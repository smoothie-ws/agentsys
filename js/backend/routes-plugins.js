// Routes: plugins (install, enable, grants, remove), their settings and data, the bridge their pages use, their endpoints and templates.
// Plugin management is admin authority: Scripts and plugins themselves cannot reach it (the default `needs` of this family is system.admin).
'use strict';

const pluginSummary = (record, nodes = 0) => ({...record, nodes});
const nodeCount = (resources, id) => resources.filter(r => r.id.startsWith(`plugin.${id}.`)).length;
const pluginSource = value => (typeof value === 'string' ? value.slice(0, 200) : '');

route(
  'GET POST',
  'plugins/builtin',
  'List, install or update the bundled plugins; keep user settings and disabled state',
  async c => {
    const index = await pluginIndex(c),
      state = await c.ctx.get('builtin_plugins', {added: []}),
      added = new Set(state.added),
      made = [],
      updated = [];
    if (c.method === 'GET')
      return BUILTIN_PLUGINS.map(p => ({
        id: p.manifest.id,
        name: p.manifest.name,
        installed: index.some(r => r.id === p.manifest.id),
      }));
    for (const input of BUILTIN_PLUGINS) {
      const id = input.manifest.id;
      const existing = index.find(r => r.id === id);
      if (existing) {
        if (existing.source === 'built-in' && existing.manifest.version !== input.manifest.version) {
          const pkg = validatePluginPackage(input);
          existing.collections = ownedCatalogSections(existing);
          existing.contributions = clone(pluginContributions(existing));
          existing.manifest = pkg.manifest;
          existing.updated = Date.now() / 1000;
          c.ctx.set(pluginKey(id, 'package'), pkg);

          updated.push(id);
        }
        added.add(id);
        continue;
      }
      if (added.has(id) && c.body.restore !== true) continue;
      const pkg = validatePluginPackage(input),
        now = Date.now() / 1000;
      const record = {
        id,
        enabled: true,
        installed: now,
        updated: now,
        source: 'built-in',
        grants: [],
        manifest: pkg.manifest,
        ...{contributions: clone(EMPTY_PLUGIN_CONTRIBUTIONS), runtime: {status: 'starting'}},
      };
      c.ctx.set(pluginKey(id, 'package'), pkg);

      index.push(record);
      added.add(id);
      made.push(id);
    }
    if (made.length || updated.length)
      c.ctx.set(
        PLUGIN_INDEX,
        index.sort((a, b) => a.id.localeCompare(b.id))
      );
    if (added.size !== state.added.length) c.ctx.set('builtin_plugins', {added: [...added].sort()});
    c.pluginLifecycle = startEnabledPluginRuntimes;
    return {added: made, updated};
  },
  {body: {restore: false}}
);

route(
  'GET POST',
  'plugins',
  'List installed plugins, or install one from a package',
  async c => {
    const index = await pluginIndex(c),
      resources = await c.ctx.get('resources', []);
    if (c.method === 'GET')
      return {
        api: PLUGIN_API,
        format: PLUGIN_FORMAT,
        formats: [PLUGIN_FORMAT],
        plugins: index.map(r => pluginSummary(r, nodeCount(resources, r.id))),
      };
    const pkg = validatePluginPackage(c.body.package),
      id = pkg.manifest.id,
      old = index.find(p => p.id === id),
      now = Date.now() / 1000;
    if (old && c.body.replace !== true)
      throw new ApiError('already_installed', `The plugin “${id}” ${old.manifest.version} is already installed`, 409);
    // An update keeps what the person granted, as far as the new version still declares it.
    const grants = checkPluginGrants(
      pkg.manifest,
      c.body.grants ?? (old ? old.grants.filter(g => pluginCapabilities(pkg).includes(g)) : [])
    );
    const record = {
      id,
      enabled: old ? old.enabled : c.body.enable === true,
      installed: old?.installed ?? now,
      updated: now,
      source: pluginSource(c.body.source),
      grants,
      collections: ownedCatalogSections(old),
      ...(old?.nodes_added ? {nodes_added: [...old.nodes_added]} : {}),
      manifest: pkg.manifest,
      ...{
        contributions: clone(old ? pluginContributions(old) : EMPTY_PLUGIN_CONTRIBUTIONS),
        runtime: {status: (old ? old.enabled : c.body.enable === true) ? 'starting' : 'inactive'},
      },
    };
    await checkRuntimeDependencies(c, record);
    c.ctx.set(pluginKey(id, 'package'), pkg);
    c.ctx.set(
      PLUGIN_INDEX,
      [...index.filter(p => p.id !== id), record].sort((a, b) => a.id.localeCompare(b.id))
    );
    const nodes = nodeCount(resources, id);
    c.pluginLifecycle = async () => {
      await stopPluginRuntime(id);
      if (record.enabled) await ensurePluginRuntime(id);
      if (old) await refreshPluginDependents(id);
    };
    c.pluginResult = id;
    logPlugin(id, {kind: old ? 'updated' : 'installed', version: pkg.manifest.version});
    return pluginSummary(record, nodes);
  },
  {
    body: {
      package: {
        format: PLUGIN_FORMAT,
        manifest: {id: 'my-plugin', name: 'My plugin', version: '1.0.0', engine: '>=2', main: 'main.js'},
        files: {'main.js': 'exports.activate = context => {};'},
      },
      grants: [],
      enable: false,
      replace: false,
      source: 'file.json',
    },
  }
);

route(
  'GET PUT DELETE',
  'plugins/{id}',
  'Read, enable, disable, change the grants of, or remove a plugin',
  async (c, {id}) => {
    const index = await pluginIndex(c),
      record = index.find(p => p.id === id);
    if (!record) throw missing('Plugin not found');
    const resources = await c.ctx.get('resources', []);
    if (c.method === 'GET') {
      const pkg = await c.ctx.get(pluginKey(id, 'package'), null),
        schema = pluginContributions(record).settings;
      return {
        ...pluginSummary(record, nodeCount(resources, id)),
        files: Object.entries(pkg?.files ?? {}).map(([path, text]) => ({path, bytes: text.length})),
        nodes_list: resources
          .filter(r => r.id.startsWith(`plugin.${id}.`))
          .map(r => ({id: r.id, name: r.name, folder: r.payload.folder})),
        settings: {schema, values: pluginSettingValues(schema, await pluginSettingsOf(c, record))},
        secrets: await Promise.all(
          pluginSecrets(record).map(async name => ({name, present: !!(await c.ctx.get('secrets/' + name))}))
        ),
      };
    }
    if (c.method === 'DELETE') {
      await assertNoPluginDependents(c, id);
      await removePluginCollections(c, record);
      for (const what of ['package', 'settings', 'data']) await c.ctx.remove(pluginKey(id, what));
      c.ctx.set(
        PLUGIN_INDEX,
        index.filter(p => p !== record)
      );
      PLUGIN_LOG.delete(id);
      c.pluginLifecycle = () => stopPluginRuntime(id);
      return {deleted: true};
    }
    const next = {...record};
    if ('enabled' in c.body) {
      if (typeof c.body.enabled !== 'boolean') throw bad('enabled must be true or false');
      next.enabled = c.body.enabled;
    }
    if ('grants' in c.body) next.grants = checkPluginGrants(record.manifest, c.body.grants);
    if (!next.enabled) await assertNoPluginDependents(c, id);
    await checkRuntimeDependencies(c, next);
    if (!next.enabled || next.enabled !== record.enabled)
      next.runtime = {status: next.enabled ? 'starting' : 'inactive'};
    next.updated = Date.now() / 1000;
    const nodes = nodeCount(resources, id);
    c.pluginLifecycle = async () => {
      if (!next.enabled) await stopPluginRuntime(id);
      else await ensurePluginRuntime(id);
    };
    c.pluginResult = id;
    c.ctx.set(
      PLUGIN_INDEX,
      index.map(p => (p === record ? next : p))
    );
    if (next.enabled !== record.enabled) logPlugin(id, {kind: next.enabled ? 'enabled' : 'disabled'});
    return pluginSummary(next, nodes);
  },
  {body: {enabled: true, grants: ['graph.read']}}
);

route(
  'GET',
  'plugins/{id}/ui',
  'Load the files referenced by a declared plugin page',
  async (c, {id}) => {
    const record = await pluginRecord(c, id),
      pkg = await pluginPackage(c, id);
    if (!record.enabled) throw bad('The plugin is disabled');
    const entry = c.query.path;
    if (![...pluginContributions(record).pages, ...pluginContributions(record).tiles].some(p => p.entry === entry))
      throw bad('Choose a declared plugin page');
    const files = {},
      visit = path => {
        if (Object.hasOwn(files, path)) return;
        const source = pkg.files[path];
        if (source === undefined) throw missing('Plugin UI file is missing: ' + path);
        files[path] = source;
        for (const match of source.matchAll(/(?:src|href)=["']([^"']+)["']|url\(["']?([^)'"\s]+)["']?\)/g)) {
          const relative = match[1] ?? match[2];
          if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(relative)) continue;
          const parts = path.split('/').slice(0, -1);
          for (const part of relative.split(/[?#]/)[0].split('/')) {
            if (part === '..') parts.pop();
            else if (part && part !== '.') parts.push(part);
          }
          const resolved = parts.join('/');
          if (Object.hasOwn(pkg.files, resolved)) visit(resolved);
        }
      };
    visit(entry);
    return {files};
  },
  {query: ['path']}
);

route(
  'GET',
  'plugins/{id}/file',
  'Read one file of a plugin',
  async (c, {id}) => {
    await pluginRecord(c, id);
    const path = pluginFilePath(c.query.path),
      pkg = await pluginPackage(c, id);
    if (!Object.hasOwn(pkg.files, path)) throw missing('No such file in the plugin');
    return {path, text: pkg.files[path]};
  },
  {query: ['path']}
);

route(
  'GET',
  'plugins/{id}/log',
  'The recent calls of a plugin: endpoints, denied requests, changes',
  async (c, {id}) => {
    await pluginRecord(c, id);
    return PLUGIN_LOG.get(id) ?? [];
  }
);

route(
  'GET PUT',
  'plugins/{id}/settings',
  'Read or change the settings of a plugin',
  async (c, {id}) => {
    const record = await pluginRecord(c, id),
      schema = pluginContributions(record).settings;
    if (c.method === 'PUT') {
      // A change is merged over what is saved, and every value is checked against the plugin's declaration.
      const merged = {...(await pluginSettingsOf(c, record)), ...(c.body.values ?? {})};
      c.ctx.set(pluginKey(id, 'settings'), pluginSettingValues(schema, merged, true));
    }
    return {schema, values: pluginSettingValues(schema, await pluginSettingsOf(c, record))};
  },
  {body: {values: {}}}
);

route(
  'GET',
  'plugins/{id}/data',
  'List the data a plugin keeps',
  async (c, {id}) => {
    await pluginRecord(c, id);
    return pluginDataOperation(c, id, 'list', null, {prefix: c.query.prefix});
  },
  {query: ['prefix']}
);
route(
  'GET PUT DELETE',
  'plugins/{id}/data/{key}',
  'Read, write (compare-and-set) or delete one value of a plugin',
  async (c, {id, key}) => {
    await pluginRecord(c, id);
    const body = c.method === 'GET' ? {} : {...c.body};
    if (c.method === 'DELETE' && c.query.version !== undefined) body.version = Number(c.query.version);
    return pluginDataOperation(c, id, c.method.toLowerCase(), key, body);
  },
  {body: {value: 'JSON', version: 0}, query: ['version']}
);

// The bridge: a plugin page asks, the host page passes the question on here, and only what the plugin declares and a person granted goes through.
route(
  'POST',
  'plugins/{id}/bridge',
  'Make an API call as a plugin, with the rights the plugin was granted',
  async (c, {id}) => pluginBridgeRequest(id, c.body.method, c.body.path, c.body.body, c.body.query),
  {unlocked: true, body: {method: 'GET', path: 'projects', body: {}, query: {}}}
);

route(
  'GET POST PUT DELETE',
  'plugins/{id}/call/{name}',
  'Call an endpoint of a plugin',
  async (c, {id, name}) => {
    const record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(p => p.id === id);
    if (!record) throw missing('Plugin not found');
    if (!record.enabled) throw new ApiError('plugin_disabled', `The plugin “${id}” is not enabled`, 409);
    const endpoint = pluginContributions(record).endpoints.find(e => e.name === name);
    if (!endpoint) throw missing('The plugin has no such endpoint');
    if (!endpoint.methods.includes(c.method))
      throw new ApiError('method_not_allowed', `This endpoint answers ${endpoint.methods.join(', ')}`, 405);
    return (
      await invokePluginHandler(
        record,
        endpoint.handler,
        [{method: c.method, query: clone(c.query), body: clone(c.body)}],
        endpoint.timeout,
        c.scriptContext?.signal,
        c.scriptContext
      )
    ).result;
  },
  {unlocked: true, body: {}}
);

route(
  'POST',
  'plugins/{id}/commands/{command}',
  'Execute a registered plugin command',
  async (c, {id, command}) => {
    let record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(p => p.id === id);
    if (!record?.enabled) throw bad('The plugin is missing or disabled');
    await ensurePluginRuntime(id);
    record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(p => p.id === id);
    const entry = pluginContributions(record).commands.find(item => item.id === command);
    if (!entry?.handler) throw missing('No executable command with this ID');
    return invokePluginHandler(record, entry.handler, Array.isArray(c.body.args) ? c.body.args : []);
  },
  {unlocked: true, body: {args: []}}
);

route(
  'POST',
  'plugins/{id}/templates/{template}/instantiate',
  'Create a project from a template of a plugin',
  async (c, {id, template}) => {
    const record = await pluginRecord(c, id);
    if (!record.enabled) throw new ApiError('plugin_disabled', `The plugin “${id}” is not enabled`, 409);
    const item = pluginContributions(record).templates.find(t => t.id === template);
    if (!item) throw missing('The plugin has no such template');
    const pkg = await pluginPackage(c, id);
    let body;
    try {
      body = decodeExchange(JSON.parse(pkg.files[item.file]));
    } catch (error) {
      throw bad(`${item.file}: ${error.message}`);
    }
    if (body.kind !== 'project') throw bad(`${item.file} is not an exported project`);
    if (typeof c.body.name === 'string' && c.body.name.trim()) body.name = c.body.name.trim().slice(0, 100);
    return importProjectDocument(c, body);
  },
  {body: {name: 'optional project name'}}
);
