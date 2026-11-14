// Default keyboard shortcuts and the validation of user-chosen ones.
'use strict';

const DEFAULT_SHORTCUTS = {
  copy: 'Ctrl+KeyC',
  cut: 'Ctrl+KeyX',
  paste: 'Ctrl+KeyV',
  delete: 'Delete',
  dissolve: 'KeyX',
  group: 'Ctrl+KeyG',
  ungroup: 'Ctrl+Alt+KeyG',
  renameGroup: 'F2',
  selectAll: 'Ctrl+KeyA',
  marquee: 'KeyB',
  invertSelection: 'Ctrl+KeyI',
  fit: 'Home',
  zoomIn: 'Equal',
  zoomOut: 'Minus',
  run: 'Ctrl+Enter',
  pan: 'Space',
  multiSelect: 'Shift',
  cancel: 'Escape',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  undo: 'Ctrl+KeyZ',
  redo: 'Ctrl+Shift+KeyZ',
  togglePanel: 'KeyN',
  disable: 'KeyM',
  fold: 'KeyF',
  snap: 'KeyG',
  hints: 'KeyH',
  toolSelect: 'Digit1',
  toolMove: 'Digit2',
  toolPan: 'Digit3',
  toolDelete: 'Digit4',
  toolAdd: 'Digit5',
};
const SHORTCUT_PATTERN =
  /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down)|Space|Enter|Escape|Delete|Backspace|Home|End|PageUp|PageDown|Equal|Minus|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Shift|Control|Alt|Meta)$/;
// GRAPH_RANGES and WIRE_STYLE_IDS are shared with the client (shared/core.js).

function validateShortcuts(value) {
  if (!isObject(value) || Object.keys(value).some(k => !Object.hasOwn(DEFAULT_SHORTCUTS, k)))
    throw bad('Unknown shortcut action');
  for (const binding of Object.values(value)) {
    if (typeof binding !== 'string' || (binding && !SHORTCUT_PATTERN.test(binding)))
      throw bad('Invalid physical-key shortcut');
    const parts = binding.split('+');
    if (parts.length !== new Set(parts).size) throw bad('A modifier cannot occur twice');
  }
  const effective = {...DEFAULT_SHORTCUTS, ...value};
  // Existing custom bindings take precedence over newly introduced tool defaults.
  for (const action of ['toolSelect', 'toolMove', 'toolPan', 'toolDelete', 'toolAdd']) {
    if (!Object.hasOwn(value, action) && Object.entries(value).some(([key, binding]) => key !== action && binding === effective[action]))
      effective[action] = '';
  }
  const used = Object.values(effective)
    .filter(Boolean)
    .map(v =>
      v
        .split('+')
        .map(p => p.replace('Meta', 'Ctrl'))
        .sort()
        .join('+')
    );
  if (used.length !== new Set(used).size) throw bad('Shortcuts must be unique; clear the conflicting binding first');
  return value;
}

/** Validation of the appearance (the style). `base` is what is stored; `style` changes it. */
function validateAppearance(style, base = {}) {
  if (
    !isObject(style) ||
    Object.keys(style).some(
      k =>
        ![
          'font_size',
          'font_family',
          'background',
          'surface',
          'text',
          'accent',
          'effects',
          'animations',
          ...Object.keys(GRAPH_RANGES),
          'wire_style',
        ].includes(k)
    )
  )
    throw bad('Invalid style settings');
  const merged = {...base, ...style};
  if ('font_size' in merged && (!Number.isInteger(merged.font_size) || merged.font_size < 12 || merged.font_size > 22))
    throw bad('Font size must be an integer from 12 to 22');
  if (
    'font_family' in merged &&
    !['system', 'Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Courier New'].includes(merged.font_family)
  )
    throw bad('Unsupported interface font');
  for (const k of ['background', 'surface', 'text', 'accent'])
    if (k in merged && (typeof merged[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(merged[k])))
      throw bad('Style colors must use #RRGGBB');
  for (const [k, [min, max]] of Object.entries(GRAPH_RANGES))
    if (k in merged && !(Number.isInteger(merged[k]) && merged[k] >= min && merged[k] <= max))
      throw bad(`${k} must be an integer from ${min} to ${max}`);
  if ('wire_style' in merged && !WIRE_STYLE_IDS.includes(merged.wire_style)) throw bad('Unsupported wire style');
  for (const k of ['effects', 'animations'])
    if (k in merged && typeof merged[k] !== 'boolean') throw bad('Style toggles must be booleans');
  return merged;
}
