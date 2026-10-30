// Native Library collections: plugin-owned sections, folders and typed JSON resources.
'use strict';

const CATALOG_FIELDS = ['text', 'textarea', 'number', 'boolean', 'select', 'json', 'secret', 'list'];
const catalogKey = section => `library/sections/${section}`;
const catalogSecretKey = (section, id) => `library/credentials/${section}/${id}`;
const catalogPath = value => {
  if (typeof value !== 'string' || value.length > 200) throw bad('Folder must be a path of at most 200 characters');
  const parts = value
    .split('/')
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.some(s => ['.', '..'].includes(s) || /[\x00-\x1f\\]/.test(s))) throw bad('Invalid folder path');
  return parts.join('/');
};
function checkHierarchy(items, label) {
  for (const item of items) {
    const seen = new Set([item.id]);
    let current = item;
    while (current.parent !== undefined) {
      const parent = items.find(p => p.id === current.parent);
      if (!parent || (item.section && parent.section !== item.section))
        throw bad(`${label} ${item.id}: parent must exist in the same section`);
      if (seen.has(parent.id)) throw bad(`${label} ${item.id}: parents form a cycle`);
      seen.add(parent.id);
      current = parent;
    }
  }
}
function validateCatalogSections(value) {
  const sections = uniquePluginItems(
    pluginList(value, 'library', 30).map(s => {
      if (!isObject(s) || !PLUGIN_ITEM.test(s.id ?? '')) throw bad('A Library section needs an id');
      validateIcon(s.icon ?? 'folder');
      const actions = list =>
        uniquePluginItems(
          pluginList(list, 'Library actions', 20).map(a => {
            if (!isObject(a) || !PLUGIN_ITEM.test(a.id ?? '') || !PLUGIN_ITEM.test(a.endpoint ?? ''))
              throw bad('An action needs an id and endpoint');
            return {id: a.id, title: pluginText(a.title, 'Action title', 100, 1), endpoint: a.endpoint};
          }),
          'Library actions'
        );
      const out = {
        id: s.id,
        title: pluginText(s.title, 'Library title', 100, 1),
        description: pluginText(s.description ?? '', 'Library description', 1000),
        icon: s.icon ?? 'folder',
        actions: actions(s.actions),
        folderActions: actions(s.folderActions),
      };
      if (s.parent !== undefined) out.parent = pluginText(s.parent, 'Parent section', 40, 1);
      if (s.item !== undefined) {
        if (!isObject(s.item) || (s.item.format ?? 'json') !== 'json')
          throw bad('Item format must be json');
        const fields = uniquePluginItems(
          pluginList(s.item.fields, 'Item fields', 40).map(f => {
            if (
              !isObject(f) ||
              !/^[a-z][A-Za-z0-9_]{0,39}$/.test(f.key ?? '') ||
              ['name', 'description', 'constructor', 'prototype', '__proto__'].includes(f.key)
            )
              throw bad('A field needs a unique key');
            if (!CATALOG_FIELDS.includes(f.type)) throw bad('Unsupported Library field type');
            const field = {
              key: f.key,
              label: pluginText(f.label ?? f.key, 'Field label', 100, 1),
              type: f.type,
              required: f.required === true,
              help: pluginText(f.help ?? '', 'Field help', 1000),
            };
            if (f.type === 'list') {
              if (!PLUGIN_ITEM.test(f.endpoint ?? '')) throw bad('A list needs a plugin endpoint');
              field.endpoint = f.endpoint;
              field.required = false;
            }
            if (f.type === 'select') {
              if (
                !Array.isArray(f.options) ||
                !f.options.length ||
                f.options.length > 100 ||
                f.options.some(o => typeof o !== 'string' || !o)
              )
                throw bad('Select options must be nonempty strings');
              field.options = [...new Set(f.options)];
            }
            if (f.shape !== undefined) {
              if (f.type !== 'json' || !['object', 'array'].includes(f.shape))
                throw bad('JSON shape is object or array');
              field.shape = f.shape;
            }
            if (f.format !== undefined) {
              if (f.type !== 'text' || !['url', 'id'].includes(f.format)) throw bad('Text format is url or id');
              field.format = f.format;
            }
            if (f.unique === true) {
              if (!['text', 'select', 'number'].includes(f.type))
                throw bad('Unique fields must be text, select or number');
              field.unique = true;
            }
            if (f.default !== undefined && f.type !== 'secret') field.default = catalogFieldValue(field, f.default);
            return field;
          }),
          'item fields'
        );
        out.item = {
          name: pluginText(s.item.name ?? 'Item', 'Item name', 80, 1),
          format: s.item.format ?? 'json',
          fields,
          actions: actions(s.item.actions),
        };
      }
      return out;
    }),
    'Library sections'
  );
  checkHierarchy(sections, 'Library section');
  return sections;
}
function catalogFieldValue(field, value) {
  const fail = message => {
    throw bad(`${field.label}: ${message}`);
  };
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') fail('use true or false');
  } else if (field.type === 'number') {
    if (!finite(value)) fail('use a finite number');
  } else if (field.type === 'json') {
    if (field.shape === 'object' && !isObject(value)) fail('use a JSON object');
    if (field.shape === 'array' && !Array.isArray(value)) fail('use a JSON array');
    if (JSON.stringify(value).length > 50000) fail('value is too large');
  } else {
    if (typeof value !== 'string' || value.length > (field.type === 'textarea' ? 100000 : 4000)) fail('invalid text');
    if (field.required && !value.trim()) fail('a value is required');
    if (field.type === 'select' && !field.options.includes(value)) fail('choose one of the available options');
    if (field.format === 'id' && value && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
      fail('use up to 64 lowercase letters, numbers, hyphens or underscores');
    if (field.format === 'url' && value) {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) fail('use an HTTP or HTTPS URL');
      } catch {
        fail('use an HTTP or HTTPS URL');
      }
    }
  }
  return clone(value);
}
async function librarySections(c) {
  const builtIn = {
    id: 'nodes',
    title: 'Nodes',
    description: 'Reusable workflow nodes.',
    icon: 'library',
    actions: [],
    item: {name: 'Node', format: 'graph', fields: [], actions: []},
  };
  const sections = [builtIn];
  for (const plugin of await pluginIndex(c))
    if (plugin.enabled)
      for (const section of pluginContributions(plugin).library ?? []) {
        sections.push({
          ...section,
          id: plugin.id + '.' + section.id,
          ...(section.parent ? {parent: plugin.id + '.' + section.parent} : {}),
          plugin: plugin.id,
        });
      }
  return sections;
}
async function librarySection(c, id) {
  const section = (await librarySections(c)).find(s => s.id === id);
  if (!section) throw missing('Library section not found or its plugin is disabled');
  return section;
}
async function catalogRecord(c, section, record) {
  let item = clone(record);
  item.values = {...Object.fromEntries(section.item.fields.filter(f=>f.default!==undefined).map(f=>[f.key,clone(f.default)])),...(item.values??{})};
  for (const field of section.item.fields) if (field.type === 'list') delete item.values[field.key];
  const secrets = await c.ctx.get(catalogSecretKey(section.id, record.id), {});
  item.secrets = Object.fromEntries(Object.keys(secrets).map(k => [k, true]));
  return item;
}
async function catalogList(c, section) {
  if (section.id === 'nodes')
    return {
      folders: await nodeFolders(c),
      items: (await c.ctx.get('resources', [])).map(r => ({
        id: r.id,
        section: 'nodes',
        name: r.name,
        description: r.payload.description ?? '',
        folder: r.payload.folder ?? '',
        icon: r.payload.icon || 'complex',
      })),
    };
  const stored = await c.ctx.get(catalogKey(section.id), {folders: [], items: []});
  return {...stored, items: await Promise.all(stored.items.map(r => catalogRecord(c, section, r)))};
}
async function saveCatalogItem(c, section, id, input) {
  if (!section.item || section.id === 'nodes') throw bad('Choose a resource collection');
  if (!isObject(input)) throw bad('A Library item must be an object');
  const store = await c.ctx.get(catalogKey(section.id), {folders: [], items: []}),
    old = id && store.items.find(r => r.id === id);
  if (id && !old) throw missing('Library item not found');
  const previous = old && (await catalogRecord(c, section, old));
  const rawName = input.name ?? previous?.name,
    name = typeof rawName === 'string' ? rawName.trim() : rawName,
    description = input.description ?? previous?.description ?? '',
    folder = catalogPath(input.folder ?? old?.folder ?? '');
  if (typeof name !== 'string' || !name.trim() || name.length > 100)
    throw bad('Item name is required and at most 100 characters');
  if (typeof description !== 'string' || description.length > 1024)
    throw bad('Description must be at most 1024 characters');
  const peers = await Promise.all(store.items.filter(r => r.id !== id).map(r => catalogRecord(c, section, r)));
  if (peers.some(r => r.name === name && r.folder === folder))
    throw bad('An item with that name already exists');
  const now = Date.now() / 1000,
    record = {id: old?.id ?? uid(), section: section.id, folder, created: old?.created ?? now, updated: now};
  {
    const values = {...(old?.values ?? {}), ...(input.values ?? {})},
      clean = {},
      secrets = await c.ctx.get(catalogSecretKey(section.id, record.id), {});
    if (!isObject(input.values ?? {})) throw bad('Item values must be an object');
    if (Object.keys(input.values ?? {}).some(key => !section.item.fields.some(f => f.key === key && f.type !== 'list')))
      throw bad('Unknown resource field');
    for (const field of section.item.fields) {
      if (field.type === 'list') continue;
      const value =
        values[field.key] ??
        field.default ??
        (field.type === 'boolean'
          ? false
          : field.type === 'json'
            ? field.shape === 'array'
              ? []
              : {}
            : field.type === 'select'
              ? field.options[0]
              : '');
      if (field.type === 'secret') {
        if (Object.hasOwn(input.values ?? {}, field.key)) {
          catalogFieldValue({...field, required: false}, value);
          if (value) secrets[field.key] = value;
          else delete secrets[field.key];
        }
        if (field.required && !secrets[field.key]) throw bad(field.label + ': a value is required');
      } else clean[field.key] = catalogFieldValue(field, value);
    }
    for (const field of section.item.fields.filter(f => f.unique))
      if (peers.some(r => r.values?.[field.key] === clean[field.key]))
        throw bad(field.label + ': this value already exists');
    Object.assign(record, {name: name.trim(), description, values: clean});
    c.ctx.set(catalogSecretKey(section.id, record.id), secrets);
  }
  if (folder)
    for (let i = 1, parts = folder.split('/'); i <= parts.length; i++)
      if (!store.folders.includes(parts.slice(0, i).join('/'))) store.folders.push(parts.slice(0, i).join('/'));
  store.items = [...store.items.filter(r => r.id !== record.id), record];
  c.ctx.set(catalogKey(section.id), store);
  return catalogRecord(c, section, record);
}
async function removePluginCollections(c, record) {
  for (const section of ownedCatalogSections(record)) {
    const id = record.id + '.' + section,
      store = await c.ctx.get(catalogKey(id), {items: []});
    for (const item of store.items) {
      await c.ctx.remove(catalogSecretKey(id, item.id));
    }
    await c.ctx.remove(catalogKey(id));
  }
}
const ownedCatalogSections = record => [
  ...new Set([...(record?.collections ?? []), ...(pluginContributions(record).library ?? []).map(s => s.id)]),
];
async function catalogFolders(c, section, body) {
  if (section.id === 'nodes' || !section.item) throw bad('Folders belong to a resource collection');
  const store = await c.ctx.get(catalogKey(section.id), {folders: [], items: []}),
    path = catalogPath(body.path ?? '');
  if (body.action === 'create') {
    const name = catalogPath(body.name ?? '');
    if (!name || name.includes('/')) throw bad('Use a folder name without slashes');
    const full = path ? path + '/' + name : name;
    if (store.folders.includes(full)) throw bad('Folder already exists');
    for (let i = 1, parts = full.split('/'); i <= parts.length; i++)
      if (!store.folders.includes(parts.slice(0, i).join('/'))) store.folders.push(parts.slice(0, i).join('/'));
  } else {
    if (!path || !store.folders.includes(path)) throw missing('Folder not found');
    if (body.action === 'rename') {
      const name = catalogPath(body.name ?? '');
      if (!name || name.includes('/')) throw bad('Use a folder name without slashes');
      const next = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) + name : name;
      if (next !== path && store.folders.includes(next)) throw bad('Folder already exists');
      const fix = p => (underPath(p, path) ? next + p.slice(path.length) : p);
      store.folders = store.folders.map(fix);
      store.items.forEach(r => (r.folder = fix(r.folder)));
    } else if (body.action === 'delete') {
      for (const item of store.items.filter(r => underPath(r.folder, path))) {
        await c.ctx.remove(catalogSecretKey(section.id, item.id));
      }
      store.folders = store.folders.filter(p => !underPath(p, path));
      store.items = store.items.filter(r => !underPath(r.folder, path));
    } else throw bad('Folder action is create, rename or delete');
  }
  c.ctx.set(catalogKey(section.id), store);
  return {folders: store.folders};
}

route('GET', 'library/sections', 'List the native Library sections', async c => librarySections(c));
route('GET', 'library/sections/{section}/items', 'List a Library collection and its folders', async (c, {section}) => {
  const result = await catalogList(c, await librarySection(c, section));
  return c.query.summary ? {...result, items: result.items.map(({values, content, ...item}) => item)} : result;
});
route('POST', 'library/sections/{section}/items', 'Create a typed Library resource', async (c, {section}) =>
  saveCatalogItem(c, await librarySection(c, section), null, c.body)
);
route(
  'GET PUT DELETE',
  'library/sections/{section}/items/{id}',
  'Read, edit or delete a Library resource',
  async (c, {section, id}) => {
    const definition = await librarySection(c, section);
    if (section === 'nodes') throw bad('Workflow nodes use the node editor');
    const store = await c.ctx.get(catalogKey(section), {folders: [], items: []}),
      item = store.items.find(r => r.id === id);
    if (!item) throw missing('Library item not found');
    if (c.method === 'GET') return catalogRecord(c, definition, item);
    if (c.method === 'PUT') return saveCatalogItem(c, definition, id, c.body);
    await c.ctx.remove(catalogSecretKey(section, id));
    store.items = store.items.filter(r => r.id !== id);
    c.ctx.set(catalogKey(section), store);
    return {deleted: true};
  }
);
route(
  'POST',
  'library/sections/{section}/folders',
  'Create, rename or delete a collection folder',
  async (c, {section}) => catalogFolders(c, await librarySection(c, section), c.body)
);
