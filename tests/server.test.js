'use strict';
// The HTTP side: the API next to the site (/api), webhooks (/hooks), the browser's storage (/__data) and how the
// three share one data folder. Starts a real server on a free port with a temporary data folder.
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
  const app = createServer({dataDir, scheduler: false, ...options});
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
const typed = (url, id, headers = {}) =>
  call(url, 'PUT', `projects/${id}/types`, {workflow_id: id, types: Object.values(TYPES)}, headers);
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
    await call(url, 'PUT', `projects/${id}/policy`, {allow: nodes.script('').capabilities});
    await typed(url, id);
    const node = (node_type, config) =>
      call(url, 'POST', `projects/${id}/typed-nodes`, {...w, node_type, config, position: {x: 0, y: 0}}).then(
        r => r.body
      );
    const script = await node('custom', nodes.script('node.display("hi?" + context.run_id.length)'));
    await startOf(url, id, w, [script.id]);
    // Scripts run in worker threads here.
    const run = await call(url, 'POST', `projects/${id}/runs`, {...w, wait: 15});
    assert.equal(run.status, 200);
    assert.equal(run.body.status, 'completed');
    assert.equal(run.body.displays[script.id], 'hi?32');
    // The data is plain JSON files, including the run history.
    assert.ok(fs.existsSync(path.join(dataDir, 'projects.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'workflows', `${id}.json`)));
    assert.ok(fs.existsSync(path.join(dataDir, 'runs', run.body.id + '.json')));
    const history = await call(url, 'GET', `projects/${id}/runs?workflow_id=${id}`);
    assert.equal(history.body.length, 1);
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
    for (const junk of ['other/triggers.json', 'other/node_disabled_folders.json', 'other/node_folder_icons.json'])
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
    assert.equal(app.apiAvailable, false);
    assert.equal((await call(url.replace('localhost', '127.0.0.1'), 'GET', 'projects')).status, 503);
  });
  await withServer({host: '0.0.0.0', token: 'abc'}, async ({url, app}) => {
    assert.equal(app.apiAvailable, true);
    assert.equal(
      (await call(url.replace('localhost', '127.0.0.1'), 'GET', 'projects', undefined, {Authorization: 'Bearer abc'}))
        .status,
      200
    );
  });
});

test('a run can be followed as Server-Sent Events', async () => {
  await withServer({}, async ({url}) => {
    const {body: project} = await call(url, 'POST', 'projects', {name: 'SSE'}),
      id = project.id,
      w = {workflow_id: id};
    await typed(url, id);
    const script = (
      await call(url, 'POST', `projects/${id}/typed-nodes`, {
        ...w,
        node_type: 'custom',
        config: nodes.script('await new Promise(r => setTimeout(r, 200)); node.display(1)'),
        position: {x: 0, y: 0},
      })
    ).body;
    await startOf(url, id, w, [script.id]);
    const run = (await call(url, 'POST', `projects/${id}/runs`, w)).body;
    const response = await fetch(`${url}/api/runs/${run.id}/stream`, {headers: {'X-AgentSys': '1'}});
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text(); // ends when the run does
    const types = [...text.matchAll(/^event: (.+)$/gm)].map(m => m[1]);
    assert.equal(types[0], 'run_started');
    assert.equal(types.at(-1), 'run_finished');
    assert.ok(types.includes('node_completed'));
    assert.equal((await fetch(`${url}/api/runs/unknown/stream`)).status, 404);
    assert.ok(script.id);
  });
});

test('webhooks start runs with the body as payload, with no other credential', async () => {
  await withServer({token: 'tok'}, async ({url}) => {
    const auth = {Authorization: 'Bearer tok'};
    const {body: project} = await call(url, 'POST', 'projects', {name: 'Hooks'}, auth),
      id = project.id,
      w = {workflow_id: id};
    await typed(url, id, auth);
    const hook = (
      await call(
        url,
        'POST',
        `projects/${id}/typed-nodes`,
        {
          ...w,
          node_type: 'custom',
          config: nodes.script('node.display(context.payload.event)'),
          position: {x: 0, y: 0},
        },
        auth
      )
    ).body;
    await startOf(url, id, w, [hook.id], auth);
    const trigger = (await call(url, 'POST', 'triggers', {name: 'Push', type: 'webhook', project_id: id}, auth)).body;
    const response = await fetch(`${url}/hooks/${trigger.token}`, {
      method: 'POST',
      body: JSON.stringify({event: 'push'}),
    });
    assert.equal(response.status, 202);
    const started = await response.json();
    const finished = (await call(url, 'GET', `runs/${started.id}?`, undefined, auth)).body;
    assert.ok(['running', 'completed'].includes(finished.status));
    assert.equal((await fetch(`${url}/hooks/wrong`, {method: 'POST', body: '{}'})).status, 404);
    assert.equal((await fetch(`${url}/hooks/${trigger.token}`)).status, 405);
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

test('the interval scheduler runs inside the server', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-'));
  const app = createServer({dataDir}); // scheduler on
  const url = await app.listen(0);
  try {
    await call(url, 'PUT', 'settings', {developer_mode: true});
    const {body: project} = await call(url, 'POST', 'projects', {name: 'Timer'}),
      id = project.id;
    await typed(url, id);
    const one = (
      await call(url, 'POST', `projects/${id}/typed-nodes`, {
        workflow_id: id,
        node_type: 'custom',
        config: nodes.script('node.display(1)'),
        position: {x: 0, y: 0},
      })
    ).body;
    await startOf(url, id, {workflow_id: id}, [one.id]);
    const trigger = (
      await call(url, 'POST', 'triggers', {name: 'Often', type: 'interval', project_id: id, every_seconds: 10})
    ).body;
    // Make it due without waiting ten seconds: pretend it last ran long ago.
    const triggers = JSON.parse(fs.readFileSync(path.join(dataDir, 'other', 'triggers.json'), 'utf8'));
    triggers[0].last_run_at = Date.now() / 1000 - 3600;
    fs.writeFileSync(path.join(dataDir, 'other', 'triggers.json'), JSON.stringify(triggers));
    let runs = [];
    for (let i = 0; i < 100 && !runs.length; i++) {
      await new Promise(r => setTimeout(r, 100));
      runs = (await call(url, 'GET', 'runs')).body;
    }
    assert.ok(runs.length >= 1, 'the scheduler started a run');
    assert.equal(runs[0].trigger_id, trigger.id);
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});

test('the site itself is still served, without the data folder or dotfiles', async () => {
  await withServer({}, async ({url}) => {
    const index = await fetch(url + '/editor/');
    assert.equal(index.status, 200);
    assert.match(await index.text(), /AgentSys/);
    assert.equal((await fetch(url + '/.gitignore')).status, 404);
    assert.equal((await fetch(url + '/__data')).status, 200);
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
    for (const page of ['api', 'api/', 'settings/', 'runs/', 'projects/', 'p/lib-builtin.delay/w/lib-builtin.delay/']) {
      const response = await fetch(url + '/editor/' + page);
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get('content-type'), /text\/html/, page);
      assert.match(await response.text(), /id="brand"/, page);
    }
    const plugins = (await call(url, 'GET', 'plugins')).body.plugins;
    assert.ok(plugins.some(p => p.id === 'ai' && p.enabled));
    assert.ok(fs.existsSync(path.join(app.dataDir, 'plugins', 'ai', 'package.json')));
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
