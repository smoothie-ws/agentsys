// The Add node menu and the selection (context) menu.
'use strict';

function spawnPoint() {
  const rect = W.canvas.getBoundingClientRect();
  const pointer = W.pointer || {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  return toWorld(pointer.x, pointer.y);
}

/** Everything that can be added to the canvas, as popup items. */
function addItems({all = false} = {}) {
  const at = spawnPoint();
  const available = new Set(W.snapshot?.library_nodes ?? []);
  const customNodes = (app.resources || []).filter(r => r.id !== W.library && (all || available.has(r.id)));
  const place = item => async () => {
    const result = await api(`projects/${W.project}/custom-nodes/${item.id}`, {
      method: 'POST',
      body: wf({point: at}),
      edit: editToken(),
    });
    await reload();
    select(pastedSelection(result));
  };
  // Library groups ("Logic/Sub") become nested submenus; nodes without a group sit directly in the menu.
  const tree = {nodes: [], groups: new Map()};
  for (const item of customNodes) {
    let level = tree,
      path = '';
    for (const part of String(item.payload.folder || '')
      .split('/')
      .filter(Boolean)) {
      path = path ? path + '/' + part : part;
      if (!level.groups.has(part)) level.groups.set(part, {nodes: [], groups: new Map(), path});
      level = level.groups.get(part);
    }
    level.nodes.push(item);
  }
  // The nodes of a level first, then its groups.
  const menuOf = level => [
    ...level.nodes.map(item => [item.name, place(item), {icon: item.payload.icon || 'complex', hint: ''}]),
    ...[...level.groups].map(([name, sub]) => [
      name,
      null,
      {icon: (app.nodeFolderIcons || {})[sub.path] || 'package', children: menuOf(sub)},
    ]),
  ];
  // The two nodes the engine is made of come first; everything else is built from them (and comes from the Library).
  const primitive = (name, kind, glyph) => [
    name,
    async () => {
      const result = await api(`projects/${W.project}/primitives`, {
        method: 'POST',
        body: wf({primitive: kind, point: at}),
        edit: editToken(),
      });
      await reload();
      select([result.id]);
    },
    {icon: glyph, hint: ''},
  ];
  const library = menuOf(tree);
  const pluginItems =
    typeof Extensions === 'undefined'
      ? []
      : Extensions.menuItems('canvas:add', [{project: W.project, workflow: W.workflow, point: at}]);
  return [
    primitive('Script', 'script', 'code'),
    primitive('Event', 'event', 'bolt'),
    ...(library.length ? [null, ...library] : []),
    ...(pluginItems.length ? [null, ...pluginItems] : []),
  ];
}
function addMenu(x, y) {
  popup(x, y, addItems(), {search: true, searchItems: addItems({all: true})});
}

/** What to select after pasting: the new top-level groups, plus any pasted nodes that are not inside one. */
function pastedSelection(result) {
  const ids = new Set(result.ids || []),
    roots = result.roots || [];
  const inside = new Set(roots.flatMap(gid => W.groups.get(gid)?.all_members || []));
  return [...roots.map(selectionIdOf), ...[...ids].filter(id => !inside.has(id) && W.nodes.has(id))];
}

function selectionMenu() {
  const plain = plainNodes(),
    groupIds = selectedGroupIds(),
    any = plain.length + groupIds.length > 0,
    shortcut = shortcutText;
  const single = groupIds.length === 1 && W.selected.size === 1 ? W.groups.get(groupIds[0]) : null,
    cx = single ? W.complex.get(single.id) : null;
  const rootOnly = W.selected.size === 1 && isRoot(selectedFrames()[0]?.id);
  const pinned = selectionItems().some(n => n.pinned),
    switchable = switchableItems(),
    off = switchable.length > 0 && switchable.every(n => n.disabled),
    foldable = foldableItems(),
    folded = foldable.length > 0 && foldable.every(n => n.folded);
  const pluginItems =
    typeof Extensions === 'undefined'
      ? []
      : Extensions.menuItems('canvas:selection', [
          {
            project: W.project,
            workflow: W.workflow,
            selected: [
              ...plainNodes().map(n => n.id),
              ...groupIds.map(id => 'complex:' + id),
            ],
          },
        ]);
  return [
    ['Copy', () => copySelection(), {icon: 'copy', hint: shortcut('copy'), disabled: !any}],
    ['Cut', () => copySelection(true), {icon: 'cut', hint: shortcut('cut'), disabled: !any}],
    ['Paste', () => paste(), {icon: 'paste', hint: shortcut('paste'), disabled: !hasClipboard()}],
    null,
    ['Group', () => groupSelection(), {icon: 'group', hint: shortcut('group'), disabled: !any}],
    [
      'Ungroup',
      () => ungroupSelection(),
      {
        icon: 'ungroup',
        hint: shortcut('ungroup'),
        disabled: !groupIds.length || groupIds.some(id => W.complex.get(id)?.locked),
      },
    ],
    ...(W.selected.size === 1 && (single || selectedNodes()[0]?.kind === 'function')
      ? [['Rename', () => renameSelection(), {icon: 'pencil', hint: shortcut('renameGroup')}]]
      : []),
    ...(single && cx?.locked && cx.source && developerMode()
      ? [['Edit graph', () => editInLibrary(cx.source.resource_id), {icon: 'pencil'}]]
      : []),
    ...(rootOnly
      ? [['Rename', () => renameGroup(selectedFrames()[0].id), {icon: 'pencil', hint: shortcut('renameGroup')}]]
      : []),
    [pinned ? 'Unpin' : 'Pin', () => setPinned(!pinned), {icon: pinned ? 'unpin' : 'pin', disabled: !any}],
    [
      off ? 'Enable' : 'Disable',
      () => toggleDisabled()?.catch(fail),
      {icon: 'power', hint: shortcut('disable'), disabled: !switchable.length},
    ],
    [
      folded ? 'Expand' : 'Collapse',
      () => setFolded(foldable, !folded).catch(fail),
      {icon: folded ? 'expand' : 'collapse', hint: shortcut('fold'), disabled: !foldable.length},
    ],
    null,
    ['Dissolve', () => deleteSelection(true), {icon: 'merge', hint: shortcut('dissolve'), disabled: !plain.length}],
    ['Delete', () => deleteSelection(), {icon: 'trash', danger: true, hint: shortcut('delete'), disabled: !any}],
    ...(pluginItems.length ? [null, ...pluginItems] : []),
  ];
}
