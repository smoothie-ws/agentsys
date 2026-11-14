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

test('migration backs up, preserves plugin sources and moves providers and keys to the generic API', async () => {
  const dir = fixture();
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
