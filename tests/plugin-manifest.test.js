'use strict';
// The package contract: manifest normalization, English semantic versions, dependencies and compatibility.
const test = require('node:test'),
  assert = require('node:assert/strict');
const Manifest = require('../js/app/plugin-manifest');

const base = {
  id: 'demo',
  name: 'Demo plugin',
  version: '1.2.3',
  api: 2,
  source: 'exports.activate = api => { api.ui.toast("hi"); };',
};

test('semantic versions and ranges are compared without a dependency', () => {
  assert.equal(Manifest.compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(Manifest.compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(Manifest.compareVersions('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(Manifest.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  for (const [version, range, ok] of [
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['3.0.0', '^1.0.0 || ^3.0.0', true],
    ['1.0.0', '1.0.0', true],
    ['1.0.1', '1.0.0', false],
    ['1.0.0', '*', true],
  ])
    assert.equal(Manifest.satisfies(version, range), ok, `${version} ${range}`);
});

test('a format 2 package is normalized: modules, assets, contributions and metadata', () => {
  const record = Manifest.normalizePackage({
    format: 2,
    manifest: {
      id: 'com.example.data',
      name: 'Structured data',
      version: '2.1.0',
      description: 'A collection UI.',
      icon: 'database',
      api: 2,
      engines: {agentsys: '>=0.3.0 <1.0.0'},
      capabilities: ['collections.read', 'collections.write', 'library.write'],
      dependencies: {'core-tools': '^1.0.0'},
      author: 'Example',
      license: 'MIT',
    },
    main: 'main.js',
    files: {
      'main.js': 'const helper = require("./lib/helper"); exports.activate = api => helper(api);',
      'lib/helper.js': 'module.exports = api => api.ui.toast("ready");',
      'schema.json': '{"type":"object"}',
    },
    assets: {logo: {type: 'image/png', data: 'aGVsbG8='}},
    contributes: {
      collections: [{name: 'demo-notes', title: 'Notes', schema: {type: 'object'}}],
      library: [{name: 'Double', code: 'node.output.value = node.input.value * 2;', outputs: ['value']}],
      workflows: [{name: 'Demo flow', nodes: [{library: 'Double'}]}],
    },
  });
  assert.equal(record.id, 'com.example.data');
  assert.equal(record.title, 'Structured data');
  assert.equal(record.version, '2.1.0');
  assert.equal(record.api, 2);
  assert.equal(record.main, 'main.js');
  assert.match(record.source, /require\("\.\/lib\/helper"\)/);
  assert.deepEqual(Object.keys(record.files), ['lib/helper.js', 'schema.json']);
  assert.match(record.assets.logo, /^data:image\/png;base64,/);
  assert.equal(record.contributes.collections[0].name, 'demo-notes');
  assert.equal(record.contributes.library[0].name, 'Double');
  assert.equal(record.contributes.workflows[0].name, 'Demo flow');
  assert.equal(record.capabilities.length, 3);
});

test('the original single-source package still reads and writes as format 2', () => {
  const record = Manifest.normalizePackage({...base, api: 1, capabilities: ['graph.read']});
  assert.equal(record.formatVersion, 1);
  assert.equal(record.api, 1);
  assert.equal(record.main, 'plugin.js');
  assert.deepEqual(record.capabilities, ['graph.read']);
  const packet = Manifest.exportPackage(record);
  assert.equal(packet.format, 2);
  assert.equal(packet.main, 'plugin.js');
  assert.equal(packet.files['plugin.js'], base.source);
  assert.match(packet.checksum, /^fnv1a-/);
  // The exported package installs back to the same code, version and capabilities.
  const again = Manifest.normalizePackage(packet);
  assert.equal(again.source, base.source);
  assert.equal(again.version, base.version);
  assert.deepEqual(again.capabilities, ['graph.read']);
});

test('compatibility is enforced: API, engine range and semantic version', () => {
  assert.throws(
    () => Manifest.normalizePackage({...base, api: 99}),
    error => error.code === 'incompatible_protocol'
  );
  assert.throws(
    () => Manifest.normalizePackage({...base, manifest: {...base, engines: {agentsys: '>=9.0.0'}}}),
    error => error.code === 'incompatible_protocol'
  );
  assert.throws(() => Manifest.normalizePackage({...base, version: 'latest'}), /semantic/);
});

test('package paths are relative, portable and cannot leave the package', () => {
  for (const path of ['../evil.js', '/etc/passwd', 'C:/evil.js', 'a\\b.js', 'a/../../b.js', './main.js']) {
    assert.throws(
      () =>
        Manifest.normalizePackage({
          ...base,
          format: 2,
          manifest: {id: 'x.y', name: 'X', version: '1.0.0', api: 2},
          main: 'main.js',
          files: {[path]: 'exports.activate = () => {};', 'main.js': 'exports.activate = () => {};'},
        }),
      error => error.code === 'invalid_request',
      path
    );
  }
  assert.throws(
    () =>
      Manifest.normalizePackage({
        ...base,
        format: 2,
        manifest: {id: 'x.y', name: 'X', version: '1.0.0', api: 2},
        main: 'main.js',
        files: {'main.js': 'exports.activate = () => {};', 'view.html': '<script></script>'},
      }),
    /JavaScript or JSON/
  );
});

test('dependencies are named, range checked and activated in order, with cycles refused', () => {
  const core = Manifest.normalizePackage({...base, id: 'core', version: '1.4.0'});
  const app = Manifest.normalizePackage({...base, id: 'app', version: '1.0.0', dependencies: {core: '^1.0.0'}});
  assert.equal(Manifest.checkDependencies(app, [core, app], {requireEnabled: true}).ok, true);
  const disabled = {...core, enabled: false};
  assert.equal(Manifest.checkDependencies(app, [disabled, app], {requireEnabled: true}).errors[0].code, 'disabled_dependency');
  const missing = Manifest.checkDependencies(app, [app]);
  assert.equal(missing.errors[0].code, 'missing_dependency');
  const wrong = {...core, version: '2.0.0'};
  assert.equal(Manifest.checkDependencies(app, [wrong, app]).errors[0].code, 'incompatible_dependency');
  const order = Manifest.activationOrder([app, core]).order.map(plugin => plugin.id);
  assert.deepEqual(order, ['core', 'app']);
  const cycleA = {...app, id: 'a', dependencies: {b: '*'}};
  const cycleB = {...app, id: 'b', dependencies: {a: '*'}};
  assert.equal(Manifest.activationOrder([cycleA, cycleB]).errors[0].code, 'dependency_cycle');
});

test('unknown capability-shaped fields are kept out of the runtime manifest', () => {
  const record = Manifest.normalizePackage({
    ...base,
    format: 2,
    manifest: {id: 'x.y', name: 'X', version: '1.0.0', api: 2, unknown: 'ignored'},
    main: 'main.js',
    files: {'main.js': 'exports.activate = () => {};'},
  });
  assert.equal('unknown' in record, false);
  assert.equal(record.title, 'X');
});
