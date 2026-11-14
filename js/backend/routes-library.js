// Routes of the Custom Node Library: the tree of groups, and the graph editor that edits one Custom Node
// (a private workflow whose id is "lib-<resource id>").
'use strict';

// Library sections used to be registered by server plugins. A server has none now; a client plugin can add a
// section in its own interface. The endpoint stays so older clients do not break.
route('GET', 'library/sections', 'List server-registered Library sections (none by design)', async () => []);

// ----- Library groups for Custom Nodes: a tree of named groups, stored apart from the nodes -----
// parentPath and underPath are shared with the client (shared/core.js).
/** Stored groups plus every level of the group path of each item (imported items name a group that may not exist yet). */
async function nodeFolders(c) {
  const all = new Set(await c.ctx.get('node_folders', []));
  for (const r of await c.ctx.get('resources', [])) {
    const parts = String(r.payload.folder || '')
      .split('/')
      .filter(Boolean);
    parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join('/')));
  }
  return [...all].sort((a, z) => a.localeCompare(z, undefined, {sensitivity: 'base'}));
}
route(
  'GET POST',
  'library/node-folders',
  'List, create, rename or delete Library groups',
  async c => {
    const folders = await nodeFolders(c);
    if (c.method === 'GET') return folders;
    const {action} = c.body,
      path = String(c.body.path ?? ''),
      name = String(c.body.name ?? '').trim();
    let items = await c.ctx.get('resources', []);
    const validName = () => {
      if (!name || name.length > 100 || name.includes('/'))
        throw bad('A group name has 1 to 100 characters and no “/”.');
    };
    let next = folders;
    const icons = await c.ctx.get('node_folder_icons', {});
    if (action === 'icon') {
      if (!folders.includes(path)) throw bad('Group not found');
      const icon = String(c.body.icon ?? '');
      validateIcon(icon);
      if (icon) icons[path] = icon;
      else delete icons[path];
    } else if (action === 'create') {
      validName();
      if (path && !folders.includes(path)) throw bad('Group not found');
      const made = path ? path + '/' + name : name;
      if (folders.includes(made)) throw bad('A group with this name already exists here.');
      next = [...folders, made];
    } else if (action === 'rename') {
      validName();
      if (!folders.includes(path)) throw bad('Group not found');
      const target = parentPath(path) ? parentPath(path) + '/' + name : name;
      if (target !== path && folders.includes(target)) throw bad('A group with this name already exists here.');
      const move = p => (underPath(p, path) ? target + p.slice(path.length) : p);
      next = folders.map(move);
      for (const k of Object.keys(icons))
        if (underPath(k, path) && move(k) !== k) {
          icons[move(k)] = icons[k];
          delete icons[k];
        }
      for (const r of items) r.payload.folder = move(String(r.payload.folder || ''));
    } else if (action === 'delete') {
      if (!folders.includes(path)) throw bad('Group not found');
      // The group goes with everything in it: its groups, and the Custom Nodes (with their graphs).
      next = folders.filter(p => !underPath(p, path));
      for (const k of Object.keys(icons)) if (underPath(k, path)) delete icons[k];
      const doomed = items.filter(r => underPath(String(r.payload.folder || ''), path));
      if (doomed.length) c.libraryTouched = true;
      for (const r of doomed) {
        await removeWorkflow(c, 'lib-' + r.id);
        await c.ctx.remove('policy:lib-' + r.id);
      }
      items = items.filter(r => !doomed.includes(r));
    } else throw bad('Unknown action');
    c.ctx.set('node_folders', next);
    c.ctx.set('node_folder_icons', icons);
    c.ctx.set('resources', items);
    return nodeFolders(c);
  },
  {
    body: {action: 'create', path: '', name: 'Logic'},
    note: 'action: create | rename | delete | icon',
  }
);

route(
  'POST',
  'library/custom-nodes/{resource_id}/move',
  'Move a Custom Node into a group',
  async (c, {resource_id}) => {
    const items = await c.ctx.get('resources', []),
      item = items.find(r => r.id === resource_id);
    if (!item) throw missing('Record not found');
    const folder = String(c.body.folder ?? '');
    if (folder && !(await nodeFolders(c)).includes(folder)) throw bad('Group not found');
    item.payload.folder = folder;
    c.ctx.set('resources', items);
    return {id: item.id, folder};
  },
  {body: {folder: 'Logic'}}
);

// A client plugin uses this to turn a small form into an ordinary Library node. The node is saved by the server
// and has no dependency on the plugin after this call: it is a normal graph with a Script.
route(
  'POST',
  'library/script-nodes',
  'Create a Script-backed Library node',
  async c => {
    const name = String(c.body.name || '').trim();
    if (!name || name.length > 100) throw bad('A node name has 1 to 100 characters');
    const code = String(c.body.code ?? '');
    if (!code.trim() || code.length > 200000) throw bad('The Script code has 1 to 200000 characters');
    const inputs = c.body.inputs === undefined ? [] : c.body.inputs,
      outputs = c.body.outputs === undefined ? [] : c.body.outputs,
      grants = c.body.grants === undefined ? ['graph.read'] : c.body.grants;
    if (!Array.isArray(inputs) || inputs.length > 64 || !Array.isArray(outputs) || outputs.length > 64)
      throw bad('inputs and outputs are lists of at most 64 ports');
    checkManifest({grants});
    const items = await c.ctx.get('resources', []);
    const resourceId = c.body.resource_id === undefined || c.body.resource_id === null ? null : String(c.body.resource_id);
    let existing = null;
    if (resourceId) {
      existing = items.find(item => item.id === resourceId);
      if (!existing) throw missing('Record not found');
      // A deployed plugin may replace only a node it owns. Without the owner tag this is a person's node, and a
      // package update must never rewrite it.
      const owner = existing.payload?.plugin?.id;
      const claimed = c.body.plugin && isObject(c.body.plugin) ? String(c.body.plugin.id ?? '') : '';
      if (!owner || owner !== claimed)
        throw new ApiError('permission_denied', 'This Library node is not owned by that plugin; it was not changed.', 403);
    }
    if (items.some(item => item.name === name && item.id !== resourceId)) throw bad('A node with that name already exists.');
    const payload = scriptNodePayload({
      name,
      inputs,
      outputs,
      grants,
      code,
      description: String(c.body.description ?? '').slice(0, 2000),
      folder: String(c.body.folder ?? '').slice(0, 200),
      icon: c.body.icon,
    });
    if (c.body.plugin && isObject(c.body.plugin)) {
      const owner = String(c.body.plugin.id ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(owner)) throw bad('Invalid plugin owner id');
      payload.plugin = {
        id: owner,
        name: String(c.body.plugin.name ?? name).slice(0, 100),
        version: String(c.body.plugin.version ?? '').slice(0, 40),
        checksum: String(c.body.plugin.checksum ?? '').slice(0, 80),
      };
    }
    const saved = saveResource(c, items, resourceId, name, payload);
    if (resourceId) {
      // The editor's private copy of the old graph must not outlive the definition it was built from.
      await c.ctx.remove('wf:lib-' + resourceId);
      await c.ctx.remove('policy:lib-' + resourceId);
    }
    return saved;
  },
  {
    body: {
      name: 'HTTP Request',
      code: 'node.output.value = 1;',
      inputs: [],
      outputs: ['value'],
      resource_id: null,
      plugin: {id: 'my-plugin', name: 'HTTP Request', version: '1.0.0', checksum: 'fnv1a-…'},
    },
    note: 'resource_id replaces a Script-backed node that a plugin owns; a user node is never rewritten.',
  }
);

// ----- Library graph editor: a private workflow that holds the Custom Node being edited -----
route(
  'POST',
  'library/node-editor',
  'Open the graph editor for a new or existing Custom Node',
  async c => {
    await c.requireDeveloper('Editing a Custom Node');
    const items = await c.ctx.get('resources', []);
    const rid = c.body.resource_id || uid(),
      item = items.find(r => r.id === rid);
    if (c.body.resource_id && !item) throw missing('Record not found');
    const id = 'lib-' + rid,
      doc = emptyDoc();
    doc.folder = String(c.body.folder ?? '');
    if (!item) {
      // A new node starts with its main group, a Complex Node that everything else is built inside.
      const gid = uid();
      doc.groups.push({id: gid, name: 'Custom node', members: [], parent: null});
      doc.complex.push({
        id: gid,
        interface: {inputs: [], outputs: []},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
      });
      // The frame starts as small as it can be (the smallest size its resize allows); it grows around what is put inside.
      doc.layout['group:' + gid] = {x: 0, y: 0, width: 260, height: 140};
      doc.root = gid;
    } else {
      const project = await c.project(id),
        editor = new Editor(project, project.workflows[0], doc);
      editor.paste(clone(item.payload.bundle), {x: 0, y: 0}, {preserveIds: true});
      const top = doc.groups.find(g => !g.parent && doc.complex.some(x => x.id === g.id && !x.source));
      if (top) {
        doc.complex.find(cx => cx.id === top.id).collapsed = false;
        top.name = item.name;
        doc.root = top.id;
        // The saved bundle keeps only node positions; the workspace is the area they cover, with room to grow.
        const spots = doc.nodes.map(n => doc.layout[n.id]).filter(Boolean);
        const saved = item.payload.frame,
          x0 = spots.length ? Math.min(...spots.map(p => p.x)) : 0,
          y0 = spots.length ? Math.min(...spots.map(p => p.y)) : 0;
        // The frame comes back as it was left; without a saved one it covers the nodes with room to grow.
        if (saved)
          doc.layout['group:' + top.id] = {
            x: x0 + saved.dx,
            y: y0 + saved.dy,
            width: Math.max(300, saved.width),
            height: Math.max(200, saved.height),
          };
        // Without an explicit user-sized frame, let the canvas wrap the visible
        // composition rather than fitting every hidden descendant in the template.
      }
    }
    c.ctx.set('wf:' + id, doc);
    if (!item) {
      // The new node exists in the Library from the start and follows every change.
      let name = 'Custom node';
      for (let n = 2; items.some(r => r.name === name); n++) name = 'Custom node ' + n;
      doc.groups.find(g => g.id === doc.root).name = name;
      const project = await c.project(id),
        editor = new Editor(project, project.workflows[0], doc);
      const bundle = editor.copy([], [doc.root]);
      saveResource(c, items, null, name, {bundle, description: '', folder: doc.folder}, rid);
    }
    histories.delete(id);
    return {project_id: id, workflow_id: id, resource_id: rid};
  },
  {body: {resource_id: null, folder: ''}}
);

route(
  'POST',
  'library/custom-nodes/{resource_id}/duplicate',
  'Duplicate a Custom Node',
  async (c, {resource_id}) => {
    await c.requireDeveloper('Duplicating a Custom Node');
    const items = await c.ctx.get('resources', []),
      item = items.find(r => r.id === resource_id);
    if (!item) throw missing('Record not found');
    const name = freeName(new Set(items.map(r => r.name)), item.name.slice(0, 95) + ' copy');
    const payload = clone(item.payload),
      top = payload.bundle?.groups?.find(g => !g.parent);
    if (top) top.name = name;
    const copy = saveResource(c, items, null, name, payload);
    return {id: copy.id, name: copy.name};
  },
  {body: {}}
);
