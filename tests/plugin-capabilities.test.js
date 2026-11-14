'use strict';
// The client plugin capability layer: what a package may ask the server to do, and what a package without a
// declaration may do (read only). The rules live in js/app/plugin-capabilities.js so the host and these tests agree.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const Capabilities = require('../js/app/plugin-capabilities');

const check = (caps, method, route, body) => Capabilities.check(caps, method, route, body);
const allowed = (caps, method, route, body) => check(caps, method, route, body).ok;
const WRITER = ['graph.read', 'graph.write', 'library.read', 'library.write'];

test('an undeclared plugin is read-only and cannot write anything', () => {
  const caps = Capabilities.forPlugin({id: 'x'});
  assert.deepEqual([...caps].sort(), [...Capabilities.READ_ONLY].sort());
  assert.equal(allowed(caps, 'GET', 'projects'), true);
  assert.equal(allowed(caps, 'GET', 'projects/p1/workflow'), true);
  assert.equal(allowed(caps, 'GET', 'library/sections'), true);
  assert.equal(allowed(caps, 'GET', 'collections/providers/records'), true);
  assert.equal(allowed(caps, 'GET', 'projects/p1/execution'), true);
  for (const [method, route] of [
    ['POST', 'projects'],
    ['PUT', 'projects/p1/workflow'],
    ['POST', 'projects/p1/execution'],
    ['POST', 'library/script-nodes'],
    ['PUT', 'collections/providers'],
    ['POST', 'notifications'],
    ['PUT', 'settings'],
    ['PUT', 'ui-state'],
  ]) {
    const decision = check(caps, method, route);
    assert.equal(decision.ok, false, `${method} ${route} is a write`);
    assert.match(decision.reason, /needs /);
    assert.ok(decision.needs.length);
  }
});

test('a declared capability allows exactly its family of calls', () => {
  assert.equal(allowed(WRITER, 'POST', 'library/script-nodes'), true);
  assert.equal(allowed(WRITER, 'POST', 'projects'), true);
  assert.equal(allowed(['collections.write'], 'POST', 'collections/providers/records', {data: {}}), true);
  assert.equal(allowed(['collections.write'], 'PUT', 'collections/providers'), true);
  assert.equal(allowed(['collections.read'], 'PUT', 'collections/providers'), false);
  assert.equal(allowed(['run.start'], 'POST', 'projects/p1/execution'), true);
  assert.equal(allowed(['run.start'], 'DELETE', 'projects/p1/execution'), true);
  assert.equal(allowed(['run.read'], 'POST', 'projects/p1/execution'), false);
  assert.equal(allowed(['notifications.write'], 'POST', 'notifications'), true);
  assert.equal(allowed(['notifications.read'], 'DELETE', 'notifications/n1'), false);
  assert.equal(allowed(['settings.write'], 'PUT', 'settings'), true);
  assert.equal(allowed(['settings.write'], 'PUT', 'ui-state'), true);
  assert.equal(allowed(['settings.read'], 'GET', 'migration/ui-state'), true);
  // A capability of one family never reaches another family.
  assert.equal(allowed(['library.write'], 'POST', 'projects'), false);
  assert.equal(allowed(['graph.write'], 'POST', 'library/script-nodes'), false);
});

test('secrets are named one by one; no wildcard secret capability exists', () => {
  assert.equal(allowed(['secrets.use:openai'], 'GET', 'secrets/openai'), true);
  assert.equal(allowed(['secrets.use:openai'], 'GET', 'secrets/anthropic'), false);
  assert.equal(allowed(['secrets.use:openai'], 'PUT', 'secrets/openai', {value: 'sk-x'}), true);
  assert.equal(allowed([], 'GET', 'secrets/openai'), false);
  assert.throws(() => Capabilities.normalize(['secrets.use:*']), /Unknown plugin capability/);
  assert.equal(allowed(Capabilities.forPlugin({id: 'x'}), 'GET', 'secrets/openai'), false);
});

test('net requests need the host they reach, and secrets they inject', () => {
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'https://api.example.com/v1'}), true);
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'https://evil.example.com/v1'}), false);
  assert.equal(allowed(['net.fetch:*.example.com'], 'POST', 'net', {url: 'https://api.example.com/v1'}), true);
  assert.equal(allowed(['net.fetch:*.example.com'], 'POST', 'net', {url: 'https://example.com.evil.test/'}), false);
  assert.equal(
    allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'https://api.example.com', headers: {Authorization: '{{secret:openai}}'}}),
    false,
    'injecting a secret needs its own capability'
  );
  assert.equal(
    allowed(
      ['net.fetch:api.example.com', 'secrets.use:openai'],
      'POST',
      'net',
      {url: 'https://api.example.com', headers: {Authorization: '{{secret:openai}}'}}
    ),
    true
  );
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'file:///etc/passwd'}), false);
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {}), false);
});

test('paths no plugin may use are refused whatever it declares', () => {
  const everything = ['graph.read', 'graph.write', 'library.read', 'library.write', 'collections.read', 'collections.write', 'run.read', 'run.start', 'notifications.read', 'notifications.write', 'settings.read', 'settings.write'];
  for (const route of ['auth/session', 'auth/logout', 'plugins', 'unknown/family']) {
    const decision = check(everything, 'POST', route);
    assert.equal(decision.ok, false, route);
    assert.match(decision.reason, /cannot|does not expose/);
  }
  // Discovery is public: a plugin may prove the connection without a capability.
  for (const route of ['meta', 'session', 'diagnostics', 'openapi.json'])
    assert.equal(allowed([], 'GET', route), true, route);
});

test('capability lists are validated and de-duplicated', () => {
  assert.deepEqual(Capabilities.normalize(['graph.read', 'graph.read']), ['graph.read']);
  assert.throws(() => Capabilities.normalize(['graph.admin']), /Unknown plugin capability/);
  assert.throws(() => Capabilities.normalize('graph.read'), /must be a list/);
  assert.throws(() => Capabilities.normalize(Array(51).fill('graph.read')), /at most 50/);
  assert.deepEqual(Capabilities.normalize(undefined), Capabilities.READ_ONLY);
});

test('the host checks the call it sends, not the label the plugin puts on it', () => {
  // A plugin that lies about the method in its own API still cannot write.
  const caps = Capabilities.forPlugin({id: 'x', capabilities: ['graph.read']});
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(allowed(caps, method, 'projects/p1/workflow'), false, method);
    assert.equal(allowed(caps, method.toLowerCase(), 'projects/p1/workflow'), false, method.toLowerCase());
  }
});

test('the shipped packages declare exactly what they use', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'client-plugins', 'index.json'), 'utf8'));
  for (const plugin of catalog) {
    const caps = Capabilities.normalize(plugin.capabilities);
    // The declared source only calls routes its capabilities cover: read what it requests.
    for (const match of plugin.source.matchAll(/api\.request\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)) {
      const decision = check(caps, match[1], match[2]);
      assert.equal(decision.ok, true, `${plugin.id} calls ${match[1]} ${match[2]}: ${decision.reason}`);
    }
    assert.equal(Capabilities.forPlugin(plugin).length, caps.length);
  }
});
