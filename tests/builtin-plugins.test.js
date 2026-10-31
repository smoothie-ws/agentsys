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
    ai.contributions.library.map(p => [p.id, p.parent]),
    [
      ['ai', undefined],
      ['providers', 'ai'],
    ]
  );
  await app.api('PUT', 'plugins/ai', {enabled: false});
  await app.api('POST', 'plugins/builtin', {});
  assert.equal((await app.api('GET', 'plugins/ai')).enabled, false);
  await app.api('DELETE', 'plugins/ai');
  assert.deepEqual((await app.api('POST', 'plugins/builtin', {})).added, []);
  assert.deepEqual((await app.api('POST', 'plugins/builtin', {restore: true})).added, ['ai']);
});

test('registered pages reject invalid parent hierarchies', async () => {
  const app = createApp();
  const pages = [
    {id: 'overview', title: 'Overview', entry: 'ui.html'},
    {id: 'providers', title: 'Providers', entry: 'ui.html', parent: 'overview'},
  ];
  for (const change of [
    p => (p[1].parent = 'missing'),
    p => (p[0].parent = 'providers'),
    p => (p[0].section = 'library'),
  ]) {
    const entries = structuredClone(pages);
    change(entries);
    const pkg = {
      format: 'agentsys.plugin/2',
      manifest: {id: 'demo', name: 'Demo', version: '1.0.0', main: 'main.js'},
      files: {
        'ui.html': '<p>demo</p>',
        'main.js':
          'exports.activate=({app})=>{for(const page of ' + JSON.stringify(entries) + ')app.views.register(page);};',
      },
    };
    await assert.rejects(app.api('POST', 'plugins', {package: pkg, replace: true, enable: true}), /parent|cycle/);
  }
});
