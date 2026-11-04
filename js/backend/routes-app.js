// Routes: session, settings, search, and the Library nodes.
'use strict';

// ----- application -----
route('GET', 'session', 'Read the session', async c => ({
  preferences: await c.prefs(),
  shortcut_defaults: DEFAULT_SHORTCUTS,
}));

route(
  'GET PUT',
  'settings',
  'Read or change application settings',
  async c => {
    const prefs = await c.prefs();
    if (c.method === 'GET')
      return {
        preferences: prefs,
        resources: await c.ctx.get('resources', []),
        node_folders: await nodeFolders(c),
        node_folder_icons: await c.ctx.get('node_folder_icons', {}),
      };
    const value = c.body;
    if ('undo_steps' in value) {
      if (!Number.isInteger(value.undo_steps) || value.undo_steps < 0 || value.undo_steps > 500)
        throw bad('Undo steps must be an integer from 0 to 500');
      prefs.undo_steps = value.undo_steps;
      for (const history of histories.values())
        history.undo = value.undo_steps ? history.undo.slice(-value.undo_steps) : [];
    }
    if ('developer_mode' in value) {
      if (typeof value.developer_mode !== 'boolean') throw bad('developer_mode must be true or false');
      prefs.developer_mode = value.developer_mode;
    }
    if ('shortcuts' in value) prefs.shortcuts = validateShortcuts(value.shortcuts);
    if ('style' in value) prefs.style = validateAppearance(value.style, prefs.style);
    delete prefs.themes; // saved themes and the selected theme were removed: the palette is the style
    delete prefs.theme;
    if (prefs.style) delete prefs.style.components;
    c.ctx.set('prefs', prefs);
    return prefs;
  },
  {body: {undo_steps: 50, developer_mode: false}}
);

route(
  'GET',
  'search/nodes',
  'Search nodes across all projects',
  async c => {
    const q = c.query.q ?? '',
      offset = Number(c.query.offset ?? 0),
      limit = Number(c.query.limit ?? 100);
    if (typeof q !== 'string' || q.length > 240 || offset < 0 || !(limit >= 1 && limit <= 200))
      throw bad('Search requires a query up to 240 characters, a nonnegative offset and a limit from 1 to 200');
    const norm = s => String(s).normalize('NFKC').toLowerCase();
    const terms = norm(q).replace(/\//g, ' ').split(/\s+/).filter(Boolean),
      matches = [];
    for (const project of await c.projects())
      for (const wf of project.workflows) {
        const doc = await c.ctx.get('wf:' + wf.id, emptyDoc());
        const entries = [
          ...doc.nodes.map(n => ({
            id: n.id,
            kind: n.kind,
            node_type: n.node_type,
            label: n.config?.title || n.label,
            words: n.node_type + ' ' + (n.config?.op || ''),
          })),
          ...doc.groups.map(g => ({id: 'group:' + g.id, kind: 'group', label: g.name, words: 'group'})),
        ];
        for (const e of entries) {
          const text = norm([project.name, wf.name, project.id, e.kind, e.label, e.words, e.id].join(' '));
          if (terms.every(t => text.includes(t)))
            matches.push({
              id: e.id,
              kind: e.kind,
              label: e.label.slice(0, 240),
              node_type: e.node_type ?? null,
              status: null,
              project_id: project.id,
              project_name: project.name,
              workflow_id: wf.id,
              workflow_name: wf.name,
            });
        }
      }
    return {
      nodes: matches.slice(offset, offset + limit),
      total: matches.length,
      next_offset: offset + limit < matches.length ? offset + limit : null,
    };
  },
  {query: ['q', 'offset', 'limit']}
);

// ----- library: Custom Nodes -----
route(
  'GET POST',
  'resources',
  'List or create Library nodes',
  async c => {
    const items = await c.ctx.get('resources', []);
    if (c.method === 'GET') return items;
    return saveResource(c, items, null, c.body.name, c.body.payload);
  },
  {body: {name: 'My node', payload: {bundle: {}}}}
);

function saveResource(c, items, id, name, payload, newId = null) {
  if (typeof name !== 'string' || !name.trim()) throw bad('A node name is required.');
  name = name.trim();
  validateResource(payload);
  if (items.some(r => r.name === name && r.id !== id)) throw bad('A node with that name already exists.');
  c.libraryTouched = true; // the Library's types follow its nodes
  const now = Date.now() / 1000;
  let item = items.find(r => r.id === id);
  if (item) Object.assign(item, {name, payload, updated: now});
  else {
    item = {id: newId || uid(), name, payload, created: now, updated: now};
    items.push(item);
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
  c.ctx.set('resources', items);
  return item;
}
route(
  'GET PUT DELETE',
  'resources/{resource_id}',
  'Read, change or delete a Library node',
  async (c, {resource_id}) => {
    const items = await c.ctx.get('resources', []),
      item = items.find(r => r.id === resource_id);
    if (!item) throw missing('Record not found');
    if (c.method === 'GET') return item;
    if (c.method === 'DELETE') {
      c.ctx.set(
        'resources',
        items.filter(r => r !== item)
      );
      await c.ctx.remove('wf:lib-' + item.id);
      c.libraryTouched = true;
      return {deleted: true};
    }
    let payload = c.body.payload;
    if (isObject(payload) && c.body.replace === true) {
      // Overwriting the node as a whole: the saved graph is replaced, and the editor's copy of the old one is dropped.
      await c.ctx.remove('wf:lib-' + item.id);
    } else if (isObject(payload)) {
      // The graph belongs to the editor; this form only changes the name, description, icon and group.
      const bundle = clone(item.payload.bundle),
        name = String(c.body.name ?? '')
          .trim()
          .slice(0, 100),
        top = bundle?.groups?.find(g => !g.parent);
      if (top && name) top.name = name;
      payload = {...payload, bundle};
      const doc = await c.ctx.get('wf:lib-' + item.id, null);
      const root = doc?.groups?.find(g => g.id === doc.root);
      if (root && name) root.name = name;
      if (doc) c.ctx.set('wf:lib-' + item.id, doc);
    }
    return saveResource(c, items, resource_id, c.body.name, payload);
  },
  {body: {name: 'My node', payload: {}}}
);
