'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('../server');
const {install} = require('../examples/stream-workflow/setup.cjs');
test('the stream example survives HTTP server restart, a failing activation and event delivery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-stream-'));
  let server, url;
  const open = async () => {
    server = createServer({dataDir: directory, scheduler: false});
    url = await server.listen(0);
  };
  await open();
  t.after(async () => {
    await server.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const call = async (method, route, body, query) => {
    const response = await fetch(url + '/api/' + route + (query ? '?' + new URLSearchParams(query) : ''), {
      method,
      headers: {'Content-Type': 'application/json', 'X-AgentSys': '1'},
      ...(body == null || method === 'GET' ? {} : {body: JSON.stringify(body)}),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const wait = async id => {
    for (let i = 0; i < 500; i++) {
      const run = await call('GET', 'runs/' + id);
      if (run.status !== 'running') return run;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('Run did not finish');
  };
  const info = await install(call),
    base = `workflows/${info.workflow_id}`;
  await call('PUT', base + '/control', {max_attempts: 1});
  const send = async value => {
    const response = await fetch(url + '/hooks/' + info.webhook_token, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(value),
    });
    const run = await response.json();
    await wait(run.id);
  };
  await send({dedupe_key: 'delivery-1', value: 7});
  assert.equal((await call('GET', base + '/queues/jobs')).size, 1);
  await server.close();
  await open();
  const tick = await call('POST', 'scheduler/tick', {});
  assert.equal((await wait(tick.fired[0].run_id)).status, 'completed');
  assert.equal((await call('GET', base + '/state/count')).value, 1);
  await send({dedupe_key: 'delivery-1', value: 7});
  assert.equal((await call('GET', base + '/queues/jobs')).size, 0);
  await send({dedupe_key: 'delivery-2', fail: true});
  const failed = await call('POST', 'scheduler/tick', {});
  assert.equal((await wait(failed.fired[0].run_id)).status, 'failed');
  assert.equal((await call('GET', base + '/control')).status, 'enabled');
  assert.equal((await call('GET', base + '/queues/jobs')).size, 1);
  const [poison] = await call('POST', base + '/queues/jobs/pull', {visibility_ms: 10000});
  // The failed element has a backoff; advance only the queue visibility for this external inspection.
  if (poison) await call('POST', base + '/queues/jobs/ack', {id: poison.id});
  await send({dedupe_key: 'delivery-3', value: 8});
  const next = await call('POST', 'scheduler/tick', {});
  await Promise.all(next.fired.map(r => wait(r.run_id)));
  assert.equal((await call('GET', base + '/state/count')).value, 2);
  await call('POST', 'events/stream-answer', {answer: 42});
  assert.equal((await wait(info.waiting_run)).status, 'completed');
  assert.equal((await call('GET', base + '/state/answer')).value.answer, 42);
  assert.ok(fs.existsSync(path.join(directory, 'workflows', info.workflow_id, 'queues/jobs/journal.jsonl')));
  assert.ok(fs.existsSync(path.join(directory, 'runs', info.waiting_run, 'events.jsonl')));
  await call('PUT', base + '/state/with:dot.key', {value: 42});
  await server.close();
  await open();
  assert.equal((await call('GET', base + '/state/with:dot.key')).value, 42);
  const completed = await call('GET', 'runs/' + next.fired[0].run_id);
  const invocation = completed.invocations.find(i => i.schema?.length === 0 && i.scope?.startsWith('complex:'));
  assert.ok(invocation, 'a completed Script retains its boundary without node.wait');
  const replaced = await call('POST', `runs/${completed.id}/output`, {
    invocation: invocation.invocation,
    output: {},
    signals: [],
    wait: 2,
  });
  assert.equal(replaced.status, 'completed', JSON.stringify(replaced.errors));
  assert.equal(replaced.restarted_from, completed.id);
  assert.equal(
    (await call('GET', base + '/state/count')).value,
    2,
    'manual output bypasses the completed counter code'
  );
});
test('startup redoes a multi-key transaction and repairs a torn queue journal append', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-redo-'));
  const first = {op: 'push', item: {id: 'one', value: 1, visible_at: 0}},
    second = {op: 'push', item: {id: 'two', value: 2, visible_at: 0}};
  const journal = path.join(directory, 'workflows/w/queues/jobs/journal.jsonl');
  fs.mkdirSync(path.dirname(journal), {recursive: true});
  fs.writeFileSync(journal, JSON.stringify(first) + '\n{"op":"push","item":');
  fs.writeFileSync(
    path.join(directory, '.transaction.json'),
    JSON.stringify({
      set: {
        projects: [{id: 'p', name: 'Recovered', workflows: [{id: 'w', name: 'Main'}]}],
        'workflows/w/queues/jobs/journal': [first, second],
        'workflows/w/queue_index': ['jobs'],
        'workflows/w/state_index': {bytes: 2, entries: {count: {version: 1, bytes: 2, present: true}}},
        'workflows/w/state/count': {key: 'count', value: 42, version: 1},
      },
      remove: [],
    })
  );
  const server = createServer({dataDir: directory, scheduler: false}),
    url = await server.listen(0);
  t.after(async () => {
    await server.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const state = await fetch(url + '/api/workflows/w/state/count').then(r => r.json());
  assert.equal(state.value, 42);
  const items = await fetch(url + '/api/workflows/w/queues/jobs/pull', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-AgentSys': '1'},
    body: '{"max":2}',
  }).then(r => r.json());
  assert.deepEqual(
    items.map(i => i.value),
    [1, 2]
  );
  assert.equal(fs.existsSync(path.join(directory, '.transaction.json')), false);
  assert.ok(
    fs
      .readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .every(line => JSON.parse(line))
  );
});
