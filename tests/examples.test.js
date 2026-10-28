'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const TextGraph = require('../js/storage/format');
const {createApp} = require('./harness');
test('all roadmap Library examples place with valid defaults and manifests', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Catalog checks'});
  for (const file of ['wait-nodes', 'initiative-nodes', 'ai-nodes']) {
    const entries = TextGraph.decode(require('../examples/' + file + '.json'));
    for (const entry of entries) {
      assert.ok(Array.isArray(entry.payload.capabilities));
      const resource = await app.api('POST', 'resources', entry);
      const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${resource.id}`, {point: {x: 0, y: 0}});
      assert.equal(placed.roots.length, 1, entry.name);
    }
  }
});
test('Planner to task runner example maintains an Initiative through the API', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Planner fixture'});
  // Import the node definitions as well: workflow copies have explicit Library manifests.
  const graph = TextGraph.decode(require('../examples/planner-task-runner.json'));
  const w = await app.api('POST', `projects/${p.id}/workflows/import`, TextGraph.encode(graph));
  const r = await app.api('POST', `projects/${p.id}/runs`, {workflow_id: w.id, wait: 1});
  assert.equal(r.status, 'completed', JSON.stringify(r.errors));
  const [i] = await app.api('GET', 'initiatives'),
    detail = await app.api('GET', 'initiatives/' + i.id);
  assert.equal(detail.tasks[0].status, 'done');
  assert.equal(detail.decisions.length, 1);
});
