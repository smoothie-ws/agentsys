'use strict';
// Two clients against one server, and two servers side by side: conditional writes, events for both readers,
// one client stopping work the other is watching, a stream across a restart, and no data mixing between servers.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'concurrency-token';
const bearer = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-concurrency-'))) {
  const app = createApiServer({dataDir: directory, token: TOKEN});
  const base = await app.listen(0);
  return {app, base, dir: directory};
}

const call = async (base, method, route, {body, headers = {}} = {}) => {
  const response = await fetch(base + '/api/' + route, {
    method,
    headers: {...bearer, ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
};

async function until(check, what) {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('not reached: ' + what);
}

/** Reads a Server-Sent Events stream and collects its data lines until `match` is satisfied. */
async function stream(base, controller) {
  const response = await fetch(base + '/api/events', {headers: bearer, signal: controller.signal});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = {text: ''};
  state.read = async match => {
    for (let i = 0; i < 200 && !match(state.text); i++) {
      const {value, done} = await reader.read();
      if (done) break;
      state.text += decoder.decode(value, {stream: true});
    }
    return state.text;
  };
  state.close = async () => {
    controller.abort();
    await reader.cancel().catch(() => {});
  };
  return state;
}

test('a conditional write is refused when the workflow changed since it was read', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Guarded'}})).body;
    const workflow = await call(base, 'GET', `projects/${project.id}/workflow`);
    const cursor = workflow.body.cursor;
    assert.equal(typeof cursor, 'number');
    const guarded = (name, x) =>
      call(base, 'POST', `projects/${project.id}/typed-nodes`, {
        body: {node_type: 'custom', config: {title: name, inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}], op: 'on_run'}, position: {x, y: 0}},
        headers: {'If-Match': String(cursor)},
      });
    const [first, second] = await Promise.all([guarded('first', 0), guarded('second', 100)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([first, second]));
    const conflict = first.status === 409 ? first : second;
    assert.equal(conflict.body.error.code, 'conflict');
    assert.match(conflict.body.error.message, /changed since it was read/);
    const after = await call(base, 'GET', `projects/${project.id}/workflow`);
    assert.equal(after.body.nodes.length, 1, 'exactly one write was applied');
    assert.equal(after.body.cursor, cursor + 1);

    // Without If-Match the same two writes both apply: the server serialises them, so neither is lost.
    const make = (name, x) =>
      call(base, 'POST', `projects/${project.id}/typed-nodes`, {
        body: {node_type: 'custom', config: {title: name, inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}], op: 'on_run'}, position: {x, y: 0}},
      });
    const [third, fourth] = await Promise.all([make('third', 200), make('fourth', 300)]);
    assert.equal(third.status, 200);
    assert.equal(fourth.status, 200);
    const final = await call(base, 'GET', `projects/${project.id}/workflow`);
    assert.equal(final.body.nodes.length, 3);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('two subscribed clients receive the same change, and neither receives it for the other server', async () => {
  const one = await start(),
    two = await start();
  const first = new AbortController(),
    second = new AbortController(),
    other = new AbortController();
  try {
    const [a, b, c] = await Promise.all([stream(one.base, first), stream(one.base, second), stream(two.base, other)]);
    await a.read(text => text.includes('"type":"ready"'));
    await b.read(text => text.includes('"type":"ready"'));
    await c.read(text => text.includes('"type":"ready"'));
    await call(one.base, 'POST', 'projects', {body: {name: 'Shared'}});
    await a.read(text => text.includes('"type":"change"'));
    await b.read(text => text.includes('"type":"change"'));
    assert.match(a.text, /"keys":\["projects"\]/);
    assert.match(b.text, /"keys":\["projects"\]/);
    // The second server has its own data and did not hear about the first server's write.
    await sleep(300);
    assert.equal(c.text.includes('"type":"change"'), false, 'no cross-server event');
    assert.deepEqual((await call(two.base, 'GET', 'projects')).body, []);
    assert.deepEqual((await call(one.base, 'GET', 'projects')).body.map(item => item.name), ['Shared']);
  } finally {
    await Promise.all([first.abort(), second.abort(), other.abort()]);
    await one.app.close();
    await two.app.close();
    fs.rmSync(one.dir, {recursive: true, force: true});
    fs.rmSync(two.dir, {recursive: true, force: true});
  }
});

test('one client stops work that a second client is watching', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Long work'}})).body;
    const query = {workflow_id: project.id};
    const startNode = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'event', point: {x: 0, y: 0}},
    })).body;
    const slow = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'script', point: {x: 100, y: 0}},
    })).body;
    await call(base, 'PUT', `projects/${project.id}/input-values`, {
      body: {...query, node_id: slow.id, values: {script: 'await node.sleep(3000); node.display("finished late");'}},
    });
    await call(base, 'POST', `projects/${project.id}/port-connections`, {
      body: {...query, add: [{source: startNode.id, source_port: 'out', target: slow.id, target_port: 'in'}]},
    });
    // Client A starts the work.
    const started = await call(base, 'POST', `projects/${project.id}/execution`, {body: {...query}});
    assert.equal(started.status, 200);
    // Client B sees the running state through the ordinary API.
    const running = await until(async () => {
      const detail = (await call(base, 'GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      return detail.nodes?.some(node => node.node_id === slow.id && node.status === 'sleeping') ? detail : null;
    }, 'the second client sees the sleeping node');
    assert.equal(running.status === 'idle', false);
    // Client A stops it.
    assert.equal((await call(base, 'DELETE', `projects/${project.id}/execution?workflow_id=${project.id}`)).status, 200);
    // Client B sees the stop, and the work did not finish in the background.
    const stopped = await until(async () => {
      const detail = (await call(base, 'GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      return detail.status === 'idle' ? detail : null;
    }, 'the stopped run is idle');
    assert.equal(JSON.stringify(stopped.displays || {}).includes('finished late'), false);
    await sleep(200);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a client reconnects after the server restarts and finds the same data, with no replayed run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-restart-'));
  let server = await start(dir);
  const controller = new AbortController();
  try {
    const project = (await call(server.base, 'POST', 'projects', {body: {name: 'Durable'}})).body;
    const projectId = project.id;
    const events = await stream(server.base, controller);
    await events.read(text => text.includes('"type":"ready"'));
    // The stream ends when the server goes away.
    await server.app.close();
    await events.read(() => false).catch(() => '');
    await events.close().catch(() => {});
    // Restart on the same folder; a client reconnects and sees the project.
    server = await start(dir);
    const projects = await call(server.base, 'GET', 'projects');
    assert.deepEqual(projects.body.map(item => item.name), ['Durable']);
    const execution = await call(server.base, 'GET', `projects/${projectId}/execution?workflow_id=${projectId}`);
    assert.equal(execution.body.status, 'idle', 'nothing restarts by itself');
    const again = new AbortController();
    const fresh = await stream(server.base, again);
    assert.match(await fresh.read(text => text.includes('"type":"ready"')), /"type":"ready"/);
    again.abort();
    await fresh.close().catch(() => {});
  } finally {
    await server.app.close().catch(() => {});
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a client that vanishes mid-run does not stop the work', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Unattended'}})).body;
    const query = {workflow_id: project.id};
    const startNode = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'event', point: {x: 0, y: 0}},
    })).body;
    const slow = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'script', point: {x: 100, y: 0}},
    })).body;
    await call(base, 'PUT', `projects/${project.id}/input-values`, {
      body: {...query, node_id: slow.id, values: {script: 'await node.sleep(400); node.display("done without its client");'}},
    });
    await call(base, 'POST', `projects/${project.id}/port-connections`, {
      body: {...query, add: [{source: startNode.id, source_port: 'out', target: slow.id, target_port: 'in'}]},
    });
    await call(base, 'POST', `projects/${project.id}/execution`, {body: {...query}});
    const finished = await until(async () => {
      const detail = (await call(base, 'GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      return detail.status === 'idle' ? detail : null;
    }, 'the run finishes on its own');
    assert.match(Object.values(finished.displays || {}).join(' '), /done without its client/);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a collection record has its own version, and If-Match makes its writes conditional', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'collections/notes', {
      body: {title: 'Notes', schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}},
    });
    const made = await call(base, 'POST', 'collections/notes/records', {body: {data: {text: 'one'}}});
    assert.equal(made.status, 200);
    assert.equal(made.body.version, 1);
    const id = made.body.id;
    const route = 'collections/notes/records/' + id;

    const first = await call(base, 'PUT', route, {body: {data: {text: 'two'}}, headers: {'If-Match': '1'}});
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);

    const stale = await call(base, 'PUT', route, {body: {data: {text: 'lost'}}, headers: {'If-Match': '1'}});
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
    assert.match(stale.body.error.message, /version is 2, not 1/);
    assert.equal((await call(base, 'GET', route)).body.data.text, 'two', 'the stale write changed nothing');

    // Without If-Match the write is last-one-wins, and the version still advances.
    const plain = await call(base, 'PUT', route, {body: {data: {text: 'three'}}});
    assert.equal(plain.status, 200);
    assert.equal(plain.body.version, 3);

    // Two writers that read version 3: one wins, one is told to read again.
    const [left, right] = await Promise.all([
      call(base, 'PUT', route, {body: {data: {text: 'left'}}, headers: {'If-Match': '3'}}),
      call(base, 'PUT', route, {body: {data: {text: 'right'}}, headers: {'If-Match': '3'}}),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);

    const bad = await call(base, 'PUT', route, {body: {data: {text: 'x'}}, headers: {'If-Match': 'soon'}});
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_request');

    const versionNow = (await call(base, 'GET', route)).body.version;
    const staleDelete = await call(base, 'DELETE', route, {headers: {'If-Match': '1'}});
    assert.equal(staleDelete.status, 409);
    assert.equal((await call(base, 'GET', route)).status, 200, 'the refused delete kept the record');
    const deleted = await call(base, 'DELETE', route, {headers: {'If-Match': String(versionNow)}});
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.version, versionNow);
    assert.equal((await call(base, 'GET', route)).status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
