'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp} = require('./harness');
function packageOf(code, manifest = {}, files = {}) {
  return {
    format: 'agentsys.plugin/2',
    manifest: {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      engine: '>=2',
      main: 'main.js',
      permissions: [],
      ...manifest,
    },
    files: {'main.js': code, ...files},
  };
}
const install = (app, pkg, extra = {}) => app.api('POST', 'plugins', {package: pkg, ...extra});
test('package validation checks metadata, files, permissions and engine requirements', async () => {
  const app = createApp();
  for (const [pkg, message] of [
    [{}, /package/],
    [packageOf('', {id: 'Bad ID'}), /id/],
    [packageOf('', {version: 'one'}), /version/],
    [packageOf('', {permissions: ['everything']}), /grants/],
    [packageOf('', {engine: '>=3'}), /needs plugin API/],
    [packageOf('', {main: 'missing.js'}), /not a file/],
  ])
    await assert.rejects(install(app, pkg), message);
});
test('registered settings validate changes and preserve defaults', async () => {
  const app = createApp();
  await install(
    app,
    packageOf(
      `exports.activate=({app})=>app.settings.register([{key:'model',type:'select',options:['small','large'],default:'small'},{key:'count',type:'number',min:0,max:5,default:2}]);`
    ),
    {enable: true}
  );
  assert.deepEqual((await app.api('GET', 'plugins/demo/settings')).values, {model: 'small', count: 2});
  await app.api('PUT', 'plugins/demo/settings', {values: {model: 'large'}});
  assert.equal((await app.api('GET', 'plugins/demo/settings')).values.count, 2);
  await assert.rejects(app.api('PUT', 'plugins/demo/settings', {values: {count: 8}}), /from 0 to 5/);
});
test('private plugin data supports compare-and-set and is isolated by plugin', async () => {
  const app = createApp();
  await install(app, packageOf('exports.activate=()=>{};'));
  assert.equal((await app.api('PUT', 'plugins/demo/data/key', {value: {a: 1}, version: 0})).version, 1);
  await assert.rejects(app.api('PUT', 'plugins/demo/data/key', {value: 2, version: 0}), error => error.status === 409);
  assert.equal((await app.api('PUT', 'plugins/demo/data/key', {value: 2, version: 1})).version, 2);
  await install(app, packageOf('exports.activate=()=>{};', {id: 'second'}));
  await assert.rejects(app.api('GET', 'plugins/second/data/key'), /No such key/);
});
test('the bridge requires both manifest permissions and installation grants', async () => {
  const app = createApp();
  await app.api('POST', 'projects', {name: 'Visible'});
  await install(app, packageOf('exports.activate=()=>{};', {permissions: ['graph.read']}), {enable: true});
  const bridge = (method, path, body = {}) => app.api('POST', 'plugins/demo/bridge', {method, path, body});
  await assert.rejects(bridge('GET', 'projects'), /graph.read/);
  await app.api('PUT', 'plugins/demo', {grants: ['graph.read']});
  assert.equal((await bridge('GET', 'projects')).length, 1);
  await assert.rejects(bridge('POST', 'projects', {name: 'Denied'}), /graph.write/);
  await assert.rejects(bridge('GET', 'plugins'), /system.admin/);
  await app.api('PUT', 'plugins/demo', {enabled: false});
  await assert.rejects(bridge('GET', 'projects'), /not enabled/);
});
test('owned endpoints receive requests and settings through the isolated host', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownPlugins());
  await install(
    app,
    packageOf(
      `exports.activate=({app})=>{app.settings.register([{key:'name',type:'text',default:'sample'}]);app.endpoints.register('echo',async request=>({body:request.body,query:request.query,settings:await app.settings.get(),network:typeof fetch}),{methods:['GET','POST']});};`
    ),
    {enable: true}
  );
  const result = await app.api('POST', 'plugins/demo/call/echo', {value: 42}, {filter: 'a'});
  assert.deepEqual(result, {body: {value: 42}, query: {filter: 'a'}, settings: {name: 'sample'}, network: 'undefined'});
  await assert.rejects(app.api('PUT', 'plugins/demo/call/echo'), error => error.status === 405);
});
test('updating narrows grants and removal deletes private data', async () => {
  const app = createApp(),
    code = 'exports.activate=()=>{};';
  await install(app, packageOf(code, {permissions: ['graph.read', 'library.read']}), {
    enable: true,
    grants: ['graph.read', 'library.read'],
  });
  await app.api('PUT', 'plugins/demo/data/key', {value: 42});
  const updated = await install(app, packageOf(code, {version: '1.1.0', permissions: ['graph.read']}), {replace: true});
  assert.deepEqual(updated.grants, ['graph.read']);
  await app.api('DELETE', 'plugins/demo');
  await install(app, packageOf(code));
  await assert.rejects(app.api('GET', 'plugins/demo/data/key'), /No such key/);
});
