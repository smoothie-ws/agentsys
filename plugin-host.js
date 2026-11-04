'use strict';
// Plugins, in the manner of Substance Painter: a plugin is a folder in `plugins/` with a `main.js` that exports
// `start(api)` and (optionally) `stop()`. There is no manifest, no sandbox and no permission list: a plugin is trusted
// code that runs in the server process, like any other program the person installed. Plugins can be turned off and the
// folder reloaded from the Plugins page.
//
//   exports.title = 'My plugin';            // optional, shown on the Plugins page
//   exports.description = 'What it does.';  // optional
//   exports.start = api => { ... };         // called when the plugin is loaded or enabled
//   exports.stop = () => { ... };           // called when it is disabled or the folder is reloaded
//
// `api` (everything a plugin can do; whatever it registers is removed when it stops):
//   api.id                              the folder name
//   api.log(...)                        a line on the server's error output, prefixed with the id
//   api.request(method, path, body, query)   any call of the application API (what the editor and Scripts use), unchecked
//   api.on('change', keys => {})        called with the stored keys that changed; returns the function that stops listening
//   api.route(method, name, handler)    answers `/api/plugins/{id}/{name}`; handler({body, query, signal, caller}) returns
//                                       JSON. `signal` aborts when the calling run is stopped; `caller` is the Script's
//                                       {project_id, workflow_id, node_id}. Scripts need the `plugins.call` permission.
//   api.notify({title, body, level, href})  adds a message to the notification list (level: info, success, warn, error)
//   api.settings.get()                  the plugin's settings (see `exports.settings` below), defaults filled in
//   api.data.get() / api.data.set(v)    private JSON the plugin keeps between runs
//   api.secret(name)                    the value of a stored secret (the Secrets API only ever returns metadata)
//   api.library.addScriptNode(spec)     adds a one-Script node to the Library unless one of that name exists:
//                                       {name, inputs, outputs, code, description, folder, icon, grants}
//   api.library.add({name, payload})    adds any Library node (a full graph payload) unless one of that name exists
//
// `exports.settings = [{key, label, type, default, options, help}]` makes a form on the plugin's page. Types: text, textarea,
// password (never sent back to the page), number, boolean, select (give `options`). The values are saved by the host.
const fs = require('node:fs');
const path = require('node:path');

const DISABLED_KEY = 'plugins-disabled';
const SETTING_TYPES = ['text', 'textarea', 'password', 'number', 'boolean', 'select'];
const settingsKey = id => `plugins/${id}/settings`;
const dataKey = id => `plugins/${id}/data`;
const bad = message => Object.assign(new Error(message), {code: 'invalid_request'});

/** The settings a plugin declares, checked. */
function checkSchema(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('settings must be a list');
  const keys = new Set();
  return list.map(field => {
    if (!field || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(field.key ?? '') || keys.has(field.key))
      throw new Error('Each setting needs its own key (letters, digits, _)');
    keys.add(field.key);
    if (!SETTING_TYPES.includes(field.type ?? 'text')) throw new Error('Unknown setting type: ' + field.type);
    if (field.type === 'select' && !Array.isArray(field.options)) throw new Error('A select setting needs options');
    return {
      key: field.key,
      label: String(field.label ?? field.key),
      type: field.type ?? 'text',
      default: field.default,
      options: field.options,
      help: field.help ? String(field.help) : '',
    };
  });
}
/** One value of a form, converted to the setting's type. */
function settingValue(field, value) {
  if (field.type === 'boolean') return value === true;
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`${field.label} must be a number`);
    return value;
  }
  if (typeof value !== 'string' || value.length > 20000) throw bad(`${field.label} must be text`);
  if (field.type === 'select' && !field.options.map(o => (typeof o === 'object' ? o.value : o)).includes(value))
    throw bad(`${field.label} is not one of its options`);
  return value;
}

function createPluginHost({dir, backend, log = (...args) => console.error(...args)}) {
  const plugins = new Map();
  const request = (method, route, body, query) =>
    backend.Backend.request(method, route, {body: body ?? {}, query: query ?? {}});
  const json = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  async function disabledIds() {
    return new Set((await backend.DB.get(DISABLED_KEY)) ?? []);
  }
  async function saveDisabled(ids) {
    await backend.DB.commit({[DISABLED_KEY]: ids.size ? [...ids].sort() : undefined});
  }

  /** The values of a plugin's settings: what was saved over the defaults. */
  async function settingsOf(plugin) {
    const saved = (await backend.DB.get(settingsKey(plugin.id))) ?? {};
    return Object.fromEntries(plugin.settings.map(f => [f.key, f.key in saved ? saved[f.key] : f.default]));
  }

  function makeApi(plugin) {
    return {
      id: plugin.id,
      log: (...args) => log(`[${plugin.id}]`, ...args),
      request,
      on(event, listener) {
        if (event !== 'change') throw new Error('Unknown event: ' + event);
        const off = backend.Backend.subscribe(keys => listener(keys), {commits: true});
        plugin.cleanup.push(off);
        return off;
      },
      route(method, name, handler) {
        plugin.routes.set(method.toUpperCase() + ' ' + name, handler);
      },
      notify: ({title, body, level, href}) =>
        request('POST', 'notifications', {title, body, level, href, source: 'plugin:' + plugin.id}),
      settings: {get: () => settingsOf(plugin)},
      data: {
        get: async () => json(await backend.DB.get(dataKey(plugin.id))),
        set: value => backend.DB.commit({[dataKey(plugin.id)]: json(value)}),
      },
      secret: async name => (await backend.DB.get('secrets/' + name))?.value,
      library: {
        async add({name, payload}) {
          const items = await request('GET', 'resources');
          if (items.some(r => r.name === name)) return;
          await request('POST', 'resources', {name, payload: json(payload)});
        },
        async addScriptNode(spec) {
          const items = await request('GET', 'resources');
          if (items.some(r => r.name === spec.name)) return;
          const payload = json(backend.eval('scriptNodePayload')(spec));
          await request('POST', 'resources', {name: spec.name, payload});
        },
      },
    };
  }

  async function start(plugin) {
    plugin.error = null;
    try {
      const main = path.join(dir, plugin.id, 'main.js');
      for (const file of Object.keys(require.cache))
        if (file.startsWith(path.join(dir, plugin.id) + path.sep)) delete require.cache[file];
      plugin.module = require(main);
      plugin.title = plugin.module.title || plugin.id;
      plugin.description = plugin.module.description || '';
      plugin.settings = checkSchema(plugin.module.settings);
      if (typeof plugin.module.start !== 'function') throw new Error('main.js must export start(api)');
      await plugin.module.start(makeApi(plugin));
      plugin.running = true;
    } catch (error) {
      plugin.error = error.message;
      await stop(plugin);
    }
  }

  async function stop(plugin) {
    try {
      if (plugin.running) await plugin.module?.stop?.();
    } catch (error) {
      plugin.error = error.message;
    }
    for (const off of plugin.cleanup.splice(0)) off();
    plugin.routes.clear();
    plugin.running = false;
  }

  const describe = p => ({
    id: p.id,
    title: p.title,
    description: p.description,
    enabled: p.enabled,
    running: p.running,
    error: p.error,
  });

  const host = {
    /** Scans the plugins folder and starts every plugin that is not turned off. */
    async load() {
      const off = await disabledIds();
      let names = [];
      try {
        names = fs
          .readdirSync(dir, {withFileTypes: true})
          .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'main.js')));
      } catch {
        /* no plugins folder: no plugins */
      }
      for (const {name: id} of names) {
        const plugin = {
          id,
          title: id,
          description: '',
          enabled: !off.has(id),
          running: false,
          error: null,
          module: null,
          settings: [],
          routes: new Map(),
          cleanup: [],
        };
        plugins.set(id, plugin);
        if (plugin.enabled) await start(plugin);
      }
    },
    /** Stops every plugin. */
    async stopAll() {
      for (const plugin of plugins.values()) await stop(plugin);
    },
    /** Stops every plugin and loads the folder again (new, removed and edited plugins take effect). */
    async reload() {
      await host.stopAll();
      plugins.clear();
      await host.load();
    },
    list: () => [...plugins.values()].map(describe),
    /** One plugin with the routes it registered and its README.md, if it has one. */
    async detail(id) {
      const plugin = plugins.get(id);
      if (!plugin) return undefined;
      let readme = '';
      try {
        readme = fs.readFileSync(path.join(dir, id, 'README.md'), 'utf8');
      } catch {
        /* no README */
      }
      const values = await settingsOf(plugin);
      const settings = plugin.settings.map(f => ({
        ...f,
        // A password is never sent to the page: only whether one is set.
        value: f.type === 'password' ? '' : values[f.key],
        set: f.type === 'password' ? !!values[f.key] : undefined,
      }));
      return {...describe(plugin), routes: [...plugin.routes.keys()].sort(), readme, settings};
    },
    /** Saves settings from the plugin's page. A password that is left empty keeps its value; null clears it. */
    async setSettings(id, values) {
      const plugin = plugins.get(id);
      if (!plugin) throw Object.assign(new Error('Plugin not found'), {code: 'not_found'});
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw bad('values is an object');
      const saved = {...((await backend.DB.get(settingsKey(id))) ?? {})};
      for (const field of plugin.settings) {
        if (!(field.key in values)) continue;
        const value = values[field.key];
        if (field.type === 'password') {
          if (value === null) delete saved[field.key];
          else if (value !== '') saved[field.key] = settingValue(field, value);
        } else saved[field.key] = settingValue(field, value);
      }
      await backend.DB.commit({[settingsKey(id)]: saved});
      return host.detail(id);
    },
    async setEnabled(id, enabled) {
      const plugin = plugins.get(id);
      if (!plugin) throw Object.assign(new Error('Plugin not found'), {code: 'not_found'});
      const off = await disabledIds();
      enabled ? off.delete(id) : off.add(id);
      await saveDisabled(off);
      plugin.enabled = enabled;
      if (enabled && !plugin.running) await start(plugin);
      if (!enabled) await stop(plugin);
      return describe(plugin);
    },
    /** Runs the route a plugin registered; undefined when there is none. */
    async call(id, name, method, body, query, {signal, caller} = {}) {
      const handler = plugins.get(id)?.routes.get(method + ' ' + name);
      // The backend runs in its own realm: hand the plugin plain objects of this one.
      return handler
        ? json(await handler({body: json(body), query: json(query), signal, caller: json(caller)}))
        : undefined;
    },
  };
  return host;
}

module.exports = {createPluginHost};
