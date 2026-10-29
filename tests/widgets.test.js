'use strict';
// Widgets: what a Custom node or a Library node declares or a Script puts on it, and how Scripts and a person read and change them. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Widgets'}),
    q = {workflow_id: id};
  const call = (method, path, body = {}) => app.api(method, `projects/${id}/${path}`, {...q, ...body}, q);
  return {
    id,
    call,
    node: config => call('POST', 'typed-nodes', {node_type: 'custom', config, position: {x: 0, y: 0}}),
    snapshot: () => call('GET', 'workflow'),
    widgets: async node => (await call('GET', 'workflow')).widgets[node] ?? [],
    set: (node, widgets) => call('PUT', `widgets/${encodeURIComponent(node)}`, {widgets}),
    values: (node, values) => call('PUT', `widgets/${encodeURIComponent(node)}`, {values}),
    use: (node, values) => call('PUT', 'widget-values', {node_id: node, values}),
    evaluate: ids => call('POST', 'evaluate-node', {node_ids: ids, collect: true}),
    state: async key => (await app.api('GET', `workflows/${id}/state/${key}`).catch(() => ({}))).value,
    idle: () => app.Backend.hooksIdle(),
  };
}

/** The titles of the Scripts that a bundle gets: `scripts` is {title: code}. Each is in the scope of the copy. */
const titled = (title, code) => ({...nodes.script(code), title});

test('code makes widgets on the copy it is part of when the copy is placed, and reads their values when it runs', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Greeting',
    {
      Body: {inputs: [], outputs: []},
      Placed: nodes.event('on_placed'),
      Make: titled(
        'Make',
        `await node.widgets([
  {id: 'name', kind: 'text', label: 'Name', value: 'world'},
  {id: 'loud', kind: 'checkbox', label: 'Loud'},
  {id: 'mode', kind: 'select', options: ['a', 'b']},
  {id: 'go', kind: 'button', label: 'Go'},
  {id: 'size', kind: 'range', min: 1, max: 9, step: 1},
  {id: 'note', kind: 'label', text: 'hello'},
])`
      ),
      Read: titled('Read', 'node.output.result = JSON.stringify(context.widgets)'),
    },
    {wires: [['Placed', 'out', 'Make', 'in']], outputs: [{id: 'result', name: 'result', node: false}]}
  );
  const greeting = await place(app, p.id, {workflow_id: p.id}, def);
  await p.idle();
  const body = (await p.snapshot()).complex.find(c => c.id === greeting.group).widget_nodes[0];
  assert.deepEqual(
    (await p.widgets(body)).map(w => [w.id, w.kind, w.value]),
    [
      ['name', 'text', 'world'],
      ['loud', 'checkbox', false],
      ['mode', 'select', 'a'],
      ['go', 'button', 0],
      ['size', 'range', 1],
      ['note', 'label', undefined],
    ]
  );
  const read = await greeting.node('Read');
  const r = await p.evaluate([read.id]);
  assert.deepEqual(JSON.parse(r.outputs[read.id].result), {name: 'world', loud: false, mode: 'a', go: 0, size: 1});
});

test('a widget that stays keeps its value, a changed kind starts again, a missing one is gone', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'W', outputs: []});
  await p.set(n.id, [
    {id: 'a', kind: 'text'},
    {id: 'b', kind: 'text'},
  ]);
  await p.values(n.id, {a: 'typed', b: 'kept'});
  await p.set(n.id, [
    {id: 'a', kind: 'number'},
    {id: 'b', kind: 'text', label: 'B again'},
  ]);
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.value]),
    [
      ['a', 0],
      ['b', 'kept'],
    ]
  );
  await p.set(n.id, []);
  assert.deepEqual(await p.widgets(n.id), []);
});

test('widgets are validated: kinds, ids, sizes; nothing else limits what they hold', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'W', outputs: []});
  await rejects(p.set(n.id, [{id: 'a', kind: 'knob'}]), /Unknown widget kind/);
  await rejects(
    p.set(n.id, [
      {id: 'a', kind: 'text'},
      {id: 'a', kind: 'text'},
    ]),
    /unique/
  );
  await rejects(p.set(n.id, [{id: 'a', kind: 'text', surprise: 1}]), /widget has/);
  await rejects(p.set('record:none', [{id: 'a', kind: 'text'}]), /not found/);
  await p.set(n.id, [
    {id: 'a', kind: 'text'},
    {id: 'l', kind: 'label', text: 'x'},
  ]);
  await rejects(p.values(n.id, {zzz: 1}), /no widget/);
  await rejects(p.values(n.id, {l: 'x'}), /no value/);
  // A widget holds any JSON, e.g. a list.
  await p.set(n.id, [{id: 'a', kind: 'text', value: ['any', {json: 1}]}]);
  assert.deepEqual((await p.widgets(n.id))[0].value, ['any', {json: 1}]);
});

test('a person using a widget fires on_widget of the copy; a Script changing a widget does not', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Echo',
    {
      Body: {inputs: [], outputs: []},
      Used: nodes.event('on_widget', ['widget']),
      Echo: titled(
        'Echo',
        `const widget = context.event.widget;
await agentsys("PUT", "workflows/" + context.workflow_id + "/state/last", {value: widget});
await node.widgets.set({echo: widget.value + "!"});`
      ),
    },
    {
      wires: [['Used', 'out', 'Echo', 'in']],
      widgets: {
        Echo: [
          {id: 't', kind: 'text'},
          {id: 'echo', kind: 'text'},
        ],
      },
    }
  );
  const echo = await place(app, p.id, {workflow_id: p.id}, def);
  await p.idle();
  const body = (await p.snapshot()).complex.find(c => c.id === echo.group).widget_nodes[0];
  assert.equal(await p.state('last'), undefined, 'placing is not using');
  await p.use(body, {t: 'hi'});
  await p.idle();
  assert.deepEqual(await p.state('last'), {id: 't', kind: 'text', value: 'hi'});
  const values = Object.fromEntries((await p.widgets(body)).map(w => [w.id, w.value]));
  assert.deepEqual(values, {t: 'hi', echo: 'hi!'}, 'the Script set echo, which did not fire on_widget again');
  assert.equal((await p.call('GET', 'edit-history')).undo > 0, true);
});

test('a button counts its clicks; a Script of the copy reads the count', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Counter',
    {Body: {inputs: [], outputs: []}, Count: titled('Count', 'node.output.result = context.widgets.go')},
    {widgets: {Body: [{id: 'go', kind: 'button', label: '+1'}]}, outputs: [{id: 'result', name: 'result', node: false}]}
  );
  const counter = await place(app, p.id, {workflow_id: p.id}, def);
  await p.idle();
  const body = (await p.snapshot()).complex.find(c => c.id === counter.group).widget_nodes[0];
  const button = (await p.widgets(body))[0];
  await p.use(body, {go: button.value + 1});
  await p.use(body, {go: button.value + 2});
  await p.idle();
  const count = await counter.node('Count');
  assert.equal((await p.evaluate([count.id])).outputs[count.id].result, 2);
});

test('a Script can change the slots of its own Library node, and the widgets of any other node', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await project(app);
  const target = await p.node({title: 'Target', outputs: []});
  const n = await fn(
    app,
    p.id,
    {workflow_id: p.id},
    {
      code: `const base = "projects/" + context.project_id;
await agentsys("PUT", base + "/node-slots/" + context.instance_id, {inputs: [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}], outputs: [{id: 'o', name: 'o'}]});
await agentsys("PUT", base + "/widgets/" + ${JSON.stringify(target.id)}, {widgets: [{id: 'x', kind: 'textarea', value: 'from outside'}]});`,
    }
  );
  const r = await p.evaluate([n.id]);
  assert.deepEqual(r.errors, {});
  const snap = await p.snapshot(),
    cx = snap.complex.find(c => c.id === n.group);
  assert.deepEqual(
    cx.interface.inputs.map(x => x.id),
    ['in', 'a', 'b']
  );
  assert.deepEqual(
    cx.interface.outputs.map(x => x.id),
    ['o']
  );
  assert.equal(snap.widgets[target.id][0].value, 'from outside');
});

test('widgets go with their node: copy and paste, duplicate, export and import, delete', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'W', outputs: []});
  await p.set(n.id, [{id: 'a', kind: 'text', value: 'one'}]);
  const bundle = await p.call('POST', 'copy', {node_ids: [n.id], group_ids: []});
  const pasted = await p.call('POST', 'paste', {clipboard: bundle, point: {x: 50, y: 50}});
  assert.equal((await p.widgets(pasted.ids[0]))[0].value, 'one');
  const TextGraph = require('../js/storage/format');
  const exported = TextGraph.decode(await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`));
  assert.equal(exported.document.widgets[n.id][0].value, 'one');
  const imported = await app.api(
    'POST',
    `projects/${p.id}/workflows/import`,
    TextGraph.encode({name: 'Copy', document: exported.document})
  );
  assert.ok(imported);
  const copy = await app.api('POST', 'projects', {name: 'Dup'});
  assert.ok(copy);
  await p.call('POST', 'delete-nodes', {node_ids: [n.id]});
  assert.deepEqual(await p.widgets(n.id), []);
  assert.equal(
    TextGraph.decode(await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`)).document.widgets[n.id],
    undefined
  );
  await rejects(
    app.api(
      'POST',
      `projects/${p.id}/workflows/import`,
      TextGraph.encode({name: 'Bad', document: {nodes: [], widgets: {nobody: [{id: 'a', kind: 'text'}]}}})
    ),
    /does not exist/
  );
});

test('nothing in the engine insists on a behaviour: no code, no outputs, odd results', async () => {
  const app = createApp(),
    p = await project(app),
    q = {workflow_id: p.id};
  const quiet = await fn(app, p.id, q, {code: 'const x = 1;', outputs: ['o']});
  const weird = await fn(app, p.id, q, {code: 'node.output.o = undefined;', outputs: ['o']});
  const empty = await p.node(nodes.script(''));
  const early = await p.node(nodes.script('node.display(Object.keys(node.output).length);'));
  const r = await p.evaluate([quiet.id, weird.id, empty.id, early.id]);
  assert.deepEqual(r.errors, {});
  // An output the node does not have, a signal output and a function are mistakes, not values that go nowhere.
  const stray = await fn(app, p.id, q, {code: 'node.output.zzz = 5;'}),
    signalled = await fn(app, p.id, q, {code: 'node.output.out = 1;', signals: ['out']}),
    func = await fn(app, p.id, q, {code: 'node.output.o = () => 1;', outputs: ['o']});
  const bad = await p.evaluate([stray.id, signalled.id, func.id]);
  assert.match(bad.errors[stray.id], /no free output “zzz”/);
  assert.match(bad.errors[signalled.id], /signal output.*emit\("out"\)/);
  assert.match(bad.errors[func.id], /output\.o cannot be sent/);
  assert.deepEqual(r.outputs[quiet.id], {});
  assert.deepEqual(r.outputs[weird.id], {});
  assert.equal(r.displays[early.id], '0');
});

test('a Custom node placed in a library node shows its widgets through the Complex Node (widget_nodes)', async () => {
  const app = createApp(),
    p = await project(app);
  const def = (suffix, value = 'v') =>
    bundleOf(
      'Widgeted',
      {
        Body: {inputs: [], outputs: []},
        S: titled('S', `node.output.out = context.widgets.w + ${JSON.stringify(suffix)}; await node.emit("done")`),
      },
      {
        widgets: {Body: [{id: 'w', kind: 'text', value}]},
        inputs: [{id: 'go', name: 'in', type: 'signal', node: 'S', port: 'in'}],
        outputs: [
          {id: 'out', name: 'out', node: false},
          {id: 'done', name: 'done', type: 'signal', node: false},
        ],
      }
    );
  const widgeted = await place(app, p.id, {workflow_id: p.id}, def(''));
  await p.idle();
  const snap = await p.snapshot(),
    cx = snap.complex.find(c => c.id === widgeted.group);
  assert.ok(cx.widget_nodes[0], 'the Complex Node says where its widgets live');
  assert.equal(snap.widgets[cx.widget_nodes[0]][0].value, 'v');
  await p.use(cx.widget_nodes[0], {w: 'typed'});
  const show = await fn(app, p.id, {workflow_id: p.id}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.call('POST', 'port-connections', {
    add: [{source: widgeted.id, source_port: 'out', target: show.wrapper, target_port: 'v'}],
  });
  const start = await flow(app, p.id, {workflow_id: p.id}, [[widgeted.id, 'go', 'done'], show.step]);
  assert.equal((await p.evaluate([start])).displays[show.id], 'typed');
  // Editing the definition keeps the values the person typed.
  await app.api('PUT', `resources/${widgeted.resource}`, {
    name: 'Widgeted',
    payload: {bundle: def('.', 'reset?').bundle},
    replace: true,
  });
  await p.idle();
  assert.equal((await p.evaluate([start])).displays[show.id], 'typed.');
});

test('config.widgets declares the widgets of a node: they exist from the start, and editing the list keeps the values that stay', async () => {
  const app = createApp(),
    p = await project(app);
  const config = widgets => ({
    ...nodes.script('node.display(JSON.stringify(context.widgets))'),
    title: 'Declared',
    widgets,
  });
  const make = widgets =>
    p.call('POST', 'typed-nodes', {node_type: 'custom', config: config(widgets), position: {x: 0, y: 0}});
  const n = await make([
    {id: 'name', kind: 'text', label: 'Name', value: 'world'},
    {id: 'n', kind: 'number'},
    {id: 'mode', kind: 'select', options: ['a', 'b']},
  ]);
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.kind, w.value]),
    [
      ['name', 'text', 'world'],
      ['n', 'number', 0],
      ['mode', 'select', 'a'],
    ],
    'no hook ran: the definition made them'
  );
  await p.use(n.id, {name: 'typed', n: 5});
  // The definition changes: `name` stays, `n` becomes another kind, `mode` is gone, `extra` is new; the order is the definition's.
  await p.call('PUT', `typed-nodes/${n.id}`, {
    node_type: 'custom',
    config: config([
      {id: 'extra', kind: 'checkbox', value: true},
      {id: 'name', kind: 'text', label: 'Your name', value: 'ignored: a widget that stays keeps its value'},
      {id: 'n', kind: 'text'},
    ]),
  });
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.kind, w.value, w.label]),
    [
      ['extra', 'checkbox', true, undefined],
      ['name', 'text', 'typed', 'Your name'],
      ['n', 'text', ''],
    ].map(r => (r.length === 3 ? [...r, undefined] : r))
  );
  assert.deepEqual(JSON.parse((await p.evaluate([n.id])).displays[n.id]), {extra: true, name: 'typed', n: ''});
  // Code that replaces the widgets is not undone by edits that leave the definition alone (a new title, say).
  await p.set(n.id, [{id: 'mine', kind: 'text', value: 'by code'}]);
  await p.call('PUT', `typed-nodes/${n.id}`, {
    node_type: 'custom',
    config: {
      ...config([
        {id: 'extra', kind: 'checkbox', value: true},
        {id: 'name', kind: 'text', label: 'Your name', value: 'ignored: a widget that stays keeps its value'},
        {id: 'n', kind: 'text'},
      ]),
      title: 'Renamed',
    },
  });
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => w.id),
    ['mine']
  );
  // Taking the declaration away takes the widgets with it.
  await p.call('PUT', `typed-nodes/${n.id}`, {
    node_type: 'custom',
    config: {title: 'Renamed', outputs: [{id: 'result', name: 'result'}]},
  });
  assert.deepEqual(await p.widgets(n.id), []);
});

test('config.widgets is checked like any list of widgets', async () => {
  const app = createApp(),
    p = await project(app);
  const make = widgets =>
    p.call('POST', 'typed-nodes', {node_type: 'custom', config: {title: 'Bad', widgets}, position: {x: 0, y: 0}});
  await rejects(make([{id: 'a', kind: 'nope'}]), /kind/i);
  await rejects(
    make([
      {id: 'a', kind: 'text'},
      {id: 'a', kind: 'text'},
    ]),
    /unique/i
  );
  await rejects(make('text'), /widgets/i);
});

test('a node of a Library node declares its widgets: every copy has them when placed, and refreshing keeps the values typed', async () => {
  const app = createApp(),
    opened = await app.api('POST', 'library/node-editor', {});
  const q = {workflow_id: opened.workflow_id},
    id = opened.project_id;
  const node = await app.api('POST', `projects/${id}/typed-nodes`, {
    ...q,
    node_type: 'custom',
    config: {
      title: 'Fields',
      inputs: [],
      outputs: [{id: 'out', name: 'out'}],
      widgets: [{id: 'w', kind: 'text', value: 'v'}],
    },
    position: {x: 0, y: 0},
  });
  const config = list => ({
    title: 'Fields',
    inputs: [],
    outputs: [{id: 'out', name: 'out'}],
    ...(list ? {widgets: list} : {}),
  });
  const root = (await app.api('GET', `projects/${id}/workflow`, {}, q)).root;
  await app.api('PUT', `projects/${id}/complex/${root}`, {
    ...q,
    interface: {inputs: [], outputs: [{id: 'out', name: 'out', bound: [{node_id: node.id, port_id: 'out'}]}]},
  });
  const p = await project(app);
  const placed = (
    await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {
      workflow_id: p.id,
      point: {x: 0, y: 0},
    })
  ).roots[0];
  const holder = async () => (await p.snapshot()).complex.find(c => c.id === placed).widget_nodes[0];
  assert.equal((await p.widgets(await holder()))[0].value, 'v', 'made at once: no on_placed');
  await p.use(await holder(), {w: 'typed'});
  // The author adds a widget and changes the default of the first: the copy gets the new one and keeps what was typed.
  await app.api('PUT', `projects/${id}/typed-nodes/${node.id}`, {
    ...q,
    node_type: 'custom',
    config: config([
      {id: 'w', kind: 'text', value: 'other'},
      {id: 'more', kind: 'checkbox'},
    ]),
  });
  const copyWidgets = async () => {
    const snap = await p.snapshot(),
      at = snap.complex.find(c => c.id === placed).widget_nodes[0];
    return at ? snap.widgets[at] : [];
  };
  assert.deepEqual(
    (await copyWidgets()).map(w => [w.id, w.value]),
    [
      ['w', 'typed'],
      ['more', false],
    ]
  );
  // An empty list takes the declaration away.
  await app.api('PUT', `projects/${id}/typed-nodes/${node.id}`, {...q, node_type: 'custom', config: config(null)});
  assert.deepEqual(await copyWidgets(), []);
});

test('a markdown widget holds text, and its renderer escapes HTML and refuses unsafe links', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'Md'});
  await p.set(n.id, [{id: 'text', kind: 'markdown', value: '# Hi'}]);
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.kind, w.value]),
    [['text', 'markdown', '# Hi']]
  );
  await p.values(n.id, {text: '**bold**'});
  assert.equal((await p.widgets(n.id))[0].value, '**bold**');
  const {renderMarkdown} = require('../js/app/markdown.js');
  assert.match(
    renderMarkdown('# T\n\n**b** _i_ `<x>`'),
    /<h1>T<\/h1><p><strong>b<\/strong> <em>i<\/em> <code>&lt;x&gt;<\/code><\/p>/
  );
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1)) ![i](https://e.com/a.png)'), /<img|href="javascript/);
  assert.match(
    renderMarkdown('[x](https://e.com)'),
    /<a href="https:\/\/e\.com" target="_blank" rel="noopener noreferrer">x<\/a>/
  );
  assert.match(
    renderMarkdown('- a\n  - b\n- [x] c'),
    /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li><span class="md-task">☑<\/span> c<\/li><\/ul>/
  );
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th>/);
});

test('markdownSlug names Settings sections; a note gets no page links and no images', () => {
  const {renderMarkdown, markdownSlug} = require('../js/app/markdown.js');
  assert.equal(markdownSlug('Keyboard shortcuts'), 'keyboard-shortcuts');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1)) <script>x</script>'), /<script|href="javascript/);
  assert.doesNotMatch(renderMarkdown('[a](/x) ![i](docs/a.png)'), /<a |<figure|<img/);
});
