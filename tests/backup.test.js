'use strict';
// The backup tool: refuses a live data folder unless forced, copies every file, checks that the JSON parses, and
// produces a folder that a server can start on directly.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {execFileSync} = require('node:child_process');
const {createApiServer} = require('../server/api-server');

const TOOL = path.join(__dirname, '..', 'tools', 'backup.js');
const run = (data, out, extra = []) => {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, '--data', data, '--out', out, '--json', ...extra], {
      encoding: 'utf8',
    });
    return {code: 0, json: JSON.parse(stdout)};
  } catch (error) {
    return {code: error.status, stdout: error.stdout, stderr: error.stderr, json: error.stdout ? JSON.parse(error.stdout) : null};
  }
};

test('a stopped folder is copied completely, checked and restorable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-source-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-target-'));
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-restored-'));
  try {
    const app = createApiServer({dataDir: dir, token: 't'});
    await app.api.request('POST', 'projects', {body: {name: 'Backed up'}, query: {}});
    await app.api.request('PUT', 'collections/notes', {
      body: {title: 'Notes', schema: {type: 'object', properties: {text: {type: 'string'}}}},
      query: {},
    });
    await app.api.request('POST', 'collections/notes/records', {body: {data: {text: 'kept'}}, query: {}});
    await app.close();

    const result = run(dir, out);
    assert.equal(result.code, 0, result.stderr || '');
    assert.equal(result.json.ok, true);
    assert.equal(result.json.live, false);
    assert.ok(result.json.files >= 3);
    assert.deepEqual(result.json.unreadable, []);
    const destination = result.json.destination;
    assert.equal(fs.existsSync(path.join(destination, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(destination, 'projects.json')), true);

    // Restore: the backup folder is itself a data folder.
    fs.cpSync(destination, restored, {recursive: true});
    const server = createApiServer({dataDir: restored, token: 't'});
    try {
      const projects = JSON.parse(JSON.stringify(await server.api.request('GET', 'projects', {body: {}, query: {}})));
      assert.deepEqual(projects.map(item => item.name), ['Backed up']);
      const records = JSON.parse(JSON.stringify(await server.api.request('GET', 'collections/notes/records', {body: {}, query: {}})));
      assert.deepEqual(records.records.map(record => record.data.text), ['kept']);
    } finally {
      await server.close();
    }
  } finally {
    for (const folder of [dir, out, restored]) fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('a running server is refused without --force, and --force says the copy is live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-live-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-live-out-'));
  const app = createApiServer({dataDir: dir, token: 't'});
  try {
    const refused = run(dir, out);
    assert.equal(refused.code, 3);
    assert.equal(refused.json.ok, false);
    assert.match(refused.json.error, /server is running/);
    const forced = run(dir, out, ['--force']);
    assert.equal(forced.code, 0, forced.stderr || '');
    assert.equal(forced.json.live, true);
  } finally {
    await app.close();
    for (const folder of [dir, out]) fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('a corrupted JSON file is copied, reported and makes the backup exit non-zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-bad-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-bad-out-'));
  try {
    fs.writeFileSync(path.join(dir, 'projects.json'), '{"broken":');
    fs.writeFileSync(path.join(dir, 'prefs.json'), '{"theme":"Light"}');
    const result = run(dir, out);
    assert.equal(result.code, 1);
    assert.equal(result.json.unreadable.length, 1);
    assert.equal(result.json.unreadable[0].file, 'projects.json');
    assert.equal(fs.existsSync(path.join(result.json.destination, 'projects.json')), true, 'the file is kept for repair');
  } finally {
    for (const folder of [dir, out]) fs.rmSync(folder, {recursive: true, force: true});
  }
});
