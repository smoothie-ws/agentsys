'use strict';
// Exercise the real iframe host class without a browser, controlling the token-issuance suspension point.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sandbox(Environment) {
  const source = fs.readFileSync(path.join(__dirname, '../js/app/extensions.js'), 'utf8');
  const context = vm.createContext({
    Environment, AbortController, URL, clearTimeout,
    window: {removeEventListener() {}},
  });
  const start = source.indexOf('  class PluginSandbox {');
  const end = source.indexOf('  function cleanupRegistrations', start);
  const Class = vm.runInContext(source.slice(start, end) + '\nPluginSandbox', context);
  // Constructor DOM work is covered by browser_plugin_security; this fixture starts at the live request boundary.
  return Object.assign(Object.create(Class.prototype), {
    plugin: {id: 'demo'}, capabilities: ['graph.read'], token: null, requests: new AbortController(),
    dead: false, stopping: false, pending: new Map(),
    frame: {contentWindow: {postMessage() {}}, remove() {}},
  });
}

test('disabling a plugin during token issuance revokes the late token and sends no request', async () => {
  let release;
  const revoked = [], requests = [];
  const host = sandbox({
    generation: () => 1,
    pluginToken: () => new Promise(resolve => { release = resolve; }),
    revokePluginToken: token => revoked.push(token),
    request: (...args) => requests.push(args),
  });
  const work = host.sendRequest('GET', 'projects');
  host.dispose();
  release('pst_late');
  await assert.rejects(work, /not running/);
  assert.deepEqual(revoked, ['pst_late']);
  assert.deepEqual(requests, []);
  assert.equal(host.requests.signal.aborted, true);
});

test('issuance failure does not fall back to the owner session', async () => {
  let calls = 0;
  const host = sandbox({
    generation: () => 1,
    pluginToken: async () => { throw new Error('Token service unavailable'); },
    request: () => { calls++; },
  });
  await assert.rejects(host.sendRequest('POST', 'projects', {}), /Token service unavailable/);
  assert.equal(calls, 0);
});

test('an expired scoped credential renews once with the same owner and never sends an owner credential', async () => {
  const auth = [], owners = [];
  const host = sandbox({
    generation: () => 1,
    pluginToken: async (caps, options) => { owners.push(options.owner); return 'pst_new'; },
    request: async (method, route, options) => {
      auth.push(options.auth);
      if (options.auth === 'pst_old') throw Object.assign(new Error('expired'), {code: 'plugin_token_expired'});
      return {ok: true};
    },
  });
  host.token = 'pst_old';
  assert.deepEqual(await host.sendRequest('GET', 'projects'), {ok: true});
  assert.deepEqual(auth, ['pst_old', 'pst_new']);
  assert.deepEqual(owners, ['demo']);
});

test('a switch during token issuance cannot send the previous plugin operation to the new server', async () => {
  let release, generation = 1, calls = 0;
  const revoked = [];
  const host = sandbox({
    generation: () => generation,
    pluginToken: () => new Promise(resolve => { release = resolve; }),
    revokePluginToken: token => revoked.push(token),
    request: () => { calls++; },
  });
  const work = host.sendRequest('POST', 'projects', {});
  generation++;
  release('pst_old_server');
  await assert.rejects(work, /environment changed/);
  assert.equal(calls, 0);
  assert.deepEqual(revoked, ['pst_old_server']);
});

test('a delayed expired response reuses a token already renewed by another request', async () => {
  let release, issued = 0, oldRequests = 0;
  const host = sandbox({
    generation: () => 1,
    pluginToken: async () => { issued++; return 'pst_new'; },
    request: async (method, route, options) => {
      if (options.auth === 'pst_old') {
        if (++oldRequests === 2) await new Promise(resolve => { release = resolve; });
        throw Object.assign(new Error('expired'), {code: 'plugin_token_expired'});
      }
      return {ok: true};
    },
  });
  host.token = 'pst_old';
  const first = host.sendRequest('GET', 'projects');
  const second = host.sendRequest('GET', 'resources');
  await first;
  release();
  await second;
  assert.equal(issued, 1, 'the late old response must not revoke the fresh token');
});
