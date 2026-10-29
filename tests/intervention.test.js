'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, nodes, bundleOf, place} = require('./harness');
const {loadBackend} = require('../headless');
const tick = () => new Promise(r => setTimeout(r, 5));
async function eventually(read, check = Boolean) {
  for (let i = 0; i < 600; i++) {
    const value = await read();
    if (check(value)) return value;
    await tick();
  }
  throw Error('Condition not reached');
}
const storeOf = () => {
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
async function fixture(scripts = 'inline', store = null) {
  const app = createApp({scripts, store});
  const p = await app.api('POST', 'projects', {name: 'Intervention'});
  return {
    app,
    p,
    base: `projects/${p.id}`,
    state: async key => (await app.api('GET', `workflows/${p.id}/state/${key}`)).value,
  };
}
async function connect(app, base, source, target, data = true) {
  await app.api('POST', base + '/port-connections', {
    add: [
      {source: source.wrapper, source_port: 'out', target: target.wrapper, target_port: 'in'},
      ...(data ? [{source: source.wrapper, source_port: 'value', target: target.wrapper, target_port: 'value'}] : []),
    ],
  });
}
const run = (app, base, ids) => app.api('POST', base + '/runs', {node_ids: ids, wait: 2});
const replace = (app, id, invocation, output, signals = ['out']) =>
  app.api('POST', `runs/${id}/output`, {invocation, output, signals, wait: 2});

test('a completed invocation without wait can be replaced; its dependent reruns and independent work stays completed; recovery replays offline', async () => {
  const {app, p, base, state} = await fixture('worker');
  const producer = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.value=1;await node.emit("out");', outputs: ['value'], signals: ['out']}
  );
  const consumer = await fn(
    app,
    p.id,
    {},
    {inputs: ['value'], code: 'node.display(node.input.value*2);await node.state.update("dependent",x=>(x??0)+1);'}
  );
  const independent = await fn(
    app,
    p.id,
    {},
    {code: 'await node.state.update("independent",x=>(x??0)+1);node.display("kept");'}
  );
  await connect(app, base, producer, consumer);
  const original = await run(app, base, [producer.id, independent.id]);
  const replacement = await replace(app, original.id, `root:${producer.id}`, {value: 10});
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(replacement.restarted_from, original.id);
  assert.equal(replacement.displays[consumer.id], '20');
  assert.equal(replacement.displays[independent.id], 'kept');
  assert.equal(await state('dependent'), 2);
  assert.equal(await state('independent'), 1);
  assert.equal((await app.api('GET', 'runs/' + original.id)).displays[consumer.id], '2');
  const replay = await app.api('POST', `runs/${replacement.id}/replay`, {wait: 3});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
  assert.deepEqual(replay.outputs, replacement.outputs);
  assert.equal(await state('dependent'), 2);
  assert.equal(await state('independent'), 1);
});

test('a failed Script before emit accepts data and explicit signal selection, and its pending automatic retry is removed', async () => {
  const {app, p, base, state} = await fixture();
  const producer = await fn(
    app,
    p.id,
    {},
    {code: 'throw Error("broken");', outputs: ['value'], signals: ['out', 'other']}
  );
  const consumer = await fn(
    app,
    p.id,
    {},
    {inputs: ['value'], code: 'await node.state.set("answer",node.input.value);'}
  );
  await connect(app, base, producer, consumer);
  const original = await run(app, base, [producer.id]);
  assert.equal(original.status, 'failed');
  const replacement = await replace(app, original.id, `root:${producer.id}`, {value: 42});
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(await state('answer'), 42);
  assert.ok(!(await app.api('GET', `workflows/${p.id}/control`)).pending.some(job => job.retry_of === original.id));
});

test('only the selected repeated invocation and its dependent branch execute again', async () => {
  const {app, p, base, state} = await fixture();
  const producer = await fn(
    app,
    p.id,
    {},
    {
      inputs: ['value'],
      outputs: ['value'],
      signals: ['out'],
      code: 'node.output.value=node.input.value;await node.emit("out");',
    }
  );
  const driver = await fn(
    app,
    p.id,
    {},
    {
      outputs: ['value'],
      signals: ['out'],
      code: 'for(const value of [1,2]){node.output.value=value;await node.emit("out");}',
    }
  );
  const consumer = await fn(
    app,
    p.id,
    {},
    {inputs: ['value'], code: 'await node.state.update("seen",x=>[...(x??[]),node.input.value]);'}
  );
  await connect(app, base, driver, producer);
  await connect(app, base, producer, consumer);
  const original = await run(app, base, [driver.id]);
  const calls = original.invocations.filter(i => i.node_id === producer.id);
  assert.equal(calls.length, 2);
  const replacement = await replace(app, original.id, calls.find(i => i.output_value.value === 1).invocation, {
    value: 9,
  });
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.deepEqual(await state('seen'), [1, 2, 9]);
});

test('completed recovery data and invocation dependencies survive a backend restart', async () => {
  const store = storeOf(),
    {app, p, base} = await fixture('worker', store);
  const producer = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.value=1;await node.emit("out");', outputs: ['value'], signals: ['out']}
  );
  const consumer = await fn(app, p.id, {}, {inputs: ['value'], code: 'node.display(node.input.value);'});
  await connect(app, base, producer, consumer);
  const original = await run(app, base, [producer.id]);
  const next = loadBackend({store});
  const replacement = await next.Backend.request('POST', `runs/${original.id}/output`, {
    body: {invocation: `root:${producer.id}`, output: {value: 7}, signals: ['out'], wait: 2},
  });
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(replacement.displays[consumer.id], '7');
});

test('invalid replacement requests do not stop a run or create new activations', async () => {
  const {app, p, base} = await fixture();
  const n = await fn(app, p.id, {}, {code: 'node.output.value=1;', outputs: ['value'], signals: ['out']});
  const original = await run(app, base, [n.id]);
  const count = (await app.api('GET', 'runs')).length;
  for (const body of [
    {invocation: 'missing', output: {value: 1}, signals: []},
    {invocation: `root:${n.id}`, output: {unknown: 1}, signals: []},
    {invocation: `root:${n.id}`, output: [], signals: []},
    {invocation: `root:${n.id}`, output: {value: 1}, signals: ['unknown']},
    {invocation: `root:${n.id}`, output: {value: 1}},
  ])
    await assert.rejects(app.api('POST', `runs/${original.id}/output`, body));
  assert.equal((await app.api('GET', 'runs')).length, count);
  assert.equal((await app.api('GET', 'runs/' + original.id)).status, 'completed');
});

test('cancelling a suspended child wave preserves its waiting sibling and does not require a Worker to remain alive', async () => {
  const {app, p, base, state} = await fixture('worker');
  const parent = await fn(
    app,
    p.id,
    {},
    {signals: ['out'], code: 'await node.emit("out");await node.state.set("continued",true);'}
  );
  const wait = await fn(
    app,
    p.id,
    {},
    {code: 'if(!node.resumed)await node.wait({event:"cancel-me"});await node.state.set("wrong",true);'}
  );
  const sibling = await fn(
    app,
    p.id,
    {},
    {code: 'if(!node.resumed)await node.wait({event:"keep-me"});await node.state.set("kept",true);'}
  );
  await connect(app, base, parent, wait, false);
  const original = await run(app, base, [parent.id, sibling.id]);
  assert.equal(original.status, 'waiting');
  const path = original.invocations.find(i => i.node_id === wait.id).wave_path;
  await app.api('POST', `runs/${original.id}/waves/cancel`, {path});
  await app.eval(`RUNS.byId.get('${original.id}').done`);
  const waiting = await app.api('GET', 'runs/' + original.id);
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(
    waiting.waits.map(w => w.wait_spec.event),
    ['keep-me']
  );
  assert.equal(await state('continued'), true);
  await assert.rejects(app.api('GET', `workflows/${p.id}/state/wrong`), /No such/);
  await app.api('POST', 'events/keep-me', {answer: 1});
  await app.eval(`RUNS.byId.get('${original.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + original.id)).status, 'completed');
  assert.equal(await state('kept'), true);
});

test('live wave cancellation is cooperative and prevents later emits from starting children', async () => {
  const {app, p, base, state} = await fixture('worker');
  let release;
  app.context.fetch = () => new Promise(resolve => (release = () => resolve({status: 200, text: async () => ''})));
  const parent = await fn(
    app,
    p.id,
    {},
    {signals: ['out'], code: 'await node.emit("out");await node.state.set("parent",true);'}
  );
  const child = await fn(
    app,
    p.id,
    {},
    {signals: ['out'], code: 'await agentsys("POST","net",{url:"https://hold.test"});await node.emit("out");'}
  );
  const tail = await fn(app, p.id, {}, {code: 'await node.state.set("wrong",true);'});
  await connect(app, base, parent, child, false);
  await connect(app, base, child, tail, false);
  const r = await app.api('POST', base + '/runs', {node_ids: [parent.id]});
  await eventually(() => release);
  const detail = await app.api('GET', 'runs/' + r.id);
  const path = detail.invocations.find(i => i.node_id === child.id).wave_path;
  await app.api('POST', `runs/${r.id}/waves/cancel`, {path});
  release();
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'completed');
  assert.equal(await state('parent'), true);
  await assert.rejects(app.api('GET', `workflows/${p.id}/state/wrong`), /No such/);
  const replay = await app.api('POST', `runs/${r.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
});

test('targeted payload delivery resumes exactly one invocation and never leaks through the event inbox', async () => {
  const {app, p, base} = await fixture('worker');
  const a = await fn(
    app,
    p.id,
    {},
    {
      code: 'if(!node.resumed)await node.wait({event:"shared",match:{id:42}});node.display(JSON.stringify(node.resumed.value));',
    }
  );
  const b = await fn(
    app,
    p.id,
    {},
    {code: 'if(!node.resumed)await node.wait({event:"shared",match:{id:42}});node.display("second");'}
  );
  const r = await run(app, base, [a.id, b.id]);
  const target = {run_id: r.id, key: r.waits.find(w => w.node_id === a.id).key};
  await assert.rejects(app.api('POST', 'events/shared', {id: 1}, target), /does not match/);
  await assert.rejects(app.api('POST', 'events/shared', {id: 42}, {...target, key: 'missing'}), /does not match/);
  await app.api('POST', 'events/shared', {id: 42, answer: {value: 7}}, target);
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  const waiting = await app.api('GET', 'runs/' + r.id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waits.length, 1);
  assert.equal(waiting.waits[0].node_id, b.id);
  assert.equal(waiting.displays[a.id], '{"id":42,"answer":{"value":7}}');
  await app.api('POST', 'scheduler/tick', {});
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'waiting');
  await app.api('POST', 'events/shared', {id: 42}, {run_id: r.id, key: waiting.waits[0].key});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'completed');
});

test('a targeted answer held while workflow is paused survives a server restart', async () => {
  const store = storeOf(),
    {app, p, base} = await fixture('worker', store);
  const n = await fn(
    app,
    p.id,
    {},
    {code: 'if(!node.resumed)await node.wait({event:"answer"});node.display(node.resumed.value.text);'}
  );
  const r = await run(app, base, [n.id]);
  await app.api('PUT', `workflows/${p.id}/control`, {status: 'paused'});
  await app.api('POST', 'events/answer', {text: 'retained'}, {run_id: r.id, key: r.waits[0].key});
  const next = loadBackend({store});
  await next.Backend.request('PUT', `workflows/${p.id}/control`, {body: {status: 'enabled'}});
  await next.Backend.request('POST', 'scheduler/tick');
  await next.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await next.Backend.request('GET', 'runs/' + r.id)).displays[n.id], 'retained');
});

test('a waiting invocation can be replaced and its dependent may wait again and resume', async () => {
  const {app, p, base} = await fixture('worker');
  const producer = await fn(
    app,
    p.id,
    {},
    {outputs: ['value'], signals: ['out'], code: 'await node.wait({event:"original"});'}
  );
  const consumer = await fn(
    app,
    p.id,
    {},
    {
      inputs: ['value'],
      code: 'if(!node.resumed)await node.wait({event:"dependent"});node.display(node.input.value+node.resumed.value.add);',
    }
  );
  await connect(app, base, producer, consumer);
  const r = await run(app, base, [producer.id]);
  const replacement = await replace(app, r.id, `root:${producer.id}`, {value: 5});
  assert.equal(replacement.status, 'waiting', JSON.stringify(replacement.errors));
  assert.equal(replacement.waits[0].wait_spec.event, 'dependent');
  await app.api('POST', 'events/dependent', {add: 3});
  await app.eval(`RUNS.byId.get('${replacement.id}').done`);
  const done = await app.api('GET', 'runs/' + replacement.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.errors));
  assert.equal(done.displays[consumer.id], '8');
  const replay = await app.api('POST', `runs/${done.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
});

test('an active invocation can be replaced from its retained boundary and the original Worker stops', async () => {
  const {app, p, base, state} = await fixture('worker');
  const n = await fn(
    app,
    p.id,
    {},
    {
      outputs: ['value'],
      signals: ['out'],
      code: 'await new Promise(r=>setTimeout(r,5000));await node.state.set("wrong",true);',
    }
  );
  const consumer = await fn(app, p.id, {}, {inputs: ['value'], code: 'node.display(node.input.value);'});
  await connect(app, base, n, consumer);
  const r = await app.api('POST', base + '/runs', {node_ids: [n.id]});
  await eventually(
    () => app.api('GET', 'runs/' + r.id),
    d => d.invocations.some(i => i.node_id === n.id && i.schema)
  );
  const replacement = await replace(app, r.id, `root:${n.id}`, {value: 12});
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(replacement.displays[consumer.id], '12');
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'cancelled');
  await assert.rejects(app.api('GET', `workflows/${p.id}/state/wrong`), /No such/);
});

test('a dependent in another root reads the replaced invocation result', async () => {
  const {app, p, base} = await fixture();
  const producer = await fn(app, p.id, {}, {outputs: ['value'], signals: ['out'], code: 'node.output.value=2;'});
  const consumer = await fn(app, p.id, {}, {inputs: ['value'], code: 'node.display(node.input.value);'});
  await app.api('POST', base + '/port-connections', {
    add: [{source: producer.wrapper, source_port: 'value', target: consumer.wrapper, target_port: 'value'}],
  });
  // Complete producer before reading its latest output from the independent root.
  const root = await fn(
    app,
    p.id,
    {},
    {signals: ['First', 'Second'], code: 'await node.emit("First");await node.emit("Second");'}
  );
  await app.api('POST', base + '/port-connections', {
    add: [
      {source: root.wrapper, source_port: 'First', target: producer.wrapper, target_port: 'in'},
      {source: root.wrapper, source_port: 'Second', target: consumer.wrapper, target_port: 'in'},
    ],
  });
  const r = await run(app, base, [root.id]);
  const target = r.invocations.find(i => i.node_id === producer.id);
  const replacement = await replace(app, r.id, target.invocation, {value: 9}, []);
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(replacement.displays[consumer.id], '9');
});

test('cancel-wave validates identity and status before changing durable control', async () => {
  const {app, p, base} = await fixture();
  const n = await fn(app, p.id, {}, {code: 'await node.wait({event:"wait"});'});
  const r = await run(app, base, [n.id]);
  await assert.rejects(app.api('POST', `runs/${r.id}/waves/cancel`, {path: 'missing'}), /Unknown wave/);
  await assert.rejects(app.api('POST', 'runs/missing/waves/cancel', {path: 'run'}), /not found/);
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'waiting');
  await app.api('POST', `runs/${r.id}/waves/cancel`, {path: 'run'});
  await app.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await app.api('GET', 'runs/' + r.id)).status, 'completed');
  await assert.rejects(app.api('POST', `runs/${r.id}/waves/cancel`, {path: 'run'}), /not active/);
});

test('wave cancellation requested while workflow is paused resumes after a backend restart and enable', async () => {
  const store = storeOf(),
    {app, p, base} = await fixture('worker', store);
  const n = await fn(app, p.id, {}, {code: 'await node.wait({event:"never"});'});
  const r = await run(app, base, [n.id]);
  await app.api('PUT', `workflows/${p.id}/control`, {status: 'paused'});
  await app.api('POST', `runs/${r.id}/waves/cancel`, {path: 'run'});
  const next = loadBackend({store});
  await next.Backend.request('PUT', `workflows/${p.id}/control`, {body: {status: 'enabled'}});
  await next.Backend.request('POST', 'scheduler/tick');
  await next.eval(`RUNS.byId.get('${r.id}').done`);
  assert.equal((await next.Backend.request('GET', 'runs/' + r.id)).status, 'completed');
});

test('a durable output-restart request completes once after a backend restart', async () => {
  const store = storeOf(),
    {app, p, base} = await fixture('worker', store);
  const n = await fn(app, p.id, {}, {outputs: ['value'], code: 'node.output.value=1;'});
  const r = await run(app, base, [n.id]);
  await app.eval(
    `exclusive(async()=>{const run=RUNS.byId.get('${r.id}');run.restarting=true;run.restart_request={id:uid(),at:Date.now(),replacement:replacementSpec(run,{invocation:'root:${n.id}',output:{value:8},signals:[]},run.plan)};await persistRun(run,true);})`
  );
  const next = loadBackend({store});
  const result = await eventually(
    () => next.Backend.request('GET', 'runs'),
    runs => runs.some(x => x.restarted_from === r.id && x.status === 'completed')
  );
  assert.equal(result.filter(x => x.restarted_from === r.id).length, 1);
  const fork = result.find(x => x.restarted_from === r.id);
  assert.equal((await next.Backend.request('GET', 'runs/' + fork.id)).outputs[n.id].value, 8);
  const again = loadBackend({store});
  await again.Backend.request('GET', 'runs');
  await tick();
  assert.equal((await again.Backend.request('GET', 'runs')).filter(x => x.restarted_from === r.id).length, 1);
});

test('an old and a newly selected signal never reuse the same child invocation path', async () => {
  const {app, p, base, state} = await fixture();
  const producer = await fn(app, p.id, {}, {signals: ['out', 'other'], code: 'await node.emit("out");'});
  const consumer = await fn(app, p.id, {}, {code: 'await node.state.update("calls",x=>(x??0)+1);'});
  await app.api('POST', base + '/port-connections', {
    add: ['out', 'other'].map(source_port => ({
      source: producer.wrapper,
      source_port,
      target: consumer.wrapper,
      target_port: 'in',
    })),
  });
  const r = await run(app, base, [producer.id]);
  const replacement = await replace(app, r.id, `root:${producer.id}`, {}, ['other', 'out']);
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(await state('calls'), 3);
});

test('a failed atomic fork commit retains a retryable intent without an orphan activation', async () => {
  const store = storeOf(),
    normal = store.commit;
  let fail = false;
  store.commit = changes => {
    if (fail && Object.values(changes.set).some(v => v?.restarted_from)) {
      fail = false;
      throw Error('simulated disk error');
    }
    return normal(changes);
  };
  const {app, p, base} = await fixture('worker', store);
  const n = await fn(app, p.id, {}, {outputs: ['value'], code: 'node.output.value=1;'});
  const r = await run(app, base, [n.id]);
  fail = true;
  await assert.rejects(replace(app, r.id, `root:${n.id}`, {value: 4}, []), /disk error/);
  assert.equal((await app.api('GET', 'runs')).filter(x => x.restarted_from === r.id).length, 0);
  const next = loadBackend({store});
  const runs = await eventually(
    () => next.Backend.request('GET', 'runs'),
    list => list.some(x => x.restarted_from === r.id && x.status === 'completed')
  );
  assert.equal(runs.filter(x => x.restarted_from === r.id).length, 1);
});

test('a completed on_read invocation is replaced when its consumer is read again', async () => {
  const {app, p, base, state} = await fixture('worker');
  const scope = await place(
    app,
    p.id,
    {},
    bundleOf(
      'Read replacement',
      {
        Read: nodes.event('on_read'),
        Script: nodes.script(
          'const value=await node.state.update("read-count",x=>(x??0)+1);node.output.value=value.value;'
        ),
      },
      {wires: [['Read', 'out', 'Script', 'in']], outputs: [{id: 'value', name: 'value', node: false}]}
    )
  );
  const consumer = await fn(app, p.id, {}, {inputs: ['value'], code: 'node.display(node.input.value);'});
  await app.api('POST', base + '/port-connections', {
    add: [{source: scope.id, source_port: 'value', target: consumer.wrapper, target_port: 'value'}],
  });
  const r = await run(app, base, [consumer.id]);
  const target = r.invocations.find(i => i.node_id !== consumer.id && i.schema?.some(p => p.name === 'value'));
  const replacement = await replace(app, r.id, target.invocation, {value: 50}, []);
  assert.equal(replacement.status, 'completed', JSON.stringify(replacement.errors));
  assert.equal(replacement.displays[consumer.id], '50');
  assert.equal(await state('read-count'), 1);
  assert.ok(
    replacement.invocations.some(i => i.invocation === target.invocation && i.overridden && i.status === 'done')
  );
  const replay = await app.api('POST', `runs/${replacement.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
});

test('a restart recovered while workflow is paused starts no dependent code until enable', async () => {
  const store = storeOf(),
    {app, p, base} = await fixture('worker', store);
  const producer = await fn(
    app,
    p.id,
    {},
    {outputs: ['value'], signals: ['out'], code: 'node.output.value=1;await node.emit("out");'}
  );
  const consumer = await fn(app, p.id, {}, {inputs: ['value'], code: 'node.display(node.input.value);'});
  await connect(app, base, producer, consumer);
  const r = await run(app, base, [producer.id]);
  await app.eval(
    `exclusive(async()=>{const run=RUNS.byId.get('${r.id}');run.restarting=true;run.restart_request={id:uid(),at:Date.now(),replacement:replacementSpec(run,{invocation:'root:${producer.id}',output:{value:7},signals:['out']},run.plan)};await persistRun(run,true);})`
  );
  await app.api('PUT', `workflows/${p.id}/control`, {status: 'paused'});
  const next = loadBackend({store});
  const list = await eventually(
    () => next.Backend.request('GET', 'runs'),
    list => list.some(x => x.restarted_from === r.id)
  );
  const fork = list.find(x => x.restarted_from === r.id);
  await tick();
  const paused = await next.Backend.request('GET', 'runs/' + fork.id);
  assert.equal(paused.status, 'running');
  assert.equal(paused.paused, true);
  assert.equal(paused.displays[consumer.id], undefined);
  await next.Backend.request('PUT', `workflows/${p.id}/control`, {body: {status: 'enabled'}});
  await next.eval(`RUNS.byId.get('${fork.id}').done`);
  assert.equal((await next.Backend.request('GET', 'runs/' + fork.id)).displays[consumer.id], '7');
});

test('ancestor idempotency keys are retained while recomputed dependents get a fresh key that replay preserves', async () => {
  const {app, p, base, state} = await fixture();
  const parent = await fn(
    app,
    p.id,
    {},
    {signals: ['out'], code: 'await node.state.set("ancestor-key",node.runKey);await node.emit("out");'}
  );
  const producer = await fn(
    app,
    p.id,
    {},
    {outputs: ['value'], signals: ['out'], code: 'node.output.value=1;await node.emit("out");'}
  );
  const child = await fn(
    app,
    p.id,
    {},
    {inputs: ['value'], code: 'await node.state.set("dependent-key",node.runKey);'}
  );
  await connect(app, base, parent, producer, false);
  await connect(app, base, producer, child);
  const source = await run(app, base, [parent.id]),
    ancestorKey = await state('ancestor-key'),
    dependentKey = await state('dependent-key');
  const target = source.invocations.find(i => i.node_id === producer.id);
  const replacement = await replace(app, source.id, target.invocation, {value: 8});
  assert.equal(replacement.status, 'completed');
  assert.equal(await state('ancestor-key'), ancestorKey);
  assert.notEqual(await state('dependent-key'), dependentKey);
  const replay = await app.api('POST', `runs/${replacement.id}/replay`, {wait: 2});
  assert.equal(replay.status, 'completed', JSON.stringify(replay.errors));
});

test('Script capabilities cannot invoke the human output-replacement endpoint', async () => {
  const {app, p, base} = await fixture();
  const sourceNode = await fn(app, p.id, {}, {outputs: ['value'], code: 'node.output.value=1;'});
  const source = await run(app, base, [sourceNode.id]);
  const attacker = await fn(
    app,
    p.id,
    {},
    {
      capabilities: ['run.read'],
      code: `await agentsys('POST','runs/${source.id}/output',{invocation:'root:${sourceNode.id}',output:{value:9},signals:[]});`,
    }
  );
  const denied = await run(app, base, [attacker.id]);
  assert.equal(denied.status, 'failed');
  assert.match(JSON.stringify(denied.errors), /Permission denied/);
  assert.equal((await app.api('GET', 'runs')).filter(r => r.restarted_from === source.id).length, 0);
});
