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
};
const SHORTCUT_PATTERN =
  /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down)|Space|Enter|Escape|Delete|Backspace|Home|End|PageUp|PageDown|Equal|Minus|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Shift|Control|Alt|Meta)$/;
/** Graph Editor appearance limits: [min, max] of each whole-number setting, and the wire shapes. */
const GRAPH_RANGES = {node_radius: [0, 42], group_radius: [0, 54], wire_width: [1, 5], wire_curve: [10, 100]};
const WIRE_STYLE_IDS = ['bezier', 'linear', 'step', 'rounded'];
const SCRIPT_TIMEOUT = 120000;

function validateShortcuts(value) {
  if (!isObject(value) || Object.keys(value).some(k => !(k in DEFAULT_SHORTCUTS))) throw bad('Unknown shortcut action');
  for (const binding of Object.values(value)) {
    if (typeof binding !== 'string' || (binding && !SHORTCUT_PATTERN.test(binding)))
      throw bad('Invalid physical-key shortcut');
    const parts = binding.split('+');
    if (parts.length !== new Set(parts).size) throw bad('A modifier cannot occur twice');
  }
  const used = Object.values({...DEFAULT_SHORTCUTS, ...value})
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

/** Component-level appearance options, shared by validation and the theme editor. */
const themeColour = (label, fallback) => ({label, type: 'color', fallback});
const themeRadius = label => ({label, type: 'number', min: 0, max: 48});
const THEME_PARTS = {
  panels: {
    label: 'Panels',
    icon: 'panel',
    fields: {
      sidebar: themeColour('Primary panel', '--panel'),
      secondary: themeColour('Navigation panel', '--card'),
      content: themeColour('Content', '--background'),
      inspector: themeColour('Inspector', '--panel'),
      outline: themeColour('Outline', '--line'),
      radius: themeRadius('Roundness'),
    },
  },
  navigation: {
    label: 'Navigation',
    icon: 'folder',
    fields: {
      text: themeColour('Text', '--muted'),
      background: themeColour('Item', '--field'),
      hover: themeColour('Hover', '--hover'),
      selected: themeColour('Selected', '--current'),
      selected_text: themeColour('Selected text', '--text'),
      radius: themeRadius('Roundness'),
    },
  },
  buttons: {
    label: 'Buttons',
    icon: 'play',
    fields: {
      text: themeColour('Text', '--text'),
      background: themeColour('Fill', '--field'),
      hover: themeColour('Hover', '--hover'),
      pressed: themeColour('Pressed', '--press'),
      outline: themeColour('Outline', '--line'),
      primary: themeColour('Primary fill', '--accent'),
      primary_text: themeColour('Primary text', '--on-accent'),
      radius: themeRadius('Roundness'),
    },
  },
  fields: {
    label: 'Text and number fields',
    icon: 'text',
    fields: {
      text: themeColour('Text', '--text'),
      background: themeColour('Fill', '--field'),
      hover: themeColour('Hover', '--hover'),
      focus: themeColour('Focused', '--soft'),
      placeholder: themeColour('Placeholder', '--muted'),
      outline: themeColour('Outline', '--line'),
      radius: themeRadius('Roundness'),
    },
  },
  menus: {
    label: 'Menus and dialogs',
    icon: 'list',
    fields: {
      text: themeColour('Text', '--text'),
      background: themeColour('Fill', '--float'),
      hover: themeColour('Item hover', '--hover'),
      selected: themeColour('Selected item', '--current'),
      outline: themeColour('Outline', '--line'),
      radius: themeRadius('Roundness'),
    },
  },
  cards: {
    label: 'Cards',
    icon: 'library',
    fields: {
      text: themeColour('Text', '--text'),
      background: themeColour('Fill', '--glass-card'),
      hover: themeColour('Hover', '--hover'),
      outline: themeColour('Outline', '--line'),
      radius: themeRadius('Roundness'),
    },
  },
  nodes: {
    label: 'Graph nodes',
    icon: 'node',
    fields: {
      text: themeColour('Text', '--text'),
      background: themeColour('Fill', '--glass-card'),
      hover: themeColour('Hover', '--hover'),
      outline: themeColour('Outline', '--line'),
      selected_outline: themeColour('Selected outline', '--accent'),
    },
  },
  canvas: {
    label: 'Canvas and wires',
    icon: 'complex',
    fields: {
      background: themeColour('Canvas', '--canvas-bg'),
      grid: themeColour('Grid dots', '--grid-colour'),
      wire: themeColour('Wires', '--idle'),
      selection: themeColour('Selection', '--soft'),
    },
  },
  status: {
    label: 'Status and secondary text',
    icon: 'activity',
    fields: {
      success: themeColour('Success', '--ok'),
      error: themeColour('Error', '--bad'),
      warning: themeColour('Warning', '--warn'),
      muted: themeColour('Secondary text', '--muted'),
    },
  },
};
function validateThemeParts(parts) {
  if (!isObject(parts)) throw bad('Theme components must be an object.');
  const result = {};
  for (const [group, values] of Object.entries(parts)) {
    if (!Object.hasOwn(THEME_PARTS, group) || !isObject(values)) throw bad('Unknown theme component.');
    const fields = {};
    for (const [key, value] of Object.entries(values)) {
      const rule = THEME_PARTS[group].fields[key];
      if (!rule || !Object.hasOwn(THEME_PARTS[group].fields, key)) throw bad('Unknown component setting.');
      if (rule.type === 'color' && (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)))
        throw bad('Component colours must use #RRGGBB or #RRGGBBAA.');
      if (rule.type === 'number' && (!Number.isInteger(value) || value < rule.min || value > rule.max))
        throw bad('Component roundness must be from 0 to 32 pixels.');
      fields[key] = value;
    }
    if (Object.keys(fields).length) result[group] = fields;
  }
  return result;
}

/** Shared validation for the active appearance and saved/imported themes. */
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
          'components',
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
  if ('components' in merged) merged.components = validateThemeParts(merged.components);
  return merged;
}

function validateThemes(themes) {
  if (!Array.isArray(themes) || themes.length > 100) throw bad('Save at most 100 themes.');
  const ids = new Set(),
    names = new Set();
  return themes.map(theme => {
    if (
      !isObject(theme) ||
      typeof theme.id !== 'string' ||
      !/^[a-z0-9_-]{1,80}$/i.test(theme.id) ||
      typeof theme.name !== 'string' ||
      !theme.name.trim() ||
      theme.name.trim().length > 100
    )
      throw bad('A theme needs an id and a name of 1 to 100 characters.');
    const name = theme.name.trim();
    if (ids.has(theme.id) || names.has(name.toLocaleLowerCase())) throw bad('Theme ids and names must be unique.');
    ids.add(theme.id);
    names.add(name.toLocaleLowerCase());
    const style = validateAppearance(theme.style);
    if (!['background', 'surface', 'text', 'accent'].every(k => k in style))
      throw bad('A theme needs four palette colours.');
    return {id: theme.id, name, style};
  });
}
