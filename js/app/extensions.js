// The extension host of the page. A plugin's client.js is loaded here (see docs/plugins.md) and gets the official
// interface tools: commands, pages, sidebar items, toolbar buttons, menu items, dashboard cards and styles. Everything
// a module registers is kept with it and removed when the plugin stops, is turned off or the folder is reloaded.
//
// A client module is CommonJS-shaped and runs in this page, not on the server:
//
//   exports.activate = api => {
//     api.commands.register('greet', () => api.ui.toast('Hello'), {title: 'Say hello'});
//     api.ui.addToolbarButton({id: 'greet', title: 'Say hello', icon: 'sparkles', command: 'greet'});
//     api.ui.addPage({id: 'hello', title: 'Hello', icon: 'sparkles', render: root => { root.textContent = 'Hi'; }});
//   };
//   exports.deactivate = () => {};
//
// The plugin is trusted code, like main.js: the page does not sandbox it. The difference from the server module is
// reach: this one can change the interface through `api.ui`, and the server module cannot.
'use strict';

const Extensions = (() => {
  const loaded = new Map(); // plugin id -> {plugin, module, api, disposables}
  const errors = new Map(); // plugin id -> message of a failed client.js
  const failed = new Set(); // plugin ids whose activation failed; retried only by a reload
  const pages = []; // {plugin, id, title, description, icon, order, render}
  const sidebarItems = []; // {plugin, id, page, href, title, icon, order}
  const toolbarButtons = []; // {plugin, id, title, icon, command, order}
  const menuContributions = []; // {plugin, menu, label, icon, command, order}
  const homeCards = []; // {plugin, id, title, icon, order, render}
  const commands = new Map(); // "plugin:command" -> {key, plugin, id, handler, title, icon, order}
  const styleNodes = new Map(); // plugin id -> [<style>]
  let loading = null;

  const byOrder = (a, b) =>
    (a.order || 0) - (b.order || 0) ||
    String(a.title ?? a.label ?? '').localeCompare(String(b.title ?? b.label ?? ''));
  const cssId = id => String(id).replace(/[^A-Za-z0-9_-]/g, '-');
  const storageKey = (id, key) => `agentsys-ext-${cssId(id)}-${cssId(key).slice(0, 120)}`;
  const own = id => (key, fallback = null) => store.get(storageKey(id, key), fallback);
  const checkId = (id, what = 'id') => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))
      throw new Error(`${what} must be letters, digits, ".", "_" or "-"`);
    return id;
  };
  const removeWhere = (list, match) => {
    for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) list.splice(i, 1);
  };
  const pagesOf = id => pages.filter(p => p.plugin === id).sort(byOrder);
  const findPage = (plugin, id) => pages.find(p => p.plugin === plugin && p.id === id);
  const pageHref = (plugin, id) => `/ext/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;
  const pluginTitle = id =>
    (typeof app !== 'undefined' && app.plugins?.find(p => p.id === id)?.title) || id;
  const sectionTitle = section => (section.startsWith('ext:') ? pluginTitle(section.slice(4)) : 'Navigation');

  // ----- what a module can register -----

  /** The tiny DOM builder plugin pages use; no innerHTML needed for ordinary content. */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null) continue;
      if (key === 'class' || key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function')
        node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false) node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function makeApi(plugin) {
    const entry = loaded.get(plugin.id),
      id = plugin.id,
      key = command => `${id}:${command}`,
      track = dispose => {
        if (typeof dispose === 'function') entry.disposables.push(dispose);
        return dispose;
      },
      request = (method, path, body, query) => api(path, {method, body, query}),
      addMenu = (menu, item) => {
        if (typeof menu !== 'string' || !/^[a-z][a-z0-9-]*(?::[^\s]+)?$/i.test(menu))
          throw new Error('A menu is written like "section:plugins"');
        if (!item || typeof item.label !== 'string' || !item.label.trim())
          throw new Error('A menu item needs a label');
        checkId(item.command, 'command');
        const contribution = {
          plugin: id,
          menu,
          label: item.label,
          icon: item.icon || '',
          command: item.command,
          order: Number(item.order) || 0,
        };
        menuContributions.push(contribution);
        return track(() => removeWhere(menuContributions, m => m === contribution));
      };

    return Object.assign(request, {
      id,
      title: plugin.title,
      description: plugin.description,
      icon: plugin.icon,
      signal: entry.controller.signal,
      log: (...args) => console.info(`[${id}]`, ...args),
      request,
      settings: {
        get: async () => {
          const detail = await api(`plugins/${encodeURIComponent(id)}`);
          return Object.fromEntries((detail.settings || []).map(field => [field.key, field.value]));
        },
      },
      storage: {
        get: own(id),
        set: (key, value) => store.set(storageKey(id, key), value),
      },
      on(event, listener) {
        if (event !== 'change') throw new Error('Unknown event: ' + event);
        if (typeof listener !== 'function') throw new Error('A listener is a function');
        return track(Backend.subscribe(listener));
      },
      onDidChange(listener) {
        if (typeof listener !== 'function') throw new Error('A listener is a function');
        return track(Backend.subscribe(listener));
      },
      commands: {
        register(command, handler, meta = {}) {
          checkId(command, 'command id');
          if (typeof handler !== 'function') throw new Error('A command needs a function');
          const full = key(command),
            item = {
              key: full,
              plugin: id,
              id: command,
              handler,
              title: meta.title || command,
              icon: meta.icon || '',
              order: Number(meta.order) || 0,
            };
          commands.set(full, item);
          return track(() => {
            if (commands.get(full) === item) commands.delete(full);
          });
        },
        execute: (command, ...args) => execute(key(command), ...args),
        list: () => [...commands.values()].filter(c => c.plugin === id).map(publicCommand),
      },
      ui: {
        addPage(spec = {}) {
          checkId(spec.id, 'page id');
          if (findPage(id, spec.id)) throw new Error(`The page "${spec.id}" is already registered`);
          if (typeof spec.render !== 'function') throw new Error('A page needs a render(container, context) function');
          const page = {
            plugin: id,
            id: spec.id,
            title: spec.title || spec.id,
            description: spec.description || '',
            icon: spec.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
            render: spec.render,
          };
          pages.push(page);
          const navItem =
            spec.nav === false
              ? null
              : {
                  plugin: id,
                  id: 'nav:' + page.id,
                  page: page.id,
                  href: pageHref(id, page.id),
                  title: page.title,
                  icon: page.icon,
                  order: page.order,
                };
          if (navItem) sidebarItems.push(navItem);
          return track(() => {
            removeWhere(pages, p => p === page);
            if (navItem) removeWhere(sidebarItems, item => item === navItem);
          });
        },
        addSidebarItem(spec = {}) {
          checkId(spec.id, 'sidebar item id');
          const page = spec.page ? findPage(id, spec.page) : null;
          if (!page && !spec.href) throw new Error('A sidebar item needs a registered page or an href');
          if (sidebarItems.some(item => item.plugin === id && item.id === spec.id))
            throw new Error(`The sidebar item "${spec.id}" is already registered`);
          const item = {
            plugin: id,
            id: spec.id,
            page: page?.id,
            href: page ? pageHref(id, page.id) : spec.href,
            title: spec.title || page?.title || spec.id,
            icon: spec.icon || page?.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
          };
          sidebarItems.push(item);
          return track(() => removeWhere(sidebarItems, other => other === item));
        },
        addToolbarButton(spec = {}) {
          checkId(spec.id, 'toolbar button id');
          if (typeof spec.command !== 'string' || !spec.command) throw new Error('A toolbar button needs a command');
          if (toolbarButtons.some(item => item.plugin === id && item.id === spec.id))
            throw new Error(`The toolbar button "${spec.id}" is already registered`);
          const item = {
            plugin: id,
            id: spec.id,
            title: spec.title || commands.get(key(spec.command))?.title || spec.command,
            icon: spec.icon || commands.get(key(spec.command))?.icon || plugin.icon || 'plug',
            command: spec.command,
            order: Number(spec.order) || 0,
          };
          toolbarButtons.push(item);
          return track(() => removeWhere(toolbarButtons, other => other === item));
        },
        addMenuItem: addMenu,
        addHomeCard(spec = {}) {
          checkId(spec.id, 'dashboard card id');
          if (typeof spec.render !== 'function') throw new Error('A dashboard card needs a render(container) function');
          const item = {
            plugin: id,
            id: spec.id,
            title: spec.title || plugin.title,
            icon: spec.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
            render: spec.render,
          };
          homeCards.push(item);
          return track(() => removeWhere(homeCards, other => other === item));
        },
        addStyles(css) {
          if (typeof css !== 'string' || !css.trim()) throw new Error('addStyles needs CSS text');
          const node = document.createElement('style');
          node.dataset.plugin = id;
          node.textContent = css;
          document.head.append(node);
          if (!styleNodes.has(id)) styleNodes.set(id, []);
          styleNodes.get(id).push(node);
          return track(() => {
            node.remove();
            removeWhere(styleNodes.get(id) || [], other => other === node);
          });
        },
        notify: notification =>
          api('notifications', {
            method: 'POST',
            body: {...notification, source: notification?.source || 'plugin:' + id},
          }),
        toast,
        fail,
        el,
        icon,
        escape: esc,
        card,
        field,
        dialog,
        confirm: confirmDialog,
        navigate: path => go(path).catch(fail),
        refresh: () => render().catch(fail),
        pageHref: pageId => pageHref(id, pageId),
        get section() {
          return 'ext:' + id;
        },
      },
    });
  }

  const publicCommand = command => ({
    key: command.key,
    id: command.id,
    title: command.title,
    icon: command.icon,
    plugin: command.plugin,
    pluginTitle: pluginTitle(command.plugin),
  });

  /** Runs one registered command; a missing one is a normal, reported failure. */
  async function execute(key, ...args) {
    const command = commands.get(key);
    if (!command) {
      const error = new Error(`Unknown command: ${key}`);
      fail(error);
      throw error;
    }
    try {
      return await command.handler(...args);
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  // ----- loading and removing a module -----

  function evaluate(id, code) {
    const module = {exports: {}};
    const factory = new Function(
      'exports',
      'module',
      'require',
      'console',
      `${code}\n//# sourceURL=plugin://${encodeURIComponent(id)}/client.js`
    );
    factory(module.exports, module, () => {
      throw new Error('client.js runs in the page and cannot require modules');
    }, console);
    return module.exports;
  }

  function removeModule(id, callDeactivate) {
    const entry = loaded.get(id);
    if (!entry) return;
    entry.controller?.abort();
    if (callDeactivate) {
      try {
        entry.module?.deactivate?.();
      } catch (error) {
        errors.set(id, error.message);
        console.error(`[plugins] ${id}: deactivate failed:`, error);
      }
    }
    for (const dispose of entry.disposables.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error(`[plugins] ${id}: could not remove a contribution:`, error);
      }
    }
    // Registrations are also filtered here in case a module threw before it returned its disposables.
    removeWhere(pages, p => p.plugin === id);
    removeWhere(sidebarItems, item => item.plugin === id);
    removeWhere(toolbarButtons, item => item.plugin === id);
    removeWhere(menuContributions, item => item.plugin === id);
    removeWhere(homeCards, item => item.plugin === id);
    for (const key of [...commands.keys()]) if (commands.get(key).plugin === id) commands.delete(key);
    for (const node of styleNodes.get(id) || []) node.remove();
    styleNodes.delete(id);
    document.body.classList.remove('plugin-' + cssId(id));
    loaded.delete(id);
  }

  async function loadModule(plugin) {
    let entry;
    try {
      const source = await api(`plugins/${encodeURIComponent(plugin.id)}/client`);
      if (!source?.code) throw new Error('client.js is empty');
      const module = evaluate(plugin.id, source.code);
      if (typeof module.activate !== 'function') throw new Error('client.js must export activate(api)');
      entry = {plugin, module, api: null, disposables: [], controller: new AbortController()};
      loaded.set(plugin.id, entry);
      entry.api = makeApi(plugin);
      document.body.classList.add('plugin-' + cssId(plugin.id));
      const cleanup = await module.activate(entry.api);
      if (typeof cleanup === 'function') entry.disposables.push(cleanup);
      errors.delete(plugin.id);
      failed.delete(plugin.id);
    } catch (error) {
      errors.set(plugin.id, error.message || String(error));
      failed.add(plugin.id);
      console.error(`[plugins] ${plugin.id}: the interface could not start:`, error);
      if (typeof toast === 'function')
        toast(`The interface of ${plugin.title || plugin.id} could not start: ${error.message}`, true);
      if (entry || loaded.has(plugin.id)) removeModule(plugin.id, false);
    }
  }

  /** Activates the modules of the plugins that are now running and removes those that stopped. Never throws. */
  async function sync(plugins) {
    if (loading) return loading;
    loading = (async () => {
      let list = plugins;
      if (!list) {
        try {
          list = await api('plugins');
        } catch (error) {
          console.error('[plugins] could not list the plugins:', error);
          return;
        }
      }
      const wanted = new Map(list.filter(p => p.running && p.client).map(p => [p.id, p]));
      for (const id of [...errors.keys()]) if (!wanted.has(id)) errors.delete(id);
      for (const id of [...failed]) if (!wanted.has(id)) failed.delete(id);
      for (const id of [...loaded.keys()]) if (!wanted.has(id)) removeModule(id, true);
      for (const plugin of wanted.values()) if (!loaded.has(plugin.id) && !failed.has(plugin.id)) await loadModule(plugin);
      renderAll();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  /** Loads every interface from scratch (an edited client.js, a plugin turned on or off). */
  async function reload(plugins) {
    if (loading) await loading;
    failed.clear();
    for (const id of [...loaded.keys()]) removeModule(id, true);
    renderAll();
    return sync(plugins);
  }

  // ----- drawing what modules registered -----

  function renderSidebarItems() {
    const host = typeof document === 'undefined' ? null : document.getElementById('sidebar-extensions');
    if (!host) return;
    const items = [...sidebarItems].sort(byOrder);
    host.hidden = !items.length;
    host.innerHTML = items
      .map(
        item =>
          `<div class="sidebar-item" data-ext="${esc(item.plugin + ':' + item.id)}"><a href="${esc(item.href)}" data-link data-section="ext:${esc(item.plugin)}" data-ext-page="${esc(item.page || '')}" title="${esc(item.title)}">${icon(item.icon)}<span>${esc(item.title)}</span></a></div>`
      )
      .join('');
  }

  function renderToolbar() {
    const host = typeof document === 'undefined' ? null : document.getElementById('toolbar-slot');
    if (!host) return;
    const items = [...toolbarButtons].sort(byOrder);
    host.hidden = !items.length;
    host.innerHTML = items
      .map(item => {
        const key = `${item.plugin}:${item.command}`;
        return `<button type="button" class="icon" data-ext-command="${esc(key)}"${commands.has(key) ? '' : ' disabled'} title="${esc(item.title)}" aria-label="${esc(item.title)}">${icon(item.icon)}</button>`;
      })
      .join('');
  }

  function renderHome(host) {
    if (!host) return;
    const cards = [...homeCards].sort(byOrder);
    host.replaceChildren();
    if (!cards.length) return;
    const section = el('section', {class: 'ext-home'});
    section.append(el('div', {class: 'section-head'}, el('h2', {}, 'Plugins')));
    const grid = el('div', {class: 'cards'});
    for (const item of cards) {
      const body = el('div', {class: 'card-preview card-note'});
      const article = el(
        'article',
        {class: 'card', 'data-ext-home': `${item.plugin}:${item.id}`},
        el(
          'div',
          {class: 'card-main'},
          el('header', {class: 'card-head'}, el('span', {class: 'head-icon', html: icon(item.icon)}), el('h3', {}, item.title)),
          body
        )
      );
      grid.append(article);
      try {
        const drawn = item.render(body, {plugin: item.plugin, api: loaded.get(item.plugin)?.api, card: item});
        if (drawn && typeof drawn.catch === 'function')
          drawn.catch(error => {
            body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
            console.error(`[plugins] ${item.plugin}: dashboard card failed:`, error);
          });
      } catch (error) {
        body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
        console.error(`[plugins] ${item.plugin}: dashboard card failed:`, error);
      }
    }
    section.append(grid);
    host.append(section);
  }

  function renderAll() {
    renderSidebarItems();
    renderToolbar();
    const route = typeof app === 'undefined' ? null : app.route;
    if (route && typeof renderSidebar === 'function') renderSidebar();
    if (route?.page === 'home') render().catch(fail);
    else if (route?.page === 'ext' && typeof render === 'function') render().catch(fail);
  }

  // Toolbar commands are delegated once; pages and sidebar links use the router.
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-ext-command]');
    if (!button) return;
    event.preventDefault();
    execute(button.dataset.extCommand).catch(() => {});
  });

  return {
    sync,
    reload,
    renderSidebar: renderSidebarItems,
    renderToolbar,
    renderHome,
    render: renderAll,
    page: findPage,
    pagesOf,
    pageHref,
    sectionTitle,
    sectionOf: route => (route?.page === 'ext' ? 'ext:' + route.plugin : null),
    destinations: () =>
      pages.map(page => ({
        label: page.title,
        hint: `Plugin · ${pluginTitle(page.plugin)}`,
        href: pageHref(page.plugin, page.id),
      })),
    commands: () => [...commands.values()].sort((a, b) => a.title.localeCompare(b.title)).map(publicCommand),
    execute,
    menuItems(spec) {
      return menuContributions
        .filter(item => item.menu === spec)
        .sort(byOrder)
        .map(item => [
          item.label,
          () => execute(`${item.plugin}:${item.command}`),
          {icon: item.icon || undefined, disabled: !commands.has(`${item.plugin}:${item.command}`)},
        ]);
    },
    hasMenu: spec => menuContributions.some(item => item.menu === spec),
    errorOf: id => errors.get(id) || '',
    apiOf: id => loaded.get(id)?.api || null,
    /** What one plugin registered, for its page on the Plugins screen. */
    describe(id) {
      return {
        error: errors.get(id) || '',
        pages: pagesOf(id).map(page => ({id: page.id, title: page.title, icon: page.icon, href: pageHref(id, page.id)})),
        sidebar: sidebarItems.filter(item => item.plugin === id).map(item => item.title),
        toolbar: toolbarButtons.filter(item => item.plugin === id).map(item => item.title),
        menu: menuContributions.filter(item => item.plugin === id).map(item => `${item.menu}: ${item.label}`),
        home: homeCards.filter(item => item.plugin === id).map(item => item.title),
        commands: [...commands.values()].filter(item => item.plugin === id).map(item => item.title),
        styles: (styleNodes.get(id) || []).length,
      };
    },
  };
})();
