'use strict';
// The public contract is only public if it is present, complete and consistent with the documentation.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

test('the SDK ships TypeScript declarations and a README', () => {
  assert.ok(exists('sdk/agentsys-plugin.d.ts'));
  assert.ok(exists('sdk/README.md'));
  const types = read('sdk/agentsys-plugin.d.ts');
  for (const member of [
    'interface AgentSysPluginApi',
    'interface PluginManifest',
    'interface PluginPackage',
    'addPage',
    'addLibrarySection',
    'addSettingsSection',
    'addInspectorSection',
    'addResourceView',
    'showDialog',
    'onUpdate',
    'onUninstall',
  ]) {
    assert.match(types, new RegExp(member), `the declarations name ${member}`);
  }
  assert.match(types, /API version 2/);
});

test('every documented plugin guide exists and the index links to it', () => {
  const guides = [
    'plugin-architecture',
    'plugin-sdk',
    'plugin-manifest',
    'plugin-lifecycle',
    'plugin-ui',
    'plugin-library',
    'plugin-capabilities',
    'plugin-security',
    'plugin-packaging',
    'plugin-development',
    'plugin-testing',
    'plugin-migration',
  ];
  const index = read('docs/plugins.md');
  for (const guide of guides) {
    assert.ok(exists(`docs/${guide}.md`), guide);
    assert.match(index, new RegExp(`${guide}\\.md`), `docs/plugins.md links ${guide}`);
  }
});

test('the plugin documentation does not present a removed server-plugin API as current', () => {
  for (const guide of [
    'plugin-architecture',
    'plugin-sdk',
    'plugin-manifest',
    'plugin-lifecycle',
    'plugin-ui',
    'plugin-library',
    'plugin-capabilities',
    'plugin-security',
    'plugin-packaging',
    'plugin-development',
  ]) {
    const text = read(`docs/${guide}.md`);
    // Migration pages may name the old API; current guides must not call api.route or require a server plugin folder.
    assert.doesNotMatch(text, /api\.route\s*\(/, guide);
    assert.doesNotMatch(text, /plugins?\/<id>\/main\.js/, guide);
  }
});
