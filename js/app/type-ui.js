// Types in the interface: colours, the type selector of a slot, the type editor. The Library's types are every workflow's: any selector offers them next to the workflow's own.
// The only built-in type is “any”; what else is offered is what the workflow defines.
// The types themselves live in the document (js/model/types.js); the canvas keeps the resolved table in W.types.
'use strict';

/** The hue a type gets when nobody picked a colour: spread by its ID. */
const autoTypeColor = id => `hsl(${parseInt(id.slice(0, 6), 16) % 360} 58% 62%)`;
const TYPE_COLORS = new Map(); // type ID -> colour, for the canvas and the minimap

/** A class naming the colour of a type. None for any; a signal has its own look (see css/canvas.css). */
function typeClass(type) {
  if (isSignal(type)) return 'signal';
  const id = typeRefs(type)[0];
  if (!id) return '';
  return 't-r' + id;
}

/** Gives each type of the document its colour as a rule for its class (and remembers it for the minimap). */
function paintTypes(types) {
  TYPE_COLORS.clear();
  for (const t of types) TYPE_COLORS.set(t.id, t.color || autoTypeColor(t.id));
  let sheet = $('#type-colors');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'type-colors';
    document.head.append(sheet);
  }
  sheet.textContent = [...TYPE_COLORS].map(([id, color]) => `.t-r${id}{--tc:${color}}`).join('');
}

const typeLabel = (type, table = W.types ?? NO_TYPES) => table.label(type);

/** The options of a type selector: any, the Library's types and the workflow's own, and a way to make a new one. */
function typeOptionsHTML(selected, types, {create = true, skip = null, signal = false} = {}) {
  const mine = types.filter(t => t.id !== skip),
    group = (label, items) => (items.length ? `<optgroup label="${esc(label)}">${options(items, selected)}</optgroup>` : '');
  return (
    `<option value="any"${isAny(selected) ? ' selected' : ''}>any</option>` +
    (signal ? `<option value="signal"${isSignal(selected) ? ' selected' : ''}>signal</option>` : '') +
    group('Library', mine.filter(t => t.library).map(t => ['t:' + t.id, t.name])) +
    group('This workflow', mine.filter(t => !t.library).map(t => ['t:' + t.id, t.name])) +
    (create ? '<option value="__new">New type…</option>' : '')
  );
}

/** The type of the port an endpoint ({id, port, dir}) names on the canvas (none: no type). */
const endpointType = e => (W.nodes.get(e.id)?.[e.dir === 'out' ? 'outputs' : 'inputs'] || []).find(p => p.id === e.port)?.type || 'any';
/** Whether two endpoints (an output and an input, in either order) may be wired; a group's internal face is checked by the server. */
function endpointsFit(a, b) {
  const [out, input] = a.dir === 'out' ? [a, b] : [b, a];
  if (out.face === 'internal' || input.face === 'internal') return true;
  return compatible(endpointType(out), endpointType(input), W.types ?? NO_TYPES);
}

const putTypes = async list => {
  const result = await api(`projects/${W.project}/types`, {method: 'PUT', body: wf({types: list}), edit: editToken()});
  W.snapshot.types = result.types;
  W.types = new TypeTable(result.types);
  paintTypes(result.types);
  return result.types;
};

const CONTROL_LABELS = {text: 'Text', textarea: 'Long text', code: 'Code', number: 'Number', checkbox: 'Checkbox', select: 'Choice (enum)'};
/** What a type's control is, for its row in a list: `typed in as text`, or the options of an enum. */
const controlNote = (t, table = W.types ?? NO_TYPES) =>
  [
    t.alias ? `alias of ${table.label(t.alias)}` : '',
    !t.control ? '' : t.control === 'select' ? `enum: ${t.options.join(' | ')}` : `typed in as ${CONTROL_LABELS[t.control].toLowerCase()}`,
  ]
    .filter(Boolean)
    .join(', ');

/**
 * The type editor: a name, a colour and fields (each a name and a type). `done(typeDefinition)` runs after it was saved;
 * `current` is the type being edited (none for a new one). It is saved to the workflow; a Library type is saved to the Custom Node being
 * edited, which makes it the Library's for everybody.
 */
function typeDialog(current, done) {
  const types = W.snapshot.types,
    id = current?.id ?? uuid().replaceAll('-', ''),
    fieldRow = f =>
      `<div class="type-field" data-type-field><input data-name placeholder="field name" value="${esc(f.name)}" aria-label="Field name"><select data-type aria-label="Field type">${typeOptionsHTML(f.type, types, {create: false, skip: id})}</select><button type="button" class="icon" data-remove-field title="Remove field" aria-label="Remove field">${icon('x')}</button></div>`;
  const fields = current?.fields ?? [];
  dialog(
    current ? 'Edit type' : 'New type',
    `${field('Name', `<input name="name" maxlength="60" required autofocus value="${esc(current?.name ?? '')}">`)}
     ${field('Color', `<input type="color" name="color" value="${esc(toHex(current?.color || autoTypeColor(id)))}">`)}
     <div class="field" id="type-alias-part"><span>Alias of <small class="muted">(it means the same as that type, so the two fit each other; it keeps its own name, color and control)</small></span>
       <select name="alias" aria-label="Alias of"><option value="">None</option>${types.filter(t => t.id !== id).map(t => `<option value="t:${t.id}" ${current?.alias === 't:' + t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
     <div class="field" id="type-fields-part"><span>Fields <small class="muted">(none: a named kind, such as Text or Signal)</small></span><div class="type-fields" id="type-fields">${fields.map(fieldRow).join('')}</div>
     <button type="button" class="dashed-action" id="add-type-field">${icon('plus')} Add field</button></div>
     <div class="field" id="type-control-part"><span>Control <small class="muted">(how a free slot of this type is typed in on the node; the value is the default of the slot)</small></span>
       <select name="control" aria-label="Control"><option value="">None</option>${Object.entries(CONTROL_LABELS).map(([k, v]) => `<option value="${k}" ${current?.control === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
       <textarea name="options" rows="4" id="type-options" placeholder="One option per line" aria-label="Options">${esc((current?.options ?? []).join('\n'))}</textarea></div>`,
    async form => {
      const next = {
        id,
        ...(current?.library ? {library: true} : {}),
        name: form.elements.name.value.trim(),
        color: form.elements.color.value,
        fields: form.elements.alias.value ? [] : $$('[data-type-field]', form).map(row => ({name: $('[data-name]', row).value.trim(), type: $('[data-type]', row).value})),
        ...(form.elements.alias.value ? {alias: form.elements.alias.value} : {}),
        ...(form.elements.control.value && (form.elements.alias.value || !$$('[data-type-field]', form).length)
          ? {
              control: form.elements.control.value,
              ...(form.elements.control.value === 'select'
                ? {options: [...new Set(form.elements.options.value.split('\n').map(o => o.trim()).filter(Boolean))]}
                : {}),
            }
          : {}),
      };
      const list = current ? types.map(t => (t.id === id ? next : t)) : [...types, next];
      await putTypes(list);
      await done?.(next);
      reload().catch(() => {});
    }
  );
  const form = $('#modal-form'),
    // A type with fields is a record: only a type without fields has a control or is an alias; an alias has no fields.
    sync = () => {
      const records = !!$$('[data-type-field]', form).length;
      $('#type-alias-part').hidden = records;
      $('#type-fields-part').hidden = !!form.elements.alias.value;
      $('#type-control-part').hidden = records;
      $('#type-options').hidden = form.elements.control.value !== 'select';
    };
  form.onclick = event => {
    if (event.target.closest('#add-type-field'))
      $('#type-fields').insertAdjacentHTML('beforeend', fieldRow({name: '', type: 'any'}));
    else event.target.closest('[data-remove-field]')?.closest('[data-type-field]').remove();
    sync();
  };
  form.addEventListener('change', sync);
  sync();
}

/** A colour as the #rrggbb an <input type=color> wants (types may carry any CSS colour). */
function toHex(color) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = color;
  return probe.fillStyle.startsWith('#') ? probe.fillStyle : '#7aa2f7';
}
