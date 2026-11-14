'use strict';
// Architectural boundaries, enforced instead of described.
//
// The refactor split AgentSys into an API-only server, a static client and a shared model. Nothing stopped the
// two halves from drifting back together: a client file could import the server store, the server manifest could
// list a UI file, or a shared helper could reach for `document`. These tests read the sources and fail on the
// forbidden edge, so the boundary is checked on every `node --test` run.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const {FILES, SERVER_ONLY} = require('../server/manifest');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const list = dir => {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute, {recursive: true})
    .filter(name => name.endsWith('.js'))
    .map(name => `${dir}/${name.split(path.sep).join('/')}`)
    .filter(file => fs.statSync(path.join(ROOT, file)).isFile());
};

// Browser-only capabilities. `document` and `window` appear as ordinary variable names in the model, so the
// patterns name the members rather than the identifiers.
const DOM_MEMBERS =
  /\b(?:document|window)\.(?:createElement|createElementNS|createTextNode|querySelector|querySelectorAll|getElementById|getElementsBy|body|head|addEventListener|removeEventListener|currentScript|location|localStorage|sessionStorage)\b|\blocalStorage\.|\bsessionStorage\.|\bindexedDB\.|\bBroadcastChannel\b|\bnavigator\.|\bEventSource\b|\brequestAnimationFrame\b|\bmatchMedia\b/;

const CLIENT_UI_DIRS = ['js/app', 'js/pages', 'js/canvas', 'js/inspector'];
const CLIENT_UI = /^js\/(?:app|pages|canvas|inspector)\//;

const requires = source =>
  [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
const resolveRequire = (from, request) => {
  if (!request.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
  for (const candidate of [base, base + '.js', base + '/index.js'])
    if (exists(candidate) && fs.statSync(path.join(ROOT, candidate)).isFile()) return candidate;
  return null;
};

test('the server manifest is a fixed list of existing files, never client interface code', () => {
  assert.ok(FILES.length >= 20, 'the manifest lists the server runtime');
  for (const file of FILES) {
    assert.ok(exists(file), `server runtime file exists: ${file}`);
    assert.doesNotMatch(file, CLIENT_UI, `server manifest must not load interface code: ${file}`);
    assert.doesNotMatch(file, /^(?:index\.html|css\/|client-plugins\/)/, `server manifest must not load assets: ${file}`);
  }
  // Every backend module that defines routes or runtime state is in the manifest: a new file cannot be forgotten.
  const backend = list('js/backend');
  assert.deepEqual(backend.filter(file => !FILES.includes(file)), [], 'every js/backend file is part of the server runtime');
  assert.ok(FILES.includes('js/storage/db.js') && FILES.includes('js/model/executor.js'));
  // Server-only files are never sent to a browser; the shared model and the helpers are.
  for (const file of [...backend, 'js/storage/db.js', 'js/model/executor.js', 'server.js', 'headless.js', 'server/migrate.js', 'bin/agentsys-server.js', 'legacy/server-plugin-host.js'])
    assert.equal(SERVER_ONLY.test(file), true, `server-only: ${file}`);
  for (const file of [...list('js/app'), ...list('js/pages'), ...list('js/canvas'), ...list('js/inspector'), 'js/model/schema.js', 'shared/core.js', 'shared/protocol.js'])
    assert.equal(SERVER_ONLY.test(file), false, `a client file must be servable: ${file}`);
});

test('the server runtime touches no DOM, browser storage or browser-only API', () => {
  for (const file of FILES) {
    // db.js is the storage adapter: it carries the browser fallback for the legacy combined page, behind an
    // early `if (external) return;`. It is asserted below, separately.
    if (file === 'js/storage/db.js') continue;
    let source = read(file);
    // scripts.js names the browser APIs it takes away from a Script: that list is the opposite of a dependency.
    if (file === 'js/backend/scripts.js') source = source.replace(/const WORKER_BLOCKED = \[[\s\S]*?\];/, '');
    const found = DOM_MEMBERS.exec(source);
    assert.equal(found, null, `${file} must not use ${found?.[0]}`);
  }
  const db = read('js/storage/db.js');
  assert.match(db, /const ready = \(async \(\) => \{\s*if \(external\) return;/, 'the store leaves before the browser branches when the server hands it a file store');
  const guard = db.indexOf('if (external) return;');
  // The IndexedDB branch is only entered after the guard; the browser event sources are created only there too.
  assert.ok(db.indexOf('idb = await openIdb()') > guard);
  for (const browser of ['new BroadcastChannel', 'new EventSource']) {
    const at = db.indexOf(browser);
    assert.ok(at === -1 || at > guard, `${browser} is only reached without a server store`);
  }
});

test('the client entry point loads the model and the interface, never server code', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 20, 'the page loads the client program');
  for (const file of scripts) {
    assert.ok(exists(file), `loaded script exists: ${file}`);
    assert.doesNotMatch(file, /^(?:js\/backend\/|js\/storage\/db\.js$|js\/model\/executor\.js$|server\/|bin\/|legacy\/)/);
  }
  // No client interface file may be dead weight: each is loaded, and each loaded file is on disk (checked above).
  const loaded = new Set(scripts);
  const dead = [...list('js/app'), ...list('js/pages'), ...list('js/canvas'), ...list('js/inspector')].filter(
    file => !loaded.has(file)
  );
  assert.deepEqual(dead, [], 'every interface file is loaded by index.html');
  assert.match(html, /js\/app\/environments\.js/, 'the single API transport is part of the client');
});

test('client code never reaches the server store, Node or a second request path', () => {
  for (const file of [
    'index.html',
    ...list('js/app'),
    ...list('js/pages'),
    ...list('js/canvas'),
    ...list('js/inspector'),
    ...list('js/model'),
    'js/storage/format.js',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${file} runs in a browser`);
    assert.doesNotMatch(source, /\bprocess\.(?:env|argv|exit)\b/, `${file} runs in a browser`);
    assert.doesNotMatch(source, /AGENTSYS_STORE/, `${file} must not see the server store`);
    assert.doesNotMatch(source, /['"`]\/__data/, `${file} must use the environment transport, not legacy storage`);
    // A second transport would be a second set of auth and switch semantics.
    assert.doesNotMatch(source, /\bBackend\.request\b/, `${file} must call the API through Environment.request`);
  }
  const helpers = read('js/app/helpers.js');
  assert.match(helpers, /Environment\.request/, 'api() is the one transport');
});

test('Node modules import each other acyclically and never pull in the interface', () => {
  const entry = ['server.js', 'headless.js', 'shared/protocol.js', 'shared/core.js', 'server/migrate.js'];
  const queue = [...entry, ...list('server').filter(file => file !== 'server/migrate.js'), ...list('bin')];
  const seen = new Map();
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file) || !exists(file)) continue;
    const source = read(file);
    const next = requires(source).map(request => resolveRequire(file, request));
    seen.set(file, next.filter(Boolean));
    queue.push(...next.filter(Boolean));
  }
  for (const [file, dependencies] of seen)
    for (const dependency of dependencies) {
      assert.doesNotMatch(dependency, CLIENT_UI, `${file} must not require the interface module ${dependency}`);
      if (dependency.startsWith('js/')) assert.ok(FILES.includes(dependency), `${file} requires ${dependency} outside the manifest`);
    }
  // Depth-first cycle detection over the real require graph.
  const state = new Map();
  const visit = (file, trail) => {
    if (state.get(file) === 'done') return;
    assert.notEqual(state.get(file), 'open', `require cycle: ${[...trail, file].join(' -> ')}`);
    state.set(file, 'open');
    for (const dependency of seen.get(file) || []) visit(dependency, [...trail, file]);
    state.set(file, 'done');
  };
  for (const file of seen.keys()) visit(file, []);
});

test('shared modules stay environment-neutral', () => {
  for (const file of ['shared/core.js', 'shared/protocol.js']) {
    const source = read(file);
    assert.doesNotMatch(source, DOM_MEMBERS, `${file} is loaded by both halves`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${file} uses a UMD wrapper, not CommonJS internals`);
    assert.doesNotMatch(source, /\bprocess\./, `${file} runs in a browser too`);
    assert.doesNotMatch(source, /node:/, `${file} must not import Node built-ins`);
  }
  // Both wrappers export the same thing: the browser global and module.exports.
  assert.match(read('shared/protocol.js'), /module\.exports = factory\(\)/, 'protocol.js exports for Node');
  // core.js is a plain globals script: the browser gets `ApiError`/`uid`, the server vm gets them in its context.
  assert.match(read('shared/core.js'), /class ApiError extends Error/);
  assert.doesNotMatch(read('shared/core.js'), /module\.exports/);
});

test('no server address is compiled into the client beyond the documented default', () => {
  const offenders = [];
  for (const file of [...list('js/app'), ...list('js/pages'), ...list('js/canvas'), ...list('js/inspector')]) {
    const source = read(file);
    for (const match of source.matchAll(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?/g)) {
      // The default environment (used only when no server was ever chosen) is the one allowed place.
      if (file === 'js/app/environments.js' && source.slice(0, match.index).includes('const defaultURL')) continue;
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'a server address is configuration, not code');
});
