'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');
test('Initiative journal, dependency validation, immutable decisions and optimistic writes', async () => {
  const app = createApp(),
    {api} = app;
  const i = await api('POST', 'initiatives', {title: 'Ship', goal: 'Finish'}),
    base = `initiatives/${i.id}`;
  const a = await api('POST', base + '/tasks', {title: 'Plan'});
  const b = await api('POST', base + '/tasks', {title: 'Build', depends_on: [a.id]});
  await assert.rejects(api('PUT', base + '/tasks/' + b.id, {version: 1, status: 'doing'}), /dependencies/);
  await api('PUT', base + '/tasks/' + a.id, {version: 1, status: 'doing'});
  const outcomes = await Promise.allSettled([
    api('PUT', base + '/tasks/' + a.id, {version: 2, status: 'done'}),
    api('PUT', base + '/tasks/' + a.id, {version: 2, status: 'blocked'}),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await api('GET', base + '/tasks', {}, {ready: 'true'}))[0].id, b.id);
  await api('PUT', base + '/tasks/' + b.id, {version: 1, status: 'doing'});
  const d = await api('POST', base + '/decisions', {summary: 'Use JS', rationale: 'Fits', made_by: 'human'});
  await assert.rejects(api('PUT', base + '/decisions/' + d.id, {summary: 'change'}), /not found/);
  const projected = await app.eval(`initiativeState(${JSON.stringify(await api('GET', base + '/log'))})`);
  assert.equal(projected.tasks[b.id].status, 'doing');
  await assert.rejects(api('PUT', base + '/tasks/' + b.id, {version: 2, parent_id: b.id}), /cycle/);
});

test('Initiative tasks, artifacts and facts survive a fresh backend on the same store', async () => {
  const data = new Map(),
    store = {
      get: k => structuredClone(data.get(k)),
      commit: ({set, remove}) => {
        for (const [k, v] of Object.entries(set)) data.set(k, structuredClone(v));
        for (const k of remove) data.delete(k);
      },
    };
  const a = createApp({store}),
    i = await a.api('POST', 'initiatives', {title: 'Persistent', goal: 'Remember work'}),
    base = 'initiatives/' + i.id;
  const task = await a.api('POST', base + '/tasks', {title: 'Keep task'});
  await a.api('POST', base + '/artifacts', {kind: 'report', title: 'Report', uri: 'https://example.test/report'});
  await a.api('POST', base + '/facts', {text: 'A sourced observation', source: 'test', confidence: 0.9});
  const b = createApp({store}),
    read = await b.api('GET', base);
  assert.equal(read.tasks[0].id, task.id);
  assert.equal(read.artifacts.length, 1);
  assert.equal(read.facts[0].confidence, 0.9);
});
