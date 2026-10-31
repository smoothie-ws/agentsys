'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, bundleOf} = require('./harness');
const TextGraph = require('../js/storage/format');
const pkg = (code, metadata = {}, files = {}) => ({
  format: 'agentsys.plugin/2',
  manifest: {id: 'runtime-demo', name: 'Runtime demo', version: '1.0.0', engine: '>=2', main: 'main.js', ...metadata},
  files: {'main.js': code, ...files},
});
const install = (app, package_, extra = {}) => app.api('POST', 'plugins', {package: package_, enable: true, ...extra});
const command = (app, name, args = []) => app.api('POST', 'plugins/runtime-demo/commands/' + name, {args});
const until = async check => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Condition did not become true');
};

test('Scripts can call only exposed plugin endpoints with their required permissions', async t => {
  const {fn} = require('./harness');
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await install(
    app,
    pkg(`exports.activate=({app})=>{
    app.endpoints.register('public',()=>42,{permissions:['library.read']});
    app.endpoints.register('private',()=>42);
  };`)
  );
  const project = await app.api('POST', 'projects', {name: 'Endpoint permissions'});
  const script = await fn(
    app,
    project.id,
    {},
    {
      grants: ['library.read'],
      outputs: ['result'],
      code: `node.output.result=await agentsys('POST','plugins/runtime-demo/call/public',{});`,
    }
  );
  const run = () => app.api('POST', `projects/${project.id}/execution`, {node_ids: [script.id], wait: true});
  assert.equal((await run()).outputs[script.id].result, 42);
  await app.api('PUT', `projects/${project.id}/complex/${script.group}`, {grants: []});
  assert.match(JSON.stringify((await run()).errors), /Permission denied/);
  const hidden = await fn(
    app,
    project.id,
    {},
    {grants: ['library.read'], code: `await agentsys('POST','plugins/runtime-demo/call/private',{});`}
  );
  const denied = await app.api('POST', `projects/${project.id}/execution`, {node_ids: [hidden.id], wait: true});
  assert.match(JSON.stringify(denied.errors), /system.admin/);
});

test('imperative handlers retain closures, use packaged modules and execute navigation effects', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  const record = await install(
    app,
    pkg(
      `
    const step = require('./step'); let count = 0;
    exports.activate = ({app}) => {
      const group = app.library.registerSection({id:'group', title:'Group'});
      const items = app.library.registerCollection({id:'items', parent:group, title:'Items', item:{fields:[]}});
      app.commands.register('increment', () => count += step, {title:'Increment'});
      app.commands.register('open', async () => {await app.navigation.open(items);return count;});
      app.endpoints.register('counter', () => count, {methods:['GET']});
    };
  `,
      {},
      {'step.js': 'module.exports = 2;'}
    )
  );
  assert.equal(record.runtime.status, 'active');
  assert.equal((await command(app, 'increment')).result, 2);
  assert.equal((await command(app, 'increment')).result, 4);
  assert.equal(await app.api('GET', 'plugins/runtime-demo/call/counter'), 4);
  assert.deepEqual((await command(app, 'open')).effects, [{type: 'navigate', path: '/library/runtime-demo.items'}]);
  assert.equal(app.workerStats.started, 1);
});

test('collection credential access is limited to the owning plugin, item and secret field', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await install(
    app,
    pkg(`exports.activate=({app})=>{
    app.library.registerCollection({id:'vault',title:'Vault',item:{fields:[{key:'password',type:'secret'},{key:'title',type:'text'}]}});
    app.commands.register('read',(section,id,key)=>app.library.getSecret(section,id,key));
  };`)
  );
  const item = await app.api('POST', 'library/sections/runtime-demo.vault/items', {
    name: 'Owned',
    values: {password: 'owned-credential'},
  });
  assert.equal((await command(app, 'read', ['vault', item.id, 'password'])).result, 'owned-credential');
  await assert.rejects(command(app, 'read', ['vault', item.id, 'title']), /owned collection/);
  await assert.rejects(command(app, 'read', ['ai.providers', item.id, 'password']), /owned collection/);
  await assert.rejects(command(app, 'read', ['vault', 'missing', 'password']), /not found/);
  assert.ok(
    !JSON.stringify(await app.api('GET', 'library/sections/runtime-demo.vault/items')).includes('owned-credential')
  );
});

test('disable and update call cleanup, stop timers, preserve storage and reactivate a fresh host', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  const code = `let app, ticks=0;
    exports.activate = async context => {
      app=context.app;
      app.timers.setInterval(() => ticks++, 10);
      app.commands.register('ticks', () => ticks);
      app.commands.register('save', () => app.storage.set('saved', 42));
      context.subscriptions.add({dispose: () => app.storage.set('disposed', true)});
      context.subscriptions.add({dispose: () => {throw new Error('cleanup failed');}});
      await new Promise(resolve=>setTimeout(resolve,40));
    };
    exports.deactivate = () => app.storage.set('deactivated', true);`;
  await install(app, pkg(code));
  await command(app, 'save');
  await until(async () => (await command(app, 'ticks')).result > 0);
  await app.api('PUT', 'plugins/runtime-demo', {enabled: false});
  assert.equal((await app.api('GET', 'plugins/runtime-demo/data/deactivated')).value, true);
  assert.equal((await app.api('GET', 'plugins/runtime-demo/data/disposed')).value, true);
  assert.equal(app.workerStats.terminated, 1);
  await assert.rejects(command(app, 'ticks'), /disabled/);
  await install(app, pkg(code, {version: '1.1.0'}), {replace: true});
  assert.equal((await app.api('GET', 'plugins/runtime-demo')).enabled, false);
  await app.api('PUT', 'plugins/runtime-demo', {enabled: true});
  assert.equal((await app.api('GET', 'plugins/runtime-demo/data/saved')).value, 42);
  assert.equal(app.workerStats.started, 2);
});

test('failed activation removes partial registrations and reports the error', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await assert.rejects(
    install(
      app,
      pkg(`exports.activate=({app})=>{
    app.library.registerSection({id:'partial',title:'Partial'}); throw new Error('broken activation');
  };`)
    ),
    /broken activation/
  );
  const record = await app.api('GET', 'plugins/runtime-demo');
  assert.equal(record.runtime.status, 'failed');
  assert.deepEqual(record.contributions.library, []);
  assert.equal(
    (await app.api('GET', 'library/sections')).some(s => s.plugin === 'runtime-demo'),
    false
  );
  assert.equal(app.workerStats.terminated, 1);
});

test('runtime registrations can be disposed dynamically; settings, storage and events use checked host calls', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await install(
    app,
    pkg(`exports.activate=({app})=>{
    app.settings.register([{key:'model',label:'Model',type:'text',default:'small'}, {key:'verbose',type:'boolean'}]);
    const group=app.library.registerSection({id:'temporary',title:'Temporary'});
    app.commands.register('remove',()=>group.dispose());
    app.commands.register('settings',()=>app.settings.get());
    app.events.on('settings.changed',()=>app.storage.set('observed',true));
  };`)
  );
  assert.equal((await command(app, 'settings')).result.model, 'small');
  assert.equal((await command(app, 'settings')).result.verbose, false);
  await app.api('PUT', 'plugins/runtime-demo/settings', {values: {model: 'large'}});
  await until(async () => (await app.api('GET', 'plugins/runtime-demo/data')).some(e => e.key === 'observed'));
  assert.equal((await command(app, 'settings')).result.model, 'large');
  await command(app, 'remove');
  await until(async () => !(await app.api('GET', 'plugins/runtime-demo')).contributions.library.length);
});

test('dependencies validate versions and cycles, activate first and cannot be disabled while needed', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  const code = 'exports.activate=()=>{};';
  await assert.rejects(install(app, pkg(code, {dependencies: {base: '^1.0.0'}})), /dependency/);
  await install(app, pkg(code, {id: 'base', version: '1.2.0'}));
  await assert.rejects(install(app, pkg(code, {dependencies: {base: '~1.1.0'}})), /dependency/);
  await install(
    app,
    pkg(
      `exports.activate=context=>context.app.commands.register('dependency',()=>context.dependencies.base.version);`,
      {dependencies: {base: '^1.0.0'}}
    )
  );
  assert.equal((await command(app, 'dependency')).result, '1.2.0');
  await assert.rejects(app.api('PUT', 'plugins/base', {enabled: false}), /dependent plugins/);
  await assert.rejects(app.api('DELETE', 'plugins/base'), /dependent plugins/);
  await assert.rejects(
    install(app, pkg(code, {id: 'base', version: '1.3.0', dependencies: {'runtime-demo': '*'}}), {replace: true}),
    /cycle/
  );
  await assert.rejects(install(app, pkg(code, {id: 'base', version: '2.0.0'}), {replace: true}), /dependency/);
  await install(app, pkg(code, {id: 'base', version: '1.3.0'}), {replace: true});
  assert.equal((await command(app, 'dependency')).result, '1.3.0');
  await assert.rejects(
    install(app, pkg("exports.activate=()=>{throw new Error('base broke');};", {id: 'base', version: '1.4.0'}), {
      replace: true,
    }),
    /base broke/
  );
  assert.equal((await app.api('GET', 'plugins/runtime-demo')).runtime.status, 'failed');
  assert.deepEqual((await app.api('GET', 'plugins/runtime-demo')).contributions.commands, []);
});

test('worker APIs are isolated and permission revocation applies to existing closures', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await install(
    app,
    pkg(
      `exports.activate=({app})=>{
    app.commands.register('read',()=>app.request('GET','projects'));
    app.commands.register('globals',()=>[typeof process,typeof fetch,typeof Worker,typeof require('node:fs')]);
  };`,
      {permissions: ['graph.read']}
    ),
    {grants: ['graph.read']}
  );
  assert.deepEqual((await command(app, 'read')).result, []);
  await assert.rejects(command(app, 'globals'), /Only packaged relative modules/);
  await app.api('PUT', 'plugins/runtime-demo', {grants: []});
  await assert.rejects(command(app, 'read'), /permission/);
  assert.equal((await app.api('GET', 'plugins/runtime-demo')).runtime.status, 'active');
});

test('a callback that never returns terminates its host and clears registrations', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await app.eval('PLUGIN.endpointMs=150');
  await install(app, pkg(`exports.activate=({app})=>app.commands.register('hang',()=>{while(true){}});`));
  await assert.rejects(command(app, 'hang'), /timed out/);
  await until(async () => (await app.api('GET', 'plugins/runtime-demo')).runtime.status === 'failed');
  assert.equal((await app.api('GET', 'plugins/runtime-demo')).contributions.commands.length, 0);
});

test('imperative node catalogs seed editable data and retain edits and deletions across the lifecycle', async t => {
  const data = new Map();
  const store = {
    get: key => structuredClone(data.get(key)),
    commit: ({set, remove}) => {
      for (const [key, value] of Object.entries(set)) data.set(key, structuredClone(value));
      for (const key of remove) data.delete(key);
    },
  };
  const app = createApp({scripts: 'worker', store});
  t.after(() => app.Backend.shutdownPlugins());
  const code = `exports.activate=({app})=>{app.library.registerNodeCatalog('nodes.json');};`;
  const files = names => ({
    'nodes.json': JSON.stringify(
      TextGraph.encode(
        names.map(name => ({
          name,
          payload: {...bundleOf(name, {Body: {inputs: [], outputs: []}}), grants: ['graph.write']},
        }))
      )
    ),
  });
  await install(app, pkg(code, {}, files(['First', 'Second'])));
  const first = (await app.api('GET', 'resources')).find(r => r.name === 'First');
  await app.api('POST', 'library/node-editor', {resource_id: first.id});
  await app.api('PUT', `resources/${first.id}`, {
    name: 'My first',
    payload: {...first.payload, description: 'Keep me', grants: ['library.read']},
  });
  const saved = await app.api('GET', `resources/${first.id}`);
  await app.api('DELETE', 'resources/plugin.runtime-demo.second');
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Runtime demo', icon: ''});
  await app.api('PUT', 'plugins/runtime-demo', {enabled: false});
  assert.deepEqual(await app.api('GET', 'resources'), [saved]);
  await app.api('PUT', 'plugins/runtime-demo', {enabled: true});
  assert.deepEqual(await app.api('GET', 'resources'), [saved]);
  assert.equal((await app.api('GET', 'settings')).node_folder_icons['Runtime demo'], undefined);
  await install(app, pkg(code, {version: '1.1.0'}, files(['First', 'Second', 'Third'])), {replace: true});
  assert.deepEqual(await app.api('GET', `resources/${first.id}`), saved);
  await assert.rejects(app.api('GET', 'resources/plugin.runtime-demo.second'), /not found/);
  assert.equal((await app.api('GET', 'resources')).length, 2);
  await app.Backend.shutdownPlugins();
  const restarted = createApp({scripts: 'worker', store});
  t.after(() => restarted.Backend.shutdownPlugins());
  await restarted.eval('startEnabledPluginRuntimes()');
  assert.deepEqual(await restarted.api('GET', `resources/${first.id}`), saved);
  await assert.rejects(restarted.api('GET', 'resources/plugin.runtime-demo.second'), /not found/);
  await restarted.api('DELETE', 'plugins/runtime-demo');
  assert.equal((await restarted.api('GET', 'resources')).length, 2);
});
