'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

test('built-in AI installs once, groups its native Library collections and respects disabling and deletion', async () => {
  const app = createApp();
  assert.deepEqual((await app.api('POST', 'plugins/builtin', {})).added, ['ai']);
  const ai = await app.api('GET', 'plugins/ai');
  assert.equal(ai.enabled, true);
  assert.deepEqual(ai.grants, []);
  assert.deepEqual(
    ai.manifest.contributes.library.map(p => [p.id, p.parent]),
    [
      ['ai', undefined],
      ['providers', 'ai'],
      ['skills', 'ai'],
    ]
  );
  await app.api('PUT', 'plugins/ai', {enabled: false});
  await app.api('POST', 'plugins/builtin', {});
  assert.equal((await app.api('GET', 'plugins/ai')).enabled, false);
  await app.api('DELETE', 'plugins/ai');
  assert.deepEqual((await app.api('POST', 'plugins/builtin', {})).added, []);
  assert.deepEqual((await app.api('POST', 'plugins/builtin', {restore: true})).added, ['ai']);
});

test('nested plugin pages reject missing parents, cycles and cross-section parents', async () => {
  const app = createApp();
  await app.api('POST', 'plugins/builtin', {});
  const pkg = {
    format: 'agentsys.plugin/1',
    manifest: {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      contributes: {
        pages: [
          {id: 'overview', title: 'Overview', entry: 'ui.html'},
          {id: 'providers', title: 'Providers', entry: 'ui.html', parent: 'overview'},
        ],
      },
    },
    files: {'ui.html': '<p>demo</p>'},
  };
  for (const change of [
    p => {
      p[1].parent = 'missing';
    },
    p => {
      p[0].parent = 'providers';
    },
    p => {
      p[0].section = 'library';
    },
  ]) {
    const invalid = structuredClone(pkg);
    change(invalid.manifest.contributes.pages);
    await assert.rejects(app.api('POST', 'plugins', {package: invalid, replace: true}), /parent|cycle/);
  }
  assert.equal((await app.api('GET', 'plugins/ai')).enabled, true);
});
