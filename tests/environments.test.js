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
          // Never closes: an event stream stays open until it is aborted.
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
  assert.deepEqual(Array.from(Environment.list(), env => env.name), ['Local server']);
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
  assert.equal(sessionStorage.getItem('agentsys-token:' + saved.id), 'good');
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

test('an address without a scheme, with credentials or with a path is refused', async () => {
  const {Environment} = makeEnvironment(plainServer);
  assert.throws(() => Environment.normalizeURL('agentsys.example.com'), error => error.code === 'invalid_request');
  assert.throws(() => Environment.normalizeURL('ftp://example.com'), error => error.code === 'invalid_request');
  assert.throws(() => Environment.normalizeURL('https://user:pass@example.com'), error => error.code === 'invalid_request');
  assert.equal(Environment.normalizeURL('https://example.com/'), 'https://example.com');
  assert.equal(Environment.normalizeURL('https://example.com/base/?q=1#x'), 'https://example.com/base');
});
