// Client plugins: packages installed in this browser, run in a sandboxed iframe (js/app/extensions.js).
// The server does not load plugins. Installing a package changes this browser; deploying its declared resources
// changes one server through the plugin's own capabilities. Server resources keep working without either.
'use strict';

async function loadPlugins({reload = false} = {}) {
  await PluginStore.load();
  app.plugins = PluginStore.list();
  if (typeof Extensions !== 'undefined') {
    if (reload) await Extensions.reload(app.plugins);
    else await Extensions.sync(app.plugins);
  }
  renderSidebar();
  return app.plugins;
}

const reloadPlugins = async () => {
  app.plugins = PluginStore.list();
  if (typeof Extensions !== 'undefined') await Extensions.reload(app.plugins);
  return app.plugins;
};

const setPluginEnabled = async (id, enabled) => {
  if (enabled) await Extensions.enable(id);
  else await Extensions.disable(id);
  app.plugins = PluginStore.list();
  return app.route?.id ? undefined : go('/plugins', true);
};

const dependencyText = plugin => {
  const entries = Object.entries(plugin.dependencies || {});
  return entries.length ? entries.map(([id, range]) => `${id} ${range}`).join(', ') : 'none';
};

const pluginActions = plugin =>
  plugin && [
    plugin.enabled
      ? ['Turn off', () => setPluginEnabled(plugin.id, false).catch(fail), {icon: 'power'}]
      : ['Turn on', () => setPluginEnabled(plugin.id, true).catch(fail), {icon: 'power'}],
    ['Reload', () => reloadPlugins().then(() => (app.route?.id ? render() : go('/plugins', true))).catch(fail), {icon: 'refresh'}],
    ...(Extensions.errorOf(plugin.id) || Extensions.isFailed(plugin.id)
      ? [['Try again', () => Extensions.recover(plugin.id).then(() => render()).catch(fail), {icon: 'refresh'}]]
      : []),
    null,
    ['Export package…', () => exportPlugin(plugin.id), {icon: 'upload'}],
    ['Remove plugin…', () => removePlugin(plugin), {icon: 'x', danger: true}],
  ];

function removePlugin(plugin) {
  confirmDialog(
    'Remove client plugin?',
    `"${plugin.title}" and the values it stored in this browser are removed. Library nodes, collections and workflows it deployed on the server stay and keep running.`,
    async () => {
      await Extensions.uninstall(plugin.id);
      await reloadPlugins();
      toast('Plugin removed. Its server resources are unchanged.');
      await go('/plugins', true);
    },
    'Remove'
  );
}

const pluginCard = p => {
  const uiError = typeof Extensions === 'undefined' ? '' : Extensions.errorOf(p.id);
  const deps = Object.keys(p.dependencies || {}).length;
  return card({
    href: '/plugins/' + encodeURIComponent(p.id),
    glyph: p.icon || 'plug',
    title: p.title,
    attrs: `data-plugin="${esc(p.id)}" title="${esc(p.description || p.id)}"`,
    preview: uiError
      ? `<p class="form-error">${esc(uiError)}</p>`
      : `<code>${esc(p.id)}</code><br><span class="muted small">v${esc(p.version)} · API ${p.api}${deps ? ` · ${deps} dependenc${deps === 1 ? 'y' : 'ies'}` : ''}</span>`,
    previewClass: 'card-note',
    facts: uiError ? 'Interface failed' : p.enabled ? 'Running · sandboxed' : 'Off',
    menu: 'plugin:' + p.id,
    tint: p.enabled ? 'k-complex' : '',
  });
};

/** The capabilities field is a comma separated list; empty means the read-only default. */
const readCapabilities = form => {
  const values = String(form.elements.capabilities?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
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
      <div><dt>Settings</dt><dd>${ui.settings.length}</dd></div>
      <div><dt>Library</dt><dd>${ui.library.length}</dd></div>
      <div><dt>Inspector</dt><dd>${ui.inspector.length}</dd></div>
      <div><dt>Views</dt><dd>${ui.views.length}</dd></div>
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
    ${ui.home.length ? `<h3>Dashboard</h3>${list(ui.home, 'No cards.')}` : ''}
    ${ui.settings.length ? `<h3>Settings sections</h3>${list(ui.settings, '')}` : ''}
    ${ui.library.length ? `<h3>Library sections</h3>${list(ui.library, '')}` : ''}
    ${ui.inspector.length ? `<h3>Inspector sections</h3>${list(ui.inspector, '')}` : ''}
    ${ui.views.length ? `<h3>Resource views</h3>${list(ui.views, '')}` : ''}`;
}

function pluginEditor(plugin = {}) {
  return `<form id="plugin-editor" class="stack">
    ${field('Id', `<input name="id" required value="${esc(plugin.id || '')}" ${plugin.id ? 'readonly' : ''} placeholder="my-plugin" autocomplete="off">`)}
    ${field('Title', `<input name="title" required maxlength="120" value="${esc(plugin.title || '')}" placeholder="My plugin">`)}
    ${field('Version', `<input name="version" required value="${esc(plugin.version || '1.0.0')}" placeholder="1.0.0" autocomplete="off">`)}
    ${field('Description', `<textarea name="description" rows="2" maxlength="2000">${esc(plugin.description || '')}</textarea>`)}
    ${field('Icon', `<input name="icon" value="${esc(plugin.icon || 'plug')}" placeholder="plug">`)}
    ${field('Source', `<textarea name="source" rows="16" spellcheck="false" required placeholder="exports.activate = async api => { ... }">${esc(plugin.source || '')}</textarea>`)}
    ${field('Server capabilities', `<input name="capabilities" value="${esc((plugin.capabilities || []).join(', '))}" placeholder="graph.read, library.write" autocomplete="off" spellcheck="false"><span class="field-help">Comma separated. Leave empty for read-only access. Writes, runs, secrets and network hosts must each be named: <code>graph.write</code>, <code>run.start</code>, <code>collections.write</code>, <code>secrets.use:my-key</code>, <code>net.fetch:api.example.com</code>.</span>`)}
    <p class="muted small">The plugin runs in a sandboxed iframe. It reaches the server only through <code>api.request</code>, and it never receives the server token or a secret value.</p>
    <p class="form-error" data-form-error hidden></p>
  </form>`;
}

function installPluginDialog() {
  dialog(
    'Install client plugin',
    `${pluginEditor()}<p class="muted small">You can also import a <code>.json</code> package with the same fields, or an exported format 2 package with modules and contributions.</p><div class="button-row"><button type="button" data-plugin-import>Import JSON file…</button></div>`,
    async form => {
      try {
        const plugin = await Extensions.install({
          id: form.elements.id.value,
          title: form.elements.title.value,
          version: form.elements.version.value,
          description: form.elements.description.value,
          icon: form.elements.icon.value,
          source: form.elements.source.value,
          capabilities: readCapabilities(form),
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
      const plugin = await Extensions.install(packet);
      await reloadPlugins();
      $('#modal').close();
      toast('Plugin installed in this browser.');
      await go('/plugins/' + encodeURIComponent(plugin.id));
    } catch (error) {
      fail(error);
    }
  });
}

function exportPlugin(id) {
  const plugin = PluginStore.get(id);
  if (!plugin) return;
  downloadJSON(PluginStore.export(id), `${plugin.id}-${plugin.version}.agentsys-plugin`);
}

function updatePluginDialog(plugin) {
  dialog(
    'Update plugin package',
    `<p class="muted">Install a newer package with the id <code>${esc(plugin.id)}</code>. The update keeps the plugin's stored data and its enabled state. If the new package cannot start, the previous one is restored.</p>
     <div class="button-row"><button type="button" data-plugin-update-file>Choose package file…</button></div>
     <p class="form-error" data-form-error hidden></p>`,
    null,
    'Close'
  );
  $('[data-plugin-update-file]', $('#modal'))?.addEventListener('click', async () => {
    const [file] = await pickFiles({multiple: false});
    if (!file) return;
    try {
      const packet = JSON.parse(await file.text());
      if ((packet.manifest?.id || packet.id) !== plugin.id)
        throw new Error(`This package is for ${packet.manifest?.id || packet.id}, not ${plugin.id}.`);
      const updated = await Extensions.update(plugin.id, packet);
      await reloadPlugins();
      $('#modal').close();
      toast(`Updated to ${updated.version}.`);
      await render();
    } catch (error) {
      const output = $('[data-form-error]', $('#modal'));
      if (output) {
        output.hidden = false;
        output.textContent = error.message;
      } else fail(error);
    }
  });
}

async function deployPlugin(plugin) {
  if (!plugin.enabled) {
    toast('Turn the plugin on before deploying its resources.', true);
    return;
  }
  const result = await Extensions.deploy(plugin.id);
  await Promise.all([loadLibrary().catch(() => {}), loadProjects().catch(() => {})]);
  if (!result.ok) {
    const warning = result.warnings?.[0]?.message;
    fail(new Error(result.errors[0]?.message + (warning ? ' ' + warning : '')));
  } else {
    toast(
      `Deployed ${result.summary.library} Library node(s), ${result.summary.collections} collection(s), ${result.summary.workflows} workflow template(s).`
    );
  }
  await render();
}

async function pluginPage(view, route) {
  await loadPlugins();
  const plugin = PluginStore.get(route.id);
  if (!plugin) throw new ApiError('not_found', 'Plugin not found', 404);
  if (app.route !== route) return;
  const uiError = Extensions.errorOf(plugin.id);
  const state = uiError ? ['failed', 'Interface failed'] : plugin.enabled ? ['running', 'Running'] : ['off', 'Off'];
  const dependencies = PluginStore.dependencyState(plugin.id);
  const deployment = Extensions.deploymentOf(plugin.id);
  const contributes = plugin.contributes || {collections: [], library: [], workflows: []};
  const declared = contributes.collections.length + contributes.library.length + contributes.workflows.length;
  view.innerHTML = `<div class="page form-page plugin-page">
    ${pageHead({title: esc(plugin.title), glyph: plugin.icon || 'plug', sub: esc(plugin.description || ''), actions: `<button type="button" class="${plugin.enabled ? '' : 'primary'}" data-plugin-toggle>${plugin.enabled ? 'Turn off' : 'Turn on'}</button><button type="button" class="icon" data-plugin-reload title="Reload plugins" aria-label="Reload plugins">${icon('refresh')}</button>`})}
    ${uiError ? `<p class="form-error plugin-error">${esc(uiError)}</p><p><button type="button" data-plugin-recover>Try again</button></p>` : ''}
    ${dependencies.ok ? '' : `<p class="form-error plugin-error">${esc(dependencies.errors.map(item => item.message).join(' '))}</p>`}
    <section><h2>Information</h2><dl class="page-facts">
      <div><dt>State</dt><dd><span class="plugin-state ${state[0]}">${state[1]}</span></dd></div>
      <div><dt>Version</dt><dd>${esc(plugin.version)}</dd></div>
      <div><dt>Plugin API</dt><dd>${plugin.api}</dd></div>
      <div><dt>Package</dt><dd>Format ${plugin.formatVersion}${plugin.hasModules ? ' · modules' : ''}${plugin.assetCount ? ` · ${plugin.assetCount} asset(s)` : ''}</dd></div>
      <div><dt>Runs in</dt><dd>This browser · sandboxed iframe</dd></div>
      <div><dt>Server access</dt><dd>${esc(typeof PluginCapabilities === 'undefined' ? '' : PluginCapabilities.describe(plugin.capabilities))}</dd></div>
      <div><dt>Dependencies</dt><dd>${esc(dependencyText(plugin))}</dd></div>
      <div><dt>Source</dt><dd>${plugin.builtin ? 'Bundled with the client' : 'Installed here'}</dd></div>
      ${plugin.author ? `<div><dt>Author</dt><dd>${esc(plugin.author)}</dd></div>` : ''}
      ${plugin.license ? `<div><dt>License</dt><dd>${esc(plugin.license)}</dd></div>` : ''}
      ${plugin.homepage ? `<div><dt>Homepage</dt><dd>${/^https?:\/\//.test(plugin.homepage) ? `<a href="${esc(plugin.homepage)}" target="_blank" rel="noopener noreferrer">${esc(plugin.homepage)}</a>` : esc(plugin.homepage)}</dd></div>` : ''}
    </dl></section>
    <section><h2>Server resources</h2>
      <p class="muted">Installing the package changed this browser only. Deploying creates ordinary server data through the plugin's capabilities: ${contributes.collections.length} collection definition(s), ${contributes.library.length} Library node(s), ${contributes.workflows.length} workflow template(s). Anything already on the server is updated in place; records and user data are never deleted.</p>
      <dl class="page-facts">
        <div><dt>Declared</dt><dd>${declared || 'Nothing'}</dd></div>
        <div><dt>Deployed here</dt><dd>${deployment.deployed ? `${deployment.counts.library} node(s), ${deployment.counts.collections} collection(s), ${deployment.counts.workflows} template(s)` : 'Not deployed'}</dd></div>
        ${deployment.pluginVersion ? `<div><dt>Deployed version</dt><dd>${esc(deployment.pluginVersion)}</dd></div>` : ''}
      </dl>
      ${declared ? `<div class="button-row"><button type="button" class="primary" data-plugin-deploy ${plugin.enabled ? '' : 'disabled'}>Deploy resources</button></div>` : ''}
      <p class="muted small">The deployment record belongs to this environment. Switching servers and deploying again creates resources on the other server; it never reuses an identifier from this one.</p>
    </section>
    <section><h2>Interface</h2>${pluginInterface(plugin)}</section>
    <section><h2>Package</h2>${pluginEditor(plugin)}<div class="button-row"><button type="button" data-plugin-save>Save changes</button><button type="button" data-plugin-export>Export package</button><button type="button" data-plugin-update>Update from file…</button><button type="button" class="danger" data-plugin-remove>Remove plugin…</button></div></section>
    <section><h2>What the server sees</h2>
      <p class="muted">The server never loads this plugin. Anything it creates through the API — a Library node, a workflow, a collection record — is ordinary server data and keeps working when this client is closed. A plugin is a convenience for editing and running those resources, not a requirement for them.</p>
    </section>
  </div>`;
  $('[data-plugin-toggle]', view).onclick = () =>
    setPluginEnabled(plugin.id, !plugin.enabled).then(() => go('/plugins/' + encodeURIComponent(plugin.id), true)).catch(fail);
  $('[data-plugin-reload]', view).onclick = () => reloadPlugins().then(() => go('/plugins', true)).catch(fail);
  $('[data-plugin-recover]', view).onclick = () => Extensions.recover(plugin.id).then(() => render()).catch(fail);
  $('[data-plugin-deploy]', view).onclick = () => deployPlugin(plugin).catch(fail);
  $('[data-plugin-update]', view).onclick = () => updatePluginDialog(plugin);
  $('[data-plugin-save]', view).onclick = () => {
    const form = $('#plugin-editor', view);
    try {
      const record = PluginStore.record(plugin.id);
      const changed = {
        ...record,
        title: form.elements.title.value,
        version: form.elements.version.value,
        description: form.elements.description.value,
        icon: form.elements.icon.value,
        source: form.elements.source.value,
        capabilities: readCapabilities(form),
      };
      return Extensions.update(plugin.id, changed).then(() => {
        toast('Plugin saved.');
        return go('/plugins/' + encodeURIComponent(plugin.id), true);
      });
    } catch (error) {
      fail(error);
    }
  };
  $('[data-plugin-export]', view).onclick = () => exportPlugin(plugin.id);
  $('[data-plugin-remove]', view).onclick = () => removePlugin(plugin);
}

PAGES.plugins = async (view, route) => {
  if (route.id) return pluginPage(view, route).catch(error => notFoundPlugin(view, error));
  await loadPlugins();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({title: 'Plugins'})}<div class="cards">${app.plugins
    .map(pluginCard)
    .join('')}</div>${
    app.plugins.length ? '' : '<div class="empty small"><h2>No client plugins</h2></div>'
  }</div>`;
};

const notFoundPlugin = (view, error) => {
  view.innerHTML = `<div class="page">${pageHead({title: 'Plugin not found', sub: esc(error.message), menu: ''})}<p><a class="button" href="/plugins" data-link>Back to Plugins</a></p></div>`;
};
