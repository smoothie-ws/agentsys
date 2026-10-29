// Plugins: the list of installed plugins (view, import, enable, disable, remove), a plugin's own page (permissions, what it adds,
// settings, secrets, files, activity), and the sandbox in which a plugin's pages and tiles run. See docs/plugins.md.
'use strict';

// ----- the installed plugins -----
async function loadPlugins() {
  const result = await api('plugins');
  app.plugins = result.plugins;
  return app.plugins;
}
const pluginById = id => (app.plugins || []).find(p => p.id === id);
/** The pages of enabled plugins that belong to a section of the sidebar ("plugins" or "library"). */
const pluginPages = section =>
  (app.plugins || [])
    .filter(p => p.enabled)
    .flatMap(p => p.manifest.contributes.pages.filter(x => x.section === section).map(page => ({plugin: p, page})));
/** Library pages may group related pages under a parent, such as AI / Providers and Skills. */
function pluginSectionRows(section, onlyPlugin) {
  const entries = pluginPages(section);
  const rows = (plugin, parent) =>
    entries
      .filter(e => e.plugin.id === plugin.id && e.page.parent === parent)
      .map(({page}) => {
        const children = rows(plugin, page.id);
        return {
          key: `pg:${plugin.id}:${page.id}`,
          label: page.title,
          icon: page.icon,
          href: pluginHref(plugin.id, page.id),
          menu: 'plugin:' + plugin.id,
          ...(children.length ? {children} : {}),
        };
      });
  return (app.plugins || [])
    .filter(p => p.enabled && (!onlyPlugin || p.id === onlyPlugin))
    .flatMap(p => rows(p, undefined));
}
const pluginHref = (id, page) => `/plugins/${encodeURIComponent(id)}${page ? '/' + encodeURIComponent(page) : ''}`;
const pluginIcon = p => p.manifest.icon || 'plug';
/** What a plugin adds, as short lines for a card. */
function pluginContents(p) {
  const c = p.manifest.contributes;
  return [
    [p.nodes ?? c.nodes.length, 'node', 'node'],
    [(c.library ?? []).length, 'collection', 'folder'],
    [c.pages.length, 'page', 'file'],
    [c.templates.length, 'template', 'folder'],
    [c.endpoints.length, 'endpoint', 'code'],
    [c.tiles.length, 'tile', 'chart'],
    [c.commands.length, 'command', 'play'],
  ]
    .filter(([n]) => n)
    .map(([n, word, glyph]) => [glyph, plural(n, word)]);
}

// ----- the sandbox of a plugin page -----
const FRAME_THEME_VARS = [
  '--text',
  '--muted',
  '--accent',
  '--on-accent',
  '--surface',
  '--panel',
  '--field',
  '--line',
  '--well',
  '--ok',
  '--bad',
  '--warn',
  '--radius',
  '--font',
  '--mono',
];
/** Resolves `src` against the folder of `from` inside the package; null for anything that is not a file of the package. */
function packagePath(from, src) {
  if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
  const parts = from.split('/').slice(0, -1);
  for (const part of src.split(/[?#]/)[0].split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
/** The code that gives a page `window.agentsys`: every call is a message to the host page, which asks the checked bridge. */
const FRAME_BRIDGE = `(() => {
  const pending = new Map(); let serial = 0, themeListener = null;
  const ask = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, {resolve, reject});
    parent.postMessage({agentsys: 1, id, type, ...payload}, '*');
  });
  addEventListener('message', event => {
    const m = event.data;
    if (event.source !== parent || !m || m.agentsys !== 1) return;
    if (m.type === 'theme') { document.documentElement.style.cssText = m.css; themeListener?.(m.dark); return; }
    const entry = pending.get(m.id); if (!entry) return;
    pending.delete(m.id);
    m.error ? entry.reject(Object.assign(new Error(m.error.message), {code: m.error.code, status: m.error.status})) : entry.resolve(m.result);
  });
  const request = (method, path, body, query) => ask('request', {method, path, body, query});
  const data = {
    list: prefix => ask('data', {op: 'list', body: {prefix}}),
    get: key => ask('data', {op: 'get', key}),
    set: (key, value, version) => ask('data', {op: 'put', key, body: version === undefined ? {value} : {value, version}}),
    delete: key => ask('data', {op: 'delete', key}),
  };
  window.agentsys = {
    request, get: (p, q) => request('GET', p, undefined, q), post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b), delete: p => request('DELETE', p),
    settings: {get: () => ask('settings'), set: values => ask('settings', {values})},
    data, call: (name, body, method = 'POST') => ask('call', {name, method, body}),
    navigate: path => ask('navigate', {path}), toast: (message, error = false) => ask('toast', {message, error}),
    resize: height => ask('resize', {height}), onTheme: fn => { themeListener = fn; },
  };
  const report = () => parent.postMessage({agentsys: 1, id: 0, type: 'resize', height: document.documentElement.scrollHeight}, '*');
  addEventListener('load', () => { report(); new ResizeObserver(report).observe(document.documentElement); });
  parent.postMessage({agentsys: 1, id: 0, type: 'ready'}, '*');
})();`;

/** The document a plugin page runs as: its HTML with the files it names inlined, a strict CSP, the theme and the bridge. */
async function pluginFrameDoc(id, entry) {
  const pkg = await api(`plugins/${id}/ui`, {query: {path: entry}}),
    html = pkg.files[entry];
  if (html === undefined) throw new Error('The page file is missing from the plugin');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const script of $$('script[src]', doc)) {
    const path = packagePath(entry, script.getAttribute('src')),
      text = path === null ? undefined : pkg.files[path];
    script.removeAttribute('src');
    script.textContent = text === undefined ? '' : text.replace(/<\/script/gi, '<\\/script');
  }
  for (const link of $$('link[href]', doc)) {
    const path = packagePath(entry, link.getAttribute('href')),
      text = path === null ? undefined : pkg.files[path];
    if (link.rel !== 'stylesheet' || text === undefined) {
      link.remove();
      continue;
    }
    const style = doc.createElement('style');
    style.textContent = text.replace(/<\/style/gi, '<\\/style');
    link.replaceWith(style);
  }
  const head = doc.head,
    meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = FRAME_CSP;
  head.prepend(meta);
  const base = doc.createElement('style');
  base.textContent =
    ':root{color-scheme:light dark}body{margin:0;padding:0.75rem;color:var(--text);background:transparent;font:14px/1.45 var(--font,system-ui,sans-serif)}';
  head.insertBefore(base, meta.nextSibling);
  const bridge = doc.createElement('script');
  bridge.textContent = FRAME_BRIDGE;
  head.insertBefore(bridge, base.nextSibling);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
const frameTheme = () => {
  const style = getComputedStyle(document.documentElement);
  return {
    css: FRAME_THEME_VARS.map(v => `${v}:${style.getPropertyValue(v).trim()}`).join(';'),
    dark:
      (document.documentElement.dataset.theme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark',
  };
};
/**
 * Runs a plugin page (or tile) in `host`: a sandboxed iframe without same-origin rights, so everything it does goes through messages
 * that this function answers. Only the frame this function made is believed (`event.source`). Returns a function that ends it.
 */
async function mountPluginFrame(host, id, entry, {height = 0} = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = 'Plugin ' + id;
  frame.className = 'plugin-frame';
  if (height) frame.style.height = height + 'px';
  frame.srcdoc = await pluginFrameDoc(id, entry);
  if (!host.isConnected) return () => {};
  const reply = (message, result, error) =>
    frame.contentWindow?.postMessage(
      {
        agentsys: 1,
        id: message.id,
        ...(error ? {error: {message: error.message, code: error.code, status: error.status}} : {result}),
      },
      '*'
    );
  const handlers = {
    request: m =>
      api(`plugins/${id}/bridge`, {
        method: 'POST',
        body: {method: m.method, path: m.path, body: m.body, query: m.query},
      }),
    data: m => {
      const key = m.key === undefined ? '' : '/' + encodeURIComponent(m.key);
      if (m.op === 'list') return api(`plugins/${id}/data`, {query: {prefix: m.body?.prefix}});
      return api(`plugins/${id}/data${key}`, {
        method: m.op === 'put' ? 'PUT' : m.op === 'delete' ? 'DELETE' : 'GET',
        body: m.body,
      });
    },
    settings: m =>
      m.values
        ? api(`plugins/${id}/settings`, {method: 'PUT', body: {values: m.values}}).then(r => r.values)
        : api(`plugins/${id}/settings`).then(r => r.values),
    call: m => api(`plugins/${id}/call/${encodeURIComponent(m.name)}`, {method: m.method, body: m.body}),
    navigate: m => {
      if (typeof m.path !== 'string' || !/^\/[A-Za-z0-9_\-/?=&%.]{0,198}$/.test(m.path))
        throw new Error('Not a page of the app');
      return go(m.path).then(() => true);
    },
    toast: m => toast(String(m.message).slice(0, 300), m.error === true),
    resize: m => {
      if (!height && Number.isFinite(m.height)) frame.style.height = Math.min(Math.max(m.height, 60), 4000) + 'px';
    },
  };
  const onMessage = async event => {
    const m = event.data;
    if (event.source !== frame.contentWindow || !m || m.agentsys !== 1) return;
    if (m.type === 'ready') return frame.contentWindow.postMessage({agentsys: 1, type: 'theme', ...frameTheme()}, '*');
    if (m.type === 'resize' && m.id === 0) return handlers.resize(m);
    const run = Object.hasOwn(handlers, m.type) ? handlers[m.type] : null;
    try {
      if (!run) throw new Error('Unknown message');
      reply(m, await run(m));
    } catch (error) {
      reply(m, undefined, error);
    }
  };
  addEventListener('message', onMessage);
  host.replaceChildren(frame);
  return () => {
    removeEventListener('message', onMessage);
    frame.remove();
  };
}
let stopPluginFrame = null;
/** A page leaves: the plugin frame it held stops listening. */
const endPluginFrame = () => {
  stopPluginFrame?.();
  stopPluginFrame = null;
};

// ----- install -----
const packageSummary = pkg => {
  const m = pkg.manifest;
  return `<div class="plugin-manifest"><h3>${icon(m.icon || 'plug')} ${esc(m.name)} <small class="muted">${esc(m.version)}</small></h3>${m.description ? `<p>${esc(m.description)}</p>` : ''}${m.author ? `<p class="muted small">by ${esc(m.author)}</p>` : ''}</div>`;
};
async function installPlugin(pkg, source, replace = false) {
  const m = pkg.manifest,
    old = pluginById(m.id);
  return new Promise(resolve => {
    dialog(
      old ? `Update ${m.name}` : `Install ${m.name}`,
      `${packageSummary(pkg)}${old ? `<p class="muted">Installed: ${esc(old.manifest.version)}. Its settings and data are kept.</p>` : ''}
      ${
        m.capabilities.length
          ? `<fieldset><legend>The plugin asks for these permissions</legend>${m.capabilities
              .map(
                cap =>
                  `<label class="check"><input type="checkbox" name="grant" value="${esc(cap)}" ${old ? (old.grants.includes(cap) ? 'checked' : '') : ''}>${esc(cap)}</label>`
              )
              .join(
                '<br>'
              )}</fieldset><p class="muted small">Nothing is allowed unless you tick it. You can change this later.</p>`
          : '<p class="muted small">This plugin asks for no permissions.</p>'
      }
      ${old ? '' : '<label class="check"><input type="checkbox" name="enable" checked>Enable after installing</label>'}`,
      async form => {
        const grants = [...form.querySelectorAll('input[name=grant]:checked')].map(i => i.value);
        const body = {package: pkg, grants, source, replace: !!old || replace};
        if (!old) body.enable = form.elements.enable.checked;
        const result = await api('plugins', {method: 'POST', body});
        await Promise.all([loadPlugins(), loadLibrary()]);
        toast(`${m.name} ${old ? 'updated' : 'installed'}.`);
        resolve(result);
        await render();
      },
      old ? 'Update' : 'Install'
    );
    $('#modal').addEventListener('close', () => resolve(null), {once: true});
  });
}
/** Asks for a plugin file and shows what it is before anything is installed. */
async function importPlugin() {
  const [file] = await pickFiles({multiple: false});
  if (!file) return;
  let pkg;
  try {
    pkg = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not JSON');
  }
  if (pkg?.format !== 'agentsys.plugin/1') throw new Error('That is not a plugin package (agentsys.plugin/1)');
  await installPlugin(pkg, file.name);
}
async function setPluginEnabled(id, enabled) {
  await api(`plugins/${id}`, {method: 'PUT', body: {enabled}});
  await Promise.all([loadPlugins(), loadLibrary()]);
  renderSidebar();
  if (app.route?.page === 'plugins') await render();
}
function removePlugin(p) {
  dialog(
    `Remove ${p.manifest.name}?`,
    `<p>Its Library nodes, settings and data are deleted. Copies of its nodes that you already used stay where they are.</p>`,
    async () => {
      await api(`plugins/${p.id}`, {method: 'DELETE'});
      await Promise.all([loadPlugins(), loadLibrary()]);
      toast(`${p.manifest.name} removed.`);
      await go('/plugins');
    },
    'Remove',
    true
  );
}
function pluginActions(p) {
  return [
    ['Open', () => go(pluginHref(p.id)), {icon: 'eye'}],
    [p.enabled ? 'Disable' : 'Enable', () => setPluginEnabled(p.id, !p.enabled).catch(fail), {icon: 'power'}],
    ['Remove', () => removePlugin(p), {icon: 'trash', danger: true}],
  ];
}
function templateActions(plugin, template) {
  return [
    [
      'Create project',
      () =>
        dialog(
          'New project',
          field('Name', `<input name="name" required maxlength="100" value="${esc(template.name)}" autofocus>`),
          async form => {
            const project = await api(`plugins/${plugin.id}/templates/${template.id}/instantiate`, {
              method: 'POST',
              body: {name: form.elements.name.value},
            });
            await loadProjects();
            await go('/p/' + project.id);
          },
          'Create'
        ),
      {icon: 'plus', disabled: !plugin.enabled},
    ],
  ];
}

// ----- the list -----
const pluginCard = p =>
  card({
    href: pluginHref(p.id),
    glyph: pluginIcon(p),
    title: p.manifest.name,
    preview: p.manifest.description
      ? `<p class="plugin-about">${esc(p.manifest.description)}</p>${cardList(pluginContents(p))}`
      : cardList(pluginContents(p)),
    previewClass: 'card-note',
    facts: `${esc(p.manifest.version)} · ${p.enabled ? 'enabled' : 'disabled'}`,
    menu: 'plugin:' + p.id,
  }).replace('<article class="card ', `<article class="card ${p.enabled ? '' : 'plugin-off'} `);

async function pluginsListPage(view, route) {
  const plugins = await loadPlugins();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({title: 'Plugins', sub: 'Installed extensions.'})}<div class="cards">${plugins.map(pluginCard).join('')}</div>${plugins.length ? '' : '<div class="empty small"><h2>No plugins installed</h2></div>'}</div>`;
}
const pluginActiveKey = route =>
  route.page !== 'plugins' || !route.id ? '' : route.view ? `pg:${route.id}:${route.view}` : 'pl:' + route.id;

// ----- one plugin -----
const stamp = seconds => (seconds ? new Date(seconds * 1000).toLocaleString() : '–');
function settingField(f, value) {
  const name = `setting-${f.key}`,
    hint = f.description ? `<small>${esc(f.description)}</small>` : '';
  if (f.type === 'boolean')
    return `<label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}>${esc(f.label)}</label>${hint}`;
  if (f.type === 'select')
    return field(
      f.label,
      `<select name="${name}">${options(
        f.options.map(o => [o, o]),
        value
      )}</select>${hint}`
    );
  if (f.type === 'textarea') return field(f.label, `<textarea name="${name}" rows="4">${esc(value)}</textarea>${hint}`);
  if (f.type === 'number')
    return field(
      f.label,
      `<input type="number" name="${name}" value="${esc(value)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} step="any">${hint}`
    );
  return field(f.label, `<input name="${name}" value="${esc(value)}">${hint}`);
}
function readSettings(form, fields) {
  const values = {};
  for (const f of fields) {
    const el = form.elements[`setting-${f.key}`];
    values[f.key] = f.type === 'boolean' ? el.checked : f.type === 'number' ? Number(el.value) : el.value;
  }
  return values;
}
const contentTabLinks = (panels, selected) =>
  `<nav class="content-tabs" aria-label="Item sections">${panels.map(([key, label]) => `<a data-link href="${esc(routePath() + '?tab=' + key)}" ${key === selected ? 'aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>`;
async function pluginDetailPage(view, route) {
  const p = await api(`plugins/${route.id}`).catch(() => null);
  if (app.route !== route) return;
  if (!p) {
    view.innerHTML = `<div class="page">${notFound('Plugin', '/plugins', 'Back to Plugins')}</div>`;
    return;
  }
  await loadPlugins();
  if (app.route !== route) return;
  const m = p.manifest,
    c = m.contributes,
    panels = [
      ['overview', 'Overview'],
      ['settings', 'Settings'],
      ['permissions', 'Permissions'],
      ['activity', 'Activity'],
    ];
  const requested = routeQuery().get('tab') ?? 'overview',
    selected = panels.some(([key]) => key === requested) ? requested : 'overview';
  let readme = m.description;
  if (m.readme && selected === 'overview') readme = (await api(`plugins/${p.id}/file`, {query: {path: m.readme}})).text;
  if (app.route !== route) return;
  const templates = c.templates
    .map(t =>
      card({
        glyph: 'folder',
        title: t.name,
        preview: '<p class="resource-description">Project template</p>',
        previewClass: 'card-note',
        menu: `plugin-template:${p.id}:${t.id}`,
      })
    )
    .join('');
  const additions =
    (app.librarySections ?? [])
      .filter(s => s.plugin === p.id && !s.parent)
      .map(catalogSectionCard)
      .join('') +
    c.pages
      .filter(x => !x.parent)
      .map(x =>
        card({
          href: p.enabled ? pluginHref(p.id, x.id) : null,
          glyph: x.icon,
          title: x.title,
          preview: `<p class="resource-description">${esc(x.section === 'library' ? 'Library page' : 'Plugin page')}</p>`,
          previewClass: 'card-note',
          menu: 'plugin:' + p.id,
        })
      )
      .join('');
  view.innerHTML = `<div class="page plugin-page">${pageHead({title: `<span class="plugin-title">${icon(pluginIcon(p))}<span>${esc(m.name)}</span></span>`, crumbs: [['Plugins', '/plugins']], sub: esc(m.description), menu: 'plugin:' + p.id})}
    <p class="plugin-meta">${statusBadge(p.enabled ? 'enabled' : 'disabled')}<span>Version ${esc(m.version)}</span>${m.author ? `<span>${esc(m.author)}</span>` : ''}</p>
    ${contentTabLinks(panels, selected)}
    <section data-content-panel="overview" ${selected === 'overview' ? '' : 'hidden'}><div class="plugin-layout"><article class="plugin-readme">${renderMarkdown(readme || 'No description provided.')}${additions ? `<h2>Library and pages</h2><div class="cards">${additions}</div>` : ''}${templates ? `<h2>Templates</h2><div class="cards">${templates}</div>` : ''}</article><aside class="plugin-facts"><h2>Details</h2><dl><dt>Version</dt><dd>${esc(m.version)}</dd><dt>Publisher</dt><dd>${esc(m.author || 'Not specified')}</dd><dt>Installed</dt><dd>${esc(stamp(p.installed))}</dd><dt>Library nodes</dt><dd>${p.nodes}</dd><dt>Collections</dt><dd>${(c.library ?? []).length}</dd>${m.homepage ? `<dt>Website</dt><dd><a href="${esc(m.homepage)}" target="_blank" rel="noopener noreferrer">Open website</a></dd>` : ''}</dl></aside></div></section>
    <section data-content-panel="settings" ${selected === 'settings' ? '' : 'hidden'}><h2>Settings</h2>${p.settings.schema.fields.length ? `<form id="plugin-settings" class="catalog-form">${p.settings.schema.fields.map(f => settingField(f, p.settings.values[f.key])).join('')}</form>` : '<p class="muted">This plugin has no additional settings.</p>'}${m.secrets.length ? `<h3>Credentials</h3>${p.secrets.map(secret => `<div class="plugin-secret" data-secret="${esc(secret.name)}"><span>${esc(secret.name)}</span><small class="muted">${secret.present ? 'Configured' : 'Not configured'}</small><button type="button" data-secret-set>${secret.present ? 'Change' : 'Set'}</button>${secret.present ? '<button type="button" data-secret-clear>Clear</button>' : ''}</div>`).join('')}` : ''}</section>
    <section data-content-panel="permissions" ${selected === 'permissions' ? '' : 'hidden'}><h2>Permissions</h2>${m.capabilities.length ? `<div data-plugin-permissions>${permissionChoices(m.capabilities, p.grants, 'data-plugin-grant', 'plugin-grant')}</div>` : '<p class="muted">This plugin requests no permissions.</p>'}</section>
    <section data-content-panel="activity" ${selected === 'activity' ? '' : 'hidden'}><h2>Activity</h2><div id="plugin-log"></div></section>
  </div>`;
  const permissionBox = $('[data-plugin-permissions]', view);
  if (permissionBox)
    permissionBox.onchange = () =>
      api(`plugins/${p.id}`, {
        method: 'PUT',
        body: {grants: $$('[data-plugin-grant]:checked', permissionBox).map(el => el.dataset.pluginGrant)},
      })
        .then(loadPlugins)
        .catch(fail);
  const form = $('#plugin-settings', view);
  if (form) {
    pageAutosave(
      form,
      () => readSettings(form, p.settings.schema.fields),
      values => api(`plugins/${p.id}/settings`, {method: 'PUT', body: {values}})
    );
  }
  for (const row of $$('[data-secret]', view)) {
    const name = row.dataset.secret;
    $('[data-secret-set]', row).onclick = () =>
      dialog(
        'Credential ' + name,
        field('Value', '<input type="password" name="value" required autocomplete="new-password">'),
        async form => {
          await api('secrets/' + encodeURIComponent(name), {method: 'PUT', body: {value: form.elements.value.value}});
          await render();
        }
      );
    const clear = $('[data-secret-clear]', row);
    if (clear)
      clear.onclick = () =>
        api('secrets/' + encodeURIComponent(name), {method: 'DELETE'})
          .then(() => render())
          .catch(fail);
  }
  if (selected === 'activity') {
    const log = await api(`plugins/${p.id}/log`);
    if (app.route !== route) return;
    $('#plugin-log', view).innerHTML = log.length
      ? `<table class="data-table"><thead><tr><th>When</th><th>Action</th><th>Details</th></tr></thead><tbody>${[...log]
          .reverse()
          .map(
            entry =>
              `<tr><td>${esc(stamp(entry.at))}</td><td>${esc(entry.kind)}</td><td>${esc([entry.method, entry.path, entry.name, entry.error].filter(Boolean).join(' '))}</td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p class="muted">No activity yet.</p>';
  }
}

// ----- a page of a plugin -----
async function pluginFramePage(view, route) {
  const p = pluginById(route.id) || (await loadPlugins(), pluginById(route.id)),
    page = p?.manifest.contributes.pages.find(x => x.id === route.view);
  if (app.route !== route) return;
  if (!p || !page || !p.enabled) {
    view.innerHTML = `<div class="empty"><h2>${p ? 'This page is not available' : 'This plugin is not installed'}</h2><p>${p && !p.enabled ? 'The plugin is disabled.' : ''}</p><a href="/plugins" data-link>Back to Plugins</a></div>`;
    return;
  }
  if (page.section === 'library') await loadLibrary();
  if (app.route !== route) return;
  if (page.navigation) app.pluginNavigation = {route, plugin: p.id, ...page.navigation};
  const parents = [];
  let ancestor = page;
  while (ancestor.parent) {
    ancestor = p.manifest.contributes.pages.find(x => x.id === ancestor.parent);
    parents.unshift([ancestor.title, pluginHref(p.id, ancestor.id)]);
  }
  view.innerHTML = `<div class="page plugin-page">${pageHead({
    crumbs:
      page.section === 'library'
        ? [['Library', '/resources'], ...parents]
        : [['Plugins', '/plugins'], [p.manifest.name, pluginHref(p.id)], ...parents],
    title: `${icon(page.icon)} ${esc(page.title)}`,
  })}<div id="plugin-host" class="plugin-host"></div></div>`;
  const stop = await mountPluginFrame($('#plugin-host', view), p.id, page.entry);
  if (app.route === route) stopPluginFrame = stop;
  else stop();
}

PAGES.plugins = async (view, route) => {
  endPluginFrame();
  if (route.id && route.view) return pluginFramePage(view, route);
  if (route.id) return pluginDetailPage(view, route);
  return pluginsListPage(view, route);
};
