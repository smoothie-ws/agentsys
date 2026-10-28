// Routes of the Custom Node Library: the tree of groups, and the graph editor that edits one Custom Node
// (a private workflow whose id is "lib-<resource id>").
'use strict';

// ----- Library groups for Custom Nodes: a tree of named groups, stored apart from the nodes -----
const parentPath = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const underPath = (path, root) => path === root || path.startsWith(root + '/');
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
      if (!name || name.length > 100 || name.includes('/')) throw bad('A group name has 1 to 100 characters and no “/”.');
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
        if (underPath(k, path)) {
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
      for (const r of doomed) await c.ctx.remove('wf:lib-' + r.id);
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
      editor.paste(clone(item.payload.bundle), {x: 0, y: 0});
      for (const cx of doc.complex) if (!cx.source) cx.collapsed = false;
      const top = doc.groups.find(g => !g.parent && doc.complex.some(x => x.id === g.id && !x.source));
      if (top) {
        top.name = item.name;
        doc.root = top.id;
        // The saved bundle keeps only node positions; the workspace is the area they cover, with room to grow.
        const spots = doc.nodes.map(n => doc.layout[n.id]).filter(Boolean),
          x = Math.min(0, ...spots.map(p => p.x)) - 80,
          y = Math.min(0, ...spots.map(p => p.y)) - 90;
        const saved = item.payload.frame,
          x0 = spots.length ? Math.min(...spots.map(p => p.x)) : 0,
          y0 = spots.length ? Math.min(...spots.map(p => p.y)) : 0;
        // The frame comes back as it was left; without a saved one it covers the nodes with room to grow.
        doc.layout['group:' + top.id] = saved
          ? {x: x0 + saved.dx, y: y0 + saved.dy, width: Math.max(300, saved.width), height: Math.max(200, saved.height)}
          : {
              x,
              y,
              width: Math.max(1400, Math.max(0, ...spots.map(p => p.x)) - x + 420),
              height: Math.max(900, Math.max(0, ...spots.map(p => p.y)) - y + 360),
            };
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
    let name = item.name + ' copy';
    for (let n = 2; items.some(r => r.name === name); n++) name = `${item.name} copy ${n}`;
    const payload = clone(item.payload),
      top = payload.bundle?.groups?.find(g => !g.parent);
    if (top) top.name = name.slice(0, 100);
    const copy = saveResource(c, items, null, name.slice(0, 100), payload);
    return {id: copy.id, name: copy.name};
  },
  {body: {}}
);
