'use strict';
// Storage and data integrity: an interrupted multi-key commit, a file that was being written when the process
// ended, a corrupted JSON file, a copy of the data folder, the sidecar scripts of a workflow, and two servers on
// one folder. Every test uses a temporary data folder.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {createServer} = require('../server');

const TOKEN = 'storage-token';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-storage-'));
const clean = dir => fs.rmSync(dir, {recursive: true, force: true});
const read = (dir, ...parts) => fs.readFileSync(path.join(dir, ...parts), 'utf8');
const exists = (dir, ...parts) => fs.existsSync(path.join(dir, ...parts));

const seedProjects = name => [{id: 'p1', name, workflows: [{id: 'w1', name: 'Flow'}]}];

/** Boots a server on the folder and returns {app, call} where call goes through the API without HTTP. */
async function boot(dir, options = {}) {
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  if (!app.api) throw new Error('the backend did not load');
  const call = async (method, route, body, query) => {
    const result = await app.api.request(method, route, {body: body ?? {}, query});
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  return {app, call};
}

test('a commit interrupted after its redo record is replayed once at the next start', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, '.transaction.json'),
      JSON.stringify({
        set: {
          projects: [{id: 'p1', name: 'replayed', description: '', created: 1, workflows: [{id: 'w1', name: 'Flow', created: 1}]}],
        },
        remove: [],
      })
    );
    const {app, call} = await boot(dir);
    try {
      const projects = await call('GET', 'projects');
      assert.deepEqual(projects.map(item => [item.id, item.name, item.workflow_count]), [['p1', 'replayed', 1]]);
      assert.equal(exists(dir, '.transaction.json'), false, 'the record is consumed');
      assert.match(read(dir, 'projects.json'), /replayed/);
    } finally {
      await app.close();
    }
    // Starting again applies nothing a second time.
    const again = await boot(dir);
    try {
      assert.deepEqual((await again.call('GET', 'projects')).map(item => item.name), ['replayed']);
    } finally {
      await again.app.close();
    }
  } finally {
    clean(dir);
  }
});

test('an unreadable commit record is set aside and the server starts on the data files', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify([{id: 'p1', name: 'kept', description: '', created: 1, workflows: []}])
    );
    fs.writeFileSync(path.join(dir, '.transaction.json'), '{not json');
    const {app, call} = await boot(dir);
    try {
      assert.deepEqual((await call('GET', 'projects')).map(item => item.name), ['kept']);
      assert.equal(exists(dir, '.transaction.json'), false);
      assert.equal(exists(dir, '.transaction.json.invalid'), true, 'kept for a person to inspect');
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('a commit record that names a path outside the folder writes nothing', async () => {
  const dir = tmp();
  try {
    const escape = path.join(path.dirname(dir), 'replayed-escape.json');
    fs.writeFileSync(
      path.join(dir, '.transaction.json'),
      JSON.stringify({set: {'../replayed-escape': {owned: true}}, remove: []})
    );
    const {app, call} = await boot(dir);
    try {
      assert.equal(fs.existsSync(escape), false, 'no file was written outside the data folder');
      assert.deepEqual(await call('GET', 'projects'), []);
      assert.equal(exists(dir, '.transaction.json.invalid'), true);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('the temporary file of a write that never finished is ignored, not read as data', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify([{id: 'p1', name: 'real', description: '', created: 1, workflows: []}])
    );
    fs.writeFileSync(path.join(dir, 'projects.json.tmp-4242'), '{"half":');
    const {app, call} = await boot(dir);
    try {
      assert.deepEqual((await call('GET', 'projects')).map(item => item.name), ['real']);
      assert.ok(app.api.diagnostics().routes > 0);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('a corrupted data file fails its own requests, not the server', async () => {
  const dir = tmp();
  let app;
  let base;
  try {
    app = createServer({dataDir: dir, token: TOKEN, serveClient: false});
    base = await app.listen(0);
    const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
    await fetch(base + '/api/projects', {method: 'POST', headers, body: JSON.stringify({name: 'Fine'})});
    await app.close();
    // Corrupt the file while the server is stopped, so the next read cannot come from a cache.
    fs.writeFileSync(path.join(dir, 'projects.json'), '{"broken":');
    app = createServer({dataDir: dir, token: TOKEN, serveClient: false});
    base = await app.listen(0);
    const broken = await fetch(base + '/api/projects', {headers});
    assert.equal(broken.status, 500);
    const body = await broken.json();
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message.includes('at '), false, 'no stack trace');
    // The server is still alive and other families still answer.
    assert.equal((await fetch(base + '/api/meta')).status, 200);
    const diagnostics = await (await fetch(base + '/api/diagnostics', {headers})).json();
    assert.ok(diagnostics.recent_errors.some(entry => entry.status === 500));
    // Fixing the file (or restoring a copy) recovers: a restart reads the repaired folder.
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([]));
    await app.close();
    app = createServer({dataDir: dir, token: TOKEN, serveClient: false});
    base = await app.listen(0);
    const fixed = await fetch(base + '/api/projects', {headers: {'Authorization': 'Bearer ' + TOKEN}});
    assert.equal(fixed.status, 200);
    assert.deepEqual(await fixed.json(), []);
  } finally {
    if (app) await app.close();
    clean(dir);
  }
});

test('a commit the folder cannot accept does not prevent the next start', async () => {
  const dir = tmp();
  let app;
  try {
    fs.writeFileSync(path.join(dir, 'other'), 'this file blocks the directory a key needs');
    app = createServer({dataDir: dir, token: TOKEN, serveClient: false});
    let base = await app.listen(0);
    const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
    const failed = await fetch(base + '/api/ui-state', {
      method: 'PUT',
      headers,
      body: JSON.stringify({values: {'agentsys-sidebar-width': 300}}),
    });
    assert.equal(failed.status, 500, 'the write fails, and reports it');
    assert.equal(exists(dir, '.transaction.json'), true, 'the redo record survives for diagnosis');
    await app.close();
    app = null;

    // Starting again must not retry the impossible write forever; the record is set aside and the server is usable.
    app = createServer({dataDir: dir, token: TOKEN, serveClient: false});
    base = await app.listen(0);
    assert.equal((await fetch(base + '/api/meta')).status, 200);
    assert.equal((await fetch(base + '/api/projects', {headers})).status, 200);
    assert.equal(exists(dir, '.transaction.json'), false);
    assert.equal(exists(dir, '.transaction.json.invalid'), true);
  } finally {
    if (app) await app.close();
    clean(dir);
  }
});

test('a copy of a stopped data folder is a complete backup, including a pending redo record', async () => {
  const dir = tmp(),
    copy = tmp();
  try {
    let first = await boot(dir);
    await first.call('POST', 'projects', {name: 'Backed up'});
    const made = await first.call('POST', 'collections/notes/records', undefined).catch(error => error);
    assert.ok(made);
    await first.call('PUT', 'collections/notes', {
      title: 'Notes',
      schema: {type: 'object', properties: {text: {type: 'string'}}},
    });
    await first.call('POST', 'collections/notes/records', {data: {text: 'kept'}});
    await first.app.close();
    // The lock is gone with the process, so the folder is a plain directory to copy.
    assert.equal(exists(dir, '.server.lock'), false);
    fs.cpSync(dir, copy, {recursive: true});
    // A copy taken while a commit was in flight still carries its redo record: the copy becomes consistent.
    fs.writeFileSync(
      path.join(copy, '.transaction.json'),
      JSON.stringify({set: {'collection:notes': [
        {id: 'r1', data: {text: 'kept'}, created: 1, updated: 1},
        {id: 'r2', data: {text: 'from the interrupted commit'}, created: 2, updated: 2},
      ]}, remove: []})
    );
    const restored = await boot(copy);
    try {
      const projects = await restored.call('GET', 'projects');
      assert.deepEqual(projects.map(item => item.name), ['Backed up']);
      const records = await restored.call('GET', 'collections/notes/records');
      assert.deepEqual(records.records.map(record => record.data.text).sort(), ['from the interrupted commit', 'kept']);
    } finally {
      await restored.app.close();
    }
  } finally {
    clean(dir);
    clean(copy);
  }
});

test('parallel writes from one server never lose a record', async () => {
  const dir = tmp();
  try {
    const {app, call} = await boot(dir);
    try {
      await call('PUT', 'collections/events', {
        title: 'Events',
        schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
      });
      const writes = Array.from({length: 25}, (_, n) => call('POST', 'collections/events/records', {data: {n}}));
      const results = await Promise.all(writes);
      assert.equal(results.length, 25);
      const list = await call('GET', 'collections/events/records', undefined, {limit: 100});
      assert.equal(list.total, 25, 'every concurrent record is stored');
      assert.deepEqual([...new Set(list.records.map(record => record.data.n))].length, 25);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('a workflow keeps its sidecar scripts, and changing the node removes the script it no longer uses', async () => {
  const dir = tmp();
  try {
    const {app, call} = await boot(dir);
    try {
      await call('PUT', 'settings', {developer_mode: true});
      const project = await call('POST', 'projects', {name: 'Sidecars'});
      const query = {workflow_id: project.id}; // a new project's first workflow has its id
      const made = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 10, y: 20}});
      // The code of a Script is the value of its `script` input; typing it stores it as a sidecar file.
      await call('PUT', `projects/${project.id}/input-values`, {
        ...query,
        node_id: made.id,
        values: {script: 'node.output.text = 1;'},
      });
      const scripts = path.join(dir, 'workflows', project.id + '.files', 'scripts');
      assert.equal(fs.existsSync(scripts), true, 'the script is a real sidecar file');
      const files = fs.readdirSync(scripts);
      assert.equal(files.length, 1, files.join(', '));
      assert.equal(fs.readFileSync(path.join(scripts, files[0]), 'utf8'), 'node.output.text = 1;');

      const snapshot = await call('GET', `projects/${project.id}/workflow`, undefined, query);
      const script = snapshot.nodes.find(node => node.config?.op === 'script');
      assert.ok(script, 'the graph reads back with its Script');
      const code = script.config.inputs.find(input => input.id === 'script').default;
      assert.equal(code, 'node.output.text = 1;');

      // Change the node into a value node: its code input is gone, so the sidecar file is removed.
      await call('PUT', `projects/${project.id}/typed-nodes/${script.id}`, {
        ...query,
        node_type: 'custom',
        config: {title: 'Value', inputs: [], outputs: [{id: 'result', name: 'result'}]},
      });
      assert.deepEqual(fs.readdirSync(scripts), [], 'the unused script file is deleted');
      const again = await call('GET', `projects/${project.id}/workflow`, undefined, query);
      const value = again.nodes.find(node => node.id === script.id);
      assert.equal(value.config.title, 'Value');
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('one data folder belongs to one server process; a stale lock is taken over', async () => {
  const dir = tmp();
  const first = createApiServer({dataDir: dir, token: TOKEN});
  try {
    assert.equal(exists(dir, '.server.lock'), true);
    assert.throws(() => createApiServer({dataDir: dir, token: TOKEN}), /in use by another AgentSys server/);
    // A lock whose process no longer exists is stale: the folder is taken over.
    await first.close();
    assert.equal(exists(dir, '.server.lock'), false, 'closing releases the folder');
    fs.writeFileSync(path.join(dir, '.server.lock'), JSON.stringify({pid: 999999, at: new Date().toISOString()}));
    const second = createApiServer({dataDir: dir, token: TOKEN});
    try {
      const holder = JSON.parse(read(dir, '.server.lock'));
      assert.equal(holder.pid, process.pid);
    } finally {
      await second.close();
    }
    // Sharing is possible deliberately, and is then the operator's responsibility.
    const shared = createApiServer({dataDir: dir, token: TOKEN, allowSharedData: true});
    const sharedToo = createApiServer({dataDir: dir, token: TOKEN, allowSharedData: true});
    await shared.close();
    await sharedToo.close();
  } finally {
    await first.close().catch(() => {});
    clean(dir);
  }
});

test('a deleted workflow does not leave its script folder behind', async () => {
  const dir = tmp();
  try {
    const {app, call} = await boot(dir);
    try {
      const project = await call('POST', 'projects', {name: 'Delete me'});
      const workflow = await call('POST', `projects/${project.id}/workflows`, {name: 'Second'});
      // A workflow with no nodes stores no script folder at all.
      assert.equal(exists(dir, 'workflows', `${workflow.id}.files`, 'scripts'), false);
      await call('DELETE', `projects/${project.id}/workflows/${workflow.id}`);
      assert.equal(exists(dir, 'workflows', `${workflow.id}.json`), false);
      assert.equal(exists(dir, 'workflows', `${workflow.id}.files`), false);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('records stored before versions existed read as version 1 and become conditional after one write', async () => {
  const dir = tmp();
  try {
    // A folder written by the previous release: definitions and records without a `version` field.
    fs.mkdirSync(path.join(dir, 'other'), {recursive: true});
    fs.writeFileSync(
      path.join(dir, 'other', 'collections.json'),
      JSON.stringify({legacy: {title: 'Legacy', description: '', schema: {type: 'object'}, updated: 1}})
    );
    fs.writeFileSync(
      path.join(dir, 'other', 'collection__legacy.json'),
      JSON.stringify([{id: 'r1', data: {text: 'old'}, created: 1, updated: 1}])
    );
    const {app, call} = await boot(dir);
    try {
      const list = await call('GET', 'collections/legacy/records');
      assert.equal(list.records.length, 1);
      assert.equal(list.records[0].version, 1);
      const written = await call('PUT', 'collections/legacy/records/r1', {data: {text: 'new'}}, {if_version: '1'});
      assert.equal(written.version, 2);
      await assert.rejects(
        call('PUT', 'collections/legacy/records/r1', {data: {text: 'stale'}}, {if_version: '1'}),
        error => error.code === 'conflict'
      );
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('undo history is per process: a restart keeps the document but not the history', async () => {
  const dir = tmp();
  let first;
  try {
    first = await boot(dir);
    await first.call('PUT', 'settings', {developer_mode: true});
    const project = await first.call('POST', 'projects', {name: 'Undo across restart'});
    const query = {workflow_id: project.id};
    await first.call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
    const before = await first.call('GET', `projects/${project.id}/workflow`, undefined, query);
    assert.equal(before.nodes.length, 1);
    assert.equal(before.history.undo >= 1, true, 'the edit is in the in-memory history');
    await first.app.close();
    first = null;

    const second = await boot(dir);
    try {
      const after = await second.call('GET', `projects/${project.id}/workflow`, undefined, query);
      assert.equal(after.nodes.length, 1, 'the document is durable');
      const undone = await second.call('POST', `projects/${project.id}/undo`, undefined, query);
      assert.deepEqual(undone, {undo: 0, redo: 0}, 'the history did not survive the restart');
      assert.equal((await second.call('GET', `projects/${project.id}/workflow`, undefined, query)).nodes.length, 1);
    } finally {
      await second.app.close();
    }
  } finally {
    if (first) await first.app.close().catch(() => {});
    clean(dir);
  }
});
