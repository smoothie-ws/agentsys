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
  const button = $('#hints-toggle');
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

/** The hints for the current mode and selection: [[keys, label, highlighted?], ...]. */
function hintList() {
  const key = shortcutText,
    snap = [key('snap'), `Snap ${W.snap ? 'off' : 'on'}`],
    detail = W.hintDetail || {};
  switch (W.hintMode) {
    case 'move':
      return [['Drag', 'Move selection'], snap, ['Middle drag / Space+drag', 'Pan']];
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
  if (W.tool === 'delete') return [['Click', 'Delete node, group or wire'], [key('undo'), 'Undo'], ['Middle drag / Space+drag', 'Pan']];
  if (W.tool === 'pan') return [['Drag', 'Pan'], ['Wheel', 'Zoom'], [key('fit'), 'Fit']];
  const items = [];
  if (W.edges.size)
    return [
      [key('delete'), 'Disconnect'],
      ['Click', 'Select another'],
      [key('cancel'), 'Deselect'],
    ];
  if (W.selected.size) {
    items.push(
      ['Drag', W.tool === 'move' ? 'Move selection (also from empty space)' : 'Move'],
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
    ['Drag', W.tool === 'pan' ? 'Pan' : 'Box select'],
    ['Middle drag / Space+drag', 'Pan'],
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
  const button = $('#hints-toggle');
  if (!button) return;
  const strip = $('#canvas-hints');
  if (strip) {
    strip.hidden = !W.hintsShown;
    strip.innerHTML = hintList().map(([keys, label]) => `<span><kbd>${esc([].concat(keys).join(' + '))}</kbd> ${esc(label)}</span>`).join('');
  }
  button.title =
    'Keyboard shortcuts' +
    (W.hintsShown
      ? '\n' +
        hintList()
          .map(([keys, label]) => [].concat(keys).join(' + ') + ' - ' + label)
          .join('\n')
      : ` (${shortcutText('hints')})`);
}

function wireHints() {
  setSnap(store.get('agentsys-snap', false), false);
  setHintsShown(store.get('agentsys-hints', true), false);
  $('#snap-toggle').onclick = () => setSnap(!W.snap);
  $('#hints-toggle').onclick = () => setHintsShown(!W.hintsShown);
}
