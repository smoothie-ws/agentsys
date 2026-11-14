'use strict';
// The five reference packages are real distributions: valid manifests, bundled modules, declared contributions and
// no privileged server code. The same files are installed by tests/browser_plugin_platform.py.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const Manifest = require('../js/app/plugin-manifest');
const {readSource} = require('../tools/plugin-pack');

const ROOT = path.join(__dirname, '..', 'client-plugins', 'reference');
const slugs = ['ui-showcase', 'library-pack', 'structured-data', 'external-integration', 'security-test'];
const expectedIds = [
  'reference-ui-showcase',
  'reference-library-pack',
  'reference-structured-data',
  'reference-external',
  'reference-security',
];

test('five reference plugins build from source with valid manifests', () => {
  assert.deepEqual(
    fs.readdirSync(ROOT, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
    [...slugs].sort()
  );
  for (const [index, slug] of slugs.entries()) {
    const record = Manifest.normalizePackage(readSource(path.join(ROOT, slug)));
    assert.equal(record.id, expectedIds[index], slug);
    assert.equal(record.api, 2);
    assert.match(record.version, /^\d+\.\d+\.\d+/);
    assert.ok(record.capabilities.length, `${slug} declares what it uses`);
    if (slug === 'ui-showcase') assert.match(record.assets.logo, /^data:image\/png;base64,/);
    // A client plugin never defines server routes and never ships a server-side host. The security reference names
    // browser globals only to prove they are unreachable, so its attempt strings are exempt from the DOM check.
    if (slug !== 'security-test')
      assert.doesNotMatch(record.source, /\bdocument\.|\bwindow\.|\blocalStorage\b|\bsessionStorage\b/);
    assert.doesNotMatch(record.source, /\.route\s*\(|listen\s*\(|require\(['"]fs['"]\)/);
    for (const [name, source] of Object.entries(record.files)) {
      const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
      for (const request of requires) {
        assert.match(request, /^\.\//, `${slug}: ${name} imports only inside the package`);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), request));
        assert.ok(
          target in record.files || target + '.js' in record.files || target === record.main,
          `${slug}: ${request} resolves`
        );
      }
    }
  }
});

test('the reference plugins exercise every required extension point', () => {
  const sources = Object.fromEntries(
    slugs.map(slug => [slug, JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'plugin.json'), 'utf8'))])
  );
  const showcase = fs.readFileSync(path.join(ROOT, 'ui-showcase', 'main.js'), 'utf8');
  for (const member of [
    'addPage',
    'addToolbarButton',
    'addContextMenu',
    'commands.register',
    'ui.notify',
    'addSettingsSection',
    'addHomeCard',
    'addInspectorSection',
  ])
    assert.match(showcase, new RegExp(member.replace('.', '\\.')), `Plugin A uses ${member}`);

  assert.equal(sources['library-pack'].contributes.library.length >= 2, true);
  assert.equal(sources['library-pack'].contributes.workflows.length, 1);
  assert.equal(sources['library-pack'].contributes.collections[0].name, 'pack-notes');
  assert.match(fs.readFileSync(path.join(ROOT, 'library-pack', 'main.js'), 'utf8'), /addLibrarySection/);

  assert.equal(sources['structured-data'].contributes.collections[0].name, 'structured-notes');
  const structured = fs.readFileSync(path.join(ROOT, 'structured-data', 'main.js'), 'utf8');
  for (const method of ['collections.create', 'collections.update', 'collections.define', 'addResourceView']) assert.match(structured, new RegExp(method.replace('.', '\\.')));

  const external = sources['external-integration'];
  assert.match(external.capabilities.join(' '), /net\.fetch:127\.0\.0\.1:\*/);
  assert.match(external.capabilities.join(' '), /secrets\.use:reference-demo/);
  assert.match(JSON.stringify(external.contributes.library[0].code), /secret:reference-demo/);

  assert.deepEqual(sources['security-test'].capabilities, ['graph.read']);
  const security = fs.readFileSync(path.join(ROOT, 'security-test', 'main.js'), 'utf8');
  for (const attempt of ['write-project', 'read-foreign-secret', 'auth-endpoint', 'foreign-command', 'direct-fetch', 'top-storage'])
    assert.match(security, new RegExp(attempt));
});

test('the generated distribution files validate and are not part of the source bundle', () => {
  for (const slug of slugs) {
    const record = Manifest.normalizePackage(readSource(path.join(ROOT, slug)));
    const file = path.join(ROOT, slug, `${record.id}-${record.version}.agentsys-plugin.json`);
    assert.ok(fs.existsSync(file), `${slug} was built with tools/plugin-pack.js`);
    const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(packet.format, 2);
    assert.equal(packet.manifest.id, record.id);
    assert.equal(packet.checksum, Manifest.fingerprint(record));
    const again = Manifest.normalizePackage(packet);
    assert.equal(again.source, record.source);
    assert.deepEqual(again.capabilities, record.capabilities);
  }
});

test('the shipped catalog stays empty: no package is installed without the user asking', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'client-plugins', 'index.json'), 'utf8'));
  assert.deepEqual(catalog, []);
});

test('the documented example project builds into a valid package', () => {
  const source = readSource(path.join(__dirname, '..', 'examples', 'hello-plugin'));
  const record = Manifest.normalizePackage(source);
  assert.equal(record.id, 'hello-agent');
  assert.equal(record.api, 2);
  assert.match(record.source, /commands\.register/);
  const packet = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'examples', 'hello-plugin', 'hello-agent-1.0.0.agentsys-plugin.json'), 'utf8')
  );
  assert.equal(packet.manifest.id, 'hello-agent');
  assert.equal(packet.checksum, Manifest.fingerprint(record));
});
