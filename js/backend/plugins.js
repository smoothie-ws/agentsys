// Plugins (backend): the package format and its validation, the registry of installed plugins, what an enabled plugin puts into the
// Library, its private settings and data, the checked bridge its pages use, and the isolated Worker its endpoints run in.
// The routes are in routes-plugins.js; the contract is in docs/plugins.md.
'use strict';

const PLUGIN_FORMAT = 'agentsys.plugin/2';
/** The version of the extension points. A plugin that needs a higher one (`engine: ">=3"`) is refused. */
const PLUGIN_API = 2;
const PLUGIN = {
  files: 200,
  fileBytes: 2000000,
  totalBytes: 8000000,
  dataBytes: 2000000,
  dataValueBytes: 500000,
  dataKeys: 500,
  endpointMs: 30000,
  resultBytes: 1000000,
  log: 100,
};
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
const PLUGIN_ITEM = /^[a-z][a-z0-9-]{0,39}$/;
const PLUGIN_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const PLUGIN_SETTING_TYPES = ['text', 'textarea', 'number', 'boolean', 'select'];
const PLUGIN_INDEX = 'plugins/index';
const pluginKey = (id, what) => `plugins/${id}/${what}`;

// ----- the package -----
const pluginText = (value, label, max, min = 0) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw bad(`${label} must be text of ${min ? `${min} to ` : 'at most '}${max} characters`);
  return value;
};
function pluginFilePath(path) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z0-9_.\-/]{1,200}$/.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..')
  )
    throw bad(`Invalid file path: ${String(path).slice(0, 60)}`);
  return path;
}
const pluginFile = (files, path, ext, label) => {
  pluginFilePath(path);
  if (!Object.hasOwn(files, path)) throw bad(`${label}: "${path}" is not a file of the package`);
  if (!path.endsWith(ext)) throw bad(`${label}: "${path}" must be a ${ext} file`);
  return path;
};
const pluginList = (value, label, max) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw bad(`${label} is a list of at most ${max} items`);
  return value;
};
function uniquePluginItems(items, label) {
  const seen = new Set();
  for (const item of items) {
    const key = item.id ?? item.name ?? item.key;
    if (seen.has(key)) throw bad(`Two ${label} are called "${key}"`);
    seen.add(key);
  }
  return items;
}
function checkPluginEngine(range) {
  if (range === undefined) return undefined;
  const match = typeof range === 'string' && /^>=\s*(\d{1,4})$/.exec(range.trim());
  if (!match) throw bad('engine is a text like ">=1"');
  if (Number(match[1]) > PLUGIN_API)
    throw bad(`This plugin needs plugin API ${match[1]}; this AgentSys provides ${PLUGIN_API}`);
  return range.trim();
}
function pluginSettingValue(field, value) {
  const fail = what => bad(`Setting “${field.label}” must be ${what}`);
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw fail('true or false');
  } else if (field.type === 'number') {
    if (
      !finite(value) ||
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max)
    )
      throw fail(
        'a number' +
          (field.min !== undefined || field.max !== undefined
            ? ` from ${field.min ?? '−∞'} to ${field.max ?? '∞'}`
            : '')
      );
  } else if (field.type === 'select') {
    if (!field.options.includes(value)) throw fail('one of: ' + field.options.join(', '));
  } else if (typeof value !== 'string' || value.length > (field.type === 'textarea' ? 20000 : 1000))
    throw fail(`text of at most ${field.type === 'textarea' ? 20000 : 1000} characters`);
  return value;
}
function validatePluginSettingsSchema(schema) {
  if (schema === undefined) return {fields: []};
  if (!isObject(schema) || !Array.isArray(schema.fields) || schema.fields.length > 50)
    throw bad('settings is {fields: [...]} with at most 50 fields');
  const seen = new Set();
  return {
    fields: schema.fields.map(f => {
      if (!isObject(f) || typeof f.key !== 'string' || !/^[a-z][A-Za-z0-9_]{0,39}$/.test(f.key) || seen.has(f.key))
        throw bad('A setting needs a unique key (a lower-case letter, then letters, digits and _)');
      seen.add(f.key);
      if (!PLUGIN_SETTING_TYPES.includes(f.type))
        throw bad(`Setting ${f.key}: type is one of ${PLUGIN_SETTING_TYPES.join(', ')}`);
      const out = {key: f.key, label: pluginText(f.label ?? f.key, 'A setting label', 100, 1), type: f.type};
      if (f.description !== undefined) out.description = pluginText(f.description, 'A setting description', 500);
      if (f.type === 'select') {
        if (
          !Array.isArray(f.options) ||
          !f.options.length ||
          f.options.length > 50 ||
          f.options.some(o => typeof o !== 'string' || !o || o.length > 100)
        )
          throw bad(`Setting ${f.key}: options is a list of 1 to 50 texts`);
        out.options = [...f.options];
      }
      if (f.type === 'number')
        for (const k of ['min', 'max'])
          if (f[k] !== undefined) {
            if (!finite(f[k])) throw bad(`Setting ${f.key}: ${k} is a number`);
            out[k] = f[k];
          }
      const fallback = {boolean: false, number: out.min ?? 0, select: out.options?.[0]}[f.type] ?? '';
      out.default = pluginSettingValue(out, f.default === undefined ? fallback : f.default);
      return out;
    }),
  };
}
/** The values of a plugin's settings: the saved ones over the defaults. With `strict`, an unknown or invalid key is an error. */
function pluginSettingValues(schema, saved, strict = false) {
  const values = Object.fromEntries(schema.fields.map(f => [f.key, f.default]));
  if (strict && !isObject(saved)) throw bad('values must be an object');
  for (const [key, value] of Object.entries(saved ?? {})) {
    const field = schema.fields.find(f => f.key === key);
    if (!field) {
      if (strict) throw bad(`Unknown setting: ${key.slice(0, 40)}`);
      continue;
    }
    try {
      values[key] = pluginSettingValue(field, value);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return values;
}

function validatePluginPackage(input) {
  if (!isObject(input) || input.format !== PLUGIN_FORMAT || !isObject(input.manifest) || !isObject(input.files))
    throw bad('A plugin package needs format, manifest and files');
  const files = {};
  let total = 0;
  if (Object.keys(input.files).length > PLUGIN.files) throw bad('Too many package files');
  for (const [name, text] of Object.entries(input.files)) {
    pluginFilePath(name);
    if (typeof text !== 'string' || text.length > PLUGIN.fileBytes) throw bad('Invalid package file ' + name);
    total += text.length;
    files[name] = text;
  }
  if (total > PLUGIN.totalBytes) throw bad('Plugin package is too large');
  const m = input.manifest,
    known = new Set([
      'id',
      'name',
      'version',
      'description',
      'authors',
      'icon',
      'main',
      'permissions',
      'dependencies',
      'engine',
      'secrets',
      'readme',
      'homepage',
      'license',
      'repository',
      'keywords',
    ]);
  for (const key of Object.keys(m)) if (!known.has(key)) throw bad('Unknown manifest field: ' + key);
  if (!PLUGIN_ID.test(m.id ?? '')) throw bad('Invalid plugin id');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(m.version))
    throw bad('version is like 1.0.0');
  const manifest = {
    id: m.id,
    name: pluginText(m.name, 'Name', 100, 1),
    version: m.version,
    description: pluginText(m.description ?? '', 'Description', 2000),
    engine: checkPluginEngine(m.engine ?? '>=2'),
    main: pluginFile(files, m.main, '.js', 'main'),
    icon: m.icon ?? 'plug',
    permissions: [...new Set(pluginList(m.permissions, 'permissions', 50))],
    secrets: [...new Set(pluginList(m.secrets, 'secrets', 20))],
    authors: pluginList(m.authors, 'authors', 20).map(author => {
      if (!isObject(author)) throw bad('An author is {name,url?}');
      return {
        name: pluginText(author.name, 'Author', 100, 1),
        ...(author.url ? {url: pluginText(author.url, 'Author URL', 500, 1)} : {}),
      };
    }),
    dependencies: {},
  };
  checkManifest({grants: manifest.permissions});
  for (const name of manifest.secrets)
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw bad('Invalid secret name');
  if (Object.hasOwn(files, manifest.icon)) {
    const asset = files[manifest.icon];
    if (manifest.icon.endsWith('.svg') && /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(asset))
      manifest.icon = 'data:image/svg+xml,' + encodeURIComponent(asset);
    else if (/^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(asset)) manifest.icon = asset;
    else throw bad('An icon file must be SVG or a PNG data URL');
  }
  validateIcon(manifest.icon);
  if (m.readme !== undefined) manifest.readme = pluginFile(files, m.readme, '.md', 'readme');
  if (m.homepage !== undefined) {
    if (typeof m.homepage !== 'string' || !/^https:\/\/[^\s]+$/.test(m.homepage)) throw bad('Homepage must be HTTPS');
    manifest.homepage = m.homepage;
  }
  if (m.dependencies !== undefined && !isObject(m.dependencies))
    throw bad('dependencies is a map of plugin IDs to versions');
  for (const [id, range] of Object.entries(m.dependencies ?? {})) {
    if (!PLUGIN_ID.test(id) || typeof range !== 'string' || !/^([~^]|>=)?\d+\.\d+\.\d+$|^\*$/.test(range))
      throw bad('Invalid plugin dependency');
    manifest.dependencies[id] = range;
  }
  for (const key of ['license', 'repository'])
    if (m[key] !== undefined) manifest[key] = pluginText(m[key], key, 500, 1);
  if (m.keywords !== undefined)
    manifest.keywords = pluginList(m.keywords, 'keywords', 30).map(item => pluginText(item, 'Keyword', 50, 1));
  return {format: PLUGIN_FORMAT, manifest, files};
}
function validatePluginRegistrations(pkg, registry) {
  const files = pkg.files;
  const known = new Set(['nodes', 'templates', 'pages', 'tiles', 'commands', 'endpoints', 'settings', 'library']);
  for (const key of Object.keys(registry)) if (!known.has(key)) throw bad(`Unknown contribution: ${key.slice(0, 40)}`);
  const out = {};
  out.library = validateCatalogSections(registry.library);
  out.nodes = pluginList(registry.nodes, 'nodes', 50).map(path => pluginFile(files, path, '.json', 'nodes'));
  out.templates = uniquePluginItems(
    pluginList(registry.templates, 'templates', 50).map(t => {
      if (!isObject(t) || typeof t.id !== 'string' || !PLUGIN_ITEM.test(t.id)) throw bad('A template needs an id');
      return {
        id: t.id,
        name: pluginText(t.name ?? t.id, 'A template name', 100, 1),
        description: pluginText(t.description ?? '', 'A template description', 500),
        file: pluginFile(files, t.file, '.json', `template ${t.id}`),
      };
    }),
    'templates'
  );
  out.pages = uniquePluginItems(
    pluginList(registry.pages, 'pages', 50).map(p => {
      if (!isObject(p) || typeof p.id !== 'string' || !PLUGIN_ITEM.test(p.id)) throw bad('A page needs an id');
      if (p.section !== undefined && !['plugins', 'library'].includes(p.section))
        throw bad(`Page ${p.id}: section is "plugins" or "library"`);
      if (p.icon !== undefined) validateIcon(p.icon);
      let navigation;
      if (p.navigation !== undefined) {
        if (!isObject(p.navigation)) throw bad('Page navigation must be an object');
        navigation = {
          title: pluginText(p.navigation.title ?? 'Navigation', 'Navigation title', 100, 1),
          items: pluginList(p.navigation.items, 'Navigation items', 40).map(item => {
            if (!isObject(item) || !PLUGIN_ITEM.test(item.page ?? '')) throw bad('A navigation item needs a page id');
            validateIcon(item.icon ?? 'file');
            return {
              page: item.page,
              title: pluginText(item.title ?? item.page, 'Navigation label', 100, 1),
              icon: item.icon ?? 'file',
            };
          }),
        };
      }
      return {
        id: p.id,
        title: pluginText(p.title ?? p.id, 'A page title', 100, 1),
        icon: p.icon ?? 'file',
        section: p.section ?? 'plugins',
        ...(p.parent !== undefined ? {parent: pluginText(p.parent, 'A parent page id', 40, 1)} : {}),
        entry: pluginFile(files, p.entry, '.html', `page ${p.id}`),
        ...(navigation ? {navigation} : {}),
      };
    }),
    'pages'
  );
  checkHierarchy(out.pages, 'Page');
  for (const page of out.pages)
    for (const item of page.navigation?.items ?? [])
      if (!out.pages.some(p => p.id === item.page && p.section === page.section))
        throw bad('Override navigation can only select pages in the same section');
  out.tiles = uniquePluginItems(
    pluginList(registry.tiles, 'tiles', 20).map(t => {
      if (!isObject(t) || typeof t.id !== 'string' || !PLUGIN_ITEM.test(t.id)) throw bad('A tile needs an id');
      const height = t.height ?? 140;
      if (!Number.isInteger(height) || height < 60 || height > 600) throw bad(`Tile ${t.id}: height is 60 to 600`);
      return {
        id: t.id,
        title: pluginText(t.title ?? t.id, 'A tile title', 100, 1),
        height,
        entry: pluginFile(files, t.entry, '.html', `tile ${t.id}`),
      };
    }),
    'tiles'
  );
  out.commands = uniquePluginItems(
    pluginList(registry.commands, 'commands', 50).map(cmd => ({
      id: pluginText(cmd.id, 'Command id', 40, 1),
      title: pluginText(cmd.title ?? cmd.id, 'Command title', 100, 1),
      handler: pluginText(cmd.handler, 'Command handler', 100, 1),
    })),
    'commands'
  );
  out.endpoints = uniquePluginItems(
    pluginList(registry.endpoints, 'endpoints', 50).map(e => {
      if (!isObject(e) || typeof e.name !== 'string' || !PLUGIN_ITEM.test(e.name))
        throw bad('An endpoint needs a name');
      const methods = e.methods ?? ['POST'];
      if (!Array.isArray(methods) || !methods.length || methods.some(x => !PLUGIN_METHODS.includes(x)))
        throw bad(`Endpoint ${e.name}: methods is a list of ${PLUGIN_METHODS.join(', ')}`);
      if (e.permissions !== undefined) {
        if (!Array.isArray(e.permissions) || !e.permissions.length) throw bad('Endpoint permissions must be nonempty');
        checkManifest({grants: e.permissions.filter(p => p !== 'net.fetch:{host}')});
      }
      if (e.timeout !== undefined && (!Number.isInteger(e.timeout) || e.timeout < 100 || e.timeout > 300000))
        throw bad('Endpoint timeout must be 100 to 300000 milliseconds');
      return {
        name: e.name,
        methods: [...new Set(methods)],
        ...(e.permissions ? {permissions: [...new Set(e.permissions)]} : {}),
        ...(e.timeout ? {timeout: e.timeout} : {}),
        ...{handler: pluginText(e.handler, 'Endpoint handler', 100, 1)},
      };
    }),
    'endpoints'
  );
  out.settings = validatePluginSettingsSchema(registry.settings);
  for (const section of out.library)
    for (const field of section.item?.fields ?? [])
      if (field.type === 'list' && !out.endpoints.some(e => e.name === field.endpoint && e.methods.includes('POST')))
        throw bad('Library list endpoint must support POST: ' + field.endpoint);
  for (const section of out.library)
    for (const action of [...section.actions, ...section.folderActions, ...(section.item?.actions ?? [])])
      if (!out.endpoints.some(e => e.name === action.endpoint && e.methods.includes('POST')))
        throw bad('Library action endpoint must support POST: ' + action.endpoint);

  return out;
}

// ----- the registry -----
/** The installed plugins: [{id, enabled, installed, updated, source, grants, manifest}] (the files are in `plugins/<id>/package`). */
const pluginIndex = c => c.ctx.get(PLUGIN_INDEX, []);
async function pluginRecord(c, id) {
  const record = (await pluginIndex(c)).find(p => p.id === id);
  if (!record) throw missing('Plugin not found');
  return record;
}
async function pluginPackage(c, id) {
  const pkg = await c.ctx.get(pluginKey(id, 'package'), null);
  if (!pkg) throw missing('The files of this plugin are missing');
  return pkg;
}
function checkPluginGrants(manifest, grants) {
  if (!Array.isArray(grants) || grants.some(g => typeof g !== 'string' || !pluginCapabilities({manifest}).includes(g)))
    throw bad('grants lists capabilities that the plugin declares');
  return [...new Set(grants)];
}
const pluginFolderName = manifest => manifest.name.replaceAll('/', '-').trim().slice(0, 100) || manifest.id;
const pluginSlug = name =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'node';

/** The Library nodes the package contributes, ready to store: [{id, name, payload}]. Their ids are stable, so placed copies keep following them. */
function pluginCatalog(record, pkg) {
  const out = [],
    ids = new Set(),
    folder = pluginFolderName(pkg.manifest);
  for (const path of pluginContributions(pkg).nodes) {
    let entries;
    try {
      entries = TextGraph.decode(JSON.parse(pkg.files[path]));
    } catch (error) {
      throw bad(`${path}: ${error.message || 'not a Library catalog'}`);
    }
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (!isObject(entry) || typeof entry.name !== 'string' || !isObject(entry.payload))
        throw bad(`${path} is not an exported Custom Node catalog`);
      const name = entry.name.trim().slice(0, 100),
        id = `plugin.${record.id}.${pluginSlug(name)}`;
      if (!name || ids.has(id)) throw bad(`${path}: node names must be unique (“${name}”)`);
      ids.add(id);
      const inner = String(entry.payload.folder || '')
        .split('/')
        .map(p => p.trim())
        .filter(Boolean);
      const defaults = entry.payload.grants ?? [];
      checkManifest({grants: defaults});
      const payload = {
        ...clone(entry.payload),
        folder: [folder, ...inner].join('/'),
        grants: clone(defaults),
      };
      validateResource(payload);
      out.push({id, name, payload});
    }
  }
  return out;
}
/** Seed ordinary Library data once, like built-ins. Updates never overwrite edits or restore deleted nodes. */
async function seedPluginNodes(c, record, pkg) {
  const items = await c.ctx.get('resources', []);
  if (!record.enabled || !pkg) return nodeCount(items, record.id);
  const added = new Set(record.nodes_added ?? []);
  let created = false;
  for (const node of pluginCatalog(record, pkg)) {
    if (added.has(node.id)) continue;
    added.add(node.id);
    if (items.some(r => r.id === node.id || r.name === node.name)) continue;
    const now = Date.now() / 1000;
    items.push({...node, created: now, updated: now});
    created = true;
  }
  record.nodes_added = [...added];
  if (created) {
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
    c.ctx.set('resources', items);
    c.libraryTouched = true;
    const icons = await c.ctx.get('node_folder_icons', {}),
      folder = pluginFolderName(pkg.manifest);
    if (!icons[folder]) c.ctx.set('node_folder_icons', {...icons, [folder]: 'plug'});
  }
  return nodeCount(items, record.id);
}

// ----- settings and data -----
const pluginSettingsOf = (c, record) => c.ctx.get(pluginKey(record.id, 'settings'), {});
const emptyPluginData = () => ({entries: {}, bytes: 0});
async function pluginDataOperation(c, id, op, key, body = {}) {
  const dataKey = pluginKey(id, 'data');
  const data = await c.ctx.get(dataKey, emptyPluginData());
  if (op === 'list') {
    const prefix = String(body.prefix ?? '');
    return Object.entries(data.entries)
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, e]) => ({key: k, value: e.value, version: e.version, updated: e.updated}));
  }
  stateKey(key);
  const current = Object.hasOwn(data.entries, key) ? data.entries[key] : undefined;
  if (op === 'get') {
    if (!current) throw missing('No such key');
    return {key, value: current.value, version: current.version, updated: current.updated};
  }
  const expected = body.version;
  if (expected !== undefined) requireVersion(expected, current?.version ?? 0);
  if (op === 'delete') {
    if (!current) throw missing('No such key');
    data.bytes -= current.bytes;
    delete data.entries[key];
    c.ctx.set(dataKey, data);
    return {deleted: key};
  }
  if (!Object.hasOwn(body, 'value') || body.value === undefined) throw bad('Pass the JSON value to store');
  const value = jsonData(body.value),
    bytes = utf8Bytes(value);
  if (bytes > PLUGIN.dataValueBytes) throw bad(`A value is at most ${PLUGIN.dataValueBytes} bytes`);
  if (data.bytes - (current?.bytes ?? 0) + bytes > PLUGIN.dataBytes)
    throw bad(`The data of a plugin is at most ${PLUGIN.dataBytes} bytes`);
  if (!current && Object.keys(data.entries).length >= PLUGIN.dataKeys)
    throw bad(`A plugin has at most ${PLUGIN.dataKeys} keys`);
  const entry = {value, version: (current?.version ?? 0) + 1, updated: Date.now() / 1000, bytes};
  data.bytes += bytes - (current?.bytes ?? 0);
  data.entries[key] = entry;
  c.ctx.set(dataKey, data);
  return {key, value, version: entry.version, updated: entry.updated};
}

// ----- the bridge: what a plugin page or endpoint may ask of the API -----
const PLUGIN_LOG = new Map();
function logPlugin(id, entry) {
  const list = PLUGIN_LOG.get(id) ?? [];
  list.push({at: Date.now() / 1000, ...entry});
  if (list.length > PLUGIN.log) list.splice(0, list.length - PLUGIN.log);
  PLUGIN_LOG.set(id, list);
}
function pluginOwnsCollection(record, path) {
  const ownSection = /^library\/sections\/([^/]+)\/(items(?:\/[^/]+)?|folders)$/.exec(path);
  return !!(
    ownSection &&
    (pluginContributions(record).library ?? []).some(s => record.id + '.' + s.id === decodeURIComponent(ownSection[1]))
  );
}
/** A plugin may always use its own settings, data, log and endpoints; everything else needs a capability the plugin declares and a person granted. */
async function assertPluginPermission(record, method, path, body) {
  if (new RegExp(`^plugins/${record.id}/(data(/[^/]+)?|settings|log|call/[^/]+|commands/[^/]+)$`).test(path)) return;
  if (pluginOwnsCollection(record, path)) return;
  let needs = await permissionNeeds(method, path, body);
  const secrets = [...JSON.stringify(body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)].map(
    m => 'secrets.use:' + m[1]
  );
  needs = [...needs, ...secrets];
  const denied = needs.find(need => !allows(pluginCapabilities(record), need) || !allows(record.grants, need));
  if (denied) {
    logPlugin(record.id, {kind: 'denied', method, path, needs, error: 'Permission denied: ' + denied});
    throw new ApiError('permission_denied', `The plugin “${record.id}” has no permission: ${denied}`, 403);
  }
}
/** One call of a plugin to the API. Rights are read fresh each time, so a revoked grant or a disabled plugin stops at once. */
async function pluginBridgeRequest(id, method, path, body, query, origin = {}) {
  const {signal} = origin;
  assertExecutionCurrent(origin);
  const record = ((await DB.get(PLUGIN_INDEX)) ?? []).find(p => p.id === id);
  if (!record?.enabled) throw new ApiError('plugin_disabled', `The plugin “${id}” is not enabled`, 409);
  method = String(method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw bad('Unknown method');
  path = String(path)
    .replace(/^\/?(api\/)?/, '')
    .replace(/\/+$/, '');
  body = {...(body ?? {})};
  query = {...(query ?? {})};
  await assertPluginPermission(record, method, path, body);
  if (method === 'POST' && path === 'notifications') body.source = 'plugin:' + id; // a plugin cannot sign as someone else
  const dataRoute =
    /^plugins\/[^/]+\/data(\/|$)/.test(path) || /^projects\/[^/]+\/execution\/(scopes|operations)(\/|$)/.test(path);
  // Code a plugin writes into a graph is quarantined like code a Script writes: it holds no grants until a person gives them.
  if (method !== 'GET' && !dataRoute) {
    body = quarantineWrite(body);
    if (path === 'resources') body.payload = {...body.payload, grants: ['graph.read']};
    if (body.config) body.config = {...body.config, grants: ['graph.read']};
    if (path.startsWith('resources/') && body.payload) body.payload = {...body.payload, grants: ['graph.read']};
  }
  const result = await Backend.request(method, path, {body, query, scriptContext: origin});
  return dataRoute ||
    pluginOwnsCollection(record, path) ||
    /^projects\/[^/]+\/execution\/(scopes|operations)(\/|$)/.test(path)
    ? clone(result)
    : stripSecrets(result);
}

const canStartWorkers = () => typeof AGENTSYS_SPAWN_WORKER === 'function' || typeof Worker === 'function';
