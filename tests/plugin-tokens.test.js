'use strict';
// Scoped tokens for client plugins: the host exchanges its own credential for a short-lived token limited to the
// capabilities a package declared, and the SERVER enforces them on every call. This is the boundary that does not
// depend on the host page being honest.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'owner-token-123';
const OWNER = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

async function withServer(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-plugin-token-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const mint = async (base, capabilities, headers = OWNER) => {
  const response = await fetch(base + '/api/auth/plugin-session', {
    method: 'POST',
    headers,
    body: JSON.stringify({capabilities}),
  });
  const body = await response.json().catch(() => undefined);
  return {status: response.status, body};
};
const use = (base, token, method, route, body) =>
  fetch(base + '/api/' + route, {
    method,
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-AgentSys': '1'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('a token can only be issued by an authenticated caller and only with known capabilities', async () => {
  await withServer({}, async ({base}) => {
    assert.equal((await mint(base, ['graph.read'], {})).status, 401);
    assert.equal((await mint(base, ['graph.read'], {Authorization: 'Bearer wrong', 'Content-Type': 'application/json'})).status, 401);
    for (const capabilities of [['root'], ['system.admin'], 'graph.read', Array(51).fill('graph.read')]) {
      const answer = await mint(base, capabilities);
      assert.equal(answer.status, 400, JSON.stringify(capabilities));
      assert.equal(answer.body.error.code, 'invalid_request');
    }
    const issued = await mint(base, ['graph.read', 'graph.read']);
    assert.equal(issued.status, 200);
    assert.match(issued.body.token, /^pst_/);
    assert.deepEqual(issued.body.capabilities, ['graph.read'], 'duplicates are removed');
    assert.equal(typeof issued.body.expires_in, 'number');
    assert.equal(issued.body.token.includes(TOKEN), false, 'the owner token is never handed out');
  });
});

test('the server, not the host, refuses a call outside the token capabilities', async () => {
  await withServer({}, async ({base}) => {
    const {body} = await mint(base, ['graph.read', 'settings.read']);
    const token = body.token;
    // The token authenticates on its own: no cookie, no owner token.
    assert.equal((await use(base, token, 'GET', 'projects')).status, 200);
    const write = await use(base, token, 'POST', 'projects', {name: 'injected'});
    assert.equal(write.status, 403);
    const denied = await write.json();
    assert.equal(denied.error.code, 'permission_denied');
    assert.match(denied.error.message, /graph\.write/);
    assert.equal((await use(base, token, 'GET', 'settings')).status, 200);
    assert.equal((await use(base, token, 'PUT', 'settings', {developer_mode: true})).status, 403);
    // Library and collections are separate families.
    assert.equal((await use(base, token, 'GET', 'library/sections')).status, 403);
    // Nothing was written.
    const projects = await (await fetch(base + '/api/projects', {headers: OWNER})).json();
    assert.deepEqual(projects, []);
  });
});

test('a wider token reaches exactly its families, including a named secret and a network host', async () => {
  await withServer({}, async ({base}) => {
    const {body} = await mint(base, [
      'graph.read',
      'graph.write',
      'library.read',
      'library.write',
      'collections.read',
      'collections.write',
      'run.read',
      'run.start',
      'settings.read',
      'settings.write',
      'secrets.use:openai',
      'net.fetch:127.0.0.1:1',
    ]);
    const token = body.token;
    assert.equal((await use(base, token, 'POST', 'projects', {name: 'made by a plugin'})).status, 200);
    assert.equal((await use(base, token, 'PUT', 'collections/notes', {title: 'Notes'})).status, 200);
    assert.equal((await use(base, token, 'POST', 'collections/notes/records', {data: {text: 'x'}})).status, 200);
    assert.equal((await use(base, token, 'GET', 'secrets/openai')).status, 200);
    assert.equal((await use(base, token, 'GET', 'secrets/other')).status, 403, 'a secret is named, not a wildcard');
    assert.equal((await use(base, token, 'GET', 'secrets/openai')).status, 200);
    // net: the host is named; the body can also carry a secret reference. Nothing external is contacted:
    // port 1 refuses at once, and a 403 would mean the capability was refused before the call.
    const allowedNet = await use(base, token, 'POST', 'net', {url: 'http://127.0.0.1:1/'});
    assert.notEqual(allowedNet.status, 403);
    const elsewhere = await use(base, token, 'POST', 'net', {url: 'http://127.0.0.1:2/'});
    assert.equal(elsewhere.status, 403);
    const withSecret = await use(base, token, 'POST', 'net', {
      url: 'http://127.0.0.1:1/',
      headers: {Authorization: '{{secret:openai}}'},
    });
    assert.notEqual(withSecret.status, 403, 'secrets.use:openai covers the reference; the secret itself is missing');
  });
});

test('a plugin token cannot use authentication, events, diagnostics or the contract', async () => {
  await withServer({}, async ({base}) => {
    const {body} = await mint(base, ['graph.read', 'graph.write']);
    const token = body.token;
    const second = await mint(base, ['graph.read'], {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-AgentSys': '1',
    });
    assert.equal(second.status, 403, 'a plugin token cannot mint another token');
    for (const [method, route] of [
      ['GET', 'events'],
      ['GET', 'diagnostics'],
      ['GET', 'openapi.json'],
    ]) {
      const response = await use(base, token, method, route);
      assert.equal(response.status, 403, `${method} ${route}`);
    }
    // The owner's own credentials still read them.
    assert.equal((await fetch(base + '/api/diagnostics', {headers: OWNER})).status, 200);
  });
});

test('a revoked token stops working at once, even when a valid session cookie is present', async () => {
  await withServer({}, async ({base}) => {
    const session = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const {body} = await mint(base, ['graph.read']);
    const token = body.token;
    assert.equal((await use(base, token, 'GET', 'projects')).status, 200);
    const revoked = await fetch(base + '/api/auth/plugin-session', {
      method: 'DELETE',
      headers: {Authorization: 'Bearer ' + token},
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, true);
    // The cookie would authenticate the request, but an invalid plugin token is refused explicitly.
    const after = await fetch(base + '/api/projects', {headers: {Authorization: 'Bearer ' + token, Cookie: cookie}});
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error.code, 'plugin_token_invalid');
    // The cookie alone still works: only the token was revoked.
    assert.equal((await fetch(base + '/api/projects', {headers: {Cookie: cookie}})).status, 200);
  });
});

test('a token expires, and the number of live tokens is bounded without silently revoking one', async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await withServer({pluginSessionTtlMs: 1000, pluginSessionLimit: 2}, async ({base, app}) => {
    const first = (await mint(base, ['graph.read'])).body.token;
    assert.equal((await use(base, first, 'GET', 'projects')).status, 200);
    await sleep(1100);
    const expired = await use(base, first, 'GET', 'projects');
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, 'plugin_token_expired');

    const a = (await mint(base, ['graph.read'])).body.token;
    const b = (await mint(base, ['graph.read'])).body.token;
    const c = await mint(base, ['graph.read']);
    assert.equal(c.status, 429, 'at the limit a new token is refused');
    assert.equal(c.body.error.code, 'too_many_tokens');
    assert.equal((await use(base, a, 'GET', 'projects')).status, 200, 'the oldest live token was not revoked');
    assert.equal((await use(base, b, 'GET', 'projects')).status, 200);
    const diagnostics = await (await fetch(base + '/api/diagnostics', {headers: OWNER})).json();
    assert.equal(diagnostics.plugin_sessions, 2);
    assert.equal(JSON.stringify(diagnostics).includes(a), false, 'diagnostics names no token');
    assert.ok(app);
  });
});

test('the host matcher and the server matcher agree on wildcard capabilities', async () => {
  const Capabilities = require('../js/app/plugin-capabilities');
  const {capabilityAllows} = require('../shared/core');
  const cases = [
    [['graph.read'], 'graph.read'],
    [['graph.read'], 'graph.write'],
    [['net.fetch:*.example.com'], 'net.fetch:api.example.com'],
    [['net.fetch:*.example.com'], 'net.fetch:example.com.evil.test'],
    [['secrets.use:openai'], 'secrets.use:openai'],
    [['secrets.use:openai'], 'secrets.use:other'],
    [['graph.*'], 'graph.read'],
    [[], 'graph.read'],
  ];
  for (const [caps, need] of cases)
    assert.equal(Capabilities.allows(caps, need), capabilityAllows(caps, need), `${caps} / ${need}`);
});
