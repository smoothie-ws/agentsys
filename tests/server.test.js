'use strict';
// The HTTP API, browser storage and site share one data folder.
// Starts a real server on a free port with a temporary data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createServer} = require('../server');
const {nodes, TYPES} = require('./harness');

async function withServer(options, work) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-'));
  const app = createServer({dataDir, ...options});
  const url = await app.listen(0);
  try {
    // The tests build Custom nodes by hand, which needs developer mode.
    await fetch(`${url}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentSys': '1',
        ...(options?.token ? {Authorization: 'Bearer ' + options.token} : {}),
      },
      body: JSON.stringify({developer_mode: true}),
    });
    await work({url, app, dataDir});
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
}
const call = async (url, method, route, body, headers = {}) => {
  const response = await fetch(`${url}/api/${route}`, {
    method,
    headers: {'Content-Type': 'application/json', 'X-AgentSys': '1', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
};
/** Gives a workflow the types that the nodes of the harness use. */
const typed = async (url, id, headers = {}) => {
  const {body} = await call(url, 'GET', `projects/${id}/types`, undefined, headers);
  const types = [...body.types, ...Object.values(TYPES).filter(t => !body.types.some(old => old.id === t.id))];
  return call(url, 'PUT', `projects/${id}/types`, {workflow_id: id, types}, headers);
};
/** An on_run node wired to `ids` (each: [node id, input port, output port] or just the id), one after another; answers its ID. */
async function startOf(url, id, w, ids, headers = {}) {
  const make = await call(
    url,
    'POST',
    `projects/${id}/typed-nodes`,
    {...w, node_type: 'custom', config: nodes.run(), position: {x: 0, y: 0}},
    headers
  );
  let from = [make.body.id, 'out'];
  for (const step of ids) {
    const [to, input = 'in', output = 'out'] = Array.isArray(step) ? step : [step];
    await call(
      url,
      'POST',
      `projects/${id}/port-connections`,
      {...w, add: [{source: from[0], source_port: from[1], target: to, target_port: input}]},
      headers
    );
    from = [to, output];
  }
  return make.body.id;
}
/** A request with a chosen Host header (fetch does not allow that). */
const withHost = (url, host, route = 'projects') =>
  new Promise((resolve, reject) => {
    const {port} = new URL(url);
    http
      .get({host: '127.0.0.1', port, path: `/api/${route}`, headers: {Host: host}}, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

test('the API creates, runs and persists: projects become files in the data folder', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const created = await call(url, 'POST', 'projects', {name: 'Over HTTP'});
    assert.equal(created.status, 200);
    const id = created.body.id,
      w = {workflow_id: id};
    await call(url, 'PUT', `projects/${id}/policy`, {allow: nodes.script('').grants});
    await typed(url, id);
    const node = (node_type, config) =>
      call(url, 'POST', `projects/${id}/typed-nodes`, {...w, node_type, config, position: {x: 0, y: 0}}).then(
        r => r.body
      );
    const script = await node('custom', nodes.script('node.display("hi?" + context.workflow_id.length)'));
    await startOf(url, id, w, [script.id]);
    // Scripts run in worker threads here.
    const run = await call(url, 'POST', `projects/${id}/execution`, {...w, wait: true});
    assert.equal(run.status, 200);
    assert.equal(run.body.status, 'idle');
    assert.equal(run.body.displays[script.id], 'hi?32');
    // The data is plain JSON files, including the run history.
    assert.ok(fs.existsSync(path.join(dataDir, 'projects.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'workflows', `${id}.json`)));
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs')));
    assert.equal((await call(url, 'GET', 'openapi.json')).body.info.title, 'AgentSys browser API');
  });
});

test('a request writes only what it changed: a default that was only read is not stored', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const made = await call(url, 'POST', 'projects', {name: 'Plain'});
    await call(url, 'DELETE', `projects/${made.body.id}`); // reads the triggers to drop those of the project
    await call(url, 'POST', 'library/node-folders', {action: 'create', path: '', name: 'Logic'}); // reads the disabled groups and the icons
    await call(url, 'POST', 'library/node-editor', {});
    const files = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true}))
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : files.push(path.relative(dataDir, path.join(dir, e.name)).split(path.sep).join('/'));
    };
    walk(dataDir);
    for (const junk of ['other/triggers.json', 'other/node_disabled_folders.json'])
      assert.ok(!files.includes(junk), `${junk} holds only a default and is not written`);
    for (const file of files.filter(f => f.endsWith('.json')))
      assert.notEqual(
        fs.readFileSync(path.join(dataDir, file), 'utf8').trim(),
        'null',
        `${file} is not an empty "null" file`
      );
  });
});

test('errors are JSON with a status; If-Match makes an edit conditional', async () => {
  await withServer({}, async ({url}) => {
    const missing = await call(url, 'GET', 'projects/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    assert.equal((await call(url, 'POST', 'projects', {name: ''})).body.id ? 200 : 400, 200); // an empty name becomes UntitledN
    assert.equal((await call(url, 'GET', 'nothing/here')).status, 404);
    const bad = await fetch(`${url}/api/projects`, {method: 'POST', headers: {'X-AgentSys': '1'}, body: '{oops'});
    assert.equal(bad.status, 400);

    const {body: project} = await call(url, 'POST', 'projects', {name: 'Cond'});
    const id = project.id,
      w = {workflow_id: id};
    await typed(url, id);
    const read = (await call(url, 'GET', `projects/${id}/workflow?workflow_id=${id}`)).body;
    const add = match =>
      call(
        url,
        'POST',
        `projects/${id}/typed-nodes`,
        {...w, node_type: 'custom', config: nodes.value('text', 'x'), position: {x: 0, y: 0}},
        {'If-Match': `"${match}"`}
      );
    assert.equal((await add(read.cursor)).status, 200);
    const stale = await add(read.cursor);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
  });
});

test('who may use the API: header for changes, Host check, token', async () => {
  await withServer({}, async ({url}) => {
    const blind = await fetch(`${url}/api/projects`, {
      method: 'POST',
      body: '{}',
      headers: {'Content-Type': 'text/plain'},
    });
    assert.equal(blind.status, 403, 'a change without X-AgentSys is refused');
    assert.equal((await fetch(`${url}/api/projects`)).status, 200, 'reading needs nothing');
    assert.equal(await withHost(url, 'evil.example'), 403, 'DNS rebinding: the Host must be loopback');
    assert.equal(await withHost(url, 'localhost:1234'), 200);
    assert.equal(await withHost(url, 'evil.example', '../__data'), 403, 'the browser storage checks the Host too');
    assert.equal(await withHost(url, 'localhost:1234', '../__data'), 200);
  });
  await withServer({allowedHosts: ['agentsys.test']}, async ({url}) => {
    assert.equal(await withHost(url, 'agentsys.test'), 200);
  });
  await withServer({token: 's3cret'}, async ({url}) => {
    for (const prefix of ['', '/editor']) {
      for (const suffix of ['', '/prefs', '/events'])
        assert.equal((await fetch(`${url}${prefix}/__data${suffix}`)).status, 401);
      assert.equal(
        (
          await fetch(`${url}${prefix}/__data`, {
            method: 'POST',
            headers: {'X-AgentSys': '1'},
            body: '{"set":{"prefs":{}}}',
          })
        ).status,
        401
      );
      assert.equal(
        (
          await fetch(`${url}${prefix}/__data/prefs`, {
            headers: {Authorization: 'Bearer s3cret'},
          })
        ).status,
        200
      );
    }
    assert.equal((await call(url, 'GET', 'projects')).status, 401);
    assert.equal((await call(url, 'GET', 'projects', undefined, {Authorization: 'Bearer nope'})).status, 401);
    // With the token, X-AgentSys is not needed (a cross-site page cannot send Authorization either).
    const response = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: {Authorization: 'Bearer s3cret', 'Content-Type': 'application/json'},
      body: '{"name":"T"}',
    });
    assert.equal(response.status, 200);
  });
  // Beyond loopback the API stays off until there is a token.
  await withServer({host: '0.0.0.0'}, async ({url, app}) => {
    assert.equal((await fetch(url.replace('localhost', '127.0.0.1') + '/__data')).status, 503);
    assert.equal(app.apiAvailable, false);
    assert.equal((await call(url.replace('localhost', '127.0.0.1'), 'GET', 'projects')).status, 503);
  });
  await withServer({host: '0.0.0.0', token: 'abc'}, async ({url, app}) => {
    assert.equal((await fetch(url.replace('localhost', '127.0.0.1') + '/__data')).status, 401);
    assert.equal(app.apiAvailable, true);
    assert.equal(
      (await call(url.replace('localhost', '127.0.0.1'), 'GET', 'projects', undefined, {Authorization: 'Bearer abc'}))
        .status,
      200
    );
  });
});

test("the browser storage and the API see each other's writes", async () => {
  await withServer({}, async ({url, dataDir}) => {
    const first = await call(url, 'POST', 'projects', {name: 'From the API'});
    assert.equal((await call(url, 'GET', 'projects')).body.length, 1);
    // A page (or a person) changes projects.json; the API must not answer from its cache.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'));
    stored[0].name = 'Renamed by a page';
    const write = await fetch(`${url}/__data`, {
      method: 'POST',
      headers: {'X-AgentSys': '1', 'Content-Type': 'application/json'},
      body: JSON.stringify({set: {projects: stored}}),
    });
    assert.equal(write.status, 200);
    assert.equal((await call(url, 'GET', `projects/${first.body.id}`)).body.project.name, 'Renamed by a page');
    // A file edited on disk is picked up within a few seconds.
    stored[0].name = 'Edited on disk';
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(stored));
    let name = '';
    for (let i = 0; i < 80 && name !== 'Edited on disk'; i++) {
      await new Promise(r => setTimeout(r, 100));
      name = (await call(url, 'GET', `projects/${first.body.id}`)).body.project.name;
    }
    assert.equal(name, 'Edited on disk');
    // Writes without the header are still refused.
    assert.equal((await fetch(`${url}/__data`, {method: 'POST', body: '{}'})).status, 403);
  });
});

test('API and raw-storage commits fingerprint only their own keys, without scanning the data tree', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const original = fs.readdirSync;
    let fullScans = 0;
    fs.readdirSync = (directory, ...args) => {
      if (path.resolve(String(directory)) === path.resolve(dataDir)) fullScans++;
      return original(directory, ...args);
    };
    try {
      const created = await call(url, 'POST', 'projects', {name: 'Fast commit'});
      assert.equal(created.status, 200);
      const response = await fetch(`${url}/__data`, {
        method: 'POST',
        headers: {'X-AgentSys': '1', 'Content-Type': 'application/json'},
        body: JSON.stringify({set: {'latency-probe': {value: 1}}}),
      });
      assert.equal(response.status, 200);
      assert.equal(fullScans, 0);
    } finally {
      fs.readdirSync = original;
    }
  });
});

test('workflow JSON state and previews survive a real server restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-durable-'));
  let app = createServer({dataDir}),
    url = await app.listen(0);
  try {
    await call(url, 'PUT', 'settings', {developer_mode: true});
    const {body: project} = await call(url, 'POST', 'projects', {name: 'Durable graph'});
    await typed(url, project.id);
    const {body: node} = await call(url, 'POST', `projects/${project.id}/typed-nodes`, {
      node_type: 'custom',
      config: nodes.script('context.state.count=(context.state.count??0)+1;node.display(context.state.count);'),
    });
    const route = `projects/${project.id}/execution`;
    assert.equal((await call(url, 'POST', route, {node_ids: [node.id], wait: true})).body.state.count, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'workflows', project.id, 'runtime.json'), 'utf8'));
    assert.equal(stored.state.count, 1);
    assert.equal(stored.displays[node.id], '1');
    await app.close();
    app = createServer({dataDir});
    url = await app.listen(0);
    const restored = (await call(url, 'GET', route)).body;
    assert.equal(restored.state.count, 1);
    assert.equal(restored.displays[node.id], '1');
    assert.equal((await call(url, 'POST', route, {node_ids: [node.id], wait: true})).body.state.count, 2);
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});

test('asynchronous file polling still detects external Script and layout edits', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const {body: project} = await call(url, 'POST', 'projects', {name: 'External files'}),
      {body: node} = await call(url, 'POST', `projects/${project.id}/primitives`, {
        primitive: 'script',
        point: {x: 0, y: 0},
      });
    const config = (await call(url, 'GET', `projects/${project.id}/workflow`)).body.nodes.find(
      n => n.id === node.id
    ).config;
    config.inputs.find(p => p.id === 'script').default = 'node.display("initial");';
    await call(url, 'PUT', `projects/${project.id}/typed-nodes/${node.id}`, {node_type: 'custom', config});
    await call(url, 'POST', `projects/${project.id}/execution`, {node_ids: [node.id], wait: true});
    await call(url, 'POST', `projects/${project.id}/execution/pause`, {});
    await call(url, 'POST', `projects/${project.id}/execution`, {node_ids: [node.id]});
    const controller = new AbortController();
    const stream = await fetch(`${url}/__data/events`, {signal: controller.signal});
    try {
      const graph = JSON.parse(fs.readFileSync(path.join(dataDir, 'workflows', project.id + '.json'), 'utf8')),
        code = graph.value.nodes.find(n => n.id === node.id).config.inputs.find(p => p.id === 'script').default.$script,
        sidecar = path.join(dataDir, 'workflows', project.id + '.files');
      fs.writeFileSync(path.join(sidecar, code), 'node.display("external edit");');
      const until = async check => {
        for (let i = 0; i < 40; i++) {
          if (await check()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.fail('External file edit was not observed');
      };
      await until(
        async () =>
          (await call(url, 'GET', `projects/${project.id}/workflow`)).body.nodes
            .find(n => n.id === node.id)
            .config.inputs.find(p => p.id === 'script').default === 'node.display("external edit");'
      );
      await call(url, 'POST', `projects/${project.id}/execution/resume`, {});
      await until(
        async () =>
          (await call(url, 'GET', `projects/${project.id}/execution`)).body.displays[node.id] === 'external edit'
      );
      const file = path.join(sidecar, 'layout.json'),
        layout = JSON.parse(fs.readFileSync(file, 'utf8'));
      layout['["value","layout"]'][node.id].x = 123;
      fs.writeFileSync(file, JSON.stringify(layout));
      await until(
        async () =>
          (await call(url, 'GET', `projects/${project.id}/workflow`)).body.nodes.find(n => n.id === node.id).position
            .x === 123
      );
    } finally {
      controller.abort();
      await stream.body.cancel().catch(() => {});
    }
  });
});

test('the site itself is still served, without the data folder or dotfiles', async t => {
  const readFile = fs.readFile;
  const privateFile = path.resolve(__dirname, '../data/__audit-private.json');
  let privateRead = false;
  t.mock.method(fs, 'readFile', (file, ...args) => {
    if (
      String(file)
        .replace(/[. ]+(?=[\\/]|$)/g, '')
        .toLowerCase() === privateFile.toLowerCase()
    ) {
      privateRead = true;
      return args.at(-1)(null, Buffer.from('{"private":true}'));
    }
    return readFile(file, ...args);
  });
  await withServer({}, async ({url}) => {
    const index = await fetch(url + '/editor/');
    assert.equal(index.status, 200);
    assert.match(await index.text(), /AgentSys/);
    assert.equal((await fetch(url + '/.gitignore')).status, 404);
    assert.equal((await fetch(url + '/__data')).status, 200);
    for (const prefix of ['', '/editor']) {
      for (const folder of ['data', 'DATA', 'data.', 'data%20'])
        assert.equal((await fetch(url + prefix + `/${folder}/__audit-private.json`)).status, 404);
      for (const file of ['server.js', 'headless.js', 'package.json', 'tests/harness.js'])
        assert.equal((await fetch(url + prefix + '/' + file)).status, 404);
    }
    assert.equal(privateRead, false, 'default data is private even with a different DATA_DIR');
  });
});

test('the app is at /editor/ (/ goes there) and everything it loads is under /editor/', async () => {
  await withServer({}, async ({url, app}) => {
    const front = await fetch(url + '/', {redirect: 'manual'});
    assert.equal(front.status, 301);
    assert.equal(front.headers.get('location'), '/editor/');
    const redirect = await fetch(url + '/editor', {redirect: 'manual'});
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/editor/');
    const editor = await fetch(url + '/editor/');
    assert.equal(editor.status, 200);
    assert.match(await editor.text(), /id="brand"/);
    assert.equal((await fetch(url + '/editor/js/app/router.js')).status, 200);
    assert.equal((await fetch(url + '/editor/__data')).status, 200);
    assert.equal((await fetch(url + '/editor/api/projects')).status, 200);
    assert.equal((await fetch(url + '/editor/.gitignore')).status, 404);
    // The pages of the editor are paths: a deep link opens the editor, whose files are named from /editor/.
    const deep = await fetch(url + '/editor/p/abc/w/def');
    assert.equal(deep.status, 200);
    const page = await deep.text();
    assert.match(page, /id="brand"/);
    assert.match(page, /src="\/editor\/js\/app\/router\.js"/);
    assert.equal((await fetch(url + '/editor/js/nothing.js')).status, 404);
    for (const page of [
      'api',
      'api/',
      'settings/',
      'projects/',
      'library',
      'p/lib-builtin.delay/w/lib-builtin.delay/',
    ]) {
      const response = await fetch(url + '/editor/' + page);
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get('content-type'), /text\/html/, page);
      assert.match(await response.text(), /id="brand"/, page);
    }
  });
});

test('bad requests get a 400, not a server error', async () => {
  await withServer({}, async ({url}) => {
    assert.equal((await fetch(url + '/%E0%A4%A')).status, 400, 'a broken %-escape in the address');
    const post = body => fetch(url + '/__data', {method: 'POST', headers: {'X-AgentSys': '1'}, body});
    assert.equal((await post('{nope')).status, 400, 'the body is not JSON');
    assert.equal((await post('null')).status, 400);
    assert.equal(
      (await post(JSON.stringify({set: [1], remove: 'x'}))).status,
      400,
      'set and remove have the wrong shape'
    );
    assert.equal((await post(JSON.stringify({set: {other: {a: 1}}}))).status, 200);
  });
});

test('UI state bootstraps from data safely and respects storage authentication', async () => {
  await withServer({token: 'ui-test-token'}, async ({url, dataDir}) => {
    fs.mkdirSync(path.join(dataDir, 'other'), {recursive: true});
    const state = {'agentsys-clipboard': '</script><script>bad()</script>$&', 'agentsys-snap': true};
    fs.writeFileSync(path.join(dataDir, 'other', 'ui-state.json'), JSON.stringify(state));
    const anonymous = await (await fetch(url + '/editor/')).text();
    assert.match(anonymous, /AGENTSYS_UI_STORE=\{\};/);
    const html = await (await fetch(url + '/editor/', {headers: {Authorization: 'Bearer ui-test-token'}})).text();
    const bootstrap = html.match(/<script>globalThis.AGENTSYS_UI_STORE=([\s\S]*?);<\/script>/)[1];
    assert.equal(bootstrap.includes('</script>'), false);
    assert.deepEqual(JSON.parse(bootstrap), state);
    assert.equal((await fetch(url + '/data/other/ui-state.json')).status, 404);
  });
});

test('corrupt UI state returns an HTTP error without terminating static hosting', async () => {
  await withServer({}, async ({url, dataDir}) => {
    fs.mkdirSync(path.join(dataDir, 'other'), {recursive: true});
    fs.writeFileSync(path.join(dataDir, 'other', 'ui-state.json'), '{broken');
    assert.equal((await fetch(url + '/editor/')).status, 500);
    assert.equal((await fetch(url + '/editor/js/app/helpers.js')).status, 200);
    assert.equal((await fetch(url + '/editor/js/missing.js')).status, 404);
  });
});

test('an interrupted commit is replayed once, and an unreadable record does not stop the server', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-transaction-'));
  const project = {
    id: 'recoveredproject',
    name: 'Recovered',
    description: '',
    created: 1,
    workflows: [{id: 'recoveredproject', name: 'Flow', created: 1}],
  };
  // The data was written before the crash; the record was not removed yet. Replaying it must
  // leave one project, not two.
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(
    path.join(dataDir, '.transaction.json'),
    JSON.stringify({set: {projects: [project]}, remove: []})
  );
  let app = createServer({dataDir}),
    url = await app.listen(0);
  try {
    const listed = await call(url, 'GET', 'projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map(item => item.name), ['Recovered']);
    assert.equal(fs.existsSync(path.join(dataDir, '.transaction.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).length, 1);
  } finally {
    await app.close();
  }
  // An unreadable record is set aside; the stored data still serves.
  fs.writeFileSync(path.join(dataDir, '.transaction.json'), '{not json');
  app = createServer({dataDir});
  url = await app.listen(0);
  try {
    assert.deepEqual((await call(url, 'GET', 'projects')).body.map(item => item.name), ['Recovered']);
    assert.equal(fs.existsSync(path.join(dataDir, '.transaction.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, '.transaction.json.invalid')), true);
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});

test('storage keys matching Object properties round-trip as ordinary user data', async () => {
  await withServer({}, async ({url}) => {
    const values = Object.fromEntries(['constructor', 'toString', '__proto__'].map(key => [key, {value: key}]));
    const saved = await fetch(url + '/__data', {
      method: 'POST',
      headers: {'X-AgentSys': '1'},
      body: JSON.stringify({set: values}),
    });
    assert.equal(saved.status, 200);
    for (const [key, value] of Object.entries(values))
      assert.deepEqual(await (await fetch(url + '/__data/' + key)).json(), value);
  });
});
