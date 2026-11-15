// The client extension host. Plugins are installed in this browser (js/app/plugin-store.js) and run inside a
// sandboxed iframe with an opaque origin: they cannot read this page's DOM, storage, cookies or server token.
// They talk to the host through a small message API: request(), storage, commands and declarative UI registrations.
//
// Lifecycle: a package is installed, enabled, reloaded, updated and removed here. The sandbox runs activate(api),
// deactivate(api) and the optional onInstall / onUpdate / onUninstall / migrate hooks. Every registration and every
// timer belongs to one sandbox and is dropped with it.
//
// This is an isolation boundary for convenience plugins, not a hardened boundary against a malicious program:
// an installed plugin can call the same API this user can, within its declared capabilities. See docs/plugins.md.
'use strict';

const Extensions = (() => {
  const loaded = new Map(); // plugin id -> sandbox
  const errors = new Map();
  const sidebarItems = [];
  const toolbarButtons = [];
  const menuContributions = [];
  const views = new PluginViews();
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
  const pagesOf = id => views.pages(id);
  const findPage = (plugin, id) => views.page(plugin, id);
  const pageHref = (plugin, id) => PluginViews.href(plugin, id);
  const pluginTitle = id => (typeof app !== 'undefined' && app.plugins?.find(p => p.id === id)?.title) || id;
  const cssId = id => String(id).replace(/[^A-Za-z0-9_-]/g, '-');

  const sanitizeHTML = value => PluginContent.sanitize(value);
  const internalHref = value => PluginContent.internalHref(value);

  /** One sandboxed iframe per plugin: no same-origin access, no direct DOM, storage or token. */
  class PluginSandbox {
    constructor(plugin, context = {}) {
      this.plugin = plugin;
      this.capabilities = PluginCapabilities.forPlugin(plugin);
      this.pending = new Map();
      this.serial = 0;
      this.dead = false;
      this.stopping = false;
      this.requests = new AbortController();
      this.token = null; // a server-issued token scoped to this plugin's capabilities
      this.dataVersion = Number(plugin.dataVersion) || 0;
      this.onCrash = null;
      this.readyDone = false;
      this.loads = 0;
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.frame = document.createElement('iframe');
      this.frame.title = `Plugin ${plugin.id}`;
      this.frame.setAttribute('sandbox', 'allow-scripts');
      this.frame.setAttribute('aria-hidden', 'true');
      this.frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:0;border:0;';
      this.url = URL.createObjectURL(new Blob([PluginFrame.document(plugin, context)], {type: 'text/html'}));
      this.frame.src = this.url;
      // A second document load after the plugin is running means the frame navigated or crashed: stop it rather than
      // keeping a half-alive sandbox that no longer matches the installed package.
      this.frame.addEventListener('load', () => {
        this.loads++;
        if (this.loads > 1 && this.readyDone && Date.now() - this.startedAt > 1000 && !this.dead)
          this.crash(new Error('The plugin frame stopped unexpectedly. Use Try again to restart it.'));
      });
      this.onMessage = event => {
        if (this.dead || event.source !== this.frame.contentWindow) return;
        // The blob document has an opaque origin. If the frame navigated to a real page, its messages carry that
        // page's origin and must not be mistaken for the installed plugin.
        if (event.origin !== 'null') return;
        const data = event.data;
        if (!data || data.__agentsys !== 'plugin') return;
        if (data.kind === 'unloading') {
          this.crash(new Error('The plugin frame stopped unexpectedly. Use Try again to restart it.'));
          return;
        }
        if (data.kind === 'ready') {
          if (data.error) this.rejectReady(new Error(data.error));
          else if (data.ok) {
            this.readyDone = true;
            this.startedAt = Date.now();
            this.dataVersion = Number(data.dataVersion) || this.dataVersion;
            this.resolveReady({dataVersion: this.dataVersion});
          }
          return;
        }
        if (data.kind === 'invoke-result' || data.kind === 'hook-result') {
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
      try {
        return await this.ready;
      } finally {
        clearTimeout(this.timer);
      }
    }
    post(kind, name, args) {
      if (this.dead) return Promise.reject(new Error('The plugin is not running.'));
      const id = ++this.serial;
      return new Promise((resolve, reject) => {
        // A plugin that never answers must not leave the page waiting forever.
        const timer = setTimeout(() => {
          this.pending.delete(id);
          const error = new Error('The plugin did not answer within 20 seconds.');
          this.crash(error);
          reject(error);
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
        this.frame.contentWindow?.postMessage({__agentsys: 'host', kind, id, name, args}, '*');
      });
    }
    invoke(name, args) {
      return this.post('invoke', name, args);
    }
    /** Calls a lifecycle hook in the sandbox. A plugin that never answers is stopped, not left running. */
    async lifecycle(name, context = {}, {allowRequests = false} = {}) {
      if (this.dead || this.stopping) return undefined;
      this.stopping = !allowRequests;
      let timer;
      try {
        return await Promise.race([
          this.post('lifecycle', name, context),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`The plugin did not finish ${name} within 3 seconds.`)), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.stopping = false;
      }
    }
    emit(name, args) {
      this.frame.contentWindow?.postMessage({__agentsys: 'host', kind: 'event', name, args}, '*');
    }
    /** One API call on behalf of this plugin, checked against its capabilities, with the scoped token when the
     * server issues one and retried once after that token expires or the server restarts. */
    async sendRequest(method, path, body, query) {
      this.inFlight = (this.inFlight || 0) + 1;
      try { return await this.performRequest(method, path, body, query); }
      finally { this.inFlight--; }
    }
    async performRequest(method, path, body, query) {
      const gen = Environment.generation();
      const ensureRunning = () => {
        if (this.dead || this.stopping) throw new Error('The plugin is not running.');
        if (gen !== Environment.generation()) throw new Error('The environment changed.');
      };
      const acquire = async refresh => {
        const token = await Environment.pluginToken(this.capabilities, {owner: this.plugin.id, refresh});
        if (this.dead || this.stopping || gen !== Environment.generation()) {
          Environment.revokePluginToken(token);
          ensureRunning();
        }
        this.token = token;
      };
      ensureRunning();
      const upper = String(method || 'GET').toUpperCase();
      if (!this.token) await acquire(false);
      const send = () => {
        ensureRunning();
        return Environment.request(upper, path, {body, query, auth: this.token || undefined, signal: this.requests.signal});
      };
      const usedToken = this.token;
      try {
        return await send();
      } catch (error) {
        if (!usedToken || !['plugin_token_expired', 'plugin_token_invalid'].includes(error.code)) throw error;
        ensureRunning();
        // Another request may already have renewed this sandbox's token while this response was in flight.
        if (this.token === usedToken) await acquire(true);
        return send();
      }
    }
    /** The capability boundary for direct host helpers (resource deployment): same rules as api.request. */
    async checkedRequest(method, path, body, query) {
      const clean = String(path || '').replace(/^\/+/, '');
      if (clean.startsWith('auth/') || clean === 'auth')
        throw new Error('A client plugin cannot use authentication endpoints');
      const decision = PluginCapabilities.check(this.capabilities, String(method || 'GET').toUpperCase(), clean, body);
      if (!decision.ok) throw new Error(decision.reason);
      return this.sendRequest(String(method || 'GET').toUpperCase(), clean, body, query);
    }
    async receive(data) {
      const plugin = this.plugin;
      const viewKinds = {
        'ui.addPage': 'page', 'ui.addLibrarySection': 'library', 'ui.addHomeCard': 'home',
        'ui.addSettingsSection': 'settings', 'ui.addInspectorSection': 'inspector', 'ui.addResourceView': 'resource',
      };
      if (Object.hasOwn(viewKinds, data.kind)) return views.add(viewKinds[data.kind], data.args?.[0] || {}, this);
      switch (data.kind) {
        case 'request': {
          const [method, path, body, query] = data.args || [];
          return this.checkedRequest(method, path, body, query);
        }
        case 'storage.get':
          return PluginStore.storage(plugin.id).get(data.args?.[0], data.args?.[1]);
        case 'storage.set':
          PluginStore.storage(plugin.id).set(data.args?.[0], data.args?.[1]);
          return true;
        case 'storage.remove':
          PluginStore.storage(plugin.id).remove(data.args?.[0]);
          return true;
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
            title: String(spec.title || spec.id).slice(0, 120),
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
            title: String(spec.title || spec.id).slice(0, 120),
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
            title: String(spec.title || spec.command).slice(0, 120),
            icon: spec.icon || plugin.icon || 'plug',
            command: spec.command,
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.addMenuItem': {
          const spec = data.args?.[0] || {};
          if (typeof spec.menu !== 'string' || !spec.menu.trim() || spec.menu.length > 80)
            throw new Error('A menu item needs a menu');
          if (typeof spec.label !== 'string' || !spec.label.trim() || spec.label.length > 120)
            throw new Error('A menu item needs a label');
          checkId(spec.command, 'command');
          if (menuContributions.length > 200) throw new Error('Too many menu items');
          menuContributions.push({
            plugin: plugin.id,
            menu: spec.menu.slice(0, 80),
            label: spec.label.slice(0, 120),
            icon: spec.icon || '',
            command: spec.command,
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.showDialog':
          return this.showDialog(data.args?.[0] || {});
        case 'ui.closeDialog':
          if (typeof $('#modal')?.close === 'function') $('#modal').close();
          return true;
        case 'ui.addStyles': {
          const css = String(data.args?.[0] || '');
          if (css.length > 100000) throw new Error('Styles are too large');
          if (PluginContent.unsafeCSS(css))
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
          const body = {...notification, source: notification.source || 'plugin:' + plugin.id};
          return this.checkedRequest('POST', 'notifications', body);
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
    /** A dialog drawn by the host with the plugin's passive body and its own commands as actions. */
    showDialog(spec) {
      const plugin = this.plugin;
      const title = String(spec.title || plugin.title).slice(0, 120);
      const body = sanitizeHTML(String(spec.body ?? spec.html ?? ''));
      const actions = (Array.isArray(spec.actions) ? spec.actions : [])
        .slice(0, 8)
        .map((action, index) => ({
          index,
          id: String(action.id || action.label || index).slice(0, 80),
          label: String(action.label || 'OK').slice(0, 80),
          command: action.command ? String(action.command) : '',
          args: Array.isArray(action.args) ? action.args : [],
          variant: ['primary', 'secondary', 'danger'].includes(action.variant) ? action.variant : '',
        }));
      const buttons = actions.length
        ? `<div class="button-row">${actions
            .map(
              action =>
                `<button type="button" data-plugin-dialog-action="${action.index}" class="${action.variant === 'danger' ? 'danger' : action.variant === 'primary' ? 'primary' : ''}">${esc(action.label)}</button>`
            )
            .join('')}</div>`
        : '';
      return new Promise(resolve => {
        const modal = $('#modal');
        let finished = false;
        let actionPending = false;
        const finish = value => {
          if (finished) return;
          finished = true;
          modal.removeEventListener('click', onClick);
          modal.removeEventListener('close', onClose);
          this.requests.signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish({action: null});
        const onClose = () => {
          if (!actionPending) finish({action: null});
        };
        const onClick = event => {
          const button = event.target.closest?.('[data-plugin-dialog-action]');
          if (!button) return;
          const action = actions[Number(button.dataset.pluginDialogAction)];
          if (!action) return;
          event.preventDefault();
          actionPending = true;
          const close = spec.close !== false;
          const values = Object.fromEntries(new FormData($('#modal-form')).entries());
          if (close) modal.close();
          if (!action.command) {
            actionPending = false;
            return finish({action: action.id, values});
          }
          Promise.resolve(execute(`${plugin.id}:${action.command}`, values, ...action.args)).then(
            result => finish({action: action.id, result: result === undefined ? null : result, values}),
            error => finish({action: action.id, error: error.message || String(error), values})
          );
        };
        dialog(title, body + buttons, null);
        modal.addEventListener('click', onClick);
        if (spec.close !== false) modal.addEventListener('close', onClose);
        this.requests.signal.addEventListener('abort', onAbort, {once: true});
      });
    }
    /** Runs the deactivate hook, then removes the frame. A plugin cannot act after this returns. */
    async stop(hook = 'deactivate', context = {}) {
      if (this.dead) return;
      try {
        if (hook === 'onUninstall') {
          // A cleanup hook may still use the API before the sandbox is removed; deactivate is the last call and
          // cannot start new work.
          await this.lifecycle('onUninstall', context, {allowRequests: true});
          await this.lifecycle('deactivate', {});
        } else if (hook) await this.lifecycle(hook, context);
      } finally {
        this.dispose();
      }
    }
    crash(error) {
      if (this.dead) return;
      this.dead = true;
      this.dispose();
      if (this.onCrash) this.onCrash(error);
    }
    dispose() {
      this.dead = true;
      this.requests.abort();
      clearTimeout(this.timer);
      // A disabled plugin's scoped token ends now, not when it happens to expire.
      if (this.token)
        Environment.revokePluginToken(this.token);
      this.token = null;
      window.removeEventListener('message', this.onMessage);
      try {
        this.frame.contentWindow?.postMessage({__agentsys: 'host', kind: 'shutdown'}, '*');
      } catch {}
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
        request: (method, path, body, query) => this.checkedRequest(method, path, body, query),
        library: {
          list: () => this.checkedRequest('GET', 'resources'),
        },
      };
    }
  }

  function cleanupRegistrations(id) {
    views.remove(id);
    removeWhere(sidebarItems, item => item.plugin === id);
    removeWhere(toolbarButtons, item => item.plugin === id);
    removeWhere(menuContributions, item => item.plugin === id);
    for (const key of [...commands.keys()]) if (commands.get(key).plugin === id) commands.delete(key);
    for (const node of styleNodes.get(id) || []) node.remove();
    styleNodes.delete(id);
    document.body.classList.remove('plugin-' + cssId(id));
  }

  /** Stops one plugin: its deactivate hook runs, its registrations, styles and scoped token go. */
  async function stopModule(id, hook = 'deactivate', context = {}) {
    const entry = loaded.get(id);
    if (entry) {
      try {
        await entry.stop(hook, context);
      } catch (error) {
        console.error(`[plugins] ${id}: ${hook} failed:`, error);
      }
      loaded.delete(id);
    }
    cleanupRegistrations(id);
  }

  async function loadModule(plugin, hook = 'activate', from = null) {
    let sandbox;
    try {
      const context = {hook, from, to: plugin.version, dataVersion: plugin.dataVersion || 0};
      sandbox = new PluginSandbox(plugin, context);
      const ready = await sandbox.start();
      sandbox.onCrash = error => {
        errors.set(plugin.id, error.message || String(error));

        cleanupRegistrations(plugin.id);
        loaded.delete(plugin.id);
        renderAll();
      };
      loaded.set(plugin.id, sandbox);
      document.body.classList.add('plugin-' + cssId(plugin.id));
      errors.delete(plugin.id);

      PluginStore.markActivated(plugin.id, plugin.version, ready?.dataVersion);
      return true;
    } catch (error) {
      sandbox?.dispose();
      errors.set(plugin.id, error.message || String(error));

      console.error(`[plugins] ${plugin.id}: the interface could not start:`, error);
      if (typeof toast === 'function')
        toast(`The interface of ${plugin.title || plugin.id} could not start: ${error.message}`, true);
      cleanupRegistrations(plugin.id);
      return false;
    }
  }

  const hookFor = plugin => {
    if (!plugin.activatedVersion) return {hook: 'install', from: null};
    if (plugin.activatedVersion !== plugin.version) return {hook: 'update', from: plugin.activatedVersion};
    return {hook: 'activate', from: null};
  };

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
      for (const id of [...loaded.keys()]) if (!wanted.has(id)) await stopModule(id, 'deactivate');
      for (const id of [...errors.keys()]) if (!wanted.has(id)) errors.delete(id);

      // A dependency that was turned off (or removed) takes its dependants down with it, even if they are
      // already running: a plugin must not keep using a service that is no longer enabled.
      for (const plugin of wanted.values()) {
        if (!loaded.has(plugin.id)) continue;
        const deps = PluginManifest.checkDependencies(plugin, list, {requireEnabled: true});
        if (deps.ok) continue;
        await stopModule(plugin.id, 'deactivate');
        errors.set(plugin.id, deps.errors.map(item => item.message).join(' '));
      }

      const sorted = PluginManifest.activationOrder([...wanted.values()]);
      for (const problem of sorted.errors) {
        if (errors.has(problem.id)) continue;
        errors.set(problem.id, problem.message);
        console.error(`[plugins] ${problem.id}: ${problem.message}`);
      }
      const order = sorted.order;
      for (const plugin of order) {
        if (loaded.has(plugin.id) || errors.has(plugin.id)) continue;
        const deps = PluginManifest.checkDependencies(plugin, list, {requireEnabled: true});
        if (!deps.ok) {
          errors.set(plugin.id, deps.errors.map(item => item.message).join(' '));
          continue;
        }
        const {hook, from} = hookFor(plugin);
        await loadModule(plugin, hook, from);
      }
      renderAll();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function reload(plugins) {
    if (loading) await loading;

    errors.clear();
    for (const id of [...loaded.keys()]) await stopModule(id, 'deactivate');
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

  // ----- lifecycle actions used by the Plugins page and tests -----
  async function install(value, options) {
    const id = value?.manifest?.id || value?.id;
    const previous = id ? PluginStore.record(id) : null;
    const plugin = PluginStore.install(value, options);
    await reload();
    const problem = errors.get(plugin.id);
    if (problem) {
      // A package that cannot start does not stay installed over a working one.
      if (previous) PluginStore.install(previous, {allowDowngrade: true, approveCapabilities: true});
      else PluginStore.remove(plugin.id);
      await reload();
      throw new ApiError('plugin_activation_failed', `${plugin.title || plugin.id} could not start: ${problem}`, 500);
    }
    return plugin;
  }

  async function update(id, value, options) {
    const previous = PluginStore.record(id);
    if (!previous) throw new ApiError('not_found', 'Plugin not found', 404);
    const plugin = PluginStore.update(id, value, options);
    await reload();
    const problem = errors.get(id);
    if (problem) {
      PluginStore.install(previous, {allowDowngrade: true, approveCapabilities: true});
      await reload();
      throw new ApiError('plugin_update_failed', `${plugin.title || id} could not be updated: ${problem}`, 500);
    }
    return plugin;
  }

  async function uninstall(id) {
    const record = PluginStore.record(id);
    if (!record) throw new ApiError('not_found', 'Plugin not found', 404);
    await stopModule(id, 'onUninstall', {version: record.version});
    PluginStore.clear(id);
    PluginStore.remove(id);
    errors.delete(id);
    renderAll();
    return true;
  }

  async function disable(id) {
    const plugin = PluginStore.setEnabled(id, false);
    await stopModule(id, 'deactivate');
    errors.delete(id);
    await sync();
    renderAll();
    return plugin;
  }

  async function enable(id) {
    const plugin = PluginStore.setEnabled(id, true);
    errors.delete(id);
    await sync();
    if (errors.has(id)) throw new ApiError('plugin_activation_failed', errors.get(id), 500);
    return plugin;
  }

  async function recover(id) {
    errors.delete(id);
    await sync();
    return !errors.has(id);
  }

  /** Deploys the package's declared server resources through this plugin's checked capabilities. */
  async function deploymentPlan(id) {
    const entry = loaded.get(id);
    if (!entry) throw new ApiError('plugin_not_running', 'Turn the plugin on before planning deployment.', 409);
    return PluginDeploy.plan(PluginStore.record(id), {
      request: (method, path, body, query) => entry.checkedRequest(method, path, body, query),
    });
  }

  async function deploy(id, {force = false} = {}) {
    const entry = loaded.get(id);
    if (!entry) throw new ApiError('plugin_not_running', 'Turn the plugin on before deploying its resources.', 409);
    const record = PluginStore.record(id);
    if (!record) throw new ApiError('not_found', 'Plugin not found', 404);
    const storage = PluginStore.hostStorage(id);
    const key = '__agentsys:deployment';
    const state = storage.get(key, null);
    if (typeof PluginDeploy === 'undefined')
      throw new ApiError('internal_error', 'The deployment module is not loaded.', 500);
    const result = await PluginDeploy.deploy(record, {
      request: (method, path, body, query) => entry.checkedRequest(method, path, body, query),
      state,
      environment: storage.environment,
      force,
      log: message => console.info('[plugins]', message),
    });
    storage.set(key, result.state);
    return result;
  }

  function deploymentOf(id) {
    const storage = PluginStore.hostStorage(id);
    return typeof PluginDeploy === 'undefined'
      ? {deployed: false, counts: {collections: 0, library: 0, workflows: 0}}
      : PluginDeploy.status(PluginStore.record(id), storage.get('__agentsys:deployment', null));
  }

  // ----- drawing what plugins registered -----
  function renderSidebarItems() {
    const host = typeof document === 'undefined' ? null : document.getElementById('sidebar-extensions');
    if (!host) return;
    const items = [...sidebarItems, ...views.sidebar()].sort(byOrder);
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

  function renderContribution(item, body, context) {
    Promise.resolve().then(() => item.render(body, context)).catch(error => {
      body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
      console.error(`[plugins] ${item.plugin}: ${item.kind} failed:`, error);
    });
  }

  function renderHome(host) {
    if (!host) return;
    const cards = views.list('home');
    host.innerHTML = cards.length
      ? `<section class="ext-home"><div class="section-head"><h2>Plugins</h2></div><div class="cards">${cards.map(item =>
        `<article class="card" data-ext-home="${esc(item.plugin + ':' + item.id)}"><div class="card-main"><header class="card-head"><span class="head-icon">${icon(item.icon)}</span><h3>${esc(item.title)}</h3></header><div class="card-preview card-note"></div></div></article>`
      ).join('')}</div></section>` : '';
    $$('[data-ext-home] .card-preview', host).forEach((body, i) => renderContribution(cards[i], body));
  }

  /** Settings and Inspector sections share rendering and failure handling. */
  function renderSections(host, items, kind, context) {
    host.innerHTML = items.map(item =>
      `<section class="${kind === 'settings' ? 'plugin-settings' : 'inspector-plugin'}" data-ext-${kind}="${esc(item.plugin + ':' + item.id)}"><h2>${esc(item.title)}</h2>${kind === 'settings' && item.description ? `<p class="muted">${esc(item.description)}</p>` : ''}<div${kind === 'settings' ? ' class="plugin-settings-body"' : ''}></div></section>`
    ).join('');
    Array.from(host.children).forEach((section, i) => renderContribution(items[i], section.lastElementChild, context));
  }

  function renderSettings(host) {
    if (host) renderSections(host, views.list('settings'), 'settings');
  }

  function renderInspector(host, context = {}) {
    if (!host) return;
    const node = context.node || null;
    const kind = node?.kind === 'complex' ? 'complex' : node ? 'node' : '';
    const sections = kind ? views.list('inspector').filter(item => item.when === 'any' || item.when === kind) : [];
    host.hidden = !sections.length;
    renderSections(host, sections, 'inspector', {
      node, selection: context.selection || [], project: context.project, workflow: context.workflow,
    });
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
    let args = [];
    try {
      const parsed = JSON.parse(button.dataset.extArgs || '[]');
      if (Array.isArray(parsed)) args = parsed.slice(0, 20);
    } catch {}
    execute(button.dataset.extCommand, ...args).catch(() => {});
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
    install,
    update,
    uninstall,
    disable,
    enable,
    recover,
    deploy,
    deploymentPlan,
    deploymentOf,
    renderSidebar: renderSidebarItems,
    renderToolbar,
    renderHome,
    renderSettings,
    renderInspector,
    render: renderAll,
    sanitize: sanitizeHTML,
    page: findPage,
    pagesOf,
    pageHref,
    sectionTitle: section => (section.startsWith('ext:') ? pluginTitle(section.slice(4)) : 'Navigation'),
    sectionOf: route => (route?.page === 'ext' ? 'ext:' + route.plugin : null),
    destinations: () =>
      views.pages().map(page => ({
        label: page.title,
        hint: `Plugin · ${pluginTitle(page.plugin)}`,
        href: pageHref(page.plugin, page.id),
      })),
    commands: () => [...commands.values()].sort((a, b) => a.title.localeCompare(b.title)).map(publicCommand),
    /** Host diagnostics for bounded lifecycle tests; no credentials or plugin data. Not exposed to iframes. */
    diagnostics: () => ({
      sandboxes: loaded.size,
      pendingCallbacks: [...loaded.values()].reduce((sum, entry) => sum + entry.pending.size, 0),
      pendingRequests: [...loaded.values()].reduce((sum, entry) => sum + (entry.inFlight || 0), 0),
      commands: commands.size,
      contributions: sidebarItems.length + toolbarButtons.length + menuContributions.length +
        ['page', 'library', 'home', 'settings', 'inspector', 'resource'].reduce((sum, kind) => sum + views.list(kind).length, 0),
    }),
    execute,
    /** Plugin entries for a named menu; the menu infrastructure adds them after the application's own items. */
    menuItems(spec, args = []) {
      return menuContributions
        .filter(item => item.menu === spec)
        .sort(byOrder)
        .map(item => [
          item.label,
          () => execute(`${item.plugin}:${item.command}`, ...(Array.isArray(args) ? args : [args])),
          {icon: item.icon || undefined, disabled: !commands.has(`${item.plugin}:${item.command}`)},
        ]);
    },
    hasMenu: spec => menuContributions.some(item => item.menu === spec),
    errorOf: id => errors.get(id) || '',
    isFailed: id => errors.has(id),
    apiOf: id => loaded.get(id)?.api() || null,
    /** The Library sections client plugins registered, for the Library page and its navigation. */
    librarySections: () => views.list('library'),
    resourceViews: () => views.list('resource'),
    settingsSections: () => views.list('settings').map(item => ({...item})),
    inspectorSections: () => views.list('inspector').map(item => ({...item})),
    describe(id) {
      return {
        error: errors.get(id) || '',
        failed: errors.has(id),
        pages: pagesOf(id).map(page => ({id: page.id, title: page.title, icon: page.icon, href: pageHref(id, page.id)})),
        sidebar: [...sidebarItems, ...views.sidebar()].filter(item => item.plugin === id).map(item => item.title),
        toolbar: toolbarButtons.filter(item => item.plugin === id).map(item => item.title),
        menu: menuContributions.filter(item => item.plugin === id).map(item => `${item.menu}: ${item.label}`),
        home: views.list('home', id).map(item => item.title),
        commands: [...commands.values()].filter(item => item.plugin === id).map(item => item.title),
        settings: views.list('settings', id).map(item => item.title),
        library: views.list('library', id).map(item => item.title),
        inspector: views.list('inspector', id).map(item => item.title),
        views: views.list('resource', id).map(item => item.title),
        styles: (styleNodes.get(id) || []).length,
      };
    },
  };
})();
