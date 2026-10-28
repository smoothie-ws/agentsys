'use strict';

const CAPABILITY =
  /^(graph\.(read|write)|library\.(read|write)|initiative\.read|initiative\.write:[A-Za-z0-9_*-]+|llm\.call:[^\r\n]{1,300}|net\.fetch:[A-Za-z0-9.*:\[\]-]+|run\.(read|start)|approval\.request|secrets\.use:[A-Za-z0-9_-]+)$/;
function checkManifest(manifest) {
  for (const field of ['capabilities', 'grants'])
    if (
      manifest[field] !== undefined &&
      (!Array.isArray(manifest[field]) ||
        manifest[field].length > 50 ||
        manifest[field].some(v => typeof v !== 'string' || !CAPABILITY.test(v)))
    )
      throw bad(`Invalid ${field}`);
  if (manifest.origin !== undefined && !['human', 'ai'].includes(manifest.origin))
    throw bad('origin must be human or ai');
}
// Every route gets an explicit method -> needs entry. Unknown families are denied to scripts.
function routeNeeds(pattern, method) {
  if (pattern === 'projects/{project_id}/evaluate-node') return ['run.start'];
  if (/^initiatives(?:\/|$)/.test(pattern))
    return method === 'GET' ? ['initiative.read'] : ['initiative.write:{initiative_id}'];
  if (pattern === 'llm') return ['llm.call:{provider_model}'];
  if (pattern === 'net') return ['net.fetch:{host}'];
  if (pattern === 'permission-requests') return ['approval.request'];
  if (/^projects\/\{project_id\}\/runs$/.test(pattern)) return [method === 'GET' ? 'run.read' : 'run.start'];
  if (/^(runs|triggers)(\/|$)/.test(pattern)) return method === 'GET' ? ['run.read'] : ['system.admin'];
  if (/^(resources|library)(\/|$)/.test(pattern)) return [method === 'GET' ? 'library.read' : 'library.write'];
  if (/^projects(\/|$)/.test(pattern) || pattern === 'search/nodes')
    return [method === 'GET' ? 'graph.read' : 'graph.write'];
  return ['system.admin'];
}
const allows = (list, capability) =>
  list.some(value => value === capability || (value.endsWith(':*') && capability.startsWith(value.slice(0, -1))));
async function preparePlanPermissions(plan) {
  const resources = (await DB.get('resources')) ?? [];
  for (const step of plan.nodes) {
    if (step.manifest) continue; // a running plan pins the code and declaration
    const resource = resources.find(r => r.id === step.context?.resource_id);
    const manifest = resource?.payload ?? step.declared ?? {};
    const script = step.inputs?.find(p => p.code)?.fallback ?? '';
    const codeInput = step.inputs?.find(p => p.code);
    const matchesDefinition =
      resource?.payload.bundle.records.some(
        r =>
          r.payload.config?.op === 'script' && r.payload.config.inputs.find(p => p.id === 'script')?.default === script
      ) && !codeInput?.ref;
    const basis = resource
      ? {
          bundle: resource.payload.bundle,
          capabilities: manifest.capabilities ?? [],
          ...(!matchesDefinition ? {actual_code: script, ref: codeInput?.ref ?? null} : {}),
        }
      : {script, capabilities: manifest.capabilities ?? []};
    step.manifest = {
      capabilities: clone(manifest.capabilities ?? []),
      grants: clone(manifest.grants ?? []),
      origin: step.declared?.origin === 'ai' || codeInput?.ref ? 'ai' : (manifest.origin ?? 'human'),
      code_hash: await hashText(JSON.stringify(basis)),
    };
  }
}
async function permissionNeeds(method, path, body) {
  const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
  if (!found) return ['system.admin'];
  const params = Object.fromEntries(
    Object.entries(path.match(found.regex).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])
  );
  if (path === 'llm') {
    const list = ((await DB.get('resources')) ?? []).filter(r => r.kind === 'provider');
    const p = body.provider ? list.find(p => p.id === body.provider || p.name === body.provider) : list[0];
    params.provider_model = `${p?.name ?? body.provider}/${body.model || p?.payload.default_model}`;
  }
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
  const step = context.plan?.nodes.find(n => n.id === context.node_id);
  const manifest = step?.manifest ?? {capabilities: [], grants: []};
  const policy = (await DB.get('policy:' + context.project_id)) ?? {allow: ['graph.read']};
  const initiativePolicy = context.initiative_id ? await DB.get('initiative_policy:' + context.initiative_id) : null;
  const approved = await DB.get(
    'permission_grant:' + context.project_id + ':' + (step?.context?.resource_id ?? context.node_id)
  );
  const grants = approved?.code_hash === manifest.code_hash ? approved.grants : manifest.grants;
  let needs = await permissionNeeds(method, path, body);
  if (path === 'llm') {
    const providers = ((await DB.get('resources')) ?? []).filter(r => r.kind === 'provider');
    const provider = body.provider
      ? providers.find(r => r.id === body.provider || r.name === body.provider)
      : providers[0];
    for (const m of JSON.stringify(provider?.payload ?? {}).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g))
      needs.push('secrets.use:' + m[1]);
  }
  if (method !== 'GET' && /^projects\/lib-/.test(path)) needs.push('library.write');
  const usedSecrets = JSON.stringify(body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g);
  needs = [...needs, ...[...usedSecrets].map(m => 'secrets.use:' + m[1])];
  const denied = needs.find(
    need =>
      !allows(manifest.capabilities, need) ||
      !allows(policy.allow ?? [], need) ||
      (initiativePolicy && !allows(initiativePolicy.allow ?? [], need)) ||
      !allows(grants ?? [], need) ||
      (manifest.origin === 'ai' &&
        approved?.code_hash !== manifest.code_hash &&
        !['graph.read', 'initiative.read', 'library.read', 'run.read'].includes(need))
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
    out.origin = 'ai';
    out.grants = ['graph.read'];
  }
  return out;
}
async function grantApprovedPermissions(run, request) {
  const wait = run.checkpoint.waits.find(
    w =>
      w.wait_spec.approval?.permission === request ||
      JSON.stringify(w.wait_spec.approval?.permission) === JSON.stringify(request)
  );
  const step = run.plan.nodes.find(n => n.id === wait?.node_id);
  if (!step) throw bad('No waiting node for permission request');
  const manifest = step.manifest;
  const grants = request.capabilities;
  checkManifest({grants});
  if (!Array.isArray(grants) || grants.some(g => !allows(manifest.capabilities, g)))
    throw bad('Permission request exceeds declared capabilities');
  const key = 'permission_grant:' + run.project_id + ':' + (step.context.resource_id ?? step.id);
  await DB.commit({[key]: {code_hash: manifest.code_hash, grants}});
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
function stripSecrets(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !/^(api_key|headers|password|secret)$/i.test(k))
      .map(([k, v]) => [k, stripSecrets(v)])
  );
}
