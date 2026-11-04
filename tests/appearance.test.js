'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

const palette = {background: '#080808', surface: '#101010', text: '#ededed', accent: '#d9d9d9'};

test('the appearance is saved and changes merge into what is stored', async () => {
  const app = createApp();
  await app.api('PUT', 'settings', {style: {...palette, font_size: 16, animations: false, wire_style: 'step'}});
  await app.api('PUT', 'settings', {style: {accent: '#82aaff'}});
  const {style} = (await app.api('GET', 'session')).preferences;
  assert.deepEqual({...style}, {...palette, accent: '#82aaff', font_size: 16, animations: false, wire_style: 'step'});
});

test('the appearance is validated: colours, font, toggles and unknown keys', async () => {
  const app = createApp();
  await app.api('PUT', 'settings', {style: palette});
  for (const style of [
    {accent: 'red'},
    {font_size: 40},
    {font_family: 'Comic Sans'},
    {effects: 'yes'},
    {components: {fields: {radius: 8}}},
  ])
    await assert.rejects(app.api('PUT', 'settings', {style}), /style|Font|colors|toggles/i);
  assert.equal((await app.api('GET', 'session')).preferences.style.accent, palette.accent);
});

test('themes and component overrides saved by an earlier version are dropped on the next save', async () => {
  const app = createApp();
  await app.eval(
    `DB.commit({prefs: {style: {accent: '#82aaff', components: {fields: {radius: 8}}}, themes: [{id: 'a', name: 'A'}], theme: 'saved:a'}})`
  );
  await app.api('PUT', 'settings', {undo_steps: 10});
  const prefs = (await app.api('GET', 'session')).preferences;
  assert.equal(prefs.themes, undefined);
  assert.equal(prefs.theme, undefined);
  assert.equal(prefs.style.components, undefined);
  assert.equal(prefs.style.accent, '#82aaff');
});
