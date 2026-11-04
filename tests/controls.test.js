'use strict';
// The control of a type (how a free slot is typed in), enum types, and the value of a free input.
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const hex = n => String(n).padStart(32, '0');
const T = n => 't:' + hex(n);

test('port names preserve their declared case through saving, snapshots and placement', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Port spelling'});
  const entry = await app.api('POST', 'resources', {
    name: 'Port spelling',
    payload: bundleOf(
      'Port spelling',
      {Body: {inputs: [], outputs: []}},
      {
        inputs: [{id: 'url', name: 'URL', node: false}],
        outputs: [{id: 'result', name: 'Result', node: false}],
      }
    ),
  });
  const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${entry.id}`, {point: {x: 0, y: 0}});
  const snapshot = await app.api('GET', `projects/${p.id}/workflow`);
  const cx = snapshot.complex.find(c => c.id === placed.roots[0]);
  assert.equal(cx.interface.inputs[0].name, 'URL');
  assert.equal(cx.interface.outputs[0].name, 'Result');
  assert.equal(
    (await app.api('GET', `resources/${entry.id}`)).payload.bundle.complex[0].interface.inputs[0].name,
    'URL'
  );
});
const TEXT = {id: hex(1), name: 'Text', fields: [], control: 'text'},
  COUNT = {id: hex(2), name: 'Count', fields: [], control: 'number'},
  MODE = {id: hex(3), name: 'Mode', fields: [], control: 'select', options: ['fast', 'slow']},
  PLAIN = {id: hex(4), name: 'Plain', fields: []};

async function project(app, types = [TEXT, COUNT, MODE, PLAIN]) {
  const {id} = await app.api('POST', 'projects', {name: 'Controls'});
  await app.api('PUT', `projects/${id}/types`, {types});
  const node = config =>
    app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}});
  const run = ids => app.api('POST', `projects/${id}/evaluate-node`, {node_ids: ids, collect: true});
  /** A Library node around a Script that shows its typed input v (Text, default 'hi'). */
  const echo = () =>
    fn(app, id, {}, {code: 'node.display(String(v))', inputs: [{name: 'v', type: T(1), default: 'hi'}]});
  return {id, node, run, echo, snapshot: () => app.api('GET', `projects/${id}/workflow`)};
}

test('empty port value updates leave the graph and undo history unchanged', async () => {
  const app = createApp(),
    p = await project(app),
    node = await p.echo();
  const before = await p.snapshot(),
    history = (await app.api('GET', `projects/${p.id}/workflow`)).history;
  for (const path of ['input-values', 'output-values'])
    await app.api('PUT', `projects/${p.id}/${path}`, {node_id: node.wrapper, values: {}});
  assert.deepEqual(await p.snapshot(), before);
  assert.deepEqual((await app.api('GET', `projects/${p.id}/workflow`)).history, history);
});

test('a type may have a control; an enum is a select with its options', async () => {
  const app = createApp(),
    p = await project(app);
  const types = (await p.snapshot()).types;
  assert.deepEqual(types.find(t => t.name === 'Mode').options, ['fast', 'slow']);
  const more = [...types];
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Bad', fields: [], control: 'knob'}],
    }),
    /control/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'NoOptions', fields: [], control: 'select'}],
    }),
    /options/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Twice', fields: [], control: 'select', options: ['a', 'a']}],
    }),
    /different/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Opts', fields: [], control: 'text', options: ['a']}],
    }),
    /options/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Rec', fields: [{name: 'x', type: T(1)}], control: 'text'}],
    }),
    /fields/
  );
});

test('an input with no wire takes its default; a wire wins over it', async () => {
  const app = createApp(),
    p = await project(app);
  const node = await p.echo();
  assert.equal((await p.run([node.id])).displays[node.id], 'hi');
  const source = await p.node({
    title: 'Source',
    inputs: [],
    outputs: [{id: 'o', name: 'o', type: T(1), editable: true, default: 'wired'}],
  });
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: source.id, source_port: 'o', target: node.wrapper, target_port: 'v'}],
  });
  assert.equal((await p.run([node.id])).displays[node.id], 'wired');
});

test('the value typed on a node is the default of the input; null takes it away; a wrong value is refused', async () => {
  const app = createApp(),
    p = await project(app);
  const node = await p.echo();
  const set = values => app.api('PUT', `projects/${p.id}/input-values`, {node_id: node.wrapper, values});
  await set({v: 'typed'});
  assert.equal((await p.run([node.id])).displays[node.id], 'typed');
  await set({v: null});
  assert.equal((await p.run([node.id])).displays[node.id], 'undefined');
  await rejects(set({v: 5}), /not a value/);
  await rejects(set({nope: 'x'}), /no input/);
  const plain = await p.node({title: 'P', inputs: [{id: 'a', name: 'a', type: T(4)}], outputs: []});
  await rejects(app.api('PUT', `projects/${p.id}/input-values`, {node_id: plain.id, values: {a: 'x'}}), /no control/);
});

test('an enum input takes only one of its options; removing an option drops a default that no longer fits', async () => {
  const app = createApp(),
    p = await project(app);
  const node = await fn(app, p.id, {}, {code: 'node.display(m)', inputs: [{name: 'm', type: T(3), default: 'fast'}]});
  await rejects(
    p.node({title: 'Bad', inputs: [{id: 'm', name: 'm', type: T(3), default: 'medium'}], outputs: []}),
    /default/
  );
  await rejects(p.node({title: 'Bad', inputs: [{id: 'm', name: 'm', default: 'x'}], outputs: []}), /default/);
  assert.equal((await p.run([node.id])).displays[node.id], 'fast');
  const types = (await p.snapshot()).types.map(t => (t.id === hex(3) ? {...t, options: ['slow', 'later']} : t));
  await app.api('PUT', `projects/${p.id}/types`, {types});
  const slot = (await p.snapshot()).complex.find(c => c.id === node.group).interface.inputs.find(i => i.name === 'm');
  assert.equal('default' in slot, false);
});

/** A Library node whose Script shows its typed input `text` followed by `suffix`, and sets it as its output `out`; it fires `Out`. */
const echoNode = suffix =>
  bundleOf(
    'Echo',
    {
      Body: {inputs: [], outputs: []},
      S: nodes.script(
        `node.output.result = node.input.text + ${JSON.stringify(suffix)}; await node.output.done.emit()`
      ),
    },
    {
      types: [TEXT],
      inputs: [
        {id: 'text', name: 'text', type: T(1), default: 'from the definition', node: false},
        {id: 'go', name: 'in', type: 'signal', node: 'S', port: 'in'},
      ],
      outputs: [
        {id: 'out', name: 'result', node: false},
        {id: 'done', name: 'done', type: 'signal', node: false},
      ],
    }
  );

test('a Library node placed on a workflow keeps the value typed on it, and the default of its definition', async () => {
  const app = createApp(),
    p = await project(app, [TEXT]);
  const echo = await place(app, p.id, {workflow_id: p.id}, echoNode(''));
  await app.Backend.hooksIdle();
  const shown = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: echo.id, source_port: 'out', target: shown.wrapper, target_port: 'v'}],
  });
  const start = await flow(app, p.id, {}, [[echo.id, 'go', 'done'], shown.step]);
  const show = async () => (await p.run([start])).displays[shown.id];
  assert.equal(await show(), 'from the definition');
  await app.api('PUT', `projects/${p.id}/input-values`, {node_id: echo.id, values: {text: 'mine'}});
  assert.equal(await show(), 'mine');
  // The Library node is saved again: the node follows it, and keeps what was typed on it.
  const again = echoNode('!');
  await app.api('PUT', `resources/${echo.resource}`, {name: 'Echo', payload: {bundle: again.bundle}, replace: true});
  await p.snapshot();
  assert.equal(await show(), 'mine!');
  await app.api('PUT', `projects/${p.id}/input-values`, {node_id: echo.id, values: {text: null}});
  assert.equal(await show(), 'undefined!');
});

test('the value of a slot added on a placed node survives an edit of the Library node', async () => {
  const app = createApp(),
    p = await project(app);
  const opened = await app.api('POST', 'library/node-editor', {}),
    q = {workflow_id: opened.workflow_id};
  await app.api('PUT', `projects/${opened.project_id}/types`, {...q, types: [TEXT]});
  const root = (await app.api('GET', `projects/${opened.project_id}/workflow`, {}, q)).root;
  const save = body => app.api('PUT', `projects/${opened.project_id}/complex/${root}`, {...q, ...body});
  await save({interface: {inputs: [{id: 'a', name: 'a'}], outputs: []}, arbitrary: {inputs: true, outputs: false}});
  const placed = (await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {point: {x: 0, y: 0}}))
    .roots[0];
  await app.api('PUT', `projects/${p.id}/complex/${placed}`, {
    extra: {inputs: [{id: 'x1', name: 'extra', type: T(1), default: 'kept'}]},
  });
  const defaults = async () =>
    (await p.snapshot()).complex.find(c => c.id === placed).interface.inputs.map(s => [s.name, s.default]);
  assert.deepEqual(await defaults(), [
    ['a', undefined],
    ['extra', 'kept'],
  ]);
  await save({arbitrary: {inputs: true, outputs: true}});
  assert.deepEqual(await defaults(), [
    ['a', undefined],
    ['extra', 'kept'],
  ]);
});
