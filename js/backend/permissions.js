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
// A deployment may refuse private, loopback and link-local destinations. It is off by default for compatibility,
// and a project policy can turn it on for its own Scripts (see routes-permissions.js).
const NET_BLOCK_PRIVATE = typeof AGENTSYS_NET_BLOCK_PRIVATE !== 'undefined' && AGENTSYS_NET_BLOCK_PRIVATE === true;
/** Host and port, lower-case, without the trailing root dot: `example.com.` is the same DNS name as `example.com`. */
const normalizeAuthority = value => {
  let text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text.endsWith('.')) text = text.slice(0, -1);
  text = text.replace(/\.(?=:\d+$)/, '');
  return text;
};
/** The host[:port] a URL resolves to, normalized. */
const authorityOf = value => {
  const url = value instanceof URL ? value : new URL(String(value));
  return normalizeAuthority(url.host);
};
/** A literal IP address (v4 or v6, brackets accepted) or an empty string. */
const literalAddress = hostname => {
  const text = String(hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return text;
  if (/^[0-9a-f:]+$/i.test(text) && text.includes(':')) return text.toLowerCase();
  return '';
};
const ipv4Private = address => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments / TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved and broadcast
  );
};
/** Private, loopback, link-local, multicast or otherwise non-public destination. */
const privateAddress = address => {
  const text = String(address || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!text) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return ipv4Private(text);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) return ipv4Private(mapped[1]);
  if (!text.includes(':')) return true; // not an address known here: fail closed
  if (text === '::' || text === '::1') return true;
  const first = text.split(':').find(Boolean) || '';
  const group = parseInt(first || '0', 16);
  return (
    (group & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (group & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (group & 0xff00) === 0xff00 || // multicast
    text.startsWith('2001:db8:') || // documentation
    text.startsWith('64:ff9b:') // NAT64
  );
};
/** `{address, family}` entries for a hostname, or null when the runtime cannot resolve (an older browser). */
const resolveHost = async hostname => {
  if (typeof AGENTSYS_RESOLVE !== 'function') return null;
  const literal = literalAddress(hostname);
  if (literal) return [{address: literal, family: literal.includes(':') ? 6 : 4}];
  return AGENTSYS_RESOLVE(String(hostname).replace(/^\[|\]$/g, ''));
};
/** The address to pin a deny-private request to, or null when any answer is private. */
const publicAddress = async hostname => {
  const addresses = await resolveHost(hostname);
  if (!addresses || !addresses.length || addresses.some(entry => privateAddress(entry.address))) return null;
  return addresses[0].address;
};
const hostMatches = (patterns, host) => {
  if (!Array.isArray(patterns)) return true; // no list: the caller's other layers decide
  const wanted = normalizeAuthority(host);
  return patterns.some(pattern => {
    if (typeof pattern !== 'string' || !pattern) return false;
    const value = normalizeAuthority(pattern);
    if (value === wanted) return true;
    if (!value.includes('*')) return false;
    return new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(wanted);
  });
};
const netHostAllowed = (host, patterns = NET_ALLOW) => !patterns.length || hostMatches(patterns, host);
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
      params.host = authorityOf(body.url);
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
