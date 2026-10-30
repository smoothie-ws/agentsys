// Plugins (backend): the package format and its validation, the registry of installed plugins, what an enabled plugin puts into the
// Library, its private settings and data, the checked bridge its pages use, and the isolated Worker its endpoints run in.
// The routes are in routes-plugins.js; the contract is in docs/plugins.md.
'use strict';

const PLUGIN_FORMAT = 'agentsys.plugin/1';
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
  endpointsAtOnce: 4,
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

/**
 * Checks a package from outside and returns a clean copy: {format, manifest, files}. `manifest.contributes` names files of the package
 * for each extension point; a name that is not a file, a duplicate, or a capability the system does not know is an error.
 */
function validatePluginPackage(input, runtime = false) {
  if (input?.format === 'agentsys.plugin/2') return validateRuntimePackage(input);
  if (!isObject(input) || input.format !== PLUGIN_FORMAT || !isObject(input.manifest) || !isObject(input.files))
    throw bad(`A plugin package is {format: "${PLUGIN_FORMAT}", manifest, files}`);
  const files = {};
  let total = 0;
  const names = Object.keys(input.files);
  if (names.length > PLUGIN.files) throw bad(`A plugin has at most ${PLUGIN.files} files`);
  for (const name of names) {
    pluginFilePath(name);
    const text = input.files[name];
    if (typeof text !== 'string') throw bad(`File ${name} must be text`);
    if (text.length > PLUGIN.fileBytes) throw bad(`File ${name} is larger than ${PLUGIN.fileBytes} characters`);
    total += text.length;
    files[name] = text;
  }
  if (total > PLUGIN.totalBytes) throw bad(`A plugin package is at most ${PLUGIN.totalBytes} characters`);
  const m = input.manifest,
    contributes = isObject(m.contributes) ? m.contributes : {};
  if (m.contributes !== undefined && !isObject(m.contributes)) throw bad('contributes must be an object');
  if (typeof m.id !== 'string' || !PLUGIN_ID.test(m.id))
    throw bad('The plugin id is 2 to 40 characters: a lower-case letter, then letters, digits and -');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(m.version))
    throw bad('version is like 1.0.0');
  const manifest = {
    id: m.id,
    name: pluginText(m.name, 'The plugin name', 100, 1).trim(),
    version: m.version,
    description: pluginText(m.description ?? '', 'The description', 2000),
    author: pluginText(m.author ?? '', 'The author', 100),
    icon: m.icon === undefined ? 'plug' : m.icon,
    capabilities: [...new Set(pluginList(m.capabilities, 'capabilities', 50))],
    secrets: [...new Set(pluginList(m.secrets, 'secrets', 20))],
    contributes: {},
  };
  const engine = checkPluginEngine(m.engine);
  if (engine) manifest.engine = engine;
  if (Object.hasOwn(files, manifest.icon)) {
    const asset = files[manifest.icon];
    if (manifest.icon.endsWith('.svg') && /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(asset) && asset.length <= 50000)
      manifest.icon = 'data:image/svg+xml,' + encodeURIComponent(asset);
    else if (/^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(asset)) manifest.icon = asset;
    else throw bad('A plugin icon file must be SVG text or a PNG data URL');
  }
  validateIcon(manifest.icon);
  if (m.readme !== undefined) manifest.readme = pluginFile(files, m.readme, '.md', 'readme');
  if (m.homepage !== undefined) {
    if (typeof m.homepage !== 'string' || !/^https:\/\/[^\s]+$/.test(m.homepage))
      throw bad('Plugin homepage must be an HTTPS URL');
    manifest.homepage = m.homepage;
  }
  checkManifest({capabilities: manifest.capabilities});
  for (const name of manifest.secrets)
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw bad('Invalid secret name');
  const known = new Set(['nodes', 'templates', 'pages', 'tiles', 'commands', 'endpoints', 'settings', 'library']);
  for (const key of Object.keys(contributes))
    if (!known.has(key)) throw bad(`Unknown contribution: ${key.slice(0, 40)}`);
  const out = manifest.contributes;
  out.library = validateCatalogSections(contributes.library);
  out.nodes = pluginList(contributes.nodes, 'nodes', 50).map(path => pluginFile(files, path, '.json', 'nodes'));
  out.templates = uniquePluginItems(
    pluginList(contributes.templates, 'templates', 50).map(t => {
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
    pluginList(contributes.pages, 'pages', 50).map(p => {
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
    pluginList(contributes.tiles, 'tiles', 20).map(t => {
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
    pluginList(contributes.commands, 'commands', 50).map(cmd => {
      if (!isObject(cmd) || typeof cmd.id !== 'string' || !PLUGIN_ITEM.test(cmd.id)) throw bad('A command needs an id');
      if ([cmd.page, cmd.path, ...(runtime ? [cmd.handler] : [])].filter(v => v !== undefined).length !== 1)
        throw bad(`Command ${cmd.id}: give either "page" (a page of the plugin) or "path" (a page of the app)`);
      if (cmd.page !== undefined && !out.pages.some(p => p.id === cmd.page))
        throw bad(`Command ${cmd.id}: there is no page "${String(cmd.page).slice(0, 40)}"`);
      if (cmd.path !== undefined && (typeof cmd.path !== 'string' || !/^\/[A-Za-z0-9_\-/?=&%.]{0,198}$/.test(cmd.path)))
        throw bad(`Command ${cmd.id}: path is a page of the app, like /projects`);
      return {
        id: cmd.id,
        title: pluginText(cmd.title ?? cmd.id, 'A command title', 100, 1),
        ...(cmd.page !== undefined ? {page: cmd.page} : runtime && cmd.handler !== undefined
          ? {handler: pluginText(cmd.handler, 'Command handler', 100, 1)} : {path: cmd.path}),
      };
    }),
    'commands'
  );
  out.endpoints = uniquePluginItems(
    pluginList(contributes.endpoints, 'endpoints', 50).map(e => {
      if (!isObject(e) || typeof e.name !== 'string' || !PLUGIN_ITEM.test(e.name))
        throw bad('An endpoint needs a name');
      const methods = e.methods ?? ['POST'];
      if (!Array.isArray(methods) || !methods.length || methods.some(x => !PLUGIN_METHODS.includes(x)))
        throw bad(`Endpoint ${e.name}: methods is a list of ${PLUGIN_METHODS.join(', ')}`);
      if (e.permissions !== undefined) {
        if (!Array.isArray(e.permissions) || !e.permissions.length) throw bad('Endpoint permissions must be nonempty');
        checkManifest({grants:e.permissions.filter(p=>p!=='net.fetch:{host}')});
      }
      if (e.timeout !== undefined && (!Number.isInteger(e.timeout) || e.timeout < 100 || e.timeout > 300000)) throw bad('Endpoint timeout must be 100 to 300000 milliseconds');
      return {
        name: e.name,
        methods: [...new Set(methods)],
        ...(e.permissions ? {permissions:[...new Set(e.permissions)]} : {}),
        ...(e.timeout ? {timeout:e.timeout} : {}),
        ...(runtime && e.handler !== undefined
          ? {handler: pluginText(e.handler, 'Endpoint handler', 100, 1)}
          : {entry: pluginFile(files, e.entry, '.js', `endpoint ${e.name}`)}),
      };
    }),
    'endpoints'
  );
  out.settings = validatePluginSettingsSchema(contributes.settings);
  for (const section of out.library)
    for (const field of section.item?.fields ?? [])
      if (field.type === 'list' && !out.endpoints.some(e => e.name === field.endpoint && e.methods.includes('POST')))
        throw bad('Library list endpoint must support POST: ' + field.endpoint);
  for (const section of out.library)
    for (const action of [...section.actions, ...section.folderActions, ...(section.item?.actions ?? [])])
      if (!out.endpoints.some(e => e.name === action.endpoint && e.methods.includes('POST')))
        throw bad('Library action endpoint must support POST: ' + action.endpoint);
  return {format: PLUGIN_FORMAT, manifest, files};
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
      const defaults = entry.payload.grants ?? entry.payload.capabilities ?? [];
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
  // Migrate old ownership metadata without changing definitions, defaults or update stamps.
  let migrated = false;
  for (const item of items) {
    if (!Object.hasOwn(item.payload, 'plugin')) continue;
    delete item.payload.plugin;
    migrated = true;
  }
  if (migrated) c.ctx.set('resources', items);
  if (!record.enabled || !pkg) return nodeCount(items, record.id);
  const added = new Set(record.nodes_added ?? items.filter(r => r.id.startsWith(`plugin.${record.id}.`)).map(r => r.id));
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
    const icons = await c.ctx.get('node_folder_icons', {}), folder = pluginFolderName(pkg.manifest);
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
  const current = data.entries[key];
  if (op === 'get') {
    if (!current) throw missing('No such key');
    return {key, value: current.value, version: current.version, updated: current.updated};
  }
  const expected = body.version;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0))
    throw bad('version is a whole number of 0 or more');
  if (expected !== undefined && expected !== (current?.version ?? 0))
    throw new ApiError('conflict', `The version of "${key}" changed. Read it again and retry.`, 409);
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
  return !!(ownSection &&
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
async function pluginBridgeRequest(id, method, path, body, query, {signal} = {}) {
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
  const dataRoute = /^plugins\/[^/]+\/data(\/|$)/.test(path);
  // Code a plugin writes into a graph is quarantined like code a Script writes: it holds no grants until a person gives them.
  if (method !== 'GET' && !dataRoute) {
    body = quarantineWrite(body);
    if (path === 'resources') body.payload = {...body.payload, grants: ['graph.read']};
    if (body.config) body.config = {...body.config, grants: ['graph.read']};
    if (path.startsWith('resources/') && body.payload) body.payload = {...body.payload, grants: ['graph.read']};
  }
  const result = await Backend.request(method, path, {body, query,scriptContext:signal?{signal}:null});
  return dataRoute || pluginOwnsCollection(record, path) ? clone(result) : stripSecrets(result);
}

// ----- endpoints: plugin code in an isolated Worker -----
// The source below is a Worker like the Scripts' (scripts.js): no network, no host APIs, intrinsics frozen. The code of an endpoint is
// the body of `async (request, agentsys, plugin) => {…}` and returns JSON; `agentsys(method, path, body, query)` is the checked
// bridge, `plugin.data` the plugin's private store and `plugin.settings` its settings.
const PLUGIN_WORKER_SOURCE = `
(() => {
const send = globalThis.postMessage.bind(globalThis);
${WORKER_FREEZE}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const pending = new Map();
let sequence = 0;
const ask = (type, args) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, {resolve, reject}); send({type, id, args}); });
self.onerror = () => true;
const receive = async ({data}) => {
  if (data.type === 'reply') {
    const entry = pending.get(data.id); pending.delete(data.id);
    return data.error ? entry.reject(Object.assign(new Error(data.error), {code: data.code})) : entry.resolve(data.result);
  }
  try {
    const agentsys = (method, path, body, query) => ask('call', [method, path, body, query]);
    const plugin = {
      id: data.plugin,
      settings: data.settings,
      data: {
        get: key => ask('data', ['get', key]),
        set: (key, value, version) => ask('data', ['set', key, value, version]),
        delete: (key, version) => ask('data', ['delete', key, version]),
        list: prefix => ask('data', ['list', prefix]),
      },
    };
    const result = await new AsyncFunction('request', 'agentsys', 'plugin', data.code)(data.request, agentsys, plugin);
    send({type: 'finished', result: JSON.stringify(result === undefined ? null : result)});
  } catch (error) {
    send({type: 'crash', error: String(error && error.message || error).slice(0, 2000), code: error && error.code});
  }
};
globalThis.addEventListener?.('message', receive);
${workerBlock(WORKER_BLOCKED.filter(name => name !== 'Date' && name !== 'Math'))}
return text => receive({data: JSON.parse(text)});
})();`;

let pluginCalls = 0;
function runPluginInWorker(code, input, host) {
  return new Promise((resolve, reject) => {
    const worker = startSourceWorker(PLUGIN_WORKER_SOURCE);
    let over = false;
    const finish = (action, value) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      worker.terminate();
      action(value);
    };
    const timer = setTimeout(
      () => finish(reject, new ApiError('timeout', `The endpoint took longer than ${PLUGIN.endpointMs / 1000} s`, 504)),
      PLUGIN.endpointMs
    );
    worker.onmessage = async ({data}) => {
      if (over) return;
      if (data.type === 'call' || data.type === 'data') {
        let reply;
        try {
          reply = {type: 'reply', id: data.id, result: await host[data.type](data.args)};
        } catch (error) {
          reply = {type: 'reply', id: data.id, error: error.message || String(error), code: error.code};
        }
        if (!over) worker.postMessage(reply);
      } else if (data.type === 'finished') finish(resolve, data.result);
      else finish(reject, Object.assign(new Error(data.error || 'The endpoint failed'), {code: data.code}));
    };
    worker.onerror = event => finish(reject, new Error(event.message || 'The endpoint stopped without an answer'));
    worker.postMessage({type: 'run', code, ...input});
  });
}
/** Without Workers (the tests' inline mode) the endpoint runs in this realm, with the same bridge and no isolation. */
async function runPluginInline(code, input, host) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const plugin = {
    id: input.plugin,
    settings: input.settings,
    data: {
      get: key => host.data(['get', key]),
      set: (key, value, version) => host.data(['set', key, value, version]),
      delete: (key, version) => host.data(['delete', key, version]),
      list: prefix => host.data(['list', prefix]),
    },
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ApiError('timeout', 'The endpoint took too long', 504)), PLUGIN.endpointMs);
  });
  try {
    const result = await Promise.race([
      new AsyncFunction('request', 'agentsys', 'plugin', code)(input.request, (...args) => host.call(args), plugin),
      timeout,
    ]);
    return JSON.stringify(result === undefined ? null : result);
  } finally {
    clearTimeout(timer);
  }
}
const canStartWorkers = () => typeof AGENTSYS_SPAWN_WORKER === 'function' || typeof Worker === 'function';

/** Calls an endpoint of an enabled plugin. Returns its JSON answer. */
async function callPluginEndpoint(record, endpoint, code, request) {
  if (pluginCalls >= PLUGIN.endpointsAtOnce)
    throw new ApiError('too_many_calls', 'Too many plugin endpoints are running; try again in a moment', 429);
  pluginCalls++;
  const started = Date.now();
  const entry = {kind: 'endpoint', endpoint: endpoint.name, method: request.method};
  try {
    const schema = pluginContributions(record).settings,
      saved = (await DB.get(pluginKey(record.id, 'settings'))) ?? {};
    const host = {
      call: ([method, path, body, query]) => pluginBridgeRequest(record.id, method, path, body, query),
      data: async ([op, key, value, version]) => {
        const method = {get: 'GET', list: 'GET', set: 'PUT', delete: 'DELETE'}[op];
        if (!method) throw bad('Unknown data operation');
        if (op === 'list') return Backend.request('GET', `plugins/${record.id}/data`, {query: {prefix: key ?? ''}});
        return Backend.request(method, `plugins/${record.id}/data/${encodeURIComponent(key)}`, {
          body: {...(op === 'set' ? {value} : {}), ...(version == null ? {} : {version})}, // a Worker sends undefined as null
        });
      },
    };
    const input = {plugin: record.id, settings: pluginSettingValues(schema, saved), request};
    const text = await (canStartWorkers() ? runPluginInWorker : runPluginInline)(code, input, host);
    if (text.length > PLUGIN.resultBytes)
      throw bad(`An endpoint answers with at most ${PLUGIN.resultBytes} characters`);
    logPlugin(record.id, {...entry, ms: Date.now() - started});
    return JSON.parse(text);
  } catch (error) {
    logPlugin(record.id, {...entry, ms: Date.now() - started, error: String(error.message || error).slice(0, 500)});
    throw error;
  } finally {
    pluginCalls--;
  }
}
