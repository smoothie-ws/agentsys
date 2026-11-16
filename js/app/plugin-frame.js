// The isolated plugin program and SDK bridge. No host state or DOM access is captured here.
'use strict';
const PluginFrame = (() => {
  /** The sandbox document: a module loader, the public API object, lifecycle hooks and the message bridge. */
  function document(plugin, context) {
    const config = JSON.stringify({
      id: plugin.id,
      title: plugin.title,
      description: plugin.description,
      icon: plugin.icon,
      version: plugin.version,
      api: plugin.api,
      capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities : [],
      main: plugin.main || 'plugin.js',
      source: plugin.source,
      files: plugin.files || {},
      assets: plugin.assets || {},
      lifecycle: {
        hook: context?.hook || 'activate',
        from: context?.from || null,
        to: context?.to || plugin.version,
        dataVersion: Number(context?.dataVersion) || 0,
      },
    }).replace(/</g, '\\u003c');
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"><script>
(() => {
  const plugin = ${config};
  const handlers = new Map();
  const changeListeners = new Set();
  const pending = new Map();
  const moduleCache = new Map();
  const controller = new AbortController();
  let serial = 0;
  let exportsObject = {};
  const send = (kind, args) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, {resolve, reject});
    parent.postMessage({__agentsys: 'plugin', kind, id, args}, '*');
  });
  addEventListener('message', event => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.__agentsys !== 'host') return;
    if (message.kind === 'result' || message.kind === 'hook-result') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
      return;
    }
    if (message.kind === 'shutdown') {
      try { controller.abort(new Error('The plugin stopped')); } catch {}
      return;
    }
    if (message.kind === 'event' && message.name === 'change') {
      for (const listener of changeListeners) { try { listener(...(message.args || [])); } catch (error) { console.error(error); } }
      return;
    }
    if (message.kind === 'invoke') {
      const handler = handlers.get(message.name);
      const render = /^(?:page|home|settings|library|inspector|resource):/.test(String(message.name || ''));
      Promise.resolve()
        .then(() => (handler ? handler(...(message.args || [])) : undefined))
        .then(value => {
          if (render && value && typeof value === 'object' && typeof value.outerHTML === 'string') value = value.outerHTML;
          const answer = render ? (value == null ? '' : String(value)) : value === undefined ? null : value;
          parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: message.id, value: answer}, '*');
        }, error => parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: message.id, error: error.message || String(error)}, '*'));
      return;
    }
    if (message.kind === 'lifecycle') {
      const name = String(message.name || '');
      const hook = typeof exportsObject[name] === 'function' ? exportsObject[name] : name === 'deactivate' ? exportsObject.__activateDispose : null;
      Promise.resolve()
        .then(() => (hook ? hook(api, message.context || message.args || {}) : undefined))
        .then(value => parent.postMessage({__agentsys: 'plugin', kind: 'hook-result', id: message.id, value: value === undefined ? null : value}, '*'))
        .catch(error => parent.postMessage({__agentsys: 'plugin', kind: 'hook-result', id: message.id, error: error.message || String(error)}, '*'));
    }
  });
  addEventListener('pagehide', () => {
    // The frame is navigating away or being destroyed; the host must not keep a sandbox that is no longer this plugin.
    try { parent.postMessage({__agentsys: 'plugin', kind: 'unloading'}, '*'); } catch {}
  });
  const request = (method, path, body, query) => send('request', [method, path, body, query]);
  const resolveModule = (from, name) => {
    let request = String(name || '');
    let target;
    if (request.startsWith('.')) {
      const parts = from.split('/').slice(0, -1);
      for (const part of request.split('/')) {
        if (part === '.' || part === '') continue;
        if (part === '..') { if (!parts.length) throw new Error('A module path leaves the package: ' + name); parts.pop(); }
        else parts.push(part);
      }
      target = parts.join('/');
    } else target = request;
    if (!/\.(?:js|json)$/i.test(target)) target += '.js';
    if (!Object.prototype.hasOwnProperty.call(plugin.files, target)) throw new Error('Module not found in the package: ' + name);
    return target;
  };
  const loadModule = path => {
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    const source = path === plugin.main ? null : plugin.files[path];
    const text = source === null ? plugin.source : source;
    if (typeof text !== 'string') throw new Error('The package entry is missing: ' + path);
    const module = {exports: {}};
    moduleCache.set(path, module);
    if (/\.json$/i.test(path)) {
      try {
        module.exports = JSON.parse(text);
      } catch (error) {
        moduleCache.delete(path);
        throw new Error('Invalid JSON module ' + path + ': ' + error.message);
      }
      return module.exports;
    }
    const localRequire = name => loadModule(resolveModule(path, name));
    try {
      new Function('exports', 'module', 'require', 'api', 'console', text)(module.exports, module, localRequire, api, console);
    } catch (error) {
      moduleCache.delete(path);
      throw error;
    }
    return module.exports;
  };
  const registerView = (call, kind, spec) => {
    const hasRender = typeof spec.render === 'function';
    if (hasRender) handlers.set(kind + ':' + spec.id, spec.render);
    const fields = ['id', 'title', 'description', 'icon', 'order', 'nav', 'when', 'collection', 'sidebar'];
    return send(call, [{...Object.fromEntries(fields.map(field => [field, spec[field]])), hasRender}]);
  };
  const withOwner = spec => ({...(spec || {}), plugin: {id: plugin.id}});
  const api = {
    id: plugin.id, title: plugin.title, description: plugin.description, icon: plugin.icon,
    version: plugin.version, api: plugin.api,
    capabilities: plugin.capabilities || [],
    manifest: {
      id: plugin.id, name: plugin.title, version: plugin.version, api: plugin.api,
      capabilities: plugin.capabilities || [], icon: plugin.icon,
    },
    asset: name => Object.prototype.hasOwnProperty.call(plugin.assets, name) ? plugin.assets[name] : '',
    assets: () => ({...plugin.assets}),
    signal: controller.signal,
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
      addPage: (spec = {}) => registerView('ui.addPage', 'page', spec),
      addSidebarItem: spec => send('ui.addSidebarItem', [spec]),
      addToolbarButton: spec => send('ui.addToolbarButton', [spec]),
      addMenuItem: (menu, item) => send('ui.addMenuItem', [{...item, menu}]),
      /** A context menu entry on the canvas selection (the same registry as addMenuItem('canvas:selection')). */
      addContextMenu(item = {}) {
        return send('ui.addMenuItem', [{...item, menu: 'canvas:selection'}]);
      },
      addHomeCard: (spec = {}) => registerView('ui.addHomeCard', 'home', spec),
      addSettingsSection: (spec = {}) => registerView('ui.addSettingsSection', 'settings', spec),
      addLibrarySection: (spec = {}) => registerView('ui.addLibrarySection', 'library', spec),
      addInspectorSection: (spec = {}) => registerView('ui.addInspectorSection', 'inspector', spec),
      addResourceView: (spec = {}) => registerView('ui.addResourceView', 'resource', spec),
      showDialog: spec => send('ui.showDialog', [spec]),
      closeDialog: () => send('ui.closeDialog', []),
      addStyles: css => send('ui.addStyles', [css]),
      escape: value =>
        String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]),
      notify: notification => send('notify', [notification]),
      toast: (message, bad = false) => send('toast', [message, bad]),
      navigate: path => send('navigate', [path]),
      refresh: () => send('refresh', []),
      pageHref: id => '/ext/' + encodeURIComponent(plugin.id) + '/' + encodeURIComponent(id),
    },
    library: {
      list: () => request('GET', 'resources'),
      get: id => request('GET', 'resources/' + encodeURIComponent(id)),
      createNode: spec => request('POST', 'library/script-nodes', withOwner(spec)),
      ensureNode: async spec => {
        const list = await request('GET', 'resources');
        const found = list.find(item => item.name === spec.name);
        return found || request('POST', 'library/script-nodes', withOwner(spec));
      },
      updateNode: (id, spec) => request('POST', 'library/script-nodes', {...withOwner(spec), resource_id: id}),
      deleteNode: id => request('DELETE', 'resources/' + encodeURIComponent(id)),
    },
    collections: {
      list: () => request('GET', 'collections'),
      define: (name, definition) => request('PUT', 'collections/' + encodeURIComponent(name), definition),
      records: (name, query) => request('GET', 'collections/' + encodeURIComponent(name) + '/records', undefined, query),
      create: (name, data, id) => request('POST', 'collections/' + encodeURIComponent(name) + '/records', {data, id}),
      update: (name, id, data, version) =>
        request('PUT', 'collections/' + encodeURIComponent(name) + '/records/' + encodeURIComponent(id), {data}, version === undefined ? undefined : {if_version: version}),
      remove: (name, id) => request('DELETE', 'collections/' + encodeURIComponent(name) + '/records/' + encodeURIComponent(id)),
    },
    workflows: {
      projects: () => request('GET', 'projects'),
      createProject: name => request('POST', 'projects', {name}),
      workflows: project => request('GET', 'projects/' + encodeURIComponent(project)),
      createWorkflow: (project, name) => request('POST', 'projects/' + encodeURIComponent(project) + '/workflows', {name}),
      placeNode: (project, workflow, resource, point) =>
        request('POST', 'projects/' + encodeURIComponent(project) + '/custom-nodes/' + encodeURIComponent(resource), {point: point || {x: 0, y: 0}}, {workflow_id: workflow}),
    },
    net: {
      fetch: spec => request('POST', 'net', spec),
    },
    secrets: {
      /** Metadata only: a client plugin never receives a secret value. */
      present: name => request('GET', 'secrets/' + encodeURIComponent(name)),
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
  let dataVersion = plugin.lifecycle.dataVersion;
  try {
    exportsObject = loadModule(plugin.main);
    if (typeof exportsObject.activate !== 'function') throw new Error('The plugin must export activate(api)');
    const run = async () => {
      const context = {...plugin.lifecycle};
      if (context.hook === 'install' && typeof exportsObject.onInstall === 'function')
        dataVersion = (await exportsObject.onInstall(api, context)) ?? dataVersion;
      if (context.hook === 'update' && typeof exportsObject.onUpdate === 'function')
        dataVersion = (await exportsObject.onUpdate(api, context)) ?? dataVersion;
      if (context.hook === 'update' && typeof exportsObject.migrate === 'function')
        dataVersion = (await exportsObject.migrate(api, context)) ?? dataVersion;
      const dispose = await exportsObject.activate(api);
      if (typeof dispose === 'function') exportsObject.__activateDispose = dispose;
      parent.postMessage({__agentsys: 'plugin', kind: 'ready', ok: true, dataVersion}, '*');
    };
    run().catch(error => parent.postMessage({__agentsys: 'plugin', kind: 'ready', error: error.message || String(error)}, '*'));
  } catch (error) {
    parent.postMessage({__agentsys: 'plugin', kind: 'ready', error: error.message || String(error)}, '*');
  }
})();
</script>`;
  }

  return {document};
})();
