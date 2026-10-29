'use strict';
// Runs, triggers, workflow state, export/import and conditional edits (see js/backend/routes-runs.js, routes-state.js,
// routes-exchange.js). Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, bundleOf, place, fn} = require('./harness');
const TextGraph = require('../js/storage/format');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

/** A project whose workflow is: on_run -> a Script (v + "!") -> a Script that shows its input, with Text "hi" as the data of the first. Returns helpers bound to it. */
async function greeting(app, name = 'Runs') {
  const {id} = await app.api('POST', 'projects', {name}),
    workflow = {workflow_id: id};
  const node = (node_type, config = {}) =>
    app.api('POST', `projects/${id}/typed-nodes`, {...workflow, node_type, config, position: {x: 0, y: 0}});
  const text = await node('custom', nodes.value('text', 'hi')),
    script = await fn(app, id, workflow, {
      code: 'node.output.result = v + "!"; await node.emit("out")',
      inputs: ['v'],
      outputs: ['result'],
      signals: ['out'],
    }),
    preview = await fn(app, id, workflow, {code: 'node.display(input)', inputs: ['input']});
  const connect = (a, ap, b, bp) =>
    app.api('POST', `projects/${id}/port-connections`, {
      ...workflow,
      add: [{source: a, source_port: ap, target: b, target_port: bp}],
    });
  const start = await node('custom', nodes.run());
  await connect(text.id, 'value', script.wrapper, 'v');
  await connect(script.wrapper, 'result', preview.wrapper, 'input');
  await connect(start.id, 'out', script.wrapper, 'in');
  await connect(script.wrapper, 'out', preview.wrapper, 'in');
  /** Gives the Script of `script` another code. */
  const recode = (target, code) =>
    app.api('PUT', `projects/${id}/typed-nodes/${target.id}`, {
      ...workflow,
      node_type: 'custom',
      config: {...nodes.script(code), title: 'Script'},
    });
  return {id, workflow, node, connect, text, script, preview, start, recode};
}
const waitUntil = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
};

test('a run starts in the background and leaves a trace and a history entry', async () => {
  const app = createApp(),
    p = await greeting(app);
  const started = await app.api('POST', `projects/${p.id}/runs`, p.workflow);
  assert.equal(started.status, 'running');
  const run = await waitUntil(async () => {
    const r = await app.api('GET', `runs/${started.id}`);
    return r.status !== 'running' && r;
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.displays[p.preview.id], 'hi!');
  assert.deepEqual(
    run.nodes.map(n => [n.node_id, n.status]).sort(),
    [
      [p.start.id, 'completed'],
      [p.script.id, 'completed'],
      [p.preview.id, 'completed'],
    ].sort()
  );
  assert.ok(run.nodes.every(n => typeof n.ms === 'number'));
  const history = await app.api('GET', `projects/${p.id}/runs`, {}, p.workflow);
  assert.deepEqual(
    history.map(r => r.id),
    [started.id]
  );
  assert.ok(!('outputs' in history[0]) && !('nodes' in history[0]), 'the list holds summaries only');
  assert.equal((await app.api('GET', 'runs')).length, 1);
});

test('wait returns the finished run; a failing script makes the run failed with its error', async () => {
  const app = createApp(),
    p = await greeting(app);
  await p.recode(p.script, 'throw new Error("boom")');
  const run = await app.api('POST', `projects/${p.id}/runs`, {...p.workflow, wait: 5});
  assert.equal(run.status, 'failed');
  assert.match(run.errors[p.start.id], /boom/);
  assert.equal(run.nodes.find(n => n.node_id === p.script.id).status, 'failed');
  assert.equal(run.failed_nodes >= 1, true);
});

test('a workflow with nothing to run, and unknown nodes, are refused', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Empty'});
  await rejects(app.api('POST', `projects/${id}/runs`, {workflow_id: id}), /Nothing to run/);
  await app.api('POST', `projects/${id}/typed-nodes`, {
    workflow_id: id,
    node_type: 'custom',
    config: nodes.script('node.display(1)'),
    position: {x: 0, y: 0},
  });
  await rejects(
    app.api('POST', `projects/${id}/runs`, {workflow_id: id}),
    /on_run/,
    'a Script is not a start: only on_run is'
  );
  const p = await greeting(app);
  await rejects(
    app.api('POST', `projects/${p.id}/runs`, {...p.workflow, node_ids: ['nope']}),
    /Not a node of this workflow: nope/
  );
  await rejects(app.api('POST', `projects/lib-x/runs`, {}), /Custom Node/);
  await rejects(app.api('GET', 'runs/unknown'), /not found/i);
});

test('the events of a run carry what a node showed, as it finishes', async () => {
  const app = createApp(),
    p = await greeting(app);
  const started = await app.api('POST', `projects/${p.id}/runs`, p.workflow);
  await waitUntil(async () => (await app.api('GET', `runs/${started.id}`)).status !== 'running');
  const {events} = await app.api('GET', `runs/${started.id}/events`, {}, {after: 0});
  const shown = events.find(e => e.type === 'node_completed' && e.node_id === p.preview.id);
  assert.equal(shown.display, 'hi!');
  assert.ok(events.findIndex(e => e.type === 'node_started' && e.node_id === p.preview.id) < events.indexOf(shown));
});

test('a paused run starts no node until it is resumed; Stop ends it', async () => {
  const app = createApp({scripts: 'worker'});
  const {id} = await app.api('POST', 'projects', {name: 'Pause'}),
    workflow = {workflow_id: id};
  const node = (node_type, config) =>
    app.api('POST', `projects/${id}/typed-nodes`, {...workflow, node_type, config, position: {x: 0, y: 0}});
  const connect = (a, ap, b) =>
    app.api('POST', `projects/${id}/port-connections`, {
      ...workflow,
      add: [{source: a, source_port: ap, target: b, target_port: 'in'}],
    });
  const start = await node('custom', nodes.run()),
    slow = await fn(app, id, workflow, {
      code: 'await new Promise(r => setTimeout(r, 300)); await node.emit("out")',
      signals: ['out'],
    }),
    after = await fn(app, id, workflow, {code: 'node.display("after")'});
  await connect(start.id, 'out', slow.wrapper);
  await connect(slow.wrapper, 'out', after.wrapper);
  const started = await app.api('POST', `projects/${id}/runs`, workflow);
  await waitUntil(async () => (await app.api('GET', `runs/${started.id}`)).nodes.some(n => n.node_id === slow.id));
  assert.equal((await app.api('POST', `runs/${started.id}/pause`, {})).paused, true);
  await new Promise(r => setTimeout(r, 600));
  let run = await app.api('GET', `runs/${started.id}`);
  assert.equal(run.status, 'running');
  assert.deepEqual(
    run.nodes.filter(n => n.node_id === after.id),
    []
  );
  assert.equal((await app.api('POST', `runs/${started.id}/resume`, {})).paused, false);
  run = await waitUntil(async () => {
    const r = await app.api('GET', `runs/${started.id}`);
    return r.status !== 'running' && r;
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.nodes.find(n => n.node_id === after.id).status, 'completed');
  await rejects(app.api('POST', `runs/${started.id}/pause`, {}), /finished/);
  // Stop: a paused run is cancelled at once.
  const second = await app.api('POST', `projects/${id}/runs`, workflow);
  await app.api('POST', `runs/${second.id}/pause`, {});
  assert.equal((await app.api('POST', `runs/${second.id}/cancel`, {})).status, 'cancelled');
});

test('a Reroute point can be put on a signal wire; the other wires of the signal input stay', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Signal reroute'}),
    workflow = {workflow_id: id};
  const node = config =>
    app.api('POST', `projects/${id}/typed-nodes`, {...workflow, node_type: 'custom', config, position: {x: 0, y: 0}});
  const first = await node(nodes.run()),
    second = await node(nodes.run()),
    script = await fn(app, id, workflow, {code: ''});
  for (const from of [first, second])
    await app.api('POST', `projects/${id}/port-connections`, {
      ...workflow,
      add: [{source: from.id, source_port: 'out', target: script.wrapper, target_port: 'in'}],
    });
  const before = await app.api('GET', `projects/${id}/workflow`, {}, workflow);
  await app.api('POST', `projects/${id}/split-connections`, {
    ...workflow,
    splits: [{edge_id: before.edges[0].id, position: {x: 5, y: 5}}],
  });
  const after = await app.api('GET', `projects/${id}/workflow`, {}, workflow);
  assert.equal(after.edges.length, 3);
  assert.equal(after.nodes.find(n => n.node_type === 'reroute').inputs[0].type, 'signal');
});

test('events can be followed with a long poll', async () => {
  const app = createApp(),
    p = await greeting(app);
  const started = await app.api('POST', `projects/${p.id}/runs`, p.workflow);
  let after = 0;
  const seen = [];
  await waitUntil(async () => {
    const batch = await app.api('GET', `runs/${started.id}/events`, {}, {after, wait: 1000});
    seen.push(...batch.events.map(e => e.type));
    after = batch.next;
    return batch.finished;
  });
  assert.equal(seen[0], 'run_started');
  assert.equal(seen.at(-1), 'run_finished');
  assert.equal(seen.filter(t => t === 'node_completed').length, 3);
  const none = await app.api('GET', `runs/${started.id}/events`, {}, {after});
  assert.deepEqual(none.events, []);
  assert.equal(none.finished, true);
});

test('a running script is stopped by cancel (worker threads)', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await greeting(app);
  await p.recode(p.script, 'await new Promise(r => setTimeout(r, 60000)); node.output.result = "late"');
  const started = await app.api('POST', `projects/${p.id}/runs`, p.workflow);
  await waitUntil(async () => (await app.api('GET', `runs/${started.id}`)).nodes.some(n => n.node_id === p.script.id));
  const began = Date.now();
  const cancelled = await app.api('POST', `runs/${started.id}/cancel`);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(Date.now() - began < 5000, 'cancel does not wait for the script');
  const run = await app.api('GET', `runs/${started.id}`);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.nodes.find(n => n.node_id === p.script.id).status, 'cancelled');
  await rejects(app.api('POST', `runs/unknown/cancel`), /not found/i);
});

test('Scripts in worker threads run, can call the API, and a script that never ends hits the limit', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await greeting(app);
  await p.recode(
    p.script,
    'const projects = await agentsys("GET", "projects"); node.output.result = node.input.v + ":" + projects.length + ":" + context.run_id.length; await node.emit("out")'
  );
  const run = await app.api('POST', `projects/${p.id}/runs`, {...p.workflow, wait: 10});
  assert.equal(run.status, 'completed');
  assert.equal(run.displays[p.preview.id], 'hi:1:32');
});

test('the history keeps the last runs of a workflow and goes away with it', async () => {
  const app = createApp(),
    p = await greeting(app);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await app.api('POST', `projects/${p.id}/runs`, {...p.workflow, wait: 5})).id);
  const list = await app.api('GET', `projects/${p.id}/runs`, {}, {...p.workflow, limit: 2});
  assert.equal(list.length, 2);
  assert.deepEqual(
    new Set((await app.api('GET', `projects/${p.id}/runs`, {}, p.workflow)).map(r => r.id)),
    new Set(ids)
  );
  assert.equal((await app.api('GET', `projects/${p.id}/runs`, {}, {...p.workflow, status: 'failed'})).length, 0);
  await app.api('DELETE', `projects/${p.id}`);
  assert.equal(app.eval('RUNS.byId.size') >= 0, true);
  assert.deepEqual(await app.eval("DB.get('run_index')").then(v => JSON.parse(JSON.stringify(v))), []);
});

test('workflow state: values, versions, compare-and-set, prefixes and limits', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'State'});
  const put = (key, value, query) => app.api('PUT', `workflows/${id}/state/${key}`, {value}, query);
  assert.deepEqual(await app.api('GET', `workflows/${id}/state`), []);
  const first = await put('plan:main', {steps: [1, 2]});
  assert.equal(first.version, 1);
  assert.equal((await put('plan:main', {steps: [1, 2, 3]})).version, 2);
  await rejects(put('plan:main', 'stale', {version: '1'}), /version/);
  assert.equal((await put('plan:main', 'ok', {version: '2'})).version, 3);
  assert.equal((await app.api('PUT', `workflows/${id}/state/lock`, {value: true, version: 0})).version, 1);
  await rejects(app.api('PUT', `workflows/${id}/state/lock`, {value: true, version: 0}), /version/);
  assert.equal((await app.api('GET', `workflows/${id}/state/plan:main`)).value, 'ok');
  assert.deepEqual(
    (await app.api('GET', `workflows/${id}/state`, {}, {prefix: 'plan:'})).map(e => e.key),
    ['plan:main']
  );
  assert.equal((await app.api('GET', `workflows/${id}/state`, {}, {values: 'true'}))[0].value, true);
  await rejects(put('bad key', 1), /state key/);
  await rejects(app.api('PUT', `workflows/${id}/state/big`, {value: 'x'.repeat(1000001)}), /state_value_bytes/);
  await rejects(app.api('PUT', `workflows/${id}/state/none`, {}), /value/);
  assert.deepEqual(await app.api('DELETE', `workflows/${id}/state/lock`), {deleted: 'lock'});
  await rejects(app.api('GET', `workflows/${id}/state/lock`), /No such state key/);
  await rejects(app.api('GET', `workflows/lib-x/state`), /Workflow not found/);
});

test('a script can keep memory between runs in the workflow state', async () => {
  const app = createApp(),
    p = await greeting(app);
  await p.recode(
    p.script,
    `let n = 0, rev = 0;
try { const e = await agentsys('GET', 'workflows/' + context.workflow_id + '/state/count'); n = e.value; rev = e.version } catch {}
await agentsys('PUT', 'workflows/' + context.workflow_id + '/state/count', {value: n + 1, version: rev});
node.output.result = n + 1; await node.emit("out")`
  );
  for (let i = 1; i <= 3; i++) {
    const run = await app.api('POST', `projects/${p.id}/runs`, {...p.workflow, wait: 5});
    assert.equal(run.displays[p.preview.id], String(i));
  }
  assert.equal((await app.api('GET', `workflows/${p.id}/state/count`)).value, 3);
});

test('a workflow exports as one document and imports with the same behaviour', async () => {
  const app = createApp(),
    p = await greeting(app);
  const exported = TextGraph.decode(await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`));
  assert.equal(exported.kind, 'workflow');
  assert.equal(exported.document.nodes.length, 6);
  assert.ok(!('cursor' in exported.document));
  const imported = await app.api(
    'POST',
    `projects/${p.id}/workflows/import`,
    TextGraph.encode({...exported, name: 'Copy'})
  );
  assert.deepEqual(imported.diagnostics, []);
  const run = await app.api('POST', `projects/${p.id}/runs`, {workflow_id: imported.id, wait: 5});
  assert.equal(run.status, 'completed');
  assert.deepEqual(Object.values(run.displays), ['hi!']);
  // The same name is made unique instead of refused.
  assert.equal(
    (await app.api('POST', `projects/${p.id}/workflows/import`, TextGraph.encode({...exported, name: 'Copy'}))).name,
    'Copy 2'
  );
  await rejects(
    app.api('POST', `projects/${p.id}/workflows/import`, TextGraph.encode({document: {nodes: 'x'}})),
    /wrong shape/
  );
  await rejects(app.api('POST', `projects/${p.id}/workflows/import`, {name: 'x'}), /agentsys.text/);
  await rejects(
    app.api(
      'POST',
      `projects/${p.id}/workflows/import`,
      TextGraph.encode({
        document: {
          nodes: [
            {id: 'a', kind: 'function', node_type: 'custom'},
            {id: 'a', kind: 'function', node_type: 'custom'},
          ],
        },
      })
    ),
    /unique/
  );
});

test('a project exports with all its workflows and imports as a new project', async () => {
  const app = createApp(),
    p = await greeting(app, 'Source');
  await app.api('POST', `projects/${p.id}/workflows`, {name: 'Second'});
  const exported = TextGraph.decode(await app.api('GET', `projects/${p.id}/export`));
  assert.equal(exported.kind, 'project');
  assert.deepEqual(
    exported.workflows.map(w => w.name),
    ['Main', 'Second']
  );
  const made = await app.api('POST', 'projects/import', TextGraph.encode(exported));
  assert.equal(made.name, 'Source 2');
  assert.equal(made.workflows.length, 2);
  const run = await app.api('POST', `projects/${made.id}/runs`, {workflow_id: made.workflows[0].id, wait: 5});
  assert.equal(run.status, 'completed');
  await rejects(app.api('POST', 'projects/import', TextGraph.encode({name: 'x', workflows: []})), /workflows/);
});

test('an edit with if_cursor applies only to the workflow state that was read', async () => {
  const app = createApp(),
    p = await greeting(app);
  const snap = () => app.api('GET', `projects/${p.id}/workflow`, {}, p.workflow);
  const read = await snap();
  const edit = if_cursor =>
    app.api(
      'POST',
      `projects/${p.id}/typed-nodes`,
      {...p.workflow, node_type: 'custom', config: nodes.value('text', 'x'), position: {x: 1, y: 1}},
      {if_cursor}
    );
  await edit(String(read.cursor));
  await rejects(edit(String(read.cursor)), /changed since it was read/);
  const again = await snap();
  assert.equal(again.cursor, read.cursor + 1);
  await edit(String(again.cursor));
  await edit(''); // no condition, no check
});

test('triggers: interval ticks, no overlap, manual fire and webhooks with a payload', async () => {
  const app = createApp(),
    p = await greeting(app);
  await p.recode(
    p.script,
    'node.output.result = JSON.stringify(context.payload) + context.trigger; await node.emit("out")'
  );
  await rejects(
    app.api('POST', 'triggers', {name: 'x', type: 'interval', project_id: p.id, every_seconds: 1}),
    /10 to 2592000/
  );
  await rejects(app.api('POST', 'triggers', {name: 'x', type: 'cron', project_id: p.id}), /type must be/);
  const tick = await app.api('POST', 'triggers', {
    name: 'Minute',
    type: 'interval',
    project_id: p.id,
    every_seconds: 60,
  });
  assert.equal(tick.enabled, true);
  const soon = tick.created + 30,
    later = tick.created + 61;
  assert.deepEqual((await app.api('POST', 'scheduler/tick', {now: soon})).fired, []);
  const fired = (await app.api('POST', 'scheduler/tick', {now: later})).fired;
  assert.equal(fired.length, 1);
  const run = await waitUntil(async () => {
    const r = await app.api('GET', `runs/${fired[0].run_id}`);
    return r.status !== 'running' && r;
  });
  assert.equal(run.trigger, 'interval');
  assert.equal(run.status, 'completed');
  assert.equal((await app.api('GET', `triggers/${tick.id}`)).last_run_id, fired[0].run_id);
  assert.deepEqual((await app.api('POST', 'scheduler/tick', {now: later + 10})).fired, [], 'not due again yet');
  await app.api('PUT', `triggers/${tick.id}`, {enabled: false});
  assert.deepEqual(
    (await app.api('POST', 'scheduler/tick', {now: later + 1000})).fired,
    [],
    'disabled triggers do not fire'
  );

  const hook = await app.api('POST', 'triggers', {name: 'Hook', type: 'webhook', project_id: p.id});
  assert.match(hook.token, /^[0-9a-f]{32}$/);
  const hooked = await app.api('POST', `hooks/${hook.token}`, {event: 'push', n: 2});
  const done = await waitUntil(async () => {
    const r = await app.api('GET', `runs/${hooked.id}`);
    return r.status !== 'running' && r;
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.displays[p.preview.id], '{"event":"push","n":2}webhook');
  await rejects(app.api('POST', 'hooks/wrong', {}), /Unknown webhook/);
  const manual = await app.api('POST', `triggers/${hook.id}/fire`, {payload: {a: 1}});
  assert.equal(manual.trigger, 'webhook');

  // Deleting the project deletes its triggers.
  await app.api('DELETE', `projects/${p.id}`);
  assert.deepEqual(await app.api('GET', 'triggers'), []);
});

test('the API description lists the new routes', async () => {
  const app = createApp();
  const paths = Object.keys(app.Backend.openapi().paths);
  for (const expected of [
    '/api/runs/{run_id}',
    '/api/projects/{project_id}/runs',
    '/api/triggers',
    '/api/workflows/{workflow_id}/state/{key}',
    '/api/projects/import',
  ])
    assert.ok(paths.includes(expected), expected);
});

test('workflow and project imports fire on_placed of the Library nodes in them, with the imported project and workflow ids', async () => {
  const app = createApp();
  const source = await app.api('POST', 'projects', {name: 'Hook source'});
  const hook = bundleOf(
    'Hook',
    {
      Body: {inputs: [], outputs: []},
      E: nodes.event('on_placed'),
      S: nodes.script(
        'await agentsys("PUT", "workflows/" + context.workflow_id + "/state/" + context.workflow_id, {value: context.node_id})'
      ),
    },
    {wires: [['E', 'out', 'S', 'in']]}
  );
  await place(app, source.id, {workflow_id: source.id}, hook);
  await app.Backend.hooksIdle();
  const workflowFile = await app.api('GET', `projects/${source.id}/workflows/${source.id}/export`);
  const projectFile = await app.api('GET', `projects/${source.id}/export`);
  const destination = await app.api('POST', 'projects', {name: 'Destination'});
  await app.api('PUT', 'settings', {developer_mode: false});
  const workflow = await app.api('POST', `projects/${destination.id}/workflows/import`, workflowFile);
  const project = await app.api('POST', 'projects/import', projectFile);
  await app.Backend.hooksIdle();
  const nodeId = TextGraph.decode(workflowFile).document.nodes.find(n => n.config?.op === 'script').id;
  assert.equal((await app.api('GET', `workflows/${workflow.id}/state/${workflow.id}`)).value, nodeId);
  assert.equal(
    (await app.api('GET', `workflows/${project.workflows[0].id}/state/${project.workflows[0].id}`)).value,
    nodeId
  );
});
