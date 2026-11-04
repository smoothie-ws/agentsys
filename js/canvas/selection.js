// Selection state, the Library editor work area, and the floating selection toolbar.
'use strict';

// ----- selection -----
function select(ids, additive = false) {
  if (!additive) W.selected.clear();
  for (const id of ids) additive && W.selected.has(id) && ids.length === 1 ? W.selected.delete(id) : W.selected.add(id);
  W.edges.clear();
  for (const [id, element] of W.elements) element.classList.toggle('selected', W.selected.has(id));
  for (const frame of $$('.frame')) frame.classList.toggle('selected', W.selected.has('frame:' + frame.dataset.frame));
  drawWires();
  drawSelectionTools();
  updateHints();
  Inspector.show();
}
/** Selects connections (replacing the selection, or toggling one when additive). */
function selectEdges(ids, additive = false) {
  if (!additive) W.edges.clear();
  else if (W.selected.size) select([]);
  for (const id of ids) additive && W.edges.has(id) ? W.edges.delete(id) : W.edges.add(id);
  if (!additive || W.edges.size) {
    W.selected.clear();
    for (const [, element] of W.elements) element.classList.remove('selected');
    for (const frame of $$('.frame')) frame.classList.remove('selected');
  }
  drawWires();
  drawSelectionTools();
  updateHints();
  Inspector.show();
}
const selectedNodes = () =>
  [...W.selected]
    .filter(id => !id.startsWith('frame:'))
    .map(id => W.nodes.get(id))
    .filter(Boolean);
const selectedFrames = () =>
  [...W.selected]
    .filter(id => id.startsWith('frame:'))
    .map(id => W.groups.get(id.slice(6)))
    .filter(Boolean);
/** The main group of a Library editor can be selected and renamed, but never copied, nested, ungrouped or deleted. */
const isRoot = id => !!W.library && id === W.snapshot?.root;
/** Groups in the selection: frames, and the groups behind collapsed Complex Nodes. */
const selectedGroupIds = () =>
  [
    ...new Set([
      ...selectedFrames().map(g => g.id),
      ...selectedNodes()
        .filter(n => n.kind === 'complex')
        .map(n => n.group_id),
    ]),
  ].filter(id => !isRoot(id));
const plainNodes = () => selectedNodes().filter(n => n.kind !== 'complex');
/** What the side panel shows for a single selection: a node, or a group with its optional Complex Node wrapper. */
function primarySelection() {
  const nodes = selectedNodes(),
    frames = selectedFrames();
  if (nodes.length + frames.length !== 1) return null;
  if (nodes[0]?.kind === 'complex') return {kind: 'group', group: W.groups.get(nodes[0].group_id), node: nodes[0]};
  if (nodes[0]) return {kind: 'node', node: nodes[0]};
  return {kind: 'group', group: frames[0], node: W.nodes.get('complex:' + frames[0].id) || null};
}
const hasClipboard = () => !!store.get('agentsys-clipboard');

const selectionItems = () => [
  ...selectedNodes(),
  ...selectedFrames().map(g => ({...g, id: 'frame:' + g.id, group_id: g.id, kind: 'group'})),
];
function drawSelectionTools() {
  const tools = $('#selection-tools');
  if (!tools || !W.camera) return;
  const items = selectionItems(),
    boxes = items.map(n => W.pos.get(n.id)).filter(Boolean);
  if (tools.hidden !== !boxes.length) tools.hidden = !boxes.length;
  if (!boxes.length) return;
  const x = Math.min(...boxes.map(p => p.x)),
    y = Math.min(...boxes.map(p => p.y));
  const right = Math.max(...boxes.map(p => p.x + p.w));
  const halfWidth = Math.max(40, tools.offsetWidth / 2 + 8),
    centre = ((x + right) / 2 - W.camera.x) * W.camera.zoom;
  tools.style.left = Math.max(halfWidth, Math.min(W.canvas.clientWidth - halfWidth, centre)) + 'px';
  tools.style.top = Math.max(8, (y - W.camera.y) * W.camera.zoom - 42) + 'px';
  const toolbar = $('.toolbar', W.canvas);
  if (toolbar) {
    const actions = toolbar.getBoundingClientRect(),
      controls = tools.getBoundingClientRect();
    if (controls.left < actions.right + 8 && controls.right > actions.left - 8 && controls.top < actions.bottom + 8)
      tools.style.top = toolbar.offsetTop + toolbar.offsetHeight + 8 + 'px';
  }
  const pinned = items.every(n => n.pinned),
    button = $('[data-selection-pin]', tools);
  button.classList.toggle('active', pinned);
  button.title = pinned ? 'Unpin' : 'Pin';
  button.setAttribute('aria-label', pinned ? 'Unpin node' : 'Pin node');
  const switchable = items,
    off = switchable.length > 0 && switchable.every(n => n.disabled),
    power = $('[data-selection-disable]', tools);
  power.hidden = !switchable.length;
  power.classList.toggle('active', off);
  power.title = `${off ? 'Enable' : 'Disable'} (${shortcutText('disable')})`;
  power.setAttribute('aria-label', off ? 'Enable' : 'Disable');
}

/** The group a node (or collapsed Complex Node) sits directly in; null on the open canvas. */
const parentGroupOf = n =>
  n.kind === 'complex' ? (W.groups.get(n.group_id)?.parent ?? null) : (groupChain(n.id)[0]?.id ?? null);
/** Selects what was not selected and deselects what was: within the group of the selection, or on the whole canvas. */
function invertSelection() {
  const nodes = selectedNodes(),
    parents = new Set(nodes.map(parentGroupOf)),
    scope = parents.size === 1 ? [...parents][0] : null;
  const pool = visibleNodes().filter(n => scope === null || parentGroupOf(n) === scope);
  select(pool.filter(n => !W.selected.has(n.id)).map(n => n.id));
}
