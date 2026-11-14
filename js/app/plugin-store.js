// Client plugins live in this browser, never on the server. A plugin is a JSON package with JavaScript that the
// client runs in a sandboxed iframe (see js/app/extensions.js); the server only sees the ordinary API calls it makes.
//
// The package contract (manifest, versions, dependencies, files) is in js/app/plugin-manifest.js. This store owns the
// browser-side record: installation, enablement, per-environment private storage and the activation bookkeeping used
// by the lifecycle. Nothing here executes plugin code.
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
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const Manifest = typeof PluginManifest === 'undefined' ? null : PluginManifest;
  const Capabilities = typeof PluginCapabilities === 'undefined' ? null : PluginCapabilities;
  const HOST_VERSION = '0.3.0';
  let loaded = null;

  const read = () => {
    let list;
    try {
      list = JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      list = [];
    }
    const result = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !ID.test(item.id || '') || typeof item.source !== 'string') continue;
      try {
        result.push(Manifest ? Manifest.migrateRecord(item) : item);
      } catch {
        // A record this client cannot read no longer runs; keeping it would only fail on every reload.
      }
    }
    loaded = result;
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
    main: item.main || 'plugin.js',
    files: item.files ? {...item.files} : {},
    assets: item.assets ? {...item.assets} : {},
    capabilities: item.capabilities ? item.capabilities.slice() : Capabilities ? Capabilities.READ_ONLY.slice() : [],
    origin: item.origin || 'installed',
    formatVersion: item.formatVersion || 1,
    author: item.author || '',
    license: item.license || '',
    homepage: item.homepage || '',
    dependencies: {...(item.dependencies || {})},
    engines: {...(item.engines || {})},
    contributes: item.contributes
      ? {
          collections: (item.contributes.collections || []).map(value => ({...value})),
          library: (item.contributes.library || []).map(value => ({...value})),
          workflows: (item.contributes.workflows || []).map(value => ({...value})),
        }
      : {collections: [], library: [], workflows: []},
    installedAt: item.installedAt || 0,
    updatedAt: item.updatedAt || 0,
    activatedVersion: item.activatedVersion || '',
    dataVersion: item.dataVersion || 0,
    hasModules: !!(item.files && Object.keys(item.files).length),
    assetCount: item.assets ? Object.keys(item.assets).length : 0,
  });

  const capabilitiesOf = value => {
    if (!Capabilities) return undefined;
    try {
      return Capabilities.normalize(value);
    } catch (error) {
      throw new ApiError('invalid_request', error.message, 400);
    }
  };

  /** Validates a package and returns the record the store keeps. */
  const normalize = (value, {allowSource = true} = {}) => {
    if (!Manifest) throw new ApiError('invalid_request', 'The plugin manifest module is not loaded.', 500);
    let record;
    try {
      record = Manifest.normalizePackage(value, {hostVersion: HOST_VERSION, apiVersion: Manifest.API_VERSION, allowSource});
    } catch (error) {
      throw error.code ? error : new ApiError('invalid_request', error.message, 400);
    }
    record.capabilities = capabilitiesOf(record.capabilities);
    if (!record.capabilities) record.capabilities = [];
    return record;
  };
  const assertDependencies = (record, list, {requireEnabled = false} = {}) => {
    const check = Manifest.checkDependencies(record, list, {requireEnabled});
    if (!check.ok) {
      const first = check.errors[0];
      const error = new ApiError(first.code, first.message, first.code === 'missing_dependency' ? 409 : 409);
      error.errors = check.errors;
      throw error;
    }
  };
  /** One storage scope per plugin and active environment. Reserved keys are host bookkeeping. */
  function storageFor(id, allowReserved) {
    const server = typeof Environment !== 'undefined' ? Environment.active()?.id || 'none' : 'none';
    const prefix = `agentsys-plugin-${id}@${server}:`;
    const safeKey = key => {
      const text = String(key).slice(0, 200);
      if (!allowReserved && text.startsWith('__agentsys:'))
        throw new ApiError('invalid_request', 'That storage key is reserved.', 400);
      return text;
    };
    return {
      get(key, fallback = null) {
        try {
          const text = localStorage.getItem(prefix + safeKey(key));
          return text === null ? fallback : JSON.parse(text);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        const text = JSON.stringify(value);
        if (text.length > 100000)
          throw new ApiError('invalid_request', 'A plugin value is too large (100 KB maximum).', 400);
        localStorage.setItem(prefix + safeKey(key), text);
      },
      remove(key) {
        localStorage.removeItem(prefix + safeKey(key));
      },
      /** The environment scope this storage is bound to, for the deployment record and tests. */
      environment: server,
    };
  }

  return {
    HOST_VERSION,
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
              builtin = normalize({...item, builtin: true, origin: 'bundled'});
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
    /** The full stored record, including modules and assets. For the host and the exporter, not for pages. */
    record(id) {
      read();
      const item = (loaded || []).find(plugin => plugin.id === id);
      return item ? JSON.parse(JSON.stringify(item)) : undefined;
    },
    records() {
      read();
      return (loaded || []).map(item => JSON.parse(JSON.stringify(item)));
    },
    /**
     * Installs a new package or updates one in place. Dependencies and compatibility are checked before anything
     * is written. An update keeps the enabled state and the user data; activation is the host's next step.
     */
    install(value, {allowDowngrade = false} = {}) {
      read();
      const plugin = normalize(value);
      const index = loaded.findIndex(item => item.id === plugin.id);
      const siblings = loaded.filter(item => item.id !== plugin.id);
      assertDependencies(plugin, [...siblings, plugin]);
      if (index < 0 && loaded.length >= MAX_PLUGINS)
        throw new ApiError('invalid_request', `At most ${MAX_PLUGINS} client plugins can be installed.`, 400);
      const now = Date.now();
      if (index >= 0) {
        const previous = loaded[index];
        if (!allowDowngrade && Manifest.compareVersions(plugin.version, previous.version) < 0)
          throw new ApiError(
            'invalid_request',
            `Installed version ${previous.version} is newer than ${plugin.version}; enable a downgrade explicitly.`,
            409
          );
        const next = {
          ...previous,
          ...plugin,
          enabled: value.enabled === undefined ? previous.enabled !== false : value.enabled !== false,
          builtin: previous.builtin || plugin.builtin,
          origin: plugin.origin || previous.origin || 'installed',
          installedAt: previous.installedAt || now,
          updatedAt: now,
          activatedVersion: previous.activatedVersion || '',
          dataVersion: previous.dataVersion || 0,
        };
        next.checksum = Manifest.fingerprint(next);
        loaded[index] = next;
        write();
        return publicPlugin(next);
      }
      plugin.installedAt = now;
      plugin.updatedAt = now;
      plugin.checksum = Manifest.fingerprint(plugin);
      loaded.push(plugin);
      write();
      return publicPlugin(plugin);
    },
    /** Explicit update: the same as install, but refuses a package for another plugin id. */
    update(id, value, options) {
      if (!value || typeof value !== 'object' || (value.id && value.id !== id) || value.manifest?.id && value.manifest.id !== id)
        throw new ApiError('invalid_request', 'The package is for another plugin.', 400);
      return this.install({...value, id: value.id || value.manifest?.id || id}, options);
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
      if (enabled) assertDependencies(item, loaded, {requireEnabled: true});
      item.enabled = !!enabled;
      item.updatedAt = Date.now();
      write();
      return publicPlugin(item);
    },
    /** Records that this version activated successfully in its current data version. */
    markActivated(id, version, dataVersion = 0) {
      read();
      const item = loaded.find(plugin => plugin.id === id);
      if (!item) return;
      item.activatedVersion = String(version || item.version);
      item.dataVersion = Number(dataVersion) || 0;
      item.lastActivatedAt = Date.now();
      write();
    },
    /** The distributable package: manifest, every module, assets, contributions and a checksum. */
    export(id) {
      const item = this.record(id);
      if (!item) throw new ApiError('not_found', 'Plugin not found', 404);
      if (!Manifest) throw new ApiError('internal_error', 'The plugin manifest module is not loaded.', 500);
      const packet = Manifest.exportPackage(item);
      packet.exportedAt = new Date().toISOString();
      packet.exportedBy = 'AgentSys client ' + HOST_VERSION;
      return packet;
    },
    /** Private JSON a plugin keeps in this browser, separated per plugin and per active server. */
    storage(id) {
      return storageFor(id, false);
    },
    /** Host bookkeeping (deployment records) in the same per-environment scope; not reachable from a sandbox. */
    hostStorage(id) {
      return storageFor(id, true);
    },
    clear(id) {
      // Remove every environment scope of this plugin.
      const prefix = `agentsys-plugin-${id}`;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key === prefix || key?.startsWith(prefix + '@') || key?.startsWith(prefix + ':')) localStorage.removeItem(key);
      }
    },
    /** Package metadata without source; used by the editor's field checks. */
    validate: value => normalize(value, {allowSource: false}),
    /** Dependency and cycle state of the installed set, for the Plugins page and activation. */
    dependencyState(id) {
      read();
      const item = loaded.find(plugin => plugin.id === id);
      if (!item) return {ok: false, errors: [{code: 'not_found', message: 'Plugin not found'}]};
      const direct = Manifest.checkDependencies(item, loaded, {requireEnabled: true});
      const all = Manifest.activationOrder(loaded.filter(plugin => plugin.enabled !== false));
      return {
        ok: direct.ok && !all.errors.some(error => error.id === id),
        errors: [...direct.errors, ...all.errors.filter(error => error.id === id)],
        order: all.order.map(plugin => plugin.id),
      };
    },
  };
})();
