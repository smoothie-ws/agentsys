// Reference Plugin C: the Generic Collections API, a plugin-drawn resource view and an update migration.
'use strict';

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);
const COLLECTION = 'structured-notes';

async function view() {
  const answer = await api.collections.records(COLLECTION, {limit: 100});
  const rows = answer.records
    .map(
      record =>
        `<tr><td>${escape(record.data.title)}</td><td>${escape(record.data.body || '')}</td><td>${record.data.done ? 'yes' : 'no'}</td><td>${escape(record.data.priority ?? 0)}</td><td class="oc-num">v${record.version}</td></tr>`
    )
    .join('');
  return `<h2>Structured notes</h2>
    <p class="muted">A resource view reads a Generic Collection through <code>api.collections</code>. Validation is
    enforced by the server, not by this page.</p>
    <dl class="page-facts"><div><dt>Records</dt><dd>${answer.total}</dd></div></dl>
    ${answer.records.length ? `<div class="oc-table"><table><thead><tr><th>Title</th><th>Body</th><th>Done</th><th>Priority</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty small"><h2>No notes yet</h2></div>'}
    <div class="button-row"><button type="button" class="primary" data-command="add-note">Add a note</button><button type="button" data-command="add-invalid">Try an invalid record</button><button type="button" data-command="race">Concurrent update</button></div>`;
}

async function settings() {
  const value = await api.settings.get();
  return `<p class="muted">Data version: <strong>${escape(String(value.schemaVersion ?? 0))}</strong></p>
    <p class="muted small">A schema change is a normal collection update; existing records are never deleted.</p>
    <button type="button" data-command="migrate">Run migration</button>`;
}

exports.activate = async pluginApi => {
  // The module receives the public API as its `api` parameter; keep a local name for the closures below.
  const api = pluginApi;
  api.ui.addResourceView({
    id: 'structured-notes',
    title: 'Structured notes',
    description: 'A custom view over the structured-notes collection.',
    collection: COLLECTION,
    icon: 'database',
    sidebar: true,
    render: () => view(),
  });
  api.ui.addSettingsSection({
    id: 'structured-data',
    title: 'Structured Data',
    description: 'Migration state of the reference collection.',
    render: () => settings(),
  });
  api.commands.register('add-note', async () => {
    const made = await api.collections.create(COLLECTION, {
      title: 'Note ' + new Date().toISOString().slice(11, 19),
      body: 'Created by Reference: Structured Data.',
      done: false,
      priority: 1,
    });
    api.ui.toast(`Created note ${made.id.slice(0, 8)}.`);
    api.ui.refresh();
    return made;
  }, {title: 'Add a note'});
  api.commands.register('add-invalid', async () => {
    try {
      await api.collections.create(COLLECTION, {body: 'no title'});
      return {unexpected: true};
    } catch (error) {
      api.ui.toast('The server refused the record: ' + error.message, true);
      return {refused: error.message};
    }
  }, {title: 'Try an invalid record'});
  api.commands.register('race', async () => {
    const list = await api.collections.records(COLLECTION, {limit: 1});
    const record = list.records[0];
    if (!record) return {skipped: 'no record'};
    const results = await Promise.allSettled([
      api.collections.update(COLLECTION, record.id, {...record.data, body: 'writer one'}, record.version),
      api.collections.update(COLLECTION, record.id, {...record.data, body: 'writer two'}, record.version),
    ]);
    const conflict = results.filter(item => item.status === 'rejected' && /conflict|version/i.test(item.reason?.message || '')).length;
    api.ui.toast(`Concurrent update: ${conflict} conflict(s) rejected.`);
    return {conflict};
  }, {title: 'Concurrent update'});
  api.commands.register('migrate', async () => {
    // The same definition with a stricter schema: existing records stay, new writes are validated against it.
    await api.collections.define(COLLECTION, {
      title: 'Structured notes',
      description: 'Notes with a title, a body, a done flag and a priority.',
      schema: {
        type: 'object',
        properties: {
          title: {type: 'string', maxLength: 200},
          body: {type: 'string', maxLength: 4000},
          done: {type: 'boolean'},
          priority: {type: 'integer', enum: [0, 1, 2, 3]},
        },
        required: ['title'],
        additionalProperties: false,
      },
    });
    const settingsValue = await api.settings.get();
    await api.settings.set({...settingsValue, schemaVersion: 2});
    api.ui.toast('Schema migrated to version 2.');
    api.ui.refresh();
    return {schemaVersion: 2};
  }, {title: 'Run migration'});
};
