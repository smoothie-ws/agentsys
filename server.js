#!/usr/bin/env node
// Combined local server, kept for the `/editor/` convenience mode and the regression suite. It composes the
// API-only platform server with static client serving and the legacy `/__data` browser store.
//
// The deployment server is bin/agentsys-server.js (server/api-server.js): it never serves the client and has
// no browser storage or plugin host. This file must not be used to expose a remote server.
//
// No dependencies. Run:  node server.js [--port 3000]
// Environment: PORT, HOST (default 127.0.0.1), DATA_DIR, AGENTSYS_TOKEN (required for API/storage on a non-loopback
// HOST; optional otherwise), ALLOWED_HOSTS (extra Host header names accepted on loopback, comma separated).
'use strict';
const http = require('http'),
  https = require('https'),
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const {loadBackend} = require('./headless');
const TextGraph = require('./js/storage/format');
const Protocol = require('./shared/protocol');
const {capabilityAllows, CAPABILITY} = require('./shared/core');
const {SERVER_ONLY} = require('./server/manifest');

const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

// ----- storage layout: a key of the application <-> a file below data/ -----
//   prefs -> settings.json        projects -> projects.json        meta -> meta.json
//   resources -> library/resources.json        node_folders -> library/node_folders.json
//   library_types -> library/types.json
//   wf:<id> -> workflows/<id>.json             wf:lib-<id> -> library/editors/<id>.json
//   anything else -> other/<key>.json
const FIXED = {
  prefs: 'settings.json',
  projects: 'projects.json',
  meta: 'meta.json',
  resources: 'library/resources.json',
  node_folders: 'library/node_folders.json',
  library_types: 'library/types.json',
};
/** The sidecar script files a stored graph refers to (`{$script: 'scripts/x.js'}` values anywhere inside it). */
const SCRIPT_PATH = /^scripts\/[A-Za-z0-9_-]+\.js$/;
const scriptRefs = (value, out = []) => {
  if (value && typeof value === 'object') {
    if (typeof value.$script === 'string') out.push(value.$script);
    for (const child of Object.values(value)) scriptRefs(child, out);
  }
  return out;
};
const VALID_KEY = /^(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9:._/-]{1,500}$/;
const storagePath = key => key.split('/').map(encodeURIComponent).join('/');
const fileOf = key => {
  if (key.includes('/')) return storagePath(key) + '.json';
  if (Object.hasOwn(FIXED, key)) return FIXED[key];
  let m = /^wf:lib-(.+)$/.exec(key);
  if (m) return `library/editors/${m[1]}.json`;
  m = /^wf:(.+)$/.exec(key);
  if (m) return `workflows/${m[1]}.json`;
  return `other/${key.replace(/:/g, '__')}.json`;
};
const keyOf = file => {
  const rel = file.split(path.sep).map(decodeURIComponent).join('/');
  const sidecar = /^(.*)\.files\/(?:layout\.json|scripts\/[A-Za-z0-9_-]+\.js)$/.exec(rel);
  if (sidecar) return keyOf(sidecar[1] + '.json');
  if ((/^(secrets|plugins)\//.test(rel) && rel.endsWith('.json')) || /^workflows\/[^/]+\/.+\.json$/.test(rel))
    return rel.slice(0, -5);
  for (const [key, f] of Object.entries(FIXED)) if (f === rel) return key;
  let m = /^library\/editors\/(.+)\.json$/.exec(rel);
  if (m) return `wf:lib-${m[1]}`;
  m = /^workflows\/(.+)\.json$/.exec(rel);
  if (m) return `wf:${m[1]}`;
  m = /^other\/(.+)\.json$/.exec(rel);
  return m ? m[1].replace(/__/g, ':') : null;
};

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (
      (e.name.endsWith('.json') ||
        (p.includes('.files' + path.sep + 'scripts' + path.sep) && e.name.endsWith('.js'))) &&
      !e.name.includes('.tmp-')
    )
      out.push(p);
  }
  return out;
}
// Polling must yield to HTTP edits even when the retained history has many files.
async function walkAsync(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, {withFileTypes: true});
  } catch {
    return [];
  }
  const children = await Promise.all(
    entries.map(async entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkAsync(file);
      return !entry.name.includes('.tmp-') &&
        (entry.name.endsWith('.json') ||
          (file.includes('.files' + path.sep + 'scripts' + path.sep) && entry.name.endsWith('.js')))
        ? [file]
        : [];
    })
  );
  return children.flat();
}
const stampOf = file => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null; // removed meanwhile
  }
};
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
const same = (a, b) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Creates the server. Nothing listens until `listen()`.
 * Options: dataDir, host, token, allowedHosts, allowedOrigins, serveClient (default true for the legacy
 * combined local launcher), legacyStorage (default follow serveClient), tls {key, cert}, name, serverVersion.
 */
function createServer(options = {}) {
  const DATA = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data')),
    HOST = options.host || process.env.HOST || '127.0.0.1',
    TOKEN = options.token ?? process.env.AGENTSYS_TOKEN ?? '',
    loopbackBound = LOOPBACK.has(HOST) || /^127\./.test(HOST),
    SERVE_CLIENT = options.serveClient !== false,
    LEGACY_STORAGE = options.legacyStorage ?? SERVE_CLIENT,
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
    SESSIONS = new Map(),
    SESSION_TTL_MS = Math.max(1000, Number(options.sessionTtlMs || 12 * 60 * 60 * 1000)),
    SESSION_LIMIT = Math.max(1, Math.min(100000, Number(options.sessionLimit || 10000))),
    // One authenticated caller must not be able to hold an unbounded number of event streams open.
    EVENT_LIMIT = Math.max(1, Math.min(100000, Number(options.eventLimit || 1000))),
    // Scoped tokens for client plugins: short-lived, limited to the capabilities the host asked for, and enforced
    // by the server on every call (not only by the host page that issued them).
    PLUGIN_TOKENS = new Map(),
    PLUGIN_TOKEN_PREFIX = 'pst_',
    PLUGIN_TTL_MS = Math.max(1000, Number(options.pluginSessionTtlMs || 60 * 60 * 1000)),
    PLUGIN_LIMIT = Math.max(1, Math.min(10000, Number(options.pluginSessionLimit || 1000))),
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
   * forwarded list, and then only its first entry: otherwise every client of a proxy would share one counter.
   */
  const authAddress = req => {
    const direct = String(req.socket?.remoteAddress || 'unknown');
    if (!TRUST_PROXY) return direct;
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
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
  const abs = key => path.join(DATA, ...fileOf(key).split('/'));
  const stamps = entries => {
    const grouped = new Map();
    for (const [file, stamp] of entries) {
      const relative = path.relative(DATA, file),
        key = keyOf(relative);
      if (!key || !stamp) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(relative + ':' + stamp + ';');
    }
    return new Map([...grouped].map(([key, values]) => [key, values.sort().join('')]));
  };
  const snapshot = () => {
    return stamps(walk(DATA).map(file => [file, stampOf(file)]));
  };
  const snapshotAsync = async () => {
    const files = await walkAsync(DATA),
      entries = [];
    for (let i = 0; i < files.length; i += 128) {
      entries.push(
        ...(await Promise.all(
          files.slice(i, i + 128).map(async file => {
            try {
              const stat = await fs.promises.stat(file);
              return [file, `${stat.mtimeMs}:${stat.size}`];
            } catch {
              return [file, null];
            }
          })
        ))
      );
    }
    return stamps(entries);
  };
  let storageRevision = 0;
  const changedAt = new Map();
  let known = snapshot();
  const recordCommit = ({set = {}, remove = []}) => {
    const revision = ++storageRevision;
    for (const key of Object.keys(set)) {
      const file = abs(key),
        sidecar = key === 'resources' || key.startsWith('wf:'),
        files = [file, ...(sidecar ? walk(file.replace(/\.json$/, '.files')) : [])];
      const stamp = stamps(files.map(p => [p, stampOf(p)])).get(key);
      if (stamp) known.set(key, stamp);
      else known.delete(key);
      changedAt.set(key, revision);
    }
    for (const key of remove) {
      known.delete(key);
      changedAt.set(key, revision);
    }
  };
  function readKey(key) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(abs(key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (key === 'resources' || key.startsWith('wf:')) {
      if (value.format !== TextGraph.FORMAT) throw new Error('Expected canonical graph files: ' + key);
      const folder = abs(key).replace(/\.json$/, '.files');
      const files = {
        'graph.json': JSON.stringify(value),
        'layout.json': fs.readFileSync(path.join(folder, 'layout.json'), 'utf8'),
      };
      const scripts = new Set(scriptRefs(value.value));
      for (const name of scripts) {
        if (!SCRIPT_PATH.test(name)) throw new Error('Invalid script path');
        files[name] = fs.readFileSync(path.join(folder, ...name.split('/')), 'utf8');
      }
      value = TextGraph.decode({format: TextGraph.FORMAT, files});
    }
    return value;
  }
  const madeDirs = new Set(); // directories this process created or found: no mkdir per file written
  function atomicText(file, text, mode) {
    try {
      const bytes = Buffer.byteLength(text);
      const stat = fs.statSync(file);
      // A size difference already proves a content difference; only an equal size needs the read to compare.
      if (stat.size !== bytes) throw Object.assign(new Error('different'), {code: 'ENOENT'});
      if (fs.readFileSync(file, 'utf8') === text) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const dir = path.dirname(file);
    if (!madeDirs.has(dir)) {
      fs.mkdirSync(dir, {recursive: true});
      madeDirs.add(dir);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, mode ? {mode} : undefined);
    // On Windows another program (antivirus, indexer, sync, editor) may hold the target for a moment, and rename then fails with
    // EPERM/EBUSY/EACCES. Retry briefly; if the target stays locked, fail without replacing it with a partial write.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        // A rename keeps the temporary file's mode; a pre-existing file may have another one, so set it here too.
        if (mode && process.platform !== 'win32') {
          try {
            fs.chmodSync(file, mode);
          } catch {}
        }
        return;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
          fs.rmSync(tmp, {force: true});
          throw error;
        }
        if (attempt < 5) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
          continue;
        }
        fs.rmSync(tmp, {force: true});
        throw error;
      }
    }
  }

  // ----- change notifications (Server-Sent Events) -----
  // Two streams exist: /api/events uses the typed envelope below; /__data/events stays for the legacy combined
  // local browser store and keeps its original {keys, by} shape.
  const clients = new Set(); // /__data/events (legacy)
  const eventClients = new Map(); // res -> {heartbeat}
  const writeEvent = (res, value) => {
    try {
      res.write(`data: ${JSON.stringify(value)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };
  const broadcastEvent = value => {
    for (const [res, entry] of eventClients) {
      if (!writeEvent(res, value)) {
        clearInterval(entry.heartbeat);
        eventClients.delete(res);
      }
    }
  };
  const broadcast = (keys, by = null) => {
    if (!keys.length) return;
    const text = `data: ${JSON.stringify({keys, by})}\n\n`;
    for (const res of clients) {
      try {
        res.write(text);
      } catch {
        clients.delete(res); // the page is gone
      }
    }
    broadcastEvent({type: 'change', keys, by});
  };
  const scriptRefsCache = new Map(); // key -> {stamp, names}: avoid reading a large unchanged graph on every save
  function writeKey(key, value) {
    const file = abs(key);
    if (key === 'resources' || key.startsWith('wf:')) {
      const packet = TextGraph.encode(value),
        folder = file.replace(/\.json$/, '.files');
      let previous = [];
      try {
        const stamp = stampOf(file),
          cached = scriptRefsCache.get(key);
        if (cached && stamp && cached.stamp === stamp) previous = cached.names;
        else {
          previous = scriptRefs(JSON.parse(fs.readFileSync(file, 'utf8')).value);
          if (stamp) scriptRefsCache.set(key, {stamp, names: previous});
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const next = [];
      for (const [name, text] of Object.entries(packet.files))
        if (name !== 'graph.json') atomicText(path.join(folder, ...name.split('/')), text);
      atomicText(file, packet.files['graph.json']);
      for (const name of previous)
        if (!Object.hasOwn(packet.files, name) && SCRIPT_PATH.test(name)) {
          try {
            fs.unlinkSync(path.join(folder, ...name.split('/')));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      for (const name of Object.keys(packet.files)) if (name !== 'graph.json') next.push(name);
      scriptRefsCache.set(key, {stamp: stampOf(file), names: next});
      return;
    }
    atomicText(file, JSON.stringify(value, null, 2) + '\n', key.startsWith('secrets/') ? 0o600 : undefined);
  }
  function removeKey(key) {
    madeDirs.clear();
    scriptRefsCache.delete(key);
    const file = abs(key),
      folder = file.replace(/\.json$/, '.files');
    if (!path.resolve(folder).startsWith(path.resolve(DATA) + path.sep)) throw new Error('Unsafe storage path');
    if (key === 'resources' || key.startsWith('wf:')) {
      try {
        const files = [
          'layout.json',
          ...scriptRefs(JSON.parse(fs.readFileSync(file, 'utf8')).value).filter(n => SCRIPT_PATH.test(n)),
        ];
        for (const name of files) {
          try {
            fs.unlinkSync(path.join(folder, ...name.split('/')));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        for (const dir of [path.join(folder, 'scripts'), folder])
          try {
            fs.rmdirSync(dir);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
          }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  // A redo record makes a multi-key commit recoverable before the backend can read it.
  const transactionFile = path.join(DATA, '.transaction.json');
  function applyTransaction({set = {}, remove = []}) {
    for (const k of Object.keys(set)) writeKey(k, set[k]);
    for (const k of remove) removeKey(k);
    fs.unlinkSync(transactionFile);
  }
  /** Finishes a commit that was interrupted, once, without writing the record again. */
  function replayTransaction() {
    if (!fs.existsSync(transactionFile)) return;
    let packet;
    try {
      packet = JSON.parse(fs.readFileSync(transactionFile, 'utf8'));
      const keys = [...Object.keys(packet?.set ?? {}), ...(packet?.remove ?? [])];
      if (!keys.every(k => VALID_KEY.test(k))) throw new Error('Invalid storage key');
    } catch (error) {
      // A record that cannot be read is not a source of truth: the data files are. Keep it for
      // inspection and start normally instead of refusing to boot.
      try {
        fs.renameSync(transactionFile, transactionFile + '.invalid');
      } catch {}
      console.warn('[agentsys] ignored an unreadable .transaction.json: ' + error.message);
      return;
    }
    try {
      applyTransaction(packet);
    } catch (error) {
      // A key the folder cannot accept (for example a directory where a file belongs) must not stop every later
      // start: keep the record for inspection and boot on the data files that did reach the disk.
      try {
        fs.renameSync(transactionFile, transactionFile + '.invalid');
      } catch {}
      console.warn('[agentsys] a redo record could not be applied: ' + error.message);
    }
  }
  function commitKeys({set = {}, remove = []}) {
    const keys = [...Object.keys(set), ...remove];
    if (!keys.every(k => VALID_KEY.test(k))) throw new Error('Invalid storage key');
    replayTransaction();
    atomicText(transactionFile, JSON.stringify({set, remove}), 0o600);
    const transactionFd = fs.openSync(transactionFile, 'r+');
    try {
      fs.fsyncSync(transactionFd);
    } finally {
      fs.closeSync(transactionFd);
    }
    applyTransaction({set, remove});
  }
  replayTransaction();
  known = snapshot();
  // ----- the backend: the same code the browser runs, with the data folder as its store -----
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
          return readKey(key);
        },
        commit({set, remove}) {
          commitKeys({set, remove});
          recordCommit({set, remove});
          broadcast([...Object.keys(set), ...remove], 'api'); // open pages reload what the API changed
        },
      },
    });
  } catch (error) {
    backendError = error;
  }
  if (backend) backend.Backend.subscribeHooks(entry => broadcastEvent({type: 'hook', entry}));
  // Server plugins do not exist in this architecture. The old host is kept under legacy/ only as a migration
  // reference; it is never loaded and no file below data/plugins/ is executed by the server.

  // Files are watched by comparing stamps: a page open gets the news within a second, and the backend forgets what it
  // had cached of a file that was edited on disk. With no page open the tree is looked at every few seconds only.
  let ticks = 0;
  let scanning = false,
    closing = false;
  const watcher = setInterval(() => {
    if (scanning || (!clients.size && ++ticks % 5)) return;
    scanning = true;
    const revision = storageRevision;
    snapshotAsync()
      .then(now => {
        if (closing) return;
        const changed = [];
        for (const key of new Set([...known.keys(), ...now.keys()])) {
          // A commit during this asynchronous scan has a newer, complete fingerprint already.
          if ((changedAt.get(key) ?? 0) > revision) continue;
          if (known.get(key) !== now.get(key)) changed.push(key);
          if (now.has(key)) known.set(key, now.get(key));
          else known.delete(key);
        }
        if (changed.length) backend?.DB.changed(changed);
        broadcast(changed);
      })
      .catch(error => console.error('File watcher:', error.message))
      .finally(() => {
        scanning = false;
      });
  }, 1000);
  watcher.unref();

  // ----- /__data: raw storage (same Host/token boundary as the API; writes also need X-AgentSys) -----
  async function handleData(req, res, url) {
    if (!LEGACY_STORAGE) return sendJSON(res, 404, {error: 'This server has no browser storage endpoint. Use /api/.'});
    if (hostRefused(req)) return sendJSON(res, 403, {error: 'forbidden'});
    if (!loopbackBound && !TOKEN)
      return sendJSON(res, 503, {error: 'Set AGENTSYS_TOKEN to access storage on a non-loopback address'});
    if (TOKEN && !tokenGiven(req)) return sendJSON(res, 401, {error: 'Storage requires a Bearer token'});
    const rest = url.pathname.slice('/__data'.length).replace(/^\//, '');
    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && rest === '')
      return sendJSON(res, 200, {agentsys: true, dir: DATA, keys: [...snapshot().keys()]});
    if (req.method === 'GET') {
      const key = decodeURIComponent(rest);
      if (!VALID_KEY.test(key)) return sendJSON(res, 400, {error: 'bad key'});
      try {
        const value = readKey(key);
        return sendJSON(res, value === undefined ? 204 : 200, value);
      } catch (error) {
        return sendJSON(res, 500, {error: String(error.message)});
      }
    }
    if (req.method === 'POST' && rest === '') {
      // Cross-site pages cannot send this header without a CORS preflight, which this server never grants.
      if (req.headers['x-agentsys'] !== '1') return sendJSON(res, 403, {error: 'forbidden'});
      const body = await parseJSONBody(req),
        set = body.set ?? {},
        remove = body.remove ?? [];
      if (typeof set !== 'object' || set === null || Array.isArray(set) || !Array.isArray(remove))
        return sendJSON(res, 400, {error: 'bad body'});
      const keys = [...Object.keys(set), ...remove];
      if (!keys.every(k => VALID_KEY.test(k))) return sendJSON(res, 400, {error: 'bad key'});
      commitKeys({set, remove});
      // Only what this request touched can have changed, so the whole tree need not be walked again.
      recordCommit({set, remove});
      backend?.DB.changed(keys); // the API's cache must not outlive what the page wrote
      broadcast(keys, String(req.headers['x-client'] || ''));
      return sendJSON(res, 200, {ok: true});
    }
    sendJSON(res, 405, {error: 'method not allowed'});
  }

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
      clients: eventClients.size,
      sessions: SESSIONS.size,
      plugin_sessions: PLUGIN_TOKENS.size,
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
      'Body: {"capabilities":["graph.read", …]}. The server enforces them on every call. ' + external
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
          SESSION_TTL_MS / 1000
        )}${secure ? '; Secure' : ''}`
      );
      return sendJSON(res, 200, {ok: true, mode: TOKEN ? 'token' : 'loopback', expires_in: Math.floor(SESSION_TTL_MS / 1000)});
    }
    if (rel === 'auth/logout' && ['POST', 'DELETE'].includes(req.method)) {
      const id = cookies(req)[Protocol.SESSION_COOKIE];
      if (id) SESSIONS.delete(sessionHash(id));
      res.setHeader('Set-Cookie', `${Protocol.SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return sendJSON(res, 200, {ok: true});
    }
    // A scoped token for a client plugin: the host asks for exactly the capabilities the package declared, and the
    // server enforces them on every call. Revoking is immediate (DELETE with the token itself).
    if (rel === 'auth/plugin-session') {
      const presented = pluginTokenOf(req);
      if (req.method === 'DELETE') {
        if (presented?.entry) {
          PLUGIN_TOKENS.delete(presented.hash);
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
      return sendJSON(res, 200, issuePluginToken(capabilities));
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
      if (eventClients.size >= EVENT_LIMIT) {
        res.setHeader('Retry-After', '30');
        return sendJSON(res, 429, {
          error: {code: 'too_many_streams', message: `This server already holds ${EVENT_LIMIT} event streams.`},
        });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(req),
      });
      res.write(`: connected\n\n`);
      res.write(`data: ${JSON.stringify({type: 'ready', protocol: Protocol.PROTOCOL, server_time: new Date().toISOString()})}\n\n`);
      const heartbeat = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          eventClients.delete(res);
        }
      }, 20000);
      heartbeat.unref?.();
      eventClients.set(res, {heartbeat});
      req.on('close', () => {
        clearInterval(heartbeat);
        eventClients.delete(res);
      });
      return;
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
  async function handleStatic(req, res, url, editor = false) {
    if (!SERVE_CLIENT) return send(res, 404, 'This server does not host the client. Use the AgentSys Client.', 'text/plain');
    let rel = decodeURIComponent(url.pathname);
    // A colon opens a Windows drive or an NTFS alternate data stream (`file.js::$DATA`), and a backslash or NUL is
    // never part of a served path. Refuse them before the file is looked up, so a stream suffix cannot slip past
    // the server-only pattern below. Windows 8.3 aliases (`BACKEN~1`) are refused for the same reason: they would
    // spell a server-only directory without matching its name.
    if (/[:\\\0]/.test(rel) || (process.platform === 'win32' && /(?:^|[\\/])[^\\/]*~[0-9][^\\/]*(?:[\\/]|$)/.test(rel)))
      return send(res, 404, 'Not found', 'text/plain');
    const pageRoute = editor && (!path.extname(rel) || /^\/(?:p|library|ext)\//.test(rel));
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(ROOT, rel);
    // Windows resolves directory names case-insensitively and ignores trailing dots/spaces.
    const normalized = value =>
      process.platform === 'win32' ? value.replace(/[. ]+(?=[\\/]|$)/g, '').toLowerCase() : value;
    const inside = (target, directory) => {
      const name = normalized(target),
        root = normalized(directory);
      return name === root || name.startsWith(root + path.sep);
    };
    if (
      !file.startsWith(ROOT + path.sep) ||
      inside(file, DATA) ||
      inside(file, path.join(ROOT, 'data')) ||
      /(^|[\\/])\.|node_modules|\0/.test(rel)
    )
      return send(res, 404, 'Not found', 'text/plain');
    // A page of the editor (/editor/p/…, /editor/settings, /editor/plugins): no such file (a folder is not one), so the editor opens and shows it.
    if (pageRoute && !(fs.statSync(file, {throwIfNoEntry: false})?.isFile() ?? false))
      file = path.join(ROOT, 'index.html');
    // Serve only public assets, never arbitrary files from the checkout and never server-only code.
    const publicPath = path.relative(ROOT, file).split(path.sep).join('/');
    if (!/^(?:index\.html$|(?:js|css|docs|shared|client-plugins)\/)/.test(publicPath) || SERVER_ONLY.test(publicPath))
      return send(res, 404, 'Not found', 'text/plain');
    let data;
    try {
      data = await fs.promises.readFile(file);
    } catch (error) {
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return send(res, 404, 'Not found', 'text/plain');
      throw error;
    }
    // Nested editor routes resolve their assets under /editor/ too.
    if (file === path.join(ROOT, 'index.html')) {
      let stored = {};
      if (!hostRefused(req) && (!TOKEN || tokenGiven(req)) && (loopbackBound || TOKEN)) {
        try {
          stored = readKey('ui-state') || {};
        } catch {
          // A damaged preference file must not make the editor unavailable; the browser-local store starts empty.
          stored = {};
        }
      }
      const state = JSON.stringify(stored).replace(/</g, '\\u003c');
      data = Buffer.from(
        String(data).replace('<head>', () => '<head><script>globalThis.AGENTSYS_UI_STORE=' + state + ';</script>')
      );
      if (editor)
        data = Buffer.from(
          String(data).replace(/(\s(?:src|href)=")(js|css|shared|client-plugins)\//g, '$1/editor/$2/')
        );
    }
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  }

  const server = TLS
    ? https.createServer(TLS, handleRequest)
    : http.createServer(handleRequest);
  function handleRequest(req, res) {
    // Security and protocol headers apply to every answer, including errors.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Agentsys-Protocol', String(Protocol.PROTOCOL));
    if (SERVE_CLIENT) {
      // The combined local server hosts the same interface as bin/agentsys-client.js and sends the same policy:
      // the page cannot be framed, and only its own files, inline styles and the plugin blob frames may load.
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'"
      );
    }
    for (const [name, value] of Object.entries(corsHeaders(req))) res.setHeader(name, value);
    let run;
    try {
      const url = new URL(req.url, 'http://localhost');
      // The app lives under /editor/: its files, its data and its API are reached through that prefix too; / and /editor go there.
      let editor = false;
      if (!SERVE_CLIENT && (url.pathname === '/' || url.pathname.startsWith('/editor'))) {
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        return res.end('This is an AgentSys Server: the GUI is a separate client. See GET /api/meta.');
      }
      if (url.pathname === '/' || url.pathname === '/editor') {
        res.writeHead(301, {Location: '/editor/' + url.search});
        return res.end();
      }
      if (url.pathname.startsWith('/editor/')) {
        editor = true;
        url.pathname = url.pathname.slice('/editor'.length);
      }
      run =
        editor && /^\/api\/?$/.test(url.pathname)
          ? handleStatic(req, res, url, true)
          : url.pathname.startsWith('/__data')
            ? handleData(req, res, url)
            : url.pathname.startsWith('/api/')
              ? handleApi(req, res, url)
              : handleStatic(req, res, url, editor);
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
    async close() {
      closing = true;
      clearInterval(watcher);
      clearInterval(sessionSweep);
      await backend?.Backend.shutdownExecutions();      for (const res of clients) res.end();
      clients.clear();
      for (const [res, entry] of eventClients) {
        clearInterval(entry.heartbeat);
        try {
          res.end();
        } catch {}
      }
      eventClients.clear();

      if (!ALLOW_SHARED_DATA) {
        try {
          const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
          if (Number(holder?.pid) === process.pid) fs.rmSync(LOCK_FILE, {force: true});
        } catch {}
      }
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(() => resolve()));
    },
    api: backend?.Backend ?? null,
    apiAvailable: !!backend && (loopbackBound || !!TOKEN),
    /** The message redactor used for API errors and diagnostics (tested directly). */
    redact,
  };
}

module.exports = {createServer};

if (require.main === module) {
  function readPort(argv, envPort) {
    let port = envPort === undefined ? 8080 : Number(envPort);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--port') {
        if (argv[i + 1] === undefined) throw new Error('Usage: node server.js [--port <number>]');
        port = Number(argv[++i]);
      } else if (arg.startsWith('--port=')) {
        port = Number(arg.slice('--port='.length));
      } else {
        throw new Error(`Unknown option: ${arg}. Usage: node server.js [--port <number>]`);
      }
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error(`Invalid port: ${port}. Choose a number from 0 to 65535.`);
    return port;
  }

  let port;
  try {
    port = readPort(process.argv.slice(2), process.env.PORT);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const app = createServer();
  app
    .listen(port)
    .then(url => {
      console.log(`AgentSys: ${url}`);
      console.log(`Data folder: ${app.dataDir}`);
      if (!app.api) console.log('The HTTP API is off: the backend could not be loaded.');
      else if (app.apiAvailable) console.log(`HTTP API: ${url}/api/openapi.json`);
      else console.log('HTTP API: off. Set AGENTSYS_TOKEN to use it on an address other than 127.0.0.1.');
    })
    .catch(error => {
      console.error(
        error.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another port with --port or PORT.` : error.message
      );
      process.exit(1);
    });
}
