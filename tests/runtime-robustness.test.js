'use strict';
// Runtime behaviour under repetition: parallel signals, Stop from a paused state, and bounded worker/runtime
// lifetimes. Every scenario uses a temporary in-memory backend and leaves no runtime behind.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes} = require('./harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  assert.fail('not reached: ' + what);
}

async function scriptWorkflow(app, name, code, {grants} = {}) {
  const project = await app.api('POST', 'projects', {name});
  const query = {workflow_id: project.id};
  const event = await app.api('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
  const script = await app.api('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 100, y: 0}});
  await app.api('PUT', `projects/${project.id}/input-values`, {...query, node_id: script.id, values: {script: code}});
  if (grants)
    await app.api('PUT', `projects/${project.id}/node-permissions/${script.id}`, {...query, grants});
  await app.api('POST', `projects/${project.id}/port-connections`, {
    ...query,
    add: [{source: event.id, source_port: 'out', target: script.id, target_port: 'in'}],
  });
  return {project, workflow: project.id, event, script};
}

test('parallel signals overlap safely and leave one idle runtime', async () => {
  const app = createApp({scripts: 'worker'});
  try {
    const {project, workflow, event, script} = await scriptWorkflow(
      app,
      'Parallel',
      `context.state.count = (context.state.count || 0) + 1;
       await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 12)));
       node.display('count ' + context.state.count);`
    );
    const signals = Array.from({length: 25}, () =>
      app.api('POST', `projects/${project.id}/execution`, {workflow_id: workflow, node_ids: [event.id]})
    );
    const answers = await Promise.all(signals);
    assert.equal(answers.length, 25);
    await until(async () => (await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow})).active_signals === 0, 'all signals settle');
    const detail = await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(detail.errors.host, undefined, JSON.stringify(detail.errors));
    assert.equal(detail.errors[script.id], undefined, JSON.stringify(detail.errors));
    assert.equal(detail.state.count, 25, 'every signal ran exactly once');
    assert.equal(detail.status, 'idle');
    assert.equal(detail.runs[script.id], 25, '25 completed passes were counted');
    assert.ok(app.workerStats.started >= 1, 'work ran in a worker');
    await app.api('DELETE', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'Stop released the worker');
  } finally {
    await app.Backend.shutdownExecutions();
  }
});

test('Stop while paused cancels the work and releases the host', async () => {
  const app = createApp({scripts: 'worker'});
  try {
    const {project, workflow, event, script} = await scriptWorkflow(
      app,
      'Paused stop',
      `context.state.started = true;
       await new Promise(resolve => setTimeout(resolve, 2000));
       context.state.finished = true;
       node.display('finished');`
    );
    await app.api('POST', `projects/${project.id}/execution`, {workflow_id: workflow, node_ids: [event.id]});
    await until(
      async () => (await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow})).state.started === true,
      'run started'
    );
    await app.api('POST', `projects/${project.id}/execution/pause`, {workflow_id: workflow});
    let detail = await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(detail.paused, true);
    const stopped = await app.api('DELETE', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(stopped.paused, false);
    assert.equal(stopped.active_signals, 0);
    assert.notEqual(stopped.nodes.find(node => node.node_id === script.id)?.status, 'running');
    detail = await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(detail.state.finished, undefined, 'the delayed continuation never ran');
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'the worker exited');
  } finally {
    await app.Backend.shutdownExecutions();
  }
});

test('idle runtimes are evicted and the worker pool stays bounded over many runs', async () => {
  const app = createApp({scripts: 'worker'});
  try {
    let last;
    for (let i = 0; i < 20; i++) {
      last = await scriptWorkflow(app, 'Visit ' + i, 'node.display("run ' + i + '");');
      await app.api('POST', `projects/${last.project.id}/execution`, {
        workflow_id: last.workflow,
        node_ids: [last.event.id],
        wait: true,
      });
      await app.api('GET', `projects/${last.project.id}/execution`, {}, {workflow_id: last.workflow});
    }
    const live = app.eval('GRAPH_RUNTIMES.size');
    assert.ok(live <= 16, `idle runtimes are bounded (${live})`);
    const diagnostics = app.Backend.diagnostics();
    assert.equal(diagnostics.runtimes.filter(entry => entry.status !== 'idle').length, 0);
    await until(
      () => app.workerStats.started - app.workerStats.exited <= live,
      'evicted runtimes released their workers'
    );
    // The last workflow still reads its saved result after its runtime was released and rebuilt.
    const detail = await app.api('GET', `projects/${last.project.id}/execution`, {}, {workflow_id: last.workflow});
    assert.equal(detail.displays[last.script.id], 'run 19');
    await app.Backend.shutdownExecutions();
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'shutdown released every worker');
    assert.equal(app.workerStats.started - app.workerStats.exited, 0, 'shutdown released every worker');
  } finally {
    await app.Backend.shutdownExecutions();
  }
});
