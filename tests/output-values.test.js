'use strict';
// An output that shows a control (`editable`): the value typed on the node is what the node outputs until its code sets another. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const hex = n => String(n).padStart(32, '0');
const TEXT = {id: hex(1), name: 'text', fields: [], control: 'textarea'},
  PLAIN = {id: hex(2), name: 'plain', fields: []};

async function setup() {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Outputs'}),
    q = {workflow_id: id},
    call = (method, path, body = {}) => app.api(method, `projects/${id}/${path}`, {...q, ...body}, q);
  await call('PUT', 'types', {types: [TEXT, PLAIN]});
  const node = config => call('POST', 'typed-nodes', {node_type: 'custom', config, position: {x: 0, y: 0}});
  return {app, id, call, node, run: ids => call('POST', 'evaluate-node', {node_ids: ids, collect: true})};
}

test('the value typed into an editable output is the output of a node without an operation, and of a Script that leaves it alone', async () => {
  const s = await setup();
  const value = await s.node({title: 'Value', outputs: [{id: 'value', name: 'value', type: 't:' + TEXT.id, editable: true}]});
  assert.deepEqual((await s.run([value.id])).outputs[value.id], {});
  await s.call('PUT', 'output-values', {node_id: value.id, values: {value: 'hello'}});
  assert.equal((await s.run([value.id])).outputs[value.id].value, 'hello');
  const snap = await s.call('GET', 'workflow');
  const port = snap.nodes.find(n => n.id === value.id).outputs[0];
  assert.deepEqual([port.editable, port.default], [true, 'hello']);

  const reader = await fn(s.app, s.id, {workflow_id: s.id}, {
    code: 'node.output.b = node.output.a + "!";',
    outputs: [
      {name: 'a', type: 't:' + TEXT.id, editable: true},
      {name: 'b', type: 't:' + TEXT.id, editable: true},
    ],
  });
  await s.call('PUT', 'output-values', {node_id: reader.wrapper, values: {a: 'x', b: 'y'}});
  const out = (await s.run([reader.id])).outputs[reader.id];
  assert.deepEqual([out.a, out.b], ['x', 'x!']); // the code reads what was typed, and may overwrite it
  await s.call('PUT', 'output-values', {node_id: value.id, values: {value: null}});
  assert.deepEqual((await s.run([value.id])).outputs[value.id], {});
});

test('only an output that asks for it, with a type that has a control, holds a value', async () => {
  const s = await setup();
  await rejects(s.node({outputs: [{id: 'o', name: 'o', type: 't:' + PLAIN.id, editable: true}]}), /control/);
  await rejects(s.node({outputs: [{id: 'o', name: 'o', editable: true}]}), /control/);
  const plain = await s.node({outputs: [{id: 'o', name: 'o', type: 't:' + TEXT.id}]});
  await rejects(s.call('PUT', 'output-values', {node_id: plain.id, values: {o: 'x'}}), /does not show a control/);
  const value = await s.node({outputs: [{id: 'o', name: 'o', type: 't:' + TEXT.id, editable: true}]});
  await rejects(s.call('PUT', 'output-values', {node_id: value.id, values: {nope: 'x'}}), /no output/);
});

test('a Library node defines an editable output; each placed copy holds its own value, and editing the definition keeps it', async () => {
  const app = createApp(),
    opened = await app.api('POST', 'library/node-editor', {});
  const q = {workflow_id: opened.workflow_id},
    id = opened.project_id,
    type = {id: hex(7), name: 'text', fields: [], control: 'textarea'};
  await app.api('PUT', `projects/${id}/types`, {...q, types: [type]});
  const root = (await app.api('GET', `projects/${id}/workflow`, {}, q)).root;
  // The value is held by a node inside the Library node: its output, which the group publishes.
  const holder = await app.api('POST', `projects/${id}/typed-nodes`, {
    ...q,
    node_type: 'custom',
    config: {title: 'Value', inputs: [], outputs: [{id: 'out', name: 'out', type: 't:' + type.id, editable: true, default: 'start'}]},
    position: {x: 0, y: 0},
  });
  const define = (editable, arbitrary = {inputs: false, outputs: false}) =>
    app.api('PUT', `projects/${id}/complex/${root}`, {...q, interface: {inputs: [], outputs: [{id: 'out', name: 'out', type: 't:' + type.id, bound: [{node_id: holder.id, port_id: 'out'}], ...(editable ? {editable: true, default: 'start'} : {})}]}, arbitrary});
  await define(true);
  const {id: wid} = await app.api('POST', 'projects', {name: 'Placed'}),
    wq = {workflow_id: wid};
  const placed = (await app.api('POST', `projects/${wid}/custom-nodes/${opened.resource_id}`, {workflow_id: wid, point: {x: 0, y: 0}})).roots[0];
  const output = async () => (await app.api('GET', `projects/${wid}/workflow`, {}, wq)).complex.find(c => c.id === placed).outputs[0];
  assert.deepEqual([(await output()).editable, (await output()).default], [true, 'start']);
  await app.api('PUT', `projects/${wid}/output-values`, {...wq, node_id: 'complex:' + placed, values: {out: 'typed'}});
  const show = await fn(app, wid, wq, {code: 'node.display(input)', inputs: ['input']});
  await app.api('POST', `projects/${wid}/port-connections`, {...wq, add: [{source: 'complex:' + placed, source_port: 'out', target: show.wrapper, target_port: 'input'}]});
  const run = () => app.api('POST', `projects/${wid}/evaluate-node`, {...wq, node_ids: [show.id], collect: true});
  assert.equal((await run()).displays[show.id], 'typed');
  // The definition changes: the typed value stays.
  await define(true, {inputs: true, outputs: false});
  await app.Backend.hooksIdle();
  assert.equal((await output()).default, 'typed');
  assert.equal((await run()).displays[show.id], 'typed');
});
