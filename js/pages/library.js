// The Library page: Custom Nodes and the groups they are kept in, as cards. A node opens as a graph in its own editor.
'use strict';

/** Opens the graph editor for a Custom Node: an existing one, or a new one when no id is given. */
async function openNodeEditor(resourceId = null, folder = '', replace = false) {
  const origin = app.route;
  const opened = await api('library/node-editor', {method: 'POST', body: {resource_id: resourceId, folder}});
  if (app.route !== origin) return;
  await go(`/p/${opened.project_id}/w/${opened.workflow_id}`, replace);
}

// ----- the actions behind every "⋯", "+" and drag: on rows of the second panel and on cards alike -----
const refreshLibrary = async () => {
  if (!(await leaveView())) return;
  await loadLibrary();
  await render();
};
const newNode = (folder = '') => openNodeEditor(null, folder).catch(fail);
const folderCall = body => api('library/node-folders', {method: 'POST', body});
const moveNode = (id, folder) =>
  api(`library/custom-nodes/${id}/move`, {method: 'POST', body: {folder}}).then(refreshLibrary).catch(fail);
function askGroupName(title, label, value, save) {
  dialog(
    title,
    field('Name', `<input name="name" required maxlength="100" autofocus value="${esc(value)}">`),
    form => save(form.name.value.trim()),
    label
  );
  $('#modal input[name=name]').select();
}
const newGroup = parent =>
  askGroupName('New group', 'Create', '', name =>
    folderCall({action: 'create', path: parent, name}).then(refreshLibrary)
  );

/** Menus of the groups one can move a Custom Node to, nested like the groups. */
function moveMenu(parent, item) {
  return app.nodeFolders
    .filter(f => parentPath(f) === parent)
    .map(f => {
      const here = [baseName(f), () => moveNode(item.id, f), {icon: 'folder', disabled: item.payload.folder === f}],
        inner = moveMenu(f, item);
      return inner.length
        ? [here[0], here[1], {...here[2], children: [[`${baseName(f)} (here)`, ...here.slice(1)], null, ...inner]}]
        : here;
    });
}
/** Whether the open page is (or is inside) what is about to go: it must leave first. */
const showsAny = (items, path) =>
  (path !== undefined && app.route.folder !== undefined && underPath(app.route.folder, path)) ||
  items.some(r => r.id === app.route.id || app.route.project === 'lib-' + r.id);

async function duplicateResource(item) {
  const copy = await api(`library/custom-nodes/${item.id}/duplicate`, {method: 'POST', body: {}});
  await loadLibrary();
  await go(resourceHref(copy));
}
const deleteResource = item =>
  confirmDialog(
    'Delete from library?',
    `“${item.name}” will be removed. Copies already placed on canvases keep working.`,
    async () => {
      await api(`resources/${item.id}`, {method: 'DELETE'});
      Tabs.dropProject('lib-' + item.id);
      if (showsAny([item])) await go(NODES_PATH, true);
      else await refreshLibrary();
    },
    'Delete'
  );

/** The icon of a Custom Node (the same choice as in the Properties of its main group). */
const changeNodeIcon = item =>
  dialog(
    'Node icon',
    field('Icon', iconGrid(item.payload.icon, 'complex')),
    async form => {
      const icon = form.icon.value;
      await api(`resources/${item.id}`, {method: 'PUT', body: {name: item.name, payload: {...item.payload, icon}}});
      Tabs.setIcon('lib-' + item.id, icon);
      await refreshLibrary();
    },
    'Save'
  );

/** Menu of a Custom Node. */
function resourceActions(item, title = () => menuTitle('resource:' + item?.id)) {
  if (!item) return;
  return [
    ...(developerMode()
      ? [
          ['Edit graph', () => openNodeEditor(item.id).catch(fail), {icon: 'pencil'}],
          [
            'Rename',
            () =>
              inlineRename(title, item.name, async name => {
                await api(`resources/${item.id}`, {method: 'PUT', body: {name, payload: item.payload}});
                Tabs.rename('lib-' + item.id, name);
                await refreshLibrary();
              }),
            {icon: 'pencil'},
          ],
          ['Change icon', () => changeNodeIcon(item), {icon: 'star'}],
          ['Duplicate', () => duplicateResource(item).catch(fail), {icon: 'copy'}],
          [
            'Move to',
            null,
            {
              icon: 'folder',
              children: [
                ['No group', () => moveNode(item.id, ''), {icon: 'package', disabled: !item.payload.folder}],
                ...(moveMenu('', item).length ? [null, ...moveMenu('', item)] : []),
              ],
            },
          ],
        ]
      : []),
    ['Export', () => exportResources([item], item.name), {icon: 'upload'}],
    ...(developerMode() ? [null, ['Delete', () => deleteResource(item), {icon: 'trash', danger: true}]] : []),
  ];
}
const nodesIn = path => app.resources.filter(r => underPath(r.payload.folder || '', path));
/** Menu of a group of Custom Nodes. */
function folderActions(path, title = () => menuTitle('folder:' + path)) {
  const name = baseName(path),
    exportGroup = ['Export group', () => exportResources(nodesIn(path), name), {icon: 'upload'}];
  if (!developerMode()) return [exportGroup];
  return [
    ...creationActions(path),
    [
      'Rename',
      () =>
        inlineRename(title, name, async next => {
          await folderCall({action: 'rename', path, name: next});
          const moved = (parentPath(path) ? parentPath(path) + '/' : '') + next,
            open = app.route.folder;
          if (open !== undefined && underPath(open, path)) await go(folderHref(moved + open.slice(path.length)), true);
          else await refreshLibrary();
        }),
      {icon: 'pencil'},
    ],
    exportGroup,
    [
      'Change icon',
      () =>
        dialog(
          'Group icon',
          field('Icon', iconGrid((app.nodeFolderIcons || {})[path], 'folder')),
          form => folderCall({action: 'icon', path, icon: form.icon.value}).then(refreshLibrary),
          'Save'
        ),
      {icon: 'star'},
    ],
    null,
    [
      'Delete group',
      () => {
        const inside = nodesIn(path),
          groups = app.nodeFolders.filter(f => f !== path && underPath(f, path)).length;
        confirmDialog(
          'Delete group and contents?',
          `“${name}” is removed with everything in it: ${plural(groups, 'group')} and ${plural(inside.length, 'Custom Node')}. This cannot be undone.`,
          async () => {
            const leave = showsAny(inside, path);
            await folderCall({action: 'delete', path});
            for (const r of inside) Tabs.dropProject('lib-' + r.id);
            if (leave) await go(parentPath(path) ? folderHref(parentPath(path)) : NODES_PATH, true);
            else await refreshLibrary();
          },
          'Delete'
        );
      },
      {icon: 'trash', danger: true},
    ],
  ];
}
/** New node and New group, first in the menu of the Library and of a group. */
const creationActions = folder =>
  developerMode()
    ? [
        ['New node', () => newNode(folder), {icon: 'plus'}],
        ['New group', () => newGroup(folder), {icon: 'folder'}],
        null,
      ]
    : [];
/** Menu of the Library itself, and the "+" of its second panel. */
const nodesActions = () => [
  ...creationActions(''),
  ['Import…', () => importFiles(), {icon: 'download'}],
  ['Export all', () => exportResources(app.resources, 'Library'), {icon: 'upload', disabled: !app.resources.length}],
  null,
  ['Restore built-in nodes', () => restoreBuiltin().catch(fail), {icon: 'package'}],
];
async function restoreBuiltin() {
  const result = await api('library/builtin', {method: 'POST', body: {restore: true}});
  await refreshLibrary();
  toast(
    result.added.length
      ? `${plural(result.added.length, 'built-in node')} restored.`
      : 'All built-in nodes are in the Library.'
  );
}
async function importFiles() {
  const files = await pickFiles({accept: '.json,application/json'});
  if (!files.length) return;
  try {
    const made = await importResources(files);
    toast(`${plural(made.length, 'node')} imported.`);
    await loadLibrary();
    await go(made.length === 1 && developerMode() ? resourceHref(made[0]) : NODES_PATH, true);
  } catch (error) {
    fail(error);
  }
}

// Drag a Custom Node (a row of the second panel or a card) onto a group, or onto "Library" itself, to move it there.
const clearDrop = () => $$('.drop-over').forEach(e => e.classList.remove('drop-over'));
document.addEventListener('dragstart', event => {
  const node = event.target.closest?.('[data-drag]');
  if (!node) return;
  event.dataTransfer.setData('text/plain', node.dataset.drag);
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', event => {
  const spot = event.target.closest?.('[data-drop-folder]');
  if (!spot || !developerMode()) return;
  event.preventDefault();
  clearDrop();
  spot.classList.add('drop-over');
});
document.addEventListener('dragleave', event => event.relatedTarget || clearDrop());
document.addEventListener('dragend', clearDrop);
document.addEventListener('drop', event => {
  const spot = event.target.closest?.('[data-drop-folder]'),
    id = event.dataTransfer.getData('text/plain');
  clearDrop();
  if (!spot || !developerMode() || !app.resources.some(r => r.id === id)) return;
  event.preventDefault();
  moveNode(id, spot.dataset.dropFolder);
});

// ----- import / export -----
/** Saves Custom Nodes as one JSON file (a single node is saved as an object, several as a list). */
function exportResources(items, name) {
  const entries = items.map(r => ({
    name: r.name,
    payload: r.payload,
  }));
  const text = JSON.stringify(TextGraph.encode(entries.length === 1 ? entries[0] : entries), null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  link.download = `${name.replace(/[^\w\-. ]+/g, '_').trim() || 'library'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Adds exported nodes. A name already taken gets a number. Returns the nodes made. */
async function addEntries(entries, source) {
  const made = [],
    taken = new Set((await api('resources')).map(r => r.name)); // kept in step as nodes are added
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.payload || typeof entry.payload !== 'object')
      throw new Error(`${source} is not an exported Custom Node.`);
    const base = entry.name.trim().slice(0, 100) || 'Imported';
    let name = base,
      n = 1;
    while (taken.has(name)) name = `${base} ${++n}`;
    taken.add(name);
    // A node keeps its group, so the tree comes back as it was exported.
    const payload = entry.payload;
    const saved = await api('resources', {method: 'POST', body: {name, payload}});
    // The main group of a node carries its name; PUT keeps that in step.
    await api(`resources/${saved.id}`, {method: 'PUT', body: {name, payload: saved.payload}});
    made.push(saved);
  }
  return made;
}

/** Reads JSON files and adds their nodes to the Library. */
async function importResources(files) {
  const made = [];
  for (const file of files) {
    let data;
    try {
      data = TextGraph.decode(JSON.parse(await file.text()));
    } catch (error) {
      throw new Error(`${file.name}: ${error.message || 'invalid Library file'}`);
    }
    made.push(...(await addEntries(Array.isArray(data) ? data : [data], file.name)));
  }
  return made;
}

// ----- pages -----
/** A well listing what is inside (first rows, then a count of the rest). */
const cardList = rows =>
  rows.length
    ? `<ul>${rows
        .slice(0, 4)
        .map(([glyph, name]) => `<li>${icon(glyph)}<span>${esc(name)}</span></li>`)
        .join('')}${rows.length > 4 ? `<li class="more">+${rows.length - 4} more</li>` : ''}</ul>`
    : '<span class="preview-empty">Nothing here yet</span>';
const itemCard = r =>
  card({
    href: developerMode() ? resourceHref(r) : null,
    glyph: resourceIcon(r),
    title: r.name,
    preview: `<div class="preview-layer">${previewSVG(graphFromBundle(r.payload.bundle))}</div>`,
    facts: r.payload.description ? esc(r.payload.description) : '',
    menu: 'resource:' + r.id,
    tint: 'k-complex',
    extra: developerMode() ? `draggable="true" data-drag="${esc(r.id)}"` : '',
  });
const folderCard = (path, rows) => {
  const groups = app.nodeFolders.filter(f => f !== path && underPath(f, path)).length;
  return card({
    href: folderHref(path),
    glyph: (app.nodeFolderIcons || {})[path] || 'folder',
    title: baseName(path),
    preview: cardList(rows),
    previewClass: 'card-note',
    facts: groups ? plural(groups, 'group') : '',
    menu: 'folder:' + path,
    extra: developerMode() ? `data-drop-folder="${esc(path)}"` : '',
  });
};
const notFound = (what, href, back) =>
  `<div class="empty"><h2>${what} not found</h2><p><a href="${esc(href)}" data-link>${esc(back)}</a></p></div>`;

/** The Library: its sections as cards (one: Nodes). */
function libraryOverview(view) {
  const rows = [
    ...app.nodeFolders.filter(f => !parentPath(f)).map(f => [(app.nodeFolderIcons || {})[f] || 'folder', baseName(f)]),
    ...app.resources.filter(r => !r.payload.folder).map(r => [resourceIcon(r), r.name]),
  ];
  view.innerHTML = `<div class="page">${pageHead({title: 'Library', sub: 'Reusable resources.'})}<div class="cards">${card(
    {
      href: NODES_PATH,
      glyph: 'complex',
      title: 'Nodes',
      preview: cardList(rows),
      previewClass: 'card-note',
      facts: 'Reusable Custom Nodes',
      menu: 'nodes:',
    }
  )}</div></div>`;
}

/** The Nodes section, or one group of it: its groups and nodes as cards. */
function libraryList(view, route) {
  const folder = route.folder || '',
    folders = app.nodeFolders.filter(f => parentPath(f) === folder),
    items = app.resources.filter(r => (r.payload.folder || '') === folder);
  if (folder && !app.nodeFolders.includes(folder))
    return void (view.innerHTML = `<div class="page">${notFound('Group', NODES_PATH, 'Back to Nodes')}</div>`);
  const chain = folder.split('/').map((name, i, parts) => [name, folderHref(parts.slice(0, i + 1).join('/'))]);
  const content = path =>
    app.resources.filter(r => (r.payload.folder || '') === path).map(r => [resourceIcon(r), r.name]);
  const spec = folder ? 'folder:' + folder : 'nodes:';
  view.innerHTML = `<div class="page">${pageHead({
    crumbs: [['Library', '/library'], ...(folder ? [['Nodes', NODES_PATH], ...chain.slice(0, -1)] : [])],
    title: esc(folder ? baseName(folder) : 'Nodes'),
    sub: folder ? '' : 'Reusable Custom Nodes.',
    menu: spec,
  })}
    <div class="cards">${folders
      .map(f =>
        folderCard(f, [
          ...app.nodeFolders
            .filter(g => parentPath(g) === f)
            .map(g => [(app.nodeFolderIcons || {})[g] || 'folder', baseName(g)]),
          ...content(f),
        ])
      )
      .join('')}${items.map(itemCard).join('')}</div>
    ${folders.length || items.length ? '' : '<div class="empty small"><h2>No nodes here yet</h2></div>'}</div>`;
}

PAGES.resources = async (view, route) => {
  await loadLibrary();
  if (app.route !== route) return;
  if (!route.section) return libraryOverview(view);
  if (!route.id) return libraryList(view, route);
  if (!developerMode() || !app.resources.some(r => r.id === route.id)) return go('/library', true);
  await openNodeEditor(route.id, '', true).catch(fail); // a node opens as a graph
};
