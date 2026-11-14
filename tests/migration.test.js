'use strict';
// The migration preserves plugin data, snapshots the old folder, moves provider keys to secrets and never
// installs server plugin code into the new server.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {migrateData} = require('../server/migrate');
const {createServer} = require('../server');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-migrate-'));
  const plugins = path.join(dir, 'plugins');
  fs.mkdirSync(path.join(plugins, 'ai'), {recursive: true});
  fs.writeFileSync(
    path.join(plugins, 'ai', 'main.js'),
    "exports.start = api => { api.route('GET', 'providers', () => []); };"
  );
  fs.writeFileSync(
    path.join(plugins, 'ai', 'client.js'),
    'exports.activate = api => api.ui.addPage({id: "p", render: () => "x"});'
  );
  fs.writeFileSync(
    path.join(plugins, 'ai', 'data.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-1',
          providerId: 'local',
          name: 'Local',
          baseURL: 'http://localhost:11434/v1',
          model: 'llama',
          apiKey: 'sk-secret-value',
        },
      ],
    })
  );
  fs.writeFileSync(
    path.join(plugins, 'index.json'),
    JSON.stringify([{id: 'ai', enabled: true, manifest: {name: 'AI', version: '2.3.1'}, installed: 1}])
  );
  fs.mkdirSync(path.join(dir, 'other'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'other', 'ui-state.json'), JSON.stringify({'agentsys-sidebar-width': 300}));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({developer_mode: true}));
  return dir;
}

test('a dry run reports the migration and writes nothing', async () => {
  const dir = fixture();
  try {
    const report = await migrateData({dataDir: dir, dryRun: true});
    assert.equal(report.dry_run, true);
    assert.equal(report.plugins.length, 1);
    assert.equal(report.plugins[0].has_server_routes, true);
    assert.equal(report.migrated.records, 0);
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
    assert.equal(fs.existsSync(path.join(dir, 'plugins-migrated')), false);
    assert.equal(fs.existsSync(path.join(dir, 'collections.json')), false);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('migration backs up, preserves plugin sources and moves providers and keys to the generic API', async () => {  const dir = fixture();
  let app;
  try {
    const report = await migrateData({dataDir: dir});
    assert.ok(report.backup && fs.existsSync(report.backup));
    assert.ok(fs.existsSync(path.join(report.backup, 'plugins', 'ai', 'data.json')));
    assert.ok(fs.existsSync(path.join(dir, 'plugins-migrated', 'ai', 'main.js')));
    assert.ok(fs.existsSync(path.join(dir, 'plugins-migrated', 'ai', 'client.js')));
    assert.ok(fs.existsSync(path.join(dir, 'client-migration', 'ui-state.json')));
    // The old plugin folder is untouched.
    assert.ok(fs.existsSync(path.join(dir, 'plugins', 'ai', 'main.js')));
    app = createServer({dataDir: dir, serveClient: false, legacyStorage: false});
    const request = async (method, route, body, query = {}) => {
      const result = await app.api.request(method, route, {body: body ?? {}, query});
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    };
    const definitions = await request('GET', 'collections');
    assert.ok(definitions.some(item => item.name === 'providers'));
    const records = await request('GET', 'collections/providers/records');
    assert.equal(records.total, 1);
    assert.equal(records.records[0].data.providerId, 'local');
    assert.match(records.records[0].data.apiKey, /^\{\{secret:provider-/);
    assert.equal(records.records[0].data.apiKey.includes('sk-secret-value'), false);
    const secretName = /^\{\{secret:([^}]+)\}\}$/.exec(records.records[0].data.apiKey)[1];
    const metadata = await request('GET', 'secrets/' + secretName);
    assert.equal(metadata.present, true);
    // The stored secret file holds the value; the collection contains only the reference.
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'secrets', secretName + '.json'), 'utf8'));
    assert.equal(stored.value, 'sk-secret-value');
    // Old UI state is still where it was and can be read once for a client import.
    assert.deepEqual(await request('GET', 'migration/ui-state'), {'agentsys-sidebar-width': 300});
    // Running the migration twice is idempotent for the collection.
    await app.close();
    app = null;
    await migrateData({dataDir: dir});
    app = createServer({dataDir: dir, serveClient: false, legacyStorage: false});
    const again = async (method, route, body, query = {}) =>
      JSON.parse(JSON.stringify(await app.api.request(method, route, {body: body ?? {}, query})));
    assert.equal((await again('GET', 'collections/providers/records')).total, 1);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ----- edge cases: a second run, missing keys, broken data, missing folders, plugin callers -----

async function readAfter(dir, work) {
  const app = createServer({dataDir: dir, serveClient: false, legacyStorage: false});
  const request = async (method, route, body, query = {}) => {
    const result = await app.api.request(method, route, {body: body ?? {}, query});
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  try {
    return await work(request);
  } finally {
    await app.close();
  }
}

test('a migration that fails halfway releases the data folder and leaves the old data readable', async () => {
  const dir = fixture();
  try {
    // A damaged collection file makes the first provider write fail after the backup and preservation steps.
    fs.mkdirSync(path.join(dir, 'other'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'other', 'collections.json'), '{"broken":');
    await assert.rejects(migrateData({dataDir: dir}), /not valid JSON|JSON|Unexpected|Unexpected end/i);
    assert.equal(fs.existsSync(path.join(dir, '.server.lock')), false, 'the lock was released');
    // The untouched plugin source is still there; a second run after the damage is repaired converges.
    assert.equal(fs.readFileSync(path.join(dir, 'plugins', 'ai', 'main.js'), 'utf8').includes('api.route'), true);
    fs.writeFileSync(path.join(dir, 'other', 'collections.json'), '{}');
    const report = await migrateData({dataDir: dir});
    assert.equal(report.migrated.records, 1);
    await readAfter(dir, async request => {
      assert.equal((await request('GET', 'collections/providers/records')).total, 1);
    });
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a provider without a key is migrated without a secret, and two providers with one id become one record', async () => {
  const dir = fixture();
  try {
    const data = path.join(dir, 'plugins', 'ai', 'data.json');
    const plugin = JSON.parse(fs.readFileSync(data, 'utf8'));
    plugin.providers.push({id: 'prov-1', providerId: 'local', name: 'Local again', baseURL: 'http://localhost:9999/v1'});
    plugin.providers.push({id: 'prov-2', providerId: 'other', name: 'Other', baseURL: 'https://other.test/v1'});
    fs.writeFileSync(data, JSON.stringify(plugin));
    const report = await migrateData({dataDir: dir});
    assert.equal(report.migrated.records, 3, 'each provider in the old data is processed');
    assert.equal(report.migrated.secrets.length, 1, 'only the provider with a key creates a secret');
    await readAfter(dir, async request => {
      const records = await request('GET', 'collections/providers/records');
      assert.equal(records.total, 2);
      const local = records.records.find(record => record.data.providerId === 'local');
      assert.equal(local.data.baseURL, 'http://localhost:9999/v1', 'the later provider record wins, as before');
      assert.match(local.data.apiKey, /^\{\{secret:/, 'a later record without a key keeps the migrated reference');
      const other = records.records.find(record => record.data.providerId === 'other');
      assert.equal('apiKey' in other.data, false);
    });
    // A second run leaves exactly the same records and secrets.
    const again = await migrateData({dataDir: dir});
    assert.equal(again.migrated.records, 3);
    await readAfter(dir, async request => {
      assert.equal((await request('GET', 'collections/providers/records')).total, 2);
    });
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('unreadable plugin data is preserved and reported, and the server still starts', async () => {
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'plugins', 'ai', 'data.json'), '{"providers": [');
    const report = await migrateData({dataDir: dir});
    assert.equal(report.migrated.records, 0);
    assert.equal(report.plugins.length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'plugins-migrated', 'ai', 'main.js')), true);
    await readAfter(dir, async request => {
      assert.deepEqual(await request('GET', 'collections'), []);
      assert.deepEqual(await request('GET', 'projects'), []);
    });
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('migration refuses a folder that does not exist and reports workflows that call a removed plugin route', async () => {
  await assert.rejects(migrateData({dataDir: path.join(os.tmpdir(), 'agentsys-no-such-folder-' + Date.now())}), /not found/);
  const dir = fixture();
  try {
    fs.mkdirSync(path.join(dir, 'workflows'), {recursive: true});
    fs.writeFileSync(
      path.join(dir, 'workflows', 'wf1.json'),
      JSON.stringify({format: 'agentsys.text/1', value: {nodes: [], note: 'calls plugins/ai/providers'}})
    );
    const report = await migrateData({dataDir: dir, dryRun: true});
    assert.deepEqual(report.plugin_callers, [path.join('workflows', 'wf1.json')]);
    assert.match(report.warnings.join('\n'), /plugin route/);
    // A dry run wrote nothing, including no lock file.
    assert.equal(fs.existsSync(path.join(dir, '.server.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'plugins-migrated')), false);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('existing collections and their records survive a migration untouched', async () => {
  const dir = fixture();
  try {
    await readAfter(dir, async request => {
      await request('PUT', 'collections/notes', {
        title: 'Notes',
        schema: {type: 'object', properties: {text: {type: 'string'}}},
      });
      await request('POST', 'collections/notes/records', {data: {text: 'keep me'}});
    });
    await migrateData({dataDir: dir});
    await readAfter(dir, async request => {
      const records = await request('GET', 'collections/notes/records');
      assert.deepEqual(records.records.map(record => record.data.text), ['keep me']);
      const providers = await request('GET', 'collections/providers/records');
      assert.equal(providers.total, 1);
    });
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
