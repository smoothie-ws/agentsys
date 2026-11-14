// What an installed client plugin may ask the server to do. A plugin is untrusted code that runs in the reader's
// browser; without this layer it could use every API call the reader can, including writing workflows, spending
// secrets and making the server fetch any URL. The host checks each request here before it reaches the transport.
//
// This is a capability boundary inside one trusted browser session, not a substitute for authentication: it is
// enforced by the host page, so it holds against a plugin, not against a modified client. See docs/plugins.md.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PluginCapabilities = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const API_VERSION = 1;
  // A plugin that declares nothing gets read-only access to the ordinary data.
  const READ_ONLY = ['graph.read', 'library.read', 'collections.read', 'run.read', 'notifications.read', 'settings.read'];
  const PATTERN =
    /^(graph\.(read|write)|library\.(read|write)|collections\.(read|write)|run\.(read|start)|notifications\.(read|write)|settings\.(read|write)|net\.fetch:[A-Za-z0-9.*:\[\]-]+|secrets\.use:[A-Za-z0-9_-]+)$/;
  const MAX = 50;

  /** Validates and de-duplicates a capability list. Throws with a message a person can act on. */
  function normalize(list) {
    if (list === undefined || list === null) return READ_ONLY.slice();
    if (!Array.isArray(list)) throw new Error('capabilities must be a list');
    if (list.length > MAX) throw new Error(`A plugin declares at most ${MAX} capabilities`);
    const out = [];
    for (const value of list) {
      if (typeof value !== 'string' || !PATTERN.test(value))
        throw new Error(`Unknown plugin capability: ${String(value).slice(0, 80)}`);
      if (!out.includes(value)) out.push(value);
    }
    return out;
  }

  /** The capabilities of a stored plugin package (older packages declared nothing: they are read-only). */
  const forPlugin = plugin => {
    try {
      return normalize(plugin?.capabilities);
    } catch {
      return READ_ONLY.slice();
    }
  };

  /** A capability is exact, or a glob where `*` stands for any run of characters (`net.fetch:*.example.com`). */
  const matches = (grant, need) => {
    if (grant === need) return true;
    if (!grant.includes('*')) return false;
    const pattern = grant.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + pattern + '$').test(need);
  };
  const allows = (capabilities, need) => capabilities.some(value => matches(value, need));

  /**
   * The capability one API call needs: `{capability}` (null for a public read), `{denied}` for a call no plugin may
   * make, or `{needs: [...]}` for a call whose needs depend on its body (net, secrets).
   */
  function classify(method, path, body) {
    const clean = String(path || '').replace(/^\/+/, '').replace(/^api\//, '').replace(/\/+$/, '');
    const parts = clean ? clean.split('/') : [];
    const top = parts[0] || '';
    const read = ['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
    if (!clean || top === 'meta' || top === 'diagnostics' || top === 'openapi.json' || top === 'session')
      return {capability: null};
    if (top === 'auth') return {denied: 'A client plugin cannot use authentication endpoints'};
    if (top === 'net') {
      let host = '';
      try {
        host = new URL(body?.url).host;
      } catch {
        return {denied: 'A network request needs an absolute http(s) url'};
      }
      if (!host) return {denied: 'A network request needs an absolute http(s) url'};
      const needs = ['net.fetch:' + host];
      for (const match of JSON.stringify(body ?? {}).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g))
        needs.push('secrets.use:' + match[1]);
      return {needs};
    }
    if (top === 'secrets') {
      const name = parts[1] || '';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) return {denied: 'A secret name is required'};
      return {needs: ['secrets.use:' + name]};
    }
    if (top === 'settings' || top === 'ui-state' || clean === 'migration/ui-state')
      return {needs: [read ? 'settings.read' : 'settings.write']};
    if (top === 'collections') return {needs: [read ? 'collections.read' : 'collections.write']};
    if (top === 'notifications') return {needs: [read ? 'notifications.read' : 'notifications.write']};
    if (top === 'library' || top === 'resources' || top === 'node-folders')
      return {needs: [read ? 'library.read' : 'library.write']};
    if (top === 'search' || top === 'node-hooks' || top === 'project-defaults' || top === 'exchange')
      return {needs: [read ? 'graph.read' : 'graph.write']};
    if (top === 'projects') {
      if (parts.includes('execution')) return {needs: [read ? 'run.read' : 'run.start']};
      if (parts.includes('batch') || parts.length > 2) return {needs: [read ? 'graph.read' : 'graph.write']};
      return {needs: [read ? 'graph.read' : 'graph.write']};
    }
    return {denied: `The client plugin API does not expose "${clean.split('/').slice(0, 3).join('/')}"`};
  }

  /** `{ok: true}` or `{ok: false, reason, needs}`. */
  function check(capabilities, method, path, body) {
    const plan = classify(method, path, body);
    if (plan.denied) return {ok: false, reason: plan.denied, needs: []};
    const needs = plan.needs ?? (plan.capability ? [plan.capability] : []);
    const missing = needs.filter(need => !allows(capabilities, need));
    if (missing.length)
      return {
        ok: false,
        needs: missing,
        reason:
          `This plugin is not allowed to ${String(method || 'GET').toUpperCase()} ${String(path || '').replace(/^\/+/, '')}: ` +
          `it needs ${missing.join(', ')}. Its package declares: ${capabilities.length ? capabilities.join(', ') : 'nothing'}.`,
      };
    return {ok: true, needs};
  }

  /** The capabilities a package should carry after an install: explicit, or the read-only default. */
  const fromPackage = pkg => {
    try {
      return normalize(pkg?.capabilities);
    } catch {
      return null;
    }
  };

  return {
    API_VERSION,
    READ_ONLY,
    PATTERN,
    MAX,
    normalize,
    forPlugin,
    allows,
    classify,
    check,
    fromPackage,
    /** A one-line summary for the interface. */
    describe: list => (list && list.length ? list.join(', ') : 'read-only'),
  };
});
