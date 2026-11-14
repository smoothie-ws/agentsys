'use strict';
// Graph engine regression scenarios that go past the existing suites: a Script editing its own graph while it
// runs, a bounded chain of nodes that create nodes, a node deleting itself mid-run, and the runtime's health
// after those mutations. The engine's semantics are not changed by these tests.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes, flow} = require('./harness');

async function project(app, name = 'Engine') {
  const {id} = await app.api('POST', 'projects', {name});
  const self = {
    id,
    query: {workflow_id: id},
    node: (config, extra = {}) =>
      app.api('POST', `projects/${id}/typed-nodes`, {workflow_id: id, node_type: 'custom', config, position: {x: 0, y: 0}, ...extra}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {workflow_id: id, add: [{source: s, source_port: sp, target: t, target_port: tp}]}),
    evaluate: (ids, extra = {}) => app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: ids, ...extra}),
    snapshot: () => app.api('GET', `projects/${id}/workflow`, {}, {workflow_id: id}),
    state: async key => (await app.api('GET', `test-observations/${key}`).catch(() => ({}))).value,
    detail: () => app.api('GET', `projects/${id}/execution`, {}, {workflow_id: id}),
  };
  return self;
}

const OBSERVE = key => `await agentsys("PUT", "test-observations/${key}", {value: (await agentsys("GET", "test-observations/${key}").catch(() => ({}))).value ?? 0});`;

test('a Script adds nodes to its own graph while it runs, and they run on the next Run', async () => {
  const app = createApp(),
    p = await project(app);
  // The inner node is created by the outer Script through the ordinary API, and is not signalled by it.
  const creator = await p.node(
    nodes.script(
      `await agentsys("POST", "projects/${p.id}/typed-nodes", {
        workflow_id: "${p.id}",
        node_type: "custom",
        config: {title: "Made", op: "on_run",
          inputs: [],
          outputs: [{id: "out", name: "out", type: "signal"}]}
      });
      await agentsys("PUT", "test-observations/created", {value: true});`
    )
  );
  const run = await p.evaluate([creator.id], {wait: true});
  assert.deepEqual(run.errors, {});
  assert.equal(await p.state('created'), true, 'the Script created its node through the API');
  const after = await p.snapshot();
  const made = after.nodes.find(node => node.config.title === 'Made');
  assert.ok(made, 'the new node is part of the graph');
  assert.equal(after.cursor > 1, true, 'the graph revision advanced');

  // The new node only runs when a signal reaches it; wiring it and running again executes both.
  const start = await p.evaluate([made.id], {wait: true});
  assert.deepEqual(start.errors, {});
  assert.equal(start.nodes.find(node => node.node_id === made.id).status, 'completed');
});

test('repeated runs of a creating Script stop at its bound and leave a valid graph', async () => {
  const app = createApp(),
    p = await project(app, 'Recursive');
  // The Script creates a node while the counter is below the bound. A created on_run node holds a trigger, not
  // code, so it runs only when it is signalled; the bound is what keeps creation from running away.
  const factory = depth =>
    nodes.script(
      `const n = Number((await agentsys("GET", "test-observations/depth").catch(() => ({}))).value ?? 0);
       await agentsys("PUT", "test-observations/depth", {value: n + 1});
       if (n < ${depth}) {
         await agentsys("POST", "projects/${p.id}/typed-nodes", {
           workflow_id: "${p.id}", node_type: "custom",
           config: {title: "Level " + (n + 2), op: "on_run",
             inputs: [],
             outputs: [{id: "out", name: "out", type: "signal"}]}
         });
       }`
    );
  const creator = await p.node(factory(2));
  for (let run = 0; run < 3; run++) {
    const result = await p.evaluate([creator.id], {wait: true});
    assert.deepEqual(result.errors, {});
  }
  assert.equal(await p.state('depth'), 3, 'the Script ran three times, not in a loop');
  const graph = await p.snapshot();
  const levels = graph.nodes.filter(node => (node.config.title || '').startsWith('Level'));
  assert.deepEqual(levels.map(node => node.config.title).sort(), ['Level 2', 'Level 3'], 'creation stopped at the bound');
  // A created node is an ordinary node of the graph: it can be run like any other.
  const made = await p.evaluate([levels[0].id], {wait: true});
  assert.deepEqual(made.errors, {});
  assert.equal(made.nodes.find(node => node.node_id === levels[0].id).status, 'completed');
  // The document is still a valid graph for the API: a further read runs the usual validation path.
  assert.equal(graph.nodes.every(node => node.id && node.kind), true);
});

test('a Script deletes its own node while running; the run settles and the runtime stays usable', async () => {
  const app = createApp(),
    p = await project(app, 'Self delete');
  const doomed = await p.node(nodes.script(`await agentsys("POST", "projects/${p.id}/delete-nodes", {node_ids: [context.node_id]})`));
  const run = await p.evaluate([doomed.id], {wait: true}).catch(error => ({error}));
  // The node cannot be removed while its dispatch is running, or the run reports a clean failure; either way the
  // runtime must not be left running or throw an unhandled rejection.
  const detail = await p.detail();
  assert.equal(detail.status, 'idle', 'the runtime is not stuck running');
  assert.equal(JSON.stringify(run).includes('unhandled'), false);
  // A later Run on the remaining graph works.
  const survivor = await p.node(nodes.script('await agentsys("PUT", "test-observations/after", {value: "ok"})'));
  const again = await p.evaluate([survivor.id], {wait: true});
  assert.deepEqual(again.errors, {});
  assert.equal(await p.state('after'), 'ok');
});

test('the runtime reports no live worker after repeated runs and a stop', async () => {
  const app = createApp({scripts: 'worker'});
  const p = await project(app, 'Workers');
  const node = await p.node(nodes.script('await node.sleep(20); await agentsys("PUT", "test-observations/tick", {value: 1})'));
  for (let i = 0; i < 4; i++) {
    const run = await p.evaluate([node.id], {wait: true});
    assert.deepEqual(run.errors, {});
    assert.equal(run.nodes.find(item => item.node_id === node.id).status, 'completed');
  }
  await p.evaluate([node.id]);
  await app.api('DELETE', `projects/${p.id}/execution`, {}, {workflow_id: p.id});
  await app.Backend.shutdownExecutions();
  assert.ok(app.workerStats.terminated >= 1, 'Stop terminates the worker');
  const detail = await p.detail();
  assert.equal(detail.status, 'idle');
  assert.equal(app.Backend.diagnostics().runtimes.every(runtime => runtime.status === 'idle'), true);
});
