// Drawing: nodes, group frames, wires and the minimap.
'use strict';

// ----- rendering -----
/** Redraws at most once per frame: a pointer fires far more often than the screen refreshes.
 *  Work is kept per `key`, so a camera update and a drag update do not cancel each other. */
function onNextFrame(key, work) {
  if (!W.frameWork) return work();
  W.frameWork.set(key, work);
  if (W.frameHandle) return;
  W.frameHandle = requestAnimationFrame(() => {
    W.frameHandle = 0;
    const pending = [...W.frameWork.values()];
    W.frameWork.clear();
    for (const task of pending) task();
  });
}

function draw() {
  const nodes = visibleNodes(),
    container = $('#nodes'),
    alive = new Set(),
    focused = document.activeElement;
  // A folded node exposes only contacts that carry a visible wire or an interface binding.
  W.usedPorts = new Set();
  W.issues = new Map();
  for (const d of W.snapshot.diagnostics || []) W.issues.set(d.node_id, [...(W.issues.get(d.node_id) || []), d]);
  for (const edge of visibleEdges()) {
    W.usedPorts.add(`${edge.source}|out|${edge.source_port}`);
    W.usedPorts.add(`${edge.target}|in|${edge.target_port}`);
  }
  for (const group of W.snapshot.complex) {
    if (group.collapsed || W.hidden.groups.has(group.id)) continue;
    for (const [direction, dir] of [
      ['inputs', 'in'],
      ['outputs', 'out'],
    ])
      for (const p of group.interface[direction] || [])
        for (const b of p.bound ?? [])
          if (!W.hidden.nodes.has(b.node_id)) W.usedPorts.add(`${b.node_id}|${dir}|${b.port_id}`);
  }
  for (const node of nodes) {
    alive.add(node.id);
    const signature = JSON.stringify([
      node,
      W.results.get(node.id) || null,
      shownStatus(node),
      innerNodesOf(node).map(n => W.results.get(n.id) || null),
      widgetsSignature(node),
      W.issues.get(node.id) || [],
      node.folded ? foldedPorts(node).map(ports => ports.map(p => p.id)) : null,
    ]);
    let element = W.elements.get(node.id);
    if (!W.drag || !W.drag.ids?.has(node.id)) {
      const p = position(node);
      W.pos.set(node.id, {...(W.pos.get(node.id) || {}), ...p});
    }
    const typing = element?.contains(focused) && focused.matches('textarea,input:not([type=checkbox])');
    // Typing keeps the node as it is, except when a wire was added or removed: the value controls of
    // connected slots must go (and those of freed slots return) even while a field of the node has focus.
    const ports = JSON.stringify((node.inputs || []).map(p => [p.id, p.connected]));
    const rewired = element && element.dataset.ports !== ports;
    if (!element || (element.dataset.signature !== signature && (!typing || rewired))) {
      const focusLiteral = element?.contains(focused) ? focused.dataset.literal : null;
      const typed = typing ? {value: focused.value, start: focused.selectionStart, end: focused.selectionEnd} : null;
      const fresh = document.createElement('div');
      fresh.innerHTML = nodeHTML(node);
      const next = fresh.firstElementChild;
      // Keep a user's field resize when saving a value redraws this node.
      if (element)
        for (const area of $$('textarea[data-literal]', next)) {
          const previous = $(`textarea[data-literal="${CSS.escape(area.dataset.literal)}"]`, element);
          if (previous?.style.height) area.style.height = previous.style.height;
        }
      next.dataset.signature = signature;
      next.dataset.ports = ports;
      if (element) forgetFieldHeights(element);
      element ? element.replaceWith(next) : container.append(next);
      element = next;
      W.elements.set(node.id, element);
      W.nodeObserver?.observe(element);
      const refocused = focusLiteral ? $(`[data-literal="${CSS.escape(focusLiteral)}"]`, element) : null;
      refocused?.focus({preventScroll: true});
      if (refocused && typed) {
        refocused.value = typed.value;
        refocused.setSelectionRange?.(typed.start, typed.end);
        refocused.dispatchEvent(new Event('input'));
      }
    }
    restoreFieldHeights(element, node.id);
    element.classList.toggle('selected', W.selected.has(node.id));
    const p = W.pos.get(node.id);
    element.style.transform = `translate(${p.x}px,${p.y}px)`;
    const size =
      node.kind === 'complex' ? {width: node.compact_width, height: node.compact_height} : node.position || {};
    element.style.width = size.width ? size.width + 'px' : '';
    element.style.minHeight = size.height && !node.folded ? size.height + 'px' : '';
    if (node.folded) layoutFoldedPorts(element);
  }
  for (const [id, element] of W.elements)
    if (!alive.has(id)) {
      forgetFieldHeights(element);
      W.nodeObserver?.unobserve(element);
      element.remove();
      W.elements.delete(id);
    }
  // What a collapsed group hides has no element, but it keeps its place: the group moves it, and the group's header sits at its corner.
  for (const id of W.hidden.folded) {
    const node = W.nodes.get(id);
    if (!node || W.drag?.ids?.has(id)) continue;
    const size = node.kind === 'complex' ? {w: node.compact_width, h: node.compact_height} : {w: 240, h: 100};
    W.pos.set(id, {...size, ...(W.pos.get(id) || {}), ...position(node)});
  }
  measure();
  drawFrames();
  drawWires();
  drawMinimap();
  wireCodeEditors(container);
  drawSelectionTools();
  $('#canvas-empty').hidden = W.snapshot.nodes.length > 0 || W.snapshot.groups.length > 0;
}

function measure() {
  W.sockets.clear();
  for (const [id, element] of W.elements) {
    const p = W.pos.get(id);
    p.w = element.offsetWidth;
    p.h = element.offsetHeight;
    measureSockets(id, element);
  }
}

function measureSockets(id, element) {
  const origin = element.getBoundingClientRect(),
    zoom = W.camera?.zoom || 1;
  for (const socket of element.querySelectorAll('.sock')) {
    // A Reroute point is one dot: wires come in and leave from its centre (layout size, so hover scaling does not move them).
    if (element.classList.contains('reroute')) {
      W.sockets.set(`${id}|${socket.dataset.dir}|${socket.dataset.port}`, {
        dx: element.offsetWidth / 2,
        dy: element.offsetHeight / 2,
      });
      continue;
    }
    const r = socket.getBoundingClientRect();
    W.sockets.set(
      `${id}|${socket.dataset.dir}|${socket.dataset.port}${socket.dataset.face ? '|' + socket.dataset.face : ''}`,
      {dx: (r.left + r.width / 2 - origin.left) / zoom, dy: (r.top + r.height / 2 - origin.top) / zoom}
    );
  }
}
function measureFrames() {
  for (const frame of $$('.frame[data-complex]', W.canvas)) measureSockets('complex:' + frame.dataset.frame, frame);
}
const resizeHandles = () =>
  ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
    .map(dir => `<span class="resize-handle resize-${dir}" data-resize="${dir}" aria-hidden="true"></span>`)
    .join('');

/** Black or white, whichever reads better on `hex` (#RRGGBB or #RRGGBBAA). */
function inkOn(hex) {
  const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1,
    background = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  const [r, g, b] = [1, 3, 5].map(i => {
    const base = parseInt(background.slice(i, i + 2), 16) / 255,
      c = (parseInt(hex.slice(i, i + 2), 16) / 255) * alpha + base * (1 - alpha);
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (light + 0.05) > (light + 0.05) / 0.06 ? '#ffffff' : '#14171c';
}

/** The icon of a node type in the header (the same ones the Add menu shows). */
const NODE_GLYPHS = {custom: 'code'};

function foldedPorts(node) {
  return [
    ['inputs', 'in'],
    ['outputs', 'out'],
  ].map(([direction, dir]) => (node[direction] || []).filter(p => W.usedPorts?.has(`${node.id}|${dir}|${p.id}`)));
}

/** Contacts follow the rounded boundary rather than the rectangle around the capsule. */
function layoutFoldedPorts(element) {
  const w = element.offsetWidth,
    h = element.offsetHeight,
    radius = Math.min(72, h / 2, w / 2);
  for (const dir of ['in', 'out']) {
    const sockets = $$(`.folded-socket[data-dir=${dir}]`, element);
    sockets.forEach((socket, i) => {
      const y = (h * (i + 1)) / (sockets.length + 1);
      const curveY = y < radius ? radius - y : y > h - radius ? y - h + radius : 0;
      const inset = radius - Math.sqrt(Math.max(0, radius * radius - curveY * curveY));
      socket.style.left = (dir === 'in' ? inset : w - inset) - socket.offsetWidth / 2 + 'px';
      socket.style.top = y - socket.offsetHeight / 2 + 'px';
    });
  }
}

/** The state a node shows: while the run is paused, a node that was running shows paused (it finishes, nothing new starts). */
function shownStatus(node) {
  return ['running', 'sleeping', 'waiting'].includes(node.status) && W.runPaused ? 'paused' : node.status;
}

function nodeHTML(node) {
  const issues = W.issues.get(node.id) || [];
  const classes = [
    'node',
    'k-' + node.kind,
    's-' + (shownStatus(node) || 'ready'),
    node.node_type ? 't-' + node.node_type.replace('.', '-') : '',
    issues.length ? 'invalid' : '',
  ];
  const used = node.folded ? foldedPorts(node) : null;
  const styles = node.color ? [`--node-color:${esc(node.color)}`, `--node-ink:${inkOn(node.color)}`] : [];
  if (used) styles.push(`--fold-height:${Math.max(56, (Math.max(...used.map(ports => ports.length)) + 1) * 24)}px`);
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  if (node.color) classes.push('colored');
  if (node.disabled || node.muted) classes.push('off');
  const pin = node.pinned ? `<span class="pinned" title="Pinned">${icon('pin')}</span>` : '';
  // Status marks sit above the right edge; the fold button stays in the header.
  const fold = `<button class="icon fold" data-fold="${esc(node.id)}" title="${node.folded ? 'Expand' : 'Collapse'}" aria-label="${node.folded ? 'Expand node' : 'Collapse node'}" aria-expanded="${!node.folded}">${icon('chevron')}</button>`;
  const head = (title, glyph, extra = '') =>
    `<header>${extra}<span class="head-icon">${icon(glyph)}</span><span class="title" title="${esc(title)}">${esc(title)}</span>${fold}</header><div class="node-marks">${stateHTML}${node.disabled || node.muted ? `<span class="switched-off" title="${node.disabled ? 'Disabled' : 'Disabled by its group'}: a run skips this node">${icon('power')}</span>` : ''}${pin}</div>`;
  if (node.node_type === 'reroute')
    return `<div class="node reroute" data-id="${esc(node.id)}" title="Reroute point"><span class="sock" data-dir="in" data-port="in"></span><span class="sock" data-dir="out" data-port="out"></span></div>`;
  // The state of a node that runs, or has just run, appears above its right edge.
  const stateMark = {
      running: ['', 'Running code'],
      sleeping: [icon('timer'), 'Delay: waiting for the timer'],
      waiting: [icon('chevron'), 'Waiting for the downstream branch to finish'],
      paused: [icon('pause'), 'Paused: new code and continuations wait for Resume'],
      stopped: [icon('stop'), 'Stopped'],
      completed: [icon('check'), 'Completed'],
      failed: [icon('x'), 'Failed'],
      blocked: [icon('lock'), 'Blocked: permission denied'],
      skipped: [icon('skip'), 'Skipped: its flow was cancelled'],
    }[shownStatus(node)],
    stateHTML = stateMark
      ? `<span class="run-state ${shownStatus(node)}" role="img" aria-label="${stateMark[1]}" title="${stateMark[1]}">${stateMark[0]}</span>`
      : '';
  if (node.folded) {
    const sockets = used
      .map((ports, side) =>
        ports
          .map(
            p =>
              `<span class="sock folded-socket ${typeClass(p.type)}" data-dir="${side ? 'out' : 'in'}" data-port="${esc(p.id)}" title="${esc(portTitle(p))}" aria-label="${esc(portTitle(p))} (${side ? 'output' : 'input'})"></span>`
          )
          .join('')
      )
      .join('');
    const glyph = node.kind === 'complex' ? customIcon(node) || 'complex' : NODE_GLYPHS[node.node_type] || 'node';
    return `<div class="${classes.join(' ')} folded" data-id="${esc(node.id)}"${style} title="${esc(issues.map(i => i.message).join('\n'))}">${head(nodeLabel(node), glyph)}${sockets}</div>`;
  }
  const body = {
    function: () =>
      head(nodeLabel(node), NODE_GLYPHS[node.node_type] || 'node') +
      portsHTML(node) +
      eventHTML(node) +
      widgetsHTML(node) +
      inlineHTML(node),
    complex: () =>
      head(
        node.name,
        customIcon(node) || 'complex',
        node.locked
          ? ''
          : `<button class="icon expand" data-expand="${esc(node.group_id)}" title="Expand Complex Node" aria-label="Expand Complex Node">${icon('chevron')}</button>`
      ) +
      portsHTML(node) +
      widgetsHTML(node) +
      innerNodesOf(node).map(inlineHTML).join(''),
  }[node.kind];
  return `<div class="${classes.join(' ')}" data-id="${esc(node.id)}"${style} title="${esc(issues.map(i => i.message).join('\n'))}">${body ? body() : head(node.label || node.kind, 'node')}${node.pinned || node.folded ? '' : resizeHandles()}</div>`;
}

function portsHTML(node) {
  const issues = new Set((W.issues.get(node.id) || []).map(d => d.port_id)),
    fields = new Map(slotWidgets(node).map(w => [w.id.startsWith('out:') ? w.id : w.id.slice(3), w]));
  const inputs = (node.inputs || []).map(p => {
    const field = fields.get(p.id);
    return `<div class="port in ${typeClass(p.type)} ${p.connected ? 'connected' : ''} ${issues.has(p.id) ? 'invalid' : ''} ${field ? 'has-field' : ''}" title="${esc(portTitle(p))}"><span class="sock" data-dir="in" data-port="${esc(p.id)}"></span><span class="port-name">${esc(p.name)}</span>${field ? slotFieldHTML(field) : ''}</div>`;
  });
  const outputs = (node.outputs || []).map(p => {
    const field = fields.get('out:' + p.id);
    return `<div class="port out ${typeClass(p.type)} ${p.connected ? 'connected' : ''} ${field ? 'has-field' : ''}" title="${esc(portTitle(p))}">${field ? slotFieldHTML(field) : ''}<span class="port-name">${esc(p.name)}</span><span class="sock" data-dir="out" data-port="${esc(p.id)}"></span></div>`;
  });
  return `<div class="ports">${outputs.join('')}${inputs.join('')}</div>`;
}

/** The control of a free input, as a widget: its type says how it is typed in, its default is the value. An output that is `editable` has one too: its value is what the node outputs. */
function slotWidgets(node) {
  const out = [];
  const ports = [
    ...(node?.inputs || []).map(p => ['in:', p]),
    ...(node?.outputs || []).filter(p => p.editable).map(p => ['out:', p]),
  ];
  for (const [prefix, p] of ports) {
    const control = prefix === 'in:' && p.connected ? null : (W.types ?? NO_TYPES).control(p.type);
    if (!control) continue;
    const select = control.control === 'select';
    out.push({
      id: prefix + p.id,
      kind: control.control === 'code' ? 'textarea' : control.control,
      ...(control.control === 'code' ? {code: true} : {}),
      label: p.name,
      value: p.default ?? (select ? null : undefined),
      ...(select ? {options: [{value: null, label: '—'}, ...control.options]} : {}),
      ...(control.control === 'textarea' ? {rows: 2} : {}),
    });
  }
  return out;
}

/** A free input's control, in the row of its slot next to the slot's name (the name stays whether or not the slot is wired). */
function slotFieldHTML(w) {
  const attrs = `data-literal="${esc(w.id)}" aria-label="${esc(w.label)}"`;
  switch (w.kind) {
    case 'textarea':
      return w.code
        ? codeEditorHTML(w.value ?? '', `class="slot-field" ${attrs} rows="2"`)
        : `<textarea class="slot-field" ${attrs} rows="2">${esc(w.value ?? '')}</textarea>`;
    case 'checkbox':
      return `<input class="slot-field slot-check" type="checkbox" ${attrs} ${w.value === true ? 'checked' : ''}>`;
    case 'number':
      return `<input class="slot-field" type="number" ${attrs} step="any" value="${esc(w.value ?? '')}">`;
    case 'select':
      return `<select class="slot-field" ${attrs}>${w.options
        .map((o, i) => {
          const object = o !== null && typeof o === 'object',
            value = object ? o.value : o;
          return `<option value="${i}" ${JSON.stringify(value) === JSON.stringify(w.value) ? 'selected' : ''}>${esc(object ? (o.label ?? o.value) : o)}</option>`;
        })
        .join('')}</select>`;
    default:
      return `<input class="slot-field" type="text" ${attrs} value="${esc(w.value ?? '')}">`;
  }
}

/** A port's name for a tooltip: with its type, if it has one. */
const portTitle = p => (isAny(p.type) ? p.name : `${p.name}: ${typeLabel(p.type)}`);

/** The type a wire carries; a Reroute point has no type of its own, so it takes the one of the wire feeding it. */
function edgeType(edge) {
  for (let hops = 0; hops < 64; hops++) {
    const source = W.nodes.get(edge.source);
    if (source?.node_type !== 'reroute')
      return (source?.outputs || []).find(p => p.id === edge.source_port)?.type || '';
    const feeder = W.snapshot.edges.find(e => e.target === source.id);
    if (!feeder) return '';
    edge = feeder;
  }
  return '';
}
/** The colour of a port type for the minimap: the one the type has (none for no type). */
const typeColorOf = type => TYPE_COLORS.get(typeRefs(type)[0]) ?? '';

/** The nodes whose widgets a node shows: itself, or for a Library node placed on the canvas the nodes inside it that have some. */
const widgetHolders = node => (node.kind === 'complex' ? (node.widget_nodes ?? []) : [node.id]);
/** What a node's widgets look like in the node's signature: an html widget's value is not part of it (the frame would reload). */
const widgetsSignature = node =>
  widgetHolders(node).map(id =>
    (W.snapshot.widgets?.[id] ?? []).map(w => (w.kind === 'html' ? {...w, value: null} : w))
  );

/** One widget as a row of the node: its label and its control. A person's edits go through changeWidget. */
function widgetHTML(w) {
  const label = w.label ?? w.id,
    id = esc(w.id),
    // A widget without a label shows only its control.
    name = w.label ? `<span class="widget-label" title="${esc(label)}">${esc(label)}</span>` : '';
  const attrs = `data-literal="${id}" aria-label="${esc(label)}"`;
  switch (w.kind) {
    case 'textarea':
      return `<div class="widget wide">${name}<textarea ${attrs} rows="${w.rows ?? 3}" placeholder="${esc(w.placeholder ?? '')}">${esc(w.value ?? '')}</textarea></div>`;
    case 'markdown': {
      // Shows the rendered text; a double click (or Enter) opens the textarea, and leaving it shows the text again. An empty note opens as a textarea.
      const empty = !String(w.value ?? '').trim();
      return `<div class="widget wide md-widget">${name}<div class="md-view" data-md-view tabindex="0" title="Double-click to edit" ${empty ? 'hidden' : ''}>${renderMarkdown(w.value ?? '')}</div><textarea ${attrs} class="md-edit" rows="${w.rows ?? 6}" placeholder="${esc(w.placeholder ?? 'Markdown…')}" ${empty ? '' : 'hidden'}>${esc(w.value ?? '')}</textarea></div>`;
    }
    case 'checkbox':
      return `<div class="widget${name ? '' : ' bare'}">${name}<input type="checkbox" ${attrs} ${w.value === true ? 'checked' : ''}></div>`;
    case 'number':
      return `<div class="widget${name ? '' : ' bare'}">${name}<input type="number" ${attrs} step="${w.step ?? 'any'}" ${'min' in w ? `min="${w.min}"` : ''} ${'max' in w ? `max="${w.max}"` : ''} value="${esc(w.value ?? '')}"></div>`;
    case 'range':
      return `<div class="widget${name ? '' : ' bare'}">${name}<span class="range-row"><input type="range" ${attrs} step="${w.step ?? 1}" min="${w.min ?? 0}" max="${w.max ?? 100}" value="${esc(w.value ?? 0)}"><output>${esc(w.value ?? 0)}</output></span></div>`;
    case 'select': {
      const options = (w.options ?? []).map((o, i) => {
        const object = o !== null && typeof o === 'object',
          value = object ? o.value : o;
        return `<option value="${i}" ${JSON.stringify(value) === JSON.stringify(w.value) ? 'selected' : ''}>${esc(object ? (o.label ?? o.value) : o)}</option>`;
      });
      return `<div class="widget${name ? '' : ' bare'}">${name}<select ${attrs}>${options.join('')}</select></div>`;
    }
    case 'button':
      return `<div class="widget wide"><button type="button" data-widget-button="${id}" title="${esc(label)}">${esc(label)}</button></div>`;
    case 'label':
      return `<div class="widget wide"><span class="widget-text">${esc(w.text ?? w.label ?? '')}</span></div>`;
    case 'html':
      // A sandboxed frame without access to the page: its scripts can only post {value} to set the widget.
      return `<div class="widget wide"><iframe class="widget-html" sandbox="allow-scripts" data-widget-frame="${id}" style="height:${w.height ?? 120}px" srcdoc="${esc(w.html ?? '')}" title="${esc(label)}"></iframe></div>`;
    default:
      return `<div class="widget${name ? '' : ' bare'}">${name}<input type="text" ${attrs} placeholder="${esc(w.placeholder ?? '')}" value="${esc(w.value ?? '')}"></div>`;
  }
}

/** The widgets of a node (or, on a Library node placed on the canvas, of the nodes inside it), one block for each node that has some. */
function widgetsHTML(node) {
  return widgetHolders(node)
    .map(holder => {
      const list = W.snapshot.widgets?.[holder] ?? [];
      return list.length
        ? `<div class="widgets" data-widget-node="${esc(holder)}">${list.map(widgetHTML).join('')}</div>`
        : '';
    })
    .join('');
}

/** The Custom nodes inside a Library node placed on the canvas: what they display() shows on the placed node. */
function innerNodesOf(node) {
  if (node.kind !== 'complex' || !node.source) return [];
  const inside = new Set(node.members);
  return W.snapshot.nodes.filter(n => inside.has(n.id));
}

/** An Event node: the combobox that chooses the event it fires (its operation). */
function eventHTML(node) {
  const op = node.config?.op;
  if (node.node_type !== 'custom' || !EVENT_OPS.has(op) || node.config.inputs?.length) return '';
  const options = [...EVENT_OPS].map(o => `<option value="${o}" ${o === op ? 'selected' : ''}>${o}</option>`).join('');
  return `<div class="widgets"><div class="widget bare"><select data-event="${esc(node.id)}" aria-label="Event">${options}</select></div></div>`;
}

/** Under the slots of a Custom node: the text or image it showed with display() after a run. */
function inlineHTML(node) {
  if (node.node_type !== 'custom') return '';
  const config = node.config || {},
    shown = W.results.get(node.id);
  // Only what the node showed (an event node shows nothing).
  if (EVENT_OPS.has(config.op)) return '';
  return previewText(shown) !== '' ? previewHTML(shown) : '';
}

const FOLDED_GROUP_WIDTH = 240,
  FOLDED_GROUP_HEIGHT = 40;
function drawFrames() {
  const html = [],
    boxes = new Map();
  for (const id of [...W.pos.keys()]) if (id.startsWith('frame:')) W.pos.delete(id);
  const visible = W.snapshot.groups.filter(g => !W.hidden.groups.has(g.id));
  const rect = p => ({x: p.x, y: p.y, r: p.x + p.w, b: p.y + p.h});
  // Inner groups first, so a group can wrap the frames of the groups inside it.
  for (const group of [...visible].sort((a, b) => b.depth - a.depth)) {
    const cx = W.complex.get(group.id),
      content = [];
    if (group.folded && !cx) {
      // Collapsed: a bar at the corner of what the group holds.
      const corner = [group, ...descendantGroups(group.id)]
        .flatMap(g => g.members)
        .map(id => W.pos.get(id))
        .filter(p => p && 'x' in p);
      const x = corner.length ? Math.min(...corner.map(p => p.x)) - 20 : group.position?.x || 0,
        y = corner.length ? Math.min(...corner.map(p => p.y)) - 44 : group.position?.y || 0;
      boxes.set(group.id, {x, y, r: x + FOLDED_GROUP_WIDTH, b: y + FOLDED_GROUP_HEIGHT});
      continue;
    }
    for (const id of group.members) {
      const p = W.pos.get(id);
      if (p?.w && !W.hidden.nodes.has(id)) content.push(rect(p));
    }
    for (const child of group.children) {
      if (boxes.has(child)) content.push(boxes.get(child));
      else if (W.complex.get(child)?.collapsed && !W.hidden.nodes.has('complex:' + child)) {
        const p = W.pos.get('complex:' + child);
        if (p?.w) content.push(rect(p));
      }
    }
    const box = content.length
      ? {
          x: Math.min(...content.map(b => b.x)) - (cx?.inputs?.length ? 128 : 20),
          y: Math.min(...content.map(b => b.y)) - 44,
          r: Math.max(...content.map(b => b.r)) + (cx?.outputs?.length ? 128 : 20),
          b: Math.max(...content.map(b => b.b)) + 20,
        }
      : {
          x: group.position?.x || 0,
          y: group.position?.y || 0,
          r: (group.position?.x || 0) + 260,
          b: (group.position?.y || 0) + 140,
        };
    const saved = group.position;
    if (saved?.width && saved?.height) {
      box.x = Math.min(box.x, saved.x);
      box.y = Math.min(box.y, saved.y);
      box.r = Math.max(box.r, saved.x + saved.width);
      box.b = Math.max(box.b, saved.y + saved.height);
    }
    box.b = Math.max(box.b, box.y + 64 + Math.max(cx?.inputs?.length || 0, cx?.outputs?.length || 0) * 28);
    boxes.set(group.id, box);
  }
  for (const group of [...visible].sort((a, b) => a.depth - b.depth)) {
    const box = boxes.get(group.id),
      cx = W.complex.get(group.id);
    // A Complex Node's ports sit on its frame: the same dot takes an outside wire and an inside binding.
    const ports = !cx
      ? ''
      : ['inputs', 'outputs']
          .map(
            direction =>
              `<div class="frame-ports ${direction}">${(cx[direction] || [])
                .map(
                  p =>
                    `<div class="port ${direction === 'inputs' ? 'in' : 'out'} ${typeClass(p.type)} ${p.connected ? 'connected' : ''}" title="${esc(portTitle(p))}"><span class="sock external" data-dir="${direction === 'inputs' ? 'in' : 'out'}" data-port="${esc(p.id)}"></span><span class="port-name">${esc(p.name)}</span><span class="sock internal" data-face="internal" data-interface="${direction}" data-dir="${direction === 'inputs' ? 'out' : 'in'}" data-port="${esc(p.id)}" title="${direction === 'inputs' ? 'Connect to a port inside' : 'Connect a port inside'}"></span></div>`
                )
                .join('')}</div>`
          )
          .join('');
    const folded = !!group.folded && !cx,
      off = group.disabled || group.muted,
      foldButton = cx
        ? ''
        : `<button class="icon fold" data-fold-group="${esc(group.id)}" title="${folded ? 'Expand' : 'Collapse'}" aria-label="${folded ? 'Expand group' : 'Collapse group'}" aria-expanded="${!folded}">${icon('chevron')}</button>`,
      offMark = off
        ? `<span class="switched-off" title="${group.disabled ? 'Disabled' : 'Disabled by its group'}: a run skips everything in it">${icon('power')}</span>`
        : '';
    const collapse =
      cx && !W.library
        ? `<button class="icon collapse" data-collapse="${esc(group.id)}" title="Collapse into a node" aria-label="Collapse Complex Node">${icon('chevron')}</button>`
        : '';
    html.push(`<div class="frame ${group.color ? 'colored' : ''} ${cx ? 'complex' : ''} ${folded ? 'folded' : ''} ${off ? 'off' : ''} ${W.library && group.id === W.snapshot.root ? 'root' : ''} ${W.selected.has('frame:' + group.id) ? 'selected' : ''}" data-frame="${esc(group.id)}" data-id="${cx ? 'complex:' : 'group:'}${esc(group.id)}" ${cx ? 'data-complex="true"' : ''} style="transform:translate(${box.x}px,${box.y}px);width:${box.r - box.x}px;height:${box.b - box.y}px;${group.color ? `--node-color:${esc(group.color)};--node-ink:${inkOn(group.color)}` : ''}">
      <header data-frame-handle="${esc(group.id)}">${collapse}${cx ? icon((W.library && group.id === W.snapshot.root && libraryIcon()) || 'complex') : ''}<span class="title">${esc(group.name)}</span>${offMark}${group.pinned ? icon('pin') : ''}${foldButton}</header>${ports}${group.pinned || folded ? '' : resizeHandles()}</div>`);
    const bounds = {x: box.x, y: box.y, w: box.r - box.x, h: box.b - box.y};
    W.pos.set('frame:' + group.id, bounds);
    if (cx) W.pos.set('complex:' + group.id, bounds);
  }
  $('#frames').innerHTML = html.join('');
  measureFrames();
}

/** Wires as drawn: an end inside a collapsed Complex Node moves to the matching port on that node. */
function visibleEdges() {
  const collapsed = W.snapshot.complex.filter(c => c.collapsed).sort((a, b) => a.depth - b.depth);
  /** The ports (as text) a port of a node or Complex Node lands on once Complex Nodes are looked through. */
  const terminals = (id, port, direction) => {
    try {
      return Editor.resolveAll(W.nodeMap, id, port, direction).map(t => t.join('|'));
    } catch {
      return [];
    }
  };
  const result = [];
  // An end inside a collapsed group moves to the group's bar (the left edge for an input, the right for an output).
  const barOf = id => W.hidden.holders.get(id);
  for (const edge of W.snapshot.edges) {
    const next = {...edge, typed_by: edge};
    let hidden = false;
    const barSource = barOf(edge.source),
      barTarget = barOf(edge.target);
    if (barSource && barSource === barTarget) continue;
    if (barSource) next.source = 'frame:' + barSource;
    if (barTarget) next.target = 'frame:' + barTarget;
    const holder = side =>
      next[side].startsWith('frame:')
        ? null
        : collapsed.find(c => c.members.includes(edge[side]) && !W.hidden.nodes.has('complex:' + c.id));
    const inside = {source: holder('source'), target: holder('target')};
    if (inside.source && inside.source === inside.target) continue;
    for (const [side, direction] of [
      ['source', 'outputs'],
      ['target', 'inputs'],
    ]) {
      const cx = inside[side];
      if (!cx) continue;
      const mine = terminals(edge[side], edge[side + '_port'], direction)[0];
      const port = cx.interface[direction].find(p => terminals('complex:' + cx.id, p.id, direction).includes(mine));
      if (!port) {
        hidden = true;
        break;
      }
      next[side] = 'complex:' + cx.id;
      next[side + '_port'] = port.id;
    }
    if (!hidden) result.push(next);
  }
  return result;
}

function socketPoint(id, dir, port, face = '') {
  const p = W.pos.get(id);
  if (!p) return null;
  const key = `${id}|${dir}|${port}${face ? '|' + face : ''}`;
  const s = W.sockets.get(key);
  return s ? {x: p.x + s.dx, y: p.y + s.dy} : {x: p.x + (dir === 'in' ? 0 : p.w || 200), y: p.y + 20};
}

/** The shape of a wire from output `a` to input `b`, as chosen in Settings → Appearance → Graph Editor. */
function wirePath(a, b) {
  const {wire_style: shape, wire_curve: curve} = graphStyle;
  if (shape === 'linear') return `M${a.x},${a.y} L${b.x},${b.y}`;
  if (shape === 'step' || shape === 'rounded') return roundedPolyline(stepPoints(a, b), shape === 'rounded' ? 16 : 0);
  const dx = Math.max(40, Math.abs(b.x - a.x) * (curve / 100));
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/** Corners of a stepped wire: it leaves the output and enters the input horizontally; when the target is behind, it detours through the middle height. */
function stepPoints(a, b) {
  const stub = 24,
    x1 = a.x + stub,
    x2 = b.x - stub;
  return x2 >= x1
    ? [a, {x: (a.x + b.x) / 2, y: a.y}, {x: (a.x + b.x) / 2, y: b.y}, b]
    : [a, {x: x1, y: a.y}, {x: x1, y: (a.y + b.y) / 2}, {x: x2, y: (a.y + b.y) / 2}, {x: x2, y: b.y}, b];
}

/** The corners (or, for a curve, samples) of the wire from `a` to `b`, in the shape it is drawn in. */
function edgePoints(a, b, samples = 24) {
  const {wire_style: shape, wire_curve: curve} = graphStyle;
  if (shape === 'linear') return [a, b];
  if (shape === 'step' || shape === 'rounded') return stepPoints(a, b);
  const dx = Math.max(40, Math.abs(b.x - a.x) * (curve / 100)),
    points = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples,
      u = 1 - t;
    points.push({
      x: u ** 3 * a.x + 3 * u * u * t * (a.x + dx) + 3 * u * t * t * (b.x - dx) + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * b.y,
    });
  }
  return points;
}

/** A polyline whose corners are cut by up to `radius` (never more than half a segment) and rounded. */
function roundedPolyline(points, radius) {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]],
      back = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2),
      forward = Math.min(radius, Math.hypot(n.x - c.x, n.y - c.y) / 2),
      toward = (from, to, by) => {
        const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        return `${from.x + ((to.x - from.x) / length) * by},${from.y + ((to.y - from.y) / length) * by}`;
      };
    d += ` L${toward(c, p, back)} Q${c.x},${c.y} ${toward(c, n, forward)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

function drawWires(preview) {
  const svg = $('#wires'),
    paths = [],
    issues = new Set((W.snapshot.diagnostics || []).map(d => d.edge_id).filter(Boolean));
  // Every wire of a selected node (or group) is lit.
  const lit = new Set(W.selected);
  for (const id of W.selected)
    if (id.startsWith('frame:') && W.complex.has(id.slice(6))) lit.add('complex:' + id.slice(6));
  for (const edge of visibleEdges()) {
    if (!W.pos.has(edge.source) || !W.pos.has(edge.target)) continue;
    const a = socketPoint(edge.source, 'out', edge.source_port),
      b = socketPoint(edge.target, 'in', edge.target_port);
    if (!a || !b) continue;
    const d = wirePath(a, b);
    let cls = `wire k-${edge.kind} ${typeClass(edgeType(edge.typed_by || edge))}`;
    if (W.nodes.get(edge.source)?.status === 'completed') cls += ' satisfied';
    if (issues.has(edge.id)) cls += ' invalid';
    if (W.edges.has(edge.id)) cls += ' selected';
    else if (lit.has(edge.source) || lit.has(edge.target)) cls += ' related';
    paths.push(`<path class="hit" data-edge="${esc(edge.id)}" d="${d}"/><path class="${cls}" d="${d}"/>`);
  }
  for (const group of W.snapshot.complex.filter(c => !W.hidden.groups.has(c.id))) {
    if (group.collapsed) continue;
    for (const [direction, dir] of [
      ['inputs', 'in'],
      ['outputs', 'out'],
    ])
      for (const port of group.interface[direction] || [])
        for (const bound of port.bound ?? []) {
          if (!W.pos.has(bound.node_id) || W.hidden.nodes.has(bound.node_id)) continue;
          const a = socketPoint('complex:' + group.id, dir === 'in' ? 'out' : 'in', port.id, 'internal'),
            b = socketPoint(bound.node_id, dir, bound.port_id);
          if (a && b) {
            const path = dir === 'in' ? wirePath(a, b) : wirePath(b, a);
            paths.push(
              `<path class="hit" data-binding-group="${esc(group.id)}" data-binding-direction="${direction}" data-binding-port="${esc(port.id)}" data-binding-node="${esc(bound.node_id)}" data-binding-inner="${esc(bound.port_id)}" d="${path}"/><path class="wire interface-wire ${typeClass(port.type)}${lit.has('complex:' + group.id) || lit.has(bound.node_id) ? ' related' : ''}" d="${path}"/>`
            );
          }
        }
  }
  if (preview) paths.push(`<path class="wire preview" d="${wirePath(preview.a, preview.b)}"/>`);
  svg.innerHTML = paths.join('');
}

/** Folds the minimap away (the zoom controls stay) or brings it back; the choice is remembered. */
function setMinimapHidden(hidden, save = true) {
  const map = $('.map'),
    toggle = $('#map-toggle');
  map.classList.toggle('collapsed', hidden);
  toggle.title = hidden ? 'Show minimap' : 'Hide minimap';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!hidden));
  $('#minimap').inert = hidden;
  if (save) store.set('agentsys-minimap-hidden', hidden);
  if (!hidden) drawMinimap();
}

function drawMinimap() {
  const canvas = $('#minimap'),
    ctx = canvas.getContext('2d'),
    entries = [...W.pos.entries()].filter(([id]) => !id.startsWith('frame:') && W.elements.has(id)),
    boxes = entries.map(([, p]) => p);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if ($('.map')?.classList.contains('collapsed')) return;
  const view = viewRect();
  if (!boxes.length) return;
  const x0 = Math.min(...boxes.map(b => b.x)),
    y0 = Math.min(...boxes.map(b => b.y)),
    x1 = Math.max(...boxes.map(b => b.x + (b.w || 0))),
    y1 = Math.max(...boxes.map(b => b.y + (b.h || 0)));
  const scale = Math.min((canvas.width - 8) / (x1 - x0 || 1), (canvas.height - 8) / (y1 - y0 || 1));
  const map = W.mapDrag || {x0, y0, scale};
  W.minimap = map;
  const style = getComputedStyle(document.documentElement),
    muted = style.getPropertyValue('--idle').trim() || '#888',
    accent = style.getPropertyValue('--accent').trim() || '#fb4';
  // Each box wears its node's colour: the one chosen for it, the accent for notes and Complex Nodes, else neutral.
  const colorOf = id => {
    const node = W.nodes.get(id);
    return node?.color || (node && ['node', 'complex'].includes(node.kind) ? accent : muted);
  };
  // Wires first, in the colour of the type they carry.
  const point = ({x, y}) => [4 + (x - map.x0) * map.scale, 4 + (y - map.y0) * map.scale];
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.7;
  for (const edge of visibleEdges()) {
    const a = socketPoint(edge.source, 'out', edge.source_port),
      b = socketPoint(edge.target, 'in', edge.target_port);
    if (!a || !b || !W.pos.has(edge.source) || !W.pos.has(edge.target)) continue;
    ctx.strokeStyle = typeColorOf(edgeType(edge)) || muted;
    ctx.beginPath();
    ctx.moveTo(...point(a));
    ctx.lineTo(...point(b));
    ctx.stroke();
  }
  ctx.globalAlpha = 0.85;
  for (const [id, b] of entries) {
    ctx.fillStyle = colorOf(id);
    ctx.beginPath();
    ctx.roundRect(
      4 + (b.x - map.x0) * map.scale,
      4 + (b.y - map.y0) * map.scale,
      Math.max(3, (b.w || 200) * map.scale),
      Math.max(3, (b.h || 60) * map.scale),
      2
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    4 + (view.x - map.x0) * map.scale,
    4 + (view.y - map.y0) * map.scale,
    view.w * map.scale,
    view.h * map.scale
  );
}

/** The icon of the Custom Node being edited (its main group shows it). */
const libraryIcon = () => (app.resources || []).find(r => r.id === W.library)?.payload.icon || '';

/** The icon chosen for the Library Custom Node a placed node comes from. */
const customIcon = node => (app.resources || []).find(r => r.id === node.source?.resource_id)?.payload.icon || '';

// ----- the height of a text field is the person's: it is kept per workflow, so reopening shows it as it was left -----
const fieldHeightsKey = () => 'fieldHeights:' + W.workflow;
const fieldHeightContexts = new WeakMap();
function saveFieldHeight(area) {
  const context = fieldHeightContexts.get(area),
    height = Math.round(parseFloat(area.style.height));
  if (!context || !Number.isFinite(height) || height <= 0) return;
  const saved = store.get(context.storage, {});
  if (saved[context.key] === height) return;
  saved[context.key] = height;
  store.set(context.storage, saved);
}
const fieldHeightObserver = new ResizeObserver(entries => {
  for (const {target} of entries) saveFieldHeight(target);
});
function forgetFieldHeights(element) {
  for (const area of $$('textarea[data-literal]', element)) {
    saveFieldHeight(area);
    fieldHeightObserver.unobserve(area);
    fieldHeightContexts.delete(area);
  }
}
function restoreFieldHeights(element, nodeId) {
  const saved = store.get(fieldHeightsKey(), {});
  for (const area of $$('textarea[data-literal]', element)) {
    const height = saved[nodeId + '|' + area.dataset.literal];
    if (height && !area.style.height) area.style.height = height + 'px';
    if (!fieldHeightContexts.has(area)) {
      fieldHeightContexts.set(area, {storage: fieldHeightsKey(), key: nodeId + '|' + area.dataset.literal});
      fieldHeightObserver.observe(area);
    }
  }
}
// Native textarea resizing may release the pointer outside the field.
document.addEventListener(
  'pointerup',
  () => W.canvas && $$('textarea[data-literal]', W.canvas).forEach(saveFieldHeight),
  true
);
