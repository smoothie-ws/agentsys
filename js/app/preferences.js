// Keyboard shortcuts and the appearance settings (palette, fonts, graph look).
'use strict';

// ----- preferences: shortcuts and appearance -----
const SHORTCUT_LABELS = {
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  delete: 'Delete',
  dissolve: 'Dissolve',
  group: 'Group',
  ungroup: 'Ungroup',
  renameGroup: 'Rename',
  selectAll: 'Select all',
  marquee: 'Rectangle select',
  invertSelection: 'Invert selection',
  fit: 'Fit to view',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  run: 'Run',
  pan: 'Pan (hold)',
  multiSelect: 'Add to selection (hold)',
  cancel: 'Cancel',
  left: 'Pan left',
  right: 'Pan right',
  up: 'Pan up',
  down: 'Pan down',
  undo: 'Undo',
  redo: 'Redo',
  togglePanel: 'Toggle side panel',
  disable: 'Disable or enable nodes and groups',
  fold: 'Collapse or expand nodes and groups',
  snap: 'Toggle snapping to the grid',
  hints: 'Toggle key hints',
};
/** Developer mode (Settings): Custom nodes can be made and edited by hand, and the Custom node is offered. */
const developerMode = () => !!app.preferences?.developer_mode;
const binding = action => app.preferences.shortcuts?.[action] ?? app.shortcutDefaults[action] ?? '';
// Shortcuts follow the physical key, so they work on any layout. When the system gives no key code
// (remote desktops, some virtual machines), a Cyrillic letter is mapped to the Latin key at the same place.
const CYRILLIC_KEYS = Object.fromEntries(
  [...'йцукенгшщзфывапролдячсмить'].map((ch, i) => [ch, [...'qwertyuiopasdfghjklzxcvbnm'][i]])
);
Object.assign(CYRILLIC_KEYS, {і: 's', ї: ']', є: "'", ґ: '\\', ё: '`', х: '[', ъ: ']', ж: ';', э: "'", б: ',', ю: '.'});
const SYMBOL_CODES = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '`': 'Backquote',
};
function keyCode(event) {
  let code = event.code;
  if (!code || code === 'Unidentified') {
    const k = String(event.key || '').toLowerCase(),
      latin = CYRILLIC_KEYS[k] || k;
    code = /^[a-z]$/.test(latin)
      ? 'Key' + latin.toUpperCase()
      : /^[0-9]$/.test(latin)
        ? 'Digit' + latin
        : SYMBOL_CODES[latin] || (event.key === ' ' ? 'Space' : '');
  }
  return code.replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, '$1');
}
const shortcutText = action =>
  binding(action)
    .replace(/Key|Digit/g, '')
    .replace('Equal', '=')
    .replace('Minus', '-') || '—';
function matches(action, event) {
  const parts = binding(action).split('+'),
    code = parts.pop();
  if (!code || keyCode(event) !== code) return false;
  return (
    (event.ctrlKey || event.metaKey) === parts.includes('Ctrl') &&
    event.altKey === parts.includes('Alt') &&
    event.shiftKey === parts.includes('Shift')
  );
}
function recordShortcut(event) {
  const code = keyCode(event),
    parts = [];
  if ((event.ctrlKey || event.metaKey) && !['Control', 'Meta'].includes(code)) parts.push('Ctrl');
  if (event.altKey && code !== 'Alt') parts.push('Alt');
  if (event.shiftKey && code !== 'Shift') parts.push('Shift');
  return [...parts, code].join('+');
}
const THEMES = {
  Dark: {background: '#080808', surface: '#101010', text: '#ededed', accent: '#d9d9d9'},
  Graphite: {background: '#06080b', surface: '#14181f', text: '#e9ebf1', accent: '#ff7a45'},
  Light: {background: '#eef0f3', surface: '#ffffff', text: '#1d232c', accent: '#b5670f'},
  Midnight: {background: '#0b1020', surface: '#141b2e', text: '#e2e8f6', accent: '#8fb0ff'},
  Moss: {background: '#0f1612', surface: '#18221c', text: '#e1ece4', accent: '#9bd08a'},
};
/** Graph Editor look: corner radii (px), wire shape and thickness. Wire shapes are drawn by `wirePath` in render.js. */
const GRAPH_DEFAULTS = {node_radius: 16, group_radius: 33, wire_style: 'bezier', wire_width: 2, wire_curve: 50};
const WIRE_STYLES = [
  ['bezier', 'Bezier curve'],
  ['linear', 'Straight line'],
  ['step', 'Right angles'],
  ['rounded', 'Rounded right angles'],
];
const STYLE_DEFAULTS = {
  font_size: 14,
  font_family: 'system',
  ...THEMES.Graphite,
  effects: true,
  animations: true,
  ...GRAPH_DEFAULTS,
};
let graphStyle = GRAPH_DEFAULTS;
/** What is on the root element now. Removing a variable and setting it again to the same value would restyle the whole page for nothing,
 *  so a value is written only when it differs from the one in place (a colour drag applies on every frame). */
const rootVars = new Map();
function setRootVar(name, value) {
  const root = document.documentElement;
  if (value === null || value === undefined || value === '') {
    if (rootVars.delete(name)) root.style.removeProperty(name);
  } else if (rootVars.get(name) !== String(value)) {
    rootVars.set(name, String(value));
    root.style.setProperty(name, String(value));
  }
}
function setRootData(name, value) {
  const root = document.documentElement;
  if (root.dataset[name] !== value) root.dataset[name] = value;
}
function applyStyle(style = {}) {
  const value = {...STYLE_DEFAULTS, ...style};
  for (const key of ['background', 'surface', 'text', 'accent']) setRootVar('--' + key, value[key]);
  setRootVar('--font-size', value.font_size + 'px');
  setRootVar('--font', value.font_family !== 'system' ? `"${value.font_family}", system-ui, sans-serif` : null);
  const luminance = hex =>
    [1, 3, 5]
      .map(i => parseInt(hex.slice(i, i + 2), 16))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  setRootData('theme', luminance(value.background) > 140 ? 'light' : 'dark');
  setRootVar('--on-accent', luminance(value.accent) > 140 ? '#14171c' : '#ffffff');
  graphStyle = value;
  setRootVar('--node-radius', value.node_radius + 'px');
  setRootVar('--frame-radius', value.group_radius + 'px');
  setRootVar('--wire-width', value.wire_width);
  setRootData('motion', String(value.animations));
  setRootData('effects', String(value.effects));
  // Colours never move a row; only what changes sizes (the font) makes the highlights find their rows again.
  applyNavJoined(value.effects, value.font_size + '|' + value.font_family);
}
