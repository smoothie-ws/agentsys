'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');
const aiApp = async () => {
  const app = createApp();
  await app.api('POST', 'plugins/builtin', {});
  return app;
};
const provider = (over = {}) => ({
  name: 'Local Ollama',
  description: 'Local models',
  values: {
    providerId: 'local',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'private-key',
  },
  ...over,
});
test('typed resources validate values and unique IDs; credentials are separate and never returned', async () => {
  const app = await aiApp(),
    made = await app.api('POST', 'library/sections/ai.providers/items', provider());
  assert.deepEqual(made.secrets, {apiKey: true});
  assert.ok(!JSON.stringify(made).includes('private-key'));
  assert.equal(made.values.npm, '@ai-sdk/openai-compatible');
  const stored = await app.eval("DB.get('library/sections/ai.providers')");
  assert.ok(!JSON.stringify(stored).includes('private-key'));
  assert.equal((await app.eval(`DB.get('library/credentials/ai.providers/${made.id}')`)).apiKey, 'private-key');
  await assert.rejects(
    app.api('POST', 'library/sections/ai.providers/items', provider({name: 'Other'})),
    /already exists/
  );
  for (const values of [
    {baseURL: 'javascript:alert(1)'},
    {providerId: 'Bad ID'},
    {env: {}},
    {models: []},
    {unknown: true},
  ])
    await assert.rejects(
      app.api('PUT', `library/sections/ai.providers/items/${made.id}`, {values}),
      /URL|letters|array|object|Unknown/
    );
  await app.api('PUT', `library/sections/ai.providers/items/${made.id}`, {description: 'Updated'});
  assert.equal((await app.api('GET', `library/sections/ai.providers/items/${made.id}`)).secrets.apiKey, true);
  await app.api('PUT', `library/sections/ai.providers/items/${made.id}`, {values: {apiKey: ''}});
  assert.deepEqual((await app.api('GET', `library/sections/ai.providers/items/${made.id}`)).secrets, {});
});
test('catalog declarations reject cycles, invalid fields and missing action endpoints', async () => {
  const app = createApp(),
    section = {id: 'items', title: 'Items', item: {name: 'Entry', fields: []}};
  const install = library =>
    app.api('POST', 'plugins', {
      package: {
        format: 'agentsys.plugin/2',
        manifest: {id: 'demo', name: 'Demo', version: '1.0.0', main: 'main.js'},
        files: {
          'main.js': `exports.activate=({app})=>{for(const section of ${JSON.stringify(library)})app.library.registerCollection(section);};`,
        },
      },
      enable: true,
      replace: true,
    });
  for (const library of [
    [{...section, parent: 'missing'}],
    [{...section, parent: 'items'}],
    [{...section, item: {fields: [{key: 'constructor', type: 'text'}]}}],
    [{...section, actions: [{id: 'sync', title: 'Sync', endpoint: 'missing'}]}],
  ])
    await assert.rejects(install(library), /parent|cycle|field|endpoint/i);
});
