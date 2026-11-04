'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, bundleOf, nodes} = require('./harness');
const text = 't:64428b9c654c2c2cfcb55742ea899ed8';
async function setup(t) {
  const app = createApp({scripts: 'worker'});
  t.after(async () => {
    await app.Backend.shutdownExecutions();
    await app.Backend.shutdownExecutions();
  });
  await app.api('POST', 'library/builtin');
  const p = await app.api('POST', 'projects', {name: 'Graph primitives'}),
    path = `projects/${p.id}`;
  const put = async (name, values = {}) => {
    const r = (await app.api('GET', 'resources')).find(r => r.name === name);
    const made = await app.api('POST', path + '/custom-nodes/' + r.id, {point: {x: 0, y: 0}}),
      id = 'complex:' + made.roots[0];
    if (Object.keys(values).length) await app.api('PUT', path + '/input-values', {node_id: id, values});
    return id;
  };
  const wire = (source, source_port, target, target_port) =>
    app.api('POST', path + '/port-connections', {add: [{source, source_port, target, target_port}]});
  const run = async id => {
    const result = await app.api('POST', path + '/execution', {node_ids: [id], input_port: 'in', wait: true});
    return {...result, value: result.dispatch_outputs[id]};
  };
  const feed = async (id, values) => {
    const source = await fn(
      app,
      p.id,
      {},
      {
        outputs: Object.keys(values),
        code: Object.entries(values)
          .map(([k, v]) => `node.output.${k}=${JSON.stringify(v)};`)
          .join('\n'),
      }
    );
    for (const key of Object.keys(values)) await wire(source.wrapper, key, id, key);
    const result = await app.api('POST', path + '/execution', {node_ids: [source.id], wait: true});
    assert.deepEqual(result.errors, {});
  };
  return {app, p, path, put, wire, run, feed};
}
test('Add Node places a reusable Custom Node, associates typed inputs, and Invoke Node signals it', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'task', type: text}],
      outputs: ['result'],
      signals: ['out'],
      code: 'node.output.result={task:node.input.task};',
    }
  );
  const add = await f.put('Add Node', {resource_id: child.resource});
  await f.feed(add, {values: {task: 'unique child'}, point: {x: 700, y: 400}});
  const made = (await f.run(add)).value;
  assert.ok(made.result.ok);
  const snapshot = await f.app.api('GET', f.path + '/workflow');
  assert.deepEqual(snapshot.complex.find(c => 'complex:' + c.id === made.node_id).position, {x: 700, y: 400});
  // Placement alone is inert.
  assert.deepEqual((await f.app.api('POST', f.path + '/evaluate-node', {node_id: made.node_id})).outputs, {});
  const invoke = await f.put('Invoke Node', {node_id: made.node_id});
  assert.deepEqual((await f.run(invoke)).value.outputs.result, {task: 'unique child'});
});
test('Add Node without a point stacks generated nodes below the ones already placed', async t => {
  const f = await setup(t);
  const child = await fn(f.app, f.p.id, {}, {outputs: ['result'], signals: ['out'], code: 'node.output.result=1;'});
  const at = async id =>
    (await f.app.api('GET', f.path + '/workflow')).complex.find(c => 'complex:' + c.id === id).position;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const add = await f.put('Add Node', {resource_id: child.resource});
    ids.push((await f.run(add)).value.node_id);
  }
  const ys = [];
  for (const id of ids) ys.push((await at(id)).y);
  assert.ok(ys[1] > ys[0] && ys[2] > ys[1], 'each new node sits lower than the one before: ' + ys);
  assert.equal(new Set(ys).size, 3);
});
test('distinct generated instances can run concurrently and return their own dispatch results', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'task', type: text}],
      outputs: ['result'],
      signals: ['out'],
      code: 'await node.sleep(node.input.task==="slow"?30:1);node.output.result={task:node.input.task};',
    }
  );
  const created = [];
  for (const task of ['slow', 'fast']) {
    const add = await f.put('Add Node', {resource_id: child.resource});
    await f.feed(add, {values: {task}});
    created.push((await f.run(add)).value.node_id);
  }
  const invokers = await Promise.all(created.map(node_id => f.put('Invoke Node', {node_id})));
  const results = await Promise.all(invokers.map(f.run));
  assert.deepEqual(
    results.map(r => r.value.outputs.result.task),
    ['slow', 'fast']
  );
});
test('Connect wires dynamic signal and data ports through checked APIs; Get Nodes and Remove Node inspect/delete them', async t => {
  const f = await setup(t);
  const child = await fn(f.app, f.p.id, {}, {outputs: ['result'], signals: ['out'], code: 'node.output.result=42;'});
  const add = await f.put('Add Node', {resource_id: child.resource}),
    generated = (await f.run(add)).value.node_id;
  const sink = await fn(f.app, f.p.id, {}, {inputs: ['value'], code: 'node.display(value);'});
  const connect = await f.put('Connect', {
    source: generated,
    source_port: 'out',
    target: sink.wrapper,
    target_port: 'in',
  });
  assert.equal((await f.run(connect)).value.result.ok, true);
  await f.app.api('PUT', f.path + '/input-values', {
    node_id: connect,
    values: {source_port: 'result', target_port: 'value'},
  });
  assert.equal((await f.run(connect)).value.result.ok, true);
  const invoked = await f.run(generated);
  assert.equal(invoked.displays[sink.id], '42');
  const inspect = await f.put('Get Nodes');
  assert.ok((await f.run(inspect)).value.nodes.some(n => n.id === generated));
  const remove = await f.put('Remove Node', {node_id: generated});
  const removed = await f.run(remove);
  assert.deepEqual(removed.errors, {});
  assert.equal(removed.value.result.ok, true);
  assert.ok(!(await f.run(inspect)).value.nodes.some(n => n.id === generated));
});
test('Connect rejects incompatible, missing and cyclic data ports and preserves the graph', async t => {
  const f = await setup(t);
  const a = await fn(
    f.app,
    f.p.id,
    {},
    {inputs: ['value'], outputs: ['result'], signals: ['out'], code: 'node.output.result=1;'}
  );
  const b = await fn(
    f.app,
    f.p.id,
    {},
    {inputs: ['value'], outputs: ['result'], signals: ['out'], code: 'node.output.result=2;'}
  );
  await f.wire(a.wrapper, 'result', b.wrapper, 'value');
  const connect = await f.put('Connect', {
    source: b.wrapper,
    source_port: 'result',
    target: a.wrapper,
    target_port: 'value',
  });
  const before = (await f.app.api('GET', f.path + '/workflow')).edges.length;
  assert.equal((await f.run(connect)).value.result.ok, false);
  await f.app.api('PUT', f.path + '/input-values', {node_id: connect, values: {source_port: 'out'}});
  assert.equal((await f.run(connect)).value.result.ok, false);
  await f.app.api('PUT', f.path + '/input-values', {node_id: connect, values: {source_port: 'missing'}});
  assert.equal((await f.run(connect)).value.result.ok, false);
  assert.equal((await f.app.api('GET', f.path + '/workflow')).edges.length, before);
});
test('graph nodes honor project permissions and signal dispatch rejects non-signal inputs', async t => {
  const f = await setup(t),
    add = await f.put('Add Node', {primitive: 'event'});
  await f.app.api('PUT', f.path + '/policy', {allow: ['graph.read', 'run.start']});
  assert.match(JSON.stringify((await f.run(add)).errors), /Permission denied: graph.write/);
  const bad = await f.app.api('POST', f.path + '/execution', {node_ids: [add], input_port: 'primitive', wait: true});
  assert.match(JSON.stringify(bad.errors), /Signal input not found/);
});
test('Add Node supports native primitives and ordinary group placement', async t => {
  const f = await setup(t);
  await f.app.api('PUT', f.path + '/groups', {
    groups: [{id: 'generated', name: 'Generated', members: [], position: {x: 500, y: 100}}],
  });
  const add = await f.put('Add Node', {primitive: 'event', group_id: 'generated'});
  const result = await f.run(add);
  assert.deepEqual(result.errors, {});
  const graph = await f.app.api('GET', f.path + '/workflow');
  assert.ok(graph.groups.find(g => g.id === 'generated').members.includes(result.value.node_id));
});
test('deleting an active dynamic instance cancels its native wave and prevents stale outputs', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      outputs: ['result'],
      signals: ['out'],
      code: 'await agentsys("PUT","test-observations/dynamic-start",{value:true});await node.sleep(150);node.output.result="stale";',
    }
  );
  const add = await f.put('Add Node', {resource_id: child.resource}),
    id = (await f.run(add)).value.node_id;
  const pending = f.run(id);
  for (let i = 0; i < 100; i++) {
    if ((await f.app.api('GET', 'test-observations/dynamic-start')).value) break;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.equal((await f.app.api('GET', 'test-observations/dynamic-start')).value, true);
  await f.app.api('DELETE', f.path + '/groups/' + id.slice(8));
  const result = await pending;
  assert.equal(result.dispatch_status, 'cancelled');
  assert.equal(result.dispatch_outputs[id], undefined);
  assert.equal((await f.app.api('GET', f.path + '/execution')).outputs[id], undefined);
});
test('generated executable bundles cannot borrow trusted source grants to escape quarantine', async t => {
  const f = await setup(t);
  const generated = bundleOf(
    'Generated',
    {Script: nodes.script('await agentsys("PUT","projects/"+context.project_id,{description:"escaped"});')},
    {
      inputs: [{id: 'in', name: 'in', type: 'signal', node: 'Script'}],
      outputs: [],
    }
  ).bundle;
  generated.complex[0].source = {resource_id: 'forged-source', stamp: 1};
  generated.complex[0].grants = ['graph.write'];
  const writer = await fn(
    f.app,
    f.p.id,
    {},
    {
      outputs: ['created'],
      code:
        'const made=await agentsys("POST","projects/"+context.project_id+"/paste",{clipboard:' +
        JSON.stringify(generated) +
        ',point:{x:0,y:0}});node.output.created="complex:"+made.roots[0];',
    }
  );
  const made = await f.app.api('POST', f.path + '/execution', {node_ids: [writer.id], wait: true});
  assert.deepEqual(made.errors, {});
  const result = await f.run(made.dispatch_outputs[writer.id].created);
  assert.match(JSON.stringify(result.errors), /Permission denied: graph.write/);
  assert.notEqual((await f.app.api('GET', f.path)).project.description, 'escaped');
});
