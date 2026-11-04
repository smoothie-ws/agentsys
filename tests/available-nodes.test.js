'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, bundleOf} = require('./harness');
const TextGraph = require('../js/storage/format');

async function fixture() {
  const app = createApp({developer: false});
  const project = await app.api('POST', 'projects', {name: 'Availability'});
  const second = await app.api('POST', `projects/${project.id}/workflows`, {name: 'Second'});
  const make = async (name, folder = '') =>
    app.api('POST', 'resources', {
      name,
      payload: bundleOf(name, {Body: {inputs: [], outputs: []}}, {folder}),
    });
  const first = await make('First', 'Logic'),
    nested = await make('Nested', 'Logic/Sub'),
    other = await make('Other', 'Logic sibling');
  const snapshot = (id = project.id) => app.api('GET', `projects/${project.id}/workflow`, {}, {workflow_id: id});
  const toggle = body => app.api('PUT', `projects/${project.id}/available-nodes`, body);
  return {app, project, second, first, nested, other, make, snapshot, toggle};
}

test('Library availability defaults to empty and is independent per workflow, including with Developer mode off', async () => {
  const {app, project, second, first, snapshot, toggle} = await fixture();
  assert.deepEqual((await snapshot()).library_nodes, []);
  await toggle({resource_id: first.id, enabled: true});
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  assert.deepEqual((await snapshot(second.id)).library_nodes, []);
  await toggle({workflow_id: second.id, resource_id: first.id, enabled: true});
  await toggle({resource_id: first.id, enabled: false});
  assert.deepEqual((await snapshot()).library_nodes, []);
  assert.deepEqual((await snapshot(second.id)).library_nodes, [first.id]);
  assert.equal((await app.api('GET', `resources/${first.id}`)).enabled, undefined);
  await app.eval(
    `(async () => {const doc = await DB.get('wf:${project.id}'); delete doc.library_nodes; await DB.commit({'wf:${project.id}': doc});})()`
  );
  assert.deepEqual((await snapshot()).library_nodes, [], 'older documents also default to excluded');
});

test('a group includes and excludes its current descendants, with individual exceptions and no path-prefix collisions', async () => {
  const {first, nested, other, snapshot, toggle, make, app, project} = await fixture();
  await toggle({folder: 'Logic', enabled: true});
  assert.deepEqual(new Set((await snapshot()).library_nodes), new Set([first.id, nested.id]));
  await toggle({resource_id: nested.id, enabled: false});
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  const fresh = await make('New', 'Logic');
  assert.ok(!(await snapshot()).library_nodes.includes(fresh.id), 'new Library nodes start excluded');
  await toggle({resource_id: other.id, enabled: true});
  await app.api('POST', 'library/node-folders', {action: 'rename', path: 'Logic', name: 'Renamed'});
  assert.ok(
    (await snapshot()).library_nodes.includes(first.id),
    'renaming a Library group preserves choices by resource ID'
  );
  await toggle({folder: 'Renamed', enabled: false});
  assert.deepEqual((await snapshot()).library_nodes, [other.id]);
  await assert.rejects(toggle({resource_id: 'missing', enabled: true}), /not found/i);
  await assert.rejects(toggle({folder: 'missing', enabled: true}), /not found/i);
  await assert.rejects(toggle({folder: 'Renamed', resource_id: first.id, enabled: true}), /either/);
  await assert.rejects(toggle({resource_id: first.id, enabled: 'yes'}), /true or false/);
  await assert.rejects(
    app.api('POST', `library/custom-nodes/${first.id}/enabled`, {enabled: false}),
    /endpoint not found/
  );
  await assert.rejects(
    app.api('POST', 'library/node-folders', {action: 'enabled', path: 'Renamed', enabled: false}),
    /Unknown action/
  );
});

test('placing an excluded Library node includes it atomically, supports undo/redo and leaves placed copies when excluded', async () => {
  const {app, project, first, snapshot, toggle} = await fixture();
  const path = `projects/${project.id}`;
  await assert.rejects(app.api('POST', `${path}/custom-nodes/${first.id}`, {point: {x: null, y: 0}}), /Coordinates/);
  assert.deepEqual((await snapshot()).library_nodes, []);
  await app.api('POST', `${path}/custom-nodes/${first.id}`, {point: {x: 80, y: 100}});
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  assert.equal((await snapshot()).complex.length, 1);
  await app.api('POST', `${path}/undo`);
  assert.deepEqual((await snapshot()).library_nodes, []);
  assert.equal((await snapshot()).complex.length, 0);
  await app.api('POST', `${path}/redo`);
  await toggle({resource_id: first.id, enabled: false});
  assert.equal((await snapshot()).complex.length, 1);
  assert.deepEqual((await snapshot()).library_nodes, []);
  await app.api('POST', `${path}/undo`);
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  await app.api('POST', `${path}/redo`);
  assert.deepEqual((await snapshot()).library_nodes, []);
});

test('availability survives document storage, workflow/project duplication, and export/import', async () => {
  const {app, project, first, toggle} = await fixture();
  const path = `projects/${project.id}`;
  await toggle({resource_id: first.id, enabled: true});
  assert.deepEqual(
    JSON.parse(await app.eval(`(async () => JSON.stringify((await DB.get('wf:${project.id}')).library_nodes))()`)),
    [first.id]
  );
  const copy = await app.api('POST', `${path}/workflows/${project.id}/duplicate`);
  assert.deepEqual((await app.api('GET', `${path}/workflow`, {}, {workflow_id: copy.id})).library_nodes, [first.id]);
  const projectCopy = await app.api('POST', `${path}/duplicate`);
  assert.deepEqual((await app.api('GET', `projects/${projectCopy.id}/workflow`)).library_nodes, [first.id]);
  const packet = await app.api('GET', `${path}/workflows/${project.id}/export`);
  const imported = await app.api('POST', `${path}/workflows/import`, packet);
  assert.deepEqual((await app.api('GET', `${path}/workflow`, {}, {workflow_id: imported.id})).library_nodes, [
    first.id,
  ]);
  const projectPacket = await app.api('GET', `${path}/export`);
  const projectImport = await app.api('POST', 'projects/import', projectPacket);
  assert.deepEqual((await app.api('GET', `projects/${projectImport.id}/workflow`)).library_nodes, [first.id]);
  const broken = TextGraph.decode(packet);
  broken.document.library_nodes = [42];
  await assert.rejects(app.api('POST', `${path}/workflows/import`, TextGraph.encode(broken)), /resource IDs/);
});
