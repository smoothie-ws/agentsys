'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, ref, TYPES} = require('./harness');
// A program fixture for the checked Script HTTP API; no dependency on a retired data-conversion tool.
const HTTP_CODE = `const options = node.input.request ?? {
  url: node.input.url,
  method: node.input.method || 'GET',
  headers: node.input.headers,
  body: node.input.body || undefined,
  timeout: node.input.timeout ?? 10000
};
const response = await agentsys('POST', 'net', options);
node.output.status = response.status;
node.output.response = response.text;`;

test('generic Request executes through net with HTTP fields and needs no plugin permission', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'HTTP Request'});
  const {types} = await app.api('GET', `projects/${project.id}/types`);
  await app.api('PUT', `projects/${project.id}/types`, {types: [...types, TYPES.text]});
  await app.api('PUT', `projects/${project.id}/policy`, {allow: ['net.fetch:request.test']});
  let called = false;
  app.context.fetch = async (url, options) => {
    called = true;
    assert.equal(url.href, 'https://request.test/echo');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, 'payload');
    return {status: 201, text: async () => 'HTTP answer'};
  };
  const request = await fn(app, project.id, {}, {
    code: HTTP_CODE,
    inputs: [
      {name: 'url', type: ref('text'), default: 'https://request.test/echo'},
      {name: 'method', type: ref('text'), default: 'POST'},
      {name: 'body', type: ref('text'), default: 'payload'},
    ],
    outputs: ['status', 'response'],
    grants: ['net.fetch:request.test'],
  });
  const result = await app.api('POST', `projects/${project.id}/execution`, {node_ids: [request.id], wait: true});
  assert.deepEqual(result.errors, {});
  assert.equal(called, true);
  assert.deepEqual(result.outputs[request.wrapper], {status: 201, response: 'HTTP answer'});
});

test('HTTP headers and legacy options stay HTTP options and cannot select an application route', async () => {
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('node', 'agentsys', HTTP_CODE);
  for (const input of [
    {url: 'https://request.test/', method: 'PATCH', headers: {'X-Test': 'yes'}, body: 'body', timeout: 1234},
    {request: {url: 'https://request.test/legacy', method: 'DELETE'}, endpoint: 'plugins/other/call'},
  ]) {
    const node = {input, output: {}};
    await run(node, async (method, route, options) => {
      assert.equal(method, 'POST');
      assert.equal(route, 'net');
      if (input.request) assert.deepEqual(options, input.request);
      else assert.deepEqual(options, input);
      return {status: 204, text: ''};
    });
    assert.deepEqual(node.output, {status: 204, response: ''});
  }
});
