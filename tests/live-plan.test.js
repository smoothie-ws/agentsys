'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, nodes, flow, bundleOf, place} = require('./harness');
const {loadBackend} = require('../headless');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function eventually(read, check = Boolean) {
  for (let i = 0; i < 600; i++) {
    const value = await read();
    if (check(value)) return value;
    await tick();
  }
  throw Error('Condition was not reached');
}
async function fixture(scripts = 'inline', store = null) {
  const app = createApp({scripts, store});
  const p = await app.api('POST', 'projects', {name: 'Live plan'});
  return {
    app,
    p,
    base: `projects/${p.id}`,
    run: ids => app.api('POST', `projects/${p.id}/runs`, {node_ids: ids, wait: 2}),
  };
}
async function changeCode(app, base, id, code) {
  const snapshot = await app.api('GET', base + '/workflow');
  const config = snapshot.nodes.find(n => n.id === id).config;
  config.inputs.find(p => p.id === 'script').default = code;
  await app.api('PUT', base + '/typed-nodes/' + id, {node_type: 'custom', config});
}
const events = async (app, id) => (await app.api('GET', `runs/${id}/events`)).events;
const memoryStore = () => {
  const data = new Map();
  return {
    data,
    get: k => structuredClone(data.get(k)),
    commit: ({set, remove}) => {
      for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
      for (const k of remove) data.delete(k);
    },
  };
};

test('a running Worker keeps its version and grants; the next signal uses the committed code; mixed-version replay is offline', async () => {
  const {app, p, base, run} = await fixture('worker');
  let release;
  app.context.fetch = () =>
    new Promise(resolve => {
      release = () => resolve({status: 200, text: async () => 'held'});
    });
  const target = await fn(
    app,
    p.id,
    {},
    {
      code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.state.update("seen",x=>[...(x??[]),"old"]);node.display("old");',
    }
  );
  const driver = await fn(app, p.id, {}, {code: 'await node.emit("Out");await node.emit("Out");', signals: ['Out']});
  await app.api('POST', base + '/port-connections', {
    add: [{source: driver.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}],
  });
  const started = app.api('POST', base + '/runs', {node_ids: [driver.id]});
  const r = await started;
  await eventually(() => release);
  await changeCode(app, base, target.id, 'await node.state.update("seen",x=>[...(x??[]),"new"]);node.display("new");');
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.equal(detail.status, 'completed', JSON.stringify(detail.errors));
  assert.deepEqual((await app.api('GET', `workflows/${p.id}/state/seen`)).value, ['old', 'new']);
  const starts = (await events(app, r.id)).filter(e => e.type === 'node_started' && e.node_id === target.id);
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].node_version, starts[1].node_version);
  assert.match(starts[0].node_version, /^[a-f0-9]{64}$/);
  const trace = await app.eval(`JSON.parse(JSON.stringify(RUNS.byId.get('${r.id}').trace))`);
  assert.equal(trace.find(t => t.path === 'net').node_version, starts[0].node_version);
  assert.equal(trace.findLast(t => t.path.endsWith('/seen')).node_version, starts[1].node_version);
  app.context.fetch = () => {
    throw Error('Replay attempted live I/O');
  };
  const replay = await app.api('POST', `runs/${r.id}/replay`, {wait: 3});
  assert.equal(replay.status, 'completed', JSON.stringify(replay));
  assert.deepEqual(replay.displays, detail.displays);
  assert.deepEqual((await app.api('GET', `workflows/${p.id}/state/seen`)).value, ['old', 'new']);
});

test('current graph is loaded after restart; a changed wait starts fresh with new code and version', async () => {
  const store = memoryStore(),
    {app, p, base, run} = await fixture('worker', store);
  const n = await fn(app, p.id, {}, {code: 'if(!node.resumed)await node.wait({event:"ready"});node.display("old");'});
  const waiting = await run([n.id]);
  const checkpoint = store.data.get(`runs/${waiting.id}/checkpoint`);
  assert.equal(checkpoint.graph_ref, p.id);
  assert.ok(checkpoint.node_versions[n.id]);
  await changeCode(app, base, n.id, 'node.display(node.resumed===null?"fresh":"stale answer");');
  const next = loadBackend({store});
  await next.Backend.request('POST', 'events/ready', {body: {answer: 42}});
  await next.eval(`RUNS.byId.get('${waiting.id}').done`);
  const detail = await next.Backend.request('GET', 'runs/' + waiting.id);
  assert.equal(detail.status, 'completed', JSON.stringify(detail.errors));
  assert.equal(detail.displays[n.id], 'fresh');
  const replay = await next.Backend.request('POST', `runs/${waiting.id}/replay`, {body: {wait: 3}});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
  assert.equal(replay.displays[n.id], 'fresh');
});

test('a deleted waiting node is skipped with node_removed on resume', async () => {
  const {app, base, p, run} = await fixture();
  const n = await fn(app, p.id, {}, {code: 'await node.wait({event:"gone"});'});
  const r = await run([n.id]);
  await app.api('POST', base + '/delete-nodes', {node_ids: [n.id]});
  await app.api('POST', 'events/gone', {});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'completed');
  assert.ok(
    (await events(app, r.id)).some(e => e.type === 'node_skipped' && e.node_id === n.id && e.reason === 'node_removed')
  );
});

test('a selected target deleted while awaiting its start gate never starts', async () => {
  const {app} = await fixture();
  const result = await app.eval(`(async()=>{
    const target={id:'target',label:'target',kind:'custom',op:'on_run',running:true,inputs:[],outputs:[],preset:{},targets:{},context:{},content_hash:'one'};
    const root={...target,id:'root',outputs:[{id:'out',signal:true}],targets:{out:['target']}};
    const gate={paused:false,waiters:[]}; const log=[]; let release;
    const done=executePlan({nodes:[root,target],roots:[{id:'root',node:true}],context:{}},{AsyncFunction:Object.getPrototypeOf(async()=>{}).constructor,limits:planLimits(),displayText,gate,emit:e=>log.push(e),authorize:id=>id==='target'?new Promise(r=>release=r):null});
    while(!release)await new Promise(r=>setTimeout(r,1));
    gate.patch({upsert:[],remove:['target'],roots:[{id:'root',node:true}],diagnostics:{}});release(null);await done;
    return JSON.stringify(log);
  })()`);
  const log = JSON.parse(result);
  assert.ok(!log.some(e => e.ev === 'start' && e.id === 'target'));
  assert.ok(log.some(e => e.ev === 'skip' && e.id === 'target' && e.reason === 'node_removed'));
});

test('one batch publishes one patch; an invalid batch commits nothing', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const n = await fn(
    app,
    p.id,
    {},
    {code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.emit("Out");', signals: ['Out']}
  );
  const target = await fn(app, p.id, {}, {code: 'node.display("before");'});
  const r = await app.api('POST', base + '/runs', {node_ids: [n.id]});
  await eventually(() => release);
  const config = (await app.api('GET', base + '/workflow')).nodes.find(x => x.id === target.id).config;
  config.inputs.find(x => x.id === 'script').default = 'node.display("after");';
  const before = (await app.api('GET', base + '/workflow')).cursor;
  await assert.rejects(
    app.api('POST', base + '/batch', {
      operations: [
        {
          method: 'POST',
          path: 'port-connections',
          body: {add: [{source: n.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}]},
        },
        {path: 'nonsense'},
      ],
    }),
    /Invalid batch/
  );
  assert.equal((await app.api('GET', base + '/workflow')).cursor, before);
  await app.api('POST', base + '/batch', {
    operations: [
      {method: 'PUT', path: 'typed-nodes/' + target.id, body: {node_type: 'custom', config}},
      {
        method: 'POST',
        path: 'port-connections',
        body: {add: [{source: n.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}]},
      },
    ],
  });
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.equal(detail.status, 'completed', JSON.stringify(detail.errors));
  assert.equal(detail.displays[target.id], 'after');
  assert.equal((await events(app, r.id)).filter(e => e.type === 'plan_patched').length, 1);
});

test('edited manifests are checked before start; a blocked version runs no code', async () => {
  const {app, p, base, run} = await fixture();
  const n = await fn(
    app,
    p.id,
    {},
    {capabilities: ['graph.read'], code: 'if(!node.resumed)await node.wait({event:"go"});'}
  );
  const r = await run([n.id]);
  const resource = await app.api('GET', 'resources/' + n.resource);
  resource.payload.capabilities = ['graph.write'];
  resource.payload.grants = [];
  // Change the placed node's declaration directly to keep its ID, and remove the Library manifest.
  await app.api('PUT', 'resources/' + n.resource, {name: resource.name, payload: resource.payload, replace: true});
  await app.api('POST', 'events/go', {});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  // The Library refresh removes its old node; the new activation below checks the new manifest.
  const current = (await app.api('GET', base + '/workflow')).nodes.find(x => x.config?.op === 'script');
  const blocked = await run([current.id]);
  assert.equal(blocked.nodes.find(x => x.node_id === current.id).status, 'blocked');
  assert.match(JSON.stringify(blocked.errors), /Permission denied/);
  assert.ok(!(await events(app, blocked.id)).some(e => e.type === 'node_started' && e.node_id === current.id));
});

test('revoking policy while a node waits blocks its unchanged version at resume; offline replay keeps that decision', async () => {
  const {app, p, base, run} = await fixture();
  const n = await fn(
    app,
    p.id,
    {},
    {
      capabilities: ['graph.read'],
      code: 'if(!node.resumed)await node.wait({event:"policy"});node.display("must not run");',
    }
  );
  const r = await run([n.id]);
  await app.api('PUT', base + '/policy', {allow: []});
  await app.api('POST', 'events/policy', {});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const blocked = await app.api('GET', 'runs/' + r.id);
  assert.equal(blocked.nodes.find(x => x.node_id === n.id).status, 'blocked');
  assert.equal(blocked.displays[n.id], undefined);
  await app.api('PUT', base + '/policy', {allow: ['graph.read']});
  const replay = await app.api('POST', `runs/${r.id}/replay`, {wait: 2});
  assert.equal(replay.nodes.find(x => x.node_id === n.id).status, 'blocked');
  assert.equal(replay.status, 'failed');
});

test('on_read recomputes after a scope or a pure dependency changes inside an active Worker', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const scope = await place(
    app,
    p.id,
    {},
    bundleOf(
      'Live read',
      {
        Read: nodes.event('on_read'),
        Script: nodes.script('node.output.result="old:"+node.input.value;'),
      },
      {
        wires: [['Read', 'out', 'Script', 'in']],
        inputs: [{id: 'value', name: 'value', node: false}],
        outputs: [{id: 'result', name: 'result', node: false}],
      }
    )
  );
  const pure = await app.api('POST', base + '/typed-nodes', {node_type: 'custom', config: nodes.value('number', 1)});
  const reader = await fn(
    app,
    p.id,
    {},
    {
      inputs: ['value'],
      outputs: ['result'],
      code: 'const first=node.input.value;await agentsys("POST","net",{url:"https://hold.test"});node.output.result=[first,await node.reread("value")];',
    }
  );
  await app.api('POST', base + '/port-connections', {
    add: [
      {source: pure.id, source_port: 'value', target: scope.id, target_port: 'value'},
      {source: scope.id, source_port: 'result', target: reader.wrapper, target_port: 'value'},
    ],
  });
  const r = await app.api('POST', base + '/runs', {node_ids: [reader.id]});
  await eventually(() => release);
  const script = await scope.node('Script');
  await changeCode(app, base, script.id, 'node.output.result="new:"+node.input.value;');
  await app.api('PUT', base + '/typed-nodes/' + pure.id, {node_type: 'custom', config: nodes.value('number', 2)});
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.equal(detail.status, 'completed', JSON.stringify(detail.errors));
  assert.deepEqual(detail.outputs[reader.id].result, ['old:1', 'new:2']);
  const replay = await app.api('POST', `runs/${r.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
  assert.deepEqual(replay.outputs, detail.outputs);
});

test('a broken edit invalidates data reads without retaining the last valid plan; independent roots complete', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const value = await app.api('POST', base + '/typed-nodes', {node_type: 'custom', config: nodes.value('number', 1)});
  const reader = await fn(
    app,
    p.id,
    {},
    {
      inputs: ['value'],
      code: 'await agentsys("POST","net",{url:"https://hold.test"});node.display(await node.reread("value"));',
    }
  );
  const independent = await fn(app, p.id, {}, {code: 'node.display("independent");'});
  await app.api('POST', base + '/port-connections', {
    add: [{source: value.id, source_port: 'value', target: reader.wrapper, target_port: 'value'}],
  });
  const r = await app.api('POST', base + '/runs', {node_ids: [reader.id, independent.id]});
  await eventually(() => release);
  // External document writes may contain diagnostics which the ordinary edit API would reject.
  await app.eval(
    `(async()=>{const doc=clone(await DB.get('wf:${p.id}'));doc.nodes.find(n=>n.id==='${value.id}').config.outputs[0].type='t:missing';await versionedCommit({'wf:${p.id}':doc});})()`
  );
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.equal(detail.status, 'failed');
  assert.equal(detail.displays[independent.id], 'independent');
  assert.match(detail.errors[reader.id], /Unknown type/);
});

test('layout and JSON key order do not change node hashes or rebuild cached executable entries', async () => {
  const {app, p, base} = await fixture();
  const n = await fn(app, p.id, {}, {code: 'node.display(42);'});
  const snapshot = await app.api('GET', base + '/workflow');
  const result = JSON.parse(
    await app.eval(`(async()=>{
    const snapshot=${JSON.stringify(snapshot)},cache=new Map();
    const first=compilePlan(snapshot,['${n.id}'],{cache});await preparePlanPermissions(first);await versionPlan(first);
    const entries=new Map(cache);
    snapshot.nodes.forEach(n=>n.position={x:900,y:300});
    snapshot.nodes.forEach(n=>n.config=Object.fromEntries(Object.entries(n.config).reverse()));
    const second=compilePlan(snapshot,['${n.id}'],{cache});await preparePlanPermissions(second);await versionPlan(second);
    return JSON.stringify({same:[...cache].every(([id,c])=>entries.get(id)===c),a:first.nodes.map(n=>n.content_hash),b:second.nodes.map(n=>n.content_hash)});
  })()`)
  );
  assert.equal(result.same, true);
  assert.deepEqual(result.a, result.b);
});

test('a Library save publishes new members without opening the graph; a running invocation retains only its original grant', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const target = await fn(
    app,
    p.id,
    {},
    {
      capabilities: ['graph.write', 'net.fetch:hold.test'],
      code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.state.set("old-finished",true);',
    }
  );
  const driver = await fn(app, p.id, {}, {code: 'await node.emit("Out");await node.emit("Out");', signals: ['Out']});
  await app.api('POST', base + '/port-connections', {
    add: [{source: driver.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}],
  });
  const r = await app.api('POST', base + '/runs', {node_ids: [driver.id]});
  await eventually(() => release);
  const resource = await app.api('GET', 'resources/' + target.resource);
  resource.payload.grants = [];
  await app.api('PUT', 'resources/' + target.resource, {name: resource.name, payload: resource.payload, replace: true});
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.equal((await app.api('GET', `workflows/${p.id}/state/old-finished`)).value, true);
  assert.equal(detail.status, 'failed');
  assert.ok(detail.nodes.some(x => x.node_id !== target.id && x.status === 'blocked'));
  assert.ok((await events(app, r.id)).some(e => e.type === 'plan_patched' && e.removed.includes(target.id)));
});

test('external store notifications publish edits through the backend without a browser', async () => {
  const store = memoryStore(),
    {app, p, base} = await fixture('worker', store);
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const n = await fn(
    app,
    p.id,
    {},
    {code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.emit("Out");', signals: ['Out']}
  );
  const target = await fn(app, p.id, {}, {code: 'node.display("old");'});
  await app.api('POST', base + '/port-connections', {
    add: [{source: n.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}],
  });
  const r = await app.api('POST', base + '/runs', {node_ids: [n.id]});
  await eventually(() => release);
  const doc = structuredClone(store.data.get('wf:' + p.id));
  doc.nodes.find(x => x.id === target.id).config.inputs.find(x => x.id === 'script').default =
    'node.display("external");';
  store.data.set('wf:' + p.id, doc);
  await app.eval(`DB.changed(['wf:${p.id}']);exclusive(()=>{});`);
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + r.id)).displays[target.id], 'external');
});

test('a paused activation accepts a code patch and starts its target on the new version only after resume', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const driver = await fn(
    app,
    p.id,
    {},
    {code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.emit("Out");', signals: ['Out']}
  );
  const target = await fn(app, p.id, {}, {code: 'node.display("old");'});
  await app.api('POST', base + '/port-connections', {
    add: [{source: driver.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}],
  });
  const r = await app.api('POST', base + '/runs', {node_ids: [driver.id]});
  await eventually(() => release);
  await app.api('POST', `runs/${r.id}/pause`, {});
  release();
  await changeCode(app, base, target.id, 'node.display("new");');
  assert.ok(!(await events(app, r.id)).some(e => e.type === 'node_started' && e.node_id === target.id));
  await app.api('POST', `runs/${r.id}/resume`, {});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + r.id)).displays[target.id], 'new');
});

test('a malformed Library definition removes its obsolete code and exposes a diagnostic, then recovers on a valid save', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const target = await fn(app, p.id, {}, {code: 'node.output.result="obsolete";', outputs: ['result']});
  const reader = await fn(
    app,
    p.id,
    {},
    {
      inputs: ['value'],
      code: 'await agentsys("POST","net",{url:"https://hold.test"});node.display(await node.reread("value"));',
    }
  );
  await app.api('POST', base + '/port-connections', {
    add: [{source: target.wrapper, source_port: 'result', target: reader.wrapper, target_port: 'value'}],
  });
  const r = await app.api('POST', base + '/runs', {node_ids: [reader.id]});
  await eventually(() => release);
  const original = await app.api('GET', 'resources/' + target.resource);
  await app.eval(
    `(async()=>{const resources=clone(await DB.get('resources')),r=resources.find(r=>r.id==='${target.resource}');r.updated+=1;r.payload.bundle.positions={invalid:{x:null,y:3}};await versionedCommit({resources});})()`
  );
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.match(detail.errors[reader.id], /Library update failed/);
  const broken = await app.api('GET', base + '/workflow');
  assert.ok(broken.diagnostics.some(d => d.node_id === target.wrapper && /Library update failed/.test(d.message)));
  assert.ok(!broken.nodes.some(n => n.id === target.id));
  await app.api('PUT', 'resources/' + target.resource, {name: original.name, payload: original.payload, replace: true});
  const fixed = await app.api('GET', base + '/workflow');
  assert.ok(!fixed.diagnostics.some(d => d.node_id === target.wrapper));
  assert.ok(fixed.nodes.some(n => n.config?.inputs?.some(i => i.default?.includes?.('obsolete'))));
});

test('bounded plan recording disables exact replay while live patches continue to work', async () => {
  const {app, p, base} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const driver = await fn(
    app,
    p.id,
    {},
    {code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.emit("Out");', signals: ['Out']}
  );
  const target = await fn(app, p.id, {}, {code: 'node.display("old");'});
  await app.api('POST', base + '/port-connections', {
    add: [{source: driver.wrapper, source_port: 'Out', target: target.wrapper, target_port: 'in'}],
  });
  await app.api('PUT', 'settings', {max_trace_bytes: 500});
  const r = await app.api('POST', base + '/runs', {node_ids: [driver.id]});
  await eventually(() => release);
  await changeCode(app, base, target.id, 'node.display("new");');
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const detail = await app.api('GET', 'runs/' + r.id);
  assert.equal(detail.status, 'completed', JSON.stringify(detail.errors));
  assert.equal(detail.displays[target.id], 'new');
  assert.equal(detail.replay_available, false);
  assert.equal(await app.eval(`RUNS.byId.get('${r.id}').segments.length`), 0);
  await assert.rejects(app.api('POST', `runs/${r.id}/replay`, {wait: 2}), /journal limit/);
});

test('unapplied replay patches fail with a divergence error even after roots returned outputs', async () => {
  const {app, p, run} = await fixture();
  const n = await fn(app, p.id, {}, {code: 'node.display("once");'});
  const r = await run([n.id]);
  await app.eval(
    `RUNS.byId.get('${r.id}').segments[0].patches.push({at:1000000,patch:{upsert:[],remove:[],roots:[],diagnostics:{}}})`
  );
  const replay = await app.api('POST', `runs/${r.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'failed');
  assert.match(replay.error, /Replay diverged/);
});
