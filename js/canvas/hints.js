// Snapping to the canvas grid, and the strip of key hints along the bottom of the canvas (like the status bar of Blender).
'use strict';

/** The grid the nodes and groups snap to: the spacing of the dots the canvas draws at 100% zoom. */
const SNAP_SIZE = 24;

const snapped = value => Math.round(value / SNAP_SIZE) * SNAP_SIZE;
/** `value` moved to the grid when snapping is on. */
const snapValue = value => (W.snap ? snapped(value) : value);
/** The move (dx, dy) that puts `origin` plus the move on the grid when snapping is on: everything that moves with it keeps its place. */
function snapMove(origin, dx, dy) {
  return W.snap && origin ? {dx: snapped(origin.x + dx) - origin.x, dy: snapped(origin.y + dy) - origin.y} : {dx, dy};
}

function setSnap(on, save = true) {
  W.snap = !!on;
  if (save) store.set('agentsys-snap', W.snap);
  const button = $('#snap-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(W.snap));
    button.title = `Snap to the grid (${shortcutText('snap')}): ${W.snap ? 'on' : 'off'}`;
  }
  updateHints();
}

function setHintsShown(on, save = true) {
  W.hintsShown = !!on;
  if (save) store.set('agentsys-hints', W.hintsShown);
  const bar = $('#hints'),
    button = $('#hints-toggle');
  bar?.classList.toggle('collapsed', !W.hintsShown);
  if (button) {
    button.setAttribute('aria-pressed', String(W.hintsShown));
    button.title = `Key hints (${shortcutText('hints')}): ${W.hintsShown ? 'shown' : 'hidden'}`;
  }
  updateHints();
}

/** What the person is doing right now, for the hints: null (nothing special), 'node', 'frame', 'resize', 'wire' or 'marquee'. */
function setHintMode(mode, detail = {}) {
  W.hintMode = mode;
  W.hintDetail = detail;
  updateHints();
}

const hintItem = (keys, label, on = false) =>
  `<span class="hint${on ? ' on' : ''}">${[]
    .concat(keys)
    .map(k => `<kbd>${esc(k)}</kbd>`)
    .join('')}<span>${esc(label)}</span></span>`;

/** The hints for the current mode and selection: [[keys, label, highlighted?], ...]. */
function hintList() {
  const key = shortcutText,
    snap = [key('snap'), `Snap ${W.snap ? 'off' : 'on'}`],
    detail = W.hintDetail || {};
  switch (W.hintMode) {
    case 'node':
      return [
        ['Drag', 'Move'],
        [
          'Ctrl',
          detail.carried
            ? `Moving ${plural(detail.carried, 'node')} downstream too`
            : 'Hold at the start to move the nodes it feeds too',
          !!detail.carried,
        ],
        snap,
        ['Drop on a group', 'Put in it'],
        ['Drop on a wire', 'Insert'],
      ];
    case 'frame':
      return [['Drag', 'Move the group'], snap, ['Drop on a group', 'Put in it']];
    case 'resize':
      return [['Drag', 'Resize'], snap];
  }
  const items = [];
  if (W.edges.size)
    return [
      [key('delete'), 'Disconnect'],
      ['Click', 'Select another'],
      [key('cancel'), 'Deselect'],
    ];
  if (W.selected.size) {
    items.push(
      ['Drag', 'Move'],
      ['Ctrl+Drag', 'Move with the nodes it feeds'],
      [key('multiSelect') + '+Click', 'Add to selection']
    );
    items.push(
      [key('copy'), 'Copy'],
      [key('delete'), 'Delete'],
      [key('group'), 'Group'],
      [key('dissolve'), 'Dissolve'],
      [key('disable'), 'Disable'],
      [key('fold'), 'Collapse']
    );
    if (selectedFrames().length) items.push([key('renameGroup'), 'Rename']);
    items.push(snap, [key('fit'), 'Fit selection']);
    return items;
  }
  items.push(
    ['Drag', 'Pan'],
    ['Wheel', 'Zoom'],
    [key('marquee'), 'Box select'],
    [key('selectAll'), 'Select all'],
    ['Right click', 'Add / menu']
  );
  if (!W.library) items.push([key('run'), 'Run']);
  items.push([key('undo'), 'Undo'], snap, [key('fit'), 'Fit'], [key('togglePanel'), 'Panel']);
  return items;
}

function updateHints() {
  const list = $('#hint-list');
  if (!list) return;
  list.innerHTML = W.hintsShown
    ? hintList()
        .map(([keys, label, on]) => hintItem(keys, label, on))
        .join('')
    : '';
  fitHints();
}

/** A hint is shown whole or not at all: those that do not fit the strip (the panel on the right narrows it) are left out, not cut mid-word. */
function fitHints() {
  const list = $('#hint-list');
  if (!list) return;
  const items = [...list.children];
  items.forEach(item => (item.hidden = false));
  const limit = list.clientWidth;
  let overflow = false;
  for (const item of items) {
    if (overflow || item.offsetLeft + item.offsetWidth > limit) {
      item.hidden = true;
      overflow = true;
    }
  }
}

function wireHints() {
  setSnap(store.get('agentsys-snap', false), false);
  setHintsShown(store.get('agentsys-hints', true), false);
  $('#snap-toggle').onclick = () => setSnap(!W.snap);
  $('#hints-toggle').onclick = () => setHintsShown(!W.hintsShown);
  new ResizeObserver(fitHints).observe($('#hint-list'));
}
