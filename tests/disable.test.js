'use strict';
// Disabling nodes and groups: a run skips them, and a group takes everything inside it along. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

async function setup() {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Disable'}),
    q = {workflow_id: id},
    call = (method, path, body = {}) => app.api(method, `projects/${id}/${path}`, {...q, ...body}, q);
  const add = config => call('POST', 'typed-nodes', {node_type: 'custom', config, position: {x: 0, y: 0}});
  const source = await add(nodes.value('text', 'hi')),
    inner = await fn(app, id, q, {code: 'node.output.result = input + "!"; await node.emit("out")', inputs: ['input'], outputs: ['result'], signals: ['out']}),
    outer = await fn(app, id, q, {code: 'node.display(String(input) + "?");', inputs: ['input']});
  const start = await flow(app, id, q, [inner.step, outer.step]);
  await call('POST', 'port-connections', {add: [{source: source.id, source_port: 'value', target: inner.wrapper, target_port: 'input'}]});
  await call('POST', 'port-connections', {add: [{source: inner.wrapper, source_port: 'result', target: outer.wrapper, target_port: 'input'}]});
  return {gid: inner.group, call, source, inner, outer, start, run: ids => call('POST', 'evaluate-node', {node_ids: ids, collect: true})};
}

test('a disabled group disables what is in it, and what it fed gets nothing', async () => {
  const s = await setup();
  assert.equal((await s.run([s.start])).displays[s.outer.id], 'hi!?');
  const style = await s.call('PUT', 'node-style', {group_id: s.gid, disabled: true});
  assert.equal(style.disabled, true);
  const snap = await s.call('GET', 'workflow');
  assert.equal(snap.groups.find(g => g.id === s.gid).disabled, true);
  const member = snap.nodes.find(n => n.id === s.inner.id);
  assert.equal(member.disabled, false);
  assert.equal(member.muted, true); // off only because of its group
  assert.equal(snap.nodes.find(n => n.id === s.outer.id).muted, false);
  assert.equal((await s.run([s.start])).displays[s.outer.id], undefined); // the signal does not pass the disabled node, and nothing arrives from it
  assert.equal((await s.run([s.outer.id])).displays[s.outer.id], 'undefined?');
  const own = await s.run([s.inner.id]);
  assert.match(JSON.stringify(own), /disabled/);
  await s.call('PUT', 'node-style', {group_id: s.gid, disabled: false});
  assert.equal((await s.run([s.start])).displays[s.outer.id], 'hi!?');
});

test('a group can be collapsed and disabled', async () => {
  const s = await setup();
  await s.call('PUT', 'node-style', {group_id: s.gid, folded: true, disabled: true});
  const snap = await s.call('GET', 'workflow');
  const g = snap.groups.find(x => x.id === s.gid);
  assert.deepEqual([g.folded, g.disabled], [true, true]);
});
