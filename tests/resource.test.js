'use strict';
// Long-running behaviour: repeated runs, open and closed event streams, a flood of sessions, a large graph and a
// large collection. The bounds are generous on purpose: they catch a leak or a quadratic path, not a slow machine.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {performance} = require('node:perf_hooks');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'resource-token';
const bearer = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-resource-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  const call = async (method, route, body, query) => {
    const response = await fetch(base + '/api/' + route, {
      method,
      headers: bearer,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {status: response.status, body: text ? JSON.parse(text) : undefined};
  };
  return {app, base, dir, call};
}

const stats = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
};

test('200 API round trips stay fast and lose nothing', async () => {
  const {app, call, dir} = await start();
  try {
    const project = (await call('POST', 'projects', {name: 'Traffic'})).body;
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const defined = await call('PUT', 'collections/audit', {
        title: 'Audit',
        schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
      });
      assert.equal(defined.status, 200, JSON.stringify(defined.body));
      await call('GET', 'projects');
      samples.push(performance.now() - started);
    }
    const timing = stats(samples);
    // p95 under 250 ms per pair on this machine; a leak or quadratic path takes far longer.
    assert.ok(timing.p95 < 250, JSON.stringify(timing));
    const records = await call('GET', 'collections/audit/records');
    assert.equal(records.status, 200);
    assert.ok(project.id);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('twelve parallel runs settle and leave no running runtime behind', async () => {
  const {app, call, dir} = await start();
  try {
    await call('PUT', 'settings', {developer_mode: true});
    const project = (await call('POST', 'projects', {name: 'Parallel runs'})).body;
    const query = {workflow_id: project.id};
    const nodes = [];
    for (let i = 0; i < 12; i++) {
      const started = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: i * 50, y: 0}});
      const slow = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: i * 50, y: 100}});
      await call('PUT', `projects/${project.id}/input-values`, {
        ...query,
        node_id: slow.body.id,
        values: {script: `await node.sleep(${30 + i * 5}); node.display("run ${i}");`},
      });
      await call('POST', `projects/${project.id}/port-connections`, {
        ...query,
        add: [{source: started.body.id, source_port: 'out', target: slow.body.id, target_port: 'in'}],
      });
      nodes.push(started.body.id);
    }
    // Start them all, then stop half of them while they sleep.
    const started = await Promise.all(nodes.map(id => call('POST', `projects/${project.id}/execution`, {...query, node_ids: [id]})));
    assert.equal(started.every(result => result.status === 200), true);
    await sleep(20);
    await call('DELETE', `projects/${project.id}/execution?workflow_id=${project.id}`);
    // Everything settles: the runtime reports idle and diagnostics sees no running runtime.
    let detail;
    for (let i = 0; i < 200; i++) {
      detail = (await call('GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      if (detail.status === 'idle') break;
      await sleep(25);
    }
    assert.equal(detail.status, 'idle');
    const diagnostics = (await call('GET', 'diagnostics')).body;
    assert.equal(diagnostics.runtime.running, 0);
    assert.ok(diagnostics.workers.started >= 1, 'the work really ran');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('an event stream that is closed by the client is forgotten by the server', async () => {
  const {app, base, call, dir} = await start();
  const controllers = Array.from({length: 10}, () => new AbortController());
  try {
    const readers = await Promise.all(
      controllers.map(controller => fetch(base + '/api/events', {headers: bearer, signal: controller.signal}))
    );
    await Promise.all(readers.map(async response => {
      const reader = response.body.getReader();
      reader.read().catch(() => {});
      return reader;
    }));
    const open = (await call('GET', 'diagnostics')).body.clients;
    assert.ok(open >= 10, `ten streams are open (${open})`);
    for (const controller of controllers) controller.abort();
    let closed = open;
    for (let i = 0; i < 100 && closed > 0; i++) {
      await sleep(20);
      closed = (await call('GET', 'diagnostics')).body.clients;
    }
    assert.equal(closed, 0, 'every closed stream is removed');
  } finally {
    for (const controller of controllers) controller.abort();
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a flood of sessions is bounded and the oldest is the one that loses its place', async () => {
  const {app, base, call, dir} = await start({sessionLimit: 3});
  try {
    const cookies = [];
    for (let i = 0; i < 5; i++) {
      const response = await fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: TOKEN}),
      });
      assert.equal(response.status, 200);
      cookies.push(response.headers.get('set-cookie').split(';')[0]);
    }
    assert.equal((await call('GET', 'diagnostics')).body.sessions, 3, 'the map keeps at most its limit');
    assert.equal((await fetch(base + '/api/projects', {headers: {Cookie: cookies[0]}})).status, 401, 'the first session was evicted');
    assert.equal((await fetch(base + '/api/projects', {headers: {Cookie: cookies[4]}})).status, 200, 'the newest still works');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a large workflow is saved and read back in linear time', async () => {
  const {app, call, dir} = await start();
  try {
    await call('PUT', 'settings', {developer_mode: true});
    const project = (await call('POST', 'projects', {name: 'Large graph'})).body;
    const query = {workflow_id: project.id};
    const total = 600;
    const write = performance.now();
    for (let batch = 0; batch < Math.ceil(total / 100); batch++) {
      const operations = [];
      for (let i = 0; i < 100 && batch * 100 + i < total; i++) {
        const n = batch * 100 + i;
        operations.push({
          method: 'POST',
          path: 'typed-nodes',
          body: {
            node_type: 'custom',
            config: {title: 'Node ' + n, op: 'on_run', inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}]},
            position: {x: (n % 40) * 40, y: Math.floor(n / 40) * 40},
          },
        });
      }
      const result = await call('POST', `projects/${project.id}/batch`, {...query, operations});
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const saved = performance.now() - write;
    const reads = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const graph = await call('GET', `projects/${project.id}/workflow?workflow_id=${project.id}`);
      reads.push(performance.now() - started);
      assert.equal(graph.body.nodes.length, total);
    }
    const timing = stats(reads);
    assert.ok(saved < 30000, `saving ${total} nodes took ${Math.round(saved)} ms`);
    assert.ok(timing.p95 < 3000, `reading ${total} nodes took ${JSON.stringify(timing)} ms`);
    // The file on disk is a canonical text graph with a layout sidecar, not one huge JSON blob.
    const graphFile = fs.readFileSync(path.join(dir, 'workflows', project.id + '.json'), 'utf8');
    assert.match(graphFile, /agentsys\.text\/1/);
    assert.equal(fs.existsSync(path.join(dir, 'workflows', project.id + '.files', 'layout.json')), true);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a collection with a thousand records paginates and stays responsive', async () => {
  const {app, call, dir} = await start();
  try {
    await call('PUT', 'collections/log', {
      title: 'Log',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    const write = performance.now();
    for (let i = 0; i < 1000; i++) await call('POST', 'collections/log/records', {data: {n: i}});
    const wrote = performance.now() - write;
    const page = await call('GET', 'collections/log/records?limit=50&offset=500');
    assert.equal(page.body.total, 1000);
    assert.equal(page.body.records.length, 50);
    assert.equal(page.body.records[0].data.n, 500);
    assert.ok(wrote < 60000, `1000 records took ${Math.round(wrote)} ms`);
    // The page size is capped by the server, whatever the caller asks for.
    const huge = await call('GET', 'collections/log/records?limit=100000');
    assert.equal(huge.body.records.length, 500);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
