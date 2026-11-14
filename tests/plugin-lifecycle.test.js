'use strict';
// Browser-side lifecycle: install, reinstall, update, enable, dependencies, export and uninstall. The host's iframe
// behaviour is covered by tests/browser_plugin_platform.py; this file covers every rule that must hold before code runs.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

function storeWith(seed = []) {
  const data = new Map();
  if (seed.length) data.set('agentsys-client-plugins', JSON.stringify(seed));
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
  for (const file of ['shared/core.js', 'js/app/plugin-manifest.js', 'js/app/plugin-capabilities.js', 'js/app/plugin-store.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return {store: vm.runInContext('PluginStore', context), data, context};
}

const pkg = (overrides = {}) => ({
  id: 'lifecycle',
  title: 'Lifecycle',
  version: '1.0.0',
  source: 'exports.activate = () => {};',
  capabilities: ['graph.read'],
  ...overrides,
});

test('install, reinstall the same version and enable state', () => {
  const {store} = storeWith();
  const made = store.install(pkg());
  assert.equal(made.version, '1.0.0');
  assert.equal(made.enabled, true);
  const firstAt = made.installedAt;
  assert.ok(firstAt > 0);
  // Installing the same version again replaces the package, not the entry: one plugin, one record.
  const again = store.install(pkg({description: 'same version, new text'}));
  assert.equal(store.list().length, 1);
  assert.equal(again.description, 'same version, new text');
  assert.equal(again.installedAt, firstAt);
  assert.equal(store.setEnabled('lifecycle', false).enabled, false);
  assert.equal(store.install(pkg({version: '1.0.1'})).enabled, false, 'an update keeps the user choice');
  assert.equal(store.get('lifecycle').enabled, false);
});

test('a new version must be newer unless a downgrade is explicit', () => {
  const {store} = storeWith();
  store.install(pkg({version: '2.0.0'}));
  assert.throws(
    () => store.install(pkg({version: '1.0.0'})),
    error => error.code === 'invalid_request' && /newer/.test(error.message)
  );
  assert.equal(store.install(pkg({version: '1.0.0'}), {allowDowngrade: true}).version, '1.0.0');
});

test('dependency validation names the missing, disabled and incompatible dependency', () => {
  const {store} = storeWith();
  assert.throws(
    () => store.install(pkg({id: 'app', dependencies: {core: '^1.0.0'}})),
    error => error.code === 'missing_dependency' && /core/.test(error.message)
  );
  store.install(pkg({id: 'core', version: '1.5.0'}));
  assert.equal(store.install(pkg({id: 'app', dependencies: {core: '^1.0.0'}})).id, 'app');
  assert.throws(
    () => store.install(pkg({id: 'bad', dependencies: {core: '^2.0.0'}})),
    error => error.code === 'incompatible_dependency'
  );
  store.install(pkg({id: 'needs-core', dependencies: {core: '^1.0.0'}}));
  store.setEnabled('core', false);
  store.setEnabled('needs-core', false);
  assert.throws(
    () => store.setEnabled('needs-core', true),
    error => error.code === 'disabled_dependency'
  );
  assert.equal(store.dependencyState('app').ok, false);
  assert.equal(store.dependencyState('core').ok, true);
});

test('a format 2 package keeps its modules and assets across export and reinstall', () => {
  const {store} = storeWith();
  const packet = {
    format: 2,
    manifest: {id: 'modular', name: 'Modular', version: '1.4.0', api: 2, capabilities: ['library.write']},
    main: 'main.js',
    files: {
      'main.js': 'const help = require("./lib/help"); exports.activate = api => help(api);',
      'lib/help.js': 'module.exports = api => api.ui.toast("help");',
    },
    contributes: {library: [{name: 'X', code: 'node.output.ok = true;'}]},
  };
  const made = store.install(packet);
  assert.equal(made.hasModules, true);
  assert.deepEqual(Object.keys(store.record('modular').files), ['lib/help.js']);
  const exported = store.export('modular');
  assert.equal(exported.format, 2);
  assert.equal(exported.main, 'main.js');
  assert.match(exported.files['main.js'], /require\("\.\/lib\/help"\)/);
  assert.match(exported.files['lib/help.js'], /module\.exports/);
  assert.equal(exported.contributes.library[0].name, 'X');
  const reinstalled = store.install(exported);
  assert.equal(reinstalled.version, '1.4.0');
  assert.equal(store.record('modular').contributes.library[0].code, 'node.output.ok = true;');
});

test('a record written by the older client is read without losing its source or capabilities', () => {
  const legacy = {
    id: 'legacy',
    title: 'Legacy',
    version: '1.0.0',
    api: 1,
    capabilities: ['graph.read', 'library.write'],
    source: 'exports.activate = api => api.ui.toast("old");',
    enabled: false,
  };
  const {store} = storeWith([legacy]);
  const found = store.get('legacy');
  assert.equal(found.formatVersion, 1);
  assert.equal(found.enabled, false);
  assert.deepEqual([...found.capabilities].sort(), ['graph.read', 'library.write']);
  assert.match(store.export('legacy').files['plugin.js'], /toast/);
});

test('uninstall removes the package and every environment-scoped value', () => {
  const {store, data} = storeWith();
  store.install(pkg());
  store.storage('lifecycle').set('settings', {n: 1});
  assert.deepEqual(JSON.parse(JSON.stringify(store.storage('lifecycle').get('settings'))), {n: 1});
  store.clear('lifecycle');
  assert.equal(store.storage('lifecycle').get('settings'), null);
  store.remove('lifecycle');
  assert.deepEqual(JSON.parse(JSON.stringify(store.list())), []);
  assert.equal([...data.keys()].some(key => key.startsWith('agentsys-plugin-lifecycle')), false);
});

test('the host storage scope is not reachable with a plugin storage key', () => {
  const {store} = storeWith();
  store.install(pkg());
  store.hostStorage('lifecycle').set('__agentsys:deployment', {ok: true});
  assert.deepEqual(JSON.parse(JSON.stringify(store.hostStorage('lifecycle').get('__agentsys:deployment'))), {ok: true});
  assert.throws(() => store.storage('lifecycle').set('__agentsys:deployment', {}), /reserved/);
  assert.equal(store.storage('lifecycle').get('__agentsys:deployment'), null);
});
