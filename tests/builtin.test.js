'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

const names = async app => (await app.api('GET', 'resources')).map(r => r.name);

test('Execute passes the checked API, context and intrinsics into its nested Script', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownExecutions());
  await app.api('POST', 'library/builtin', {});
  const project = await app.api('POST', 'projects', {name: 'Execute bridge'});
  const item = (await app.api('GET', 'resources')).find(r => r.name === 'Execute');
  await app.api('PUT', 'resources/' + item.id, {
    name: item.name,
    payload: {...item.payload, grants: ['library.read']},
  });
  const copy = await app.api('POST', `projects/${project.id}/custom-nodes/${item.id}`, {point: {x: 0, y: 0}});
  const wrapper = 'complex:' + copy.roots[0];
  const code = `const nodes=await agentsys('GET','resources');
    node.display('Execute API works');
    return {nodes:nodes.length,project:context.project_id,year:new Date(0).getUTCFullYear(),rounded:Math.round(1.7)};`;
  await app.api('PUT', `projects/${project.id}/input-values`, {node_id: wrapper, values: {pr97li: code}});
  const snapshot = await app.api('GET', `projects/${project.id}/workflow`);
  const script = snapshot.nodes.find(
    n => snapshot.complex.find(c => c.id === copy.roots[0]).members.includes(n.id) && n.config?.op === 'script'
  );
  const result = await app.api('POST', `projects/${project.id}/execution`, {node_ids: [script.id], wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.deepEqual(result.outputs[script.id].pxltyf, {
    nodes: (await names(app)).length,
    project: project.id,
    year: 1970,
    rounded: 2,
  });
  assert.equal(result.displays[script.id], 'Execute API works');
});

test('built-in nodes: added to an empty Library, once, with stable ids and their groups', async () => {
  const app = createApp();
  const listed = await app.api('GET', 'library/builtin');
  assert.ok(listed.some(n => n.name === 'Delay'));
  assert.ok(!listed.some(n => n.name === 'Wait for event' || n.folder === 'Streams'));
  assert.ok(listed.every(n => n.installed === false));
  assert.ok(!listed.some(n => ['Sleep', 'Wait until'].includes(n.name)));
  const first = await app.api('POST', 'library/builtin', {});
  assert.equal(first.added.length, first.total);
  const items = await app.api('GET', 'resources');
  assert.equal(items.length, first.total);
  assert.ok(items.every(r => r.id.startsWith('builtin.')));
  assert.ok(items.some(r => r.payload.folder === 'Flow'));
  assert.deepEqual((await app.api('POST', 'library/builtin', {})).added, []);
  assert.equal(
    (await app.api('GET', 'library/builtin')).every(n => n.installed),
    true
  );
});

test('built-in nodes: a node the person has is kept, one they deleted stays deleted until restored', async () => {
  const app = createApp();
  await app.api('POST', 'library/builtin', {});
  const items = await app.api('GET', 'resources');
  const gone = items.find(r => r.name === 'For');
  await app.api('DELETE', `resources/${gone.id}`);
  assert.deepEqual((await app.api('POST', 'library/builtin', {})).added, []);
  assert.equal((await names(app)).includes('For'), false);
  assert.deepEqual((await app.api('POST', 'library/builtin', {restore: true})).added, ['For']);
  assert.equal((await names(app)).includes('For'), true);
  // Edits are theirs: a later start does not overwrite them.
  const text = (await app.api('GET', 'resources')).find(r => r.name === 'Text');
  await app.api('PUT', `resources/${text.id}`, {name: 'Text', payload: {...text.payload, description: 'mine'}});
  await app.api('POST', 'library/builtin', {restore: true});
  assert.equal((await app.api('GET', `resources/${text.id}`)).payload.description, 'mine');
});

test('built-in nodes: a Library that already has a node of that name gets no second one', async () => {
  const a = createApp();
  await a.api('POST', 'library/builtin', {});
  const exported = (await a.api('GET', 'resources')).filter(r => r.name === 'Bool');
  const b = createApp();
  await b.api('POST', 'resources', {name: 'Bool', payload: exported[0].payload});
  const result = await b.api('POST', 'library/builtin', {});
  assert.equal(result.added.includes('Bool'), false);
  assert.equal((await names(b)).filter(n => n === 'Bool').length, 1);
});

test('every built-in node places with valid defaults and permissions', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Built-in checks'});
  await app.api('POST', 'library/builtin', {});
  const items = await app.api('GET', 'resources');
  assert.ok(items.length > 20);
  for (const item of items) {
    assert.ok(Array.isArray(item.payload.grants), item.name);
    const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${item.id}`, {point: {x: 0, y: 0}});
    assert.equal(placed.roots.length, 1, item.name);
  }
});
