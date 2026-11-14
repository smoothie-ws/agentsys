'use strict';
// Server resource deployment: the plugin is a client package; its collections, Library nodes and workflow templates
// become ordinary server data. The test speaks to two independent servers and proves that a saved graph runs with
// no client and no plugin host attached.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const Manifest = require('../js/app/plugin-manifest');
const Deploy = require('../js/app/plugin-deploy');

const TOKEN = 'owner-token-deploy';
async function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-deploy-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  const base = await app.listen(0);
  const request = async (method, route, body, query) => {
    const url = new URL(base + '/api/' + route.replace(/^\/+/, ''));
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
        'X-AgentSys': '1',
      },
      body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = new Error(value?.error?.message || `HTTP ${response.status}`);
      error.code = value?.error?.code;
      error.status = response.status;
      throw error;
    }
    return value;
  };
  return {
    dir,
    base,
    request,
    async close() {
      await app.close();
      fs.rmSync(dir, {recursive: true, force: true});
    },
  };
}

function packageOf({version = '1.0.0', code = "node.display('ran without a client'); node.output.result = 'ok';", strategy} = {}) {
  return Manifest.normalizePackage({
    format: 2,
    manifest: {
      id: 'reference-library',
      name: 'Reference Library Pack',
      version,
      api: 2,
      capabilities: ['graph.read', 'graph.write', 'library.read', 'library.write', 'collections.read', 'collections.write'],
    },
    main: 'main.js',
    files: {'main.js': 'exports.activate = () => {};'},
    contributes: {
      collections: [
        {
          name: 'demo-notes',
          title: 'Demo notes',
          strategy,
          schema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']},
        },
      ],
      library: [
        {
          name: 'Runs alone',
          code,
          outputs: ['result'],
          grants: ['graph.read'],
          folder: 'Reference',
          description: 'A node the server runs without this plugin.',
        },
      ],
      workflows: [{name: 'Alone flow', project: 'Reference templates', nodes: [{library: 'Runs alone'}]}],
    },
  });
}

test('deploying a package creates server data, is idempotent, and the saved graph runs with no client', async () => {
  const one = await server();
  try {
    const record = packageOf();
    const first = await Deploy.deploy(record, {request: one.request, environment: 'one'});
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    assert.equal(first.errors.length, 0);
    assert.equal(first.summary.library, 1);
    assert.equal(first.summary.workflows, 1);

    const resources = await one.request('GET', 'resources');
    const node = resources.find(item => item.name === 'Runs alone');
    assert.ok(node, 'the Library node exists');
    assert.equal(node.payload.plugin.id, record.id);
    assert.equal(node.payload.plugin.version, '1.0.0');
    const definition = (await one.request('GET', 'collections')).find(item => item.name === 'demo-notes');
    assert.equal(definition.title, 'Demo notes');

    // User data belongs to the server, not to the deployment: a record survives a re-deploy.
    const made = await one.request('POST', 'collections/demo-notes/records', {data: {title: 'Mine'}});
    const again = await Deploy.deploy(record, {request: one.request, state: first.state, environment: 'one'});
    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(again.summary.created, 0, 'nothing was created twice: ' + JSON.stringify(again.summary));
    assert.equal((await one.request('GET', 'resources')).filter(item => item.name === 'Runs alone').length, 1);
    const records = await one.request('GET', 'collections/demo-notes/records');
    assert.equal(records.total, 1);
    assert.equal(records.records[0].id, made.id);
    assert.equal(records.records[0].data.title, 'Mine');

    // The workflow template is made of ordinary nodes: an Event and the plugin's Library node.
    const state = again.state.workflows['Alone flow'];
    assert.ok(state.project_id && state.workflow_id && state.event_id);
    const graph = await one.request('GET', `projects/${state.project_id}/workflow`, undefined, {
      workflow_id: state.workflow_id,
    });
    const event = graph.nodes.find(item => item.config?.op === 'on_run');
    assert.equal(event.id, state.event_id);
    const complex = graph.complex.find(item => item.source?.resource_id === node.id);
    assert.ok(complex, 'the Library node is placed as a complex node');
    assert.ok(
      graph.edges.some(edge => edge.source === state.event_id && edge.target === 'complex:' + complex.id),
      JSON.stringify(graph.edges)
    );
    // A second deploy must not create a second Event or a second copy of the node.
    assert.equal(graph.nodes.filter(item => item.config?.op === 'on_run').length, 1);
    assert.equal(graph.complex.length, 1);

    // This request comes from the test process, not from a browser: the server materializes the plugin's node and
    // runs its Script from saved data alone.
    const run = await one.request('POST', `projects/${state.project_id}/execution`, {wait: true}, {
      workflow_id: state.workflow_id,
    });
    assert.equal(run.dispatch_status, 'completed', JSON.stringify(run.errors));
    assert.match(Object.values(run.displays || {}).join('\n'), /ran without a client/);
    assert.equal(run.outputs?.['complex:' + complex.id]?.result, 'ok');

    // Forgetting the deployment record in the browser does not delete server data.
    const forgotten = Deploy.forget(record.id, 'one');
    assert.equal(forgotten.library && Object.keys(forgotten.library).length, 0);
    assert.equal((await one.request('GET', 'resources')).some(item => item.id === node.id), true);
    const rerun = await one.request('POST', `projects/${state.project_id}/execution`, {wait: true}, {
      workflow_id: state.workflow_id,
    });
    assert.equal(rerun.dispatch_status, 'completed');
  } finally {
    await one.close();
  }
});

test('two servers get independent resources and never share identifiers', async () => {
  const one = await server();
  const two = await server();
  try {
    const record = packageOf();
    const inOne = await Deploy.deploy(record, {request: one.request, environment: 'one'});
    const inTwo = await Deploy.deploy(record, {request: two.request, state: inOne.state, environment: 'two'});
    assert.equal(inOne.ok, true, JSON.stringify(inOne.errors));
    assert.equal(inTwo.ok, true, JSON.stringify(inTwo.errors));
    // The state from the first server names ids the second server has never seen: new data, not a cross-link.
    assert.notEqual(inOne.state.library['Runs alone'].id, inTwo.state.library['Runs alone'].id);
    assert.notEqual(inOne.state.workflows['Alone flow'].project_id, inTwo.state.workflows['Alone flow'].project_id);
    assert.equal((await one.request('GET', 'resources')).length, 1);
    assert.equal((await two.request('GET', 'resources')).length, 1);
    assert.equal((await one.request('GET', 'projects')).length, 1);
    assert.equal((await two.request('GET', 'projects')).length, 1);
    assert.equal((await two.request('GET', 'collections/demo-notes/records')).total, 0);
    await one.request('POST', 'collections/demo-notes/records', {data: {title: 'only one'}});
    assert.equal((await two.request('GET', 'collections/demo-notes/records')).total, 0);
    assert.equal(inTwo.state.environment, 'two');
  } finally {
    await one.close();
    await two.close();
  }
});

test('an update changes its own node in place and leaves user data and foreign nodes alone', async () => {
  const one = await server();
  try {
    const v1 = packageOf();
    const first = await Deploy.deploy(v1, {request: one.request, environment: 'one'});
    const id = first.state.library['Runs alone'].id;
    const made = await one.request('POST', 'collections/demo-notes/records', {data: {title: 'kept'}});

    // A user-created node with another owner is never touched by the package.
    const foreign = await one.request('POST', 'library/script-nodes', {
      name: 'User node',
      code: 'node.output.result = 1;',
      plugin: {id: 'someone-else', name: 'User node'},
    });
    const before = await one.request('GET', `resources/${foreign.id}`);
    let refused = null;
    try {
      await one.request('POST', 'library/script-nodes', {
        resource_id: foreign.id,
        name: 'User node',
        code: 'node.output.result = 3;',
        plugin: {id: v1.id, name: 'User node', version: '1.0.0'},
      });
    } catch (error) {
      refused = error;
    }
    assert.equal(refused?.status, 403, 'the server refuses to rewrite a node the plugin does not own: ' + JSON.stringify({refused, status: refused?.status, message: refused?.message}));
    assert.match(refused.message, /not owned|permission/i);

    const v2 = packageOf({version: '1.1.0', code: "node.display('version two'); node.output.result = 2;"});
    const second = await Deploy.deploy(v2, {request: one.request, state: first.state, environment: 'one'});
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.equal(second.state.library['Runs alone'].id, id, 'the Library node was updated in place');
    const after = await one.request('GET', `resources/${id}`);
    assert.equal(after.payload.plugin.version, '1.1.0');
    assert.match(JSON.stringify(after.payload), /version two/);
    assert.equal((await one.request('GET', 'collections/demo-notes/records')).records[0].id, made.id);
    assert.deepEqual(await one.request('GET', `resources/${foreign.id}`), before);

    // An older client that has the same package must not downgrade a node another client already updated.
    const older = await Deploy.deploy(v1, {request: one.request, state: second.state, environment: 'one'});
    assert.equal(older.ok, true);
    assert.equal(older.warnings.some(item => item.code === 'deployment_newer'), true, JSON.stringify(older.warnings));
    assert.equal((await one.request('GET', `resources/${id}`)).payload.plugin.version, '1.1.0');

    // A collection definition is not silently replaced by a package that asked only to create it.
    await one.request('PUT', 'collections/demo-notes', {
      title: 'Renamed by the user',
      description: 'mine',
      schema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']},
    });
    const third = await Deploy.deploy(v2, {request: one.request, state: older.state, environment: 'one'});
    assert.equal(third.ok, true);
    assert.equal(third.warnings.some(item => item.code === 'collection_exists'), true, JSON.stringify(third.warnings));
    const definition = (await one.request('GET', 'collections')).find(item => item.name === 'demo-notes');
    assert.equal(definition.title, 'Renamed by the user');
    assert.equal((await one.request('GET', 'collections/demo-notes/records')).total, 1);
  } finally {
    await one.close();
  }
});

test('the deployment refuses to run without the plugin capabilities', async () => {
  const one = await server();
  try {
    const Capabilities = require('../js/app/plugin-capabilities');
    const record = packageOf();
    record.capabilities = ['graph.read', 'library.read', 'collections.read'];
    const checked = (method, path, body) => {
      const decision = Capabilities.check(record.capabilities, method, path, body);
      if (!decision.ok) {
        const error = new Error(decision.reason);
        error.code = 'permission_denied';
        throw error;
      }
      return one.request(method, path, body);
    };
    const result = await Deploy.deploy(record, {request: checked, environment: 'one'});
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(item => /capabilit|allowed|permission/i.test(item.message)), JSON.stringify(result.errors));
    assert.equal((await one.request('GET', 'resources')).length, 0);
  } finally {
    await one.close();
  }
});
