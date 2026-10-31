// The right-hand panel: workflow settings, available Library nodes and selection properties.
'use strict';

const SWATCHES = [null, '#3b6ea8', '#3f8f6b', '#a8873b', '#a8513b', '#7c4ea8', '#5b6575'];
/** Changes when the selected thing was edited elsewhere (another tab, undo, a wire dropped on a port). */
const editSignature = sel =>
  JSON.stringify(
    sel &&
      (sel.kind === 'group'
        ? [sel.group.id, sel.group.name, sel.group.members, sel.group.children, W.complex.get(sel.group.id)]
        : [sel.node.id, sel.node.config, sel.node.text, (sel.node.inputs || []).map(p => p.connected)])
  );

// ----- The widgets a Custom Node declares, edited by hand (one card per widget) -----

/** The kinds a widget can have, as the list shows them. */
const WIDGET_KIND_NAMES = {
  text: 'Text',
  textarea: 'Text area',
  number: 'Number',
  range: 'Slider',
  checkbox: 'Checkbox',
  select: 'Select',
  button: 'Button',
  label: 'Label',
  html: 'HTML',
  markdown: 'Markdown',
};
/** What each kind has besides its ID and label (the keys of a widget: see checkWidgets). */
const WIDGET_KIND_FIELDS = {
  text: ['placeholder', 'value'],
  textarea: ['placeholder', 'rows', 'value'],
  number: ['value', 'min', 'max', 'step'],
  range: ['value', 'min', 'max', 'step'],
  checkbox: ['value'],
  select: ['options', 'value'],
  button: [],
  label: ['text'],
  html: ['html', 'height'],
  markdown: ['value'],
};
const WIDGET_FIELD_LABELS = {
  placeholder: 'Placeholder',
  rows: 'Rows',
  value: 'Default',
  min: 'Min',
  max: 'Max',
  step: 'Step',
  options: 'Options, one per line (value | label)',
  text: 'Text',
  html: 'HTML',
  height: 'Height',
};
const WIDGET_NUMBER_FIELDS = new Set(['rows', 'min', 'max', 'step', 'height']);

/** One option as a line of the Options field: `value`, or `value | label` when it has a label of its own. */
const optionLine = o =>
  o !== null && typeof o === 'object'
    ? o.label !== undefined && o.label !== o.value
      ? `${o.value} | ${o.label}`
      : String(o.value)
    : String(o);

/** One widget as an editable card: kind, ID, label and the fields of its kind. */
function widgetRowHTML(w) {
  const kind = WIDGET_KIND_FIELDS[w.kind] ? w.kind : 'text',
    attr = name => `data-wfield="${name}"`;
  const control = key => {
    const value = w[key];
    if (key === 'options') {
      const text = (w.options || []).map(optionLine).join('\n');
      return `<textarea ${attr(key)} rows="3" spellcheck="false" aria-label="${WIDGET_FIELD_LABELS[key]}" data-text="${esc(text)}" data-raw="${esc(JSON.stringify(w.options || []))}">${esc(text)}</textarea>`;
    }
    if (key === 'html') return codeEditorHTML(value ?? '', `${attr(key)} aria-label="HTML" rows="6"`, false);
    if (key === 'text' || (key === 'value' && (kind === 'textarea' || kind === 'markdown')))
      return `<textarea ${attr(key)} rows="3" aria-label="${WIDGET_FIELD_LABELS[key]}">${esc(value ?? '')}</textarea>`;
    if (key === 'value' && kind === 'checkbox')
      return `<label class="check small"><input ${attr(key)} type="checkbox" ${value === true ? 'checked' : ''}>on by default</label>`;
    const numeric = WIDGET_NUMBER_FIELDS.has(key) || (key === 'value' && (kind === 'number' || kind === 'range'));
    return `<input ${attr(key)} ${numeric ? 'type="number" step="any"' : ''} aria-label="${WIDGET_FIELD_LABELS[key]}" value="${esc(value ?? '')}">`;
  };
  const fields = WIDGET_KIND_FIELDS[kind]
    .map(key =>
      key === 'value' && kind === 'checkbox'
        ? `<div class="widget-field wide">${control(key)}</div>`
        : `<label class="widget-field${['options', 'text', 'html', 'placeholder'].includes(key) || (key === 'value' && ['textarea', 'markdown', 'text', 'select'].includes(kind)) ? ' wide' : ''}"><span>${WIDGET_FIELD_LABELS[key]}</span>${control(key)}</label>`
    )
    .join('');
  return `<div class="widget-row" data-widget-row>
    <div class="widget-head">
      <select ${attr('kind')} class="slot-type" aria-label="Kind">${Object.entries(WIDGET_KIND_NAMES)
        .map(([k, name]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${name}</option>`)
        .join('')}</select>
      <input ${attr('id')} class="slot-name" required maxlength="80" placeholder="id" aria-label="ID" value="${esc(w.id ?? '')}">
      <button type="button" class="icon slot-remove" data-remove-widget title="Remove" aria-label="Remove widget">${icon('x')}</button>
    </div>
    <input ${attr('label')} maxlength="500" placeholder="Label" aria-label="Label" value="${esc(w.label ?? '')}">
    ${fields ? `<div class="widget-fields">${fields}</div>` : ''}</div>`;
}

/** The widget a card describes (only what its kind has). */
function readWidgetRow(row) {
  const get = name => $(`[data-wfield="${name}"]`, row),
    kind = get('kind').value,
    widget = {id: get('id').value.trim(), kind},
    label = get('label').value;
  if (label) widget.label = label;
  for (const key of WIDGET_KIND_FIELDS[kind]) {
    const el = get(key);
    if (!el) continue;
    if (key === 'options') {
      if (el.value === el.dataset.text) widget.options = JSON.parse(el.dataset.raw);
      else
        widget.options = el.value
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => {
            const bar = line.indexOf(' | ');
            return bar < 0 ? line : {value: line.slice(0, bar).trim(), label: line.slice(bar + 3).trim()};
          });
      continue;
    }
    if (el.type === 'checkbox') {
      if (el.checked) widget[key] = true;
    } else if (el.value !== '') {
      if (el.type === 'number') {
        if (Number.isFinite(Number(el.value))) widget[key] = Number(el.value);
      } else widget[key] = el.value;
    }
  }
  return widget;
}

/** An ID for a new widget that no other card in `list` has. */
function newWidgetId(list, base) {
  const taken = new Set($$('[data-wfield=id]', list).map(i => i.value.trim()));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = base + n;
  return id;
}

const Inspector = {
  tab: 'properties',
  root: null,
  pending: null,

  // ───── Panel frame: mount, show/hide, tabs ─────

  mount(root) {
    this.availableOpen = new Map();
    this.workflowPolicySave = null;
    this.root = root;
    root.hidden = false;
    root.dataset.collapsed = String(sideHidden());
    root.innerHTML = `<nav class="side-tabs" aria-label="Canvas panel sections">${[
      ['workflow', 'Workflow settings', 'settings'],
      ['properties', 'Properties', 'node'],
    ]
      .map(
        ([id, label, glyph]) =>
          `<button class="icon ${this.tab === id && root.dataset.collapsed !== 'true' ? 'active' : ''}" data-side-tab="${id}" title="${label}" aria-label="${label}" aria-pressed="${this.tab === id && root.dataset.collapsed !== 'true'}">${icon(glyph)}</button>`
      )
      .join('')}
      </nav><div class="side-content"><div class="side-heading"><span id="side-heading"></span><button class="icon" data-side-close title="Close section" aria-label="Close section">${icon('x')}</button></div><div class="side-body" id="side-body"><section id="side-workflow" aria-label="Workflow"></section><section id="side-selection" aria-label="Selection"></section></div><footer class="side-actions" id="side-actions" hidden></footer></div>`;
    for (const type of ['input', 'change', 'click', 'focusout'])
      $('#side-body', root).addEventListener(type, event => {
        if (event.target.closest?.('#node-connections, .conn-host, .port-conn')) this.connHandlers?.[type]?.(event);
      });
    // Changing a slot's type recolours its dot.
    $('#side-body', root).addEventListener('change', event => {
      if (event.target.matches('[data-field=editable]')) {
        $('[data-slot-default]', event.target.closest('.port-row')).hidden = !event.target.checked;
        return;
      }
      if (!event.target.matches('[data-field=type]')) return;
      const row = event.target.closest('.port-row'),
        select = event.target,
        type = select.value;
      if (type === '__new') {
        // The new type is made in a dialog; the slot takes it once it is saved (and keeps its own type if the dialog is closed).
        select.value = select.dataset.prev ?? 'any';
        typeDialog(null, def => {
          for (const s of $$('select[data-field=type]', $('#side-body')))
            s.innerHTML = typeOptionsHTML(s.value, W.snapshot.types, {signal: true});
          select.value = 't:' + def.id;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        });
        return;
      }
      select.dataset.prev = type;
      $('.type-dot', row).className = 'type-dot ' + typeClass(type);
      const holder = $('[data-slot-default]', row),
        box = $('[data-editable-box]', row);
      if (holder) {
        holder.innerHTML = defaultControlHTML(type);
        wireCodeEditors(holder);
      }
      if (box) {
        const control = !!W.types.control(type);
        box.hidden = !control;
        if (!control) {
          $('input', box).checked = false;
          holder.hidden = true;
        }
      }
    });
    root.onclick = event => {
      const tab = event.target.closest('[data-side-tab]');
      // A section icon opens its section; closing is the job of the cross.
      if (tab && !(this.tab === tab.dataset.sideTab && root.dataset.collapsed !== 'true')) {
        this.tab = tab.dataset.sideTab;
        this.toggle(true);
      }
      if (event.target.closest('[data-side-close]')) this.toggle();
    };
    panelResize(root, {
      edge: 'left',
      key: 'agentsys-inspector-width',
      initial: 380,
      min: 280,
      max: Math.max(380, Math.min(760, innerWidth - 240)),
      setWidth: width => root.parentElement.style.setProperty('--side-width', width + 'px'),
      collapse: () => this.toggle(false),
      expand: () => this.toggle(true),
      isCollapsed: () => root.dataset.collapsed === 'true',
    });
  },

  /** Shows or hides the panel; `save` remembers the choice (a change of layout only follows the remembered one). */
  toggle(visible = this.root.dataset.collapsed === 'true', save = true) {
    this.root.dataset.collapsed = String(!visible);
    $$('[data-side-tab]', this.root).forEach(b => {
      const on = visible && b.dataset.sideTab === this.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (save) store.set(sideHiddenKey(), !visible);
    requestAnimationFrame(() => placeRailPill());
    if (visible) this.show();
    drawMinimap();
  },
  focus() {
    this.toggle(true);
    this.tab = 'properties';
    $$('[data-side-tab]', this.root).forEach(b => b.classList.toggle('active', b.dataset.sideTab === 'properties'));
    this.show();
    $('#side-body textarea, #side-body input')?.focus();
  },

  async leave() {
    await this.flushPermissions?.();
    this.flushPermissions = null;
    if (this.workflowPolicySave && !(await leaveAutosave(this.workflowPolicySave))) return false;
    await this.flushConnections?.();
    await this.pending?.();
    this.pending = null;
  },

  /** Where the selection (or the activity) is shown. */
  body() {
    return $('#side-selection');
  },

  // ───── Choosing what to show for the current selection ─────

  /** Re-render after a snapshot reload without losing in-progress typing. */
  refresh() {
    if (this.root.dataset.collapsed === 'true') return;
    if (this.tab === 'workflow') return this.workflow();
    // A completed permission save must not replace a radio during the next pointer click.
    if ($('#placed-grants, #script-grants', this.body())?.contains(document.activeElement)) {
      this.connections();
      return;
    }
    if (this.editing?.isConnected) {
      if (
        !this.editing.contains(document.activeElement) &&
        !this.pending?.isDirty?.() &&
        this.editSource !== editSignature(primarySelection())
      ) {
        this.editing = null;
        this.pending = null;
        this.show(true);
        return;
      }
      this.connections();
      return;
    }
    if ($('#side-body').contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) {
      this.connections();
      return;
    }
    if (this.tab === 'properties') this.show(true);
  },

  async show(soft = false) {
    if (!this.root || this.root.dataset.collapsed === 'true') return syncToolbar();
    syncToolbar();
    if (soft && this.editing?.isConnected) {
      this.connections();
      return;
    }
    if (!soft) {
      await this.flushPermissions?.();
      this.flushPermissions = null;
      await this.flushConnections?.();
      await this.workflowPolicySave?.();
    }
    const pending = this.pending;
    this.pending = null;
    if (!soft) await pending?.();
    this.editing = null;
    this.body().onclick = null;
    this.body().onchange = null;
    const footer = $('#side-actions', this.root);
    footer.replaceChildren();
    footer.hidden = true;
    $('#side-heading').textContent = {workflow: 'Workflow settings', properties: 'Properties'}[this.tab];
    $('#side-workflow').hidden = this.tab !== 'workflow';
    $('#side-selection').hidden = this.tab === 'workflow';
    if (this.tab === 'workflow') return this.workflow();
    if (this.tab === 'activity') return this.activity();
    const nodes = selectedNodes(),
      frames = selectedFrames();
    try {
      if (W.edges.size) return this.edge();
      if (nodes.length + frames.length > 1) return this.multiple(nodes, frames);
      const sel = primarySelection();
      if (!sel) return this.nothing();
      if (sel.kind === 'group') this.group(sel.group);
      else this.plain(sel.node);
      this.editSource = editSignature(sel);
      this.connections(
        sel.kind === 'group'
          ? sel.node || {id: 'frame:' + sel.group.id, kind: 'frame', group_id: sel.group.id, inputs: [], outputs: []}
          : sel.node
      );
      this.pinActions();
    } catch (error) {
      this.body().innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
    }
  },

  pinActions() {
    const actions = $('[data-node-actions]', this.body()),
      footer = $('#side-actions', this.root);
    if (!actions) return;
    // Keep each selection's handler with its controls after moving them out of the scrolling form.
    actions.onclick = actions.parentElement.onclick;
    footer.replaceChildren(actions);
    footer.hidden = false;
  },

  /** Nothing is selected. */
  nothing() {
    this.body().innerHTML = '<p class="muted small">Select a node or a group to edit its properties here.</p>';
  },

  /** Each workflow keeps its own opt-in set. Group checkboxes toggle all current descendants. */
  availableNodes(body) {
    const previous = (this.availableOpen ??= new Map()),
      items = (app.resources || []).filter(r => r.id !== W.library),
      available = new Set(W.snapshot.library_nodes ?? []),
      tree = {nodes: [], groups: new Map()};
    const levelAt = path => {
      let level = tree,
        parent = '';
      for (const part of path.split('/').filter(Boolean)) {
        parent = parent ? parent + '/' + part : part;
        if (!level.groups.has(part)) level.groups.set(part, {nodes: [], groups: new Map(), path: parent});
        level = level.groups.get(part);
      }
      return level;
    };
    for (const path of app.nodeFolders || []) levelAt(path);
    for (const item of items) levelAt(String(item.payload.folder || '')).nodes.push(item);
    const descendants = level => [...level.nodes, ...[...level.groups.values()].flatMap(descendants)];
    const render = level =>
      level.nodes
        .map(
          item =>
            `<label class="available-node check"><input type="checkbox" data-library-node="${esc(item.id)}" aria-label="Include node: ${esc(item.name)}" ${available.has(item.id) ? 'checked' : ''}>${icon(resourceIcon(item))}<span>${esc(item.name)}</span></label>`
        )
        .join('') +
      [...level.groups]
        .map(([name, sub]) => {
          const nodes = descendants(sub),
            count = nodes.filter(item => available.has(item.id)).length;
          return `<details class="available-group" data-library-folder="${esc(sub.path)}" ${previous.get(sub.path) === true ? 'open' : ''}><summary><label class="check"><input type="checkbox" data-library-group="${esc(sub.path)}" aria-label="Include group: ${esc(sub.path)}" ${nodes.length && count === nodes.length ? 'checked' : ''} ${count && count < nodes.length ? 'data-partial' : ''} ${nodes.length ? '' : 'disabled'}>${icon((app.nodeFolderIcons || {})[sub.path] || 'folder')}<span>${esc(name)}</span></label></summary><div class="available-group-items">${render(sub)}</div></details>`;
        })
        .join('');
    body.innerHTML = `<div class="available-nodes">${render(tree) || '<p class="muted small">No Library nodes yet.</p>'}</div>`;
    for (const box of $$('[data-partial]', body)) box.indeterminate = true;
    body.addEventListener(
      'toggle',
      event => {
        if (event.target.matches('.available-group'))
          previous.set(event.target.dataset.libraryFolder, event.target.open);
      },
      true
    );
    body.onchange = async event => {
      const box = event.target.closest('[data-library-node], [data-library-group]');
      if (!box) return;
      const project = W.project,
        workflow = W.workflow;
      const target = box.hasAttribute('data-library-node')
        ? {resource_id: box.dataset.libraryNode}
        : {folder: box.dataset.libraryGroup};
      for (const input of $$('input', body)) input.disabled = true;
      try {
        await api(`projects/${project}/available-nodes`, {
          method: 'PUT',
          body: {workflow_id: workflow, ...target, enabled: box.checked},
          edit: editToken(),
        });
        if (W.project === project && W.workflow === workflow) await reload();
      } catch (error) {
        if (W.project === project && W.workflow === workflow && this.tab === 'workflow') this.availableNodes(body);
        fail(error);
      }
    };
  },

  /** The Workflow section: its name, its types and problems. */
  workflow() {
    const issues = W.snapshot.diagnostics || [],
      host = $('#side-workflow');
    const existingPolicy = $('#workflow-policy, #library-permissions', host);
    if (existingPolicy && (existingPolicy.contains(document.activeElement) || this.workflowPolicySave?.isDirty()))
      return;
    const resource = W.library ? app.resources.find(item => item.id === W.library) : null;
    const opened = (this.workflowSections ??= new Set()),
      key = id => `${W.project}/${W.workflow}/${id}`,
      section = (id, title, glyph, note, content) =>
        `<details class="workflow-section" data-workflow-section="${id}" ${opened.has(key(id)) ? 'open' : ''}><summary>${icon(glyph)}<span><strong>${esc(title)}</strong><small>${esc(note)}</small></span>${icon('chevron')}</summary><div class="workflow-section-body">${content}</div></details>`;
    host.innerHTML = `<div class="workflow-heading"><h2>${esc(W.snapshot.workflow_name)}</h2><p class="muted small">${plural(W.snapshot.nodes.length, 'node')} · ${plural(W.snapshot.edges.length, 'connection')}</p></div>
      ${
        issues.length
          ? section(
              'problems',
              'Graph problems',
              'x',
              plural(issues.length, 'problem'),
              `<ul class="links">${issues
                .slice(0, 20)
                .map(i => `<li><button class="link" data-reveal="${esc(i.node_id)}">${esc(i.message)}</button></li>`)
                .join('')}</ul>`
            )
          : ''
      }
      ${section('execution', 'Execution', 'play', 'Signals, values and pause', `<div class="workflow-guide"><p><strong>Run</strong> signals every enabled on_run Event. Further signals use the same mechanism, including while other work is active.</p><p><strong>Pause</strong> keeps variables and outputs in memory. New code and continuations wait for Resume. Switching tabs keeps this execution.</p><p><strong>Stop</strong> cancels active work and keeps graph values. Graph edits affect the next node or emission; code already executing finishes its current invocation.</p><div class="execution-legend"><span>${icon('play')}Running code</span><span>${icon('timer')}Waiting for a timer</span><span>${icon('chevron')}Waiting for a branch</span></div><p class="muted">A Script emits its own <code>out</code> automatically after success. <code>await node.output.name.emit()</code> emits a signal from its code and waits for that branch. <code>context.state</code> is the shared JSON context saved with the workflow.</p></div>`)}
      ${section('available', 'Available nodes', 'package', plural(W.snapshot.library_nodes?.length ?? 0, 'Library node') + ' included in the Add menu', '<div data-available-nodes></div>')}
      ${W.library ? (resource ? section('permissions', 'Default permissions', 'lock', 'For new copies of this Library node', `<form id="library-permissions">${grantControls(resource.payload.grants ?? [], {title: 'Allowed operations', hint: 'Copied to new instances. Existing instances keep their own permissions.'})}</form>`) : '') : section('permissions', 'Project permissions', 'lock', 'Shared by every workflow in this project', `<form id="workflow-policy">${grantControls(W.policy.allow, {title: 'Allowed operations', hint: 'Nodes can only perform operations allowed by both the project and the node.'})}</form>`)}
      ${developerMode() ? section('types', 'Types', 'code', plural(W.snapshot.types.length, 'type'), this.typesSection()) : ''}`;
    for (const details of $$('[data-workflow-section]', host)) {
      const remember = open =>
        open ? opened.add(key(details.dataset.workflowSection)) : opened.delete(key(details.dataset.workflowSection));
      // The native toggle event is queued; remember a click before a reload can replace this section.
      $(':scope > summary', details).addEventListener('click', () => remember(!details.open));
      details.addEventListener('toggle', () => {
        if (details.isConnected) remember(details.open);
      });
    }
    this.wireReveal();
    this.wireTypes();
    const executionSection = $('[data-workflow-section=execution] .workflow-section-body', host);
    const history = Object.assign(document.createElement('button'), {type: 'button', textContent: 'Execution history'});
    history.onclick = () => showExecutionHistory().catch(fail);
    executionSection?.append(history);
    this.availableNodes($('[data-available-nodes]', host));
    const libraryForm = $('#library-permissions', host),
      resourceId = resource?.id;
    if (libraryForm) {
      this.workflowPolicySave = autoForm(
        libraryForm,
        () => ({
          grants: readGrantControls(libraryForm),
        }),
        async permissions => {
          const latest = await api(`resources/${resourceId}`);
          await api(`resources/${resourceId}`, {
            method: 'PUT',
            body: {
              name: latest.name,
              payload: {...latest.payload, ...permissions},
            },
          });
          await loadLibrary();
        }
      );
      return;
    }
    const form = $('#workflow-policy', host),
      project = W.project;
    this.workflowPolicySave = form
      ? autoForm(
          form,
          () => ({allow: readGrantControls(form)}),
          async body => {
            const policy = await api(`projects/${project}/policy`, {method: 'PUT', body});
            if (W.project === project) W.policy = policy;
          }
        )
      : null;
  },

  /** The types of the workflow: what they are made of, where they came from, and (in developer mode) how to change them. */
  typesSection() {
    const types = W.snapshot.types,
      dev = developerMode(),
      used = new Set(
        [
          ...W.snapshot.nodes.flatMap(n => [...(n.inputs || []), ...(n.outputs || [])]),
          ...W.snapshot.complex.flatMap(c => [...c.interface.inputs, ...c.interface.outputs]),
        ].flatMap(p => typeRefs(p.type))
      );
    if (!dev) return ''; // types look after themselves: only a developer sees them
    const inNode = String(W.project).startsWith('lib-'),
      row = t =>
        `<li class="type-item" data-type-id="${t.id}"><span class="type-dot t-r${t.id}" aria-hidden="true"></span><div><strong>${esc(t.name)}</strong>${t.library ? ' <small class="muted">Library</small>' : ''}<small class="muted block">${t.fields.map(f => `${esc(f.name)}: ${esc(typeLabel(f.type))}`).join(', ')}${esc(controlNote(t))}</small></div><span class="type-actions">${
          t.library && !inNode
            ? `<button type="button" class="icon" data-type-source title="A Library type: it is changed in the Custom Node that defines it" aria-label="Open the Custom Node">${icon('package')}</button>`
            : `<button type="button" class="icon" data-type-edit title="${t.library ? 'Edit: changes it for every Custom Node and workflow' : 'Edit'}" aria-label="Edit">${icon('pencil')}</button>`
        }${t.library ? '' : `<button type="button" class="icon" data-type-delete ${used.has(t.id) ? 'disabled title="In use"' : 'title="Delete"'} aria-label="Delete">${icon('trash')}</button>`}</span></li>`;
    return `${types.length ? `<ul class="type-list">${types.map(row).join('')}</ul>` : '<p class="muted small">No types yet. A type groups named fields. A type a Custom Node of the Library uses is available in every workflow; the others belong to this workflow.</p>'}${
      dev
        ? `<div class="button-row"><button type="button" class="dashed-action" data-type-new>${icon('plus')}New type</button></div>`
        : ''
    }`;
  },
  wireTypes() {
    const body = $('#side-workflow'),
      types = () => W.snapshot.types,
      saved = () => {
        reload().catch(() => {});
      };
    $('[data-type-new]', body)?.addEventListener('click', () => typeDialog(null, saved));
    for (const li of $$('.type-item', body)) {
      const type = types().find(t => t.id === li.dataset.typeId);
      $('[data-type-edit]', li)?.addEventListener('click', () => typeDialog(type, saved));
      $('[data-type-delete]', li)?.addEventListener('click', () =>
        confirmDialog(
          'Delete type',
          `Delete “${type.name}”?`,
          async () => {
            await putTypes(types().filter(t => t.id !== type.id));
            saved();
          },
          'Delete'
        )
      );
      $('[data-type-source]', li)?.addEventListener('click', () => {
        // The Custom Node that defines the type is where it is changed.
        const home = app.resources.find(r => r.payload.bundle?.types?.some(t => t.id === type.id));
        if (home) editInLibrary(home.id).catch(fail);
        else toast('No Custom Node of the Library defines this type any more.', true);
      });
    }
  },

  wireReveal() {
    for (const link of $$('[data-reveal]', $('#side-body'))) link.onclick = () => reveal(link.dataset.reveal);
  },

  edge() {
    const ids = [...W.edges].filter(id => W.snapshot.edges.some(e => e.id === id));
    if (!ids.length) return this.nothing();
    if (ids.length > 1) {
      this.body().innerHTML = `<h2>${plural(ids.length, 'connection')} selected</h2>
        <div class="button-row"><button id="split">${icon('plus')}Add reroute</button><button class="danger" id="disconnect">Disconnect</button></div>`;
      $('#split').onclick = () => splitEdges(ids).catch(fail);
      $('#disconnect').onclick = () => disconnectMany(ids).catch(fail);
      return;
    }
    const edge = W.snapshot.edges.find(e => e.id === ids[0]);
    const source = W.nodes.get(edge.source),
      target = W.nodes.get(edge.target);
    this.body().innerHTML = `<h2>Connection</h2><p><strong>${esc(nodeLabel(source || {}))}</strong> sends data to <strong>${esc(nodeLabel(target || {}))}</strong></p>
      <div class="button-row"><button id="split">${icon('plus')}Add reroute</button><button class="danger" id="disconnect">Disconnect</button></div>`;
    $('#split').onclick = () => splitEdges([edge.id]).catch(fail);
    $('#disconnect').onclick = () => disconnect(edge.id).catch(fail);
  },

  /** The title of a panel: the name of the item with a pencil beside it (`kind` is a small line above, what the item is). */
  nameHeading(current, kind = '') {
    return `${kind ? `<p class="muted small title-kind">${esc(kind)}</p>` : ''}<div class="title-row"><h2 id="node-title">${esc(current)}</h2><button type="button" class="icon" data-rename title="Rename" aria-label="Rename">${icon('pencil')}</button></div>`;
  },
  /** The pencil turns the title into a field; Enter or leaving it calls `save(name)`, Escape leaves the name as it was. */
  wireName(save) {
    const button = $('[data-rename]', this.body());
    if (!button) return;
    button.onclick = () => {
      const title = $('#node-title'),
        current = title.textContent,
        input = document.createElement('input');
      input.id = 'node-name';
      input.className = 'title-input';
      input.maxLength = 100;
      input.value = current;
      input.setAttribute('aria-label', 'Name');
      title.replaceWith(input);
      button.hidden = true;
      input.focus();
      input.select();
      let closed = false;
      const close = name => {
        if (closed) return;
        closed = true;
        const heading = document.createElement('h2');
        heading.id = 'node-title';
        heading.textContent = name;
        input.replaceWith(heading);
        button.hidden = false;
      };
      input.onkeydown = event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        }
        if (event.key === 'Escape') {
          input.value = current;
          input.blur();
        }
      };
      input.onblur = () => {
        const name = input.value.trim();
        if (!name || name === current) return close(current);
        close(name);
        save(name).catch(error => {
          const heading = $('#node-title');
          if (heading) heading.textContent = current;
          fail(error);
        });
      };
    };
  },

  /** A Custom node (a Script, an event node, a value holder): its name, slots and widgets. */
  customNode(node) {
    const config = node.config ?? {},
      libraryEditor = !!W.library;
    // The code of a Script is typed on the node itself, and its first signal input (what starts it) cannot be taken away: neither is a row here.
    const start = config.op === 'script' ? (config.inputs || []).find(p => isSignal(p.type)) : null;
    const code = (dir, p) => dir === 'inputs' && config.op === 'script' && (p.name === 'script' || p === start);
    const rows = dir =>
      (config[dir] || [])
        .filter(p => !code(dir, p))
        .map(p => portRow(p, false, dir))
        .join('');
    // A Script has no slots to edit: it reads and writes the inputs and outputs of the Library node it is in.
    const slots =
      config.op === 'script'
        ? ''
        : `
      <h3>Inputs</h3><div class="connection-grid" data-conn-extra="inputs"></div><div class="port-rows" data-direction="inputs">${rows('inputs')}</div>
      <button type="button" class="dashed-action" data-add="inputs">${icon('plus')}Add input</button>
      <h3>Outputs</h3><div class="connection-grid" data-conn-extra="outputs"></div><div class="port-rows" data-direction="outputs">${rows('outputs')}</div>
      <button type="button" class="dashed-action" data-add="outputs">${icon('plus')}Add output</button>`;
    this.body().innerHTML = `${this.nameHeading(nodeLabel(node))}<form id="node-form" class="stack">${slots}
      <h3>Widgets</h3><div class="widget-rows" data-widget-rows>${(W.snapshot.widgets?.[node.id] || []).map(widgetRowHTML).join('')}</div>
      <button type="button" class="dashed-action" data-add-widget>${icon('plus')}Add widget</button></form>`;
    if (config.op === 'script') {
      const panel = document.createElement('div');
      panel.id = 'script-grants';
      panel.className = 'stack';
      this.body().append(panel);
      const project = W.project,
        workflow_id = W.workflow;
      const permissionPath = `projects/${project}/node-permissions/${encodeURIComponent(node.id)}`;
      const showPermissions = detail => {
        if (!panel.isConnected) return;
        panel.innerHTML = `<h3>Permissions</h3>${detail.editable ? grantControls(detail.grants) : '<p class="muted small">Permissions come from the enclosing Custom Nodes.</p>'}<p class="small" data-effective-permissions>Effective: ${esc(detail.effective.join(', ') || 'none')}</p><details><summary>Permission constraints</summary><p class="small">Project: ${esc(detail.project_allow.join(', ') || 'none')}</p>${detail.layers.map((layer, i) => `<p class="small">Layer ${i + 1}: ${esc(layer.join(', ') || 'none')}</p>`).join('')}</details>`;
      };
      api(permissionPath, {query: {workflow_id}}).then(showPermissions).catch(fail);
      let permissionSave = Promise.resolve();
      panel.addEventListener('change', () => {
        const grants = readGrantControls(panel);
        permissionSave = permissionSave
          .catch(() => {})
          .then(async () => {
            const detail = await api(permissionPath, {method: 'PUT', body: {workflow_id, grants}});
            if (panel.isConnected)
              $('[data-effective-permissions]', panel).textContent =
                'Effective: ' + (detail.effective.join(', ') || 'none');
            await reload();
          });
        this.flushPermissions = () => permissionSave;
        permissionSave.catch(fail);
      });
      this.flushPermissions = () => permissionSave;
    }
    const form = $('#node-form');
    wireCodeEditors(form);
    this.wireName(async title => {
      await api(`projects/${W.project}/node-title`, {
        method: 'PUT',
        body: wf({node_id: node.id, title}),
        edit: editToken(),
      });
      await reload();
    });
    // A card of another kind has other fields: it is drawn again, keeping what the kinds share.
    form.addEventListener('change', event => {
      const kind = event.target.closest?.('[data-wfield=kind]');
      if (!kind) return;
      const row = kind.closest('[data-widget-row]'),
        old = readWidgetRow(row),
        {id, label} = old,
        keep = {id, kind: kind.value, ...(label ? {label} : {})};
      for (const key of WIDGET_KIND_FIELDS[kind.value])
        if (key in old && WIDGET_KIND_FIELDS[old.kind].includes(key) && key !== 'options' && key !== 'value')
          keep[key] = old[key];
      row.outerHTML = widgetRowHTML(keep);
      wireCodeEditors(form);
    });
    form.onclick = event => {
      const add = event.target.closest('[data-add]');
      if (add) {
        const dir = add.dataset.add,
          list = $(`[data-direction=${dir}]`, form),
          id = 'p' + Math.random().toString(36).slice(2, 7);
        list.insertAdjacentHTML(
          'beforeend',
          portRow(
            {
              id,
              name: slotName(
                list,
                dir === 'inputs' ? 'input' : 'output',
                (config[dir] || []).map(p => p.name)
              ),
            },
            false,
            dir
          )
        );
        this.pending.changed();
      }
      if (event.target.closest('[data-add-widget]')) {
        const list = $('[data-widget-rows]', form);
        list.insertAdjacentHTML('beforeend', widgetRowHTML({id: newWidgetId(list, 'text'), kind: 'text'}));
        $('[data-widget-row]:last-child [data-wfield=id]', list).focus();
        this.pending.changed();
      }
      const removeWidget = event.target.closest('[data-remove-widget]');
      if (removeWidget) {
        removeWidget.closest('[data-widget-row]').remove();
        this.pending.changed();
      }
      if (movePortRow(event.target)) this.pending.changed();
      const remove = event.target.closest('[data-remove-port]');
      if (remove) {
        remove.closest('.port-row').remove();
        this.pending.changed();
      }
    };
    this.editing = form;
    this.pending = autoForm(
      form,
      () => {
        const read = dir => {
          const list = $$(`[data-direction=${dir}] .port-row`, form)
              .map(readPortRow)
              .map(({bound, ...p}) => p),
            fixed = (config[dir] || []).map((p, i) => [i, p]).filter(([, p]) => code(dir, p));
          for (const [at, p] of fixed) list.splice(Math.min(at, list.length), 0, p);
          return list;
        };
        return {
          inputs: read('inputs'),
          outputs: read('outputs'),
          widgets: $$('[data-widget-row]', form).map(readWidgetRow),
        };
      },
      async data => {
        const edit = editToken(),
          path = `projects/${W.project}`;
        if (libraryEditor) {
          // In the editor of a Library node the widgets are part of the node's definition: every copy has them.
          const {widgets: _, ...rest} = config;
          await api(`${path}/typed-nodes/${encodeURIComponent(node.id)}`, {
            method: 'PUT',
            body: wf({
              node_type: 'custom',
              config: {
                ...rest,
                inputs: data.inputs,
                outputs: data.outputs,
                ...(data.widgets.length ? {widgets: data.widgets} : {}),
              },
            }),
            edit,
          });
        } else {
          await api(`${path}/node-slots/${encodeURIComponent(node.id)}`, {
            method: 'PUT',
            body: wf({inputs: data.inputs, outputs: data.outputs}),
            edit,
          });
          await api(`${path}/widgets/${encodeURIComponent(node.id)}`, {
            method: 'PUT',
            body: wf({widgets: data.widgets}),
            edit,
          });
        }
        await reload();
      }
    );
  },

  plain(node) {
    if (node.kind === 'function' && node.node_type === 'custom') return this.customNode(node);
    this.body().innerHTML = `<h2>${node.node_type === 'reroute' ? 'Reroute point' : esc(nodeLabel(node))}</h2>`;
    this.editing = null;
    this.pending = null;
  },

  multiple(nodes, frames) {
    this.body().innerHTML = `<h2>${plural(nodes.length + frames.length, 'item')} selected</h2>
      <div class="button-row" data-node-actions><button data-act="group">${icon('group')}Group</button><button class="danger" data-act="delete">${icon('trash')}Delete</button></div>`;
    this.body().onclick = event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      ({group: () => groupSelection(), delete: () => deleteSelection()})[act]?.().catch(fail);
    };
    this.pinActions();
  },

  // ───── One section per kind of selection (placed node, group) ─────

  /** A Complex Node placed on a canvas: its description, the slots of its definition (read-only) and the slots added on this workflow. */
  placed(group, cx) {
    const description = (app.resources || []).find(r => r.id === cx.source?.resource_id)?.payload.description || '';
    const own = dir => cx.interface[dir].filter(p => p.extra);
    const rows = dir =>
      own(dir)
        .map(({bound, extra, ...p}) => portRow(p, false, dir))
        .join('');
    // A Script of the node reads the slots added here by name: `node.input.name`.
    const section = dir =>
      `<div class="slot-section"><div class="conn-host" data-conn-host="${dir}"></div>${
        cx.arbitrary[dir]
          ? `<div class="port-rows" id="own-${dir}">${rows(dir)}</div><button type="button" class="dashed-action add-slot" data-add="${dir}">${icon('plus')}Add ${dir.slice(0, -1)}</button>`
          : ''
      }</div>`;
    const slots =
      cx.arbitrary.inputs || cx.arbitrary.outputs
        ? `<form id="own-slots" class="stack">${section('inputs')}${section('outputs')}</form>`
        : '';
    this.body().innerHTML = `${this.nameHeading(group.name)}<div class="stack" id="placed">${description ? `<p class="muted">${esc(description)}</p>` : ''}${slots}${cx.source ? `<div id="placed-grants">${grantControls(cx.grants ?? [])}</div>` : ''}
      <div class="button-row" data-node-actions>${cx.source && developerMode() ? `<button type="button" data-act="edit">${icon('pencil')}Edit graph</button>` : ''}<button type="button" class="danger" data-act="delete">${icon('trash')}Delete</button></div></div>`;
    this.wireName(async name => {
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
    $('#placed').onclick = event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') editInLibrary(cx.source.resource_id).catch(fail);
      if (act === 'delete') {
        W.selected = new Set(['complex:' + group.id]);
        deleteSelection().catch(fail);
      }
    };
    $('#placed-grants')?.addEventListener('change', () =>
      api(`projects/${W.project}/complex/${encodeURIComponent(group.id)}`, {
        method: 'PUT',
        body: wf({grants: readGrantControls($('#placed-grants'))}),
        edit: editToken(),
      })
        .then(() => reload())
        .catch(fail)
    );
    this.editing = null;
    this.pending = null;
    const form = $('#own-slots');
    if (!form) return;
    this.editing = form;
    form.onclick = event => {
      const add = event.target.closest('[data-add]')?.dataset.add;
      if (add) {
        const list = $(`#own-${add}`),
          id = 'x' + Math.random().toString(36).slice(2, 7);
        list.insertAdjacentHTML(
          'beforeend',
          portRow(
            {
              id,
              name: slotName(
                list,
                add === 'inputs' ? 'input' : 'output',
                cx.interface[add].map(p => p.name)
              ),
            },
            false,
            add
          )
        );
        this.pending.changed();
      }
      if (movePortRow(event.target)) this.pending.changed();
      if (event.target.closest('[data-remove-port]')) {
        event.target.closest('.port-row').remove();
        this.pending.changed();
      }
    };
    const read = dir =>
      $$(`#own-${dir} .port-row`, form)
        .map(readPortRow)
        .map(({bound, ...p}) => p);
    this.pending = autoForm(
      form,
      () => ({inputs: read('inputs'), outputs: read('outputs')}),
      async extra => {
        await api(`projects/${W.project}/complex/${encodeURIComponent(group.id)}`, {
          method: 'PUT',
          body: wf({extra}),
          edit: editToken(),
        });
        await reload();
      }
    );
  },

  group(group) {
    const cx = W.complex.get(group.id),
      main = isRoot(group.id),
      item = main ? (app.resources || []).find(r => r.id === W.library) : null;
    if (cx?.locked) return this.placed(group, cx);
    // Arbitrary: a node placed on a workflow may add inputs / outputs of its own (a Script of the node reads them with node.input.<name>).
    const heading = (title, dir) =>
      main
        ? `<h3 class="heading-check">${title}<label class="check small" title="A node placed on a workflow may add ${dir} of its own"><input type="checkbox" name="arbitrary_${dir}" ${cx.arbitrary?.[dir] ? 'checked' : ''}>Arbitrary</label></h3>`
        : `<h3>${title}</h3>`;
    const complexPart = cx
      ? `${heading('Inputs', 'inputs')}<div class="port-rows" data-direction="inputs">${(cx.interface.inputs || []).map(p => portRow(p, true, 'inputs')).join('')}</div>
      <button type="button" class="dashed-action" data-add="inputs">${icon('plus')}Add input</button>
      ${heading('Outputs', 'outputs')}<div class="port-rows" data-direction="outputs">${(cx.interface.outputs || []).map(p => portRow(p, true, 'outputs')).join('')}</div>
      <button type="button" class="dashed-action" data-add="outputs">${icon('plus')}Add output</button>
      `
      : ``;
    this.body().innerHTML = `${this.nameHeading(group.name, main ? '' : cx ? 'Complex Node' : 'Group')}<form id="group-form" class="stack"><input type="hidden" name="name" value="${esc(group.name)}">
      ${main ? field('Description', `<textarea name="description" rows="3" maxlength="2000" placeholder="What does this node do?">${esc(item?.payload.description || '')}</textarea>`) + field('Icon', iconGrid(item?.payload.icon, 'complex')) : ''}
      ${complexPart}
      ${main ? '' : `<div class="button-row" data-node-actions><button type="button" data-act="ungroup">${icon('ungroup')}Ungroup</button><button type="button" class="danger" data-act="delete">${icon('trash')}Delete with contents</button></div>`}</form>`;
    const form = $('#group-form');
    wireCodeEditors(form);
    // The name is saved with the rest of the form: the pencil sets the hidden field and the form saves it.
    this.wireName(async name => {
      form.name.value = name;
      form.dispatchEvent(new Event('change', {bubbles: true}));
    });
    form.onclick = event => {
      const add = event.target.closest('[data-add]');
      if (add) {
        const id = 'p' + Math.random().toString(36).slice(2, 7),
          list = $(`[data-direction=${add.dataset.add}]`, form);
        list.insertAdjacentHTML(
          'beforeend',
          portRow(
            {
              id,
              name: slotName(
                list,
                add.dataset.add === 'inputs' ? 'input' : 'output',
                add.dataset.add === 'outputs'
                  ? []
                  : $$('[data-direction=inputs] [data-field=name]', form).map(i => i.value)
              ),
            },
            true,
            add.dataset.add
          )
        );
        this.pending.changed();
      }
      if (movePortRow(event.target)) this.pending.changed();
      const remove = event.target.closest('[data-remove-port]');
      if (remove) {
        remove.closest('.port-row').remove();
        this.pending.changed();
      }
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'ungroup') {
        W.selected = new Set(['frame:' + group.id]);
        ungroupSelection().catch(fail);
      }
      if (act === 'delete')
        confirmDialog(
          'Delete group and contents?',
          `Everything inside “${group.name}” will be deleted. Undo restores it.`,
          async () => {
            await api(`projects/${W.project}/groups/${encodeURIComponent(group.id)}`, {
              method: 'DELETE',
              query: {workflow_id: W.workflow},
              edit: editToken(),
            });
            W.selected.clear();
            await reload();
            this.show();
          },
          'Delete'
        );
    };
    this.editing = form;
    this.pending = autoForm(
      form,
      () => {
        const members = group.members;
        const inside = [...members, ...(cx ? cx.members.filter(id => id.startsWith('complex:')) : [])];
        const read = direction =>
          $$(`[data-direction=${direction}] .port-row`, form)
            .map(readPortRow)
            .map(p => {
              if (!p.bound) return p;
              const {bound, ...rest} = p,
                kept = bound.filter(b => inside.includes(b.node_id));
              return kept.length ? {...rest, bound: kept} : rest;
            });
        return {
          name: form.name.value.trim(),
          members,
          ...(main ? {description: form.description.value, icon: form.icon.value} : {}),
          ...(cx ? {interface: {inputs: read('inputs'), outputs: read('outputs')}} : {}),
          ...(main
            ? {
                arbitrary: {
                  inputs: form.elements.arbitrary_inputs.checked,
                  outputs: form.elements.arbitrary_outputs.checked,
                },
              }
            : {}),
        };
      },
      async data => {
        const edit = editToken();
        if (data.name !== group.name || JSON.stringify(data.members) !== JSON.stringify(group.members)) {
          const position = g =>
            g.position ||
            (W.pos.get('frame:' + g.id) && {x: W.pos.get('frame:' + g.id).x, y: W.pos.get('frame:' + g.id).y});
          await saveGroups(
            W.snapshot.groups.map(g =>
              g.id === group.id
                ? {id: g.id, name: data.name, members: data.members, parent: g.parent, position: position(g)}
                : {
                    id: g.id,
                    name: g.name,
                    members: g.members.filter(id => !data.members.includes(id)),
                    parent: g.parent,
                    position: position(g),
                  }
            ),
            edit
          );
        }
        if (cx) {
          await api(`projects/${W.project}/complex/${encodeURIComponent(group.id)}`, {
            method: 'PUT',
            body: wf({interface: data.interface, arbitrary: data.arbitrary}),
            edit,
          });
        }
        if (
          main &&
          (data.description !== (item?.payload.description || '') || data.icon !== (item?.payload.icon || ''))
        ) {
          // description and icon belong to the Library item, not to the graph
          const saved = await api(`resources/${W.library}`);
          await api(`resources/${W.library}`, {
            method: 'PUT',
            body: {
              name: saved.name,
              payload: {
                ...saved.payload,
                description: data.description,
                icon: data.icon,
              },
            },
          });
          await loadLibrary();
          Tabs.setIcon(W.workflow, data.icon);
        }
        await reload();
        W.selected = new Set(['frame:' + group.id]);
        draw();
      }
    );
  },

  // ───── Inputs and Outputs: where each slot gets its value or sends it ─────
  // Every node shows the same Inputs / Outputs. Rows of a node's own slot editor (Custom nodes, groups) carry their
  // connection controls in a `.port-conn` holder; every other slot is listed in this section.

  connJobs: new Set(),

  connections(selected) {
    const node =
      selected ||
      primarySelection()?.node ||
      (selectedFrames()[0] && {
        id: 'frame:' + selectedFrames()[0].id,
        kind: 'frame',
        group_id: selectedFrames()[0].id,
        inputs: [],
        outputs: [],
      });
    if (!node || this.tab !== 'properties' || W.selected.size !== 1) return;
    const body = this.body(),
      existing = $('#node-connections'),
      active = document.activeElement;
    const typing =
      (existing?.contains(active) || $$('.conn-host, .port-conn', body).some(el => el.contains(active))) &&
      !active.matches('input[type=checkbox]');
    if (typing || this.connJobs.size) return;
    existing?.remove();
    const root = document.createElement('section');
    root.id = 'node-connections';
    const current = W.nodes.get(node.id) || node;
    const inbound = port => W.snapshot.edges.find(e => e.target === node.id && e.target_port === port.id);
    // A wired slot says where it is wired; each name is a link that selects that node on the canvas.
    const target = (id, port) => {
      const other = W.nodes.get(id);
      return other
        ? `<button type="button" class="link" data-reveal="${esc(id)}">${esc(nodeLabel(other))} › ${esc(port)}</button>`
        : '';
    };
    // The value of a free input whose type has a control is typed in right here (the rows of the slot editor have their own).
    const inputControls = (p, editable) => {
      if (!p.connected) return editable ? defaultControlHTML(p.type, p.default, 'data-input-value') : '';
      const edge = inbound(p),
        group = W.snapshot.complex.find(g =>
          (g.interface.inputs || []).some(b => (b.bound ?? []).some(x => x.node_id === node.id && x.port_id === p.id))
        );
      return edge
        ? target(edge.source, edge.source_port)
        : group
          ? `<button type="button" class="link" data-inspect-group="${esc(group.id)}">${esc(group.name)} (group input)</button>`
          : '';
    };
    const outputControls = (p, editable) =>
      (editable && p.editable ? defaultControlHTML(p.type, p.default, 'data-output-value') : '') +
      W.snapshot.edges
        .filter(e => e.source === node.id && e.source_port === p.id)
        .map(e => target(e.target, e.target_port))
        .join('');
    const controls = (dir, p, editable = false) =>
      dir === 'inputs' ? inputControls(p, editable) : outputControls(p, editable);
    // Rows that already exist in the slot editor of Script nodes and groups get their controls in place.
    const placed = {inputs: new Set(), outputs: new Set()};
    for (const holder of $$('.port-row .port-conn[data-conn-port]', body)) {
      const dir = holder.dataset.connDir,
        port = (current[dir] || []).find(p => p.id === holder.dataset.connPort);
      holder.innerHTML = port ? controls(dir, port) : '';
      wireCodeEditors(holder);
      placed[dir].add(holder.dataset.connPort);
    }
    // A placed node shows its own slots inside these sections (the host is in the slot form).
    const hosts = $$('[data-conn-host]', body);
    const cards = (ports, dir) =>
      ports
        .map(
          p =>
            `<div class="connection-port"><div class="connection-label">${typeDot(p.type)}<small>${esc(typeLabel(p.type))}</small><strong>${esc(p.name)}</strong></div><div class="port-conn" data-conn-port="${esc(p.id)}" data-conn-dir="${dir}">${controls(dir, p, true)}</div></div>`
        )
        .join('');
    const section = (title, dir) => {
      const ports = (current[dir] || []).filter(p => !placed[dir].has(p.id)),
        extra = $(`[data-conn-extra=${dir}]`, body);
      // A Script lists the slots it does not edit (what starts it, its code) under the heading of its own slot editor: one Inputs section.
      if (extra) {
        extra.innerHTML = cards(ports, dir);
        return '';
      }
      return ports.length || (hosts.length && $(`#own-${dir}`, body))
        ? `<h3>${title}</h3><div class="connection-grid">${cards(ports, dir)}</div>`
        : '';
    };
    const bindings = W.snapshot.complex.flatMap(group =>
      ['inputs', 'outputs'].flatMap(direction =>
        (group.interface[direction] || []).flatMap(p =>
          (p.bound ?? [])
            .filter(b => b.node_id === node.id)
            .map(
              b =>
                `<li><button type="button" class="link" data-inspect-group="${esc(group.id)}">${esc(group.name)} › ${esc(p.name)}</button><span class="muted small">${esc(direction === 'inputs' ? '→ ' + b.port_id : b.port_id + ' →')}</span></li>`
            )
        )
      )
    );
    const sections = {inputs: section('Inputs', 'inputs'), outputs: section('Outputs', 'outputs')};
    for (const host of hosts) host.innerHTML = sections[host.dataset.connHost];
    root.innerHTML = `${hosts.length ? '' : sections.inputs + sections.outputs}${bindings.length ? `<h4>Group bindings</h4><ul class="links">${bindings.join('')}</ul>` : ''}<small class="connection-status muted" role="status"></small>`;
    const tail = $('#placed-grants, #script-grants', body) || $('[data-node-actions]', body);
    if (tail) tail.before(root);
    else body.append(root);
    wireCodeEditors(body);
    this.flushConnections = () => Promise.resolve();
    this.connHandlers = {
      change: event => {
        const el = event.target.closest('[data-input-value], [data-output-value]'),
          port = el?.closest('[data-conn-port]')?.dataset.connPort;
        if (!el || !port) return;
        const value =
          el.type === 'checkbox'
            ? el.checked
              ? true
              : null
            : el.value === ''
              ? null
              : el.type === 'number'
                ? Number(el.value)
                : el.value;
        (el.matches('[data-output-value]') ? changeOutput : changeInput)(node.id, port, value).catch(fail);
      },
      focusout: () => requestAnimationFrame(() => this.connections()),
      click: event => {
        const group = event.target.closest('[data-inspect-group]'),
          link = event.target.closest('[data-reveal]');
        if (group) select([selectionIdOf(group.dataset.inspectGroup)]);
        if (link) reveal(link.dataset.reveal);
      },
    };
  },

  // ───── Activity tab (the last run) ─────
};

/** A name no slot of the list has yet (the names are variables of the code: each is its own): input, input2, input3… */
function slotName(list, base, others = []) {
  const taken = new Set([...others, ...$$('[data-field=name]', list).map(input => input.value)]);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = base + n;
  return name;
}

/** Moves the row of a clicked move button one place up or down among its neighbours; answers whether it moved one. */
function movePortRow(target) {
  const button = target.closest('[data-move-port]');
  if (!button) return false;
  const row = button.closest('.port-row'),
    other = button.dataset.movePort === '-1' ? row.previousElementSibling : row.nextElementSibling;
  if (other?.classList.contains('port-row'))
    other.insertAdjacentElement(button.dataset.movePort === '-1' ? 'beforebegin' : 'afterend', row);
  return true;
}

/** A small circle in the colour of a slot type (the same colours as the sockets on the canvas). */
const typeDot = type => `<span class="type-dot ${typeClass(type)}" aria-hidden="true"></span>`;

function portRow(port, group, dir = '') {
  // Fields use data-field rather than name, so they never shadow the form's own fields.
  // The port a group slot is bound to is set on the canvas (by wiring); the row only carries it along.
  const bound = port.bound ? ` data-bound="${esc(JSON.stringify(port.bound))}"` : '';
  return `<div class="port-row connection-port editable" data-id="${esc(port.id)}"${group ? ' data-group' : ''}${bound}>
    <div class="connection-label">${typeDot(port.type)}<select data-field="type" class="slot-type" aria-label="Type" data-prev="${esc(port.type ?? 'any')}">${typeOptionsHTML(port.type ?? 'any', W.snapshot.types, {signal: true})}</select><input data-field="name" class="slot-name" placeholder="name" value="${esc(port.name)}" aria-label="Name"></div>
    ${dir ? `<div class="slot-value">${dir === 'inputs' ? `<div class="slot-default" data-slot-default>${defaultControlHTML(port.type, port.default)}</div>` : outputValueHTML(port)}<div class="port-conn" data-conn-port="${esc(port.id)}" data-conn-dir="${dir}"></div></div>` : ''}
    <span class="slot-actions"><button type="button" class="icon slot-move up" data-move-port="-1" title="Move up" aria-label="Move up">${icon('chevron')}</button><button type="button" class="icon slot-move down" data-move-port="1" title="Move down" aria-label="Move down">${icon('chevron')}</button><button type="button" class="icon slot-remove" data-remove-port title="Remove" aria-label="Remove">${icon('x')}</button></span></div>`;
}

/** An output can show the control of its type on the node: the tick, and the value typed there (the output until the code sets another). */
function outputValueHTML(port) {
  const control = !!W.types.control(port.type),
    on = control && port.editable === true;
  return `<label class="check small" data-editable-box title="Show the control of the type on the node: what is typed there is the value of the output until the code sets another" ${control ? '' : 'hidden'}><input type="checkbox" data-field="editable" ${on ? 'checked' : ''}>Show control</label><div class="slot-default" data-slot-default ${on ? '' : 'hidden'}>${defaultControlHTML(port.type, port.default)}</div>`;
}

/** The field of the default value of an input: how its type says it is typed in (nothing for a type without a control). */
function defaultControlHTML(type, value, field = 'data-field="default"') {
  const control = W.types.control(type);
  if (!control) return '';
  const attrs = `${field} aria-label="Value" `;
  switch (control.control) {
    case 'textarea':
      return `<textarea ${attrs} rows="2" placeholder="value">${esc(value ?? '')}</textarea>`;
    case 'code':
      return codeEditorHTML(value ?? '', `${attrs} rows="2" placeholder="value"`);
    case 'number':
      return `<input ${attrs} type="number" step="any" placeholder="value" value="${esc(value ?? '')}">`;
    case 'checkbox':
      return `<label class="check small"><input ${attrs} type="checkbox" ${value === true ? 'checked' : ''}>on by default</label>`;
    case 'select':
      return `<select ${attrs}><option value="">none</option>${control.options.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    default:
      return `<input ${attrs} placeholder="value" value="${esc(value ?? '')}">`;
  }
}
/** What the default field of a slot row holds (undefined: none). */
function readDefault(row) {
  const el = $('[data-field=default]', row);
  if (!el) return undefined;
  if (el.type === 'checkbox') return el.checked ? true : undefined;
  if (el.value === '') return undefined;
  return el.type === 'number' ? Number(el.value) : el.value;
}

function readPortRow(row) {
  const port = {id: row.dataset.id, name: ($('[data-field=name]', row)?.value ?? '').trim()},
    type = $('[data-field=type]', row)?.value;
  if (type && type !== 'any') port.type = type;
  const box = $('[data-field=editable]', row),
    editable = !!box?.checked && !!port.type && !!W.types.control(port.type);
  const value = readDefault(row);
  if (editable) port.editable = true;
  if (value !== undefined && port.type && (!box || editable)) port.default = value;
  if (row.dataset.bound) port.bound = JSON.parse(row.dataset.bound);
  return port;
}

function tabIndent(area) {
  let released = false;
  area.addEventListener('blur', () => (released = false));
  area.addEventListener('keydown', event => {
    // Tab is indentation here, so Escape releases it: Escape then Tab moves on to the next control.
    if (event.key === 'Escape') released = true;
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || released) return;
    event.preventDefault();
    const {selectionStart: start, selectionEnd: end, value} = area;
    area.value = value.slice(0, start) + '  ' + value.slice(end);
    area.selectionStart = area.selectionEnd = start + 2;
    area.dispatchEvent(new Event('input'));
  });
}
