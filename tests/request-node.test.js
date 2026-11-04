'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, ref, TYPES} = require('./harness');
const {HTTP_CODE, PROVIDER_CODE, simplifyGraph} = require('../tools/simplify-request');

function legacyGraph(endpoint = 'net') {
  return {
    groups: [{id: 'request', name: 'Request', parent: null, members: ['script']}],
    complex: [{id: 'request', source: {resource_id: 'http-resource', stamp: 1}, interface: {
      inputs: [
        {id: 'signal-in', name: 'in', type: 'signal', bound: [{node_id: 'script', port_id: 'in'}]},
        {id: 'url-input', name: 'url'}, {id: 'method-input', name: 'method'},
        {id: 'timeout-input', name: 'timeout'}, {id: 'options-input', name: 'request'},
        {id: 'endpoint-input', name: 'endpoint', default: endpoint},
      ],
      outputs: [{id: 'status-output', name: 'status'}, {id: 'response-output', name: 'response'}],
    }}],
    records: [{id: 'script', payload: {config: {title: 'Script', inputs: [
      {id: 'script', default: "await agentsys('POST', node.input.endpoint || 'net', node.input.request);"},
    ]}}}],
    port_edges: [{id: 'keep', source: 'complex:request', source_port: 'response-output', target: 'other', target_port: 'in'}],
  };
}

test('HTTP Request drops internal routing and preserves existing ports, links and complete-options support', () => {
  const graph = legacyGraph();
  assert.equal(simplifyGraph(graph), true);
  assert.deepEqual(graph.complex[0].interface.inputs.map(port => port.name), ['in', 'url', 'method', 'timeout', 'request', 'headers', 'body']);
  assert.equal(graph.complex[0].interface.inputs.find(port => port.name === 'url').id, 'url-input');
  assert.equal(graph.complex[0].source.resource_id, 'http-resource');
  assert.equal(graph.port_edges[0].source_port, 'response-output');
  assert.equal(graph.records[0].payload.config.inputs[0].default, HTTP_CODE);
  assert.equal(simplifyGraph(graph), false, 'reapplying does not modify a migrated graph');
});

test('AI transport becomes a private Provider request and no longer follows the HTTP Library definition', async () => {
  const graph = legacyGraph('plugins/ai/call/request');
  simplifyGraph(graph);
  assert.equal(graph.groups[0].name, 'Provider request');
  assert.equal(graph.complex[0].source, undefined);
  assert.deepEqual(graph.complex[0].interface.inputs.map(port => port.name), ['in', 'request']);
  assert.equal(graph.port_edges[0].id, 'keep');
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('node', 'agentsys', PROVIDER_CODE);
  const input = {request: {provider: 'local', url: 'https://model.test/chat', body: '{}'}};
  const node = {input, output: {}};
  await run(node, async (method, route, body) => {
    assert.deepEqual([method, route, body], ['POST', 'plugins/ai/call/request', input.request]);
    return {status: 200, text: 'model answer'};
  });
  assert.deepEqual(node.output, {status: 200, response: 'model answer'});
});

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
