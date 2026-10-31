'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, flow} = require('./harness');
async function setup(t, fetcher) {
  const app = createApp({scripts: 'worker'}),
    requests = [];
  t.after(async () => {
    await app.Backend.shutdownExecutions();
    await app.Backend.shutdownPlugins();
  });
  app.context.fetch = async (url, options) => {
    requests.push({url: String(url), ...options});
    const body = fetcher
      ? await fetcher(String(url), options)
      : String(url).includes('/models')
        ? {data: [{id: 'model-a'}, {id: 'model-b'}]}
        : {choices: [{message: {content: 'Hello from the model'}}]};
    return body && typeof body.text === 'function' ? body : {status: 200, text: async () => JSON.stringify(body)};
  };
  await app.api('POST', 'plugins/builtin', {});
  const plugin = await app.api('GET', 'plugins/ai');
  await app.api('PUT', 'plugins/ai', {grants: plugin.manifest.permissions});
  const provider = await app.api('POST', 'library/sections/ai.providers/items', {
    name: 'Local',
    values: {providerId: 'local', baseURL: 'http://model.test/v1', apiKey: 'private-model-key'},
  });
  const project = await app.api('POST', 'projects', {name: 'AI nodes'}),
    prefix = `projects/${project.id}`;
  const put = async name => {
    const resource = (await app.api('GET', 'resources')).find(r => r.name === name && r.id.startsWith('plugin.ai.'));
    const placed = await app.api('POST', prefix + '/custom-nodes/' + resource.id, {point: {x: 0, y: 0}});
    await app.Backend.hooksIdle();
    return 'complex:' + placed.roots[0];
  };
  const wire = (source, source_port, target, target_port) =>
    app.api('POST', prefix + '/port-connections', {add: [{source, source_port, target, target_port}]});
  const snapshot = () => app.api('GET', prefix + '/workflow');
  const widget = async (id, key) => {
    const graph = await snapshot(),
      group = graph.complex.find(c => 'complex:' + c.id === id);
    for (const owner of group.widget_nodes) {
      const item = graph.widgets[owner]?.find(w => w.id === key);
      if (item) return {owner, ...item};
    }
    assert.fail('Missing ' + key + ' widget');
  };
  return {app, project, provider, prefix, put, wire, snapshot, widget, requests};
}
test('AI plugin supplies exactly Provider, Model and Ask in the AI node group', async t => {
  const {app} = await setup(t);
  const resources = (await app.api('GET', 'resources')).filter(r => r.id.startsWith('plugin.ai.'));
  assert.deepEqual(resources.map(r => r.name).sort(), ['Ask', 'Model', 'Provider']);
  assert.ok(resources.every(r => r.payload.folder === 'AI'));
});
test('all AI node definitions open in the ordinary Library graph editor and save changes', async t => {
  const {app} = await setup(t);
  for (const name of ['Provider', 'Model', 'Ask']) {
    const id = 'plugin.ai.' + name.toLowerCase();
    const opened = await app.api('POST', 'library/node-editor', {resource_id: id});
    const prefix = `projects/${opened.project_id}`;
    const graph = await app.api('GET', prefix + '/workflow');
    const script = graph.nodes.find(n => n.kind === 'function' && n.config.op === 'script');
    assert.match(script.id, /^record:[a-f0-9]{32}$/);
    await app.api('PUT', prefix + '/node-title', {node_id: script.id, title: 'My ' + name + ' script'});
    const saved = await app.api('GET', 'resources/' + id);
    assert.ok(saved.payload.bundle.records.some(r => r.payload.config.title === 'My ' + name + ' script'));
    await app.api('POST', 'library/node-editor', {resource_id: id});
    assert.ok(
      (await app.api('GET', prefix + '/workflow')).nodes.some(n => n.config.title === 'My ' + name + ' script')
    );
  }
});

test('Provider on_placed builds its combobox; Model on_input_connected follows selection and rewiring', async t => {
  const f = await setup(t, url => ({data: [{id: url.includes('other.test') ? 'other-model' : 'local-model'}]}));
  const providerNode = await f.put('Provider'),
    model = await f.put('Model');
  assert.equal((await f.widget(providerNode, 'provider')).value, f.provider.id);
  await f.wire(providerNode, 'id', model, 'provider');
  await f.app.Backend.hooksIdle();
  assert.equal((await f.widget(model, 'model')).value, 'local-model');
  const other = await f.app.api('POST', 'library/sections/ai.providers/items', {
    name: 'Other',
    values: {providerId: 'other', baseURL: 'http://other.test/v1'},
  });
  const selected = await f.widget(providerNode, 'provider');
  await f.app.api('PUT', f.prefix + '/widget-values', {node_id: selected.owner, values: {provider: other.id}});
  await f.app.Backend.hooksIdle();
  assert.equal((await f.widget(model, 'model')).value, 'other-model');
  const second = await f.put('Provider');
  const graph = await f.snapshot(),
    edge = graph.edges.find(e => e.target === model && e.target_port === 'provider');
  await f.app.api('POST', f.prefix + '/port-connections', {
    remove: [{source: edge.source, source_port: edge.source_port, target: edge.target, target_port: edge.target_port}],
    add: [{source: second, source_port: 'id', target: model, target_port: 'provider'}],
  });
  await f.app.Backend.hooksIdle();
  assert.equal((await f.widget(model, 'model')).value, 'local-model');
  const hooks = await f.app.api('GET', 'node-hooks');
  assert.ok(
    hooks.every(h => h.ok),
    JSON.stringify(hooks.filter(h => !h.ok))
  );
});
test('Provider → Model → Ask uses nested Request, authenticates privately and emits text', async t => {
  const f = await setup(t),
    provider = await f.put('Provider'),
    model = await f.put('Model'),
    ask = await f.put('Ask');
  await f.wire(provider, 'id', model, 'provider');
  await f.app.Backend.hooksIdle();
  await f.wire(provider, 'id', ask, 'provider');
  await f.wire(provider, 'url', ask, 'url');
  await f.wire(model, 'model', ask, 'model');
  await f.app.api('PUT', f.prefix + '/input-values', {node_id: ask, values: {prompt: 'Say hello'}});
  const preview = await fn(f.app, f.project.id, {}, {inputs: ['value'], code: 'node.display(value);'});
  await f.wire(ask, 'out', preview.wrapper, 'in');
  await f.wire(ask, 'response', preview.wrapper, 'value');
  await flow(f.app, f.project.id, {}, [[ask, 'in']]);
  const result = await f.app.api('POST', f.prefix + '/execution', {wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.equal(result.displays[preview.id], 'Hello from the model');
  const request = f.requests.find(r => r.method === 'POST');
  assert.ok(request);
  assert.equal(request.url, 'http://model.test/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer private-model-key');
  assert.deepEqual(JSON.parse(request.body), {
    model: 'model-a',
    messages: [{role: 'user', content: 'Say hello'}],
    stream: false,
  });
  assert.ok(!JSON.stringify(result).includes('private-model-key'));
});

test('rapid placement and wiring initialize Model from the current Provider selection', async t => {
  const f = await setup(t);
  const put = async name =>
    'complex:' +
    (await f.app.api('POST', f.prefix + '/custom-nodes/plugin.ai.' + name.toLowerCase(), {point: {x: 0, y: 0}}))
      .roots[0];
  const provider = await put('Provider'),
    model = await put('Model');
  await f.wire(provider, 'id', model, 'provider');
  await f.app.Backend.hooksIdle();
  assert.equal((await f.widget(model, 'model')).value, 'model-a');
  assert.ok((await f.app.api('GET', 'node-hooks')).every(event => event.ok));
});

test('a failed model refresh clears the previous Provider model selection', async t => {
  const f = await setup(t, url =>
    url.includes('other.test')
      ? {status: 401, text: async () => '{"error":"Unauthorized"}'}
      : {data: [{id: 'old-model'}]}
  );
  const provider = await f.put('Provider'),
    model = await f.put('Model');
  await f.wire(provider, 'id', model, 'provider');
  await f.app.Backend.hooksIdle();
  assert.equal((await f.widget(model, 'model')).value, 'old-model');
  const other = await f.app.api('POST', 'library/sections/ai.providers/items', {
    name: 'Unavailable',
    values: {providerId: 'other', baseURL: 'http://other.test/v1'},
  });
  const owner = await f.widget(provider, 'provider');
  await f.app.api('PUT', f.prefix + '/widget-values', {node_id: owner.owner, values: {provider: other.id}});
  await f.app.Backend.hooksIdle();
  const widget = await f.widget(model, 'model');
  assert.equal(widget.value, '');
  assert.equal(widget.options[0].label, 'Models unavailable');
});

async function askFlow(f, values = {}) {
  const ask = await f.put('Ask');
  await f.app.api('PUT', f.prefix + '/input-values', {
    node_id: ask,
    values: {provider: 'local', url: 'http://model.test/v1', model: 'model-a', prompt: 'Hello', ...values},
  });
  const preview = await fn(f.app, f.project.id, {}, {inputs: ['value'], code: 'node.display(value);'});
  await f.wire(ask, 'out', preview.wrapper, 'in');
  await f.wire(ask, 'response', preview.wrapper, 'value');
  await flow(f.app, f.project.id, {}, [[ask, 'in']]);
  return {ask, preview};
}
test('Ask handles Anthropic text content and keeps authentication outside the graph', async t => {
  const f = await setup(t, () => ({
    content: [
      {type: 'text', text: 'Hello '},
      {type: 'text', text: 'Claude'},
    ],
  }));
  await f.app.api('PUT', 'library/sections/ai.providers/items/' + f.provider.id, {values: {npm: '@ai-sdk/anthropic'}});
  const {preview} = await askFlow(f);
  const result = await f.app.api('POST', f.prefix + '/execution', {wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.equal(result.displays[preview.id], 'Hello Claude');
  const sent = f.requests.find(r => r.method === 'POST');
  assert.equal(sent.url, 'http://model.test/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'private-model-key');
  assert.equal(JSON.parse(sent.body).max_tokens, 1024);
});
test('Ask reports HTTP and missing-model errors instead of emitting a successful response', async t => {
  const f = await setup(t, () => ({status: 503, text: async () => JSON.stringify({error: 'Unavailable'})}));
  const {ask} = await askFlow(f);
  const failed = await f.app.api('POST', f.prefix + '/execution', {wait: true});
  assert.ok(Object.keys(failed.errors).length > 0);
  assert.match(JSON.stringify(failed.errors), /HTTP 503/);
  await f.app.api('PUT', f.prefix + '/input-values', {node_id: ask, values: {model: ''}});
  const missing = await f.app.api('POST', f.prefix + '/execution', {wait: true});
  assert.ok(Object.keys(missing.errors).length > 0);
  assert.match(JSON.stringify(missing.errors), /Choose a model/);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});
test('Stop aborts an inference HTTP request without disabling the AI plugin', async t => {
  let began,
    aborted = false;
  const started = new Promise(resolve => (began = resolve));
  const f = await setup(t, (url, options) =>
    options.method !== 'POST'
      ? {data: [{id: 'still-active'}]}
      : new Promise((resolve, reject) => {
          began();
          options.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('Request aborted'));
            },
            {once: true}
          );
        })
  );
  await askFlow(f);
  await f.app.api('POST', f.prefix + '/execution', {});
  await started;
  const stopped = await f.app.api('DELETE', f.prefix + '/execution');
  assert.equal(stopped.status, 'idle');
  assert.equal(aborted, true);
  assert.equal((await f.app.api('GET', 'plugins/ai')).runtime.status, 'active');
  assert.equal((await f.app.api('POST', 'plugins/ai/call/models', {provider: 'local'})).items[0].id, 'still-active');
});

test('the extended Request keeps ordinary GET behavior when optional inputs are unused', async t => {
  const f = await setup(t, () => ({status: 200, text: async () => 'GET still works'}));
  const asset = require('../plugins/ai/nodes/request.json');
  const resource = await f.app.api('POST', 'resources', {name: 'Request', payload: asset.payload});
  const placed = await f.app.api('POST', f.prefix + '/custom-nodes/' + resource.id, {point: {x: 0, y: 0}});
  const graph = await f.snapshot(),
    group = graph.complex.find(c => c.id === placed.roots[0]);
  const urlPort = group.interface.inputs.find(p => p.name === 'url');
  await f.app.api('PUT', f.prefix + '/input-values', {
    node_id: 'complex:' + group.id,
    values: {[urlPort.id]: 'http://model.test/plain'},
  });
  const script = graph.nodes.find(n => group.members.includes(n.id) && n.config?.op === 'script');
  const result = await f.app.api('POST', f.prefix + '/execution', {node_ids: [script.id], wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.equal(
    result.outputs[script.id][group.interface.outputs.find(p => p.name === 'response').id],
    'GET still works'
  );
  assert.equal(f.requests[0].url, 'http://model.test/plain');
  assert.equal(f.requests[0].method, 'GET');
});
test('Ask refuses ambiguous Providers and cannot send a saved key to another URL', async t => {
  const f = await setup(t);
  await f.app.api('POST', 'library/sections/ai.providers/items', {
    name: 'Another account',
    values: {providerId: 'second', baseURL: 'http://model.test/v1'},
  });
  await assert.rejects(
    f.app.api('POST', 'plugins/ai/call/prepare-request', {url: 'http://model.test/v1', model: 'model-a', prompt: 'Hi'}),
    /Several Providers/
  );
  const request = await f.app.api('POST', 'plugins/ai/call/prepare-request', {
    provider: 'local',
    url: 'http://model.test/v1',
    model: 'model-a',
    prompt: 'Hi',
  });
  assert.ok(!JSON.stringify(request).includes('private-model-key'));
  await assert.rejects(
    f.app.api('POST', 'plugins/ai/call/request', {...request, url: 'http://evil.test/steal'}),
    /does not match/
  );
  assert.equal(f.requests.length, 0);
});
