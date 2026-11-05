'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn} = require('./harness');
const TextGraph = require('../js/storage/format');

test('graph import preserves empty group geometry and ignores execution state', async () => {
  const app = createApp();
  const p = await app.api('POST', 'projects', {name: 'Empty group exchange'});
  const path = `projects/${p.id}`;
  await app.api('PUT', path + '/groups', {groups: [{id: 'empty', name: 'Empty', members: [], parent: null,
    position: {x: 120, y: 240, width: 320, height: 180}}]});
  const packet = await app.api('GET', `${path}/workflows/${p.id}/export`);
  const decoded = TextGraph.decode(packet);
  assert.equal(decoded.document.runtime, undefined);
  decoded.document.runtime = {state: {shouldNotImport: true}};
  const target = await app.api('POST', path + '/workflows', {name: 'Destination'});
  await app.api('POST', path + '/import-graph', {workflow_id: target.id, graph: TextGraph.encode(decoded), point: {x: 500, y: 600}});
  const snap = await app.api('GET', path + '/workflow', {}, {workflow_id: target.id});
  assert.deepEqual(snap.groups[0].position, {x: 500, y: 600, width: 320, height: 180});
  assert.deepEqual((await app.api('GET', path + '/execution', {}, {workflow_id: target.id})).state, {});
  const created = await app.api('POST', path + '/workflows/import', TextGraph.encode({...decoded, name: 'Chosen name'}));
  assert.equal(created.name, 'Chosen name');
  assert.deepEqual((await app.api('GET', path + '/execution', {}, {workflow_id: created.id})).state, {});
});

test('graph import keeps Complex Node bindings, group sizes, widgets, styles and external wires', async () => {
  const app = createApp();
  const p = await app.api('POST', 'projects', {name: 'Complex exchange'}), path = `projects/${p.id}`;
  const source = await fn(app, p.id, {}, {name: 'Source', code: 'node.output.result=7;', outputs: ['result']});
  const target = await app.api('POST', path + '/typed-nodes', {node_type: 'custom',
    config: {title: 'Target', inputs: [{id: 'in', name: 'in'}], outputs: []}, position: {x: 700, y: 200}});
  await app.api('POST', path + '/port-connections', {add: [{source: source.wrapper, source_port: 'result', target: target.id, target_port: 'in'}]});
  const before = await app.api('GET', path + '/workflow');
  await app.api('PUT', path + '/groups', {groups: [
    ...before.groups.map(g => ({id:g.id,name:g.name,members:g.members,parent:'outer',position:g.position})),
    {id:'outer',name:'Outer',members:[target.id],parent:null,position:{x:-100,y:-80,width:1100,height:500}},
  ]});
  await app.api('PUT', path + '/node-style', {group_id:'outer',color:'#123456',pinned:true});
  await app.api('PUT', path + '/widgets/' + target.id, {widgets:[{id:'text',kind:'text',value:'kept'}]});
  const packet = await app.api('GET', `${path}/workflows/${p.id}/export`);
  const destination = await app.api('POST', path + '/workflows', {name:'Destination'});
  const paste = await app.api('POST', path + '/import-graph', {workflow_id:destination.id,graph:packet,point:{x:100,y:200}});
  const snap = await app.api('GET', path + '/workflow', {}, {workflow_id:destination.id});
  assert.equal(snap.complex.length,before.complex.length);
  const group = snap.groups.find(g=>g.name==='Outer');
  assert.deepEqual(group.position,{x:100,y:200,width:1100,height:500});
  assert.equal(group.pinned,true);assert.equal(group.color,'#123456');
  assert.equal(paste.roots.length,1);assert.equal(paste.roots[0],group.id);
  const wrapper = snap.complex[0];
  assert.equal(snap.groups.find(g=>g.id===wrapper.id).parent,group.id);
  for(const port of [...wrapper.interface.inputs,...wrapper.interface.outputs])
    for(const binding of port.bound??[]) assert.ok(wrapper.members.includes(binding.node_id));
  const pastedTarget = snap.nodes.find(n=>n.config?.title==='Target');
  assert.equal(snap.widgets[pastedTarget.id][0].value,'kept');
  assert.ok(snap.edges.some(e=>e.source==='complex:'+wrapper.id&&e.target===pastedTarget.id));
});
