'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const {write, withServer, scriptRunner} = require('./plugin-setup');

test('AI registers Providers only while running and retains provider data across reloads', async () => {
  const ai = fs.readFileSync(path.join(__dirname, '..', 'data', 'plugins', 'ai', 'main.js'), 'utf8');
  await withServer({ai}, async ({call}) => {
    const list = (await call('GET', 'plugins')).body;
    assert.equal(list[0].id, 'ai');
    assert.equal(list[0].running, true);
    assert.equal(
      list.some(p => p.id === 'hello'),
      false
    );
    assert.equal(
      (await call('GET', 'resources')).body.some(r => r.name === 'Hello'),
      false
    );
    const sections = (await call('GET', 'library/sections')).body;
    assert.equal(sections[0].id, 'providers');
    assert.equal(sections[0].title, 'Providers');
    const created = await call('POST', 'plugins/ai/providers', {
      providerId: 'local',
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'private',
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.hasApiKey, true);
    assert.equal('apiKey' in created.body, false);
    const id = created.body.id;
    assert.equal(
      (await call('POST', 'plugins/ai/providers', {providerId: 'local', baseURL: 'https://example.org'})).status,
      400
    );
    assert.equal((await call('POST', 'plugins/ai/providers', {providerId: 'bad', baseURL: 'file:///tmp'})).status, 400);
    await call('PUT', 'plugins/ai/providers', {
      id,
      providerId: 'local',
      baseURL: 'https://example.org/v1',
      model: 'test',
      apiKey: '',
    });
    await call('PUT', 'plugins/ai', {enabled: false});
    assert.deepEqual((await call('GET', 'library/sections')).body, []);
    assert.equal((await call('GET', 'plugins/ai/providers')).status, 404);
    await call('PUT', 'plugins/ai', {enabled: true});
    await call('POST', 'plugins/reload');
    const saved = (await call('GET', 'plugins/ai/providers')).body;
    assert.equal(saved[0].model, 'test');
    assert.equal(saved[0].hasApiKey, true);
    assert.equal((await call('GET', 'library/sections')).body.length, 1);
    assert.equal((await call('DELETE', 'plugins/ai/providers', undefined, {id})).body.deleted, true);
    assert.deepEqual((await call('GET', 'plugins/ai/providers')).body, []);
  });
});

test('a minimal plugin uses the application API directly and keeps metadata while disabled', async () => {
  const source = `exports.title='Simple';exports.icon='sparkles';
    exports.start=async api=>{globalThis.__pluginSignal=api.signal;await api('POST','projects',{name:'Direct API'});};
    exports.stop=()=>{globalThis.__pluginStopped=(globalThis.__pluginStopped??0)+1;};`;
  await withServer({simple: source}, async ({call}) => {
    assert.ok((await call('GET', 'projects')).body.some(p => p.name === 'Direct API'));
    await call('PUT', 'plugins/simple', {enabled: false});
    assert.equal(globalThis.__pluginSignal.aborted, true);
    assert.equal(globalThis.__pluginStopped, 1);
    await call('POST', 'plugins/reload');
    const plugin = (await call('GET', 'plugins/simple')).body;
    assert.equal(plugin.title, 'Simple');
    assert.equal(plugin.icon, 'sparkles');
    assert.equal(plugin.running, false);
    assert.equal(globalThis.__pluginStopped, 1, 'stop is called once for each start');
  });
  delete globalThis.__pluginSignal;
  delete globalThis.__pluginStopped;
});

test('a failed startup stops partial work and removes routes and listeners', async () => {
  const source = `exports.start=api=>{globalThis.__failedSignal=api.signal;
    api.route('GET','partial',()=>true);api.on('change',()=>globalThis.__failedChanges++);throw Error('partial startup');};
    exports.stop=()=>{globalThis.__failedStopped=true;};`;
  globalThis.__failedChanges = 0;
  await withServer({broken: source}, async ({call}) => {
    assert.equal(globalThis.__failedStopped, true);
    assert.equal(globalThis.__failedSignal.aborted, true);
    const changes = globalThis.__failedChanges;
    await call('POST', 'projects', {name: 'After failure'});
    assert.equal(globalThis.__failedChanges, changes);
    assert.equal((await call('GET', 'plugins/broken/partial')).status, 404);
    assert.equal((await call('GET', 'plugins/broken')).body.error, 'partial startup');
  });
  delete globalThis.__failedChanges;
  delete globalThis.__failedSignal;
  delete globalThis.__failedStopped;
});

test('turning a plugin off stops it, removes its routes and stays off after a reload', async () => {
  const source = `exports.start = api => { api.route('GET', 'ping', () => ({ok: true})); };
    exports.stop = () => { globalThis.__stopped = (globalThis.__stopped ?? 0) + 1; };`;
  await withServer({ping: source}, async ({call}) => {
    assert.deepEqual((await call('GET', 'plugins/ping/ping')).body, {ok: true});
    const off = await call('PUT', 'plugins/ping', {enabled: false});
    assert.equal(off.body.running, false);
    assert.equal((await call('GET', 'plugins/ping/ping')).status, 404);
    assert.equal(globalThis.__stopped, 1);
    await call('POST', 'plugins/reload');
    assert.equal((await call('GET', 'plugins')).body[0].running, false, 'a plugin turned off stays off');
    assert.equal((await call('PUT', 'plugins/ping', {enabled: true})).body.running, true);
    assert.deepEqual((await call('GET', 'plugins/ping/ping')).body, {ok: true});
    assert.equal((await call('PUT', 'plugins/nothing', {enabled: true})).status, 404);
    assert.equal((await call('PUT', 'plugins/ping', {enabled: 'yes'})).status, 400);
  });
  delete globalThis.__stopped;
});

test('a plugin carries an optional browser module the API serves to the page', async () => {
  await withServer({ui: `exports.start = () => {};`}, async ({call, pluginsDir}) => {
    assert.equal((await call('GET', 'plugins/ui/client')).status, 404);
    assert.equal((await call('GET', 'plugins')).body[0].client, false);
    fs.writeFileSync(
      path.join(pluginsDir, 'ui', 'client.js'),
      `exports.activate = api => api.commands.register('hi', () => 'hello', {title: 'Hi'});`
    );
    await call('POST', 'plugins/reload');
    const plugin = (await call('GET', 'plugins')).body[0];
    assert.equal(plugin.client, true);
    assert.equal((await call('GET', 'plugins/ui')).body.client, true);
    const source = (await call('GET', 'plugins/ui/client')).body;
    assert.equal(source.path, 'data/plugins/ui/client.js');
    assert.match(source.code, /commands\.register/);
    await call('PUT', 'plugins/ui', {enabled: false});
    assert.equal((await call('GET', 'plugins/ui')).body.client, true, 'metadata is read while disabled');
    assert.equal((await call('GET', 'plugins/ui/client')).status, 200, 'the source stays readable while disabled');
    await call('PUT', 'plugins/ui', {enabled: true});
  });
});

test('a plugin that fails to start shows its error and does not stop the others', async () => {
  await withServer(
    {
      broken: `exports.start = () => { throw new Error('boom'); };`,
      nostart: `exports.title = 'No start';`,
      fine: `exports.start = api => api.route('GET', 'x', () => 1);`,
    },
    async ({call}) => {
      const byId = Object.fromEntries((await call('GET', 'plugins')).body.map(p => [p.id, p]));
      assert.equal(byId.broken.error, 'boom');
      assert.equal(byId.broken.running, false);
      assert.match(byId.nostart.error, /start\(api\)/);
      assert.equal(byId.fine.running, true);
      assert.equal((await call('GET', 'plugins/fine/x')).body, 1);
    }
  );
});

test('the Hello UI example has both halves and a client module that parses', () => {
  const folder = path.join(__dirname, '..', 'data', 'plugins', 'hello-ui');
  for (const name of ['main.js', 'client.js', 'README.md']) assert.ok(fs.existsSync(path.join(folder, name)), name);
  const client = fs.readFileSync(path.join(folder, 'client.js'), 'utf8');
  assert.doesNotThrow(() => new Function('exports', 'module', 'api', client));
  assert.match(client, /api\.ui\.addPage/);
});

test('reload picks up new and edited plugins; api.request and api.on reach the application', async () => {
  const seen = [];
  globalThis.__seen = seen;
  const source = `exports.start = async api => {
    api.on('change', keys => globalThis.__seen.push(...keys));
    api.route('POST', 'make', async ({body}) => (await api.request('POST', 'projects', {name: body.name})).name);
  };`;
  await withServer({}, async ({call, pluginsDir}) => {
    assert.deepEqual((await call('GET', 'plugins')).body, []);
    write(pluginsDir, 'maker', source);
    assert.equal((await call('POST', 'plugins/reload')).body.length, 1);
    assert.equal((await call('POST', 'plugins/maker/make', {name: 'From plugin'})).body, 'From plugin');
    assert.ok((await call('GET', 'projects')).body.some(p => p.name === 'From plugin'));
    assert.ok(seen.includes('projects'));
    write(pluginsDir, 'maker', `exports.start = api => api.route('POST', 'make', () => 'edited');`);
    await call('POST', 'plugins/reload');
    assert.equal((await call('POST', 'plugins/maker/make')).body, 'edited');
  });
  delete globalThis.__seen;
});

test('Scripts need the plugins.call permission to call a plugin route', async () => {
  await withServer({p: `exports.start = api => api.route('GET', 'r', () => ({v: 1}));`}, async ({call}) => {
    await call('PUT', 'settings', {developer_mode: true});
    const project = (await call('POST', 'projects', {name: 'P'})).body;
    const types = [
      {id: 'c0de0c0de0c0de0c0de0c0de0c0de0c0', name: 'code', color: '#8a6fd6', fields: [], control: 'code'},
    ];
    await call('PUT', `projects/${project.id}/types`, {types});
    const code = "try{context.state.v=(await agentsys('GET','plugins/p/r')).v}catch(e){context.state.v=e.code}";
    const run = async (allow, grants) => {
      await call('PUT', `projects/${project.id}/policy`, {allow});
      const node = (
        await call('POST', `projects/${project.id}/typed-nodes`, {
          node_type: 'custom',
          config: {
            title: 'S',
            op: 'script',
            grants,
            inputs: [
              {id: 'in', name: 'in', type: 'signal'},
              {id: 'script', name: 'script', type: 't:' + types[0].id, default: code},
            ],
            outputs: [{id: 'out', name: 'out', type: 'signal'}],
          },
        })
      ).body;
      await call('POST', `projects/${project.id}/execution`, {node_ids: [node.id], wait: true});
      return (await call('GET', `projects/${project.id}/execution`)).body.state.v;
    };
    assert.equal(await run(['graph.read'], ['graph.read']), 'permission_denied');
    assert.equal(await run(['graph.read', 'plugins.call'], ['plugins.call']), 1);
  });
});
