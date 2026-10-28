'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn} = require('./harness');
async function fakeApp(scripts = 'inline') {
  const app = createApp({scripts});
  await app.api('POST', 'resources', {
    kind: 'provider',
    name: 'Fake',
    payload: {endpoint: 'http://fake.test/v1', default_model: 'test'},
  });
  const p = await app.api('POST', 'projects', {name: 'AI'});
  return {app, p};
}
test('the standalone model endpoint works without a run context and redacts provider credentials', async () => {
  const {app} = await fakeApp();
  const provider = (await app.api('GET', 'resources')).find(r => r.kind === 'provider');
  await app.api('PUT', 'resources/' + provider.id, {
    name: provider.name,
    payload: {...provider.payload, api_key: 'private-credential'},
  });
  app.context.fetch = async () => ({
    ok: true,
    json: async () => ({choices: [{message: {content: 'standalone private-credential'}}]}),
  });
  assert.equal((await app.api('POST', 'llm', {prompt: 'hi'})).text, 'standalone [REDACTED]');
});
test('429 retry and structured correction are traced with usage, redacted blobs and a shared budget', async () => {
  const {app, p} = await fakeApp();
  let count = 0;
  app.context.fetch = async () => {
    count++;
    return {
      ok: count !== 1,
      status: count === 1 ? 429 : 200,
      text: async () => '',
      json: async () => ({
        choices: [{message: {content: count === 2 ? 'bad' : '{"ok":true}'}}],
        usage: {total_tokens: 10, prompt_tokens: 5, completion_tokens: 5},
      }),
    };
  };
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'const r = await agentsys("POST","llm",{prompt:"token=secret-token",retry:{backoff:0},schema:{type:"object",required:["ok"],properties:{ok:{type:"boolean"}}}}); node.output.result=r.value;',
      outputs: ['result'],
    }
  );
  const run = await app.api('POST', `projects/${p.id}/runs`, {
    node_ids: [n.id],
    wait: 2,
    budget: {calls: 3, tokens: 100000, cost: 1, ms: 10000},
  });
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.outputs[n.id].result, {ok: true});
  const events = (await app.api('GET', `runs/${run.id}/events`)).events.filter(e => e.type === 'llm_call');
  assert.equal(events.length, 3);
  assert.equal(count, 3);
  assert.equal((await app.api('GET', `runs/${run.id}/budget`)).usage.calls, 3);
  const blob = await app.eval(`DB.get('blobs/${events[0].prompt_hash}')`);
  assert.ok(!blob.text.includes('secret-token'));
  const loop = await fn(
    app,
    p.id,
    {},
    {code: 'await Promise.all([1,2].map(()=>agentsys("POST","llm",{prompt:"hi"})));'}
  );
  const limited = await app.api('POST', `projects/${p.id}/runs`, {
    node_ids: [loop.id],
    wait: 2,
    budget: {calls: 1, tokens: 100000, cost: 1},
  });
  assert.equal(limited.status, 'failed');
  assert.equal(limited.usage.calls, 1);
});
test('human approvals approve, reject, expire and cannot be bypassed by manual resume', async () => {
  const {app, p} = await fakeApp();
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'if(!node.resumed) await node.wait({approval:{question:"Proceed?",timeout:1000}}); node.output.result=node.resumed.value.approved;',
      outputs: ['result'],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  assert.equal(r.status, 'waiting');
  await assert.rejects(app.api('POST', `runs/${r.id}/resume`), /approval/);
  const [a] = await app.api('GET', 'approvals');
  await app.api('POST', `approvals/${a.id}`, {answer: 'approve'});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', `runs/${r.id}`)).outputs[n.id].result, true);
  const r2 = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  await app.api('POST', 'scheduler/tick', {now: Date.now() / 1000 + 2});
  await app.eval(`RUNS.byId.get('${r2.id}').done`);
  assert.equal((await app.api('GET', `runs/${r2.id}`)).outputs[n.id].result, false);
});
test('capabilities intersect declaration, policy and grant; absent manifest denies; AI is quarantined', async () => {
  const {app, p} = await fakeApp();
  for (const options of [
    {capabilities: []},
    {capabilities: ['graph.read']},
    {capabilities: ['graph.write'], grants: []},
    {capabilities: ['graph.write'], origin: 'ai'},
  ]) {
    const n = await fn(
      app,
      p.id,
      {},
      {...options, code: 'await agentsys("PUT","projects/"+context.project_id+"/state/x",{value:1});'}
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

test('AI capability approval is bound to code and changes invalidate the grant', async () => {
  const {app, p} = await fakeApp();
  const n = await fn(
    app,
    p.id,
    {},
    {
      origin: 'ai',
      capabilities: ['graph.write'],
      grants: [],
      code: 'await agentsys("PUT","projects/"+context.project_id+"/state/approved",{value:1});',
    }
  );
  const approval = await app.api('POST', `projects/${p.id}/permission-approvals`, {resource_id: n.resource});
  assert.ok(approval.code.includes('/state/approved'));
  assert.deepEqual(approval.capabilities, ['graph.write']);
  await app.api('POST', 'approvals/' + approval.id, {answer: 'approve'});
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  assert.equal(run.status, 'completed');
  const item = await app.api('GET', 'resources/' + n.resource);
  item.payload.bundle.records
    .find(r => r.payload.config?.op === 'script')
    .payload.config.inputs.find(p => p.id === 'script').default += '\nnode.display("changed");';
  await app.api('PUT', 'resources/' + n.resource, {name: item.name, payload: item.payload, replace: true});
  const snapshot = await app.api('GET', `projects/${p.id}/workflow`);
  const id = snapshot.nodes.find(x => x.config?.op === 'script').id;
  const denied = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [id], wait: 1});
  assert.equal(denied.status, 'failed');
});

test('the shipped Tool-use loop stops before exceeding its shared model-call budget', async () => {
  const {app, p} = await fakeApp();
  const TextGraph = require('../js/storage/format');
  const entry = TextGraph.decode(require('../examples/ai-nodes.json')).find(e => e.name === 'Tool-use loop');
  const item = await app.api('POST', 'resources', entry),
    placed = await app.api('POST', `projects/${p.id}/custom-nodes/${item.id}`, {point: {x: 0, y: 0}});
  const loop = 'complex:' + placed.roots[0],
    initiative = await app.api('POST', 'initiatives', {title: 'Agent', goal: 'Run a bounded tool loop'});
  const setup = await fn(
    app,
    p.id,
    {},
    {
      outputs: ['tools'],
      signals: ['Out'],
      capabilities: [],
      code: `node.output.tools=[{name:"tasks",method:"GET",path:"initiatives/${initiative.id}/tasks"}];await node.emit("Out");`,
    }
  );
  await app.api('PUT', `projects/${p.id}/input-values`, {
    node_id: loop,
    values: {prompt: 'Inspect the tasks', max_steps: 10},
  });
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [
      {source: setup.wrapper, source_port: 'tools', target: loop, target_port: 'tools'},
      {source: setup.wrapper, source_port: 'Out', target: loop, target_port: 'in'},
    ],
  });
  let calls = 0;
  app.context.fetch = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        choices: [{message: {content: JSON.stringify({done: false, text: 'continue', tool: 'tasks', args: {}})}}],
        usage: {total_tokens: 10},
      }),
    };
  };
  const run = await app.api('POST', `projects/${p.id}/runs`, {
    node_ids: [setup.id],
    wait: 1,
    budget: {calls: 1, tokens: 1000000, cost: 1},
  });
  assert.equal(run.status, 'failed');
  assert.equal(calls, 1);
  assert.equal(run.usage.calls, 1);
  assert.match(JSON.stringify(run.errors), /Budget exceeded/);
});

test('an approval survives a backend restart and rejecting it resumes with an explicit negative answer', async () => {
  const data = new Map(),
    store = {
      get: k => structuredClone(data.get(k)),
      commit: ({set, remove}) => {
        for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
        for (const k of remove) data.delete(k);
      },
    };
  const a = createApp({store}),
    p = await a.api('POST', 'projects', {name: 'Durable approval'});
  const n = await fn(
    a,
    p.id,
    {},
    {
      code: 'if(!node.resumed)await node.wait({approval:{question:"Continue after restart?"}});node.display(node.resumed.value.answer);',
    }
  );
  const run = await a.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id], wait: 1});
  const b = createApp({store, scripts: 'worker'}),
    [approval] = await b.api('GET', 'approvals');
  assert.equal(approval.run_id, run.id);
  await b.api('POST', 'approvals/' + approval.id, {answer: 'reject'});
  await b.eval(`RUNS.byId.get('${run.id}').done`);
  const done = await b.api('GET', 'runs/' + run.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.displays[n.id], 'reject');
});

test('cancelling an in-flight model request does not retry or leave pending approvals', async () => {
  const {app, p} = await fakeApp();
  let started;
  const ready = new Promise(resolve => (started = resolve));
  let calls = 0;
  app.context.fetch = async (_url, init) => {
    calls++;
    started();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('Aborted'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, {once: true});
    });
  };
  const n = await fn(app, p.id, {}, {code: 'await agentsys("POST","llm",{prompt:"slow"});'});
  const run = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [n.id]});
  await ready;
  assert.equal((await app.api('POST', `runs/${run.id}/cancel`)).status, 'cancelled');
  assert.equal(calls, 1);
  const ask = await fn(app, p.id, {}, {code: 'await node.wait({approval:{question:"Cancel me"}});'});
  const waiting = await app.api('POST', `projects/${p.id}/runs`, {node_ids: [ask.id], wait: 1});
  await app.api('POST', `runs/${waiting.id}/cancel`);
  assert.equal((await app.api('GET', 'approvals')).length, 0);
});
