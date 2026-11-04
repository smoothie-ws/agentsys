// The Plugins page: what is installed, on or off, and a reload of the plugins folder (see plugin-host.js and docs/plugins.md).
// A plugin is a card like those of the Library; its menu turns it on or off.
'use strict';

/** Reads the list of plugins (the cards and the second panel show it). */
async function loadPlugins() {
  app.plugins = await api('plugins');
  renderSidebar();
  return app.plugins;
}

/** Stops and starts the plugins again from the folder, then shows the new list. */
const reloadPlugins = () =>
  api('plugins/reload', {method: 'POST', body: {}})
    .then(() => go('/plugins', true))
    .catch(fail);

const setPluginEnabled = (id, enabled) =>
  api(`plugins/${encodeURIComponent(id)}`, {method: 'PUT', body: {enabled}})
    .then(() => (app.route?.id ? undefined : go('/plugins', true)))
    .catch(fail);

const pluginActions = plugin =>
  plugin && [
    plugin.enabled
      ? ['Turn off', () => setPluginEnabled(plugin.id, false), {icon: 'power'}]
      : ['Turn on', () => setPluginEnabled(plugin.id, true), {icon: 'power'}],
  ];

const pluginCard = p =>
  card({
    href: '/plugins/' + encodeURIComponent(p.id),
    glyph: 'plug',
    title: p.title,
    attrs: `data-plugin="${esc(p.id)}"`,
    preview: p.error ? `<p class="form-error">${esc(p.error)}</p>` : `<span>${esc(p.description || p.id)}</span>`,
    previewClass: 'card-note',
    facts: p.error ? 'Failed' : p.running ? 'Running' : 'Off',
    menu: 'plugin:' + p.id,
    tint: p.enabled ? 'k-complex' : '',
  });

/** The form of the settings a plugin declares (see plugin-host.js). A password is never shown: only whether one is saved. */
function pluginSettingsForm(plugin) {
  const control = f => {
    const name = `name="${esc(f.key)}"`;
    if (f.type === 'boolean')
      return `<label class="check"><input type="checkbox" ${name} ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    const help = f.help ? `<small class="muted">${esc(f.help)}</small>` : '';
    if (f.type === 'textarea')
      return field(f.label, `<textarea ${name} rows="4">${esc(f.value ?? '')}</textarea>`) + help;
    if (f.type === 'select')
      return (
        field(
          f.label,
          `<select ${name}>${options(
            f.options.map(o => (typeof o === 'object' ? [o.value, o.label ?? o.value] : [o, o])),
            f.value
          )}</select>`
        ) + help
      );
    if (f.type === 'number')
      return field(f.label, `<input type="number" ${name} value="${esc(f.value ?? '')}">`) + help;
    if (f.type === 'password')
      return (
        field(
          f.label,
          `<input type="password" ${name} autocomplete="new-password" placeholder="${f.set ? 'Saved. Type to replace.' : ''}">`
        ) +
        (f.set
          ? `<button type="button" class="ghost small" data-clear="${esc(f.key)}">Clear saved ${esc(f.label.toLowerCase())}</button>`
          : '') +
        help
      );
    return field(f.label, `<input ${name} value="${esc(f.value ?? '')}">`) + help;
  };
  return `<form id="plugin-settings" class="stack">${plugin.settings.map(control).join('')}<p class="form-error" hidden></p></form>`;
}
const readPluginSettings = (form, plugin) =>
  Object.fromEntries(
    plugin.settings.map(f => {
      const input = form.elements[f.key];
      return [f.key, f.type === 'boolean' ? input.checked : f.type === 'number' ? Number(input.value) : input.value];
    })
  );

/** One plugin, laid out like an extension page: a header with its state and actions, tabs (Details, Settings, Routes) and a column of facts. */
async function pluginPage(view, route) {
  const [, plugin] = await Promise.all([loadPlugins(), api(`plugins/${encodeURIComponent(route.id)}`)]);
  if (app.route !== route) return;
  const id = encodeURIComponent(plugin.id),
    state = plugin.error ? ['failed', 'Failed'] : plugin.running ? ['running', 'Running'] : ['off', 'Off'],
    tabs = [
      ['details', 'Details'],
      ...(plugin.settings.length ? [['settings', 'Settings']] : []),
      ['routes', `Routes${plugin.routes.length ? ` (${plugin.routes.length})` : ''}`],
    ],
    first = plugin.readme ? 'details' : plugin.settings.length ? 'settings' : 'details';
  const routeList = plugin.routes.length
    ? `<ul class="plugin-routes">${plugin.routes
        .map(r => {
          const [method, ...name] = r.split(' ');
          return `<li><span class="method m-${esc(method.toLowerCase())}">${esc(method)}</span><code>/api/plugins/${esc(plugin.id)}/${esc(name.join(' '))}</code></li>`;
        })
        .join('')}</ul>`
    : '<p class="muted">This plugin answers no routes.</p>';
  view.innerHTML = `<div class="page plugin-page">
    <header class="plugin-hero">
      <div class="plugin-icon" aria-hidden="true">${icon('plug')}</div>
      <div class="plugin-hero-text">
        <h1>${esc(plugin.title)}</h1>
        ${plugin.description ? `<p class="muted">${esc(plugin.description)}</p>` : ''}
        <div class="plugin-meta"><span class="plugin-state ${state[0]}">${state[1]}</span><span class="muted small">plugins/${esc(plugin.id)}</span></div>
        <div class="plugin-hero-actions"><button type="button" class="${plugin.enabled ? '' : 'primary'}" data-plugin-toggle>${plugin.enabled ? 'Turn off' : 'Turn on'}</button><button type="button" class="ghost" data-plugin-reload>${icon('refresh')}Reload plugins</button><span id="save-slot"></span></div>
      </div>
    </header>
    ${plugin.error ? `<p class="form-error plugin-error">${esc(plugin.error)}</p>` : ''}
    <div class="plugin-body">
      <div class="plugin-main">
        <nav class="plugin-tabs" role="tablist">${tabs.map(([key, label]) => `<button type="button" role="tab" data-plugin-tab="${key}" aria-selected="${key === first}">${esc(label)}</button>`).join('')}</nav>
        <section class="plugin-panel" data-plugin-panel="details" ${first === 'details' ? '' : 'hidden'}>${plugin.readme ? `<div class="markdown">${renderMarkdown(plugin.readme)}</div>` : '<p class="muted">This plugin has no README.md.</p>'}</section>
        ${plugin.settings.length ? `<section class="plugin-panel" data-plugin-panel="settings" ${first === 'settings' ? '' : 'hidden'}>${pluginSettingsForm(plugin)}</section>` : ''}
        <section class="plugin-panel" data-plugin-panel="routes" hidden>${routeList}</section>
      </div>
      <aside class="plugin-aside">
        <h3>Information</h3>
        <dl>
          <dt>State</dt><dd>${state[1]}</dd>
          <dt>Folder</dt><dd><code>plugins/${esc(plugin.id)}</code></dd>
          <dt>Entry point</dt><dd><code>main.js</code></dd>
          <dt>Routes</dt><dd>${plugin.routes.length}</dd>
          <dt>Settings</dt><dd>${plugin.settings.length}</dd>
        </dl>
      </aside>
    </div>
  </div>`;
  for (const tab of $$('[data-plugin-tab]', view))
    tab.onclick = () => {
      for (const t of $$('[data-plugin-tab]', view)) t.setAttribute('aria-selected', String(t === tab));
      for (const panel of $$('[data-plugin-panel]', view))
        panel.hidden = panel.dataset.pluginPanel !== tab.dataset.pluginTab;
    };
  $('[data-plugin-toggle]', view).onclick = () =>
    setPluginEnabled(plugin.id, !plugin.enabled).then(() => go('/plugins/' + id, true));
  $('[data-plugin-reload]', view).onclick = () =>
    api('plugins/reload', {method: 'POST', body: {}})
      .then(() => go('/plugins/' + id, true))
      .catch(fail);
  const form = $('#plugin-settings', view);
  if (!form) return;
  const url = `plugins/${id}/settings`;
  pageAutosave(
    form,
    () => readPluginSettings(form, plugin),
    async values => {
      await api(url, {method: 'PUT', body: {values}});
      for (const f of plugin.settings) if (f.type === 'password') form.elements[f.key].value = ''; // the key stays on the server
    }
  );
  for (const button of $$('[data-clear]', form))
    button.onclick = () =>
      api(url, {method: 'PUT', body: {values: {[button.dataset.clear]: null}}})
        .then(() => go('/plugins/' + id, true))
        .catch(fail);
}

PAGES.plugins = async (view, route) => {
  if (route.id) return pluginPage(view, route).catch(error => notFoundPlugin(view, error));
  await loadPlugins();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({
    title: 'Plugins',
    sub: 'Folders in plugins/ with a main.js. They run on the server with full access.',
    menu: 'section:plugins',
  })}${
    app.plugins.length
      ? `<div class="cards">${app.plugins.map(pluginCard).join('')}</div>`
      : '<div class="empty small"><h2>No plugins</h2><p class="muted">Put a folder with a main.js into plugins/ and choose Reload plugins in the menu.</p></div>'
  }</div>`;
};

const notFoundPlugin = (view, error) => {
  view.innerHTML = `<div class="page"><div class="empty"><h2>Plugin not found</h2><p class="muted">${esc(error.message)}</p><p><a href="/plugins" data-link>Back to Plugins</a></p></div></div>`;
};
