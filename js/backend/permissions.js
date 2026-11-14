'use strict';

// CAPABILITY and checkManifest live in shared/core.js: the editor checks grants before it saves, and the
// server checks them again at the API boundary.
// Every route gets an explicit method -> needs entry. Unknown families are denied to scripts.
function routeNeeds(pattern, method) {
  if (pattern === 'projects/{project_id}/evaluate-node' || pattern.startsWith('projects/{project_id}/execution'))
    return [method === 'GET' ? 'run.read' : 'run.start'];
  if (pattern === 'net') return ['net.fetch:{host}'];
  if (pattern === 'notifications')
    return [method === 'GET' ? 'notifications.read' : method === 'POST' ? 'notifications.write' : 'system.admin'];
  if (/^collections/.test(pattern)) return [method === 'GET' ? 'collections.read' : 'collections.write'];
  if (/^(resources|library)(\/|$)/.test(pattern)) return [method === 'GET' ? 'library.read' : 'library.write'];
  if (/^projects(\/|$)/.test(pattern) || pattern === 'search/nodes')
    return [method === 'GET' ? 'graph.read' : 'graph.write'];
  return ['system.admin'];
}
const allows = (list, capability) =>
  list.some(value => value === capability || (value.endsWith(':*') && capability.startsWith(value.slice(0, -1))));
// An optional server-wide egress allowlist (`AGENTSYS_ALLOW_NET` / `allowedNetHosts`): a pattern may contain `*`.
const NET_ALLOW = typeof AGENTSYS_NET_ALLOW !== 'undefined' && Array.isArray(AGENTSYS_NET_ALLOW) ? AGENTSYS_NET_ALLOW : [];
const netHostAllowed = host =>
  !NET_ALLOW.length ||
  NET_ALLOW.some(pattern => {
    if (typeof pattern !== 'string' || !pattern) return false;
    if (pattern === host) return true;
    if (!pattern.includes('*')) return false;
    return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(host);
  });
// Permissions come from the placed instances. Library defaults are copied on placement, never checked at runtime.
const grantedBy = (permissions, capability) => permissions.chain.every(list => allows(list, capability));
async function permissionNeeds(method, path, body) {
  const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
  if (!found) return ['system.admin'];
  const params = Object.fromEntries(
    Object.entries(path.match(found.regex).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])
  );
  const needs = found.needs[method];
  if (needs.some(need => need.includes('{host}'))) {
    try {
      params.host = new URL(body.url).host;
    } catch {
      throw bad('Invalid network URL');
    }
  }
  return needs.map(need => need.replace(/{(\w+)}/g, (_, k) => params[k] ?? '*'));
}
async function assertScriptPermission(context, method, path, body) {  const step = context.step;
  const permissions = step?.permissions ?? {chain: [[]]};
  const policy = (await DB.get('policy:' + context.project_id)) ?? {allow: ['graph.read']};
  let needs = await permissionNeeds(method, path, body);
  if (method !== 'GET' && /^projects\/lib-/.test(path)) needs.push('library.write');
  const usedSecrets = JSON.stringify(body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g);
  needs = [...needs, ...[...usedSecrets].map(m => 'secrets.use:' + m[1])];
  const denied = needs.find(need => !allows(policy.allow ?? [], need) || !grantedBy(permissions, need));
  if (denied) {
    throw new ApiError('permission_denied', 'Permission denied: ' + denied, 403);
  }
}
/**
 * The capabilities a scoped token (a client plugin) needs for one call. It refines `system.admin` only for the
 * families a plugin may legitimately use (preferences, one named secret, the session probe); everything else that
 * the route table treats as administrative keeps `system.admin`, which no plugin token can hold.
 */
async function scopedNeeds(method, path, body = {}) {
  const needs = await permissionNeeds(method, path, body);
  const refined = [];
  for (const need of needs) {
    if (need !== 'system.admin') {
      refined.push(need);
      continue;
    }
    if (/^(settings|ui-state)$/.test(path) || path === 'migration/ui-state') {
      refined.push(method === 'GET' ? 'settings.read' : 'settings.write');
      continue;
    }
    const secret = /^secrets\/([A-Za-z0-9_-]+)$/.exec(path);
    if (secret) {
      refined.push('secrets.use:' + secret[1]);
      continue;
    }
    if (path === 'session' && method === 'GET') continue;
    refined.push('system.admin');
  }
  for (const match of JSON.stringify(body ?? {}).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g))
    if (!refined.includes('secrets.use:' + match[1])) refined.push('secrets.use:' + match[1]);
  return [...new Set(refined)];
}

function quarantineWrite(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.format === TextGraph.FORMAT) {
    return TextGraph.encode(quarantineWrite(TextGraph.decode(value)));
  }
  if (Array.isArray(value)) return value.map(quarantineWrite);
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, quarantineWrite(v)]));
  // Supplied wrappers cannot lend a generated Script trusted Library instance grants.
  if (value.op === 'script' || (value.source && value.interface)) {
    out.grants = ['graph.read'];
  }
  return out;
}
// Script writes must apply the same policy at the API boundary.
function quarantineRequest(path, body) {
  const out = quarantineWrite(body);
  if (path === 'resources' || (path.startsWith('resources/') && out.payload))
    out.payload = {...out.payload, grants: ['graph.read']};
  if (out.config) out.config = {...out.config, grants: ['graph.read']};
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
