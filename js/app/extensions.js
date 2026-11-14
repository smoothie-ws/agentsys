// The client extension host. Plugins are installed in this browser (js/app/plugin-store.js) and run inside a
// sandboxed iframe with an opaque origin: they cannot read this page's DOM, storage, cookies or server token.
// They talk to the host through a small message API: request(), storage, commands and declarative UI registrations.
//
// This is a best-effort isolation boundary for convenience plugins, not a hardened security boundary against a
// malicious program: an installed plugin can call the same API this user can. See docs/plugins.md.
'use strict';

const Extensions = (() => {
  const loaded = new Map(); // plugin id -> {plugin, sandbox, api, disposables}
  const errors = new Map();
  const failed = new Set();
  const pages = [];
  const sidebarItems = [];
  const toolbarButtons = [];
  const menuContributions = [];
  const homeCards = [];
  const commands = new Map();
  const styleNodes = new Map();
  let loading = null;

  const byOrder = (a, b) =>
    (a.order || 0) - (b.order || 0) ||
    String(a.title ?? a.label ?? '').localeCompare(String(b.title ?? b.label ?? ''));
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
  const pluginTitle = id => (typeof app !== 'undefined' && app.plugins?.find(p => p.id === id)?.title) || id;
  const cssId = id => String(id).replace(/[^A-Za-z0-9_-]/g, '-');

  /** Passive HTML from a plugin page or card. Scripts, frames, event handlers and unsafe URLs are removed. */
  function sanitizeHTML(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value ?? '').slice(0, 300000);
    // HTML elements report an upper-case tagName, namespaced ones (SVG, MathML) keep their lower-case name: compare
    // the local name without case, so `<svg><script>` is removed like `<script>`.
    const banned = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM']);
    const tagged = node => String(node.localName || node.tagName || '').toUpperCase();
    const unsafeURL = text => /^\s*(?:javascript|vbscript|data:text\/html|data:application\/xhtml)/i.test(text);
    const walk = node => {
      for (const child of [...node.children]) {
        if (banned.has(tagged(child))) {
          child.remove();
          continue;
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const text = String(attr.value || '');
          if (
            name.startsWith('on') ||
            name === 'srcdoc' ||
            name === 'action' ||
            name === 'formaction' ||
            name === 'ping' ||
            unsafeURL(text)
          )
            child.removeAttribute(attr.name);
          else if (name === 'style' && /url\s*\(|expression\s*\(|behavior\s*:|@import|-moz-binding/i.test(text))
            child.removeAttribute(attr.name);
        }
        if (tagged(child) === 'A') {
          child.setAttribute('rel', 'noopener noreferrer');
          if (/^https?:/i.test(child.getAttribute('href') || '')) child.setAttribute('target', '_blank');
          else child.removeAttribute('target');
        }
        walk(child);
      }
    };
    walk(template.content);
    return template.innerHTML;
  }

  /** A sidebar item points into this client; a URL of another origin or another scheme is not a destination. */
  function internalHref(value) {
    const text = String(value || '');
    if (text.length > 2000 || !/^\/(?!\/)/.test(text) || /[\\\u0000-\u001f\u007f]/.test(text))
      throw new Error('A sidebar item href must be a path of this client, starting with "/"');
    return text;
  }

  /** One sandboxed iframe per plugin: no same-origin access, no direct DOM, storage or token. */
  class PluginSandbox {
    constructor(plugin) {
      this.plugin = plugin;
      this.capabilities = typeof PluginCapabilities === 'undefined' ? [] : PluginCapabilities.forPlugin(plugin);
      this.pending = new Map();
      this.serial = 0;
      this.dead = false;
      this.token = null; // a server-issued token scoped to this plugin's capabilities
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.frame = document.createElement('iframe');
      this.frame.title = `Plugin ${plugin.id}`;
      this.frame.setAttribute('sandbox', 'allow-scripts');
      this.frame.setAttribute('aria-hidden', 'true');
      this.frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:0;border:0;';
      this.url = URL.createObjectURL(new Blob([sandboxDocument(plugin)], {type: 'text/html'}));
      this.frame.src = this.url;
      this.onMessage = event => {
        if (event.source !== this.frame.contentWindow) return;
        const data = event.data;
        if (!data || data.__agentsys !== 'plugin') return;
        if (data.kind === 'ready') {
          if (data.error) this.rejectReady(new Error(data.error));
          else if (data.ok) this.resolveReady();
          return;
        }
        if (data.kind === 'invoke-result') {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          this.pending.delete(data.id);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.value);
          return;
        }
        this.receive(data).then(
          value =>
            this.frame.contentWindow?.postMessage(
              {__agentsys: 'host', kind: 'result', id: data.id, value},
              '*'
            ),
          error =>
            this.frame.contentWindow?.postMessage(
              {__agentsys: 'host', kind: 'result', id: data.id, error: error.message || String(error) },
              '*'
            )
        );
      };
      window.addEventListener('message', this.onMessage);
      document.body.append(this.frame);
      this.timer = setTimeout(() => {
        if (this.dead) return;
        this.rejectReady(new Error('The plugin did not start within 8 seconds.'));
      }, 8000);
    }
    async start() {
      await this.ready.finally(() => clearTimeout(this.timer));
    }
    invoke(name, args) {
      if (this.dead) return Promise.reject(new Error('The plugin is not running.'));
      const id = ++this.serial;
      return new Promise((resolve, reject) => {
        // A plugin that never answers must not leave the page waiting forever.
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('The plugin did not answer within 20 seconds.'));
        }, 20000);
        this.pending.set(id, {
          resolve: value => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: error => {
            clearTimeout(timer);
            reject(error);
          },
        });
        this.frame.contentWindow?.postMessage({__agentsys: 'host', kind: 'invoke', id, name, args}, '*');
      });
    }
    emit(name, args) {
      this.frame.contentWindow?.postMessage({__agentsys: 'host', kind: 'event', name, args}, '*');
    }
    /** One API call on behalf of this plugin: with the scoped token when the server issues one, retried once after
     * the token expires or the server restarts. */
    async sendRequest(method, path, body, query) {
      if (this.dead) throw new Error('The plugin is not running.');
      const upper = String(method || 'GET').toUpperCase();
      if (!this.token && typeof Environment.pluginToken === 'function') {
        try {
          this.token = await Environment.pluginToken(this.capabilities);
        } catch {
          this.token = null;
        }
      }
      const send = () => Environment.request(upper, path, {body, query, auth: this.token || undefined});
      try {
        return await send();
      } catch (error) {
        if (this.token && ['plugin_token_expired', 'plugin_token_invalid'].includes(error.code)) {
          this.token = null;
          try {
            this.token = await Environment.pluginToken(this.capabilities, {refresh: true});
          } catch {
            this.token = null;
          }
          return send();
        }
        throw error;
      }
    }
    async receive(data) {      const plugin = this.plugin;
      switch (data.kind) {
        case 'request': {
          const [method, path, body, query] = data.args || [];
          const clean = String(path || '').replace(/^\/+/, '');
          if (clean.startsWith('auth/') || clean === 'auth')
            throw new Error('A client plugin cannot use authentication endpoints');
          // The capability of the call is decided from the method, the path and (for net) the body, not from the
          // plugin's claim: the host is the one that sends it.
          if (typeof PluginCapabilities !== 'undefined') {
            const decision = PluginCapabilities.check(
              this.capabilities,
              String(method || 'GET').toUpperCase(),
              clean,
              body
            );
            if (!decision.ok) throw new Error(decision.reason);
          }
          // The server enforces the same capabilities on a token scoped to this plugin. An older server does not
          // issue one; the host-side check above is then the whole boundary.
          return this.sendRequest(String(method || 'GET').toUpperCase(), clean, body, query);
        }
        case 'storage.get':
          return PluginStore.storage(plugin.id).get(data.args?.[0], data.args?.[1]);
        case 'storage.set':
          PluginStore.storage(plugin.id).set(data.args?.[0], data.args?.[1]);
          return true;
        case 'storage.remove':
          PluginStore.storage(plugin.id).remove(data.args?.[0]);
          return true;
        case 'ui.addPage': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'page id');
          if (findPage(plugin.id, spec.id)) throw new Error(`The page "${spec.id}" is already registered`);
          if (!spec.hasRender) throw new Error('A page needs a render(context) function');
          const page = {
            plugin: plugin.id,
            id: spec.id,
            title: spec.title || spec.id,
            description: spec.description || '',
            icon: spec.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
            render: async (root, context) => {
              root.innerHTML = sanitizeHTML(
                await this.invoke('page:' + spec.id, [JSON.parse(JSON.stringify(context || {}))])
              );
            },
          };
          pages.push(page);
          const navItem =
            spec.nav === false
              ? null
              : {
                  plugin: plugin.id,
                  id: 'nav:' + page.id,
                  page: page.id,
                  href: pageHref(plugin.id, page.id),
                  title: page.title,
                  icon: page.icon,
                  order: page.order,
                };
          if (navItem) sidebarItems.push(navItem);
          return true;
        }
        case 'ui.addSidebarItem': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'sidebar item id');
          if (sidebarItems.some(item => item.plugin === plugin.id && item.id === spec.id))
            throw new Error(`The sidebar item "${spec.id}" is already registered`);
          if (!spec.href && !spec.page) throw new Error('A sidebar item needs an href or a page');
          sidebarItems.push({
            plugin: plugin.id,
            id: spec.id,
            page: spec.page,
            href: spec.page ? pageHref(plugin.id, spec.page) : internalHref(spec.href),
            title: spec.title || spec.id,
            icon: spec.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.addCommand': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'command id');
          const key = `${plugin.id}:${spec.id}`;
          commands.set(key, {
            key,
            plugin: plugin.id,
            id: spec.id,
            title: spec.title || spec.id,
            icon: spec.icon || '',
            order: Number(spec.order) || 0,
            run: (...args) => this.invoke('command:' + spec.id, args),
          });
          return true;
        }
        case 'ui.addToolbarButton': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'toolbar button id');
          if (!spec.command) throw new Error('A toolbar button needs a command');
          toolbarButtons.push({
            plugin: plugin.id,
            id: spec.id,
            title: spec.title || spec.command,
            icon: spec.icon || plugin.icon || 'plug',
            command: spec.command,
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.addMenuItem': {
          const spec = data.args?.[0] || {};
          if (typeof spec.menu !== 'string' || !spec.menu.trim()) throw new Error('A menu item needs a menu');
          if (typeof spec.label !== 'string' || !spec.label.trim()) throw new Error('A menu item needs a label');
          checkId(spec.command, 'command');
          menuContributions.push({
            plugin: plugin.id,
            menu: spec.menu,
            label: spec.label,
            icon: spec.icon || '',
            command: spec.command,
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.addHomeCard': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'dashboard card id');
          if (!spec.hasRender) throw new Error('A dashboard card needs a render() function');
          homeCards.push({
            plugin: plugin.id,
            id: spec.id,
            title: spec.title || plugin.title,
            icon: spec.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
            render: async root => {
              root.innerHTML = sanitizeHTML(await this.invoke('home:' + spec.id, []));
            },
          });
          return true;
        }
        case 'ui.addStyles': {
          const css = String(data.args?.[0] || '');
          if (css.length > 100000) throw new Error('Styles are too large');
          if (/@import|url\s*\(|expression\s*\(|javascript:/i.test(css))
            throw new Error('Plugin styles cannot load external resources');
          const node = document.createElement('style');
          node.dataset.plugin = plugin.id;
          node.textContent = css;
          document.head.append(node);
          if (!styleNodes.has(plugin.id)) styleNodes.set(plugin.id, []);
          styleNodes.get(plugin.id).push(node);
          return true;
        }
        case 'commands.execute': {
          const [id, ...args] = data.args || [];
          // A plugin runs its own commands: a plugin id is not a way to reach another plugin's command.
          const name = String(id ?? '');
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name))
            throw new Error('A plugin can only run a command of its own, by name');
          return execute(`${plugin.id}:${name}`, ...args);
        }
        case 'notify': {
          const notification = data.args?.[0] || {};
          return api('notifications', {
            method: 'POST',
            body: {...notification, source: notification.source || 'plugin:' + plugin.id},
          });
        }
        case 'toast':
          toast(String(data.args?.[0] || ''), !!data.args?.[1]);
          return true;
        case 'navigate':
          go(String(data.args?.[0] || '/')).catch(fail);
          return true;
        case 'refresh':
          render().catch(fail);
          return true;
        case 'env.info':
          return {
            ...Environment.status().environment,
            protocol: globalThis.AgentSysProtocol?.PROTOCOL,
            status: Environment.status().status,
          };
        case 'log':
          console.info(`[${plugin.id}]`, ...(data.args || []));
          return true;
        case 'settings.get':
          return PluginStore.storage(plugin.id).get('settings', {});
        case 'settings.set':
          PluginStore.storage(plugin.id).set('settings', data.args?.[0] || {});
          return true;
        default:
          throw new Error('Unknown plugin call: ' + data.kind);
      }
    }
    dispose() {
      this.dead = true;
      clearTimeout(this.timer);
      // A disabled plugin's scoped token ends now, not when it happens to expire.
      if (this.token && typeof Environment !== 'undefined' && typeof Environment.revokePluginToken === 'function')
        Environment.revokePluginToken(this.token);
      this.token = null;
      window.removeEventListener('message', this.onMessage);
      this.frame.remove();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      for (const pending of this.pending.values()) pending.reject(new Error('The plugin stopped.'));
      this.pending.clear();
    }
    api() {
      return {
        id: this.plugin.id,
        capabilities: this.capabilities.slice(),
        request: (method, path, body, query) => {
          const decision =
            typeof PluginCapabilities === 'undefined'
              ? {ok: true}
              : PluginCapabilities.check(this.capabilities, String(method || 'GET').toUpperCase(), path, body);
          if (!decision.ok) return Promise.reject(new Error(decision.reason));
          return this.sendRequest(String(method || 'GET').toUpperCase(), String(path || '').replace(/^\/+/, ''), body, query);
        },
      };
    }
  }

  function sandboxDocument(plugin) {
    const source = JSON.stringify(plugin.source).replace(/</g, '\\u003c');
    const config = JSON.stringify({
      id: plugin.id,
      title: plugin.title,
      description: plugin.description,
      icon: plugin.icon,
      version: plugin.version,
      capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities : [],
    }).replace(/</g, '\\u003c');
    return `<!doctype html><meta charset="utf-8"><script>
(() => {
  const plugin = ${config};
  const handlers = new Map();
  const changeListeners = new Set();
  const pending = new Map();
  let serial = 0;
  const send = (kind, args) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, {resolve, reject});
    parent.postMessage({__agentsys: 'plugin', kind, id, args}, '*');
  });
  addEventListener('message', event => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.__agentsys !== 'host') return;
    if (message.kind === 'result') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
      return;
    }
    if (message.kind === 'event' && message.name === 'change') {
      for (const listener of changeListeners) { try { listener(...(message.args || [])); } catch (error) { console.error(error); } }
      return;
    }
    if (message.kind === 'invoke') {
      const handler = handlers.get(message.name);
      Promise.resolve()
        .then(() => (handler ? handler(...(message.args || [])) : undefined))
        .then(value => {
          if (value && typeof value === 'object' && typeof value.outerHTML === 'string') value = value.outerHTML;
          parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: message.id, value: value == null ? '' : String(value)}, '*');
        }, error => parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: message.id, error: error.message || String(error)}, '*'));
    }
  });
  const call = (method, path, body, query) => send('host.request', [method, path, body, query]);
  const api = {
    id: plugin.id, title: plugin.title, description: plugin.description, icon: plugin.icon,
    capabilities: plugin.capabilities || [],
    signal: new AbortController().signal,
    log: (...args) => parent.postMessage({__agentsys: 'plugin', kind: 'log', args: args.map(String)}, '*'),
    request: (method, path, body, query) => send('request', [method, path, body, query]),
    storage: {
      get: (key, fallback = null) => send('storage.get', [key, fallback]),
      set: (key, value) => send('storage.set', [key, value]),
      remove: key => send('storage.remove', [key]),
    },
    settings: {
      get: () => send('settings.get', []),
      set: value => send('settings.set', [value]),
    },
    commands: {
      register(command, handler, meta = {}) {
        const id = String(command);
        handlers.set('command:' + id, handler);
        return send('ui.addCommand', [{id, title: meta.title || id, icon: meta.icon, order: meta.order}]);
      },
      execute: (command, ...args) => send('commands.execute', [String(command), ...args]),
    },
    ui: {
      addPage(spec = {}) {
        if (typeof spec.render === 'function') handlers.set('page:' + spec.id, spec.render);
        return send('ui.addPage', [{id: spec.id, title: spec.title, description: spec.description, icon: spec.icon, order: spec.order, nav: spec.nav, hasRender: typeof spec.render === 'function'}]);
      },
      addSidebarItem: spec => send('ui.addSidebarItem', [spec]),
      addToolbarButton: spec => send('ui.addToolbarButton', [spec]),
      addMenuItem: (menu, item) => send('ui.addMenuItem', [{...item, menu}]),
      addHomeCard(spec = {}) {
        if (typeof spec.render === 'function') handlers.set('home:' + spec.id, spec.render);
        return send('ui.addHomeCard', [{id: spec.id, title: spec.title, icon: spec.icon, order: spec.order, hasRender: typeof spec.render === 'function'}]);
      },
      addStyles: css => send('ui.addStyles', [css]),
      escape: value =>
        String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]),
      notify: notification => send('notify', [notification]),
      toast: (message, bad = false) => send('toast', [message, bad]),
      navigate: path => send('navigate', [path]),
      refresh: () => send('refresh', []),
      pageHref: id => '/ext/' + encodeURIComponent(plugin.id) + '/' + encodeURIComponent(id),
    },
    env: {info: () => send('env.info', [])},
    onDidChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    on(event, listener) {
      if (event !== 'change') throw new Error('Unknown event: ' + event);
      return api.onDidChange(listener);
    },
  };
  let exports = {};
  try {
    const module = {exports};
    new Function('exports', 'module', 'api', ${source})(module.exports, module, api);
    exports = module.exports;
    if (typeof exports.activate !== 'function') throw new Error('The plugin must export activate(api)');
    Promise.resolve(exports.activate(api)).then(
      () => parent.postMessage({__agentsys: 'plugin', kind: 'ready', ok: true}, '*'),
      error => parent.postMessage({__agentsys: 'plugin', kind: 'ready', error: error.message || String(error)}, '*')
    );
  } catch (error) {
    parent.postMessage({__agentsys: 'plugin', kind: 'ready', error: error.message || String(error)}, '*');
  }
})();
</script>`;
  }

  function cleanupRegistrations(id) {
    removeWhere(pages, p => p.plugin === id);
    removeWhere(sidebarItems, item => item.plugin === id);
    removeWhere(toolbarButtons, item => item.plugin === id);
    removeWhere(menuContributions, item => item.plugin === id);
    removeWhere(homeCards, item => item.plugin === id);
    for (const key of [...commands.keys()]) if (commands.get(key).plugin === id) commands.delete(key);
    for (const node of styleNodes.get(id) || []) node.remove();
    styleNodes.delete(id);
    document.body.classList.remove('plugin-' + cssId(id));
  }

  function removeModule(id, callDeactivate) {
    const entry = loaded.get(id);
    if (entry) {
      // deactivate runs in the sandbox before it is removed; failures are reported, not thrown.
      if (callDeactivate) entry.sandbox.dead = true;
      entry.sandbox.dispose();
      loaded.delete(id);
    }
    cleanupRegistrations(id);
  }

  async function loadModule(plugin) {
    let sandbox;
    try {
      sandbox = new PluginSandbox(plugin);
      await sandbox.start();
      loaded.set(plugin.id, {plugin, sandbox, disposables: []});
      document.body.classList.add('plugin-' + cssId(plugin.id));
      errors.delete(plugin.id);
      failed.delete(plugin.id);
    } catch (error) {
      sandbox?.dispose();
      errors.set(plugin.id, error.message || String(error));
      failed.add(plugin.id);
      console.error(`[plugins] ${plugin.id}: the interface could not start:`, error);
      if (typeof toast === 'function')
        toast(`The interface of ${plugin.title || plugin.id} could not start: ${error.message}`, true);
      removeModule(plugin.id, false);
    }
  }

  /** Activates enabled plugins and removes those that stopped. Never throws. */
  async function sync(plugins) {
    if (loading) return loading;
    loading = (async () => {
      let list = plugins;
      if (!list) {
        try {
          await PluginStore.load();
          list = PluginStore.list();
        } catch (error) {
          console.error('[plugins] could not list the client plugins:', error);
          return;
        }
      }
      app.plugins = list;
      const wanted = new Map(list.filter(p => p.enabled).map(p => [p.id, p]));
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

  async function reload(plugins) {
    if (loading) await loading;
    failed.clear();
    for (const id of [...loaded.keys()]) removeModule(id, true);
    renderAll();
    return sync(plugins);
  }

  function execute(key, ...args) {
    const command = commands.get(key);
    if (!command) {
      fail(new Error(`Unknown command: ${key}`));
      return Promise.reject(new Error(`Unknown command: ${key}`));
    }
    return Promise.resolve(command.run(...args)).catch(error => {
      fail(error);
      throw error;
    });
  }

  // ----- drawing what plugins registered -----
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
      Promise.resolve()
        .then(() => item.render(body))
        .catch(error => {
          body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
          console.error(`[plugins] ${item.plugin}: dashboard card failed:`, error);
        });
    }
    section.append(grid);
    host.append(section);
  }

  /** The small DOM builder is kept for pages written by the application itself. */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null) continue;
      if (key === 'class' || key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false) node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function renderAll() {
    renderSidebarItems();
    renderToolbar();
    const route = typeof app === 'undefined' ? null : app.route;
    if (route && typeof renderSidebar === 'function') renderSidebar();
    if (route?.page === 'home') render().catch(fail);
    else if (route?.page === 'ext' && typeof render === 'function') render().catch(fail);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-ext-command]');
    if (!button) return;
    event.preventDefault();
    execute(button.dataset.extCommand).catch(() => {});
  });

  const publicCommand = command => ({
    key: command.key,
    id: command.id,
    title: command.title,
    icon: command.icon,
    plugin: command.plugin,
    pluginTitle: pluginTitle(command.plugin),
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
    sectionTitle: section => (section.startsWith('ext:') ? pluginTitle(section.slice(4)) : 'Navigation'),
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
    apiOf: id => loaded.get(id)?.sandbox.api() || null,
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
