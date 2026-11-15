'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const context = vm.createContext({PluginContent: {decorate: (html, owner) => owner + ':' + html}});
  for (const file of ['shared/core.js', 'js/app/plugin-views.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const registry = vm.runInContext('new PluginViews()', context);
  const sandbox = id => ({
    plugin: {id, title: id},
    invoke: async (name, args) => JSON.stringify({name, args}),
    checkedRequest: async () => ({records: [{data: {value: 3}}], total: 1}),
  });
  return {registry, sandbox};
}

test('removing a plugin removes every projection without removing another owner', () => {
  const {registry, sandbox} = fixture();
  for (const owner of ['first', 'second']) {
    registry.add('library', {id: 'tools', hasRender: true}, sandbox(owner));
    registry.add('resource', {id: 'records', collection: 'records', sidebar: true, hasRender: true}, sandbox(owner));
    registry.add('inspector', {id: 'node', hasRender: true}, sandbox(owner));
  }
  assert.equal(registry.pages().length, 4);
  assert.equal(registry.sidebar().length, 4);
  registry.remove('first');
  assert.equal(registry.page('first', 'tools'), undefined);
  for (const projection of [registry.pages(), registry.sidebar(), registry.list()])
    assert.ok(projection.every(item => item.plugin === 'second'));
  assert.equal(registry.page('second', 'view-records').resourceView, 'records');
});

test('page names collide across contribution kinds, with owner-local names', () => {
  const {registry, sandbox} = fixture();
  registry.add('page', {id: 'view-items', hasRender: true}, sandbox('first'));
  assert.throws(() => registry.add('resource', {id: 'items', collection: 'items', hasRender: true}, sandbox('first')), /already registered/);
  registry.add('library', {id: 'view-items', hasRender: true}, sandbox('second'));
  assert.equal(registry.pages().length, 2);
  assert.throws(() => registry.add('page', {id: '../escape', hasRender: true}, sandbox('first')), /id must/);
  assert.throws(() => registry.add('resource', {id: 'items', collection: '../secret', hasRender: true}, sandbox('first')), /collection name/);
});

test('resource rendering reads through the owning checked API and decorates for that owner', async () => {
  const {registry, sandbox} = fixture();
  const owner = sandbox('first'), calls = [];
  owner.checkedRequest = async (...args) => { calls.push(args); return {records: [{data: {value: 3}}], total: 4}; };
  registry.add('resource', {id: 'items', collection: 'items', hasRender: true}, owner);
  const root = {};
  await registry.page('first', 'view-items').render(root, {route: 'items'});
  assert.equal(calls[0][0], 'GET');
  assert.equal(calls[0][1], 'collections/items/records');
  const result = JSON.parse(root.innerHTML.slice('first:'.length));
  assert.equal(result.name, 'resource:items');
  assert.deepEqual(result.args, [{collection: 'items', records: [{data: {value: 3}}], total: 4, page: {route: 'items'}}]);
  owner.checkedRequest = async () => { throw new Error('permission denied'); };
  await assert.rejects(registry.page('first', 'view-items').render({}), /permission denied/);
});

test('returned lists cannot mutate authoritative navigation metadata', () => {
  const {registry, sandbox} = fixture();
  registry.add('page', {id: 'page', nav: false, hasRender: true}, sandbox('first'));
  registry.pages()[0].title = 'changed';
  assert.equal(registry.page('first', 'page').title, 'page');
  assert.equal(registry.sidebar().length, 0);
});
