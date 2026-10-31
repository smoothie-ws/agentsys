'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const {createApp, nodes, flow, fn, place, bundleOf} = require('./harness');
const {createOperationRunner} = require('../sdk/operations');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(app, path, predicate) {
  for (let i = 0; i < 300; i++) {
    const value = await app.api('GET', path);
    if (predicate(value)) return value;
    await sleep(10);
  }
  assert.fail('Expected execution state was not reached');
}
async function setup(t, code = '', store = null) {
  const app = createApp({scripts: 'worker', store}),
    project = await app.api('POST', 'projects', {name: 'Durable'});
  t.after(() => app.Backend.shutdownExecutions());
  const node = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script(code),
  });
  return {app, project, node, path: `projects/${project.id}/execution`};
}
function memoryStore() {
  const data = new Map();
  return {
    data,
    fail: false,
    get: key => structuredClone(data.get(key)),
    commit({set, remove}) {
      if (this.fail) throw Error('Disk unavailable');
      for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
      for (const k of remove) data.delete(k);
    },
    compareAndSet(key, version, value) {
      if (this.fail) throw Error('Disk unavailable');
      if ((data.get(key)?.version ?? 0) !== version) throw Object.assign(Error('Conflict'), {code: 'conflict'});
      data.set(key, structuredClone(value));
    },
  };
}
test('parallel dispatches have independent identities, isolated JSON areas and invocation ancestry', async t => {
  const {app, project, node, path} = await setup(
    t,
    `
    const path='projects/'+context.project_id+'/execution/scopes/'+context.execution.run_id;
    await node.sleep(context.event.payload.delay);
    await agentsys('PUT',path,{version:0,value:{result:context.event.payload.value,identity:context.execution}});
  `
  );
  const child = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('node.display(context.execution);'),
  });
  await app.api('POST', `projects/${project.id}/port-connections`, {
    add: [{source: node.id, source_port: 'out', target: child.id, target_port: 'in'}],
  });
  const results = await Promise.all(
    [30, 5].map(delay => app.api('POST', path, {node_ids: [node.id], payload: {delay, value: delay}, wait: true}))
  );
  assert.notEqual(results[0].run_id, results[1].run_id);
  for (const result of results) {
    assert.equal(result.dispatch_status, 'completed');
    const area = await app.api('GET', `${path}/scopes/${result.run_id}`);
    assert.equal(area.value.identity.dispatch_id, result.dispatch_id);
    const trace = await app.api('GET', `${path}/trace`, {}, {dispatch_id: result.dispatch_id});
    const starts = trace.events.filter(e => e.type === 'invocation.start');
    assert.equal(starts.length, 2);
    assert.equal(starts[1].parent_invocation_id, starts[0].invocation_id);
    assert.equal(new Set(starts.map(e => e.invocation_id)).size, 2);
    assert.ok(trace.events.some(e => e.type === 'wait.start'));
    assert.ok(trace.events.every(e => e.dispatch_id === result.dispatch_id && e.graph_revision));
  }
});
test('CAS detects concurrent writes and deletion/recreation cannot reuse an old area version', async t => {
  const {app, path} = await setup(t),
    key = path + '/scopes/shared';
  const outcomes = await Promise.allSettled([1, 2].map(value => app.api('PUT', key, {version: 0, value})));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'conflict');
  await app.api('DELETE', key, {}, {version: 1});
  await assert.rejects(app.api('PUT', key, {version: 0, value: 3}), {code: 'conflict'});
  const missing = await app.api('GET', key);
  assert.equal(missing.deleted, true);
  assert.equal(missing.version, 2);
  await app.api('PUT', key, {version: 2, value: 3});
  assert.equal((await app.api('GET', key)).version, 3);
});
test('temporary cleanup preserves user areas and shared workflow state', async t => {
  const {app, node, path} = await setup(t, 'context.state.saved=42;');
  const dispatch = await app.api('POST', path, {node_ids: [node.id], wait: true});
  await app.api('PUT', path + '/scopes/user', {version: 0, value: {saved: 1}});
  await app.api('PUT', path + '/scopes/temp', {
    version: 0,
    value: {saved: 2},
    temporary: true,
    run_id: dispatch.run_id,
  });
  assert.equal((await app.api('DELETE', path + '/scopes', {}, {run_id: dispatch.run_id})).removed, 1);
  assert.equal((await app.api('GET', path + '/scopes/user')).value.saved, 1);
  assert.equal((await app.api('GET', path)).state.saved, 42);
});
test('default host background callbacks retain checked JSON behavior until Stop', async t => {
  const {app, node, path} = await setup(
    t,
    `
    setTimeout(async()=>{
      context.state.background=42;
      await agentsys('PUT','projects/'+context.project_id+'/execution/scopes/toString',{
        version:0,value:{op:'script',grants:['run.start'],token:'user-data',headers:{ordinary:'data'}}
      });
    },50);
  `
  );
  const dispatch = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(dispatch.dispatch_status, 'completed');
  await until(app, path, r => r.state.background === 42);
  const area = await until(app, path + '/scopes/toString', r => !r.deleted);
  assert.deepEqual(area.value, {op: 'script', grants: ['run.start'], token: 'user-data', headers: {ordinary: 'data'}});
});
test('live edits are reflected in subsequent invocation and signal graph revisions', async t => {
  const {app, project, node, path} = await setup(t, 'await node.sleep(100);');
  const next = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.result=1;'),
  });
  await flow(app, project.id, {}, [node.id, next.id]);
  const dispatch = await app.api('POST', path);
  await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping'));
  await app.api('PUT', `projects/${project.id}/typed-nodes/${next.id}`, {
    node_type: 'custom',
    config: nodes.script('context.state.result=42;'),
  });
  await until(app, path, r => r.status === 'idle');
  const trace = await app.api('GET', path + '/trace', {}, {dispatch_id: dispatch.dispatch_id});
  const before = trace.events.find(e => e.type === 'invocation.start' && e.node_id === node.id),
    after = trace.events.find(e => e.type === 'invocation.start' && e.node_id === next.id);
  assert.notEqual(before.graph_revision, after.graph_revision);
  assert.equal(
    trace.events.find(e => e.type === 'signal.sent' && e.node_id === node.id).graph_revision,
    after.graph_revision
  );
  assert.equal((await app.api('GET', path)).state.result, 42);
});
test('nested checked evaluation inherits its caller run, dispatch, invocation and budget', async t => {
  const {app, project, node, path} = await setup(t);
  const child = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('node.display(context.execution);'),
  });
  const config = nodes.script(`await agentsys('POST','projects/${project.id}/evaluate-node',{node_id:'${child.id}'});`);
  await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {node_type: 'custom', config});
  const result = await app.api('POST', path, {
    node_ids: [node.id],
    wait: true,
    policy: {max_dispatches: 2, max_invocations: 5},
  });
  assert.equal(result.dispatch_status, 'completed');
  const childIdentity = JSON.parse((await app.api('GET', path)).displays[child.id]);
  assert.equal(childIdentity.run_id, result.run_id);
  assert.equal(childIdentity.parent_dispatch_id, result.dispatch_id);
  assert.ok(childIdentity.parent_invocation_id);
  assert.equal(childIdentity.policy.max_dispatches, 2);
  const limited = await app.api('POST', path, {node_ids: [node.id], wait: true, policy: {max_dispatches: 1}});
  assert.equal(limited.dispatch_status, 'budget_exceeded');
});
test('real plugin Workers preserve nested ancestry and propagate parent Stop across workflows', async t => {
  const {app, project, node, path} = await setup(t);
  t.after(() => app.Backend.shutdownPlugins());
  const other = await app.api('POST', 'projects', {name: 'Child workflow'}),
    otherPath = `projects/${other.id}/execution`;
  const child = await app.api('POST', `projects/${other.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script(
      'node.display(context.execution);context.state.started=true;await node.sleep(context.event.payload.delay);context.state.late=true;'
    ),
  });
  await app.api('POST', 'plugins', {
    enable: true,
    grants: ['run.start'],
    package: {
      format: 'agentsys.plugin/2',
      manifest: {
        id: 'durable-bridge',
        name: 'Durable bridge',
        version: '1.0.0',
        engine: '>=2',
        main: 'main.js',
        permissions: ['run.start'],
      },
      files: {
        'main.js': `
    exports.activate=({app})=>app.endpoints.register('child',({body})=>app.workflows.run(body.project,body.project,{node_ids:[body.node],payload:{delay:body.delay},wait:true}),{permissions:['run.start']});
  `,
      },
    },
  });
  await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {
    node_type: 'custom',
    config: nodes.script(
      `await agentsys('POST','plugins/durable-bridge/call/child',{project:'${other.id}',node:'${child.id}',delay:context.event.payload.delay});`
    ),
  });
  const parent = await app.api('POST', path, {node_ids: [node.id], payload: {delay: 0}, wait: true});
  assert.equal(parent.dispatch_status, 'completed');
  const identity = JSON.parse((await app.api('GET', otherPath)).displays[child.id]);
  assert.equal(identity.run_id, parent.run_id);
  assert.equal(identity.parent_dispatch_id, parent.dispatch_id);
  assert.ok(identity.parent_invocation_id);
  await app.api('PUT', `projects/${other.id}/typed-nodes/${child.id}`, {
    node_type: 'custom',
    config: nodes.script(
      'node.display(context.execution);context.state.started=false;await node.sleep(context.event.payload.delay);context.state.unwanted=true;'
    ),
  });
  const cancellable = await app.api('POST', path, {node_ids: [node.id], payload: {delay: 1000}});
  await until(app, otherPath, r => r.nodes.some(n => n.node_id === child.id && n.status === 'sleeping'));
  await app.api('DELETE', path);
  await until(app, otherPath, r => r.status === 'idle');
  assert.equal((await app.api('GET', otherPath)).state.unwanted, undefined);
  assert.equal((await app.api('GET', path + '/dispatches/' + cancellable.dispatch_id)).status, 'cancelled');
});
test('read-triggered invocations correlate with their evaluation dispatch', async t => {
  const {app, project, path} = await setup(t);
  const reader = await place(
    app,
    project.id,
    {},
    bundleOf(
      'Read identity',
      {
        E: nodes.event('on_read'),
        S: nodes.script('node.output.value=42;node.display(context.execution);'),
      },
      {wires: [['E', 'out', 'S', 'in']], outputs: [{id: 'value', name: 'value', node: false}]}
    )
  );
  const result = await app.api('POST', `projects/${project.id}/evaluate-node`, {node_id: reader.id});
  const trace = await app.api('GET', path + '/trace', {}, {dispatch_id: result.dispatch_id});
  const invocation = trace.events.find(e => e.type === 'invocation.start');
  assert.ok(invocation);
  assert.equal(invocation.run_id, result.run_id);
});
test('deleting a node during an await prevents late state mutations and API writes', async t => {
  const {app, project, node, path} = await setup(
    t,
    `
    context.state.started=true;await new Promise(resolve=>setTimeout(resolve,100));
    try{context.state.late=true;}catch{}
    try{await agentsys('PUT','projects/'+context.project_id+'/execution/scopes/late',{version:0,value:1});}catch{}
  `
  );
  const dispatch = await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, r => r.state.started);
  await app.api('POST', `projects/${project.id}/delete-nodes`, {node_ids: [node.id]});
  await until(app, path, r => r.status === 'idle');
  assert.equal((await app.api('GET', path)).state.late, undefined);
  assert.equal((await app.api('GET', path + '/scopes/late')).deleted, true);
  const finished = await app.api('GET', path + '/dispatches/' + dispatch.dispatch_id);
  assert.ok(finished.finished_at);
  assert.equal(finished.status, 'cancelled');
});
test('Stop cancels a real checked network request and permits a clean new Worker generation', async t => {
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
  const {app, project, node, path} = await setup(
    t,
    `await agentsys('POST','net',{url:'http://127.0.0.1:${server.address().port}'});context.state.late=true;`
  );
  const dispatch = await app.api('POST', path, {node_ids: [node.id]});
  await received;
  await app.api('DELETE', path);
  assert.equal((await app.api('GET', path + '/dispatches/' + dispatch.dispatch_id)).status, 'cancelled');
  assert.equal((await app.api('GET', path)).state.late, undefined);
  await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {
    node_type: 'custom',
    config: nodes.script('context.state.fresh=true;'),
  });
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.state.fresh, true);
  assert.equal(app.workerStats.started, 2);
});
test('optional duration, invocation and parallelism budgets are distinct from errors and user Stop', async t => {
  const {app, project, node, path} = await setup(t, 'context.state.started=true;while(true){}');
  const timed = await app.api('POST', path, {node_ids: [node.id], policy: {max_duration_ms: 100}});
  await until(app, path + '/dispatches/' + timed.dispatch_id, r => r.status === 'budget_exceeded');
  const next = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('await node.sleep(20);'),
  });
  await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {
    node_type: 'custom',
    config: nodes.script('await node.sleep(20);'),
  });
  const limited = await app.api('POST', path, {node_ids: [node.id, next.id], wait: true, policy: {max_parallelism: 1}});
  assert.equal(limited.dispatch_status, 'budget_exceeded');
  await flow(app, project.id, {}, [node.id, next.id]);
  const count = await app.api('POST', path, {wait: true, policy: {max_invocations: 1}});
  assert.equal(count.dispatch_status, 'budget_exceeded');
  const unlimited = await app.api('POST', path, {wait: true});
  assert.equal(unlimited.dispatch_status, 'completed');
  const longBudget = await app.api('POST', path, {wait: true, policy: {max_duration_ms: 2147483648}});
  assert.equal(longBudget.dispatch_status, 'completed');
});
test(
  'a new Run arriving during Stop waits for its boundary without joining the cancelled generation',
  {timeout: 5000},
  async t => {
    const store = memoryStore(),
      {app, project, node, path} = await setup(
        t,
        'context.state.started=true;await node.sleep(1000);context.state.stale=true;',
        store
      );
    await app.api('POST', path, {node_ids: [node.id]});
    await until(app, path, r => r.state.started);
    await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {
      node_type: 'custom',
      config: nodes.script('context.state.fresh=true;'),
    });
    let release;
    const gate = new Promise(resolve => (release = resolve)),
      read = store.get;
    let paused = true;
    store.get = async key => {
      if (paused && key.endsWith('/executions')) await gate;
      return read(key);
    };
    const stop = app.api('DELETE', path);
    for (let i = 0; i < 100; i++) {
      if (app.eval(`[...GRAPH_RUNTIMES.values()][0].stopping!==null && !![...GRAPH_RUNTIMES.values()][0].stopping`))
        break;
      await sleep(1);
    }
    const next = app.api('POST', path, {node_ids: [node.id], wait: true});
    await sleep(10);
    paused = false;
    release();
    await stop;
    const result = await next;
    assert.equal(result.dispatch_status, 'completed');
    assert.equal(result.state.fresh, true);
    assert.equal(result.state.stale, undefined);
  }
);
test('trace retention is bounded, filterable, optional and excludes code, secrets and request bodies', async t => {
  const marker = 'sensitive-request-body-5273';
  const {app, node, path} = await setup(t, `node.display('${marker}');throw Error('${marker}');`);
  await app.api('PUT', path + '/retention', {max_events: 4});
  const dispatch = await app.api('POST', path, {node_ids: [node.id], payload: {token: marker}, wait: true});
  const trace = await app.api('GET', path + '/trace', {}, {run_id: dispatch.run_id});
  assert.ok(trace.events.length > 0 && trace.events.length <= 4);
  assert.ok(!JSON.stringify(trace).includes(marker));
  assert.ok(!JSON.stringify(await app.api('GET', path + '/dispatches')).includes(marker));
  await app.api('PUT', path + '/retention', {enabled: false});
  const other = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal((await app.api('GET', path + '/trace', {}, {dispatch_id: other.dispatch_id})).events.length, 0);
  const config = nodes.script(`
    const path='projects/'+context.project_id+'/execution/scopes/conflict';
    await agentsys('PUT',path,{version:0,value:1});
    try{await agentsys('PUT',path,{version:0,value:2});}catch{}
  `);
  const project = path.split('/')[1];
  await app.api('PUT', `projects/${project}/typed-nodes/${node.id}`, {node_type: 'custom', config});
  assert.equal((await app.api('POST', path, {node_ids: [node.id], wait: true})).dispatch_status, 'completed');
  assert.ok(Array.isArray(await app.api('GET', path + '/dispatches')));
  assert.equal((await app.api('GET', path)).storage_error, undefined);
  await app.api('PUT', path + '/retention', {enabled: true, max_bytes: 64});
  await app.api('POST', path, {node_ids: [], wait: true});
  assert.ok(Buffer.byteLength(JSON.stringify((await app.api('GET', path + '/trace')).events)) <= 64);
});
test('durable operations claim with CAS, retry explicitly and never replay completed effects', async t => {
  const {app, project, path} = await setup(t),
    request = (method, path, body, query) => app.api(method, path, body, query);
  const runner = createOperationRunner(request, {project_id: project.id, workflow_id: project.id});
  let effects = 0;
  await assert.rejects(
    runner.execute(
      'sum',
      {a: 1},
      async () => {
        effects++;
        throw Error('intentional');
      },
      {policy: 'safe'}
    ),
    /intentional/
  );
  const failed = await runner.get('sum');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempt, 1);
  await assert.rejects(
    runner.execute('sum', {a: 1}, () => 42, {policy: 'safe'}),
    /recovery decision/
  );
  assert.equal(
    await runner.execute(
      'sum',
      {a: 1},
      async () => {
        effects++;
        return 42;
      },
      {policy: 'safe', retry: true}
    ),
    42
  );
  assert.equal(
    await runner.execute(
      'sum',
      {a: 1},
      () => {
        effects++;
        return 0;
      },
      {policy: 'safe'}
    ),
    42
  );
  assert.equal(effects, 2);
  assert.equal((await runner.get('sum')).attempt, 2);
  assert.ok((await runner.get('sum')).history.some(event => event.status === 'failed'));
  await assert.rejects(app.api('PUT', path + '/operations/sum', {version: 4, status: 'running'}));
});
test('concurrent operation runners cannot both invoke the same side effect', async t => {
  const {app, project} = await setup(t),
    runner = createOperationRunner((method, path, body, query) => app.api(method, path, body, query), {
      project_id: project.id,
      workflow_id: project.id,
    });
  let effects = 0;
  const action = async () => {
    effects++;
    await sleep(25);
    return 42;
  };
  const results = await Promise.allSettled([runner.execute('once', {}, action), runner.execute('once', {}, action)]);
  assert.equal(effects, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await runner.get('once')).status, 'completed');
});
test('active operation budget stops a controlled dispatch with a budget outcome', async t => {
  const {app, node, path} = await setup(
    t,
    `
    const base='projects/'+context.project_id+'/execution/operations';
    for(const id of ['first','second']){
      const r=await agentsys('GET',base+'/'+id);
      await agentsys('PUT',base+'/'+id,{version:r.version,status:'running'});
    }
  `
  );
  for (const id of ['first', 'second'])
    await app.api('POST', path + '/operations', {id, policy: 'safe', run_id: 'earlier-' + id});
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true, policy: {max_active_operations: 1}});
  assert.equal(result.dispatch_status, 'budget_exceeded');
});
test('restart marks active operations interrupted, keeps completed checkpoints, and requires manual resolution for uncertain effects', async t => {
  const store = memoryStore(),
    {app, project, path} = await setup(t, '', store),
    base = path + '/operations';
  for (const id of ['completed', 'safe', 'external']) {
    let r = await app.api('POST', base, {id, input: {id}, policy: id === 'external' ? 'manual' : 'safe'});
    r = await app.api('PUT', base + '/' + id, {version: r.version, status: 'running'});
    if (id === 'completed')
      await app.api('PUT', base + '/' + id, {version: r.version, status: 'completed', result: 42});
  }
  const reopened = createApp({scripts: 'worker', store});
  t.after(() => reopened.Backend.shutdownExecutions());
  const operations = await reopened.api('GET', base);
  assert.equal(operations.find(r => r.id === 'completed').status, 'completed');
  const uncertain = operations.find(r => r.id === 'external');
  assert.equal(uncertain.status, 'interrupted');
  assert.equal(uncertain.uncertain, true);
  await assert.rejects(reopened.api('POST', base + '/external/retry', {version: uncertain.version}), {
    code: 'manual_resolution_required',
  });
  await reopened.api('POST', base + '/external/resolve', {
    version: uncertain.version,
    status: 'completed',
    result: 'verified',
  });
  const safe = operations.find(r => r.id === 'safe');
  assert.equal((await reopened.api('POST', base + '/safe/retry', {version: safe.version})).status, 'pending');
  // Old backend writers are fenced after a new execution owner claims the store.
  await assert.rejects(app.api('PUT', path + '/scopes/stale', {version: 0, value: 1}), {code: 'execution_cancelled'});
  app.eval('GRAPH_RUNTIMES.clear()');
});
test('write failures are surfaced, do not acknowledge checkpoints and cannot leave phantom active dispatches', async t => {
  const store = memoryStore(),
    {app, node, path} = await setup(t, 'context.state.sideEffect=true;', store);
  await app.api('GET', path);
  store.fail = true;
  await assert.rejects(app.api('POST', path, {node_ids: [node.id], wait: true}), /Disk unavailable/);
  store.fail = false;
  const runtime = await app.api('GET', path);
  assert.equal(runtime.active_signals, 0);
  assert.ok(runtime.storage_error);
  assert.equal(runtime.state.sideEffect, undefined);
  await assert.rejects(app.api('PUT', path + '/scopes/failure', {value: 1}), /version/);
});
test('user grants endpoint works outside developer mode; actual Workers cannot authorize themselves or resolve manual operations', async t => {
  const {app, project, node, path} = await setup(
    t,
    `
    try{await agentsys('PUT','projects/'+context.project_id+'/node-permissions/'+context.node_id,{grants:['net.fetch:*']});}
    catch(error){context.state.denied=error.code;}
    try{await agentsys('POST','projects/'+context.project_id+'/execution/operations/effect/resolve',{version:3,status:'completed'});}
    catch(error){context.state.resolveDenied=error.code;}
  `
  );
  await app.api('PUT', 'settings', {developer_mode: false});
  await app.api('PUT', `projects/${project.id}/node-permissions/${node.id}`, {grants: ['graph.write', 'run.start']});
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.state.denied, 'permission_denied');
  assert.equal(result.state.resolveDenied, 'permission_denied');
  const detail = await app.api('GET', `projects/${project.id}/node-permissions/${node.id}`);
  assert.deepEqual(detail.effective, ['graph.write', 'run.start']);
  await app.api('PUT', `projects/${project.id}/policy`, {allow: ['graph.read']});
  assert.deepEqual((await app.api('GET', `projects/${project.id}/node-permissions/${node.id}`)).effective, []);
});
