'use strict';
// In-memory bearer/session credentials. Maps and expiry cleanup belong to this server instance.
const crypto = require('node:crypto');
const Protocol = require('../shared/protocol');
const {CAPABILITY} = require('../shared/core');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createCredentials(options, TOKEN) {
  const SESSIONS = new Map(),
    SESSION_TTL_MS = Math.max(1000, Number(options.sessionTtlMs || 12 * 60 * 60 * 1000)),
    SESSION_LIMIT = Math.max(1, Math.min(100000, Number(options.sessionLimit || 10000))),
    // Scoped tokens for client plugins: short-lived, limited to the capabilities the host asked for, and enforced
    // by the server on every call (not only by the host page that issued them).
    PLUGIN_TOKENS = new Map(),
    PLUGIN_TOKEN_PREFIX = 'pst_',
    PLUGIN_TTL_MS = Math.max(1000, Number(options.pluginSessionTtlMs || 60 * 60 * 1000)),
    PLUGIN_LIMIT = Math.max(1, Math.min(10000, Number(options.pluginSessionLimit || 1000)));
  const sessionHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
  const cookies = req => {
    const out = Object.create(null);
    for (const part of String(req.headers.cookie || '').split(';')) {
      const at = part.indexOf('=');
      if (at < 0) continue;
      // A malformed escape is an anonymous request, not a server error: anyone can craft a cookie header.
      let value;
      try {
        value = decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        continue;
      }
      out[part.slice(0, at).trim()] = value;
    }
    return out;
  };
  const sessionOf = req => {
    const id = cookies(req)[Protocol.SESSION_COOKIE];
    if (!id) return null;
    const hash = sessionHash(id),
      found = SESSIONS.get(hash);
    if (!found) return null;
    if (found.expires <= Date.now()) {
      SESSIONS.delete(hash);
      return null;
    }
    return found;
  };
  const newSession = () => {
    // Expired sessions are dropped when a new one is made, and by the periodic sweep below: the map cannot grow
    // without bound because a browser forgot its cookie.
    sweepSessions();
    const id = crypto.randomBytes(32).toString('base64url'),
      hash = sessionHash(id);
    SESSIONS.set(hash, {expires: Date.now() + SESSION_TTL_MS, created: Date.now()});
    // A flood of sign-ins must not grow memory without limit: the oldest session goes first.
    while (SESSIONS.size > SESSION_LIMIT) SESSIONS.delete(SESSIONS.keys().next().value);
    return id;
  };
  function sweepSessions() {
    const now = Date.now();
    for (const [hash, session] of SESSIONS) if (session.expires <= now) SESSIONS.delete(hash);
  }
  const sessionSweep = setInterval(() => {
    sweepSessions();
    sweepPluginTokens();
  }, 5 * 60 * 1000);
  sessionSweep.unref();
  // ----- scoped tokens for client plugins -----
  /** Which plugin token (if any) this request presents: `{entry, hash}`, `{invalid: true, expired}` or null. */
  const pluginTokenOf = req => {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] || '';
    // An operator token that happens to start with the plugin prefix is still the operator token.
    if (TOKEN && same(bearer, TOKEN)) return null;
    if (!bearer.startsWith(PLUGIN_TOKEN_PREFIX)) return null;
    const hash = sessionHash(bearer),
      found = PLUGIN_TOKENS.get(hash);
    if (!found) return {invalid: true, expired: false};
    if (found.expires <= Date.now()) {
      PLUGIN_TOKENS.delete(hash);
      return {invalid: true, expired: true};
    }
    return {entry: found, hash};
  };
  const pluginTokenProblem = presented =>
    presented?.expired
      ? {code: 'plugin_token_expired', message: 'The plugin token expired; ask the host for a new one.'}
      : {code: 'plugin_token_invalid', message: 'The plugin token is not valid; ask the host for a new one.'};
  function sweepPluginTokens() {
    const now = Date.now();
    for (const [hash, token] of PLUGIN_TOKENS) if (token.expires <= now) PLUGIN_TOKENS.delete(hash);
  }
  /** Issues a token limited to `capabilities`; at the limit it refuses instead of silently revoking a live token. */
  function issuePluginToken(capabilities) {
    sweepPluginTokens();
    if (PLUGIN_TOKENS.size >= PLUGIN_LIMIT) {
      const error = new Error(
        `This server already holds ${PLUGIN_LIMIT} plugin tokens; revoke one (or disable a plugin) and try again.`
      );
      error.status = 429;
      error.code = 'too_many_tokens';
      throw error;
    }
    const token = PLUGIN_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    PLUGIN_TOKENS.set(sessionHash(token), {
      caps: capabilities,
      expires: Date.now() + PLUGIN_TTL_MS,
      created: Date.now(),
    });
    return {token, expires_in: Math.floor(PLUGIN_TTL_MS / 1000), capabilities};
  }
  /** Validated, de-duplicated capabilities for a plugin token; never administrative. */
  function pluginCapabilities(value) {
    if (!Array.isArray(value) || value.length > 50)
      throw Object.assign(new Error('capabilities must be a list of at most 50 values'), {status: 400, code: 'invalid_request'});
    const caps = [];
    for (const cap of value) {
      if (typeof cap !== 'string' || !CAPABILITY.test(cap))
        throw Object.assign(new Error(`Unknown capability: ${String(cap).slice(0, 80)}`), {status: 400, code: 'invalid_request'});
      if (!caps.includes(cap)) caps.push(cap);
    }
    return caps;
  }
  return {
    sessionOf, newSession, pluginTokenOf, pluginTokenProblem, issuePluginToken, pluginCapabilities,
    sessionTtlMs: SESSION_TTL_MS,
    revokeSession(req) {
      const id = cookies(req)[Protocol.SESSION_COOKIE];
      if (id) SESSIONS.delete(sessionHash(id));
    },
    revokePlugin(hash) { PLUGIN_TOKENS.delete(hash); },
    counts: () => ({sessions: SESSIONS.size, plugin_sessions: PLUGIN_TOKENS.size}),
    close() { clearInterval(sessionSweep); SESSIONS.clear(); PLUGIN_TOKENS.clear(); },
  };
}
module.exports = {createCredentials, same};
