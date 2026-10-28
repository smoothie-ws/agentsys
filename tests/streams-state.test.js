'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, flow} = require('./harness');
const {loadBackend} = require('../headless');
const memoryStore = () => {
  const data = new Map();
  return {
    data,
    get: key => structuredClone(data.get(key)),
    commit: ({set, remove}) => {
      for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
      for (const k of remove) data.delete(k);
    },
  };
};
async function fixture(code = '', store = null, scripts = 'inline') {
  const app = createApp({store, scripts}),
    p = await app.api('POST', 'projects', {name: 'Streams'});
  const n = await fn(app, p.id, {}, {code, outputs: ['result']});
  await flow(app, p.id, {}, [n.wrapper]);
  return {
    app,
    p,
    n,
    base: `workflows/${p.id}`,
    run: body => app.api('POST', `projects/${p.id}/runs`, {wait: 5, ...body}),
  };
}
const settle = async app => {
  for (const id of await app.eval('[...RUNS.byId.keys()]')) await app.eval(`RUNS.byId.get('${id}')?.done`);
};
test('workflow state is isolated, versioned, bounded and recovered after a backend restart', async () => {
  const store = memoryStore(),
    {app, p, base} = await fixture('', store);
  const second = await app.api('POST', `projects/${p.id}/workflows`, {name: 'Second'});
  const put = value => app.api('PUT', base + '/state/key', value);
  assert.equal((await put({value: 1, version: 0})).version, 1);
  await assert.rejects(put({value: 2, version: 0}), /version/);
  await assert.rejects(app.api('GET', `workflows/${second.id}/state/key`), /No such/);
  await app.api('DELETE', base + '/state/key', {}, {version: 1});
  const recreated = await put({value: 2, version: 0});
  assert.ok(recreated.version > 1);
  await assert.rejects(put({value: 3, version: 1}), /version/);
  await app.api('PUT', 'settings', {state_value_bytes: 10, state_total_bytes: 15});
  await assert.rejects(put({value: 'long'.repeat(4)}), /state_value_bytes/);
  await put({value: '12345678'});
  await assert.rejects(app.api('PUT', base + '/state/other', {value: '12345'}), /state_total_bytes/);
  const backend = loadBackend({store});
  assert.equal((await backend.Backend.request('GET', base + '/state/key')).value, '12345678');
  await assert.rejects(app.api('GET', `projects/${p.id}/state/key`), /endpoint not found/);
});
test('100 simultaneous node.state.update calls lose no increments', async () => {
  const {app, base, run} = await fixture(
    'await Promise.all(Array.from({length:100},()=>node.state.update("count",n=>(n??0)+1)));'
  );
  await app.api('PUT', 'settings', {max_bridge_calls: 30000});
  const result = await run({wait: 120});
  assert.equal(result.status, 'completed', JSON.stringify(result.errors));
  assert.equal((await app.api('GET', base + '/state/count')).value, 100);
});
test('state and queues reject cross-workflow access through the bridge', async () => {
  const {app, p, n, run} = await fixture('');
  const second = await app.api('POST', `projects/${p.id}/workflows`, {name: 'Private'});
  const item = await app.api('GET', 'resources/' + n.resource);
  item.payload.bundle.records
    .find(r => r.payload.config?.op === 'script')
    .payload.config.inputs.find(p => p.id === 'script').default =
    `await agentsys('PUT','workflows/${second.id}/state/x',{value:1});`;
  await app.api('PUT', 'resources/' + n.resource, {name: item.name, payload: item.payload, replace: true});
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.errors), /private/);
});
test('queues recover leases after restart, reject stale receipts and enforce overflow', async () => {
  const store = memoryStore(),
    {app, base} = await fixture('', store),
    q = base + '/queues/items';
  await app.api('PUT', q, {limit: 2, overflow: 'fail', visibility_ms: 10});
  await app.api('POST', q + '/push', {item: 1});
  await app.api('POST', q + '/push', {item: 2});
  await assert.rejects(app.api('POST', q + '/push', {item: 3}), /full/);
  const [first] = await app.api('POST', q + '/pull', {visibility_ms: 1});
  await new Promise(resolve => setTimeout(resolve, 5));
  const backend = loadBackend({store}),
    call = (method, path, body = {}) => backend.Backend.request(method, path, {body});
  const [again] = await call('POST', q + '/pull', {visibility_ms: 10000});
  assert.equal(first.item_id, again.item_id);
  assert.notEqual(first.id, again.id);
  await assert.rejects(call('POST', q + '/ack', {id: first.id}), /expired/);
  await call('POST', q + '/ack', {id: again.id});
  await call('PUT', q, {limit: 1, overflow: 'drop_new'});
  assert.equal((await call('POST', q + '/push', {item: 3})).accepted, false);
  await call('PUT', q, {overflow: 'drop_oldest'});
  await call('POST', q + '/push', {item: 4});
  assert.equal((await call('POST', q + '/pull'))[0].value, 4);
  await assert.rejects(call('POST', q + '/pull', {max: 0}), /max/);
  await assert.rejects(call('PUT', q, {limit: -1}), /limit/);
});
test('queue trigger obeys max_concurrency, acknowledges success and returns failures', async () => {
  const {app, p, base} = await fixture(
    'if(context.payload.item.value.fail)throw Error("bad item");await node.state.update("count",n=>(n??0)+1);'
  );
  await app.api('PUT', base + '/control', {max_attempts: 1});
  const q = base + '/queues/jobs';
  await app.api('PUT', q, {visibility_ms: 60000});
  await app.api('POST', 'triggers', {
    name: 'Consumer',
    type: 'queue',
    project_id: p.id,
    queue: 'jobs',
    max_concurrency: 2,
  });
  for (let i = 0; i < 3; i++) await app.api('POST', q + '/push', {item: {fail: i === 2}});
  const tick = await app.api('POST', 'scheduler/tick', {});
  assert.equal(tick.fired.length, 2);
  await settle(app);
  assert.equal((await app.api('GET', q)).size, 1);
  assert.equal((await app.api('GET', base + '/state/count')).value, 2);
  await app.api('POST', 'scheduler/tick', {});
  await settle(app);
  assert.equal((await app.api('GET', q)).size, 1);
  const snapshot = await app.eval(`DB.get('${base}/queues/jobs/journal').then(queueSnapshot)`);
  assert.equal(snapshot.items[0].receipt, null);
});
test('webhook dedupe is durable, expires, and all three overlap policies apply to waiting runs', async () => {
  for (const overlap of ['skip', 'queue', 'parallel']) {
    const store = memoryStore(),
      {app, p, base} = await fixture('if(!node.resumed)await node.wait({event:"finish"});', store);
    await app.api('PUT', base + '/control', {dedupe_ms: 60000});
    const trigger = await app.api('POST', 'triggers', {type: 'webhook', name: overlap, project_id: p.id, overlap});
    const first = await app.api('POST', 'hooks/' + trigger.token, {dedupe_key: 'one'});
    await settle(app);
    const same = await app.api('POST', 'hooks/' + trigger.token, {dedupe_key: 'one'});
    assert.equal(same.id, first.id);
    const other = await app.api('POST', 'hooks/' + trigger.token, {dedupe_key: 'two'});
    assert.equal(other.status, overlap === 'skip' ? 'skipped' : overlap === 'queue' ? 'queued' : 'running');
    if (overlap === 'queue') assert.equal((await app.api('GET', base + '/control')).pending.length, 1);
    const backend = loadBackend({store, scripts: 'inline'});
    const afterRestart = await backend.Backend.request('POST', 'hooks/' + trigger.token, {body: {dedupe_key: 'one'}});
    assert.equal(afterRestart.id, first.id);
    await app.api('POST', 'events/finish', {});
    await settle(app);
    await app.api('POST', 'scheduler/tick', {});
    await settle(app);
    if (overlap === 'queue') {
      assert.equal((await app.api('GET', base + '/control')).pending.length, 0);
      assert.equal((await app.api('GET', 'runs/' + other.id)).status, 'waiting');
    }
  }
});
test('supervision persists backoff retries, pauses after exhausted failures and allows manual recovery', async () => {
  const store = memoryStore(),
    {app, p, base, run} = await fixture('throw Error("activation failed");', store);
  await app.api('PUT', base + '/control', {max_attempts: 2, backoff_ms: 1000, pause_after: 1});
  const first = await run();
  assert.equal(first.status, 'failed');
  assert.equal((await app.api('GET', base + '/control')).status, 'enabled');
  assert.equal((await app.api('POST', 'scheduler/tick', {})).fired.length, 0);
  const backend = loadBackend({store, scripts: 'inline'}),
    call = (m, path, body = {}) => backend.Backend.request(m, path, {body});
  const tick = await call('POST', 'scheduler/tick', {now: Date.now() / 1000 + 2});
  const retry = tick.fired.find(r => r.retry_of === first.id);
  assert.ok(retry);
  await backend.eval(`RUNS.byId.get('${retry.run_id}').done`);
  const control = await call('GET', base + '/control');
  assert.equal(control.status, 'paused');
  assert.equal(control.reason, 'consecutive_failures');
  await assert.rejects(call('POST', `projects/${p.id}/runs`), /paused/);
  await call('PUT', base + '/control', {status: 'enabled'});
  assert.equal((await call('GET', base + '/control')).failures, 0);
});
test('bridge quotas reserve atomically and replay incurs no charges', async () => {
  const {app, base, run} = await fixture(
    'const results=await Promise.allSettled(Array.from({length:16},()=>agentsys("GET","projects")));node.display(results.filter(r=>r.status==="fulfilled").length);'
  );
  await app.api('PUT', base + '/control', {
    quotas: [{key: 'GET projects', limit: 5, capacity: 5, refill_per_second: 0.001}],
  });
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(Object.values(result.displays)[0], '5');
  const before = await app.api('GET', base + '/usage');
  assert.equal(before['GET projects'].used, 5);
  const replay = await app.api('POST', `runs/${result.id}/replay`, {wait: 5});
  assert.equal(replay.status, 'completed');
  assert.deepEqual(await app.api('GET', base + '/usage'), before);
});
test('bridge journal stores redacted blobs with hashes, sizes, duration and node version', async () => {
  const store = memoryStore(),
    {app, base, run} = await fixture(
      'await agentsys("GET","projects",{password:"never-record-this",token:"never-record-this"});',
      store
    );
  const result = await run();
  assert.equal(result.status, 'completed');
  const trace = store.data.get('runs/' + result.id).trace;
  assert.equal(trace.length, 1);
  assert.match(trace[0].node_version, /^[a-f0-9]{64}$/);
  for (const key of ['request_bytes', 'response_bytes', 'duration_ms']) assert.equal(typeof trace[0][key], 'number');
  const journal = [...store.data]
    .filter(([key]) => key.includes('/blobs/') || key.endsWith('/events'))
    .map(([, value]) => value);
  assert.equal(JSON.stringify(journal).includes('never-record-this'), false);
  assert.ok(store.data.has(trace[0].request_ref));
  assert.ok(store.data.has(trace[0].response_ref));
  await app.api('PUT', 'settings', {trace_retention_ms: 1});
  await app.api('POST', 'scheduler/tick', {now: Date.now() / 1000 + 1});
  assert.equal(store.data.has(trace[0].response_ref), false);
  assert.equal((await app.api('GET', 'runs/' + result.id)).replay_available, false);
});
test('a paused workflow retains event answers across restart and blocks manual resume', async () => {
  const store = memoryStore(),
    {app, p, base, run} = await fixture(
      'if(!node.resumed)await node.wait({event:"answer"});await node.state.set("answer",node.resumed.value);',
      store
    );
  const waiting = await run();
  assert.equal(waiting.status, 'waiting');
  await app.api('PUT', base + '/control', {status: 'paused'});
  assert.equal((await app.api('POST', 'events/answer', {value: 42})).resumed.length, 0);
  await assert.rejects(app.api('POST', `runs/${waiting.id}/resume`), /Enable the workflow/);
  const backend = loadBackend({store, scripts: 'inline'}),
    call = (m, path, body = {}) => backend.Backend.request(m, path, {body});
  await call('PUT', base + '/control', {status: 'enabled'});
  await call('POST', 'scheduler/tick');
  await backend.eval(`RUNS.byId.get('${waiting.id}').done`);
  assert.equal((await call('GET', base + '/state/answer')).value.value, 42);
});
test('blocked queue pushes suspend without holding a worker and resume when a receipt is acknowledged', async () => {
  const {app, base, run} = await fixture('await node.queue("bounded").push(2);node.display("pushed");', null, 'worker');
  const q = base + '/queues/bounded';
  await app.api('PUT', q, {limit: 1, overflow: 'block'});
  await app.api('POST', q + '/push', {item: 1});
  const suspended = await run();
  assert.equal(suspended.status, 'waiting');
  assert.equal(app.workerStats.terminated, 1);
  const [first] = await app.api('POST', q + '/pull', {});
  await app.api('POST', q + '/ack', {id: first.id});
  for (let i = 0; i < 100; i++) {
    const current = await app.api('GET', 'runs/' + suspended.id);
    if (current.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await app.api('GET', 'runs/' + suspended.id)).status, 'completed');
  assert.equal((await app.api('POST', q + '/pull', {}))[0].value, 2);
});
test('queue journals compact without losing order and concurrent pulls never share a lease', async () => {
  const {app, base} = await fixture(),
    q = base + '/queues/ordered';
  for (let i = 0; i < 140; i++) {
    await app.api('POST', q + '/push', {item: i});
    const [item] = await app.api('POST', q + '/pull', {});
    assert.equal(item.value, i);
    await app.api('POST', q + '/ack', {id: item.id});
  }
  assert.ok((await app.eval(`DB.get('${base}/queues/ordered/journal')`)).length <= 256);
  for (let i = 0; i < 10; i++) await app.api('POST', q + '/push', {item: i});
  const deliveries = (await Promise.all(Array.from({length: 10}, () => app.api('POST', q + '/pull', {})))).flat();
  assert.equal(new Set(deliveries.map(i => i.item_id)).size, 10);
  assert.equal((await app.api('POST', q + '/pull', {})).length, 0);
});
test('event dedupe and activation dedupe expire without creating a duplicate before expiry', async () => {
  const {app, base, run} = await fixture('if(!node.resumed)await node.wait({event:"delivery"});');
  const first = await run({dedupe_key: 'same'});
  assert.equal((await run({dedupe_key: 'same'})).id, first.id);
  await app.api('POST', 'events/delivery', {dedupe_key: 'event-1'});
  await settle(app);
  const second = await run();
  assert.equal(second.status, 'waiting');
  assert.equal((await app.api('POST', 'events/delivery', {dedupe_key: 'event-1'})).duplicate, true);
  assert.equal((await app.api('GET', 'runs/' + second.id)).status, 'waiting');
  await app.eval(
    `exclusive(async()=>{const key='${base}/control',c=clone(await DB.get(key));for(const e of Object.values(c.dedupe))e.expires=0;await DB.commit({[key]:c,event_dedupe:{}});})`
  );
  const third = await run({dedupe_key: 'same'});
  assert.notEqual(third.id, first.id);
  assert.equal((await app.api('POST', 'events/delivery', {dedupe_key: 'event-1'})).resumed.length, 2);
  await settle(app);
});
test('retention expires details and blobs while keeping bounded activation summaries', async () => {
  const store = memoryStore(),
    {app, base, run} = await fixture('await agentsys("GET","projects");', store);
  await app.api('PUT', 'settings', {run_retention: 1, run_summary_retention: 2});
  const first = await run(),
    trace = store.data.get('runs/' + first.id).trace;
  await run();
  const last = await run();
  const summaries = await app.api('GET', 'runs');
  assert.equal(summaries.length, 2);
  assert.equal(store.data.has('runs/' + first.id), false);
  assert.equal(store.data.has(trace[0].response_ref), false);
  assert.ok(store.data.has('runs/' + last.id));
  await app.api('DELETE', `projects/${last.project_id}`);
  assert.equal(
    [...store.data.keys()].some(k => k.startsWith(base + '/')),
    false
  );
  assert.equal((await app.api('GET', 'runs')).length, 0);
});
test('invalid workflow settings, state keys, queue values and quota rules are rejected', async () => {
  const {app, base, run} = await fixture('await node.state.set("invalid",Infinity);');
  for (const value of [
    {status: 'running'},
    {max_attempts: 0},
    {pause_after: -1},
    {quotas: [{key: '*', limit: 0}]},
    {unknown: true},
  ])
    await assert.rejects(app.api('PUT', base + '/control', value));
  for (const key of ['__proto__', 'constructor', 'bad key'])
    await assert.rejects(app.api('PUT', base + '/state/' + key, {value: 1}));
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.errors), /JSON data/);
  await assert.rejects(app.Backend.request('POST', base + '/queues/x/push', {body: {item: NaN}}), /JSON data/);
});
test('24 hours of scheduler time keep stream state correct and journal storage bounded', async () => {
  const store = memoryStore(),
    app = createApp({store});
  const {install} = require('../examples/stream-workflow/setup.cjs'),
    info = await install(app.api),
    base = `workflows/${info.workflow_id}`;
  await app.api('PUT', 'settings', {run_retention: 4, run_summary_retention: 10});
  const epoch = Date.now() / 1000;
  for (let hour = 1; hour <= 24; hour++) {
    for (let i = 0; i < 5; i++) {
      const run = await app.api('POST', 'hooks/' + info.webhook_token, {dedupe_key: `${hour}/${i}`, value: i});
      await app.eval(`RUNS.byId.get('${run.id}').done`);
    }
    for (let pass = 0; pass < 3; pass++) {
      await app.api('POST', 'scheduler/tick', {now: epoch + hour * 3600});
      await settle(app);
    }
    assert.equal((await app.api('GET', base + '/queues/jobs')).size, 0);
    assert.equal((await app.api('GET', base + '/state/count')).value, hour * 5);
    assert.ok((await app.eval('RUNS.byId.size')) <= 5);
    assert.ok(store.data.size < 150, 'details and blob storage remain bounded');
  }
  assert.equal((await app.api('GET', 'runs/' + info.waiting_run)).status, 'waiting');
});
test('quota windows and token refill are independent and reported units settle a reservation', async () => {
  const {app, base, run} = await fixture(
    'const results=await Promise.allSettled(Array.from({length:3},()=>agentsys("GET","projects")));node.display(results.filter(r=>r.status==="fulfilled").length);'
  );
  await app.api('PUT', base + '/control', {
    quotas: [{key: 'GET projects', limit: 100, capacity: 2, refill_per_second: 1}],
  });
  assert.equal(Object.values((await run()).displays)[0], '2');
  assert.equal(Object.values((await run()).displays)[0], '0');
  await app.eval(
    `exclusive(async()=>{const key='${base}/usage',u=clone(await DB.get(key));u['GET projects'].updated-=2000;await DB.commit({[key]:u});})`
  );
  assert.equal(Object.values((await run()).displays)[0], '2');
  await app.api('PUT', base + '/control', {quotas: [{key: '*', limit: 10, reserve_units: 4}]});
  await app.eval(
    `(async()=>{const r=await reserveBridge({workflow_id:'${base.split('/')[1]}'},'POST','jobs');await settleBridge(r,{usage:{units:2}},null);})()`
  );
  assert.equal((await app.api('GET', base + '/usage'))['*'].used, 2);
});
test('state and queue payloads remain ordinary JSON rather than executable graph writes', async () => {
  const {app, base, run} = await fixture(
    'const value={op:"script",grants:["ordinary-data"],token:"public-value"};await node.state.set("data",value);await node.queue("data").push(value);const e=await node.state.get("data");const [q]=await node.queue("data").pull();node.display(JSON.stringify([e.value,q.value]));'
  );
  const result = await run();
  assert.equal(result.status, 'completed');
  const values = JSON.parse(Object.values(result.displays)[0]);
  assert.deepEqual(values[0], {op: 'script', grants: ['ordinary-data'], token: 'public-value'});
  assert.deepEqual(values[0], values[1]);
  assert.equal(result.replay_available, false);
  await assert.rejects(app.api('POST', `runs/${result.id}/replay`, {wait: 1}), /redacted/);
});
test('a retry whose entry was deleted becomes a failed attempt rather than an immortal pending job', async () => {
  const {app, p, base, run} = await fixture('throw Error("failure");');
  await app.api('PUT', base + '/control', {max_attempts: 2, backoff_ms: 1, pause_after: 1});
  const first = await run();
  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: first.roots});
  await app.api('POST', 'scheduler/tick', {now: Date.now() / 1000 + 1});
  await new Promise(resolve => setTimeout(resolve, 10));
  const control = await app.api('GET', base + '/control');
  assert.equal(control.pending.length, 0);
  assert.equal(control.status, 'paused');
  const attempts = await app.api('GET', 'runs');
  assert.equal(attempts.filter(r => r.retry_of === first.id && r.status === 'failed').length, 1);
});
test('a queue retry uses a free concurrency slot while another activation waits', async () => {
  const {app, p, base} = await fixture(
    'if(context.payload.item.value.wait&&!node.resumed)await node.wait({event:"hold"});if(context.payload.item.value.fail)throw Error("failure");'
  );
  await app.api('PUT', base + '/control', {max_attempts: 2, backoff_ms: 1, pause_after: 100});
  await app.api('POST', 'triggers', {
    name: 'Consumer',
    type: 'queue',
    project_id: p.id,
    queue: 'jobs',
    max_concurrency: 2,
  });
  for (const item of [{wait: true}, {fail: true}]) await app.api('POST', base + '/queues/jobs/push', {item});
  await app.api('POST', 'scheduler/tick', {});
  await settle(app);
  const first = (await app.api('GET', 'runs')).find(r => r.status === 'failed');
  assert.ok(first);
  const tick = await app.api('POST', 'scheduler/tick', {now: Date.now() / 1000 + 1});
  assert.ok(tick.fired.some(r => r.retry_of === first.id));
  await settle(app);
  assert.equal((await app.api('GET', base + '/control')).pending.length, 0);
});
test('queued admission is removed in the same durable commit that creates its run', async () => {
  const store = memoryStore(),
    {app, p, base} = await fixture('if(!node.resumed)await node.wait({event:"next"});', store);
  const trigger = await app.api('POST', 'triggers', {
    name: 'Queued',
    type: 'webhook',
    project_id: p.id,
    overlap: 'queue',
  });
  const first = await app.api('POST', 'hooks/' + trigger.token, {dedupe_key: 'first'});
  await settle(app);
  const queued = await app.api('POST', 'hooks/' + trigger.token, {dedupe_key: 'second'});
  assert.equal(queued.status, 'queued');
  const commit = store.commit;
  store.commit = change => {
    const control = change.set[base + '/control'];
    if (control && !control.pending.some(j => j.id === queued.id) && !store.data.has('runs/' + queued.id))
      assert.ok(change.set['runs/' + queued.id], 'pending delivery cannot disappear before its run is durable');
    commit(change);
  };
  await app.api('POST', 'events/next', {});
  await settle(app);
  await app.api('POST', 'scheduler/tick', {});
  await settle(app);
  assert.equal((await app.api('GET', 'runs/' + queued.id)).status, 'waiting');
});
test('activation lifetime includes pending retry time and cannot be reset by another attempt', async () => {
  const {app, base, run} = await fixture('throw Error("failure");');
  await app.api('PUT', 'settings', {run_lifetime_ms: 100});
  const first = await run();
  await app.api('POST', 'scheduler/tick', {now: first.started + 2});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await app.api('GET', base + '/control')).pending.length, 0);
  const attempts = await app.api('GET', 'runs');
  assert.ok(attempts.some(r => r.retry_of === first.id && r.error === 'Run lifetime exceeded'));
});

test('an offline plan without its replay trace cannot fall through to live bridge calls', async () => {
  const app = createApp();
  await assert.rejects(
    app.eval('bridgeFor({plan:{replay:true}}).request(["GET","projects",{},{}])'),
    /Replay trace is unavailable/
  );
});
test('bridge journal admits exactly its call limit and rejects oversized requests without a live call', async () => {
  const {app, base, run} = await fixture(
    'const r=await Promise.allSettled([agentsys("GET","projects"),agentsys("GET","projects")]);node.display(r.filter(x=>x.status==="fulfilled").length);'
  );
  await app.api('PUT', 'settings', {max_bridge_calls: 1});
  const one = await run();
  assert.equal(Object.values(one.displays)[0], '1');
  assert.equal(one.replay_available, false);
  await assert.rejects(app.api('POST', `runs/${one.id}/replay`, {wait: 1}), /journal limit/);
  assert.equal((await app.eval(`RUNS.byId.get('${one.id}').trace`)).length, 1);
  await app.api('PUT', 'settings', {max_trace_bytes: 1});
  const before = await app.api('GET', base + '/usage');
  const none = await run();
  assert.equal(Object.values(none.displays)[0], '0');
  assert.deepEqual(await app.api('GET', base + '/usage'), before);
});
test('state key capacity and pending admission capacity reject growth instead of dropping work', async () => {
  const {app, p, base} = await fixture('if(!node.resumed)await node.wait({event:"hold-capacity"});');
  await app.api('PUT', 'settings', {state_max_keys: 1});
  await app.api('PUT', base + '/state/one', {value: 1});
  await app.api('DELETE', base + '/state/one');
  await assert.rejects(app.api('PUT', base + '/state/two', {value: 2}), /Too many state keys/);
  await app.api('PUT', base + '/control', {pending_limit: 1});
  const trigger = await app.api('POST', 'triggers', {
    name: 'Bounded',
    type: 'webhook',
    project_id: p.id,
    overlap: 'queue',
  });
  await app.api('POST', 'hooks/' + trigger.token, {});
  await settle(app);
  const accepted = await app.api('POST', 'hooks/' + trigger.token, {});
  assert.equal(accepted.status, 'queued');
  await assert.rejects(app.api('POST', 'hooks/' + trigger.token, {}), /Activation queue is full/);
  assert.equal((await app.api('GET', base + '/control')).pending[0].id, accepted.id);
});
test('reservation overruns fail conservatively and the rule remains exhausted', async () => {
  const {app, p, base} = await fixture();
  await app.api('PUT', base + '/control', {
    quotas: [{key: '*', limit: 2, capacity: 2, reserve_units: 2, refill_per_second: 0.001}],
  });
  await assert.rejects(
    app.eval(
      `(async()=>{const r=await reserveBridge({workflow_id:'${p.id}'},'GET','projects');await settleBridge(r,{usage:{units:3}},null);})()`
    ),
    /exceeds reserve_units/
  );
  assert.equal((await app.api('GET', base + '/usage'))['*'].used, 2);
  await assert.rejects(app.eval(`reserveBridge({workflow_id:'${p.id}'},'GET','projects')`), /Quota exceeded/);
});
