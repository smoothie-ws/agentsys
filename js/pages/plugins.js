// Client plugins: packages installed in this browser, run in a sandboxed iframe (js/app/extensions.js).
// The server does not load plugins; a plugin can create ordinary Library nodes through the API, and those keep
// running when the plugin or the client is gone.
'use strict';

async function loadPlugins() {
  await PluginStore.load();
  app.plugins = PluginStore.list();
  if (typeof Extensions !== 'undefined') await Extensions.sync(app.plugins);
  renderSidebar();
  return app.plugins;
}

const reloadPlugins = async () => {
  app.plugins = PluginStore.list();
  if (typeof Extensions !== 'undefined') await Extensions.reload(app.plugins);
  return app.plugins;
};

const setPluginEnabled = async (id, enabled) => {
  PluginStore.setEnabled(id, enabled);
  return reloadPlugins().then(() => (app.route?.id ? undefined : go('/plugins', true)));
};

const pluginActions = plugin =>
  plugin && [
    plugin.enabled
      ? ['Turn off', () => setPluginEnabled(plugin.id, false).catch(fail), {icon: 'power'}]
      : ['Turn on', () => setPluginEnabled(plugin.id, true).catch(fail), {icon: 'power'}],
    null,
    ['Remove plugin…', () => removePlugin(plugin).catch(fail), {icon: 'x', danger: true}],
  ];

function removePlugin(plugin) {
  confirmDialog(
    'Remove client plugin?',
    `"${plugin.title}" and the values it stored in this browser are removed. Library nodes it created on the server stay and keep running.`,
    () => {
      PluginStore.clear(plugin.id);
      PluginStore.remove(plugin.id);
      return reloadPlugins().then(() => {
        toast('Plugin removed. Its server resources are unchanged.');
        return go('/plugins', true);
      });
    },
    'Remove'
  );
}

const pluginCard = p => {
  const uiError = typeof Extensions === 'undefined' ? '' : Extensions.errorOf(p.id);
  return card({
    href: '/plugins/' + encodeURIComponent(p.id),
    glyph: p.icon || 'plug',
    title: p.title,
    attrs: `data-plugin="${esc(p.id)}" title="${esc(p.description || p.id)}"`,
    preview: uiError
      ? `<p class="form-error">${esc(uiError)}</p>`
      : `<code>${esc(p.id)}</code>`,
    previewClass: 'card-note',
    facts: uiError ? 'Interface failed' : p.enabled ? 'Running · sandboxed' : 'Off',
    menu: 'plugin:' + p.id,
    tint: p.enabled ? 'k-complex' : '',
  });
};

/** What a plugin's sandbox put into the interface while it is running. */
function pluginInterface(plugin) {
  if (!plugin.enabled)
    return '<p class="muted">The plugin is off: its interface is not loaded.</p>';
  if (typeof Extensions === 'undefined') return '<p class="muted">The interface host is not available.</p>';
  const ui = Extensions.describe(plugin.id);
  const list = (items, empty) =>
    items.length ? `<ul class="plugin-contributions">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
  return `${ui.error ? `<p class="form-error plugin-error">${esc(ui.error)}</p>` : ''}
    <dl class="page-facts">
      <div><dt>Pages</dt><dd>${ui.pages.length}</dd></div>
      <div><dt>Commands</dt><dd>${ui.commands.length}</dd></div>
      <div><dt>Toolbar</dt><dd>${ui.toolbar.length}</dd></div>
      <div><dt>Menus</dt><dd>${ui.menu.length}</dd></div>
      <div><dt>Styles</dt><dd>${ui.styles}</dd></div>
    </dl>
    ${
      ui.pages.length
        ? `<h3>Pages</h3><ul class="plugin-contributions">${ui.pages
            .map(page => `<li><a href="${esc(page.href)}" data-link>${esc(page.title)}</a></li>`)
            .join('')}</ul>`
        : ''
    }
    ${ui.commands.length ? `<h3>Commands</h3>${list(ui.commands, 'No commands.')}` : ''}
    ${ui.menu.length ? `<h3>Menus</h3>${list(ui.menu, 'No menu items.')}` : ''}
    ${ui.home.length ? `<h3>Dashboard</h3>${list(ui.home, 'No cards.')}` : ''}`;
}

function pluginEditor(plugin = {}) {
  return `<form id="plugin-editor" class="stack">
    ${field('Id', `<input name="id" required value="${esc(plugin.id || '')}" ${plugin.id ? 'readonly' : ''} placeholder="my-plugin" autocomplete="off">`)}
    ${field('Title', `<input name="title" required maxlength="120" value="${esc(plugin.title || '')}" placeholder="My plugin">`)}
    ${field('Description', `<textarea name="description" rows="2" maxlength="2000">${esc(plugin.description || '')}</textarea>`)}
    ${field('Icon', `<input name="icon" value="${esc(plugin.icon || 'plug')}" placeholder="plug">`)}
    ${field('Source', `<textarea name="source" rows="16" spellcheck="false" required placeholder="exports.activate = async api => { ... }">${esc(plugin.source || '')}</textarea>`)}
    <p class="muted small">The plugin runs in a sandboxed iframe. It reaches the server only through <code>api.request</code>, and it never receives the server token.</p>
    <p class="form-error" data-form-error hidden></p>
  </form>`;
}

function installPluginDialog() {
  dialog(
    'Install client plugin',
    `${pluginEditor()}<p class="muted small">You can also import a <code>.json</code> package with the same fields.</p><div class="button-row"><button type="button" data-plugin-import>Import JSON file…</button></div>`,
    async form => {
      try {
        const plugin = PluginStore.install({
          id: form.elements.id.value,
          title: form.elements.title.value,
          description: form.elements.description.value,
          icon: form.elements.icon.value,
          source: form.elements.source.value,
        });
        await reloadPlugins();
        toast('Plugin installed in this browser.');
        await go('/plugins/' + encodeURIComponent(plugin.id));
      } catch (error) {
        const output = $('[data-form-error]', form);
        output.hidden = false;
        output.textContent = error.message;
        return false;
      }
    },
    'Install'
  );
  $('[data-plugin-import]', $('#modal'))?.addEventListener('click', async () => {
    const [file] = await pickFiles({multiple: false});
    if (!file) return;
    try {
      const packet = JSON.parse(await file.text());
      const plugin = PluginStore.install(packet);
      await reloadPlugins();
      $('#modal').close();
      toast('Plugin installed in this browser.');
      await go('/plugins/' + encodeURIComponent(plugin.id));
    } catch (error) {
      fail(error);
    }
  });
}

async function pluginPage(view, route) {
  await loadPlugins();
  const plugin = PluginStore.get(route.id);
  if (!plugin) throw new ApiError('not_found', 'Plugin not found', 404);
  if (app.route !== route) return;
  const uiError = Extensions.errorOf(plugin.id);
  const state = uiError ? ['failed', 'Interface failed'] : plugin.enabled ? ['running', 'Running'] : ['off', 'Off'];
  view.innerHTML = `<div class="page form-page plugin-page">
    ${pageHead({title: esc(plugin.title), glyph: plugin.icon || 'plug', sub: esc(plugin.description || ''), menu: '', actions: `<button type="button" class="${plugin.enabled ? '' : 'primary'}" data-plugin-toggle>${plugin.enabled ? 'Turn off' : 'Turn on'}</button><button type="button" class="icon" data-plugin-reload title="Reload plugins" aria-label="Reload plugins">${icon('refresh')}</button>`})}
    ${uiError ? `<p class="form-error plugin-error">${esc(uiError)}</p>` : ''}
    <section><h2>Information</h2><dl class="page-facts">
      <div><dt>State</dt><dd><span class="plugin-state ${state[0]}">${state[1]}</span></dd></div>
      <div><dt>Version</dt><dd>${esc(plugin.version)}</dd></div>
      <div><dt>Runs in</dt><dd>This browser · sandboxed iframe</dd></div>
      <div><dt>Source</dt><dd>${plugin.builtin ? 'Bundled with the client' : 'Installed here'}</dd></div>
    </dl></section>
    <section><h2>Interface</h2>${pluginInterface(plugin)}</section>
    <section><h2>Package</h2>${pluginEditor(plugin)}<div class="button-row"><button type="button" data-plugin-save>Save changes</button><button type="button" data-plugin-export>Export JSON</button></div></section>
    <section><h2>What the server sees</h2>
      <p class="muted">The server never loads this plugin. Anything it creates through the API — a Library node, a workflow, a collection record — is ordinary server data and keeps working when this client is closed. A plugin is a convenience for editing and running those resources, not a requirement for them.</p>
    </section>
  </div>`;
  $('[data-plugin-toggle]', view).onclick = () =>
    setPluginEnabled(plugin.id, !plugin.enabled).then(() => go('/plugins/' + encodeURIComponent(plugin.id), true)).catch(fail);
  $('[data-plugin-reload]', view).onclick = () => reloadPlugins().then(() => go('/plugins', true)).catch(fail);
  $('[data-plugin-save]', view).onclick = () => {
    const form = $('#plugin-editor', view);
    try {
      PluginStore.install({
        ...plugin,
        title: form.elements.title.value,
        description: form.elements.description.value,
        icon: form.elements.icon.value,
        source: form.elements.source.value,
      });
      return reloadPlugins().then(() => {
        toast('Plugin saved.');
        return go('/plugins/' + encodeURIComponent(plugin.id), true);
      });
    } catch (error) {
      fail(error);
    }
  };
  $('[data-plugin-export]', view).onclick = () => {
    downloadJSON({...PluginStore.get(plugin.id)}, plugin.id);
  };
}

PAGES.plugins = async (view, route) => {
  if (route.id) return pluginPage(view, route).catch(error => notFoundPlugin(view, error));
  await loadPlugins();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({
    title: 'Plugins',
    sub: 'Client-side extensions installed in this browser. They extend this interface; the server never loads them.',
    menu: '',
    actions: `<button type="button" class="primary" data-plugin-install>${icon('plus')}<span>Install plugin</span></button>`,
  })}<div class="callout"><p>Plugins run in a sandboxed iframe and use the ordinary server API. A Library node a plugin creates is saved on the server and keeps running without the plugin or this client.</p></div>${
    app.plugins.length
      ? `<div class="cards">${app.plugins.map(pluginCard).join('')}</div>`
      : '<div class="empty small"><h2>No client plugins</h2><p>Install a JSON package or write one here.</p></div>'
  }</div>`;
  $('[data-plugin-install]', view).onclick = installPluginDialog;
};

const notFoundPlugin = (view, error) => {
  view.innerHTML = `<div class="page">${pageHead({title: 'Plugin not found', sub: esc(error.message), menu: ''})}<p><a class="button" href="/plugins" data-link>Back to Plugins</a></p></div>`;
};
