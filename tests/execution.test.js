'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes, flow, fn, bundleOf, place} = require('./harness');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(app, path, predicate) {
  for (let i = 0; i < 300; i++) {
    const detail = await app.api('GET', path);
    if (predicate(detail)) return detail;
    await sleep(10);
  }
  assert.fail('Graph state was not reached');
}
async function fixture(t, code, {store = null} = {}) {
  const app = createApp({scripts: 'worker', store}),
    project = await app.api('POST', 'projects', {name: 'Live graph'});
  t.after(() => app.Backend.shutdownExecutions());
  const node = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script(code),
  });
  return {app, project, node, path: `projects/${project.id}/execution`};
}
async function change(app, project, node, code) {
  const graph = await app.api('GET', `projects/${project.id}/workflow`),
    config = graph.nodes.find(n => n.id === node.id).config;
  config.inputs.find(p => p.id === 'script').default = code;
  await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {node_type: 'custom', config});
}

test('Run is a repeatable on_run signal, with one persistent graph context and host', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.count=(context.state.count??0)+1;globalThis.count=(globalThis.count??0)+1;node.display([context.state.count,globalThis.count]);'
  );
  await flow(app, project.id, {}, [node.id]);
  for (let count = 1; count <= 3; count++) {
    const detail = await app.api('POST', path, {wait: true});
    assert.equal(detail.status, 'idle');
    assert.equal(detail.state.count, count);
    assert.deepEqual(JSON.parse(detail.displays[node.id]), [count, count]);
  }
  assert.equal(app.workerStats.started, 1);
});
test('a graph without on_run does nothing when Run is signalled', async t => {
  const {app, path} = await fixture(t, 'throw Error("Must not run without a signal")');
  assert.equal((await app.api('POST', path, {wait: true})).status, 'idle');
  assert.equal(app.workerStats.started, 0);
});
test('automatic Script out connects standalone Scripts in a chain', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.order=["first"];');
  const second = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.order.push("second");'),
  });
  await flow(app, project.id, {}, [node.id, second.id]);
  const result = await app.api('POST', path, {wait: true});
  assert.deepEqual(result.state.order, ['first', 'second']);
  assert.deepEqual(result.errors, {});
});
test('Run can signal the same graph while other work is active', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.started=(context.state.started??0)+1;await node.sleep(100);context.state.finished=(context.state.finished??0)+1;'
  );
  await flow(app, project.id, {}, [node.id]);
  await app.api('POST', path);
  await app.api('POST', path);
  await until(app, path, r => r.state.started === 2);
  const result = await until(app, path, r => r.status === 'idle');
  assert.equal(result.state.finished, 2);
});
test('Pause preserves state and uses edits when the next node is reached', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.value=42;node.display("before delay");await node.sleep(80);'
  );
  const second = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.seen="before edit";'),
  });
  await flow(app, project.id, {}, [node.id, second.id]);
  await app.api('POST', path);
  await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping'));
  await app.api('POST', path + '/pause');
  await sleep(100);
  await change(app, project, second, 'context.state.seen=context.state.value+1;node.display(context.state.seen);');
  const paused = await app.api('GET', path);
  assert.equal(paused.state.value, 42);
  assert.equal(paused.displays[node.id], 'before delay');
  assert.equal(paused.state.seen, undefined);
  await app.api('POST', path + '/resume');
  const result = await until(app, path, r => r.status === 'idle');
  assert.equal(result.state.seen, 43);
  assert.equal(app.workerStats.started, 1);
});
test('rewiring during an active delay changes the following completion signal', async t => {
  const {app, project, node, path} = await fixture(t, 'await node.sleep(80);');
  const make = code =>
    app.api('POST', `projects/${project.id}/typed-nodes`, {node_type: 'custom', config: nodes.script(code)});
  const first = await make('context.state.first=true;'),
    second = await make('context.state.second=true;');
  await flow(app, project.id, {}, [node.id, first.id]);
  await app.api('POST', path);
  await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping'));
  await app.api('POST', path + '/pause');
  const graph = await app.api('GET', `projects/${project.id}/workflow`),
    edge = graph.edges.find(e => e.source === node.id);
  await app.api('POST', `projects/${project.id}/port-connections`, {
    remove: [edge],
    add: [{source: node.id, source_port: 'out', target: second.id, target_port: 'in'}],
  });
  await app.api('POST', path + '/resume');
  const result = await until(app, path, r => r.status === 'idle');
  assert.equal(result.state.first, undefined);
  assert.equal(result.state.second, true);
});
test('durable JSON, output values and previews survive Stop and backend restart', async t => {
  const data = new Map(),
    store = {
      get: key => structuredClone(data.get(key)),
      commit: ({set, remove}) => {
        for (const [key, value] of Object.entries(set)) data.set(key, structuredClone(value));
        for (const key of remove) data.delete(key);
      },
    };
  const {app, project, path} = await fixture(t, '', {store});
  const writer = await fn(
    app,
    project.id,
    {},
    {
      code: 'context.state.nested??={items:[]};context.state.nested.items.push(42);node.output.value=42;node.display("saved");',
      outputs: ['value'],
    }
  );
  await app.api('POST', path, {node_ids: [writer.id], wait: true});
  await app.api('DELETE', path);
  const reopened = createApp({scripts: 'worker', store});
  t.after(() => reopened.Backend.shutdownExecutions());
  const restored = await reopened.api('GET', path);
  assert.deepEqual(restored.state, {nested: {items: [42]}});
  assert.equal(restored.outputs[writer.wrapper].value, 42);
  assert.equal(restored.displays[writer.id], 'saved');
  await reopened.api('POST', path, {node_ids: [writer.id], wait: true});
  assert.deepEqual((await reopened.api('GET', path)).state.nested.items, [42, 42]);
});
test('Stop interrupts synchronous infinite code while retaining acknowledged state', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.started=true;while(true){}');
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, r => r.state.started === true);
  await app.api('DELETE', path);
  assert.equal((await app.api('GET', path)).status, 'idle');
  await change(app, project, node, 'node.display(context.state.started);');
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.displays[node.id], 'true');
});
test('the graph accepts more than sixteen asynchronous Script bodies together', async t => {
  const {app, project, path} = await fixture(t, '');
  const ids = [];
  for (let i = 0; i < 24; i++)
    ids.push(
      (
        await app.api('POST', `projects/${project.id}/typed-nodes`, {
          node_type: 'custom',
          config: nodes.script(
            'context.state.started=(context.state.started??0)+1;await new Promise(resolve=>setTimeout(resolve,100));'
          ),
        })
      ).id
    );
  await app.api('POST', path, {node_ids: ids});
  await until(app, path, r => r.state.started === 24);
  await until(app, path, r => r.status === 'idle');
});
test('new signals queued while paused start after Resume without clearing state', async t => {
  const {app, node, path} = await fixture(t, 'context.state.count=(context.state.count??0)+1;');
  await app.api('POST', path + '/pause');
  await app.api('POST', path, {node_ids: [node.id]});
  assert.equal((await app.api('GET', path)).state.count, undefined);
  await app.api('POST', path + '/resume');
  assert.equal((await until(app, path, r => r.status === 'idle')).state.count, 1);
});
test('JSON context rejects functions and keeps its previous value', async t => {
  const {app, node, path} = await fixture(
    t,
    'context.state.value=42;try{context.state.value=()=>1;}catch(error){node.display(error.message);}'
  );
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.state.value, 42);
  assert.match(result.displays[node.id], /JSON/);
});

test('export, import and duplication carry graph JSON state and remap node values', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.nodes=[{id:"z"},{id:"a"}];context.state.marker={$script:"literal data"};node.display("stored");'
  );
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  const packet = await app.api('GET', `projects/${project.id}/workflows/${project.id}/export`);
  const imported = await app.api('POST', `projects/${project.id}/workflows/import`, packet);
  const restored = await app.api('GET', path, {}, {workflow_id: imported.id});
  assert.deepEqual(restored.state.nodes, [{id: 'z'}, {id: 'a'}]);
  assert.deepEqual(restored.state.marker, {$script: 'literal data'});
  assert.equal(restored.displays[node.id], 'stored');
  const copied = await app.api('POST', `projects/${project.id}/workflows/${project.id}/duplicate`);
  const copy = await app.api('GET', path, {}, {workflow_id: copied.id});
  assert.deepEqual(copy.state, restored.state);
  assert.deepEqual(Object.values(copy.displays), ['stored']);
  assert.equal(copy.displays[node.id], undefined);
});

test('a paused editor event does not block events in another workflow', async t => {
  const {app, project, path} = await fixture(t, '');
  await app.api('POST', path + '/pause');
  const hook = bundleOf(
    'Placement context',
    {E: nodes.event('on_placed'), S: nodes.script('context.state.placed=true;')},
    {wires: [['E', 'out', 'S', 'in']]}
  );
  const first = await place(app, project.id, {}, hook);
  const other = await app.api('POST', 'projects', {name: 'Other live graph'});
  await app.api('POST', `projects/${other.id}/custom-nodes/${first.resource}`, {point: {x: 0, y: 0}});
  await until(app, `projects/${other.id}/execution`, value => value.state.placed === true);
  assert.equal((await app.api('GET', path)).state.placed, undefined);
  await app.api('POST', path + '/resume');
  await app.Backend.hooksIdle();
  assert.equal((await app.api('GET', path)).state.placed, true);
});

test('an old node error does not mark a later successful editor event as failed', async t => {
  const {app, project, node, path} = await fixture(t, 'throw Error("Earlier failure");');
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  await place(
    app,
    project.id,
    {},
    bundleOf(
      'Successful placement',
      {E: nodes.event('on_placed'), S: nodes.script('context.state.placed=true;')},
      {wires: [['E', 'out', 'S', 'in']]}
    )
  );
  await app.Backend.hooksIdle();
  assert.equal((await app.api('GET', path)).state.placed, true);
  assert.ok((await app.api('GET', path)).errors[node.id]);
  assert.ok((await app.api('GET', 'node-hooks')).every(event => event.ok));
});

module.exports = {until};
