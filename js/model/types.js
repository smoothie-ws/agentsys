// User-defined types. A type is told by its ID. The types a workflow can use are the Library's (the types its Custom Nodes define, kept once, the same
// everywhere) and its own (`doc.types`, only in this workflow). While a workflow is open the two are one list, a Library type marked `library`.
// The built-in types are `any` and `signal`; there is no `text` or `number` until somebody defines one.
//
// A port's `type` is optional. Without one the port is of type `any`, which fits everything. Otherwise it is a type expression:
//   any           the built-in type: anything (the same as no type)
//   signal        the built-in type of a signal (see docs/engine.md): it carries no data and fits only another signal
//   t:<id>        a type: a name, a color and named fields (it may have none: then it is just a named kind)
// A type may be an alias of another (`alias: 't:<id>'`, no fields of its own): it means exactly what the other type means, so the two
// are interchangeable on wires, and it only brings its own name, color and control (Script is Text typed in as code).
// Compatibility is structural for types with fields: a type fits another when it has every field of the other (and the field
// types fit), so two types with the same fields are interchangeable. A type with no fields is a named kind: it fits itself and the
// ports of type any.
// Types only decide what may be wired to what. The engine never looks at them, and values are not checked while a graph runs.
'use strict';

const TYPE_REF = /^t:([0-9a-f]{32})$/;
const TYPE_REFS = /t:([0-9a-f]{32})/g;
const MAX_TYPES = 256,
  MAX_FIELDS = 32,
  MAX_TYPE_DEFS_SIZE = 400000;
const ANY = Object.freeze({kind: 'any'});
const SIGNAL = Object.freeze({kind: 'signal'});
/** Whether a type expression is the built-in signal type. */
const isSignal = type => type === 'signal';
/** How a type is typed in on a free slot: a small field of its kind. `select` is an enum: one of the type's `options`. */
const CONTROLS = ['text', 'textarea', 'code', 'number', 'checkbox', 'select'];
const MAX_OPTIONS = 64,
  MAX_OPTION = 80,
  MAX_TEXT = 10000;
/** The part of a type definition that says how it is typed in (what mergeTypes and syncType carry along with the fields). */
const controlOf = t => ({
  ...(t.control ? {control: t.control} : {}),
  ...(t.options ? {options: [...t.options]} : {}),
  ...(t.alias ? {alias: t.alias} : {}),
});
/** The type IDs a definition is made of: those of its fields and the one it is an alias of. */
const refsOf = t => [...t.fields.flatMap(f => typeRefs(f.type)), ...typeRefs(t.alias)];
/** Whether `value` is something the control of a type can hold. */
function fitsControl(value, {control, options}) {
  if (control === 'text' || control === 'textarea' || control === 'code') return typeof value === 'string' && value.length <= MAX_TEXT;
  if (control === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (control === 'checkbox') return typeof value === 'boolean';
  if (control === 'select') return typeof value === 'string' && (options || []).includes(value);
  return false;
}

/** The types of one document, resolved on demand: `shape(expression)` is what a type expression means (null when it means nothing). */
class TypeTable {
  constructor(list) {
    this.defs = new Map((list || []).map(t => [t.id, t]));
    this.known = new Map();
  }
  /** `{kind: 'any'}` or `{kind: 'type', name, fields: [{name, type: shape}]}`. */
  shape(expression, stack = []) {
    if (expression == null || expression === 'any') return ANY;
    if (expression === 'signal') return SIGNAL;
    if (typeof expression !== 'string') return null;
    const cached = this.known.get(expression);
    if (cached) return cached;
    let shape = null;
    const id = TYPE_REF.exec(expression)?.[1],
      def = id && this.defs.get(id);
    // A type that contains itself (however deep) means nothing: the stack finds the loop.
    if (def?.alias && !stack.includes(id)) {
      shape = this.shape(def.alias, [...stack, id]); // an alias is what it stands for
    } else if (def && !stack.includes(id)) {
      const fields = [];
      for (const field of def.fields || []) {
        const type = this.shape(field.type, [...stack, id]);
        if (!type) break;
        fields.push({name: field.name, type});
      }
      if (fields.length === (def.fields || []).length) shape = {kind: 'type', name: def.name, fields};
    }
    if (shape) this.known.set(expression, shape);
    return shape;
  }
  /** How the type is typed in on a slot: `{control, options?}`, or null (any, an unknown type, or a type without a control). */
  control(expression, depth = 0) {
    const id = typeof expression === 'string' && TYPE_REF.exec(expression)?.[1],
      def = id && this.defs.get(id);
    if (def?.control) return {control: def.control, ...(def.options ? {options: def.options} : {})};
    // An alias without a control of its own is typed in like the type it stands for.
    return def?.alias && depth < MAX_TYPES ? this.control(def.alias, depth + 1) : null;
  }
  /** What a person reads: `Person`, `any`; an unknown type shows as “unknown type”. */
  label(expression) {
    if (typeof expression !== 'string') return 'any';
    return expression.replace(TYPE_REFS, (_, id) => this.defs.get(id)?.name ?? 'unknown type');
  }
}
const NO_TYPES = new TypeTable([]);

/** Whether a value of the shape `from` can go where `to` is expected. */
function shapeFits(from, to) {
  if (from.kind === 'signal' || to.kind === 'signal') return from.kind === to.kind;
  if (from.kind === 'any' || to.kind === 'any') return true;
  if (!to.fields.length) return from.name === to.name;
  return to.fields.every(f => from.fields.some(g => g.name === f.name && shapeFits(g.type, f.type)));
}
/** Whether a type expression means `any` (no type, or `any` itself). */
const isAny = type => type == null || type === 'any';
/** Whether an output of type `a` may be wired to an input of type `b` (each a type expression, or none: `any`). */
function compatible(a, b, types = NO_TYPES) {
  if (isSignal(a) || isSignal(b)) return isSignal(a) && isSignal(b); // a signal is not data: it does not fit any, and any does not fit it
  if (a === b || isAny(a) || isAny(b)) return true;
  const from = types.shape(a),
    to = types.shape(b);
  return !!from && !!to && shapeFits(from, to);
}

/** A type of the Library as the type of a workflow: the same definition, marked `library`. */
const libraryType = t => ({...clone(t), library: true});
/** What the Library keeps of a type: its definition without the mark. */
const plainType = ({library, ...t}) => clone(t);
/** The types a workflow stores: its own, not the Library's. */
const ownTypes = list => (list || []).filter(t => !t.library);

/**
 * The types a workflow works with: the Library's and its own. A type of its own that means the same as a Library type (same name, same
 * fields and control) is that type, and one that a Library type shadows (same ID) or that has the name of another type is given
 * another name. Answers {types, absorbed: {dropped type ID -> Library type ID} for the caller to rename the ports with, changed}.
 */
function unifyTypes(library, own) {
  const out = library.map(t => ({...t, library: true})),
    absorbed = new Map(),
    libIds = new Set(library.map(t => t.id));
  let rest = ownTypes(own).map(t => ({...t})),
    changed = false;
  const shape = (t, map) => JSON.stringify([(t.fields || []).map(f => ({name: f.name, type: renameTypeRefs(f.type, map)})), controlOf({...t, alias: t.alias && renameTypeRefs(t.alias, map)})]);
  for (let more = true; more; ) {
    more = false;
    for (const x of rest) {
      const twin = library.find(y => y.name.toLowerCase() === x.name.toLowerCase() && shape(y, new Map()) === shape(x, absorbed));
      if (!twin && !libIds.has(x.id)) continue;
      if (twin) absorbed.set(x.id, twin.id);
      rest = rest.filter(y => y !== x);
      changed = more = true;
      break;
    }
  }
  const taken = new Set(out.map(t => t.name.toLowerCase()));
  for (const t of rest) {
    let name = t.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${t.name.slice(0, 50)} (${n})`;
    if (name !== t.name) changed = true;
    taken.add(name.toLowerCase());
    t.name = name;
  }
  return {types: [...out, ...rest], absorbed, changed};
}

/** The ids of the document types a type expression mentions. */
const typeRefs = expression => [...String(expression ?? '').matchAll(TYPE_REFS)].map(m => m[1]);
/** The expression with the document types it mentions replaced as `map` (old id -> new id) says. */
const renameTypeRefs = (expression, map) =>
  String(expression ?? '').replace(TYPE_REFS, (whole, id) => (map.has(id) ? 't:' + map.get(id) : whole));

/** Checks a list of type definitions: unique ids and names, fields with known types, no type that contains itself. */
function checkTypes(list) {
  if (!Array.isArray(list) || list.length > MAX_TYPES) throw bad(`Use at most ${MAX_TYPES} types`);
  const ids = new Set(),
    names = new Set();
  for (const t of list) {
    if (
      !isObject(t) ||
      Object.keys(t).some(k => !['id', 'name', 'color', 'fields', 'library', 'control', 'options', 'alias'].includes(k)) ||
      typeof t.id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(t.id) ||
      ids.has(t.id) ||
      typeof t.name !== 'string' ||
      !t.name.trim() ||
      t.name.length > 60 ||
      t.name !== t.name.trim() ||
      names.has(t.name.toLowerCase()) ||
      (t.color != null && !(typeof t.color === 'string' && COLOR.test(t.color))) ||
      ('library' in t && t.library !== true)
    )
      throw bad('Give each type a unique ID and a unique name of 1 to 60 characters');
    if ('alias' in t && !(typeof t.alias === 'string' && TYPE_REF.test(t.alias)))
      throw bad(`The alias of ${t.name} is another type of the document`);
    if (t.alias && (t.fields || []).length) throw bad(`${t.name} is an alias: it has no fields of its own`);
    if ('control' in t && !CONTROLS.includes(t.control)) throw bad(`The control of ${t.name} is one of ${CONTROLS.join(', ')}`);
    if (t.control && (t.fields || []).length) throw bad(`${t.name} has fields: only a type without fields can have a control`);
    if (t.control === 'select') {
      if (!Array.isArray(t.options) || !t.options.length || t.options.length > MAX_OPTIONS)
        throw bad(`${t.name} needs 1 to ${MAX_OPTIONS} options`);
      if (t.options.some((o, i) => typeof o !== 'string' || !o || o.length > MAX_OPTION || t.options.indexOf(o) !== i))
        throw bad(`The options of ${t.name} are different texts of 1 to ${MAX_OPTION} characters`);
    } else if ('options' in t) throw bad('Only a type with the select control has options');
    ids.add(t.id);
    names.add(t.name.toLowerCase());
    if (!Array.isArray(t.fields) || t.fields.length > MAX_FIELDS) throw bad(`A type has at most ${MAX_FIELDS} fields: ${t.name}`);
    const fields = new Set();
    for (const f of t.fields) {
      if (
        !isObject(f) ||
        Object.keys(f).some(k => !['name', 'type'].includes(k)) ||
        typeof f.name !== 'string' ||
        !f.name.trim() ||
        f.name.length > 60 ||
        fields.has(f.name) ||
        typeof f.type !== 'string'
      )
        throw bad(`Give each field of ${t.name} a unique name and a type (any for anything)`);
      fields.add(f.name);
    }
  }
  if (JSON.stringify(list).length > MAX_TYPE_DEFS_SIZE) throw bad('The types are too large');
  const table = new TypeTable(list);
  for (const t of list)
    if (!table.shape('t:' + t.id)) throw bad(`The type ${t.name} is made of an unknown type, or contains itself`);
}
