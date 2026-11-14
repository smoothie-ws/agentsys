'use strict';
// Client plugin packages are validated and kept in this browser. The server has no plugin endpoint and no
// server-side plugin code.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

function pluginStore() {
  const data = new Map();
  const localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(String(key), String(value)),
    removeItem: key => data.delete(key),
    get length() {
      return data.size;
    },
    key: index => [...data.keys()][index] ?? null,
  };
  const context = vm.createContext({
    console,
    localStorage,
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    crypto: globalThis.crypto,
    fetch: async () => ({ok: false, status: 404}),
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  });
  context.self = context;
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'core.js'), 'utf8'), context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'plugin-manifest.js'), 'utf8'),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'plugin-capabilities.js'), 'utf8'),
    context
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'plugin-store.js'), 'utf8'), context);
  return vm.runInContext('PluginStore', context);
}

test('client plugin packages are validated: id, API version, source and size limits', async () => {
  const store = pluginStore();
  await store.load();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(store.list()), []);
  assert.throws(
    () => store.install({id: '../evil', title: 'X', source: 'exports.activate = () => {};'}),
    error => error.code === 'invalid_request'
  );
  assert.throws(
    () => store.install({id: 'x', title: 'X', api: 99, source: 'exports.activate = () => {};'}),
    error => error.code === 'incompatible_protocol'
  );
  assert.throws(
    () => store.install({id: 'x', title: 'X', source: 'console.log(1)'}),
    error => error.code === 'invalid_request'
  );
  const plugin = store.install({
    id: 'hello',
    title: 'Hello',
    version: '1.2.3',
    description: 'demo',
    source: 'exports.activate = api => { api.ui.addPage({id: "p", render: () => "hi"}); };',
  });
  assert.equal(plugin.id, 'hello');
  assert.equal(store.list().length, 1);
  // A package that declares no capabilities is read-only; writes must be named.
  assert.deepEqual([...plugin.capabilities].sort(), ['collections.read', 'graph.read', 'library.read', 'notifications.read', 'run.read', 'settings.read']);
  assert.deepEqual(
    [...store.install({id: 'writer', title: 'Writer', capabilities: ['library.read', 'library.write'], source: 'exports.activate = () => {};'}).capabilities],
    ['library.read', 'library.write']
  );
  assert.throws(
    () => store.install({id: 'writer2', title: 'Writer', capabilities: ['root'], source: 'exports.activate = () => {};'}),
    error => error.code === 'invalid_request' && /Unknown plugin capability/.test(error.message)
  );
  store.remove('writer');
  assert.equal(store.setEnabled('hello', false).enabled, false);
  assert.equal(store.get('hello').enabled, false);
  store.storage('hello').set('settings', {n: 1});
  assert.deepEqual(plain(store.storage('hello').get('settings')), {n: 1});
  store.clear('hello');
  assert.equal(store.storage('hello').get('settings'), null);
  store.remove('hello');
  assert.deepEqual(plain(store.list()), []);
});

test('the shipped catalog is valid and has no privileged server surface', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'client-plugins', 'index.json'), 'utf8'));
  assert.ok(Array.isArray(catalog), 'the catalog is a JSON list');
  for (const plugin of catalog) {
    assert.match(plugin.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
    assert.equal(plugin.api, 1);
    assert.ok(plugin.source.includes('exports.activate'));
    // Sandboxed client plugins use the normal API; they do not claim a server plugin route.
    assert.doesNotMatch(plugin.source, /\.route\s*\(/);
  }
});
