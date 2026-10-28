#!/usr/bin/env node
// AgentSys local server: serves the site, keeps the data as JSON files in the data/ folder, and runs the same
// backend the browser has as an HTTP API (/api/…), so runs, triggers and outside programs work with no page open.
// No dependencies. Run:  node server.js
// Environment: PORT, HOST (default 127.0.0.1), DATA_DIR, AGENTSYS_TOKEN (required to use /api on a non-loopback
// HOST; optional otherwise), ALLOWED_HOSTS (extra Host header names accepted on loopback, comma separated).
'use strict';
const http = require('http'),
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const {loadBackend} = require('./headless');
const TextGraph = require('./js/storage/format');

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
//   run:<id> -> runs/<id>.json                 anything else -> other/<key>.json
const FIXED = {
  prefs: 'settings.json',
  projects: 'projects.json',
  meta: 'meta.json',
  resources: 'library/resources.json',
  node_folders: 'library/node_folders.json',
  library_types: 'library/types.json',
};
const VALID_KEY = /^(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9:._/-]{1,500}$/;
const storagePath = key => key.split('/').map(encodeURIComponent).join('/');
const journalKey = key => /^(workflows\/[^/]+\/queues\/[^/]+\/journal|runs\/[^/]+\/events)$/.test(key);
const fileOf = key => {
  if (journalKey(key)) return storagePath(key) + '.jsonl';
  if (key.includes('/')) return storagePath(key) + '.json';
  if (FIXED[key]) return FIXED[key];
  let m = /^wf:lib-(.+)$/.exec(key);
  if (m) return `library/editors/${m[1]}.json`;
  m = /^wf:(.+)$/.exec(key);
  if (m) return `workflows/${m[1]}.json`;
  m = /^run:(.+)$/.exec(key);
  if (m) return `last-runs/${m[1]}.json`;
  return `other/${key.replace(/:/g, '__')}.json`;
};
const keyOf = file => {
  const rel = file.split(path.sep).map(decodeURIComponent).join('/');
  if (rel.endsWith('.jsonl') && journalKey(rel.slice(0, -6))) return rel.slice(0, -6);
  const sidecar = /^(.*)\.files\/(?:layout\.json|scripts\/[A-Za-z0-9_-]+\.js)$/.exec(rel);
  if (sidecar) return keyOf(sidecar[1] + '.json');
  if ((/^(runs|versions|secrets)\//.test(rel) && rel.endsWith('.json')) || /^workflows\/[^/]+\/.+\.json$/.test(rel))
    return rel.slice(0, -5);
  for (const [key, f] of Object.entries(FIXED)) if (f === rel) return key;
  let m = /^library\/editors\/(.+)\.json$/.exec(rel);
  if (m) return `wf:lib-${m[1]}`;
  m = /^workflows\/(.+)\.json$/.exec(rel);
  if (m) return `wf:${m[1]}`;
  m = /^last-runs\/(.+)\.json$/.exec(rel);
  if (m) return `run:${m[1]}`;
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
        e.name.endsWith('.jsonl') ||
        (p.includes('.files' + path.sep + 'scripts' + path.sep) && e.name.endsWith('.js'))) &&
      !e.name.includes('.tmp-')
    )
      out.push(p);
  }
  return out;
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
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Too large'), {status: 413}));
        req.destroy();
      } else chunks.push(c);
    });
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
 * Options: dataDir, host, token, allowedHosts (array), scheduler (false to switch the interval triggers off).
 */
function createServer(options = {}) {
  const DATA = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data')),
    HOST = options.host || process.env.HOST || '127.0.0.1',
    TOKEN = options.token ?? process.env.AGENTSYS_TOKEN ?? '',
    loopbackBound = LOOPBACK.has(HOST) || /^127\./.test(HOST),
    allowedHosts = new Set(
      (options.allowedHosts || String(process.env.ALLOWED_HOSTS || '').split(','))
        .map(h => h.trim().toLowerCase())
        .filter(Boolean)
    );
  const abs = key => path.join(DATA, ...fileOf(key).split('/'));
  const snapshot = () => {
    const map = new Map();
    for (const p of walk(DATA)) {
      const key = keyOf(path.relative(DATA, p)),
        stamp = key && stampOf(p);
      if (stamp) map.set(key, (map.get(key) || '') + path.relative(DATA, p) + ':' + stamp + ';');
    }
    return map;
  };
  let known = snapshot();
  function readKey(key) {
    let value;
    try {
      if (journalKey(key)) {
        const text = fs.readFileSync(abs(key), 'utf8'),
          lines = text.split('\n'),
          entries = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          try {
            entries.push(JSON.parse(lines[i]));
          } catch (error) {
            if (i !== lines.length - 1) throw error;
          }
        }
        return entries;
      }
      value = JSON.parse(fs.readFileSync(abs(key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (key === 'resources' || key.startsWith('wf:') || key.startsWith('versions/content/')) {
      if (value.format !== TextGraph.FORMAT) throw new Error('Expected canonical graph files: ' + key);
      const folder = abs(key).replace(/\.json$/, '.files');
      const files = {
        'graph.json': JSON.stringify(value),
        'layout.json': fs.readFileSync(path.join(folder, 'layout.json'), 'utf8'),
      };
      const scripts = new Set();
      const scan = v => {
        if (!v || typeof v !== 'object') return;
        if (v.$script) scripts.add(v.$script);
        for (const child of Object.values(v)) scan(child);
      };
      scan(value.value);
      for (const name of scripts) {
        if (!/^scripts\/[A-Za-z0-9_-]+\.js$/.test(name)) throw new Error('Invalid script path');
        files[name] = fs.readFileSync(path.join(folder, ...name.split('/')), 'utf8');
      }
      value = TextGraph.decode({format: TextGraph.FORMAT, files});
    }
    return value;
  }
  function atomicText(file, text) {
    try {
      if (fs.readFileSync(file, 'utf8') === text) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    // On Windows another program (antivirus, indexer, sync, editor) may hold the target for a moment, and rename then fails with
    // EPERM/EBUSY/EACCES. Retry briefly; if the target stays locked, fail without replacing it with a partial write.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
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
  const clients = new Set();
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
  };
  function writeKey(key, value) {
    if (journalKey(key)) {
      const file = abs(key),
        before = readKey(key) ?? [];
      if (!Array.isArray(value)) throw new Error('Journal entries must be an array');
      const prefix =
        before.length <= value.length && before.every((e, i) => JSON.stringify(e) === JSON.stringify(value[i]));
      if (!prefix) return atomicText(file, value.map(e => JSON.stringify(e) + '\n').join(''));
      fs.mkdirSync(path.dirname(file), {recursive: true});
      // Remove a torn final append before retrying the idempotent transaction.
      const expected = before.map(e => JSON.stringify(e) + '\n').join('');
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== expected) atomicText(file, expected);
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeFileSync(
          fd,
          value
            .slice(before.length)
            .map(e => JSON.stringify(e) + '\n')
            .join('')
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    const file = abs(key);
    if (key === 'resources' || key.startsWith('wf:') || key.startsWith('versions/content/')) {
      const packet = TextGraph.encode(value),
        folder = file.replace(/\.json$/, '.files');
      let previous = [];
      try {
        const before = JSON.parse(fs.readFileSync(file, 'utf8'));
        const scan = v => {
          if (!v || typeof v !== 'object') return;
          if (v.$script) previous.push(v.$script);
          Object.values(v).forEach(scan);
        };
        scan(before.value);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const [name, text] of Object.entries(packet.files))
        if (name !== 'graph.json') atomicText(path.join(folder, ...name.split('/')), text);
      atomicText(file, packet.files['graph.json']);
      for (const name of previous)
        if (!Object.hasOwn(packet.files, name) && /^scripts\/[A-Za-z0-9_-]+\.js$/.test(name)) {
          try {
            fs.unlinkSync(path.join(folder, ...name.split('/')));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      return;
    }
    atomicText(file, JSON.stringify(value, null, 2) + '\n');
  }
  function removeKey(key) {
    const file = abs(key),
      folder = file.replace(/\.json$/, '.files');
    if (!path.resolve(folder).startsWith(path.resolve(DATA) + path.sep)) throw new Error('Unsafe storage path');
    if (key === 'resources' || key.startsWith('wf:') || key.startsWith('versions/content/')) {
      try {
        const graph = JSON.parse(fs.readFileSync(file, 'utf8')),
          files = ['layout.json'];
        const scan = v => {
          if (!v || typeof v !== 'object') return;
          if (typeof v.$script === 'string' && /^scripts\/[A-Za-z0-9_-]+\.js$/.test(v.$script)) files.push(v.$script);
          Object.values(v).forEach(scan);
        };
        scan(graph.value);
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
  function commitKeys({set = {}, remove = []}) {
    const keys = [...Object.keys(set), ...remove];
    if (!keys.every(k => VALID_KEY.test(k))) throw new Error('Invalid storage key');
    if (fs.existsSync(transactionFile)) applyTransaction(JSON.parse(fs.readFileSync(transactionFile, 'utf8')));
    atomicText(transactionFile, JSON.stringify({set, remove}));
    const transactionFd = fs.openSync(transactionFile, 'r+');
    try {
      fs.fsyncSync(transactionFd);
    } finally {
      fs.closeSync(transactionFd);
    }
    applyTransaction({set, remove});
  }
  if (fs.existsSync(transactionFile)) commitKeys(JSON.parse(fs.readFileSync(transactionFile, 'utf8')));
  known = snapshot();
  // ----- the backend: the same code the browser runs, with the data folder as its store -----
  let backend = null,
    backendError = null;
  try {
    backend = loadBackend({
      root: ROOT,
      scripts: 'worker',
      store: {
        dir: DATA,
        get(key) {
          return readKey(key);
        },
        commit({set, remove}) {
          commitKeys({set, remove});
          const current = snapshot();
          for (const k of Object.keys(set)) known.set(k, current.get(k));
          for (const k of remove) known.delete(k);
          broadcast([...Object.keys(set), ...remove], 'api'); // open pages reload what the API changed
        },
      },
    });
  } catch (error) {
    backendError = error;
  }

  if (backend) backend.Backend.request('GET', 'runs').catch(error => console.error('Recovery:', error.message));
  // Files are watched by comparing stamps: a page open gets the news within a second, and the backend forgets what it
  // had cached of a file that was edited on disk. With no page open the tree is looked at every few seconds only.
  let ticks = 0;
  const watcher = setInterval(() => {
    if (!clients.size && ++ticks % 5) return;
    const now = snapshot(),
      changed = [];
    for (const [k, v] of now) if (known.get(k) !== v) changed.push(k);
    for (const k of known.keys()) if (!now.has(k)) changed.push(k);
    known = now;
    if (changed.length) backend?.DB.changed(changed);
    broadcast(changed);
  }, 1000);
  watcher.unref();

  // ----- the scheduler: interval triggers fire while the server runs -----
  let scheduler = null;
  if (backend && options.scheduler !== false) {
    scheduler = setInterval(() => {
      backend.Backend.request('POST', 'scheduler/tick', {body: {}}).catch(error =>
        console.error('Scheduler:', error.message || error)
      );
    }, 1000);
    scheduler.unref();
  }

  // ----- /__data: the browser's storage (reads are open; writes need the X-AgentSys header) -----
  async function handleData(req, res, url) {
    if (hostRefused(req)) return sendJSON(res, 403, {error: 'forbidden'});
    const rest = url.pathname.slice('/__data'.length).replace(/^\//, '');
    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
      res.write(': connected\n\n');
      if (!clients.size) known = snapshot(); // the first page back gets a fresh baseline, not a flood
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
      const current = snapshot();
      for (const k of Object.keys(set)) known.set(k, current.get(k));
      for (const k of remove) known.delete(k);
      backend?.DB.changed(keys); // the API's cache must not outlive what the page wrote
      broadcast(keys, String(req.headers['x-client'] || ''));
      return sendJSON(res, 200, {ok: true});
    }
    sendJSON(res, 405, {error: 'method not allowed'});
  }

  // ----- /api: the backend as an HTTP API -----
  /** On a loopback address only the loopback names (and ALLOWED_HOSTS) are accepted in the Host header: a rebound name is refused. */
  const hostRefused = req => {
    if (!loopbackBound) return false;
    const host = String(req.headers.host || '')
      .replace(/:\d+$/, '')
      .toLowerCase();
    return !LOOPBACK.has(host) && !allowedHosts.has(host);
  };
  const tokenGiven = req => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    return !!(TOKEN && m && same(m[1], TOKEN));
  };
  /** Returns [status, message] when the request may not use the API. */
  function refuse(req) {
    if (!backend) return [503, 'The API could not start: ' + (backendError?.message || 'unknown error')];
    if (hostRefused(req)) return [403, 'Unexpected Host header'];
    if (!loopbackBound && !TOKEN) return [503, 'Set AGENTSYS_TOKEN to use the API on an address other than 127.0.0.1'];
    if (TOKEN && !tokenGiven(req)) return [401, 'Send the token as "Authorization: Bearer <token>"'];
    // Without a token, a request that changes anything must prove it is not a blind cross-site one.
    if (!TOKEN && !['GET', 'HEAD'].includes(req.method) && req.headers['x-agentsys'] !== '1')
      return [403, 'Send the header "X-AgentSys: 1" with requests that change data'];
    return null;
  }
  const failure = (res, error) => {
    const status = Number.isInteger(error?.status) ? error.status : error instanceof URIError ? 400 : 500; // a malformed %-escape in the address
    sendJSON(res, status, {
      error: {code: error?.code || (status === 500 ? 'internal' : 'error'), message: String(error?.message || error)},
    });
  };
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
  async function handleApi(req, res, url) {
    const denied = refuse(req);
    if (denied) return sendJSON(res, denied[0], {error: {code: 'forbidden', message: denied[1]}});
    const rel = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
    const {Backend} = backend;
    if (req.method === 'GET' && rel === 'openapi.json')
      return sendJSON(res, 200, JSON.parse(JSON.stringify(Backend.openapi())));
    const stream = /^runs\/([^/]+)\/stream$/.exec(rel);
    if (req.method === 'GET' && stream) return streamRun(req, res, decodeURIComponent(stream[1]));
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
      return sendJSON(res, 405, {error: {message: 'method not allowed'}});
    const query = Object.fromEntries(url.searchParams);
    // If-Match: <cursor> makes an edit conditional (see "if_cursor" in the API page).
    if (req.headers['if-match'] && query.if_cursor === undefined)
      query.if_cursor = String(req.headers['if-match']).replace(/"/g, '');
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await parseJSONBody(req, 20e6);
    const edit = req.headers['x-edit'];
    if (edit !== undefined && (typeof edit !== 'string' || edit.length > 100))
      throw Object.assign(new Error('Invalid edit token'), {status: 400, code: 'invalid_request'});
    const result = await Backend.request(req.method, rel, {body, query, edit: edit ?? null});
    // Results come out of the backend's own realm; JSON is the contract.
    sendJSON(
      res,
      result === undefined ? 204 : 200,
      result === undefined ? undefined : JSON.parse(JSON.stringify(result))
    );
  }
  /** Server-Sent Events of one run: every event as it happens, ending with run_finished. */
  async function streamRun(req, res, id) {
    const {Backend} = backend;
    try {
      await Backend.request('GET', `runs/${encodeURIComponent(id)}`, {});
    } catch (error) {
      return failure(res, error);
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
    let closed = false,
      after = 0;
    req.on('close', () => (closed = true));
    while (!closed) {
      let batch;
      try {
        batch = JSON.parse(
          JSON.stringify(
            await Backend.request('GET', `runs/${encodeURIComponent(id)}/events`, {query: {after, wait: 15000}})
          )
        );
      } catch {
        break;
      }
      for (const event of batch.events)
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      after = batch.next;
      if (!batch.events.length) res.write(': keep-alive\n\n');
      if (batch.finished) break;
    }
    res.end();
  }
  /** POST /hooks/<token>: starts the run of a webhook trigger. The token is the secret, so no other credential. */
  async function handleHook(req, res, url) {
    if (!backend) return sendJSON(res, 503, {error: {code: 'unavailable', message: 'The backend is not running'}});
    if (req.method !== 'POST') return sendJSON(res, 405, {error: {message: 'Use POST'}});
    const token = decodeURIComponent(url.pathname.slice('/hooks/'.length));
    const body = await parseJSONBody(req, 64000).catch(() => ({}));
    const run = await backend.Backend.request('POST', `hooks/${encodeURIComponent(token)}`, {body});
    sendJSON(res, 202, JSON.parse(JSON.stringify(run)));
  }

  function handleStatic(req, res, url, editor = false) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(ROOT, rel);
    if (
      !file.startsWith(ROOT + path.sep) ||
      file.startsWith(DATA + path.sep) ||
      /(^|[\\/])\.|node_modules|\0/.test(rel)
    )
      return send(res, 404, 'Not found', 'text/plain');
    // A page of the editor (/editor/p/…, /editor/settings): no such file, so the editor opens and shows it.
    if (editor && !path.extname(rel) && !fs.existsSync(file)) file = path.join(ROOT, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      // The page names its files without a leading path; under /editor/ (at any depth) they are found there.
      if (editor && file === path.join(ROOT, 'index.html'))
        data = Buffer.from(String(data).replace(/(\s(?:src|href)=")(js|css)\//g, '$1/editor/$2/'));
      send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  }

  const server = http.createServer((req, res) => {
    let run;
    try {
      const url = new URL(req.url, 'http://localhost');
      // The app lives under /editor/: its files, its data and its API are reached through that prefix too; / and /editor go there.
      let editor = false;
      if (url.pathname === '/' || url.pathname === '/editor') {
        res.writeHead(301, {Location: '/editor/' + url.search});
        return res.end();
      }
      if (url.pathname.startsWith('/editor/')) {
        editor = true;
        url.pathname = url.pathname.slice('/editor'.length);
      }
      run = url.pathname.startsWith('/__data')
        ? handleData(req, res, url)
        : url.pathname.startsWith('/api/')
          ? handleApi(req, res, url)
          : url.pathname.startsWith('/hooks/')
            ? handleHook(req, res, url)
            : handleStatic(req, res, url, editor);
    } catch (error) {
      run = Promise.reject(error);
    }
    Promise.resolve(run).catch(error => (res.headersSent ? res.end() : failure(res, error)));
  });

  return {
    server,
    dataDir: DATA,
    host: HOST,
    /** Resolves with the base URL once listening (port 0 picks a free one). */
    listen(port = 8080) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
          resolve(`http://${shown}:${server.address().port}`);
        });
      });
    },
    close() {
      clearInterval(watcher);
      if (scheduler) clearInterval(scheduler);
      for (const res of clients) res.end();
      clients.clear();
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(() => resolve()));
    },
    api: backend?.Backend ?? null,
    apiAvailable: !!backend && (loopbackBound || !!TOKEN),
  };
}

module.exports = {createServer};

if (require.main === module) {
  const app = createServer();
  const port = process.env.PORT !== undefined ? Number(process.env.PORT) : 8080;
  app
    .listen(port)
    .then(url => {
      console.log(`AgentSys: ${url}`);
      console.log(`Data folder: ${app.dataDir}`);
      if (!app.api) console.log('The HTTP API is off: the backend could not be loaded.');
      else if (app.apiAvailable)
        console.log(`HTTP API: ${url}/api/openapi.json (interval triggers run while this server runs)`);
      else console.log('HTTP API: off. Set AGENTSYS_TOKEN to use it on an address other than 127.0.0.1.');
    })
    .catch(error => {
      console.error(
        error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another number.` : error.message
      );
      process.exit(1);
    });
}
