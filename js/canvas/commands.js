// Commands that change the graph: inline edits, delete, copy/paste, group/ungroup, Library save, undo.
'use strict';

// ----- editing -----
/** The widgets of a Custom node (by node ID). */
const widgetsOf = id => W.snapshot.widgets?.[id] ?? [];

/** A multi-selection is one edit and one commit, rather than a round trip per selected item. */
async function applyCanvasEdits(operations, edit = editToken()) {
  for (let i = 0; i < operations.length; i += 200)
    await api(`projects/${W.project}/batch`, {
      method: 'POST', body: wf({operations: operations.slice(i, i + 200)}), edit,
    });
}

/** A person used a widget: the node it belongs to gets the value (and its on_widget runs). */
async function changeWidget(nodeId, widgetId, value) {
  await api(`projects/${W.project}/widget-values`, {
    method: 'PUT',
    body: wf({node_id: nodeId, values: {[widgetId]: value}}),
    edit: editToken(),
  });
  W.results.delete(nodeId);
  await reload();
}

/** A person typed into the control of a free input: the node keeps the value as the default of that input. */
async function changeInput(nodeId, portId, value) {
  await api(`projects/${W.project}/input-values`, {
    method: 'PUT',
    body: wf({node_id: nodeId, values: {[portId]: value}}),
    edit: editToken(),
  });
  W.results.delete(nodeId);
  await reload();
}

/** A person typed into the control of an output: the node keeps the value, and it is what the output holds until the code sets another. */
async function changeOutput(nodeId, portId, value) {
  await api(`projects/${W.project}/output-values`, {
    method: 'PUT',
    body: wf({node_id: nodeId, values: {[portId]: value}}),
    edit: editToken(),
  });
  W.results.delete(nodeId);
  await reload();
}

/** A field of a widget changed (data-literal is the widget's ID), or of the control of a free input or output (its ID is in:<port> or out:<port>). */
async function inlineChange(input, captured = input.type === 'checkbox' ? input.checked : input.value) {
  const slot = input.closest('.port'),
    holder = slot ? input.closest('.node') : input.closest('[data-widget-node]');
  if (!holder) return;
  const nodeId = slot ? holder.dataset.id : holder.dataset.widgetNode,
    widget = (slot ? slotWidgets(W.nodes.get(nodeId)) : widgetsOf(nodeId)).find(w => w.id === input.dataset.literal);
  if (!widget) return;
  let value = captured;
  if (widget.kind === 'number' || widget.kind === 'range') {
    // A number field reports "-" or "1e" as empty: that is a number being typed, so it waits for the rest.
    if (input.validity?.badInput) return;
    value = captured === '' ? null : Number(captured);
    if (value !== null && !Number.isFinite(value)) return;
  } else if (widget.kind === 'select') {
    const option = widget.options?.[Number(captured)];
    value = option !== null && typeof option === 'object' ? option.value : option;
  }
  if (widget.id.startsWith('out:')) await changeOutput(nodeId, widget.id.slice(4), value);
  else if (slot) await changeInput(nodeId, widget.id.slice(3), value);
  else await changeWidget(nodeId, widget.id, value);
}

async function setSelectionStyle(style) {
  const edit = editToken(), operations = [];
  for (const node of selectionItems()) {
    const grouped = node.kind === 'group' || node.kind === 'complex';
    if (style.pinned && grouped) {
      const ids = (W.groups.get(node.group_id)?.all_members || []).filter(id => !W.nodes.get(id)?.position);
      if (ids.length) await savePositions(ids);
    }
    const p = W.pos.get(node.id);
    const target = grouped ? {group_id: node.group_id} : {node_id: node.id, ...(p ? {position: {x: p.x, y: p.y}} : {})};
    operations.push({path: 'node-style', body: {...target, ...style}});
  }
  await applyCanvasEdits(operations, edit);
  await reload();
}
const setPinned = pinned => setSelectionStyle({pinned});

/** The style target of a node, a Complex Node or a group frame. */
const styleTarget = node => (node.kind === 'complex' || node.kind === 'group' ? {group_id: node.group_id} : {node_id: node.id});
/** What can be disabled: every selected node, Complex Node and group. */
const switchableItems = () => selectionItems();
/** Disables nodes and groups (a run skips them and everything inside, and what they feed gets nothing from them) or enables them again. */
async function setDisabled(items, disabled) {
  await applyCanvasEdits(items.map(node => ({path: 'node-style', body: {...styleTarget(node), disabled}})));
  await reload();
}
const toggleDisabled = () => {
  const items = switchableItems();
  return items.length ? setDisabled(items, !items.every(n => n.disabled)) : undefined;
};

/** What can be collapsed: nodes, Complex Nodes and groups (a Complex Node that is open as a frame in the Library editor is not). */
const foldableItems = () => selectionItems().filter(n => n.kind !== 'group' || !W.complex.has(n.group_id));
/** Collapses nodes (only the header and the slots stay) and groups (only the header stays, the members are hidden), or opens them again. */
async function setFolded(items, folded) {
  await applyCanvasEdits(items.map(node => ({path: 'node-style', body: {...styleTarget(node), folded}})));
  for (const node of items) {
    // What a collapsed group hides cannot stay selected.
    if (node.kind === 'group' && folded) {
      const gone = new Set([...(W.groups.get(node.group_id)?.all_members || [])]);
      select([...W.selected].filter(id => !gone.has(id)));
    }
  }
  await reload();
}
const toggleFolded = () => {
  const items = foldableItems();
  return items.length ? setFolded(items, !items.every(n => n.folded)) : undefined;
};

/** Editing the next graph discards old results after execution has finished. */
function discardStaleRun() {
  const signature = JSON.stringify([
    W.snapshot.nodes.map(n => [n.id, n.config, n.inputs]),
    W.snapshot.edges,
    W.snapshot.complex.map(c => [c.id, c.interface]),
  ]);
  if (signature === W.previewSignature) return;
  W.previewSignature = signature;
  if (!W.running) {
    W.runStatus.clear();
    W.results.clear();
  }
}

async function deleteSelection(dissolve = false) {
  await flushNodeEdits();
  const nodes = plainNodes(),
    groupIds = selectedGroupIds();
  if (!nodes.length && !groupIds.length) return;
  const edit = editToken(),
    gone = [], operations = [];
  // Outer groups first: deleting one takes the groups inside it with it, so those need no call of their own.
  for (const gid of [...groupIds].sort((a, b) => W.groups.get(a).depth - W.groups.get(b).depth)) {
    if (gone.some(outer => isUnder(W.groups.get(gid), outer))) continue;
    operations.push({path: 'groups/' + gid, method: 'DELETE'});
    gone.push(gid);
  }
  const grouped = new Set(gone.flatMap(id => W.groups.get(id).all_members));
  const live = nodes.map(n => n.id).filter(id => !grouped.has(id));
  if (live.length)
    operations.push({path: 'delete-nodes', method: 'POST', body: {node_ids: live, dissolve}});
  await applyCanvasEdits(operations, edit);
  W.selected.clear();
  await reload();
  Inspector.show();
}

async function copySelection(cut = false) {
  await flushNodeEdits();
  const nodes = plainNodes(),
    groupIds = selectedGroupIds();
  if (!nodes.length && !groupIds.length) return;
  const bundle = await api(`projects/${W.project}/copy`, {
    method: 'POST',
    body: wf({node_ids: nodes.map(n => n.id), group_ids: groupIds}),
  });
  try {
    localStorage.setItem('agentsys-clipboard', JSON.stringify(bundle));
  } catch {
    throw new Error('The browser blocked storage for the clipboard.');
  }
  const count = bundle.records.length;
  toast(cut ? 'Cut.' : `Copied ${plural(count || bundle.groups.length, count ? 'node' : 'group')}.`);
  if (cut) await deleteSelection();
}

async function paste() {
  const bundle = store.get('agentsys-clipboard');
  if (!bundle) return toast('The clipboard is empty. Copy nodes first.');
  const result = await api(`projects/${W.project}/paste`, {
    method: 'POST',
    body: wf({clipboard: bundle, point: spawnPoint()}),
    edit: editToken(),
  });
  await reload();
  select(pastedSelection(result));
}

/** Saves the whole group list. A group with nothing inside keeps a position; one that lost everything is dropped. */
async function saveGroups(groups, edit = editToken()) {
  const alive = new Set(groups.map(g => g.id));
  const parentOf = g => (g.parent && alive.has(g.parent) ? g.parent : null);
  const keep = groups.filter(g => g.members.length || groups.some(o => parentOf(o) === g.id) || g.position);
  const kept = new Set(keep.map(g => g.id));
  await api(`projects/${W.project}/groups`, {
    method: 'PUT',
    body: wf({
      groups: keep.map(g => ({
        id: g.id,
        name: g.name,
        members: g.members,
        parent: g.parent && kept.has(g.parent) ? g.parent : null,
        ...(g.members.length || keep.some(o => o.parent === g.id) ? {} : {position: g.position}),
      })),
    }),
    edit,
  });
}

/** Groups the selected nodes and groups into a new group; the new group sits where the selection sat. */
async function groupSelection() {
  const ids = plainNodes().map(n => n.id),
    childIds = selectedGroupIds();
  if (!ids.length && !childIds.length) return toast('Select nodes to group.');
  const parents = new Set([
    ...ids.map(id => groupChain(id)[0]?.id ?? null),
    ...childIds.map(id => W.groups.get(id).parent ?? null),
  ]);
  const parent = parents.size === 1 ? [...parents][0] : null;
  const id = uuid();
  const groups = W.snapshot.groups.map(g => ({
    id: g.id,
    name: g.name,
    position: g.position,
    members: g.members.filter(m => !ids.includes(m)),
    parent: childIds.includes(g.id) ? id : g.parent,
  }));
  await saveGroups([...groups, {id, name: 'Group', members: ids, parent}]);
  await reload();
  select(['frame:' + id]);
  renameGroup();
}

/** Removes the selected groups but keeps what was inside them (a Complex Node's wires move to the ports it was bound to). */
async function ungroupSelection() {
  const gone = new Set(selectedGroupIds());
  if (!gone.size) return;
  if ([...gone].some(id => W.complex.get(id)?.locked))
    return toast('A Complex Node is an ordinary node here. Edit it in the [Library](/library).', true);
  const parentOf = g => {
    let p = g.parent;
    while (p && gone.has(p)) p = W.groups.get(p)?.parent ?? null;
    return p;
  };
  await saveGroups(
    W.snapshot.groups
      .filter(g => !gone.has(g.id))
      .map(g => ({id: g.id, name: g.name, position: g.position, members: g.members, parent: parentOf(g)}))
  );
  await reload();
  select([]);
}

/** Renames the selected node or group on the canvas (a Custom node, a Complex Node placed from the Library, a group). */
function renameSelection() {
  const item = primarySelection();
  if (item?.kind === 'group') return renameGroup(item.group.id);
  const node = item?.node;
  if (node?.kind !== 'function') return;
  inlineRename($(`.node[data-id="${CSS.escape(node.id)}"] .title`), nodeLabel(node), async title => {
    await api(`projects/${W.project}/node-title`, {method: 'PUT', body: wf({node_id: node.id, title}), edit: editToken()});
    await reload();
  });
}

function renameGroup(id = primarySelection()?.group?.id) {
  const group = W.groups.get(id);
  if (!group) return;
  const title =
    $(`.frame[data-frame="${CSS.escape(id)}"] .title`) || $(`.node[data-id="complex:${CSS.escape(id)}"] .title`);
  inlineRename(title, group.name, async name => {
    await saveGroups(
      W.snapshot.groups.map(g => ({
        id: g.id,
        name: g.id === group.id ? name : g.name,
        members: g.members,
        parent: g.parent,
        position: g.position,
      }))
    );
    await reload();
  });
}

/** Opens a Library node in its graph editor (the only place where a Complex Node can be changed). */
async function editInLibrary(resourceId) {
  await flushNodeEdits();
  await openNodeEditor(resourceId);
}

async function setCollapsed(groupId, collapsed) {
  if (W.complex.get(groupId)?.locked)
    return toast('A Complex Node is an ordinary node here. Edit it in the [Library](/library).', true);
  const edit = editToken();
  if (collapsed) {
    const frame = W.pos.get('frame:' + groupId);
    if (frame)
      await api(`projects/${W.project}/layout`, {
        method: 'PUT',
        body: wf({positions: {['complex:' + groupId]: {x: frame.x, y: frame.y}}}),
        edit,
      });
  }
  await api(`projects/${W.project}/complex/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    body: wf({collapsed}),
    edit,
  });
  await reload();
  select([collapsed ? 'complex:' + groupId : 'frame:' + groupId]);
}

async function undo(redo) {
  await flushNodeEdits();
  const status = await api(`projects/${W.project}/${redo ? 'redo' : 'undo'}`, {method: 'POST', body: wf()});
  if (!status[redo ? 'redo' : 'undo'] && !W.history[redo ? 'redo' : 'undo'])
    toast(redo ? 'Nothing to redo.' : 'Nothing to undo.');
  await reload();
}
