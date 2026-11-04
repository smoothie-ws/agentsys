'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const {write, withServer, scriptRunner} = require('./plugin-setup');

test('the bundled plugin starts: it adds a Library node and answers its route', async () => {
  const hello = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'hello', 'main.js'), 'utf8');
  await withServer({hello}, async ({call, pluginsDir}) => {
    fs.writeFileSync(path.join(pluginsDir, 'hello', 'README.md'), '# Hello\nA readme.');
    const list = (await call('GET', 'plugins')).body;
    assert.deepEqual(list, [
      {id: 'hello', title: 'AI', description: list[0].description, icon: 'sparkles', enabled: true, running: true, error: null},
    ]);
    assert.ok((await call('GET', 'resources')).body.some(r => r.name === 'Hello'));
    assert.deepEqual((await call('GET', 'plugins/hello/greet', undefined, {name: 'Ann'})).body, {text: 'Hello, Ann!'});
    assert.equal((await call('GET', 'plugins/hello/missing')).status, 404);
    const detail = (await call('GET', 'plugins/hello')).body;
    assert.deepEqual(detail.routes, ['GET greet']);
    assert.match(detail.readme, /Hello/);
    assert.equal((await call('GET', 'plugins/nothing')).status, 404);
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
