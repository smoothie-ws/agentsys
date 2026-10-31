'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createServer} = require('../server');
const {demonstrate} = require('../examples/durable-process.cjs');
async function childServer(dataDir) {
  const source =
    "const a=require('./server').createServer({dataDir:process.env.AGENTSYS_CRASH_DATA});a.listen(0).then(url=>console.log(url));";
  const child = spawn(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    env: {...process.env, AGENTSYS_CRASH_DATA: dataDir},
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', text => {
      output += text;
      if (output.includes('\n')) resolve(output.trim());
    });
    child.once('error', reject);
    child.once('exit', code => reject(Error('Child server exited ' + code)));
  });
  return {child, base};
}
async function api(base, method, route, body) {
  const response = await fetch(base + '/api/' + route, {
    method,
    headers: {'X-AgentSys': '1', 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
test('storage compare-and-set is atomic between HTTP storage clients and the backend', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-cas-')),
    server = createServer({dataDir}),
    base = await server.listen(0);
  try {
    const update = value =>
      fetch(base + '/__data', {
        method: 'POST',
        headers: {'X-AgentSys': '1', 'Content-Type': 'application/json'},
        body: JSON.stringify({set: {'test-cas': {version: 1, value}}, if_versions: {'test-cas': 0}}),
      });
    const results = await Promise.all([update('left'), update('right')]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const current = await (await fetch(base + '/__data/test-cas')).json();
    assert.equal(current.version, 1);
  } finally {
    await server.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});
test('a killed server restores completed history, marks active dispatches interrupted, and never replays external operations', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-crash-'));
  let running;
  try {
    running = await childServer(dataDir);
    let base = running.base;
    await api(base, 'PUT', 'settings', {developer_mode: true});
    const p = await api(base, 'POST', 'projects', {name: 'Crash recovery'}),
      root = `projects/${p.id}/execution`;
    const {types} = await api(base, 'GET', `projects/${p.id}/types`),
      codeType = types.find(t => t.control === 'code').id;
    const make = code =>
      api(base, 'POST', `projects/${p.id}/typed-nodes`, {
        node_type: 'custom',
        config: {
          title: 'Crash body',
          op: 'script',
          inputs: [
            {id: 'in', name: 'in', type: 'signal'},
            {id: 'script', name: 'script', type: 't:' + codeType, default: code},
          ],
          outputs: [{id: 'out', name: 'out', type: 'signal'}],
        },
      });
    const done = await make('context.state.completed=42;');
    const complete = await api(base, 'POST', root, {node_ids: [done.id], wait: true});
    let op = await api(base, 'POST', root + '/operations', {
      id: 'external',
      input: {request: 'opaque-reference'},
      policy: 'manual',
    });
    op = await api(base, 'PUT', root + '/operations/external', {version: op.version, status: 'running'});
    const loop = await make('context.state.running=true;while(true){}');
    const active = await api(base, 'POST', root, {node_ids: [loop.id]});
    for (let i = 0; i < 100; i++) {
      if ((await api(base, 'GET', root)).state.running) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const killed = once(running.child, 'exit');
    running.child.kill('SIGKILL');
    await killed;
    running = await childServer(dataDir);
    base = running.base;
    const history = await api(base, 'GET', root + '/dispatches');
    assert.equal(history.find(r => r.dispatch_id === complete.dispatch_id).status, 'completed');
    assert.equal(history.find(r => r.dispatch_id === active.dispatch_id).status, 'interrupted');
    const restored = await api(base, 'GET', root + '/operations/external');
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.uncertain, true);
    assert.equal(restored.attempt, 1);
    assert.equal((await api(base, 'GET', root)).state.completed, 42);
    assert.equal((await api(base, 'GET', root)).active_signals, 0);
    const trace = await api(base, 'GET', root + '/trace');
    assert.ok(trace.events.some(e => e.type === 'dispatch.end' && e.status === 'interrupted'));
  } finally {
    if (running?.child.exitCode === null) {
      const ended = once(running.child, 'exit');
      running.child.kill('SIGKILL');
      await ended;
    }
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});
test('the non-LLM readiness example joins independent results and retries after restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-readiness-'));
  try {
    const result = await demonstrate(dataDir);
    assert.equal(result.result, 42);
    assert.equal(result.dispatches, 2);
    assert.equal(result.operations.find(o => o.id === 'combine').attempt, 2);
  } finally {
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});
