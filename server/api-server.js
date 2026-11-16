'use strict';
// The sole HTTP API implementation. The browser client is a separate process.
const http = require('http'),
  https = require('https'),
  fs = require('fs'),
  path = require('path');
const {loadBackend} = require('../headless');
const {createFileStore} = require('./file-store');
const Protocol = require('../shared/protocol');
const {capabilityAllows} = require('../shared/core');
const {createCredentials, same} = require('./credentials');

const ROOT = path.resolve(__dirname, '..');
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
  res.end(body);
};
const sendJSON = (res, status, value) => send(res, status, value === undefined ? '' : JSON.stringify(value));
const readBody = (req, limit = 200e6) =>
  new Promise((resolve, reject) => {
    // A declared oversized body is refused before it is buffered: the client can still read the 413 answer.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.pause();
      reject(Object.assign(new Error('The request body is larger than the limit'), {status: 413, code: 'too_large'}));
      return;
    }
    const chunks = [];
    let size = 0;
    const tooLarge = () =>
      Object.assign(new Error('The request body is larger than the limit'), {status: 413, code: 'too_large'});
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        // Stop buffering and answer: destroying the socket here would take the 413 with it.
        chunks.length = 0;
        req.pause();
        reject(tooLarge());
      } else chunks.push(c);
    });
    req.on('aborted', () => reject(Object.assign(new Error('The client stopped sending'), {status: 400})));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);


/**
 * Creates the server. Nothing listens until `listen()`.
 * Options: dataDir, host, token, allowedHosts, allowedOrigins, tls {key, cert}, name, serverVersion.
 */
function createApiServer(options = {}) {
  const DATA = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data')),
    HOST = options.host || process.env.HOST || '127.0.0.1',
    TOKEN = options.token ?? process.env.AGENTSYS_TOKEN ?? '',
    loopbackBound = LOOPBACK.has(HOST) || /^127\./.test(HOST),
    STARTED_AT = Date.now(),
    SERVER_NAME = String(options.name || process.env.AGENTSYS_NAME || 'AgentSys Server').slice(0, 120),
    SERVER_VERSION = String(options.serverVersion || Protocol.VERSION),
    allowedHosts = new Set(
      (options.allowedHosts || String(process.env.ALLOWED_HOSTS || '').split(','))
        .map(h => h.trim().toLowerCase())
        .filter(Boolean)
    ),
    allowedOrigins = new Set(
      (options.allowedOrigins || String(process.env.AGENTSYS_ALLOWED_ORIGINS || '').split(','))
        .map(origin => origin.trim().replace(/\/+$/, '').toLowerCase())
        .filter(Boolean)
    ),
    TLS = options.tls || null,
    TRUST_PROXY = !!options.trustProxy || process.env.AGENTSYS_TRUST_PROXY === '1',
    // One authenticated caller must not be able to hold an unbounded number of event streams open.
    EVENT_LIMIT = Math.max(1, Math.min(100000, Number(options.eventLimit || 1000))),
    ALLOW_SHARED_DATA = options.allowSharedData === true || process.env.AGENTSYS_ALLOW_SHARED_DATA === '1',
    LOCK_FILE = path.join(DATA, '.server.lock'),
    // Optional server-wide egress allowlist for POST /api/net and a Script's net.fetch (a deployment control on
    // top of the per-Script host grant). Empty means no extra restriction.
    NET_ALLOW = (
      options.allowedNetHosts ||
      String(process.env.AGENTSYS_ALLOW_NET || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    ),
    NET_BLOCK_PRIVATE =
      options.blockPrivateNet === true ||
      (options.blockPrivateNet === undefined && process.env.AGENTSYS_NET_DENY_PRIVATE === '1'),
    // Sign-in attempts from one address are limited: a wrong token must not be a free brute-force oracle. A
    // successful sign-in clears the count.
    AUTH_ATTEMPTS = Math.max(1, Number(options.authAttempts || process.env.AGENTSYS_AUTH_ATTEMPTS || 10)),
    AUTH_WINDOW_MS = Math.max(1000, Number(options.authWindowMs || process.env.AGENTSYS_AUTH_WINDOW_MS || 60000));
  // Two server processes on one data folder would each cache whole documents and overwrite the other's writes:
  // the last save wins and a record disappears. The lock is per folder, recorded with the pid, and a lock left by
  // a stopped process (a crash) is replaced.
  const pidAlive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  if (!ALLOW_SHARED_DATA) {
    fs.mkdirSync(DATA, {recursive: true});
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({pid: process.pid, at: new Date().toISOString()}), {flag: 'wx'});
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let holder = null;
        try {
          holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        } catch {}
        if (pidAlive(Number(holder?.pid)))
          throw new Error(
            `The data folder ${DATA} is in use by another AgentSys server (pid ${holder.pid}). ` +
              'Stop it, use another --data folder, or set AGENTSYS_ALLOW_SHARED_DATA=1 to share it anyway.'
          );
        // A lock of a process that no longer runs is stale: take the folder over.
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {}
        if (attempt === 1) throw error;
      }
    }
  }
  const credentials = createCredentials(options, TOKEN);
  const {sessionOf, newSession, pluginTokenOf, pluginTokenProblem, issuePluginToken, pluginCapabilities} = credentials;
  // Failed sign-ins per address, in a fixed window.
  const authFailures = new Map();
  function authEntry(key) {
    const now = Date.now();
    let entry = authFailures.get(key);
    if (!entry || entry.reset <= now) {
      entry = {count: 0, reset: now + AUTH_WINDOW_MS};
      authFailures.set(key, entry);
    }
    return entry;
  }
  /** Seconds to wait when this address used up its attempts in the window, or 0. */
  const authWait = key => {
    const entry = authEntry(key);
    return entry.count >= AUTH_ATTEMPTS ? Math.max(1, Math.ceil((entry.reset - Date.now()) / 1000)) : 0;
  };
  const noteAuthFailure = key => {
    authEntry(key).count++;
    if (authFailures.size > 512) {
      const now = Date.now();
      for (const [address, entry] of authFailures) if (entry.reset <= now) authFailures.delete(address);
    }
  };
  const originOf = req => String(req.headers.origin || '').replace(/\/+$/, '').toLowerCase();
  /**
   * The address a sign-in is counted against. Only a server explicitly started with --trust-proxy reads the
   * forwarded list. Trust the rightmost hop appended by the configured reverse proxy, not an attacker-supplied
   * prefix preserved by nginx's proxy_add_x_forwarded_for. Multiple proxies require sanitizing at the last proxy.
   */
  const authAddress = req => {
    const direct = String(req.socket?.remoteAddress || 'unknown');
    if (!TRUST_PROXY) return direct;
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',').at(-1)
      .trim();
    return forwarded || direct;
  };
  const hostName = req =>
    String(req.headers.host || '')
      .replace(/:\d+$/, '')
      .toLowerCase();
  const sameOrigin = req => {
    const origin = originOf(req);
    if (!origin) return true; // not a browser request; CSRF checks still apply to cookie-authenticated writes
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch {
      return false;
    }
  };
  const originAllowed = req => {
    const origin = originOf(req);
    if (!origin) return true;
    if (sameOrigin(req) || allowedOrigins.has(origin)) return true;
    // On a trusted loopback-only server with no token, any loopback web origin may use the local API.
    // This keeps the split local launcher (client on :8081, server on :8080) working without weakening
    // a token-protected or remotely bound server.
    if (loopbackBound && !TOKEN) {
      try {
        const host = new URL(origin).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
      } catch {
        return false;
      }
    }
    return false;
  };
  const corsHeaders = req => {
    const origin = originOf(req);
    if (!origin) return {};
    if (!originAllowed(req)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, X-AgentSys, X-Edit, X-Agentsys-Client, X-Agentsys-Protocol',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  };
  // ----- change notifications (Server-Sent Events) -----
  const eventClients = new Map(); // response -> {heartbeat}
  const apiClientCount = () => eventClients.size;
  function removeEventClient(res) {
    clearInterval(eventClients.get(res)?.heartbeat);
    eventClients.delete(res);
  }
  function writeEvent(res, text) {
    try {
      if (!res.destroyed && !res.writableEnded && res.write(text)) return true;
    } catch {}
    // Events invalidate cached reads; reconnecting is preferable to retaining a slow reader's queue.
    removeEventClient(res);
    res.destroy();
    return false;
  }
  function openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', ...corsHeaders(req),
    });
    eventClients.set(res, {heartbeat: null});
    req.on('close', () => removeEventClient(res));
    if (!writeEvent(res, ': connected\n\n')) return;
    if (!writeEvent(res, `data: ${JSON.stringify({type: 'ready', protocol: Protocol.PROTOCOL, server_time: new Date().toISOString()})}\n\n`)) return;
    const heartbeat = setInterval(() => writeEvent(res, `: ping ${Date.now()}\n\n`), 20000);
    heartbeat.unref?.();
    eventClients.get(res).heartbeat = heartbeat;
  }
  const broadcastEvent = value => {
    for (const res of eventClients.keys()) writeEvent(res, `data: ${JSON.stringify(value)}\n\n`);
  };
  const broadcast = (keys, by = null) => {
    if (keys.length) broadcastEvent({type: 'change', keys, by});
  };
  const store = createFileStore(DATA);
  // ----- application backend with a transport-independent store -----
  let backend = null,
    backendError = null;
  try {
    backend = loadBackend({
      root: ROOT,
      scripts: 'worker',
      allowedNetHosts: NET_ALLOW,
      blockPrivateNet: NET_BLOCK_PRIVATE,
      store: {
        dir: DATA,
        get(key) {
          return store.get(key);
        },
        commit({set, remove}) {
          store.commit({set, remove});
          broadcast([...Object.keys(set), ...remove], 'api'); // open pages reload what the API changed
        },
      },
    });
  } catch (error) {
    backendError = error;
  }
  if (backend) backend.Backend.subscribeHooks(entry => broadcastEvent({type: 'hook', entry}));
  // Server plugins do not exist in this architecture. The old host remains in git history as a migration
  // reference; it is never loaded and no file below data/plugins/ is executed by the server.

  // Files are watched by comparing stamps: a page open gets the news within a second, and the backend forgets what it
  // had cached of a file that was edited on disk. With no page open the tree is looked at every few seconds only.
  let ticks = 0;
  let scanning = false,
    closing = false;
  const watcher = setInterval(() => {
    if (scanning || (!eventClients.size && ++ticks % 5)) return;
    scanning = true;
    store.scan()
      .then(changed => {
        if (closing) return;
        if (changed.length) backend?.DB.changed(changed);
        broadcast(changed);
      })
      .catch(error => console.error('File watcher:', error.message))
      .finally(() => {
        scanning = false;
      });
  }, 1000);
  watcher.unref();

  // ----- /api: the backend as an HTTP API -----
  /** On a loopback address only the loopback names (and ALLOWED_HOSTS) are accepted in the Host header: a rebound name is refused. */
  const hostRefused = req => {
    if (!loopbackBound) {
      // A remotely bound server may pin the Host names it answers to; empty means any name behind a proxy.
      if (!allowedHosts.size) return false;
      return !allowedHosts.has(hostName(req));
    }
    const host = hostName(req);
    return !LOOPBACK.has(host) && !allowedHosts.has(host);
  };
  const tokenGiven = req => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    return !!(TOKEN && m && same(m[1], TOKEN));
  };
  /** True when this request is authenticated by a bearer token, a scoped plugin token or a server-issued session. */
  const authenticated = req => (!TOKEN ? loopbackBound : tokenGiven(req) || !!sessionOf(req) || !!pluginTokenOf(req)?.entry);
  const unsafe = method => !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
  /** A cookie-authenticated write must come from this origin (or an allowed one) and carries the CSRF header. */
  const csrfOk = req => {
    if (!unsafe(req.method)) return true;
    if (tokenGiven(req) || pluginTokenOf(req)?.entry) return true; // a bearer token is not sent automatically
    if (!originAllowed(req)) return false;
    return req.headers[Protocol.CSRF_HEADER.toLowerCase()] === '1';
  };
  /** Returns [status, message] when the request may not use the API. */
  function refuse(req) {
    if (!backend) return [503, 'The API could not start: ' + (backendError?.message || 'unknown error')];
    if (hostRefused(req)) return [403, 'Unexpected Host header'];
    if (!loopbackBound && !TOKEN) return [503, 'Set AGENTSYS_TOKEN to use the API on an address other than 127.0.0.1'];
    if (!authenticated(req))
      return [401, TOKEN ? 'Send the token as "Authorization: Bearer <token>" or sign in with a session' : 'Unauthorized'];
    if (!csrfOk(req)) return [403, 'The request did not come from an allowed origin (send "X-AgentSys: 1")'];
    return null;
  }
  const recentErrors = [];
  const noteError = (status, error) => {
    recentErrors.push({
      at: new Date().toISOString(),
      status,
      code: error?.code || 'internal',
      message: String(error?.message || error).slice(0, 500),
    });
    if (recentErrors.length > 20) recentErrors.splice(0, recentErrors.length - 20);
  };
  const redact = text =>
    String(text)
      .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|token)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
  const failure = (res, error) => {
    const status = Number.isInteger(error?.status) ? error.status : error instanceof URIError ? 400 : 500; // a malformed %-escape in the address
    noteError(status, error);
    // A 405 names the methods the path accepts.
    if (status === 405 && error?.allow) res.setHeader('Allow', String(error.allow));
    sendJSON(res, status, {
      error: {
        code: error?.code || (status === 500 ? 'internal' : 'error'),
        message: redact(error?.message || error),
      },
    });
  };
  function diagnostics() {
    return {
      agentsys: true,
      version: SERVER_VERSION,
      protocol: Protocol.PROTOCOL,
      server_name: SERVER_NAME,
      started_at: new Date(STARTED_AT).toISOString(),
      uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
      storage: backend?.Backend.storage ?? {mode: 'unavailable', directory: ''},
      workers: backend?.workerStats ?? null,
      runtime: backend?.Backend.diagnostics?.() ?? null,
      clients: apiClientCount(),
      ...credentials.counts(),
      memory: (() => {
        const usage = process.memoryUsage();
        const mb = value => Math.round((value / 1024 / 1024) * 10) / 10;
        return {heap_mb: mb(usage.heapUsed), rss_mb: mb(usage.rss)};
      })(),
      recent_errors: recentErrors.slice(),
    };
  }
  /** The JSON object in the body of a request ({} when empty); anything else is a 400. */
  async function parseJSONBody(req, limit) {
    const text = await readBody(req, limit);
    if (!text.trim()) return {};
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('The body is not valid JSON'), {status: 400, code: 'invalid_request'});
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw Object.assign(new Error('The body must be a JSON object'), {status: 400, code: 'invalid_request'});
    return body;
  }
  const meta = () => ({
    agentsys: true,
    product: Protocol.PRODUCT,
    name: Protocol.NAME,
    server_name: SERVER_NAME,
    version: SERVER_VERSION,
    protocol: Protocol.PROTOCOL,
    api: '/api',
    auth: TOKEN ? 'token' : 'loopback',
    started_at: new Date(STARTED_AT).toISOString(),
    uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
    features: {
      sse: true,
      sessions: true,
      collections: true,
      client_plugins: false,
      server_plugins: false,
      plugin_tokens: true,
      plugin_identity: true,
      net_allowlist: NET_ALLOW.length > 0,
      net_block_private: NET_BLOCK_PRIVATE,
      tls: !!TLS,
    },
  });  /** The API page is also a platform reference: add the HTTP-level endpoints to the generated contract. */
  function platformOpenAPI(spec) {
    // The contract reports the running server's version and protocol, not a literal copied from the source.
    spec.info = {...(spec.info || {}), title: SERVER_NAME + ' API', version: SERVER_VERSION, 'x-protocol': Protocol.PROTOCOL};
    const add = (path, method, summary, description) => {
      spec.paths[path] = {
        ...(spec.paths[path] || {}),
        [method]: {summary, description, responses: {200: {description: 'Success'}}},
      };
    };
    const external = 'External HTTP endpoint; it is not part of the Script agentsys() table.';
    add('/api/meta', 'get', 'Read server version, protocol and features', 'Public discovery; no secrets. ' + external);
    add('/api/auth/session', 'post', 'Exchange a token for an HttpOnly session', 'Body: {"token":"…"}. ' + external);
    add('/api/auth/logout', 'post', 'End the current session', external);
    add(
      '/api/auth/plugin-session',
      'post',
      'Issue a short-lived token scoped to client plugin capabilities',
      'Body: {"plugin_id":"my-plugin","capabilities":["graph.read", …]}. The server binds identity and enforces capabilities on every call. ' + external
    );
    add('/api/auth/plugin-session', 'delete', 'Revoke a scoped plugin token', 'Send the plugin token itself. ' + external);
    add('/api/events', 'get', 'Stream change and hook events (SSE)', 'Requires a token or session cookie. ' + external);
    add('/api/diagnostics', 'get', 'Read server diagnostics', 'Requires authentication. ' + external);
    return spec;
  }
  async function handleApi(req, res, url) {
    const rel = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    // Version discovery is public: a client must be able to say that it cannot talk to this server.
    if (req.method === 'GET' && rel === 'meta') return sendJSON(res, 200, meta());
    if (req.method === 'POST' && rel === 'auth/session') {
      if (hostRefused(req)) return sendJSON(res, 403, {error: {code: 'forbidden', message: 'Unexpected Host header'}});
      if (originOf(req) && !originAllowed(req))
        return sendJSON(res, 403, {error: {code: 'forbidden', message: 'This origin may not open a session'}});
      const address = authAddress(req);
      const wait = authWait(address);
      if (wait) {
        res.setHeader('Retry-After', String(wait));
        return sendJSON(res, 429, {
          error: {code: 'rate_limited', message: `Too many sign-in attempts. Try again in ${wait} second(s).`},
        });
      }
      const body = await parseJSONBody(req, 64 * 1024);
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
      const supplied = typeof body.token === 'string' ? body.token : bearer || '';
      if (TOKEN && !same(supplied, TOKEN)) {
        noteAuthFailure(address);
        return sendJSON(res, 401, {error: {code: 'unauthorized', message: 'The token is not valid'}});
      }
      if (!TOKEN && !loopbackBound && !authenticated(req))
        return sendJSON(res, 401, {error: {code: 'unauthorized', message: 'This server requires a token'}});
      authFailures.delete(address);
      const id = newSession();
      const secure = !!(
        req.socket?.encrypted ||
        TLS ||
        (TRUST_PROXY && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()))
      );
      // Same-site cookies work for localhost ports and subdomains. A genuinely cross-site HTTPS client
      // (for example a client on another domain) needs SameSite=None, which browsers require with Secure.
      let sameSite = 'Strict';
      const origin = originOf(req);
      if (origin && secure) {
        try {
          if (new URL(origin).hostname !== hostName(req)) sameSite = 'None';
        } catch {}
      }
      res.setHeader(
        'Set-Cookie',
        `${Protocol.SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${Math.floor(
          credentials.sessionTtlMs / 1000
        )}${secure ? '; Secure' : ''}`
      );
      return sendJSON(res, 200, {ok: true, mode: TOKEN ? 'token' : 'loopback', expires_in: Math.floor(credentials.sessionTtlMs / 1000)});
    }
    if (rel === 'auth/logout' && ['POST', 'DELETE'].includes(req.method)) {
      credentials.revokeSession(req);
      res.setHeader('Set-Cookie', `${Protocol.SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return sendJSON(res, 200, {ok: true});
    }
    // A scoped token for a client plugin: the host asks for exactly the capabilities the package declared, and the
    // server enforces them on every call. Revoking is immediate (DELETE with the token itself).
    if (rel === 'auth/plugin-session') {
      const presented = pluginTokenOf(req);
      if (req.method === 'DELETE') {
        if (presented?.entry) {
          credentials.revokePlugin(presented.hash);
          return sendJSON(res, 200, {revoked: true});
        }
        return sendJSON(res, 401, {error: pluginTokenProblem(presented)});
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, DELETE');
        return sendJSON(res, 405, {error: {code: 'method_not_allowed', message: 'Use POST to issue, DELETE to revoke'}});
      }
      if (presented?.entry)
        return sendJSON(res, 403, {
          error: {code: 'permission_denied', message: 'A plugin token cannot issue another token'},
        });
      if (presented?.invalid) return sendJSON(res, 401, {error: pluginTokenProblem(presented)});
      const blocked = refuse(req);
      if (blocked)
        return sendJSON(res, blocked[0], {error: {code: blocked[0] === 401 ? 'unauthorized' : 'forbidden', message: blocked[1]}});
      const body = await parseJSONBody(req, 64 * 1024);
      let capabilities;
      try {
        capabilities = pluginCapabilities(body.capabilities);
      } catch (error) {
        return sendJSON(res, error.status || 400, {error: {code: error.code || 'invalid_request', message: error.message}});
      }
      return sendJSON(res, 200, issuePluginToken(capabilities, body.plugin_id ?? null));
    }
    // A token that was issued but is no longer valid is refused explicitly: it must not fall back to the cookie.
    const presented = pluginTokenOf(req);
    if (presented?.invalid) return sendJSON(res, 401, {error: pluginTokenProblem(presented)});
    const denied = refuse(req);
    if (denied) return sendJSON(res, denied[0], {error: {code: denied[0] === 401 ? 'unauthorized' : 'forbidden', message: denied[1]}});
    // A plugin token reaches data routes only; the host's own session reads events, diagnostics and the contract.
    if (presented?.entry && ['events', 'diagnostics', 'openapi.json'].includes(rel))
      return sendJSON(res, 403, {
        error: {code: 'permission_denied', message: 'A plugin token cannot read server events, diagnostics or the contract'},
      });
    if (req.method === 'GET' && rel === 'events') {
      if (apiClientCount() >= EVENT_LIMIT) {
        res.setHeader('Retry-After', '30');
        return sendJSON(res, 429, {
          error: {code: 'too_many_streams', message: `This server already holds ${EVENT_LIMIT} event streams.`},
        });
      }
      return openEvents(req, res);
    }
    if (req.method === 'GET' && rel === 'diagnostics') return sendJSON(res, 200, diagnostics());
    const {Backend} = backend;
    if (req.method === 'GET' && rel === 'openapi.json')
      return sendJSON(res, 200, JSON.parse(JSON.stringify(platformOpenAPI(Backend.openapi()))));
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
      return sendJSON(res, 405, {error: {message: 'method not allowed'}});
    const query = Object.fromEntries(url.searchParams);
    // If-Match: <cursor|version> makes an edit conditional. Workflows compare it with the document cursor; a
    // collection record compares it with its own version (see "if_cursor"/"if_version" in the API page).
    if (req.headers['if-match']) {
      const value = String(req.headers['if-match']).replace(/"/g, '');
      if (query.if_cursor === undefined) query.if_cursor = value;
      if (query.if_version === undefined) query.if_version = value;
    }
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await parseJSONBody(req, 20e6);
    // A scoped plugin token is checked here, from the method, path and body the server is about to use — not from
    // anything the plugin claims.
    if (presented?.entry) {
      const needs = await Backend.scopedNeeds(req.method, rel, body);
      const missing = needs.filter(need => !capabilityAllows(presented.entry.caps, need));
      if (missing.length)
        return sendJSON(res, 403, {
          error: {
            code: 'permission_denied',
            message: `This plugin token may not ${req.method} /api/${rel}: it needs ${missing.join(', ')}.`,
          },
        });
    }
    const edit = req.headers['x-edit'];
    if (edit !== undefined && (typeof edit !== 'string' || edit.length > 100))
      throw Object.assign(new Error('Invalid edit token'), {status: 400, code: 'invalid_request'});
    const result = await Backend.request(req.method, rel, {
      pluginIdentity: presented?.entry ? {id: presented.entry.pluginId} : null,
      body,
      query,
      edit: edit ?? null,
      client: /^[A-Za-z0-9._:-]{1,100}$/.test(String(req.headers[Protocol.CLIENT_HEADER] || ''))
        ? String(req.headers[Protocol.CLIENT_HEADER])
        : null,
    });
    if (result === undefined) return send(res, 204, '');
    // Serialize once: the backend's objects live in the vm realm and JSON is the contract, so an extra
    // parse/stringify round trip costs a large graph read about a third of the response time.
    return send(res, 200, JSON.stringify(result));
  }
  const server = TLS
    ? https.createServer(TLS, handleRequest)
    : http.createServer(handleRequest);
  let closeTask = null;
  function handleRequest(req, res) {
    // Security and protocol headers apply to every answer, including errors.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Agentsys-Protocol', String(Protocol.PROTOCOL));
    if (closing) return sendJSON(res, 503, {error: {code: 'server_closing', message: 'The server is shutting down'}});
    for (const [name, value] of Object.entries(corsHeaders(req))) res.setHeader(name, value);
    let run;
    try {
      const url = new URL(req.url, 'http://localhost');
      // Only the canonical API prefix reaches backend dispatch.
      run = url.pathname.startsWith('/api/')
        ? handleApi(req, res, url)
        : send(res, 404, 'This is an AgentSys Server. Use the separate Client.', 'text/plain');
    } catch (error) {
      run = Promise.reject(error);
    }
    Promise.resolve(run).catch(error => (res.headersSent ? res.end() : failure(res, error)));
  }

  return {
    server,
    dataDir: DATA,
    host: HOST,
    protocol: Protocol.PROTOCOL,
    /** Resolves with the base URL once listening (port 0 picks a free one). */
    async listen(port = 8080) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
          const scheme = TLS ? 'https' : 'http';
          resolve(`${scheme}://${shown}:${server.address().port}`);
        });
      });
    },
    close() {
      if (closeTask) return closeTask;
      closing = true;
      clearInterval(watcher);
      credentials.close();
      const stopped = new Promise(resolve => server.close(() => resolve()));
      closeTask = (async () => {
        // Keep the folder locked until all admitted writers and hook continuations have settled.
        await backend?.Backend.close();
        for (const res of eventClients.keys()) {
          removeEventClient(res);
          try { res.end(); } catch {}
        }

        server.closeAllConnections?.();
        await stopped;
        if (!ALLOW_SHARED_DATA) {
          try {
            const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (Number(holder?.pid) === process.pid) fs.rmSync(LOCK_FILE, {force: true});
          } catch {}
        }
      })();
      return closeTask;
    },
    api: backend?.Backend ?? null,
    apiAvailable: !!backend && (loopbackBound || !!TOKEN),
    /** The message redactor used for API errors and diagnostics (tested directly). */
    redact,
  };
}

module.exports = {createApiServer};
