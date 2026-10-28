'use strict';
const assert = require('node:assert/strict');
const {createApp} = require('./harness');
const TextGraph = require('../js/storage/format');
async function runGraphFixture(fixture, {verify = true} = {}) {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Fixture'});
  if (fixture.mocks?.length) {
    await app.api('POST', 'resources', {
      kind: 'provider',
      name: 'Fixture',
      payload: {endpoint: 'http://fixture.test/v1', default_model: 'fixture'},
    });
    let index = 0;
    app.context.fetch = async () => {
      const mock = fixture.mocks[index++];
      if (!mock) throw Error('Unexpected model request');
      return {ok: true, json: async () => mock};
    };
  }
  const wf = await app.api('POST', `projects/${p.id}/workflows/import`, fixture.graph);
  const run = await app.api('POST', `projects/${p.id}/runs`, {
    workflow_id: wf.id,
    payload: fixture.inputs ?? {},
    wait: 2,
    budget: fixture.budget,
  });
  if (verify) assert.equal(run.status, fixture.expected.status ?? 'completed', JSON.stringify(run.errors));
  if (verify && fixture.expected.displays)
    assert.deepEqual(Object.values(run.displays).sort(), fixture.expected.displays.slice().sort());
  if (verify && fixture.expected.outputs) assert.deepEqual(run.outputs, fixture.expected.outputs);
  assert.equal(TextGraph.canonical(TextGraph.decode(fixture.graph)), JSON.stringify(fixture.graph));
  return run;
}
module.exports = {runGraphFixture};
