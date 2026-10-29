// Native Library collections: declarative plugin sections, folders, typed resources and SKILL.md documents.
'use strict';

const CATALOG_FIELDS = ['text', 'textarea', 'number', 'boolean', 'select', 'json', 'secret'];
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
        if (!isObject(s.item) || !['json', 'skill'].includes(s.item.format ?? 'json'))
          throw bad('Item format is json or skill');
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
        if ((s.item.format ?? 'json') === 'skill' && fields.length)
          throw bad('Skill fields are name, description and instructions');
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
function readSkillMarkdown(source) {
  if (typeof source !== 'string' || source.length > 500000)
    throw bad('SKILL.md must be text of at most 500000 characters');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw bad('SKILL.md needs YAML frontmatter followed by Markdown instructions');
  const entries = new Map();
  let key;
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line);
    if (entry) {
      key = entry[1];
      if (entries.has(key)) throw bad('Duplicate frontmatter field: ' + key);
      entries.set(key, [entry[2] ?? '']);
    } else if (key && (/^\s/.test(line) || !line)) entries.get(key).push(line);
    else if (!line.startsWith('#')) throw bad('Invalid skill frontmatter');
  }
  const scalar = name => {
    const lines = entries.get(name);
    if (!lines) return '';
    const text = lines[0].trim();
    if (/^[|>][-+]?$/.test(text))
      return lines
        .slice(1)
        .map(s => s.replace(/^  /, ''))
        .join(text[0] === '>' ? ' ' : '\n')
        .trim();
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text);
      } catch {
        throw bad('Invalid quoted ' + name);
      }
    }
    return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text;
  };
  const name = scalar('name'),
    description = scalar('description'),
    instructions = match[2].replace(/^\r?\n/, '');
  checkSkillFields(name, description, instructions);
  return {
    name,
    description,
    instructions,
    extra: [...entries]
      .filter(([k]) => !['name', 'description'].includes(k))
      .map(([k, lines]) => k + ': ' + lines.join('\n'))
      .join('\n'),
  };
}
function checkSkillFields(name, description, instructions) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw bad('Skill name uses 1–64 lowercase letters, numbers and single hyphens');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024)
    throw bad('Skill description is required and at most 1024 characters');
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 400000)
    throw bad('Skill instructions are required and at most 400000 characters');
}
function skillMarkdown({name, description, instructions, extra = ''}) {
  checkSkillFields(name, description, instructions);
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra ? extra + '\n' : ''}---\n\n${instructions.trimEnd()}\n`;
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
      for (const section of plugin.manifest.contributes.library ?? []) {
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
  if (section.item.format === 'skill') {
    const source = await c.ctx.get(record.file, null);
    if (source === null) throw missing('SKILL.md is missing: ' + record.file);
    const skill = readSkillMarkdown(source);
    item = {
      ...item,
      name: skill.name,
      description: skill.description,
      values: {instructions: skill.instructions},
      content: source,
    };
  }
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
  const imported =
    section.item.format === 'skill' && input.content !== undefined ? readSkillMarkdown(input.content) : null;
  const rawName = input.name ?? imported?.name ?? previous?.name,
    name = typeof rawName === 'string' ? rawName.trim() : rawName,
    description = input.description ?? imported?.description ?? previous?.description ?? '',
    folder = catalogPath(input.folder ?? old?.folder ?? '');
  if (typeof name !== 'string' || !name.trim() || name.length > 100)
    throw bad('Item name is required and at most 100 characters');
  if (typeof description !== 'string' || description.length > 1024)
    throw bad('Description must be at most 1024 characters');
  const peers = await Promise.all(store.items.filter(r => r.id !== id).map(r => catalogRecord(c, section, r)));
  if (peers.some(r => r.name === name && (section.item.format === 'skill' || r.folder === folder)))
    throw bad('An item with that name already exists');
  const now = Date.now() / 1000,
    record = {id: old?.id ?? uid(), section: section.id, folder, created: old?.created ?? now, updated: now};
  if (section.item.format === 'skill') {
    const parsed = imported;
    const fields = parsed ?? {
      name,
      description,
      instructions: input.values?.instructions ?? previous?.values.instructions,
      extra: previous ? readSkillMarkdown(previous.content).extra : '',
    };
    if (parsed && (parsed.name !== name || parsed.description !== description))
      throw bad('Skill metadata must match its Markdown frontmatter');
    const source = skillMarkdown(fields);
    record.file = `library/skills/${section.id}/${name}/SKILL.md`;
    if (old?.file && old.file !== record.file) await c.ctx.remove(old.file);
    c.ctx.set(record.file, source);
  } else {
    const values = {...(old?.values ?? {}), ...(input.values ?? {})},
      clean = {},
      secrets = await c.ctx.get(catalogSecretKey(section.id, record.id), {});
    if (!isObject(input.values ?? {})) throw bad('Item values must be an object');
    if (Object.keys(input.values ?? {}).some(key => !section.item.fields.some(f => f.key === key)))
      throw bad('Unknown resource field');
    for (const field of section.item.fields) {
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
      if (item.file) await c.ctx.remove(item.file);
      await c.ctx.remove(catalogSecretKey(id, item.id));
    }
    await c.ctx.remove(catalogKey(id));
  }
}
const ownedCatalogSections = record => [
  ...new Set([...(record?.collections ?? []), ...(record?.manifest.contributes.library ?? []).map(s => s.id)]),
];
// One-time conversion of the first AI scaffold. Keep the original private entries as a migration archive.
async function migrateAICollections(c) {
  const data = await c.ctx.get(pluginKey('ai', 'data'), {entries: {}});
  for (const [key, entry] of Object.entries(data.entries)) {
    const kind = key.startsWith('providers:') ? 'providers' : key.startsWith('skills:') ? 'skills' : null;
    if (!kind || !isObject(entry.value)) continue;
    const section = 'ai.' + kind,
      store = await c.ctx.get(catalogKey(section), {folders: [], items: []});
    const id = key.slice(key.indexOf(':') + 1);
    if (store.items.some(r => r.id === id)) continue;
    const value = entry.value,
      now = Date.now() / 1000,
      record = {id, section, folder: '', created: entry.updated ?? now, updated: now};
    const name = String(value.name || kind.slice(0, -1)),
      detail = String(value.detail ?? '');
    if (kind === 'skills') {
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 54)
          .replace(/-$/, '') || 'skill';
      let unique = slug,
        suffix = 2;
      while (store.items.some(r => r.file?.endsWith('/' + unique + '/SKILL.md'))) unique = slug + '-' + suffix++;
      record.file = `library/skills/${section}/${unique}/SKILL.md`;
      c.ctx.set(
        record.file,
        skillMarkdown({name: unique, description: detail.slice(0, 1024) || name, instructions: detail || name})
      );
    } else {
      Object.assign(record, {
        name,
        description: detail.slice(0, 1024),
        values: {
          providerId: 'imported-' + id.slice(0, 20),
          npm: '@ai-sdk/openai-compatible',
          baseURL: /^https?:\/\//.test(detail) ? detail : '',
          models: {},
          env: [],
          headers: {},
          options: {},
        },
      });
    }
    store.items.push(record);
    c.ctx.set(catalogKey(section), store);
  }
}
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
        if (item.file) await c.ctx.remove(item.file);
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
    if (item.file) await c.ctx.remove(item.file);
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
