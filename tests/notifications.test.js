'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

test('notifications: post, list newest first, delete one, clear', async () => {
  const app = createApp();
  assert.deepEqual(await app.api('GET', 'notifications'), {total: 0, items: []});
  const a = await app.api('POST', 'notifications', {title: 'First', level: 'warn', href: '/projects'});
  const b = await app.api('POST', 'notifications', {title: 'Second', body: 'text', source: 'test'});
  assert.equal('read' in a, false);
  const list = await app.api('GET', 'notifications');
  assert.deepEqual(
    list.items.map(n => n.title),
    ['Second', 'First']
  );
  assert.equal(list.total, 2);
  await app.api('DELETE', `notifications/${b.id}`);
  assert.equal((await app.api('GET', 'notifications')).total, 1);
  await assert.rejects(app.api('DELETE', `notifications/${b.id}`), /not found/i);
  assert.deepEqual(await app.api('DELETE', 'notifications'), {deleted: 1});
  assert.equal((await app.api('GET', 'notifications')).total, 0);
});

test('notifications: input is checked and the list is bounded', async () => {
  const app = createApp();
  await assert.rejects(app.api('POST', 'notifications', {}), /title/);
  await assert.rejects(app.api('POST', 'notifications', {title: 'x', level: 'loud'}), /level/);
  await assert.rejects(app.api('POST', 'notifications', {title: 'x', href: 'https://evil.example'}), /href/);
  await assert.rejects(app.api('POST', 'notifications', {title: 'x', href: '//evil.example'}), /href/);
  for (let i = 0; i < 205; i++) await app.api('POST', 'notifications', {title: 'n' + i});
  const list = await app.api('GET', 'notifications', {}, {limit: 500});
  assert.equal(list.total, 200);
  assert.equal(list.items[0].title, 'n204');
});

test('notifications: a Script needs notifications.write to post and system.admin to clear', async () => {
  const app = createApp();
  const needs = method => JSON.parse(app.eval(`JSON.stringify(routeNeeds('notifications', '${method}'))`));
  assert.deepEqual(needs('GET'), ['notifications.read']);
  assert.deepEqual(needs('POST'), ['notifications.write']);
  assert.deepEqual(needs('DELETE'), ['system.admin']);
});
