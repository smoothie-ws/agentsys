'use strict';
// The Custom node: Scripts and the signals between them, the input rules, node.display(), hooks of Library nodes (on_placed, on_deleted)
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const out = (id, _type, name = id) => ({id, name});

async function project(app, name = 'Custom') {
  const {id} = await app.api('POST', 'projects', {name});
  const self = {
    id,
    node: (config, extra = {}) =>
      app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}, ...extra}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {node_ids: ids, collect: true}),
    /** Runs an on_run wired to the nodes one after another. */
    run: async (...steps) => self.evaluate([await flow(app, id, {}, steps)]),
    remove: ids => app.api('POST', `projects/${id}/delete-nodes`, {node_ids: ids}),
    snapshot: () => app.api('GET', `projects/${id}/workflow`),
    state: async key => (await app.api('GET', `test-observations/${key}`).catch(() => ({}))).value,
    log: async () => {
      await app.Backend.hooksIdle();
      return app.api('GET', 'node-hooks');
    },
  };
  return self;
}
/** A Library node with a hook: when `hook` (on_placed, on_deleted) fires for a copy, a Script saves `who` under the state key `key`. */
const hooked = (name, who, hooks = {on_placed: 'placed', on_deleted: 'deleted'}, extra = '') => {
  const members = {Body: {inputs: [], outputs: []}},
    wires = [];
  for (const [hook, key] of Object.entries(hooks)) {
    members['E' + hook] = nodes.event(hook);
    members['S' + hook] = nodes.script(
      `${extra}await agentsys("PUT", "test-observations/${key}", {value: "${who}"})`
    );
    wires.push(['E' + hook, 'out', 'S' + hook, 'in']);
  }
  return bundleOf(name, members, {wires});
};

test('a Script runs when its signal arrives; it sends Out only with emit, and what it sets in output.<name> is its result', async () => {
  const app = createApp(),
    p = await project(app);
  const a = await fn(
      app,
      p.id,
      {},
      {code: 'node.output.result = 1 + 1; await node.emit("out")', outputs: ['result'], signals: ['out']}
    ),
    show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(a.wrapper, 'result', show.wrapper, 'v');
  const r = await p.run(a.step, show.step);
  assert.deepEqual(r.errors, {});
  assert.equal(r.displays[show.id], '2');
  assert.deepEqual(
    (await p.evaluate([a.id])).outputs[a.id],
    {result: 2},
    'a Script that is run directly runs as if its signal arrived'
  );
});

test('a slot takes one wire: connecting a second one replaces the first; a signal input takes as many as you like', async () => {
  const app = createApp(),
    p = await project(app);
  const a = await p.node(nodes.value('text', 'a')),
    b = await p.node(nodes.value('text', 'b'));
  const show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(a.id, 'value', show.wrapper, 'v');
  await p.connect(b.id, 'value', show.wrapper, 'v');
  const wires = (await p.snapshot()).edges.filter(e => e.target === show.wrapper && e.target_port === 'v');
  assert.equal(wires.length, 1);
  assert.equal((await p.evaluate([show.id])).displays[show.id], 'b');
  const one = await p.node(nodes.event('on_run')),
    two = await p.node(nodes.event('on_run'));
  await p.connect(one.id, 'out', show.wrapper, 'in');
  await p.connect(two.id, 'out', show.wrapper, 'in');
  assert.equal((await p.snapshot()).edges.filter(e => e.target === show.wrapper && e.target_port === 'in').length, 2);
  await rejects(p.connect(one.id, 'out', show.wrapper, 'in'), /connected already/);
  await rejects(p.connect(one.id, 'out', show.wrapper, 'v'), /./, 'a signal does not fit a data input');
  await p.connect(one.id, 'out', one.id, 'in').catch(e => assert.match(e.message, /./)); // an event node has no In
});

test('node.display() shows text on the node: a string as it is, anything else as JSON; the last call wins', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node(nodes.script('node.display("first"); node.display({a: [1, 2]})', [], 'void'));
  const r = await p.run(n.id);
  assert.deepEqual(JSON.parse(r.displays[n.id]), {a: [1, 2]});
  const s = await p.node(nodes.script('node.display("plain")', [], 'void'));
  assert.equal((await p.evaluate([s.id])).displays[s.id], 'plain');
});

test('node.display() shows an image ({mime_type, data}) as a data URL and refuses one that is too large or not base64', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node(nodes.script('node.display({mime_type: "image/png", data: "iVBORw0KGgo="})', [], 'void'));
  assert.equal((await p.evaluate([n.id])).displays[n.id], 'data:image/png;base64,iVBORw0KGgo=');
  const bad = await p.node(nodes.script('node.display({mime_type: "image/png", data: "not base64!"})', [], 'void'));
  assert.match((await p.evaluate([bad.id])).errors[bad.id], /cannot be displayed/);
  const text = await p.node(nodes.script('node.display({mime_type: "text/plain", data: "x"})', [], 'void'));
  assert.match((await p.evaluate([text.id])).displays[text.id], /mime_type/);
});

test('a node can have several outputs of any kind; one it does not set is undefined, not an error', async () => {
  const app = createApp(),
    p = await project(app);
  const ok = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.a = 2; node.output.b = "y"; await node.emit("out")', outputs: ['a', 'b'], signals: ['out']}
  );
  const second = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(ok.wrapper, 'b', second.wrapper, 'v');
  assert.equal((await p.run(ok.step, second.step)).displays[second.id], 'y');
  const loose = await fn(app, p.id, {}, {code: 'node.output.a = {any: ["thing", 1]};', outputs: ['a', 'b']});
  const r = await p.evaluate([loose.id]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.outputs[loose.id], {a: {any: ['thing', 1]}});
  const silent = await fn(app, p.id, {}, {code: '', outputs: ['result'], signals: ['out']});
  const shows = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(silent.wrapper, 'result', shows.wrapper, 'v');
  const none = await p.run(silent.step, shows.step);
  assert.deepEqual(none.errors, {});
});

test('on_placed and on_deleted fire for a copy of a Library node when it enters or leaves the canvas, whichever way it happens', async () => {
  const app = createApp(),
    p = await project(app);
  const state = p.state;
  const one = await place(app, p.id, {}, hooked('Hooked', 'one'));
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'one');
  // Moving or editing the node is not placing it.
  await app.api('PUT', `projects/${p.id}/layout`, {positions: {[one.id]: {x: 40, y: 40}}}).catch(() => {});
  await app.api('PUT', `test-observations/placed`, {value: 'untouched'});
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'untouched');

  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: [one.id]}).catch(() => {});
  await app.api('DELETE', `projects/${p.id}/groups/${one.group}`).catch(() => {});
  await app.Backend.hooksIdle();
  assert.equal(await state('deleted'), 'one');

  // Undo brings the node back, so on_placed fires again; redo removes it, so on_deleted does.
  await app.api('PUT', `test-observations/placed`, {value: 'cleared'});
  await app.api('POST', `projects/${p.id}/undo`);
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'one');
  await app.api('PUT', `test-observations/deleted`, {value: 'cleared'});
  await app.api('POST', `projects/${p.id}/redo`);
  await app.Backend.hooksIdle();
  assert.equal(await state('deleted'), 'one');

  // Copy and paste places a new copy, so on_placed fires for it.
  const two = await place(app, p.id, {}, hooked('Hooked two', 'two'));
  const bundle = await app.api('POST', `projects/${p.id}/copy`, {node_ids: [], group_ids: [two.group]});
  await app.api('PUT', `test-observations/placed`, {value: 'cleared'});
  await app.api('POST', `projects/${p.id}/paste`, {clipboard: bundle, point: {x: 100, y: 100}});
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'two');
});

test('the hooks of a copy belong to that copy: another copy, or an ordinary workflow, does not fire them', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Counter',
    {
      Body: {inputs: [], outputs: []},
      E: nodes.event('on_placed'),
      S: nodes.script(
        'const n = (await agentsys("GET", "test-observations/n").catch(() => ({}))).value ?? 0; await agentsys("PUT", "test-observations/n", {value: n + 1}); await agentsys("PUT", "test-observations/who", {value: context.instance_id})'
      ),
    },
    {wires: [['E', 'out', 'S', 'in']]}
  );
  const a = await place(app, p.id, {}, def);
  await app.Backend.hooksIdle();
  assert.equal(await p.state('n'), 1);
  assert.equal(await p.state('who'), a.id, 'context.instance_id is the copy the hook is for');
  const b = await place(app, p.id, {}, {...def, name: 'Counter'}).catch(() => null);
  await app.Backend.hooksIdle();
  // A plain on_placed on the workflow is never fired (nothing places a workflow); on_run is.
  const loose = await p.node(nodes.event('on_placed'));
  const log = await p.node(
    nodes.script('await agentsys("PUT", "test-observations/loose", {value: 1})')
  );
  await p.connect(loose.id, 'out', log.id, 'in');
  await app.Backend.hooksIdle();
  assert.equal(await p.state('loose'), undefined);
  assert.ok(b === null || (await p.state('n')) >= 1);
});

test('a failing hook is logged and hooks always run', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Bad',
    {
      Body: {inputs: [], outputs: []},
      E: nodes.event('on_placed'),
      S: nodes.script('throw new Error("nope")'),
      D: nodes.event('on_deleted'),
      T: nodes.script('throw new Error("deleted")'),
    },
    {
      wires: [
        ['E', 'out', 'S', 'in'],
        ['D', 'out', 'T', 'in'],
      ],
    }
  );
  const bad = await place(app, p.id, {}, def);
  assert.ok(
    (await p.snapshot()).complex.some(c => c.id === bad.group),
    'the node is on the canvas'
  );
  const log = await p.log();
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].hook, log[0].ok, log[0].node_id], ['on_placed', false, bad.id]);
  assert.match(log[0].error, /nope/);
  assert.deepEqual(await app.api('GET', 'node-hooks', {}, {workflow_id: 'other'}), []);
  await app.api('DELETE', `projects/${p.id}/groups/${bad.group}`).catch(() => {});
  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: [bad.id]}).catch(() => {});
  assert.equal((await p.log()).length, 2, 'on_deleted runs');
});

test('the configuration is validated: unknown keys, removed flags, the old Constructor and oversized configurations are refused', async () => {
  const app = createApp(),
    p = await project(app);
  await rejects(p.node({title: 'x', surprise: 1}), /./);
  await rejects(p.node({title: 'x', init: 'node.OnStarted = () => 1;'}), /./, 'the Constructor is gone');
  await rejects(p.node({title: 'x', op: 'constructor'}), /Unknown operation/);
  for (const flag of ['lazy', 'multiline', 'variadic'])
    await rejects(p.node({title: 'x', inputs: [{...out('n', 'text'), [flag]: true}]}), /./);
  await rejects(p.node({title: 'x'.repeat(200001)}), /./);
  // Any name is allowed: one that is not a name is read as node.input["a b"].
  const odd = await fn(
    app,
    p.id,
    {},
    {
      code: 'node.output.result = node.input["a b"] + "|" + node.input.class',
      inputs: ['a b', 'class'],
      outputs: ['result'],
    }
  );
  const one = await p.node(nodes.value('text', 'x'));
  await p.connect(one.id, 'value', odd.wrapper, 'a b');
  const r = await p.evaluate([odd.id]);
  assert.deepEqual(r.errors, {});
  assert.equal(r.outputs[odd.id].result, 'x|undefined');
});

test('Logic: a Custom node does what If and Switch did, choosing among the values it is given', async () => {
  const app = createApp(),
    p = await project(app);
  const mode = await p.node(nodes.value('text', 'b'));
  const sw = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.result = ({a, b, c})[key]', inputs: ['key', 'a', 'b', 'c'], outputs: ['result']}
  );
  const one = await p.node(nodes.value('number', 1)),
    two = await p.node(nodes.value('number', 2)),
    three = await p.node(nodes.value('number', 3));
  await p.connect(mode.id, 'value', sw.wrapper, 'key');
  await p.connect(one.id, 'value', sw.wrapper, 'a');
  await p.connect(two.id, 'value', sw.wrapper, 'b');
  await p.connect(three.id, 'value', sw.wrapper, 'c');
  const r = await p.evaluate([sw.id]);
  assert.deepEqual(r.errors, {});
  assert.equal(r.outputs[sw.id].result, 2);
});

test('a Custom node without an operation holds its values and runs nothing: it is no error', async () => {
  const app = createApp(),
    p = await project(app);
  const note = await p.node({title: 'Note', inputs: [], outputs: []});
  const r = await p.evaluate([note.id]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.outputs[note.id], {});
});

test('importing a document with a node of an unsupported type is refused', async () => {
  const app = createApp(),
    p = await project(app);
  const keep = {
    id: 'node:keep',
    kind: 'function',
    node_type: 'custom',
    config: nodes.value('text', 'a'),
    label: 'Custom',
    status: 'ready',
  };
  const old = {
    id: 'node:old',
    kind: 'function',
    node_type: 'script',
    config: {code: 'return 1', inputs: []},
    label: 'Script',
    status: 'ready',
  };
  const document = {nodes: [keep, old], layout: {}, style: {}, groups: [], complex: [], port_edges: [], widgets: {}};
  await assert.rejects(
    app.api(
      'POST',
      `projects/${p.id}/workflows/import`,
      require('../js/storage/format').encode({name: 'Old', document})
    ),
    /unsupported type/
  );
});

test('a Script reads its inputs as variables; code can change the nodes of the graph and the properties of its own node', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await project(app);
  const two = await p.node(nodes.value('number', 2)),
    three = await p.node(nodes.value('number', 3));
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'node.output.sum = a + b; node.output.twice = (a + b) * 2; await node.emit("out")',
      inputs: ['a', 'b'],
      outputs: ['sum', 'twice'],
      signals: ['out'],
    }
  );
  await p.connect(two.id, 'value', n.wrapper, 'a');
  await p.connect(three.id, 'value', n.wrapper, 'b');
  const show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(n.wrapper, 'twice', show.wrapper, 'v');
  assert.equal((await p.run(n.step, show.step)).displays[show.id], '10');
  const target = await p.node({title: 'Before', outputs: []});
  const editor = await p.node(
    nodes.script(`const base = "projects/" + context.project_id;
// another node of the graph: a new title and a new output
const other = (await agentsys("GET", base + "/workflow")).nodes.find(n => n.config.title === "Before");
await agentsys("PUT", base + "/typed-nodes/" + other.id, {node_type: "custom", config: {...other.config, title: "After", outputs: [{id: "r", name: "r"}]}});
// its own properties: the title
const me = (await agentsys("GET", base + "/workflow")).nodes.find(n => n.id === context.node_id);
await agentsys("PUT", base + "/typed-nodes/" + context.node_id, {node_type: "custom", config: {...me.config, title: "Edited"}});
await agentsys("POST", base + "/typed-nodes", {node_type: "custom", config: {title: "Made by code", outputs: []}, position: {x: 10, y: 10}});`)
  );
  const run = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [editor.id], wait: true}).catch(e => e);
  const snap = await p.snapshot();
  const byTitle = title => snap.nodes.find(n => n.config.title === title);
  assert.ok(
    byTitle('After')?.outputs.some(q => q.id === 'r'),
    'another node was changed'
  );
  assert.ok(byTitle('Edited'), 'the node changed its own properties');
  assert.ok(byTitle('Made by code'), 'and made a new node');
  assert.ok(run && target);
});

test('code can change the layout of nodes: position, size, color, fold and pin', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await project(app);
  const other = await p.node({title: 'Other', outputs: []});
  const editor = await p.node(
    nodes.script(`const base = "projects/" + context.project_id;
const other = (await agentsys("GET", base + "/workflow")).nodes.find(n => n.config.title === "Other");
await agentsys("PUT", base + "/layout", {positions: {[other.id]: {x: 300, y: 120, width: 400, height: 200}, [context.node_id]: {x: 5, y: 6}}});
await agentsys("PUT", base + "/node-style", {node_id: other.id, color: "#3b6ea8", folded: true});
await agentsys("PUT", base + "/node-style", {node_id: context.node_id, color: "#aa3333", pinned: true});`)
  );
  await app.api('POST', `projects/${p.id}/execution`, {node_ids: [editor.id], wait: true}).catch(e => e);
  const snap = await p.snapshot(),
    o = snap.nodes.find(n => n.id === other.id),
    me = snap.nodes.find(n => n.id === editor.id);
  assert.deepEqual([o.position.x, o.position.y, o.position.width, o.position.height], [300, 120, 400, 200]);
  assert.equal(o.color, '#3b6ea8');
  assert.ok(o.folded);
  assert.equal(me.color, '#aa3333');
  assert.ok(me.pinned);
});

test('developer mode: off by default for the app, Custom nodes cannot be made or edited by hand, but can be imported, exported and run', async () => {
  const app = createApp({developer: false}),
    api = app.api;
  assert.notEqual((await api('GET', 'settings')).preferences.developer_mode, true);
  const p = await project(app);
  await rejects(p.node(nodes.value('text', 'x')), /developer mode/);
  await rejects(api('POST', 'library/node-editor', {}), /developer mode/);
  // Turning it on allows both, and a node made then keeps working with the mode off again.
  await rejects(api('PUT', 'settings', {developer_mode: 'yes'}), /true or false/);
  await api('PUT', 'settings', {developer_mode: true});
  const n = await p.node(nodes.value('text', 'kept'));
  const show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(n.id, 'value', show.wrapper, 'v');
  await api('PUT', 'settings', {developer_mode: false});
  await rejects(
    api('PUT', `projects/${p.id}/typed-nodes/${n.id}`, {node_type: 'custom', config: nodes.value('text', 'y')}),
    /developer mode/
  );
  assert.equal((await p.evaluate([show.id])).displays[show.id], 'kept');
  // Moving and styling nodes, typing values and copying and pasting them are not editing the node.
  await api('PUT', `projects/${p.id}/layout`, {positions: {[n.id]: {x: 5, y: 5}}});
  const copied = await api('POST', `projects/${p.id}/copy`, {node_ids: [n.id]}).catch(e => e);
  assert.ok(copied);
});

test('a Library node can be overwritten as a whole: the graph is replaced and the editor copy of the old one is dropped', async () => {
  const app = createApp(),
    a = await app.api('POST', 'library/node-editor', {}),
    b = await app.api('POST', 'library/node-editor', {});
  await app.api('PUT', `projects/${b.project_id}/types`, {
    workflow_id: b.workflow_id,
    types: [{id: '1'.repeat(32), name: 'Only B', fields: []}],
  });
  const source = await app.api('GET', `resources/${b.resource_id}`),
    old = await app.api('GET', `resources/${a.resource_id}`);
  assert.notDeepEqual(source.payload.bundle, old.payload.bundle);
  await app.api('PUT', `resources/${a.resource_id}`, {name: old.name, payload: source.payload, replace: true});
  assert.deepEqual((await app.api('GET', `resources/${a.resource_id}`)).payload.bundle, source.payload.bundle);
  assert.equal(await app.eval(`DB.get('wf:lib-${a.resource_id}')`), undefined);
});
