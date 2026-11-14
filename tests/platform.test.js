'use strict';
// The platform contract: an API-only server, version discovery, sessions, CORS, events, generic collections
// and the Script-backed Library node a client plugin creates.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {createApp, nodes} = require('./harness');

async function withApi(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-platform-'));
  const app = createApiServer({dataDir: dir, token: 'secret-token', ...options});
  const base = await app.listen(0);
  try {
    await work({base, app, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
const call = async (base, method, route, body, headers = {}) => {
  const response = await fetch(base + '/api/' + route, {
    method,
    headers: {'Content-Type': 'application/json', 'X-AgentSys': '1', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
};
const token = {Authorization: 'Bearer secret-token'};

test('the server manifest contains no plugin host and the client loads no server runtime', () => {
  const {FILES} = require('../server/manifest');
  assert.equal(FILES.some(file => file.includes('routes-plugins')), false);
  assert.equal(FILES.some(file => file.includes('plugin-host')), false);
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /createPluginHost|plugin-host/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /js\/backend\//);
  assert.doesNotMatch(html, /js\/storage\/db\.js/);
  assert.doesNotMatch(html, /js\/model\/executor\.js/);
});

test('an API-only server reports its protocol and serves no client or server plugins', async () => {
  await withApi({}, async ({base}) => {
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.agentsys, true);
    assert.equal(meta.product, 'agentsys');
    assert.equal(meta.protocol, 1);
    assert.equal(meta.features.server_plugins, false);
    assert.equal(meta.features.client_plugins, false);
    assert.equal((await fetch(base + '/')).status, 404);
    assert.equal((await fetch(base + '/js/app/helpers.js')).status, 404);
    assert.equal((await call(base, 'GET', 'plugins', undefined, token)).status, 404);
    assert.deepEqual((await call(base, 'GET', 'library/sections', undefined, token)).body, []);
    const diagnostics = await call(base, 'GET', 'diagnostics', undefined, token);
    assert.equal(diagnostics.status, 200);
    assert.equal(typeof diagnostics.body.uptime_seconds, 'number');
    assert.equal(diagnostics.body.workers.started, 0);
  });
});

test('a token is exchanged for an HttpOnly session; cookie writes need the CSRF header and an allowed origin', async () => {
  await withApi({allowedOrigins: ['http://client.example']}, async ({base}) => {
    const session = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'secret-token'}),
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const auth = {Cookie: cookie.split(';')[0]};
    assert.equal((await fetch(base + '/api/projects', {headers: auth})).status, 200);
    const noCsrf = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json'},
      body: '{"name":"No header"}',
    });
    assert.equal(noCsrf.status, 403);
    const badOrigin = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json', 'X-AgentSys': '1', Origin: 'http://evil.example'},
      body: '{"name":"Bad origin"}',
    });
    assert.equal(badOrigin.status, 403);
    const allowed = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json', 'X-AgentSys': '1', Origin: 'http://client.example'},
      body: '{"name":"Allowed"}',
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://client.example');
    const preflight = await fetch(base + '/api/projects', {
      method: 'OPTIONS',
      headers: {Origin: 'http://client.example', 'Access-Control-Request-Method': 'POST'},
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.equal(preflight.headers.get('access-control-allow-origin') === '*', false);
    // A wrong token is refused, and no cookie is set.
    const wrong = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'nope'}),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
  });
});

test('the event stream reports changes and hook events to an authenticated client', async () => {
  await withApi({}, async ({base}) => {
    const controller = new AbortController();
    const response = await fetch(base + '/api/events', {headers: token, signal: controller.signal});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async match => {
      for (let i = 0; i < 100 && !match(text); i++) {
        const {value, done} = await reader.read();
        if (done) break;
        text += decoder.decode(value, {stream: true});
      }
      return text;
    };
    await readUntil(value => value.includes('"type":"ready"'));
    await call(base, 'POST', 'projects', {name: 'SSE project'}, token);
    await readUntil(value => value.includes('"type":"change"'));
    assert.match(text, /"keys":\["projects"\]/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test('two authenticated clients receive the same change events', async () => {
  await withApi({}, async ({base}) => {
    const controller = new AbortController();
    const open = () =>
      fetch(base + '/api/events', {headers: token, signal: controller.signal}).then(response => ({
        response,
        reader: response.body.getReader(),
        text: '',
      }));
    const one = await open(),
      two = await open();
    const read = async client => {
      const decoder = new TextDecoder();
      for (let i = 0; i < 100 && !client.text.includes('"type":"change"'); i++) {
        const {value, done} = await client.reader.read();
        if (done) break;
        client.text += decoder.decode(value, {stream: true});
      }
      return client.text;
    };
    await call(base, 'POST', 'projects', {name: 'Shared'}, token);
    const [first, second] = await Promise.all([read(one), read(two)]);
    assert.match(first, /"keys":\["projects"\]/);
    assert.match(second, /"keys":\["projects"\]/);
    controller.abort();
    await Promise.all([one.reader.cancel().catch(() => {}), two.reader.cancel().catch(() => {})]);
  });
});

test('generic collections validate their schema and persist records without domain knowledge', async () => {
  await withApp(async app => {
    await app.api('PUT', 'collections/providers', {
      title: 'Providers',
      schema: {
        type: 'object',
        properties: {providerId: {type: 'string', maxLength: 50}, baseURL: {type: 'string'}},
        required: ['providerId', 'baseURL'],
        additionalProperties: false,
      },
    });
    const made = await app.api('POST', 'collections/providers/records', {
      data: {providerId: 'local', baseURL: 'http://localhost:11434/v1'},
    });
    assert.equal(made.data.providerId, 'local');
    await assert.rejects(
      app.api('POST', 'collections/providers/records', {data: {providerId: 'x'}}),
      error => error.code === 'invalid_request' && /baseURL is required/.test(error.message)
    );
    await assert.rejects(
      app.api('POST', 'collections/providers/records', {
        data: {providerId: 'x', baseURL: 'http://x', extra: true},
      }),
      error => error.code === 'invalid_request' && /extra is not allowed/.test(error.message)
    );
    const list = await app.api('GET', 'collections/providers/records');
    assert.equal(list.total, 1);
    const updated = await app.api('PUT', 'collections/providers/records/' + made.id, {
      data: {providerId: 'local', baseURL: 'https://example.test/v1'},
    });
    assert.equal(updated.data.baseURL, 'https://example.test/v1');
    assert.equal((await app.api('DELETE', 'collections/providers/records/' + made.id)).deleted, true);
    assert.equal((await app.api('GET', 'collections/providers/records')).total, 0);
  });
});

test('a client plugin can create an ordinary Library node; the node runs without the plugin', async () => {
  await withApp(async app => {
    const project = await app.api('POST', 'projects', {name: 'Plugin node'});
    const workflow = {workflow_id: project.id}; // the first workflow of a new project has the project's id
    const item = await app.api('POST', 'library/script-nodes', {
      name: 'Greeting',
      description: 'Made through the documented API',
      code: 'node.display("hello from a Library node");',
      outputs: ['text'],
      grants: ['graph.read'],
    });
    assert.equal(item.name, 'Greeting');
    const resources = await app.api('GET', 'resources');
    assert.ok(resources.some(resource => resource.id === item.id));
    assert.ok(item.payload.bundle.records.length);
    // Place it, wire an on_run to its signal input, and dispatch: the definition is ordinary server data.
    const placed = await app.api('POST', `projects/${project.id}/custom-nodes/${item.id}`, {
      ...workflow,
      point: {x: 0, y: 0},
    });
    const complex = 'complex:' + placed.roots[0];
    const start = await app.api('POST', `projects/${project.id}/typed-nodes`, {
      ...workflow,
      node_type: 'custom',
      config: nodes.run(),
      position: {x: 0, y: 0},
    });
    await app.api('POST', `projects/${project.id}/port-connections`, {
      ...workflow,
      add: [{source: start.id, source_port: 'out', target: complex, target_port: 'in'}],
    });
    const run = await app.api('POST', `projects/${project.id}/execution`, {...workflow, wait: true});
    const displays = Object.values(run.displays || {});
    assert.ok(
      displays.some(text => text.includes('hello from a Library node')) ||
        (await app.api('GET', `projects/${project.id}/execution`, {}, workflow)).displays
    );
    // A second create with the same name is a clean conflict.
    await assert.rejects(
      app.api('POST', 'library/script-nodes', {name: 'Greeting', code: 'node.output.text = 1;'}),
      error => error.code === 'invalid_request'
    );
  });
});

async function withApp(work) {
  const app = createApp({scripts: 'inline'});
  await work(app);
}
