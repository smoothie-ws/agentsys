// The page, cards and sections of the UI showcase. Modules are loaded with a tiny CommonJS loader; no bundler.
'use strict';

const labels = require('./labels.json');

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);

const shell = (title, body, hint = '') =>
  `<div class="plugin-showcase"><h2>${escape(title)}</h2>${hint ? `<p class="muted">${escape(hint)}</p>` : ''}${body}</div>`;

async function page(api, context) {
  const settings = await api.settings.get();
  const environment = await api.env.info();
  const stored = await api.storage.get('last', null);
  const projects = await api.request('GET', 'projects');
  return shell(
    'A page drawn by a sandboxed plugin',
    `<dl class="page-facts">
      <div><dt>Plugin</dt><dd>${escape(api.id)} ${escape(api.version)}</dd></div>
      <div><dt>API</dt><dd>${escape(api.api || api.version)}</dd></div>
      <div><dt>Server</dt><dd>${escape(environment.name || 'unknown')} · ${escape(environment.status || '')}</dd></div>
      <div><dt>Projects</dt><dd>${projects.length}</dd></div>
      <div><dt>Stored</dt><dd>${stored ? escape(stored.name) : 'nothing yet'}</dd></div>
    </dl>
    <p class="plugin-logo-line"><img class="plugin-logo" src="${escape(api.asset('logo'))}" alt="Plugin logo" width="16" height="16"> Bundled image from <code>assets/logo.png</code>.</p>
    <p class="muted">The page cannot touch the application DOM. It returns passive HTML, and the host draws it with
    the application's own styles. A <code>data-command</code> button calls a command of this plugin.</p>
    <p class="muted small">${escape(labels.note)}</p>
    <div class="button-row"><button type="button" class="primary" data-command="hello" data-args='[{"name":"page"}]'>Say hello</button>
    <button type="button" data-command="notify">Send a notification</button></div>
    <p class="muted small">Settings saved here: ${escape(JSON.stringify(settings))}</p>`,
    'Rendered as a plugin page at /ext/reference-ui-showcase/showcase.'
  );
}

async function card(api) {
  const stored = await api.storage.get('last', null);
  return `<p class="muted">A dashboard card from <strong>${escape(api.title)}</strong>.</p>
    <p>${stored ? `Last greeting: <strong>${escape(stored.name)}</strong>` : 'No greeting yet.'}</p>
    <button type="button" data-command="hello" data-args='[{"name":"dashboard"}]'>Greet</button>`;
}

async function settings(api) {
  const value = await api.settings.get();
  return `<dl class="page-facts">
    <div><dt>Greeting</dt><dd>${escape(value.greeting || 'Hello')}</dd></div>
    <div><dt>Notifications</dt><dd>${escape(value.notifications === false ? 'off' : 'on')}</dd></div>
  </dl>
  <p class="muted small">This section is drawn by the plugin into the application's Settings page.</p>
  <button type="button" data-command="rotate-settings">Change the greeting</button>`;
}

async function inspector(api, context) {
  const node = context?.node || null;
  return `<p class="muted">Selection: <strong>${escape(node?.name || node?.label || node?.id || 'nothing')}</strong></p>
    <p class="muted small">An inspector section receives the selected node, project and workflow as plain data.</p>
    <button type="button" data-command="hello" data-args='[{"name":"inspector"}]'>Greet</button>`;
}

module.exports = {page, card, settings, inspector};
