// Node definitions and the rules about a node's configuration. A port is {id, name, type?}: the type, if it has one, is only used to decide what may be wired to what.
// Pure functions: nothing here touches a document or the browser.
'use strict';

/**
 * What a Custom node does besides holding values (`config.op`): the operations the engine knows. A node without one only holds the
 * values typed into its outputs. `script` runs JavaScript when a signal reaches it; the `on_*` nodes are the sources of signals
 * (see docs/engine.md). Nothing else is built into the engine.
 */
const OPS = new Set(['script', 'on_run', 'on_read', 'on_placed', 'on_deleted', 'on_wired', 'on_widget']);
/** The operations that fire a signal by themselves: the event nodes. */
const EVENT_OPS = new Set(['on_run', 'on_read', 'on_placed', 'on_deleted', 'on_wired', 'on_widget']);
/** The types of a Script's code (text typed in as code): the same IDs in every workflow and Library node, so they are one type everywhere. */
const SCRIPT_TEXT_TYPE = '64428b9c654c2c2cfcb55742ea899ed8',
  SCRIPT_CODE_TYPE = 'a42dbde0c1e1090d6adf1640c2dda533';
/** The error prefix of a Script. */
const SCRIPT_PREFIX = 'Node code';
const CUSTOM_CONFIG_LIMIT = 400000;
const MAX_PORTS = 256; // per direction
/** The format of a clipboard / Custom Node bundle (see Editor.copy). Another version is not read. */
const BUNDLE_VERSION = 3;
const CUSTOM_KEYS = new Set(['title', 'inputs', 'outputs', 'op', 'widgets', 'capabilities', 'grants']);
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// ----- Widgets: the controls and displays code puts on a Custom node -----
const WIDGET_KINDS = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'range', 'button', 'label', 'html', 'markdown']);
/** Widgets that hold a value the person can change (a button's value counts its clicks; the script of an html widget may post one). */
const HAS_VALUE = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'range', 'button', 'html', 'markdown']);
const WIDGET_KEYS = new Set(['id', 'kind', 'label', 'value', 'options', 'min', 'max', 'step', 'placeholder', 'rows', 'text', 'html', 'height']);
const WIDGET_VALUE_LIMIT = 1000000;
const MAX_WIDGETS = 100; // per node
const optionValue = o => (isObject(o) ? o.value : o);
/** What a widget holds before anyone set it. */
function widgetDefault(w) {
  switch (w.kind) {
    case 'number':
    case 'range':
      return w.min ?? 0;
    case 'checkbox':
      return false;
    case 'button':
      return 0;
    case 'select':
      return w.options?.length ? optionValue(w.options[0]) : null;
    default:
      return '';
  }
}
/** The widgets of a node: [{id, kind, label?, value?, options?, min?, max?, step?, placeholder?, rows?, text?, html?, height?}]. */
function checkWidgets(list) {
  if (!Array.isArray(list) || list.length > MAX_WIDGETS) throw bad(`A node has at most ${MAX_WIDGETS} widgets`);
  const ids = new Set();
  for (const w of list) {
    if (!isObject(w) || Object.keys(w).some(k => !WIDGET_KEYS.has(k))) throw bad('A widget has an id, a kind and the fields of its kind');
    if (typeof w.id !== 'string' || !w.id || w.id.length > 80 || ids.has(w.id)) throw bad('Give each widget a unique ID');
    ids.add(w.id);
    if (!WIDGET_KINDS.has(w.kind)) throw bad(`Unknown widget kind “${w.kind}” (use ${[...WIDGET_KINDS].join(', ')})`);
    if ('label' in w && (typeof w.label !== 'string' || w.label.length > 500)) throw bad('A widget label is text of at most 500 characters');
    for (const k of ['min', 'max', 'step', 'rows', 'height'])
      if (k in w && !(typeof w[k] === 'number' && Number.isFinite(w[k]))) throw bad(`Widget ${k} is a number`);
    for (const k of ['placeholder', 'text', 'html'])
      if (k in w && typeof w[k] !== 'string') throw bad(`Widget ${k} is text`);
    if ('options' in w && (!Array.isArray(w.options) || w.options.length > 500)) throw bad('Widget options are a list of at most 500');
    if ('value' in w && JSON.stringify(w.value ?? null).length > WIDGET_VALUE_LIMIT) throw bad('The widget value is too large');
  }
  if (JSON.stringify(list).length > 4 * WIDGET_VALUE_LIMIT) throw bad('The widgets are too large');
}

const DEFINITIONS = {
  // A Custom node: its ports are listed in its configuration, what it does is `op` (none: it holds values).
  custom: {
    label: 'Custom',
    category: 'Custom',
    inputs: [],
    outputs: [],
    defaults: {
      title: '',
      inputs: [],
      outputs: [{id: 'result', name: 'result'}],
    },
  },
  // A point on a wire: passes its input on. Made by splitting a connection; not offered in menus.
  reroute: {label: 'Reroute', category: 'Hidden', inputs: [{id: 'in', name: 'in'}], outputs: [{id: 'out', name: 'out'}], defaults: {}},
};

const key = (node, port) => node + '|' + port;

/** The ports inside a group that a slot of its interface is bound to: [{node_id, port_id}], at least one, no port twice. */
const validBound = list =>
  Array.isArray(list) &&
  list.length > 0 &&
  list.length <= MAX_PORTS &&
  list.every(b => isObject(b) && Object.keys(b).length === 2 && typeof b.node_id === 'string' && typeof b.port_id === 'string') &&
  new Set(list.map(b => b.node_id + '|' + b.port_id)).size === list.length;

function checkPorts(items, {custom = false, types = NO_TYPES} = {}) {
  if (!Array.isArray(items) || items.length > MAX_PORTS) throw bad(`Use at most ${MAX_PORTS} ports per direction`);
  const ids = new Set(),
    names = new Set(),
    allowed = new Set(['id', 'name', 'type', 'bound', 'extra', 'default', 'editable']);
  for (const item of items) {
    if (
      !isObject(item) ||
      Object.keys(item).some(k => !allowed.has(k)) ||
      typeof item.id !== 'string' ||
      !item.id.length ||
      item.id.length > 80 ||
      ids.has(item.id) ||
      names.has(item.name) ||
      typeof item.name !== 'string' ||
      item.name.length > 200 ||
      ('type' in item && (typeof item.type !== 'string' || !item.type || !types.shape(item.type))) ||
      ('extra' in item && typeof item.extra !== 'boolean') ||
      ('editable' in item && typeof item.editable !== 'boolean') ||
      ('bound' in item && !validBound(item.bound))
    )
      throw bad('Give each port a unique ID and a name (a type, if it has one, must be a type of the workflow)');
    if ('default' in item) {
      const control = types.control(item.type);
      if (!control || !fitsControl(item.default, control)) throw bad(`The default of “${item.name}” must be a value its type can hold (a type with a control)`);
    }
    // `editable` (outputs): the node shows the control of the type, and what is typed there is the value of the output (`default`).
    if (item.editable && !types.control(item.type)) throw bad(`“${item.name}” can show a control only if its type has one`);
    if (custom && /[:|]/.test(item.id)) throw bad('A port ID cannot contain “:” or “|”');
    ids.add(item.id);
    names.add(item.name);
  }
  if (JSON.stringify(items).length > 100000) throw bad('Port configuration is too large');
}
function ensureAcyclic(adjacency) {
  const degrees = new Map();
  for (const [node, targets] of adjacency) {
    if (!degrees.has(node)) degrees.set(node, 0);
    for (const t of targets) degrees.set(t, (degrees.get(t) || 0) + 1);
  }
  const ready = [...degrees].filter(([, d]) => !d).map(([n]) => n);
  let count = 0;
  while (ready.length) {
    count++;
    for (const target of adjacency.get(ready.pop()) || []) {
      degrees.set(target, degrees.get(target) - 1);
      if (degrees.get(target) === 0) ready.push(target);
    }
  }
  if (count !== degrees.size) throw bad('Connection creates a cycle');
}

/** The configuration of a Custom node: only the known fields, an operation the engine knows (or none), valid ports. */
function validateCustomConfig(config, types = NO_TYPES) {
  if (typeof checkManifest === 'function') checkManifest(config);
  const unknown = Object.keys(config).find(k => !CUSTOM_KEYS.has(k));
  if (unknown) throw bad(`Unknown Custom node field “${unknown}”`);
  if (typeof config.title !== 'string' || config.title.length > 200) throw bad('The title is text of at most 200 characters');
  if ('op' in config && !OPS.has(config.op)) throw bad(`Unknown operation “${config.op}” (use ${[...OPS].join(', ')})`);
  checkPorts(config.inputs, {custom: true, types});
  checkPorts(config.outputs, {custom: true, types});
  // A Script has nothing to configure but its code: it reads the inputs and writes the outputs of the Library node it is in.
  if (config.op === 'script') {
    const [start, code] = config.inputs;
    if (config.inputs.length !== 2 || start.id !== 'in' || start.type !== 'signal' || code.id !== 'script' || code.type === 'signal' || config.outputs.length)
      throw bad('A Script has only the signal input In and its code (script), and no outputs: it reads and writes the inputs and outputs of the Library node it is in');
  }
  if (config.widgets !== undefined) checkWidgets(config.widgets);
  if (JSON.stringify(config).length > CUSTOM_CONFIG_LIMIT) throw bad('Node configuration is too large');
}

/** The values of a node's widgets by widget ID. */
const widgetValues = list => Object.fromEntries((list || []).map(w => [w.id, w.value]));

/** True when the node does something when a signal reaches it (a Script) or fires one (an event node); the others are read, not run. */
const isRunning = node => node.node_type === 'custom' && (node.config?.op === 'script' || EVENT_OPS.has(node.config?.op));
/** A node that takes no part in a run: disabled itself, or inside a group that is. */
const isOff = node => !!(node.disabled || node.muted);
/** The nodes a Run fires: the on_run nodes that are on. */
const isRunStart = node => node.node_type === 'custom' && node.config?.op === 'on_run' && !isOff(node);

function schema(node) {
  if (node.node_type === 'custom') {
    const config = node.config || {};
    return {inputs: (config.inputs || []).map(p => ({...p})), outputs: (config.outputs || []).map(p => ({...p}))};
  }
  if (node.node_type in DEFINITIONS) return DEFINITIONS[node.node_type];
  if (node.kind === 'complex') return {inputs: node.interface?.inputs || [], outputs: node.interface?.outputs || []};
  return {inputs: [], outputs: []};
}
