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
    models: {llama3: {name: 'Llama 3'}},
    apiKey: 'private-key',
  },
  ...over,
});
const skill = (name = 'review-code') => ({
  name,
  description: 'Review code clearly.',
  values: {instructions: '# Review\n\nCheck correctness first.'},
});
test('Library is namespaced, native, and disabled collections disappear without losing data', async () => {
  const app = await aiApp();
  assert.deepEqual(
    (await app.api('GET', 'library/sections')).map(s => [s.id, s.parent]),
    [
      ['nodes', undefined],
      ['ai.ai', undefined],
      ['ai.providers', 'ai.ai'],
      ['ai.skills', 'ai.ai'],
    ]
  );
  const made = await app.api('POST', 'library/sections/ai.skills/items', skill());
  await app.api('PUT', 'plugins/ai', {enabled: false});
  assert.deepEqual(
    (await app.api('GET', 'library/sections')).map(s => s.id),
    ['nodes']
  );
  await assert.rejects(app.api('GET', 'library/sections/ai.skills/items'), /disabled/);
  await app.api('PUT', 'plugins/ai', {enabled: true});
  assert.equal((await app.api('GET', 'library/sections/ai.skills/items')).items[0].id, made.id);
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
test('Skills use canonical Markdown with preserved extra frontmatter and no duplicate instructions in JSON', async () => {
  const app = await aiApp(),
    made = await app.api('POST', 'library/sections/ai.skills/items', skill());
  assert.match(made.content, /^---\nname: review-code\ndescription: "Review code clearly\."\n---\n\n# Review/);
  const stored = await app.eval("DB.get('library/sections/ai.skills')");
  assert.equal(stored.items[0].values, undefined);
  assert.equal(stored.items[0].name, undefined);
  assert.equal(await app.eval(`DB.get('${stored.items[0].file}')`), made.content);
  const imported = await app.api('POST', 'library/sections/ai.skills/items', {
    content:
      '---\nname: imported\ndescription: >\n  A longer\n  description.\nlicense: MIT\nmetadata:\n  author: Test\n---\n\nInstructions.',
  });
  assert.equal(imported.description, 'A longer description.');
  const renamed = await app.api('PUT', `library/sections/ai.skills/items/${imported.id}`, {name: 'renamed'});
  assert.match(renamed.content, /license: MIT\nmetadata: \n  author: Test/);
  assert.equal(await app.eval("DB.get('library/skills/ai.skills/imported/SKILL.md')"), undefined);
  const summary = await app.api('GET', 'library/sections/ai.skills/items', {}, {summary: 1});
  assert.equal(summary.items[0].content, undefined);
  assert.equal(summary.items[0].values, undefined);
  for (const data of [
    skill('Uppercase'),
    {...skill(), description: ''},
    {...skill(), values: {instructions: ''}},
    {content: 'No frontmatter'},
  ])
    await assert.rejects(app.api('POST', 'library/sections/ai.skills/items', data));
});
test('folder rename, moving items and cascading deletion keep Markdown and credentials consistent', async () => {
  const app = await aiApp(),
    route = 'library/sections/ai.skills';
  await app.api('POST', route + '/folders', {action: 'create', name: 'Parent'});
  await app.api('POST', route + '/folders', {action: 'create', path: 'Parent', name: 'Child'});
  const made = await app.api('POST', route + '/items', {...skill(), folder: 'Parent/Child'});
  await app.api('POST', route + '/folders', {action: 'rename', path: 'Parent', name: 'Renamed'});
  assert.equal((await app.api('GET', route + '/items/' + made.id)).folder, 'Renamed/Child');
  await app.api('POST', route + '/folders', {action: 'delete', path: 'Renamed'});
  assert.deepEqual(await app.api('GET', route + '/items'), {folders: [], items: []});
  assert.equal(await app.eval("DB.get('library/skills/ai.skills/review-code/SKILL.md')"), undefined);
  await assert.rejects(app.api('POST', route + '/folders', {action: 'create', name: '../outside'}), /Invalid/);
  const p = await app.api('POST', 'library/sections/ai.providers/items', provider());
  await app.api('DELETE', 'plugins/ai');
  assert.equal(await app.eval("DB.get('library/sections/ai.providers')"), undefined);
  assert.equal(await app.eval(`DB.get('library/credentials/ai.providers/${p.id}')`), undefined);
});
test('plugins can use their own resource API without global grants, and cannot use another collection', async () => {
  const app = await aiApp(),
    bridge = (method, path, body) => app.api('POST', 'plugins/ai/bridge', {method, path, body});
  assert.equal((await bridge('POST', 'library/sections/ai.skills/items', skill())).name, 'review-code');
  await assert.rejects(bridge('GET', 'library/sections/nodes/items'), /permission/);
  await app.api('PUT', 'plugins/ai', {enabled: false});
  await assert.rejects(bridge('GET', 'library/sections/ai.skills/items'), /not enabled|disabled/);
});
test('removal also clears collections retired by a package update', async () => {
  const app = await aiApp();
  const made = await app.api('POST', 'library/sections/ai.skills/items', skill());
  await app.api('POST', 'plugins', {
    replace: true,
    package: {format: 'agentsys.plugin/1', manifest: {id: 'ai', name: 'AI', version: '1.0.0'}, files: {}},
  });
  assert.equal((await app.api('GET', 'library/sections')).length, 1);
  await app.api('DELETE', 'plugins/ai');
  assert.equal(await app.eval("DB.get('library/sections/ai.skills')"), undefined);
  assert.equal(await app.eval(`DB.get('library/skills/ai.skills/${made.name}/SKILL.md')`), undefined);
});
test('catalog declarations reject cycles, invalid fields and missing action endpoints', async () => {
  const app = createApp(),
    section = {id: 'items', title: 'Items', item: {name: 'Entry', fields: []}};
  const install = library =>
    app.api('POST', 'plugins', {
      package: {
        format: 'agentsys.plugin/1',
        manifest: {id: 'demo', name: 'Demo', version: '1.0.0', contributes: {library}},
        files: {},
      },
    });
  for (const library of [
    [{...section, parent: 'missing'}],
    [{...section, parent: 'items'}],
    [{...section, item: {fields: [{key: 'constructor', type: 'text'}]}}],
    [{...section, actions: [{id: 'sync', title: 'Sync', endpoint: 'missing'}]}],
  ])
    await assert.rejects(install(library), /parent|cycle|field|endpoint/i);
});
test('bundled updates preserve disabled state and migrate old AI scaffold data once', async () => {
  const app = await aiApp();
  await app.api('PUT', 'plugins/ai/data/skills:old', {value: {name: 'Review Code', detail: 'Read code carefully.'}});
  await app.api('PUT', 'plugins/ai', {enabled: false});
  // Index key is deliberately obtained from the core, not duplicated in this test.
  await app.eval(
    "(async()=>{const records=await DB.get(PLUGIN_INDEX);records[0].manifest.version='0.1.0';await DB.commit({[PLUGIN_INDEX]:records});})()"
  );
  assert.deepEqual((await app.api('POST', 'plugins/builtin', {})).updated, ['ai']);
  assert.equal((await app.api('GET', 'plugins/ai')).enabled, false);
  await app.api('PUT', 'plugins/ai', {enabled: true});
  assert.equal((await app.api('GET', 'library/sections/ai.skills/items')).items[0].name, 'review-code');
  await app.api('POST', 'plugins/builtin', {});
  assert.equal((await app.api('GET', 'library/sections/ai.skills/items')).items.length, 1);
});
