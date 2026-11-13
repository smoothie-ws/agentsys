'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const http = require('node:http');
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
for (const parallel of [false, true])
  test(`starting upstream clears old downstream states${parallel ? ' through a cycle while preserving active work' : ''}`, async t => {
    const {app, project, node, path} = await fixture(t, 'node.display("first");');
    const make = code =>
      app.api('POST', `projects/${project.id}/typed-nodes`, {
        node_type: 'custom',
        config: nodes.script(code),
      });
    const second = await make('node.display("second");'),
      last = await make(`node.display("last");${parallel ? 'throw Error("old failure");' : ''}`),
      unrelated = await make('node.display("unrelated");');
    await flow(app, project.id, {}, [node.id, second.id, last.id]);
    const previous = await app.api('POST', path, {node_ids: [node.id, unrelated.id], wait: true});
    assert.equal(previous.nodes.find(n => n.node_id === last.id)?.status, parallel ? 'failed' : 'completed');
    await change(app, project, node, 'await node.sleep(500);node.flow.cancel();');
    if (parallel) {
      await app.api('POST', `projects/${project.id}/port-connections`, {
        add: [{source: last.id, source_port: 'out', target: node.id, target_port: 'in'}],
      });
      await change(app, project, second, 'await node.sleep(500);node.flow.cancel();');
      await app.api('POST', path, {node_ids: [second.id]});
      await until(app, path, r => r.nodes.some(n => n.node_id === second.id && n.status === 'sleeping'));
    }
    await app.api('POST', path, {node_ids: [node.id]});
    const detail = await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping')),
      status = id => detail.nodes.find(n => n.node_id === id)?.status;
    assert.equal(status(second.id), parallel ? 'sleeping' : 'ready');
    assert.equal(status(last.id), 'ready');
    assert.equal(status(unrelated.id), 'completed');
    assert.equal(detail.displays[last.id], 'last');
    assert.equal(detail.runs[last.id], 1);
    await until(app, path, r => r.status === 'idle');
  });
test('flow.abort cancels its owning dispatch without cancelling an unrelated concurrent dispatch', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.otherStarted=true;await node.sleep(80);context.state.otherFinished=true;'
  );
  const abort = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('node.flow.abort();'),
  });
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, state => state.state.otherStarted);
  const aborted = await app.api('POST', path, {node_ids: [abort.id], wait: true});
  assert.equal(aborted.dispatch_status, 'cancelled');
  await until(app, path, runtime => runtime.state.otherFinished);
});
test('flow.abort also cancels continuations of other roots in its own dispatch', async t => {
  const {app, project, node, path} = await fixture(t, 'await node.sleep(80);context.state.shouldNotFinish=true;');
  const abort = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('await node.sleep(10);node.flow.abort();'),
  });
  const stopped = await app.api('POST', path, {node_ids: [node.id, abort.id], wait: true});
  assert.equal(stopped.dispatch_status, 'cancelled');
  assert.equal(stopped.state.shouldNotFinish, undefined);
  await change(app, project, node, 'context.state.fresh=true;');
  const next = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(next.dispatch_status, 'completed');
  assert.equal(next.state.fresh, true);
});

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

test('graph export omits runtime; workflow duplication keeps state and remaps node values', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.nodes=[{id:"z"},{id:"a"}];context.state.marker={$script:"literal data"};node.display("stored");'
  );
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  const packet = await app.api('GET', `projects/${project.id}/workflows/${project.id}/export`);
  const imported = await app.api('POST', `projects/${project.id}/workflows/import`, packet);
  const restored = await app.api('GET', path, {}, {workflow_id: imported.id});
  assert.deepEqual(restored.state, {});
  assert.deepEqual(restored.displays, {});
  const copied = await app.api('POST', `projects/${project.id}/workflows/${project.id}/duplicate`);
  const copy = await app.api('GET', path, {}, {workflow_id: copied.id});
  assert.deepEqual(copy.state.nodes, [{id: 'z'}, {id: 'a'}]);
  assert.deepEqual(copy.state.marker, {$script: 'literal data'});
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

test('a successful dispatch clears the host error of an earlier failure', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.ok=true;');
  await app.api('GET', path);
  // The entry records a host failure exactly as a crashed dispatch does.
  app.eval(`GRAPH_RUNTIMES.get('${project.id}').errors.host='the script host stopped'`);
  assert.equal((await app.api('GET', path)).errors.host, 'the script host stopped');
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.dispatch_status, 'completed');
  assert.equal((await app.api('GET', path)).errors.host, undefined);
});
test('node_ids naming a group is rejected; nodes and Custom Nodes still run', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.ran=true;');
  await app.api('PUT', `projects/${project.id}/groups`, {
    groups: [{id: 'g1', name: 'Group', members: [node.id]}],
  });
  const badRoot = app.api('POST', path, {node_ids: ['group:g1'], wait: true});
  await assert.rejects(badRoot, error => error.status === 400 && error.code === 'invalid_request');
  await assert.rejects(
    app.api('POST', `projects/${project.id}/evaluate-node`, {node_ids: ['group:g1'], collect: true}),
    error => error.status === 400 && error.code === 'invalid_request'
  );
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.dispatch_status, 'completed');
  assert.equal(result.state.ran, true);
});
test('deleting a node during an await prevents late state mutations', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.started=true;await new Promise(resolve=>setTimeout(resolve,100));try{context.state.late=true;}catch{}'
  );
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, r => r.state.started);
  await app.api('POST', `projects/${project.id}/delete-nodes`, {node_ids: [node.id]});
  await until(app, path, r => r.status === 'idle');
  assert.equal((await app.api('GET', path)).state.late, undefined);
});
test('Stop cancels a real checked network request and the next Run gets a clean host', async t => {
  let receivedResolve;
  const received = new Promise(resolve => (receivedResolve = resolve));
  const server = http.createServer((req, res) => {
    receivedResolve();
    req.on('close', () => res.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const {app, project, node, path} = await fixture(
    t,
    `await agentsys('POST','net',{url:'http://127.0.0.1:${server.address().port}'});context.state.late=true;`
  );
  await app.api('POST', path, {node_ids: [node.id]});
  await received;
  await app.api('DELETE', path);
  assert.equal((await app.api('GET', path)).state.late, undefined);
  await change(app, project, node, 'context.state.fresh=true;');
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.state.fresh, true);
  assert.equal(app.workerStats.started, 2);
});
test('Stop of a Script that runs another workflow stops that workflow too', async t => {
  const {app, project, node, path} = await fixture(t, '');
  const other = await app.api('POST', 'projects', {name: 'Child workflow'}),
    otherPath = `projects/${other.id}/execution`;
  const child = await app.api('POST', `projects/${other.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('await node.sleep(1000);context.state.unwanted=true;'),
  });
  await change(
    app,
    project,
    node,
    `await agentsys('POST','projects/${other.id}/execution',{node_ids:['${child.id}'],wait:true});`
  );
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, otherPath, r => r.nodes.some(n => n.node_id === child.id && n.status === 'sleeping'));
  await app.api('DELETE', path);
  await until(app, otherPath, r => r.status === 'idle');
  assert.equal((await app.api('GET', otherPath)).state.unwanted, undefined);
});

for (const group of [false, true])
  test(`deleting a Library ${group ? 'group' : 'node'} releases its editor runtime and history`, async t => {
    const app = createApp({scripts: 'worker'});
    t.after(() => app.Backend.shutdownExecutions());
    const opened = await app.api('POST', 'library/node-editor', {folder: 'Disposable'});
    const id = opened.project_id;
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      node_type: 'custom',
      config: nodes.script('await node.sleep(10000);'),
    });
    await app.api('POST', `projects/${id}/execution`, {node_ids: [script.id]});
    await until(app, `projects/${id}/execution`, detail => detail.nodes.some(n => n.status === 'sleeping'));
    assert.equal(app.eval(`GRAPH_RUNTIMES.has('${id}')`), true);
    assert.equal(app.eval(`histories.has('${id}')`), true);
    if (group) await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Disposable'});
    else await app.api('DELETE', `resources/${opened.resource_id}`);
    assert.equal(app.eval(`GRAPH_RUNTIMES.has('${id}')`), false);
    assert.equal(app.workerStats.terminated, 1);
    assert.equal(app.eval(`histories.has('${id}')`), false);
    assert.equal(await app.eval(`DB.get('wf:${id}')`), undefined);
    assert.equal(await app.eval(`DB.get(runtimeKey('${id}'))`), undefined);
  });

test('an idle runtime is evicted after its TTL and rebuilt from saved data', async t => {
  const {app, project, path} = await fixture(t, '');
  const writer = await fn(app, project.id, {}, {
    code: 'context.state.count=(context.state.count??0)+1;node.output.value=42;node.display("saved");',
    outputs: ['value'],
  });
  assert.equal((await app.api('POST', path, {node_ids: [writer.id], wait: true})).dispatch_status, 'completed');
  app.eval('RUNTIME_TTL_MS = 1');
  t.after(() => app.eval('RUNTIME_TTL_MS = 600000'));
  await sleep(10);
  // Any later runtime lookup sweeps: the idle workflow is released.
  const other = await app.api('POST', 'projects', {name: 'Eviction trigger'});
  await app.api('GET', `projects/${other.id}/execution`);
  assert.equal(app.eval(`GRAPH_RUNTIMES.has('${project.id}')`), false);
  // The next read builds it again from the store: values, outputs and previews are intact.
  const restored = await app.api('GET', path);
  assert.equal(restored.state.count, 1);
  assert.equal(restored.outputs[writer.wrapper].value, 42);
  assert.equal(restored.displays[writer.id], 'saved');
  assert.equal(restored.status, 'idle');
});

test('a paused runtime is never evicted', async t => {
  const {app, project, path} = await fixture(t, '');
  await app.api('POST', path + '/pause');
  app.eval('RUNTIME_TTL_MS = 1');
  t.after(() => app.eval('RUNTIME_TTL_MS = 600000'));
  await sleep(10);
  const other = await app.api('POST', 'projects', {name: 'Eviction trigger'});
  await app.api('GET', `projects/${other.id}/execution`);
  assert.equal(app.eval(`GRAPH_RUNTIMES.has('${project.id}')`), true);
  assert.equal((await app.api('GET', path)).paused, true);
});

test('at most sixteen idle runtimes stay live, least recently used go first', async t => {
  const app = createApp();
  t.after(() => app.Backend.shutdownExecutions());
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const project = await app.api('POST', 'projects', {name: 'Visited ' + i});
    ids.push(project.id);
    await app.api('GET', `projects/${project.id}/execution`);
  }
  assert.equal(app.eval('GRAPH_RUNTIMES.size'), 16);
  assert.equal(app.eval(`GRAPH_RUNTIMES.has('${ids[19]}')`), true);
  // Opening the first again rebuilds it from its stored (empty) runtime.
  assert.equal((await app.api('GET', `projects/${ids[0]}/execution`)).status, 'idle');
  assert.equal(app.eval('GRAPH_RUNTIMES.size'), 16);
});

test('a failed runtime write is reported and kept for the next successful write', async t => {
  const data = new Map();
  let fail = true,
    runtime = null;
  const store = {
    get: key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    commit: ({set, remove}) => {
      for (const [key, value] of Object.entries(set)) {
        if (fail && key.endsWith('/runtime')) throw Error('disk full');
        data.set(key, structuredClone(value));
        if (key.endsWith('/runtime')) runtime = value;
      }
      for (const key of remove) data.delete(key);
    },
  };
  const {app, node, path} = await fixture(t, 'context.state.saved=1;', {store});
  const first = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(first.dispatch_status, 'completed');
  assert.equal(first.storage_error, 'disk full');
  assert.equal(runtime, null);
  // The same state is still current: the next save writes it instead of skipping it as clean.
  fail = false;
  const second = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(second.storage_error, undefined);
  assert.equal(runtime.state.saved, 1);
});

test('shutdown waits for the runtime of a fire-and-forget Run to be saved', async t => {
  const data = new Map();
  const store = {
    get: key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    commit: async ({set, remove}) => {
      await sleep(80);
      for (const [key, value] of Object.entries(set)) data.set(key, structuredClone(value));
      for (const key of remove) data.delete(key);
    },
  };
  const app = createApp({store});
  const project = await app.api('POST', 'projects', {name: 'Slow store'});
  const node = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.saved=true;'),
  });
  const path = `projects/${project.id}/execution`;
  await app.api('POST', path, {node_ids: [node.id]});
  for (let i = 0; i < 100 && !app.eval(`GRAPH_RUNTIMES.get('${project.id}')?.state.saved`); i++) await sleep(5);
  assert.equal(app.eval(`GRAPH_RUNTIMES.get('${project.id}')?.state.saved`), true);
  await app.Backend.shutdownExecutions();
  assert.equal([...data.keys()].some(key => key.endsWith('/runtime')), true);
  assert.equal([...data.entries()].find(([key]) => key.endsWith('/runtime'))[1].state.saved, true);
});

test('twenty parallel Runs with Stop in the middle settle without unhandled rejections', async t => {
  const rejections = [];
  const listener = reason => rejections.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const {app, node, path} = await fixture(
    t,
    'context.state.started=(context.state.started??0)+1;await node.sleep(40);context.state.finished=(context.state.finished??0)+1;'
  );
  const runs = Array.from({length: 20}, () => app.api('POST', path, {node_ids: [node.id]}).catch(() => {}));
  await sleep(10);
  await app.api('DELETE', path);
  await Promise.all(runs);
  const idle = await until(app, path, runtime => runtime.status === 'idle');
  assert.equal(idle.active_signals, 0);
  await sleep(120);
  assert.deepEqual(rejections, []);
});

test('Stop terminates the workflow worker and a later Run starts exactly one new worker', async t => {
  const {app, node, path} = await fixture(t, 'context.state.n=(context.state.n??0)+1;');
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(app.workerStats.started, 1);
  await app.api('DELETE', path);
  await sleep(30);
  assert.equal(app.workerStats.terminated, 1);
  assert.equal(app.workerStats.started - app.workerStats.exited, 0);
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(app.workerStats.started, 2);
});
