'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, nodes} = require('./harness');
const {loadBackend} = require('../headless');

test('a wait frees the worker and resumes with its input snapshot after a backend restart', async () => {
  const data = new Map();
  const store = {
    get: k => structuredClone(data.get(k)),
    commit: ({set, remove}) => {
      for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
      for (const k of remove) data.delete(k);
    },
  };
  const app = createApp({scripts: 'worker', store});
  const p = await app.api('POST', 'projects', {name: 'Durable'});
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'if (!node.resumed) await node.wait({event:"ready", match:{id:42}}); node.output.result = node.resumed.value.answer;',
      outputs: ['result'],
    }
  );
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 2});
  assert.equal(run.status, 'waiting');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.workerStats.terminated, 1);
  assert.equal(app.workerStats.exited, 1);
  assert.equal(run.nodes.find(x => x.node_id === n.id).status, 'waiting');
  assert.ok(data.get(`runs/${run.id}/checkpoint`));
  const backend = loadBackend({store});
  const api = (method, path, body = {}) => backend.Backend.request(method, path, {body});
  assert.equal((await api('GET', `runs/${run.id}`)).status, 'waiting');
  assert.equal((await api('POST', 'events/ready', {id: 1})).resumed.length, 0);
  assert.equal((await api('POST', 'events/ready', {id: 42, answer: 'yes'})).resumed[0], run.id);
  await backend.eval(`RUNS.byId.get('${run.id}').done`);
  const done = await api('GET', `runs/${run.id}`);
  assert.equal(done.status, 'completed');
  assert.equal(done.outputs[n.id].result, 'yes');
  assert.ok((await api('GET', `runs/${run.id}/events`)).events.some(e => e.type === 'run_resumed'));
});

test('parallel branch finishes during a delay and nested emit continues after resume', async () => {
  const app = createApp();
  const p = await app.api('POST', 'projects', {name: 'Nested'});
  const a = await fn(app, p.id, {}, {code: 'await node.emit("out"); node.display("parent done");', signals: ['out']});
  const b = await fn(
    app,
    p.id,
    {},
    {code: 'if (!node.resumed) await node.wait({delay:1000}); node.display("child done");'}
  );
  const c = await fn(app, p.id, {}, {code: 'node.display("parallel done");'});
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [b, c].map(n => ({source: a.wrapper, source_port: 'out', target: n.wrapper, target_port: 'in'})),
  });
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [a.id], wait: 1});
  assert.equal(run.status, 'waiting');
  assert.equal(run.displays[c.id], 'parallel done');
  await app.api('POST', 'scheduler/tick', {now: Date.now() / 1000 + 2});
  await app.eval(`RUNS.byId.get('${run.id}').done`);
  const done = await app.api('GET', `runs/${run.id}`);
  assert.equal(done.status, 'completed');
  assert.equal(done.displays[a.id], 'parent done');
  assert.equal(done.displays[b.id], 'child done');
});

test('waiting runs can be cancelled and running runs recover as interrupted', async () => {
  const app = createApp();
  const p = await app.api('POST', 'projects', {name: 'Cancel'});
  const n = await fn(app, p.id, {}, {code: 'await node.wait({event:"forever"});'});
  const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  assert.equal((await app.api('POST', `runs/${r.id}/cancel`)).status, 'cancelled');
  assert.equal((await app.api('POST', 'events/forever', {})).resumed.length, 0);
});

test('break and failFast cancel sibling waits without leaving an orphan checkpoint', async () => {
  for (const mode of ['break', 'failFast']) {
    const app = createApp(),
      p = await app.api('POST', 'projects', {name: mode});
    const parent = await fn(
      app,
      p.id,
      {},
      {
        signals: ['out'],
        code: `const r=await node.emit("out",{handles:["break"],failFast:true});node.display(r??"finished");`,
      }
    );
    const waiting = await fn(app, p.id, {}, {code: 'await node.wait({event:"never"});'});
    const stop = await fn(
      app,
      p.id,
      {},
      {code: mode === 'break' ? 'node.flow.break();' : 'throw Error("branch failed");'}
    );
    await app.api('POST', `projects/${p.id}/port-connections`, {
      add: [waiting, stop].map(n => ({
        source: parent.wrapper,
        source_port: 'out',
        target: n.wrapper,
        target_port: 'in',
      })),
    });
    const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [parent.id], wait: 1});
    assert.equal(run.status, mode === 'break' ? 'completed' : 'failed');
    assert.equal(run.waits.length, 0);
    if (mode === 'break') assert.equal(run.displays[parent.id], 'break');
    else assert.match(JSON.stringify(run.errors), /branch failed/);
  }
});

test('waiting inside on_read restores its read cache and invocation identity', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Read suspension'});
  const {bundleOf, place} = require('./harness');
  const placed = await place(
    app,
    p.id,
    {},
    bundleOf(
      'Read wait',
      {
        Read: nodes.event('on_read'),
        Script: nodes.script(
          'if(!node.resumed)await node.wait({event:"read-ready"});node.output.result=node.resumed.value.result;'
        ),
      },
      {wires: [['Read', 'out', 'Script', 'in']], outputs: [{id: 'result', name: 'result', node: false}]}
    )
  );
  const read = await fn(
    app,
    p.id,
    {},
    {inputs: ['value'], outputs: ['result'], code: 'node.output.result=node.input.value;'}
  );
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: placed.id, source_port: 'result', target: read.wrapper, target_port: 'value'}],
  });
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [read.id], wait: 1});
  assert.equal(run.status, 'waiting');
  await app.api('POST', 'events/read-ready', {result: 42});
  await app.eval(`RUNS.byId.get('${run.id}').done`);
  const done = await app.api('GET', 'runs/' + run.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.outputs[read.id].result, 42);
});

test('a running record becomes interrupted on startup and can resume its last checkpoint', async () => {
  const data = new Map(),
    store = {
      get: k => structuredClone(data.get(k)),
      commit: ({set, remove}) => {
        for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
        for (const k of remove) data.delete(k);
      },
    };
  const app = createApp({store}),
    p = await app.api('POST', 'projects', {name: 'Interrupt'}),
    n = await fn(
      app,
      p.id,
      {},
      {code: 'if(!node.resumed)await node.wait({event:"resume"});node.display("recovered");'}
    );
  const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  data.get('runs/' + r.id).status = 'running';
  const second = loadBackend({store}),
    api = (m, path, body = {}) => second.Backend.request(m, path, {body});
  assert.equal((await api('GET', 'runs/' + r.id)).status, 'interrupted');
  await api('POST', `runs/${r.id}/resume`);
  await second.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await api('GET', 'runs/' + r.id)).status, 'completed');
});

test('an event arriving while another branch drains is not lost before the checkpoint', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Event race'});
  const a = await fn(app, p.id, {}, {code: 'if(!node.resumed)await node.wait({event:"race"});node.display("awake");'});
  const b = await fn(app, p.id, {}, {code: 'await new Promise(r=>setTimeout(r,100));'});
  const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [a.id, b.id]});
  for (let i = 0; i < 100; i++) {
    const events = await app.api('GET', `runs/${r.id}/events`);
    if (events.events.some(e => e.type === 'node_waiting')) break;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'running');
  await app.api('POST', 'events/race', {});
  for (let i = 0; i < 100; i++) {
    const run = await app.api('GET', 'runs/' + r.id);
    if (run.status === 'completed') {
      assert.equal(run.displays[a.id], 'awake');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Event did not resume the run');
});
