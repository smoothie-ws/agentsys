'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, bundleOf} = require('./harness');
const TextGraph = require('../js/storage/format');

const FORMAT = 'agentsys.plugin/1';
/** A Library catalog file: nodes carry default permissions for new instances. */
const catalog = (names, capabilities = ['graph.read', 'net.fetch:api.example.com']) =>
  JSON.stringify(
    TextGraph.encode(
      names.map(name => ({
        name,
        payload: {...bundleOf(name, {Body: {inputs: [], outputs: []}}), grants: [...capabilities, 'graph.write']},
      }))
    )
  );
/** A complete plugin package with every kind of contribution. */
function pluginPackage(over = {}, files = {}) {
  return {
    format: FORMAT,
    manifest: {
      id: 'demo',
      name: 'Demo plugin',
      version: '1.0.0',
      description: 'Shows every extension point.',
      capabilities: ['graph.read', 'net.fetch:api.example.com', 'secrets.use:llm'],
      secrets: ['llm'],
      contributes: {
        nodes: ['nodes/basic.json'],
        pages: [
          {id: 'main', title: 'Main', icon: 'chart', entry: 'ui/main.html'},
          {id: 'tools', title: 'Tools', section: 'library', entry: 'ui/tools.html'},
        ],
        tiles: [{id: 'status', title: 'Status', entry: 'ui/tile.html', height: 120}],
        commands: [
          {id: 'open', title: 'Open demo', page: 'main'},
          {id: 'projects', title: 'Open projects', path: '/projects'},
        ],
        endpoints: [{name: 'echo', methods: ['GET', 'POST'], entry: 'server/echo.js'}],
        templates: [{id: 'starter', name: 'Starter', file: 'templates/starter.json'}],
        settings: {
          fields: [
            {key: 'model', label: 'Model', type: 'select', options: ['small', 'large'], default: 'small'},
            {key: 'retries', label: 'Retries', type: 'number', min: 0, max: 5, default: 2},
            {key: 'verbose', label: 'Verbose', type: 'boolean'},
            {key: 'prompt', label: 'Prompt', type: 'textarea'},
          ],
        },
      },
      ...over,
    },
    files: {
      'nodes/basic.json': catalog(['Demo echo', 'Demo shout']),
      'ui/main.html': '<!doctype html><title>x</title><p>main</p>',
      'ui/tools.html': '<p>tools</p>',
      'ui/tile.html': '<p>tile</p>',
      'server/echo.js':
        'return {method: request.method, body: request.body, query: request.query, model: plugin.settings.model};',
      'templates/starter.json': JSON.stringify(
        TextGraph.encode({kind: 'project', name: 'Starter project', workflows: [{name: 'Main', document: {}}]})
      ),
      ...files,
    },
  };
}
const install = (app, pkg = pluginPackage(), extra = {}) => app.api('POST', 'plugins', {package: pkg, ...extra});

test('a package is validated: format, ids, files named by contributions, capabilities, engine', async () => {
  const app = createApp();
  const refuse = async (pkg, message) =>
    await assert.rejects(
      install(app, pkg),
      error => message.test(error.message) || (console.log(error.message), false)
    );
  await refuse({manifest: {}, files: {}}, /plugin package is/);
  await refuse(pluginPackage({id: 'Bad Id'}), /plugin id/);
  await refuse(pluginPackage({version: 'one'}), /version/);
  await refuse(pluginPackage({capabilities: ['everything']}), /capabilities/);
  await refuse(pluginPackage({engine: '>=3'}), /needs plugin API 3/);
  await refuse(pluginPackage({engine: '^1'}), /engine/);
  await refuse(
    pluginPackage({contributes: {pages: [{id: 'a', title: 'A', entry: 'missing.html'}]}}),
    /not a file of the package/
  );
  await refuse(pluginPackage({contributes: {pages: [{id: 'a', title: 'A', entry: 'server/echo.js'}]}}), /\.html file/);
  await refuse(pluginPackage({contributes: {nodes: ['../x.json']}}), /Invalid file path/);
  await refuse(pluginPackage({contributes: {widgets: []}}), /Unknown contribution/);
  await refuse(pluginPackage({contributes: {commands: [{id: 'c', title: 'C', page: 'nope'}]}}), /no page/);
  await refuse(pluginPackage({contributes: {commands: [{id: 'c', title: 'C'}]}}), /either "page"/);
  await refuse(
    pluginPackage({contributes: {endpoints: [{name: 'a', methods: ['TRACE'], entry: 'server/echo.js'}]}}),
    /methods/
  );
  await refuse(
    pluginPackage({
      contributes: {
        pages: [
          {id: 'a', title: 'A', entry: 'ui/main.html'},
          {id: 'a', title: 'B', entry: 'ui/main.html'},
        ],
      },
    }),
    /Two pages/
  );
  await refuse(
    pluginPackage({contributes: {settings: {fields: [{key: 'x', type: 'number', default: 'no'}]}}}),
    /must be a number/
  );
  assert.deepEqual((await app.api('GET', 'plugins')).plugins, []);
});

test('enabling seeds ordinary nodes once and plugin grants do not rewrite their defaults', async () => {
  const app = createApp();
  const made = await install(app);
  assert.equal(made.enabled, false);
  assert.equal(made.nodes, 0);
  const on = await app.api('PUT', 'plugins/demo', {enabled: true});
  assert.equal(on.nodes, 2);
  const nodes = (await app.api('GET', 'resources')).filter(r => r.id.startsWith('plugin.demo.'));
  assert.deepEqual(nodes.map(n => n.name), ['Demo echo', 'Demo shout']);
  assert.ok(nodes.every(n => n.payload.folder === 'Demo plugin' && !('plugin' in n.payload)));
  assert.ok(nodes.every(n => n.payload.grants.includes('graph.write')));
  assert.equal((await app.api('GET', 'settings')).node_folder_icons['Demo plugin'], 'plug');
  await app.api('PUT', 'plugins/demo', {grants: ['graph.read']});
  await app.api('PUT', 'plugins/demo', {enabled: false});
  assert.deepEqual(await app.api('GET', 'resources'), nodes);
  await app.api('PUT', 'plugins/demo', {enabled: true});
  assert.deepEqual(await app.api('GET', 'resources'), nodes);
});

test('grants must be capabilities the plugin declares', async () => {
  const app = createApp();
  await install(app);
  await assert.rejects(app.api('PUT', 'plugins/demo', {grants: ['graph.write']}), /declares/);
  await assert.rejects(install(app, pluginPackage(), {replace: true, grants: ['library.write']}), /declares/);
});

test('plugin nodes and groups allow normal editing, duplication, moving and deletion', async () => {
  const app = createApp();
  await install(app, pluginPackage(), {enable: true});
  const node = (await app.api('GET', 'resources')).find(r => r.name === 'Demo echo');
  const editor = await app.api('POST', 'library/node-editor', {resource_id: node.id});
  assert.equal(editor.resource_id, node.id);
  await app.api('PUT', `resources/${node.id}`, {name: 'Renamed', payload: {...node.payload, grants: ['library.read'], description: 'My changes'}});
  const copy = await app.api('POST', `library/custom-nodes/${node.id}/duplicate`, {});
  const mine = await app.api('GET', `resources/${copy.id}`);
  assert.equal(mine.payload.plugin, undefined);
  assert.equal(mine.payload.folder, 'Demo plugin');
  assert.deepEqual(mine.payload.grants, ['library.read']);
  await app.api('POST', 'library/node-folders', {action: 'create', path: 'Demo plugin', name: 'Inside'});
  await app.api('POST', `library/custom-nodes/${node.id}/move`, {folder: 'Demo plugin/Inside'});
  await app.api('POST', 'library/node-folders', {action: 'rename', path: 'Demo plugin', name: 'Mine'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Mine', icon: 'star'});
  const saved = await app.api('GET', `resources/${node.id}`);
  assert.equal(saved.payload.folder, 'Mine/Inside');
  await install(app, pluginPackage({version: '1.1.0'}), {replace: true});
  assert.deepEqual(await app.api('GET', `resources/${node.id}`), saved, 'update preserves all edits');
  await app.api('DELETE', `resources/${node.id}`);
  await app.api('PUT', 'plugins/demo', {enabled: false});
  await app.api('PUT', 'plugins/demo', {enabled: true});
  await install(app, pluginPackage({version: '1.2.0'}), {replace: true});
  await assert.rejects(app.api('GET', `resources/${node.id}`), /not found/);
  await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Mine'});
  await assert.rejects(app.api('GET', `resources/${copy.id}`), /not found/);
  const imported = await app.api('POST', 'resources', {name: 'Legacy export', payload: {...node.payload, plugin: 'demo'}});
  assert.equal(imported.payload.plugin, undefined, 'legacy ownership is ignored on import');
});

test('a catalog skips existing names and adds only new nodes on update', async () => {
  const app = createApp();
  const existing = await app.api('POST', 'resources', {
    name: 'Same name', payload: bundleOf('Same name', {Body: {inputs: [], outputs: []}}),
  });
  const first = await install(app, pluginPackage({}, {'nodes/basic.json': catalog(['Same name', 'New node'])}), {enable: true});
  assert.equal(first.nodes, 1);
  await app.api('DELETE', `resources/${existing.id}`);
  await install(app, pluginPackage({version: '1.1.0'}, {'nodes/basic.json': catalog(['Same name', 'New node', 'Another node'])}), {replace: true});
  assert.deepEqual((await app.api('GET', 'resources')).map(r => r.name), ['Another node', 'New node']);
});

test('placed copies of a plugin node survive disabling and removing the plugin', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Uses plugin'});
  await install(app, pluginPackage(), {enable: true});
  const node = (await app.api('GET', 'resources')).find(r => r.name === 'Demo echo');
  await app.api('PUT', `projects/${project.id}/available-nodes`, {resource_id: node.id, enabled: true});
  const placed = await app.api('POST', `projects/${project.id}/custom-nodes/${node.id}`, {point: {x: 0, y: 0}});
  assert.equal(placed.roots.length, 1);
  await app.api('DELETE', 'plugins/demo');
  const snapshot = await app.api('GET', `projects/${project.id}/workflow`);
  assert.equal(snapshot.complex.filter(c => c.source).length, 1, 'the copy is still on the canvas');
  assert.deepEqual((await app.api('GET', 'plugins')).plugins, []);
  assert.deepEqual(
    (await app.api('GET', 'resources')).filter(r => r.id.startsWith('plugin.demo.')).map(r => r.name),
    ['Demo echo', 'Demo shout']
  );
});

test('removing a plugin deletes its package, settings and data', async () => {
  const app = createApp();
  await install(app, pluginPackage(), {enable: true});
  await app.api('PUT', 'plugins/demo/settings', {values: {model: 'large'}});
  await app.api('PUT', 'plugins/demo/data/k', {value: 1});
  await app.api('DELETE', 'plugins/demo');
  for (const key of ['package', 'settings', 'data'])
    assert.equal(await app.eval(`DB.get('plugins/demo/${key}')`), undefined, key);
  await assert.rejects(app.api('GET', 'plugins/demo'), /not found/);
  // Installing again starts clean.
  await install(app);
  assert.deepEqual((await app.api('GET', 'plugins/demo')).settings.values.model, 'small');
  await assert.rejects(app.api('GET', 'plugins/demo/data/k'), /No such key/);
});

test('updating keeps enabled state, narrows grants to what is still declared, and refuses without replace', async () => {
  const app = createApp();
  await install(app, pluginPackage(), {enable: true, grants: ['graph.read', 'secrets.use:llm']});
  await assert.rejects(install(app), error => error.code === 'already_installed');
  const next = pluginPackage({version: '1.1.0', capabilities: ['graph.read']});
  const updated = await install(app, next, {replace: true});
  assert.equal(updated.enabled, true);
  assert.equal(updated.manifest.version, '1.1.0');
  assert.deepEqual(updated.grants, ['graph.read']);
  assert.equal((await app.api('GET', 'resources')).filter(r => r.id.startsWith('plugin.demo.')).length, 2);
});

test('settings are checked against the plugin’s declaration and merged over the defaults', async () => {
  const app = createApp();
  await install(app);
  assert.deepEqual((await app.api('GET', 'plugins/demo/settings')).values, {
    model: 'small',
    retries: 2,
    verbose: false,
    prompt: '',
  });
  const saved = await app.api('PUT', 'plugins/demo/settings', {values: {model: 'large'}});
  assert.equal(saved.values.model, 'large');
  assert.equal(saved.values.retries, 2);
  await assert.rejects(app.api('PUT', 'plugins/demo/settings', {values: {model: 'huge'}}), /one of/);
  await assert.rejects(app.api('PUT', 'plugins/demo/settings', {values: {retries: 9}}), /from 0 to 5/);
  await assert.rejects(app.api('PUT', 'plugins/demo/settings', {values: {nope: 1}}), /Unknown setting/);
  assert.equal(
    (await app.api('GET', 'plugins/demo/settings')).values.model,
    'large',
    'a refused change changes nothing'
  );
});

test('plugin data is a bounded compare-and-set store of its own', async () => {
  const app = createApp();
  await install(app);
  const first = await app.api('PUT', 'plugins/demo/data/k', {value: {a: 1}, version: 0});
  assert.equal(first.version, 1);
  await assert.rejects(app.api('PUT', 'plugins/demo/data/k', {value: 2, version: 0}), error => error.status === 409);
  assert.equal((await app.api('PUT', 'plugins/demo/data/k', {value: 2, version: 1})).version, 2);
  await app.api('PUT', 'plugins/demo/data/other', {value: 'x'});
  assert.deepEqual(
    (await app.api('GET', 'plugins/demo/data', {}, {prefix: 'k'})).map(e => e.key),
    ['k']
  );
  await assert.rejects(app.api('PUT', 'plugins/demo/data/big', {value: 'x'.repeat(600000)}), /at most/);
  await assert.rejects(app.api('GET', 'plugins/demo/data/bad key'), /state key|1 to 100/);
  assert.deepEqual(await app.api('DELETE', 'plugins/demo/data/k'), {deleted: 'k'});
  await install(app, pluginPackage({id: 'second', name: 'Second'}));
  await assert.rejects(app.api('GET', 'plugins/second/data/other'), /No such key/, 'data is private to a plugin');
});

test('the bridge passes only what the plugin declares and a person granted, and stops when disabled', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Bridge'});
  await install(app, pluginPackage(), {enable: true});
  const bridge = (method, path, body = {}, query = {}) =>
    app.api('POST', 'plugins/demo/bridge', {method, path, body, query});
  // Declared but not granted.
  await assert.rejects(bridge('GET', 'projects'), /no permission: graph\.read/);
  await app.api('PUT', 'plugins/demo', {grants: ['graph.read']});
  assert.equal((await bridge('GET', 'projects')).length >= 1, true);
  assert.equal((await bridge('GET', `projects/${project.id}`)).project.name, 'Bridge');
  // Not declared at all: writing the graph, managing plugins, secrets, the network.
  await assert.rejects(bridge('POST', `projects/${project.id}/workflows`, {name: 'W'}), /graph\.write/);
  await assert.rejects(bridge('GET', 'plugins'), /system\.admin/);
  await assert.rejects(bridge('PUT', 'plugins/demo', {enabled: false}), /system\.admin/);
  await assert.rejects(bridge('PUT', 'secrets/x', {value: 'y'}), /system\.admin/);
  await assert.rejects(bridge('POST', 'net', {url: 'https://evil.example.com/'}), /net\.fetch:evil\.example\.com/);
  await assert.rejects(
    bridge('POST', 'net', {url: 'https://api.example.com/', headers: {a: '{{secret:other}}'}}),
    /secrets\.use:other|net\.fetch:api/
  );
  // Its own data, settings and endpoints need no capability.
  await bridge('PUT', 'plugins/demo/data/n', {value: 5});
  assert.equal((await bridge('GET', 'plugins/demo/data/n')).value, 5);
  assert.equal((await bridge('GET', 'plugins/demo/settings')).values.model, 'small');
  await assert.rejects(bridge('GET', 'plugins/second/data/n'), /system\.admin|no permission/);
  const log = await app.api('GET', 'plugins/demo/log');
  assert.ok(log.some(entry => entry.kind === 'denied'));
  await app.api('PUT', 'plugins/demo', {enabled: false});
  await assert.rejects(bridge('GET', 'projects'), error => error.code === 'plugin_disabled');
});

test('what a plugin writes into the Library is quarantined like what a Script writes', async () => {
  const app = createApp();
  const caps = ['graph.read', 'library.read', 'library.write'];
  await install(app, pluginPackage({capabilities: caps}), {enable: true, grants: caps});
  const payload = {
    ...bundleOf('Written', {Body: {inputs: [], outputs: []}}),
    capabilities: ['graph.write'],
    grants: ['graph.write'],
  };
  const made = await app.api('POST', 'plugins/demo/bridge', {
    method: 'POST',
    path: 'resources',
    body: {name: 'Written', payload},
  });
  assert.deepEqual(made.payload.grants, ['graph.read']);
  assert.deepEqual((await app.api('GET', `resources/${made.id}`)).payload.grants, ['graph.read']);
});

test('an endpoint runs the plugin’s code with the request, its settings and the checked bridge', async () => {
  for (const scripts of ['inline', 'worker']) {
    const app = createApp({scripts});
    await install(app, pluginPackage(), {enable: true, grants: ['graph.read']});
    await app.api('PUT', 'plugins/demo/settings', {values: {model: 'large'}});
    const answer = await app.api('POST', 'plugins/demo/call/echo', {hello: 'world'}, {a: '1'});
    assert.deepEqual(answer, {method: 'POST', body: {hello: 'world'}, query: {a: '1'}, model: 'large'}, scripts);
    assert.equal((await app.api('GET', 'plugins/demo/call/echo')).method, 'GET');
    await assert.rejects(app.api('PUT', 'plugins/demo/call/echo', {}), error => error.status === 405);
    await assert.rejects(app.api('POST', 'plugins/demo/call/nope', {}), /no such endpoint/);
    assert.ok((await app.api('GET', 'plugins/demo/log')).some(e => e.kind === 'endpoint' && e.endpoint === 'echo'));
  }
});

test('endpoint code can use its data and the bridge, fails with its own message, and is stopped when it never ends', async () => {
  const app = createApp({scripts: 'worker'});
  const code = {
    'server/echo.js': `
      if (request.query.mode === 'data') { await plugin.data.set('n', (request.body.n ?? 0) + 1); return plugin.data.get('n'); }
      if (request.query.mode === 'read') return (await agentsys('GET', 'projects')).length;
      if (request.query.mode === 'write') return agentsys('POST', 'projects', {name: 'x'});
      if (request.query.mode === 'throw') throw new Error('custom failure');
      if (request.query.mode === 'globals') return [typeof fetch, typeof process, typeof require, typeof postMessage, typeof Date.now];
      return null;`,
  };
  await app.api('POST', 'projects', {name: 'P'});
  const pkg = pluginPackage({}, {...code, 'server/broken.js': 'return ;; }'});
  pkg.manifest.contributes.endpoints.push({name: 'broken', entry: 'server/broken.js'});
  await install(app, pkg, {enable: true, grants: ['graph.read']});
  const call = (mode, body = {}) => app.api('POST', 'plugins/demo/call/echo', body, {mode});
  assert.equal((await call('data', {n: 4})).value, 5);
  assert.equal(await call('read'), 1);
  await assert.rejects(call('write'), /graph\.write/);
  await assert.rejects(call('throw'), /custom failure/);
  await assert.rejects(app.api('POST', 'plugins/demo/call/broken', {}), /Unexpected token/);
  assert.deepEqual(await call('globals'), ['undefined', 'undefined', 'undefined', 'undefined', 'function']);
});

test('a plugin that is disabled answers no endpoint and a template cannot be used', async () => {
  const app = createApp();
  await install(app);
  await assert.rejects(app.api('POST', 'plugins/demo/call/echo', {}), error => error.code === 'plugin_disabled');
  await assert.rejects(
    app.api('POST', 'plugins/demo/templates/starter/instantiate', {}),
    error => error.code === 'plugin_disabled'
  );
});

test('a template becomes a project of its own, named as asked', async () => {
  const app = createApp();
  await install(app, pluginPackage(), {enable: true});
  const made = await app.api('POST', 'plugins/demo/templates/starter/instantiate', {name: 'My starter'});
  assert.equal(made.name, 'My starter');
  assert.equal((await app.api('GET', `projects/${made.id}`)).workflows.length, 1);
  const again = await app.api('POST', 'plugins/demo/templates/starter/instantiate', {name: 'My starter'});
  assert.equal(again.name, 'My starter 2', 'a taken name gets a number');
  await assert.rejects(app.api('POST', 'plugins/demo/templates/none/instantiate', {}), /no such template/);
});

test('plugin export is absent; UI loading returns only declared page assets', async () => {
  const app = createApp(),
    pkg = pluginPackage(
      {},
      {
        'ui/main.html': '<link href="style.css"><script src="main.js"></script>',
        'ui/style.css': 'body{}',
        'ui/main.js': 'document.body.textContent="Ready"',
      }
    );
  await install(app, pkg, {enable: true});
  await assert.rejects(app.api('GET', 'plugins/demo/export'), error => error.status === 404);
  const ui = await app.api('GET', 'plugins/demo/ui', {}, {path: 'ui/main.html'});
  assert.deepEqual(Object.keys(ui.files).sort(), ['ui/main.html', 'ui/main.js', 'ui/style.css']);
  assert.equal(ui.manifest, undefined);
  await assert.rejects(app.api('GET', 'plugins/demo/ui', {}, {path: 'server/echo.js'}), /declared/);
  assert.equal((await app.api('GET', 'plugins/demo/file', {}, {path: 'ui/main.html'})).text, pkg.files['ui/main.html']);
  await assert.rejects(app.api('GET', 'plugins/demo/file', {}, {path: '../secrets'}), /Invalid file path/);
  await app.api('PUT', 'plugins/demo', {enabled: false});
  await assert.rejects(app.api('GET', 'plugins/demo/ui', {}, {path: 'ui/main.html'}), /disabled/);
});

test('scripts cannot manage plugins or use the plugin routes', async () => {
  const app = createApp();
  assert.ok(
    await app.eval(
      `ROUTES.filter(r => r.pattern.startsWith('plugins')).every(r => [...r.methods].every(m => r.needs[m].includes('system.admin') || r.pattern.includes('plugins/{id}/')))`
    )
  );
  assert.ok(
    await app.eval(
      `ROUTES.filter(r => r.pattern.startsWith('plugins')).every(r => [...r.methods].every(m => r.needs[m].includes('system.admin')))`
    ),
    'every plugin route needs admin authority, so a Script is always refused'
  );
});

test('the API page documents the plugin routes', async () => {
  const app = createApp();
  const paths = await app.eval(`Object.keys(Backend.openapi().paths)`);
  for (const path of ['/api/plugins', '/api/plugins/{id}', '/api/plugins/{id}/bridge', '/api/plugins/{id}/call/{name}'])
    assert.ok(paths.includes(path), path);
});
