'use strict';
// The client transport (js/app/environments.js) without a browser: one fake server, a real EventSource-shaped
// stream built from fetch, and the storage the file uses. These are the semantics that decide whether two servers
// can mix their data, and whether a restarted server locks the user out.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const Protocol = require('../shared/protocol');

const ROOT = path.join(__dirname, '..');

/** A scripted server: `handler(request)` returns {status, body, headers} or {stream: true}. */
function makeEnvironment(handler) {
  const requests = [];
  const storage = () => {
    const data = new Map();
    return {
      getItem: key => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(String(key), String(value)),
      removeItem: key => data.delete(key),
      clear: () => data.clear(),
      key: index => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
      _data: data,
    };
  };
  const localStorage = storage(),
    sessionStorage = storage();
  const fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    const request = {
      url,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
      signal: init.signal,
    };
    requests.push(request);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
    const result = await handler(request, {requests, localStorage, sessionStorage});
    if (result && result.stream) {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(result.stream.initial || ''));
          // An event stream stays open until it is aborted, unless the scripted answer closes it.
          if (result.stream.close) controller.close();
        },
      });
      return new Response(body, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
    }
    const status = result?.status ?? 200;
    return new Response(result?.body === undefined ? '' : JSON.stringify(result.body), {
      status,
      headers: {'Content-Type': 'application/json', ...(result?.headers || {})},
    });
  };
  const context = vm.createContext({
    console,
    localStorage,
    sessionStorage,
    fetch,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    location: {protocol: 'http:', origin: 'http://client.test'},
  });
  context.self = context;
  context.globalThis = context;
  context.AgentSysProtocol = Protocol;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'app', 'environments.js'), 'utf8'), context);
  const Environment = vm.runInContext('Environment', context);
  return {Environment, requests, localStorage, sessionStorage, context};
}

const meta = {agentsys: true, product: Protocol.PRODUCT, protocol: Protocol.PROTOCOL, auth: 'loopback'};
const API = Protocol.META_PATH;

/** A server that answers discovery, the session probe and changes; nothing needs authentication. */
const plainServer = (request, tools) => {
  if (request.url.includes(API)) return {body: meta};
  if (request.url.includes('/api/session')) return {body: {ok: true}};
  if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: 'data: {"type":"ready"}\n\n'}};
  if (request.url.includes('/api/projects')) return {body: [{id: 'p1', name: 'From ' + request.url}]};
  return {body: {}};
};

test('start() discovers the server, proves the session and opens one event stream', async () => {
  const {Environment, requests} = makeEnvironment(plainServer);
  assert.equal(await Environment.start(), true);
  const status = Environment.status();
  assert.equal(status.status, 'connected');
  assert.equal(status.meta.protocol, Protocol.PROTOCOL);
  assert.deepEqual(Array.from(Environment.list(), env => env.name), ['Local Server']);
  // The client is served by an AgentSys server in this harness, so the default is that origin, not a constant.
  assert.equal(Environment.apiURL('projects'), 'http://client.test/api/projects');
  const paths = requests.map(request => new URL(request.url).pathname);
  assert.deepEqual(paths, ['/api/meta', '/api/session', '/api/events']);
  assert.equal(requests[0].method, 'GET');
  // Every API call carries the CSRF header the server requires of a cookie-authenticated write.
  await Environment.request('POST', 'projects', {body: {name: 'x'}});
  assert.equal(requests.at(-1).headers['X-AgentSys'], '1');
  assert.equal(requests.at(-1).headers['Content-Type'], 'application/json');
});

test('a token stays in this tab, is sent as a bearer header and is exchanged for a session', async () => {
  const {Environment, requests, localStorage, sessionStorage} = makeEnvironment((request) => {
    if (request.url.includes(API)) return {body: {...meta, auth: 'token'}};
    if (request.url.includes('/api/auth/session')) {
      const body = JSON.parse(request.body);
      return body.token === 'good'
        ? {status: 200, body: {ok: true, mode: 'token'}, headers: {'Set-Cookie': 'agentsys_session=abc; HttpOnly'}}
        : {status: 401, body: {error: {code: 'unauthorized', message: 'bad'}}};
    }
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    return {body: {}};
  });
  const saved = Environment.save({name: 'Remote', url: 'https://agentsys.example.com', token: 'good'});
  assert.equal(saved.id.startsWith('env-'), true);
  assert.equal(await Environment.setActive(saved.id), true);
  assert.equal(sessionStorage.getItem('agentsys-token:' + saved.id + '@' + encodeURIComponent(saved.url)), 'good');
  assert.equal([...localStorage._data.keys()].some(key => key.startsWith('agentsys-token')), false, 'a token never reaches localStorage');
  const session = requests.find(request => request.url.includes('/api/auth/session'));
  assert.equal(session.method, 'POST');
  assert.deepEqual(JSON.parse(session.body), {token: 'good'});
  assert.equal(session.headers.Authorization, undefined, 'the session POST carries the token in its body');
  const metaCall = requests.find(request => request.url.includes(API));
  assert.equal(metaCall.headers.Authorization, 'Bearer good', 'discovery uses the bearer header when a token exists');
});

test('a 401 renews the session once and repeats the same read', async () => {
  let reads = 0;
  const {Environment, requests} = makeEnvironment((request) => {
    if (request.url.includes(API)) return {body: {...meta, auth: 'token'}};
    if (request.url.includes('/api/auth/session')) return {status: 200, body: {ok: true}};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    if (request.url.includes('/api/projects')) {
      reads++;
      return reads === 1
        ? {status: 401, body: {error: {code: 'unauthorized', message: 'session expired'}}}
        : {body: [{id: 'p1', name: 'Second'}]};
    }
    return {body: {}};
  });
  const saved = Environment.save({name: 'Remote', url: 'http://remote.test', token: 'good'});
  await Environment.setActive(saved.id);
  const projects = await Environment.request('GET', 'projects');
  assert.equal(projects[0].name, 'Second');
  assert.equal(reads, 2);
  assert.equal(requests.filter(request => request.url.includes('/api/auth/session')).length >= 2, true);
  // A second failure would surface as unauthorized instead of looping.
  Environment.sessionStorage;
});

test('API renewal retries the original encoded body even if the caller mutates its object', async () => {
  const sent = [];
  let encodings = 0;
  const body = {name: 'Original', nested: {value: 1}};
  Object.defineProperty(body, 'toJSON', {value() {
    encodings++;
    return {name: this.name, nested: this.nested};
  }});
  const {Environment, context} = makeEnvironment((request, tools) => {
    if (request.method === 'POST' && request.url.endsWith('/api/projects')) {
      sent.push(request.body);
      if (sent.length === 1) {
        body.name = 'Changed later';
        body.nested.value = 2;
        return {status: 401, body: {error: {code: 'unauthorized', message: 'Renew the session'}}};
      }
      return {body: {id: 'p1'}};
    }
    return plainServer(request, tools);
  });
  const remote = Environment.save({name: 'Remote', url: 'https://server.test', token: 'owner-token'});
  assert.equal(await Environment.setActive(remote.id), true);
  context.document = {addEventListener() {}};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/app/helpers.js'), 'utf8'), context);
  const api = vm.runInContext('api', context);
  assert.equal((await api('projects', {method: 'POST', body})).id, 'p1');
  const original = JSON.stringify({name: 'Original', nested: {value: 1}});
  assert.deepEqual(sent, [original, original]);
  assert.equal(encodings, 1, 'body is encoded once for the entire request lifecycle');
});

test('a network failure is never retried, and a mutation is not repeated', async () => {
  const {Environment, requests} = makeEnvironment((request) => {
    if (request.url.includes(API)) return {body: meta};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    return {status: 503, body: {error: {code: 'unavailable', message: 'nope'}}};
  });
  await Environment.start();
  const before = requests.length;
  await assert.rejects(Environment.request('POST', 'projects', {body: {name: 'x'}}), error => error.status === 503);
  assert.equal(requests.length - before, 1, 'a write reaches the server exactly once');
});

test('switching environments aborts in-flight requests and rejects their late answers', async () => {
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  const {Environment, requests} = makeEnvironment(async (request) => {
    if (request.url.includes(API)) return {body: meta};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    if (request.url.includes('slow')) {
      await pending;
      return {body: {project: 'of the first server'}};
    }
    return {body: []};
  });
  const first = Environment.save({name: 'First', url: 'http://first.test'});
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  await Environment.setActive(first.id);
  const slow = Environment.request('GET', 'slow');
  // Let the request reach fetch, then switch.
  await new Promise(resolve => setTimeout(resolve, 20));
  const slowCall = requests.find(request => request.url.includes('slow'));
  assert.ok(slowCall, 'the request was sent');
  await Environment.setActive(second.id);
  assert.equal(slowCall.signal.aborted, true, 'switching cancels the old server request');
  release();
  await assert.rejects(slow, error => ['stale_environment', 'AbortError'].includes(error.code || error.name));
  assert.equal(Environment.status().environment.name, 'Second');
});

test('an answer of the old server cannot change the new environment status', async () => {
  const {Environment} = makeEnvironment(async (request) => {
    if (request.url.includes(API)) return {body: meta};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    if (request.url.includes('boom')) return {status: 500, body: {error: {code: 'internal', message: 'old'}}};
    return {body: []};
  });
  const first = Environment.save({name: 'First', url: 'http://first.test'});
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  await Environment.setActive(first.id);
  const failing = Environment.request('GET', 'boom').catch(error => error);
  await Environment.setActive(second.id);
  const error = await failing;
  assert.ok(error);
  assert.equal(Environment.status().status, 'connected', 'the new environment stays connected');
});

test('removing the active environment disconnects it and connects the next one', async () => {
  const {Environment} = makeEnvironment(plainServer);
  await Environment.start();
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  await Environment.setActive(second.id);
  assert.equal(Environment.status().status, 'connected');
  await Environment.setActive('local');
  const list = Environment.remove('local');
  assert.deepEqual(Array.from(list, env => env.name), ['Second']);
  assert.equal(Environment.active().name, 'Second');
  // The removal starts a fresh connection to the next environment; it must not keep the old status or meta.
  await new Promise(resolve => setTimeout(resolve, 50));
  const state = Environment.status();
  assert.equal(state.environment.name, 'Second');
  assert.equal(state.status, 'connected');
  assert.equal(state.meta.product, Protocol.PRODUCT);
});

test('an incompatible server is reported as such and is not used', async () => {
  const {Environment} = makeEnvironment((request) => {
    if (request.url.includes(API)) return {body: {...meta, protocol: Protocol.PROTOCOL + 1}};
    return {body: {}};
  });
  assert.equal(await Environment.start(), false);
  assert.equal(Environment.status().status, 'incompatible');
  assert.match(Environment.status().detail, /protocol/i);
  // A request to a server of another protocol is refused before it is sent.
  await assert.rejects(Environment.request('GET', 'projects'), error => error.code === 'incompatible_protocol');
});

test('an address without a scheme, with credentials or with a path is refused', async () => {  const {Environment} = makeEnvironment(plainServer);
  assert.throws(() => Environment.normalizeURL('agentsys.example.com'), error => error.code === 'invalid_request');
  assert.throws(() => Environment.normalizeURL('ftp://example.com'), error => error.code === 'invalid_request');
  assert.throws(() => Environment.normalizeURL('https://user:pass@example.com'), error => error.code === 'invalid_request');
  assert.equal(Environment.normalizeURL('https://example.com/'), 'https://example.com');
  assert.equal(Environment.normalizeURL('https://example.com/base/?q=1#x'), 'https://example.com/base');
});

test('rapid switching settles on the last environment, with no stale status', async () => {
  const {Environment, requests} = makeEnvironment(plainServer);
  await Environment.start();
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  const third = Environment.save({name: 'Third', url: 'http://third.test'});
  // Three switches without waiting: the last one wins and earlier connections cannot report over it.
  const attempts = [Environment.setActive(second.id), Environment.setActive(third.id), Environment.setActive('local')];
  const results = await Promise.all(attempts);
  assert.equal(results.at(-1), true);
  const state = Environment.status();
  assert.equal(state.environment.name, 'Local Server');
  assert.equal(state.status, 'connected');
  assert.equal(state.meta.product, Protocol.PRODUCT);
  // The last stream that was opened is the default server's, not one of the abandoned ones.
  const streams = requests.filter(request => request.url.includes(Protocol.EVENTS_PATH));
  assert.ok(streams.length >= 1);
  await Environment.setActive('local', {reconnect: false});
});

test('the event stream reconnects with backoff after it closes, without replaying a mutation', async () => {
  let opens = 0;
  let writes = 0;
  const {Environment} = makeEnvironment(request => {
    if (request.url.includes(API)) return {body: meta};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) {
      opens++;
      // The first stream closes at once (a proxy timeout); the next one stays open.
      return opens === 1 ? {stream: {initial: 'data: {"type":"ready"}\n\n', close: true}} : {stream: {initial: 'data: {"type":"ready"}\n\n'}};
    }
    if (request.url.includes('/api/projects')) {
      if (request.method === 'POST') writes++;
      return {body: []};
    }
    return {body: {}};
  });
  await Environment.start();
  await Environment.request('POST', 'projects', {body: {name: 'once'}});
  // Wait for the scheduled reconnect (500 ms first backoff).
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(opens >= 2, `the stream was reopened (${opens})`);
  assert.equal(writes, 1, 'a reconnect never repeats a write');
  assert.equal(Environment.status().status, 'connected');
  await Environment.setActive('local', {reconnect: false});
});

test('a plugin token is minted once per environment and capability set, and revoked explicitly', async () => {
  let mints = 0;
  const deletes = [];
  const {Environment} = makeEnvironment(request => {
    if (request.url.includes(API)) return {body: meta};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    if (request.url.includes('/api/auth/plugin-session')) {
      if (request.method === 'DELETE') {
        deletes.push(request.headers.Authorization);
        return {body: {revoked: true}};
      }
      mints++;
      return {body: {token: 'pst_' + mints, expires_in: 3600, capabilities: ['graph.read']}};
    }
    return {body: []};
  });
  await Environment.start();
  assert.equal(await Environment.pluginToken(['graph.read']), 'pst_1');
  assert.equal(await Environment.pluginToken(['graph.read']), 'pst_1', 'the cached token is reused');
  assert.equal(mints, 1);
  // The capability set is a set: the same values in another order use the same token.
  assert.equal(await Environment.pluginToken(['graph.read']), 'pst_1');
  assert.equal(mints, 1);
  Environment.revokePluginToken('pst_1');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(deletes, ['Bearer pst_1']);
  // A switch starts a new generation: a token of the previous server is not reused.
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  await Environment.setActive(second.id);
  assert.equal(await Environment.pluginToken(['graph.read']), 'pst_2');
  await Environment.setActive(second.id, {reconnect: false});
});

test('a server without plugin tokens is remembered instead of asked on every plugin call', async () => {
  let posts = 0;
  const {Environment} = makeEnvironment(request => {
    if (request.url.includes(API)) return {body: meta};
    if (request.url.includes('/api/session')) return {body: {ok: true}};
    if (request.url.includes(Protocol.EVENTS_PATH)) return {stream: {initial: ''}};
    if (request.url.includes('/api/auth/plugin-session')) {
      posts++;
      return {status: 404, body: {error: {code: 'not_found', message: 'no such route'}}};
    }
    return {body: []};
  });
  await Environment.start();
  assert.equal(await Environment.pluginToken(['graph.read']), null);
  assert.equal(await Environment.pluginToken(['graph.read']), null);
  assert.equal(posts, 1, 'the missing route is remembered for a while');
  await Environment.setActive('local', {reconnect: false});
});

test('a scoped 401 preserves its error and never retries with the owner credential', async () => {
  let writes = 0;
  const {Environment, requests} = makeEnvironment(request => {
    if (request.url.endsWith('/api/projects') && request.method === 'POST') {
      writes++;
      return request.headers.Authorization === 'Bearer expired-plugin'
        ? {status: 401, body: {error: {code: 'plugin_token_expired', message: 'expired'}}}
        : {body: {id: 'unauthorized-write'}};
    }
    return plainServer(request);
  });
  Environment.save({id: 'local', name: 'Local', url: 'http://client.test', token: 'owner-token'});
  await Environment.start();
  const before = requests.length;
  await assert.rejects(Environment.request('POST', 'projects', {body: {}, auth: 'expired-plugin'}),
    error => error.code === 'plugin_token_expired' && error.status === 401);
  assert.equal(writes, 1);
  assert.equal(requests.length, before + 1, 'no owner session renewal');
  assert.equal(Environment.status().status, 'connected', 'plugin expiry does not sign the owner out');
  await Environment.setActive('local', {reconnect: false});
});

test('concurrent token requests join per owner; equal grants do not share revocation', async () => {
  let mints = 0;
  const revoked = [];
  const {Environment} = makeEnvironment(async request => {
    if (request.url.endsWith('/api/auth/plugin-session')) {
      if (request.method === 'DELETE') {
        revoked.push(request.headers.Authorization);
        return {body: {revoked: true}};
      }
      const id = ++mints;
      await new Promise(resolve => setTimeout(resolve, 10));
      return {body: {token: 'pst_' + id, expires_in: 3600}};
    }
    return plainServer(request);
  });
  await Environment.start();
  const tokens = await Promise.all(Array.from({length: 12}, () => Environment.pluginToken(['graph.read'], {owner: 'first'})));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(mints, 1);
  const second = await Environment.pluginToken(['graph.read'], {owner: 'second'});
  assert.notEqual(second, tokens[0]);
  Environment.revokePluginToken(tokens[0]);
  assert.equal(await Environment.pluginToken(['graph.read'], {owner: 'second'}), second);
  assert.deepEqual(revoked, ['Bearer pst_1']);
  await Environment.setActive('local', {reconnect: false});
});

test('token issuance failures fail closed and a missing route cache expires', async () => {
  let now = Date.now(), status = 404, mints = 0;
  const {Environment, context} = makeEnvironment(request => {
    if (request.url.endsWith('/api/auth/plugin-session')) {
      mints++;
      return {status, body: {error: {code: 'denied', message: 'denied'}}};
    }
    return plainServer(request);
  });
  context.testNow = () => now;
  vm.runInContext('Date.now = testNow', context);
  await Environment.start();
  assert.equal(await Environment.pluginToken([]), null);
  assert.equal(await Environment.pluginToken([]), null);
  assert.equal(mints, 1);
  now += 6 * 60 * 1000;
  status = 403;
  await assert.rejects(Environment.pluginToken([]), error => error.status === 403);
  assert.equal(mints, 2);
  await Environment.setActive('local', {reconnect: false});
});

test('sign out actually posts to the issuing server logout endpoint', async () => {
  const {Environment, requests} = makeEnvironment(plainServer);
  await Environment.start();
  await Environment.signOut();
  const logout = requests.filter(request => request.url.endsWith('/api/auth/logout'));
  assert.equal(logout.length, 1);
  assert.equal(logout[0].method, 'POST');
  assert.equal(Environment.status().status, 'disconnected');
});

test('failed or declined edit flush prevents a server switch', async () => {
  const {Environment} = makeEnvironment(plainServer);
  await Environment.start();
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  const gen = Environment.generation();
  const unsubscribe = Environment.onBeforeSwitch(() => { throw new Error('Unsaved edit'); });
  await assert.rejects(Environment.setActive(second.id), /Unsaved edit/);
  assert.equal(Environment.active().id, 'local');
  assert.equal(Environment.generation(), gen);
  unsubscribe();
  const decline = Environment.onBeforeSwitch(() => false);
  assert.equal(await Environment.setActive(second.id), false);
  assert.equal(Environment.active().id, 'local');
  decline();
  await Environment.setActive('local', {reconnect: false});
});

test('the latest switch wins even when an earlier save hook finishes last', async () => {
  const {Environment} = makeEnvironment(plainServer);
  await Environment.start();
  const second = Environment.save({name: 'Second', url: 'http://second.test'});
  const third = Environment.save({name: 'Third', url: 'http://third.test'});
  let release, first = true;
  const unsubscribe = Environment.onBeforeSwitch(() => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { release = resolve; });
  });
  const old = Environment.setActive(second.id);
  assert.equal(await Environment.setActive(third.id), true);
  release();
  assert.equal(await old, false);
  assert.equal(Environment.active().id, third.id);
  unsubscribe();
  await Environment.setActive(third.id, {reconnect: false});
});

test('removing a server revokes credentials only at the original URL', async () => {
  const deletes = [];
  const {Environment} = makeEnvironment(request => {
    if (request.url.endsWith('/api/auth/plugin-session')) {
      if (request.method === 'DELETE') { deletes.push(request.url); return {body: {revoked: true}}; }
      return {body: {token: 'pst_private', expires_in: 3600}};
    }
    return plainServer(request);
  });
  await Environment.start();
  const remote = Environment.save({name: 'Remote', url: 'http://remote.test'});
  await Environment.setActive(remote.id);
  await Environment.pluginToken(['graph.read']);
  Environment.remove(remote.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(deletes, ['http://remote.test/api/auth/plugin-session']);
  await Environment.setActive('local', {reconnect: false});
});

test('editing a server URL never forwards the old credential to the new endpoint', async () => {
  const {Environment, requests, sessionStorage} = makeEnvironment(plainServer);
  const env = Environment.save({name: 'Original', url: 'http://original.test', token: 'old-secret'});
  await Environment.setActive(env.id);
  // Simulate a tab opened by the previous release, whose credential had no URL in its key.
  sessionStorage.removeItem('agentsys-token:' + env.id + '@' + encodeURIComponent(env.url));
  sessionStorage.setItem('agentsys-token:' + env.id, 'old-secret');
  Environment.save({...env, url: 'http://replacement.test'});
  let flushed = 0;
  Environment.onBeforeSwitch(() => { flushed++; });
  assert.equal(await Environment.reconnect(), true);
  assert.equal(flushed, 1, 'an edited endpoint reconnect runs the normal save guards');
  assert.equal(Environment.active().url, 'http://replacement.test');
  const replacement = requests.filter(request => request.url.startsWith('http://replacement.test/'));
  assert.ok(replacement.length >= 2);
  assert.equal(replacement.some(request => request.headers.Authorization || request.body?.includes('old-secret')), false);
  await Environment.setActive(env.id, {reconnect: false});
});

test('a newly entered token cannot reach the still-active old URL while its edits are flushed', async () => {
  const {Environment, requests} = makeEnvironment(plainServer);
  const env = Environment.save({name: 'Original', url: 'http://original.test', token: 'old-secret'});
  await Environment.setActive(env.id);
  Environment.save({...env, url: 'http://replacement.test', token: 'new-secret'});
  await Environment.request('GET', 'projects');
  assert.equal(requests.at(-1).url, 'http://original.test/api/projects');
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer old-secret');
  await Environment.reconnect();
  await Environment.request('GET', 'projects');
  assert.equal(requests.at(-1).url, 'http://replacement.test/api/projects');
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer new-secret');
  await Environment.setActive(env.id, {reconnect: false});
});
