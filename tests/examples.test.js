'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const TextGraph = require('../js/storage/format');
const {createApp} = require('./harness');
test('the Library node catalogs in examples/ place with valid defaults and manifests', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Catalog checks'});
  for (const file of ['wait-nodes', 'flow-nodes', 'basic-nodes', 'stream-nodes']) {
    const entries = TextGraph.decode(require('../examples/' + file + '.json'));
    for (const entry of entries) {
      assert.ok(Array.isArray(entry.payload.capabilities));
      const resource = await app.api('POST', 'resources', entry);
      const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${resource.id}`, {point: {x: 0, y: 0}});
      assert.equal(placed.roots.length, 1, entry.name);
    }
  }
});
