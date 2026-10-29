'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

test('run overview counts beyond a page, filters before pagination and uses stable cursors', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Overview'});
  const now = Math.floor(Date.now() / 1000);
  const rows = Array.from({length: 260}, (_, i) => ({id: String(i).padStart(4, '0'),
    project_id: project.id, workflow_id: project.id, started: now - Math.floor(i / 2),
    status: i === 259 ? 'waiting' : i === 258 ? 'failed' : 'completed', finished: now}));
  await app.eval(`DB.commit({run_summaries: ${JSON.stringify(rows)}})`);
  const first = await app.api('GET', 'runs/overview', {}, {limit: 50, controls: '1'});
  assert.equal(first.total, 260);
  assert.equal(first.metrics.active, 1);
  assert.equal(first.metrics.failed_24h, 1);
  assert.equal(first.workflows[0].control.status, 'enabled');
  const found = [];
  let result = first;
  do {
    found.push(...result.items.map(r => r.id));
    if (!result.next_cursor) break;
    result = await app.api('GET', 'runs/overview', {}, {limit: 50, cursor: result.next_cursor});
  } while (true);
  assert.equal(found.length, 260);
  assert.equal(new Set(found).size, 260);
  const failed = await app.api('GET', 'runs/overview', {}, {status: 'attention', workflow_id: project.id});
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].id, '0258');
  assert.equal((await app.api('GET', 'runs/overview', {}, {since: now + 1})).total, 0);
  for (const query of [{limit: 1.5}, {cursor: 'broken'}, {cursor: '[null, "x"]'}, {since: 'NaN'}, {status: 'bad'}])
    await assert.rejects(app.api('GET', 'runs/overview', {}, query));
});
