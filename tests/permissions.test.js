'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn} = require('./harness');
async function fakeApp(scripts = 'inline') {
  const app = createApp({scripts});
  const p = await app.api('POST', 'projects', {name: 'AI'});
  return {app, p};
}
test('capabilities intersect declaration, policy and grant; absent manifest denies', async () => {
  const {app, p} = await fakeApp();
  for (const options of [
    {capabilities: []},
    {capabilities: ['graph.read']},
    {capabilities: ['graph.write'], grants: []},
  ]) {
    const n = await fn(
      app,
      p.id,
      {},
      {...options, code: 'await agentsys("PUT","workflows/"+context.workflow_id+"/state/x",{value:1});'}
    );
    const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
    assert.equal(r.status, 'failed');
    assert.match(JSON.stringify(r.errors), /Permission denied/);
  }
  const n = await fn(
    app,
    p.id,
    {},
    {capabilities: ['graph.read'], code: 'const p=await agentsys("GET","projects"); node.display(p.length);'}
  );
  assert.equal((await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1})).status, 'completed');
  assert.ok(
    await app.eval('ROUTES.every(r => [...r.methods].every(m => Array.isArray(r.needs[m]) && r.needs[m].length))')
  );
});

test('worker has no direct network, messaging, Node globals or constructor escape to the host', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'node.output.result=[typeof fetch,typeof importScripts,typeof require,typeof process,typeof postMessage,typeof setTimeout.constructor("return globalThis.process")(),typeof globalThis.__host];',
      outputs: ['result'],
      capabilities: [],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 2});
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.outputs[n.id].result, Array(7).fill('undefined'));
});

test('network allow lists and secret substitution are enforced and audited by the host', async () => {
  const {app, p} = await fakeApp();
  await app.api('PUT', `projects/${p.id}/policy`, {allow: ['net.fetch:good.test', 'secrets.use:service']});
  await app.api('PUT', 'secrets/service', {value: 'sensitive-value'});
  let calls = 0;
  app.context.fetch = async (url, init) => {
    calls++;
    assert.equal(init.headers.Authorization, 'Bearer sensitive-value');
    return {status: 200, text: async () => 'echo sensitive-value'};
  };
  const n = await fn(
    app,
    p.id,
    {},
    {
      capabilities: ['net.fetch:good.test', 'secrets.use:service'],
      code: 'node.output.result=await agentsys("POST","net",{url:"https://good.test/path",headers:{Authorization:"Bearer {{secret:service}}"}});',
      outputs: ['result'],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  assert.equal(r.status, 'completed');
  assert.equal(r.outputs[n.id].result.text, 'echo [REDACTED]');
  assert.equal(calls, 1);
  const bad = await fn(
    app,
    p.id,
    {},
    {capabilities: ['net.fetch:good.test'], code: 'await agentsys("POST","net",{url:"https://other.test"});'}
  );
  const denied = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [bad.id], wait: 1});
  assert.equal(denied.status, 'failed');
  assert.equal(calls, 1);
  assert.ok((await app.api('GET', `runs/${denied.id}/events`)).events.some(e => e.type === 'permission_denied'));
  assert.equal(JSON.stringify(await app.eval(`RUNS.byId.get('${r.id}').trace`)).includes('sensitive-value'), false);
});

test('what a script writes into the Library is stripped of grants', async () => {
  const {app, p} = await fakeApp();
  const {bundleOf, nodes} = require('./harness');
  const made = bundleOf('Made by a script', {Body: {inputs: [], outputs: []}, Script: nodes.script('')});
  const writer = await fn(
    app,
    p.id,
    {},
    {
      capabilities: ['library.write', 'graph.read'],
      code: `await agentsys("POST","resources",{name:"Made by a script",payload:{bundle:${JSON.stringify(made.bundle)},capabilities:["graph.write"],grants:["graph.write"]}});`,
    }
  );
  await app.api('PUT', `projects/${p.id}/policy`, {allow: ['library.write', 'graph.read']});
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [writer.id], wait: 1});
  assert.equal(run.status, 'completed', JSON.stringify(run.errors));
  const item = (await app.api('GET', 'resources')).find(r => r.name === 'Made by a script');
  assert.deepEqual(item.payload.grants, ['graph.read']);
  assert.deepEqual(item.payload.capabilities, ['graph.write']);
});
