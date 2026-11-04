'use strict';
// What a controller built from nodes (an LLM agent, for instance) needs of a plugin: Stop reaches its calls, it has settings
// with a masked key, private data, secrets and the means to add Library nodes.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const {withServer, scriptRunner} = require('./plugin-setup');

test('Stop reaches a plugin route: its signal aborts and the caller is identified', async () => {
  const source = `exports.start = api => api.route('POST', 'wait', ({signal, caller}) => new Promise(resolve => {
    globalThis.__caller = caller;
    signal.addEventListener('abort', () => { globalThis.__aborted = true; resolve({aborted: true}); });
    globalThis.__entered = true;
  }));`;
  await withServer({slow: source}, async ({call}) => {
    const s = await scriptRunner(call, "context.state.r = await agentsys('POST', 'plugins/slow/wait', {})", [
      'plugins.call',
    ]);
    await s.start();
    for (let i = 0; i < 200 && !globalThis.__entered; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(globalThis.__entered, 'the route is running');
    assert.deepEqual(globalThis.__caller, {project_id: s.project.id, workflow_id: s.project.id, node_id: s.node.id});
    await s.stop();
    for (let i = 0; i < 200 && !globalThis.__aborted; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(globalThis.__aborted, true, 'Stop aborted the signal');
  });
  delete globalThis.__entered;
  delete globalThis.__aborted;
  delete globalThis.__caller;
});

test('plugin settings: a form schema, saved values, a password that is never sent back', async () => {
  const source = `exports.settings = [
      {key: 'baseURL', label: 'Base URL', type: 'text', default: 'http://localhost:1/v1'},
      {key: 'apiKey', label: 'API key', type: 'password'},
      {key: 'retries', label: 'Retries', type: 'number', default: 2},
      {key: 'stream', label: 'Stream', type: 'boolean', default: false},
      {key: 'model', label: 'Model', type: 'select', options: ['a', 'b'], default: 'a'},
    ];
    exports.start = api => api.route('GET', 'show', () => api.settings.get());`;
  await withServer({cfg: source}, async ({call}) => {
    const detail = (await call('GET', 'plugins/cfg')).body;
    assert.deepEqual(
      detail.settings.map(f => [f.key, f.type, f.value, f.set]),
      [
        ['baseURL', 'text', 'http://localhost:1/v1', undefined],
        ['apiKey', 'password', '', false],
        ['retries', 'number', 2, undefined],
        ['stream', 'boolean', false, undefined],
        ['model', 'select', 'a', undefined],
      ]
    );
    const saved = await call('PUT', 'plugins/cfg/settings', {
      values: {baseURL: 'http://x/v1', apiKey: 'secret-key', retries: 5, stream: true, model: 'b', ignored: 1},
    });
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved.body).includes('secret-key'), 'the password is not sent back');
    assert.equal(saved.body.settings.find(f => f.key === 'apiKey').set, true);
    assert.deepEqual((await call('GET', 'plugins/cfg/show')).body, {
      baseURL: 'http://x/v1',
      apiKey: 'secret-key',
      retries: 5,
      stream: true,
      model: 'b',
    });
    // An empty password keeps the value; null clears it.
    await call('PUT', 'plugins/cfg/settings', {values: {apiKey: '', retries: 6}});
    assert.equal((await call('GET', 'plugins/cfg/show')).body.apiKey, 'secret-key');
    await call('PUT', 'plugins/cfg/settings', {values: {apiKey: null}});
    assert.equal((await call('GET', 'plugins/cfg/show')).body.apiKey, undefined);
    assert.equal((await call('PUT', 'plugins/cfg/settings', {values: {retries: 'many'}})).status, 400);
    assert.equal((await call('PUT', 'plugins/cfg/settings', {values: {model: 'c'}})).status, 400);
    assert.equal((await call('PUT', 'plugins/nothing/settings', {values: {}})).status, 404);
    assert.equal((await call('GET', 'plugins/cfg/show')).body.retries, 6, 'a refused save changed nothing');
  });
});

test('a plugin with a bad settings schema is reported and stays stopped', async () => {
  await withServer({bad: `exports.settings = [{key: 'x y'}]; exports.start = () => {};`}, async ({call}) => {
    const plugin = (await call('GET', 'plugins')).body[0];
    assert.equal(plugin.running, false);
    assert.match(plugin.error, /setting/);
  });
});

test('api.data, api.secret and api.library.add', async () => {
  const source = `exports.start = api => {
    api.route('POST', 'remember', async ({body}) => { await api.data.set({n: body.n}); return api.data.get(); });
    api.route('GET', 'key', async () => ({key: await api.secret('MY_KEY')}));
    api.route('POST', 'clone', async () => {
      const source = (await api.request('GET', 'resources')).find(r => r.name === 'Hello');
      await api.library.add({name: 'Hello copy', payload: source.payload});
      await api.library.add({name: 'Hello copy', payload: source.payload});
      return (await api.request('GET', 'resources')).filter(r => r.name === 'Hello copy').length;
    });
  };`;
  const hello = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'hello', 'main.js'), 'utf8');
  await withServer({tools: source, hello}, async ({call}) => {
    assert.deepEqual((await call('POST', 'plugins/tools/remember', {n: 7})).body, {n: 7});
    assert.deepEqual((await call('POST', 'plugins/tools/remember', {n: 8})).body, {n: 8});
    await call('PUT', 'secrets/MY_KEY', {value: 'abc'});
    assert.deepEqual((await call('GET', 'plugins/tools/key')).body, {key: 'abc'});
    assert.equal((await call('POST', 'plugins/tools/clone')).body, 1, 'a node of that name is added once');
  });
});

test('the plugin skeleton of docs/llm-controller.md works: settings, key header, answer, and Stop aborts the model request', async () => {
  const http = require('node:http');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'llm-controller.md'), 'utf8');
  const skeleton = doc.match(/```js\r?\n([\s\S]*?)```/)[1];
  const seen = {requests: 0, closed: 0, auth: null, body: null};
  const model = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      seen.requests++;
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(data);
      if (seen.body.messages[0].content === 'hang') {
        res.on('close', () => seen.closed++);
        return; // never answers: only an abort ends it
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{message: {content: 'pong: ' + seen.body.messages[0].content}}],
          usage: {total_tokens: 3},
        })
      );
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    await withServer({llm: skeleton}, async ({call}) => {
      const plugin = (await call('GET', 'plugins')).body[0];
      assert.equal(plugin.error, null);
      const url = `http://127.0.0.1:${model.address().port}/v1`;
      assert.equal(
        (await call('PUT', 'plugins/llm/settings', {values: {baseURL: url, apiKey: 'k-123', model: 'm1'}})).status,
        200
      );
      const answer = (await call('POST', 'plugins/llm/chat', {prompt: 'ping'})).body;
      assert.deepEqual(answer, {text: 'pong: ping', usage: {total_tokens: 3}});
      assert.equal(seen.auth, 'Bearer k-123');
      assert.equal(seen.body.model, 'm1');
      // The Ask node the plugin adds is in the Library with the permission it needs.
      const ask = (await call('GET', 'resources')).body.find(r => r.name === 'Ask');
      assert.deepEqual(ask.payload.grants, ['plugins.call']);
      // Stop aborts a request in flight: the model sees the connection close.
      const s = await scriptRunner(
        call,
        "context.state.r = await agentsys('POST', 'plugins/llm/chat', {prompt: 'hang'})",
        ['plugins.call']
      );
      await s.start();
      for (let i = 0; (i < 300 && !seen.body?.messages) || seen.body.messages[0].content !== 'hang'; i++)
        await new Promise(r => setTimeout(r, 10));
      await s.stop();
      for (let i = 0; i < 300 && !seen.closed; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(seen.closed, 1, 'the request to the model was aborted');
    });
  } finally {
    model.closeAllConnections?.();
    await new Promise(resolve => model.close(resolve));
  }
});
