'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, flow, nodes, TYPES} = require('./harness');
async function fakeApp(scripts = 'inline') {
  const app = createApp({scripts});
  const p = await app.api('POST', 'projects', {name: 'AI'});
  return {app, p};
}
test('Script API calls require instance permissions and project policy', async () => {
  const {app, p} = await fakeApp();
  for (const options of [{grants: []}, {grants: ['graph.read']}, {grants: ['graph.write'], grants: []}]) {
    const n = await fn(
      app,
      p.id,
      {},
      {...options, code: 'await agentsys("PUT","projects/"+context.project_id,{description:"changed"});'}
    );
    const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
    assert.ok(Object.keys(r.errors).length > 0);
    assert.match(JSON.stringify(r.errors), /Permission denied/);
  }
  const n = await fn(
    app,
    p.id,
    {},
    {grants: ['graph.read'], code: 'const p=await agentsys("GET","projects"); node.display(p.length);'}
  );
  assert.equal((await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true})).status, 'idle');
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
      grants: [],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(r.status, 'idle');
  assert.deepEqual(r.outputs[n.id].result, Array(7).fill('undefined'));
});

test('network allow lists and secret substitution are enforced by the host', async () => {
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
      grants: ['net.fetch:good.test', 'secrets.use:service'],
      code: 'node.output.result=await agentsys("POST","net",{url:"https://good.test/path",headers:{Authorization:"Bearer {{secret:service}}"}});',
      outputs: ['result'],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(r.status, 'idle');
  assert.equal(r.outputs[n.id].result.text, 'echo [REDACTED]');
  assert.equal(calls, 1);
  const bad = await fn(
    app,
    p.id,
    {},
    {grants: ['net.fetch:good.test'], code: 'await agentsys("POST","net",{url:"https://other.test"});'}
  );
  const denied = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [bad.id], wait: true});
  assert.ok(Object.keys(denied.errors).length > 0);
  assert.equal(calls, 1);
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
      grants: ['library.write', 'graph.read'],
      code: `await agentsys("POST","resources",{name:"Made by a script",payload:{bundle:${JSON.stringify(made.bundle)},grants:["graph.write"],grants:["graph.write"]}});`,
    }
  );
  await app.api('PUT', `projects/${p.id}/policy`, {allow: ['library.write', 'graph.read']});
  const run = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [writer.id], wait: true});
  assert.equal(run.status, 'idle', JSON.stringify(run.errors));
  const item = (await app.api('GET', 'resources')).find(r => r.name === 'Made by a script');
  assert.deepEqual(item.payload.grants, ['graph.read']);
});

test('Library permissions are placement defaults, never a ceiling for an existing instance', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await fn(
    app,
    p.id,
    {},
    {grants: [], outputs: ['result'], code: 'node.output.result=(await agentsys("GET","projects")).length;'}
  );
  await flow(app, p.id, {}, [n.step]);
  const run = () => app.api('POST', `projects/${p.id}/execution`, {wait: true});
  assert.ok(Object.keys((await run()).errors).length > 0);
  await app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: ['graph.read']});
  assert.equal((await run()).status, 'idle', 'instance can allow a right absent from the Library defaults');
  const resource = await app.api('GET', 'resources/' + n.resource);
  await app.api('PUT', 'resources/' + n.resource, {
    name: resource.name,
    payload: {...resource.payload, grants: ['library.read']},
  });
  const snapshot = await app.api('GET', `projects/${p.id}/workflow`);
  assert.deepEqual(snapshot.complex.find(c => c.id === n.group).grants, ['graph.read']);
  assert.equal((await run()).status, 'idle', 'changing the defaults does not restrict an existing copy');
  const next = await app.api('POST', `projects/${p.id}/custom-nodes/${n.resource}`, {point: {x: 300, y: 0}});
  const after = await app.api('GET', `projects/${p.id}/workflow`);
  assert.deepEqual(after.complex.find(c => c.id === next.roots[0]).grants, ['library.read']);
  await app.api('PUT', `projects/${p.id}/policy`, {allow: []});
  assert.ok(Object.keys((await run()).errors).length > 0);
});

test('unused permissions do not block a node from running ordinary code', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await fn(app, p.id, {}, {grants: ['net.fetch:*'], outputs: ['result'], code: 'node.output.result=42;'});
  await app.api('PUT', `projects/${p.id}/policy`, {allow: []});
  const result = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(result.status, 'idle');
  assert.equal(result.outputs[n.id].result, 42);
});

test('typed and wired Script code use the same instance permissions', async () => {
  const {app, p} = await fakeApp('worker');
  const code = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'custom',
    config: {
      title: 'Code',
      inputs: [],
      outputs: [
        {
          id: 'value',
          name: 'value',
          type: 't:' + TYPES.code.id,
          editable: true,
          default: `await agentsys('PUT','projects/${p.id}',{description:'Written through an explicit instance grant'});`,
        },
      ],
    },
  });
  const script = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'custom',
    config: {...nodes.script(''), grants: ['graph.write']},
  });
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: code.id, source_port: 'value', target: script.id, target_port: 'script'}],
  });
  const result = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [script.id], wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.equal(
    (await app.api('GET', `projects/${p.id}`)).project.description,
    'Written through an explicit instance grant'
  );
});

test('permissions are set on the placed node and limit everything inside it', async () => {
  const {app, p} = await fakeApp();
  const n = await fn(
    app,
    p.id,
    {},
    {
      grants: ['graph.write'],
      grants: ['graph.write'],
      code: 'await agentsys("PUT","projects/"+context.project_id,{description:"changed"});',
    }
  );
  const run = () => app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal((await run()).status, 'idle');
  await app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: []});
  const denied = await run();
  assert.ok(Object.keys(denied.errors).length > 0);
  assert.match(JSON.stringify(denied.errors), /Permission denied/);
  await assert.rejects(app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: ['bogus']}), /Invalid grants/);
  await app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: ['graph.write']});
  assert.equal((await run()).status, 'idle');
});
