// Client plugins live in this browser, never on the server. A plugin is a small JSON package with JavaScript that
// the client runs in a sandboxed iframe (see js/app/extensions.js); the server only sees the ordinary API calls it makes.
'use strict';

const PluginStore = (() => {
  const KEY = 'agentsys-client-plugins';
  // Resolve from this script's own URL: it works at the client root, under /editor/ and on a deep editor URL.
  const BUILTIN_URL = (() => {
    try {
      const source = document.currentScript?.src;
      return source ? new URL('../../client-plugins/index.json', source).toString() : 'client-plugins/index.json';
    } catch {
      return 'client-plugins/index.json';
    }
  })();
  const MAX_PLUGINS = 50;
  const MAX_SOURCE = 400000;
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const API_VERSION = 1;
  let loaded = null;

  const read = () => {
    let list;
    try {
      list = JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      list = [];
    }
    loaded = Array.isArray(list) ? list.filter(item => item && ID.test(item.id || '') && typeof item.source === 'string') : [];
    return loaded;
  };
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(loaded || []));
    } catch (error) {
      throw new ApiError('storage_full', 'The browser storage is full; remove a plugin and try again.', 507);
    }
  };
  const publicPlugin = item => ({
    id: item.id,
    title: item.title,
    description: item.description || '',
    version: item.version || '0.0.0',
    icon: item.icon || 'plug',
    api: item.api || 1,
    enabled: item.enabled !== false,
    builtin: !!item.builtin,
    source: item.source,
    origin: item.origin || 'installed',
  });

  const validate = (value, {allowSource = true} = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError('invalid_request', 'A plugin package must be a JSON object.', 400);
    if (!ID.test(value.id || ''))
      throw new ApiError('invalid_request', 'Plugin id must be letters, digits, ".", "_" or "-" (at most 80).', 400);
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120)
      throw new ApiError('invalid_request', 'A plugin needs a title of 1 to 120 characters.', 400);
    if (value.api !== undefined && value.api !== API_VERSION)
      throw new ApiError('incompatible_protocol', `This client runs client plugin API ${API_VERSION}, not ${value.api}.`, 409);
    if (allowSource && (typeof value.source !== 'string' || !value.source.trim()))
      throw new ApiError('invalid_request', 'A plugin needs JavaScript source.', 400);
    if (allowSource && value.source.length > MAX_SOURCE)
      throw new ApiError('invalid_request', 'The plugin source is too large (400 KB maximum).', 400);
    if (allowSource && !/\bactivate\b/.test(value.source))
      throw new ApiError('invalid_request', 'The plugin source must export activate(api).', 400);
    return {
      id: value.id,
      title: value.title.trim(),
      description: String(value.description || '').slice(0, 2000),
      version: String(value.version || '0.0.0').slice(0, 40),
      icon: /^[a-z][a-z0-9-]*$/.test(value.icon || '') ? value.icon : 'plug',
      api: API_VERSION,
      enabled: value.enabled !== false,
      builtin: !!value.builtin,
      source: value.source,
      origin: String(value.origin || 'installed').slice(0, 80),
    };
  };

  return {
    /** Loads the bundled catalog once; installed plugins win. */
    async load() {
      if (loaded) return loaded;
      read();
      try {
        const response = await fetch(BUILTIN_URL, {cache: 'no-store'});
        if (response.ok) {
          const list = await response.json();
          for (const item of Array.isArray(list) ? list : []) {
            let builtin;
            try {
              builtin = validate({...item, builtin: true, origin: 'bundled'});
            } catch {
              continue;
            }
            if (!loaded.some(existing => existing.id === builtin.id))
              loaded.push({...builtin, enabled: item.enabled !== false});
          }
          try {
            write();
          } catch {
            /* private browsing or a full quota: keep the catalog for this page session */
          }
        }
      } catch {
        /* a client without a catalog still works */
      }
      return loaded;
    },
    list() {
      read();
      return (loaded || []).map(publicPlugin);
    },
    get(id) {
      read();
      const item = (loaded || []).find(plugin => plugin.id === id);
      return item ? publicPlugin(item) : undefined;
    },
    /** Installs or replaces a package. The source is checked, not trusted. */
    install(value) {
      read();
      const plugin = validate(value);
      const index = loaded.findIndex(item => item.id === plugin.id);
      if (index < 0 && loaded.length >= MAX_PLUGINS)
        throw new ApiError('invalid_request', `At most ${MAX_PLUGINS} client plugins can be installed.`, 400);
      if (index >= 0) loaded[index] = {...loaded[index], ...plugin};
      else loaded.push(plugin);
      write();
      return publicPlugin(plugin);
    },
    remove(id) {
      read();
      loaded = loaded.filter(item => item.id !== id);
      write();
    },
    setEnabled(id, enabled) {
      read();
      const item = loaded.find(plugin => plugin.id === id);
      if (!item) throw new ApiError('not_found', 'Plugin not found', 404);
      item.enabled = !!enabled;
      write();
      return publicPlugin(item);
    },
    /** Private JSON a plugin keeps in this browser, separated per plugin and per active server. */
    storage(id) {
      const server = typeof Environment !== 'undefined' ? Environment.active()?.id || 'none' : 'none';
      const prefix = `agentsys-plugin-${id}@${server}:`;
      const result = {
        get(key, fallback = null) {
          try {
            const text = localStorage.getItem(prefix + String(key).slice(0, 200));
            return text === null ? fallback : JSON.parse(text);
          } catch {
            return fallback;
          }
        },
        set(key, value) {
          const text = JSON.stringify(value);
          if (text.length > 100000)
            throw new ApiError('invalid_request', 'A plugin value is too large (100 KB maximum).', 400);
          localStorage.setItem(prefix + String(key).slice(0, 200), text);
        },
        remove(key) {
          localStorage.removeItem(prefix + String(key).slice(0, 200));
        },
      };
      return result;
    },
    clear(id) {
      // Remove every environment scope of this plugin.
      const prefix = `agentsys-plugin-${id}`;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key === prefix || key?.startsWith(prefix + '@') || key?.startsWith(prefix + ':')) localStorage.removeItem(key);
      }
    },
    validate: value => validate(value, {allowSource: false}),
  };
})();
