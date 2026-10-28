'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TextGraph = require('../js/storage/format');
const {createApp, fn, nodes} = require('./harness');

test('canonical text round trips byte for byte and separates code and position diffs', () => {
  const value = {
    kind: 'workflow',
    document: {
      nodes: [
        {id: 'b', config: nodes.script('node.display("hello");\n')},
        {id: 'a', config: nodes.run()},
      ],
      layout: {b: {x: 10, y: 20}, a: {x: 0, y: 0}},
    },
  };
  const encoded = TextGraph.encode(value);
  assert.equal(TextGraph.canonical(TextGraph.decode(encoded)), TextGraph.canonical(value));
  assert.ok(!encoded.files['graph.json'].includes('node.display'));
  const moved = structuredClone(value);
  moved.document.layout.b.x = 50;
  assert.equal(TextGraph.encode(moved).files['graph.json'], encoded.files['graph.json']);
  assert.notEqual(TextGraph.encode(moved).files['layout.json'], encoded.files['layout.json']);
  assert.throws(() => TextGraph.decode({kind: 'workflow', document: {}}), /agentsys.text/);
  assert.throws(
    () => TextGraph.decode({...encoded, files: {...encoded.files, '../secret.js': 'x'}}),
    /Invalid text file/
  );
});
test('history restores old code; replacing a Library copy removes its waiting invocation', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Versions'});
  const n = await fn(app, p.id, {}, {code: 'if(!node.resumed)await node.wait({event:"go"});node.display("original");'});
  const original = (await app.api('GET', `versions/node/${n.resource}`)).current;
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  const item = await app.api('GET', 'resources/' + n.resource);
  item.payload.bundle.records
    .find(r => r.payload.config?.op === 'script')
    .payload.config.inputs.find(p => p.id === 'script').default = 'node.display("changed");';
  await app.api('PUT', 'resources/' + n.resource, {name: item.name, payload: item.payload, replace: true});
  assert.notEqual((await app.api('GET', `versions/node/${n.resource}`)).current, original);
  await app.api('POST', 'events/go', {});
  await app.eval(`RUNS.byId.get('${run.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + run.id)).status, 'completed');
  assert.ok(
    (await app.api('GET', `runs/${run.id}/events`)).events.some(
      e => e.type === 'node_skipped' && e.node_id === n.id && e.reason === 'node_removed'
    )
  );
  await app.api('POST', `versions/node/${n.resource}/${original}/restore`);
  assert.equal((await app.api('GET', `versions/node/${n.resource}`)).current, original);
  const restored = await app.api('GET', 'resources/' + n.resource);
  assert.match(JSON.stringify(restored.payload.bundle), /original/);
});
test('offline replay reproduces outside calls, parallel completion, time and randomness and reports divergence', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Replay'});
  app.context.fetch = async () => ({status: 200, text: async () => 'recorded'});
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'const time=Date.now(),random=Math.random();const r=await agentsys("POST","net",{url:"https://fake.test"});node.output.result={time,random,text:r.text};',
      outputs: ['result'],
    }
  );
  const original = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  app.context.fetch = async () => {
    throw Error('offline; should not be called');
  };
  const replay = await app.api('POST', `runs/${original.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'completed');
  assert.deepEqual(replay.outputs, original.outputs);
  await app.eval(`RUNS.byId.get('${original.id}').trace[0].request_hash='different'`);
  const bad = await app.api('POST', `runs/${original.id}/replay`, {wait: 2});
  assert.equal(bad.status, 'failed');
  assert.match(JSON.stringify(bad), /diverged/);
});
test('a completed executor snapshot restores without rerunning code and returns the same outputs', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Snapshot'});
  const n = await fn(app, p.id, {}, {code: 'node.output.result={answer:42};', outputs: ['result']});
  const snapshot = await app.api('GET', `projects/${p.id}/workflow`);
  const result = await app.eval(
    `(async()=>{const plan=compilePlan(${JSON.stringify(snapshot)},['${n.id}']);const a=await runPlanned(plan,runPlan);const b=await runPlanned({...plan,checkpoint:JSON.parse(JSON.stringify(a.execution.checkpoint))},runPlan);return JSON.stringify({a:a.outputs,b:b.outputs,executed:b.done});})()`
  );
  const restored = JSON.parse(result);
  assert.deepEqual(restored.a, restored.b);
  assert.deepEqual(restored.executed, []);
});
