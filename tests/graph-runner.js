'use strict';
const assert = require('node:assert/strict');
const {createApp} = require('./harness');
const TextGraph = require('../js/storage/format');
async function runGraphFixture(fixture, {verify = true} = {}) {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Fixture'});
  const wf = await app.api('POST', `projects/${p.id}/workflows/import`, fixture.graph);
  const run = await app.api('POST', `projects/${p.id}/execution`, {
    workflow_id: wf.id,
    payload: fixture.inputs ?? {},
    wait: true,
  });
  if (verify) assert.equal(run.status, fixture.expected.status ?? 'completed', JSON.stringify(run.errors));
  if (verify && fixture.expected.displays)
    assert.deepEqual(Object.values(run.displays).sort(), fixture.expected.displays.slice().sort());
  if (verify && fixture.expected.outputs) assert.deepEqual(run.outputs, fixture.expected.outputs);
  assert.equal(TextGraph.canonical(TextGraph.decode(fixture.graph)), JSON.stringify(fixture.graph));
  return run;
}
module.exports = {runGraphFixture};
