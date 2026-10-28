'use strict';

const CAPABILITY =
  /^(graph\.(read|write)|library\.(read|write)|net\.fetch:[A-Za-z0-9.*:\[\]-]+|run\.(read|start)|secrets\.use:[A-Za-z0-9_-]+)$/;
function checkManifest(manifest) {
  for (const field of ['capabilities', 'grants'])
    if (
      manifest[field] !== undefined &&
      (!Array.isArray(manifest[field]) ||
        manifest[field].length > 50 ||
        manifest[field].some(v => typeof v !== 'string' || !CAPABILITY.test(v)))
    )
      throw bad(`Invalid ${field}`);
}
// Every route gets an explicit method -> needs entry. Unknown families are denied to scripts.
function routeNeeds(pattern, method) {
  if (/^workflows\/\{workflow_id\}\/(state|queues)(\/|$)/.test(pattern))
    return [method === 'GET' ? 'graph.read' : 'graph.write'];
  if (pattern === 'projects/{project_id}/evaluate-node') return ['run.start'];
  if (pattern === 'net') return ['net.fetch:{host}'];
  if (/^projects\/\{project_id\}\/runs$/.test(pattern)) return [method === 'GET' ? 'run.read' : 'run.start'];
  if (/^(runs|triggers)(\/|$)/.test(pattern)) return method === 'GET' ? ['run.read'] : ['system.admin'];
  if (/^(resources|library)(\/|$)/.test(pattern)) return [method === 'GET' ? 'library.read' : 'library.write'];
  if (/^projects(\/|$)/.test(pattern) || pattern === 'search/nodes')
    return [method === 'GET' ? 'graph.read' : 'graph.write'];
  return ['system.admin'];
}
const allows = (list, capability) =>
  list.some(value => value === capability || (value.endsWith(':*') && capability.startsWith(value.slice(0, -1))));
// Every invocation captures its declaration at start. Code that
// arrives through a wire (not typed into the node) cannot have been reviewed, so it only gets the read grants.
const READ_ONLY = ['graph.read', 'library.read', 'run.read'];
async function preparePlanPermissions(plan) {
  const resources = (await DB.get('resources')) ?? [];
  for (const step of plan.nodes) {
    if (step.manifest) continue;
    const resource = resources.find(r => r.id === step.context?.resource_id);
    const manifest = resource?.payload ?? step.declared ?? {};
    const dynamic = !!step.inputs?.find(p => p.code)?.ref;
    const grants = clone(manifest.grants ?? []);
    step.manifest = {
      capabilities: clone(manifest.capabilities ?? []),
      grants: dynamic ? grants.filter(g => READ_ONLY.includes(g)) : grants,
    };
  }
}
async function nodeStartPermission(plan, step, invocation) {
  const run = RUNS.byId.get(plan.context.run_id);
  if (run?.replay) {
    const entry = run.replay.authorizations?.shift();
    if (!entry || entry.invocation !== invocation || entry.node_version !== step.content_hash)
      throw new ApiError('replay_diverged', 'Replay diverged at node authorization: ' + invocation, 409);
    return entry.reason;
  }
  const policy = (await DB.get('policy:' + plan.context.project_id)) ?? {allow: ['graph.read']};
  const denied = (step.manifest?.capabilities ?? []).find(
    capability => !allows(step.manifest.grants ?? [], capability) || !allows(policy.allow ?? [], capability)
  );
  const reason = denied ? 'Permission denied: ' + denied : null;
  recordPlanEntry(run, 'authorizations', {invocation, node_version: step.content_hash, reason});
  return reason;
}
async function permissionNeeds(method, path, body) {
  const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
  if (!found) return ['system.admin'];
  const params = Object.fromEntries(
    Object.entries(path.match(found.regex).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])
  );
  if (path === 'net') {
    try {
      params.host = new URL(body.url).host;
    } catch {
      throw bad('Invalid network URL');
    }
  }
  return found.needs[method].map(need => need.replace(/{(\w+)}/g, (_, k) => params[k] ?? '*'));
}
async function assertScriptPermission(context, method, path, body) {
  const step = context.step;
  const manifest = step?.manifest ?? {capabilities: [], grants: []};
  const policy = (await DB.get('policy:' + context.project_id)) ?? {allow: ['graph.read']};
  let needs = await permissionNeeds(method, path, body);
  if (method !== 'GET' && /^projects\/lib-/.test(path)) needs.push('library.write');
  const usedSecrets = JSON.stringify(body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g);
  needs = [...needs, ...[...usedSecrets].map(m => 'secrets.use:' + m[1])];
  const denied = needs.find(
    need =>
      !allows(manifest.capabilities, need) || !allows(policy.allow ?? [], need) || !allows(manifest.grants ?? [], need)
  );
  const run = RUNS.byId.get(context.run_id);
  if (denied) {
    if (run) emit(run, 'permission_denied', {node_id: context.node_id, method, path, needs});
    throw new ApiError('permission_denied', 'Permission denied: ' + denied, 403);
  }
  if (run && method !== 'GET') emit(run, 'sensitive_action', {node_id: context.node_id, method, path, needs});
}
function quarantineWrite(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.format === TextGraph.FORMAT) {
    return TextGraph.encode(quarantineWrite(TextGraph.decode(value)));
  }
  if (Array.isArray(value)) return value.map(quarantineWrite);
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, quarantineWrite(v)]));
  if (value.op === 'script') {
    out.grants = ['graph.read'];
  }
  return out;
}
async function injectSecrets(value) {
  if (typeof value === 'string') {
    const matches = [...value.matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)];
    for (const m of matches) {
      const secret = await DB.get('secrets/' + m[1]);
      if (!secret) throw missing('Secret not found: ' + m[1]);
      value = value.replaceAll(m[0], secret.value);
    }
    return value;
  }
  if (Array.isArray(value)) return Promise.all(value.map(injectSecrets));
  if (isObject(value))
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await injectSecrets(v)]))
    );
  return value;
}
const redactText = value =>
  String(value)
    .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)[\"']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
function stripSecrets(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !/^(api[_-]?key|headers|password|secret|token|authorization|cookie|set-cookie)$/i.test(k))
      .map(([k, v]) => [k, stripSecrets(v)])
  );
}
