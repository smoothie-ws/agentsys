// Every change to a workflow document goes through the Editor class: nodes, wires, groups, Complex Nodes,
// clipboard (copy/paste), Library node placement and refresh. Methods throw ApiError on invalid input and may leave
// the document half-edited; the caller (backend/runtime.js) discards it then.
'use strict';

const COPYABLE = new Set(['kind', 'node_type', 'config', 'label', 'status']);
/** A slot as it is stored on a node: the type is there only when it is not any. */
const slotOf = ({id, name, type, default: value, editable}) => ({
  id,
  name,
  ...(isAny(type) ? {} : {type}),
  ...(value === undefined || isAny(type) ? {} : {default: value}),
  ...(editable === true && !isAny(type) ? {editable: true} : {}),
});
const validPoint = point => isObject(point) && finite(point.x) && finite(point.y);
const validStyle = (pinned, color) =>
  typeof pinned === 'boolean' && (color == null || (typeof color === 'string' && COLOR.test(color)));

/** All edits of one workflow document. Methods throw ApiError and may leave the document half-edited; the caller discards it then. */
class Editor {
  constructor(project, workflow, doc) {
    this.project = project;
    this.workflow = workflow;
    this.doc = doc;
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Reading: snapshot, selection, layout and styles в”Ђв”Ђв”Ђв”Ђв”Ђ

  /** `structure`: nodes, groups and Complex Nodes only, without ports, wires and diagnostics (see buildSnapshot). */
  snapshot(structure = false) {
    return buildSnapshot(this.project, this.workflow, this.doc, structure);
  }
  static nodeMap(snapshot) {
    return new Map(
      [
        ...snapshot.nodes,
        ...snapshot.groups.map(g => ({...g, id: 'group:' + g.id, kind: 'group', inputs: [], outputs: []})),
        ...snapshot.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'})),
      ].map(n => [n.id, n])
    );
  }
  /** Follows Complex Node ports down to the node ports they are bound to: [[node ID, port ID], ...] (an unbound port stays on the wrapper; only an input is bound to several). */
  static resolveAll(nodes, nodeId, portId, direction, seen = new Set()) {
    const address = key(nodeId, portId);
    if (seen.has(address)) throw bad('Cyclic interface binding');
    const node = nodes.get(nodeId);
    if (node.kind !== 'complex') return [[nodeId, portId]];
    const item = node.interface[direction].find(p => p.id === portId);
    if (!item) throw bad('Complex Node port not found');
    if (!item.bound?.length) return [[nodeId, portId]];
    return item.bound.flatMap(b =>
      Editor.resolveAll(nodes, b.node_id, b.port_id, direction, new Set(seen).add(address))
    );
  }
  /** The first port a Complex Node port is bound to (the only one of an output). */
  static resolve(nodes, nodeId, portId, direction) {
    return Editor.resolveAll(nodes, nodeId, portId, direction)[0];
  }
  /** The types of this document, resolved. */
  typeTable() {
    return new TypeTable(this.doc.types);
  }

  /** Every port the document has, with the node or Complex Node it belongs to: the places a type is used. */
  allPorts() {
    return [
      ...this.doc.nodes.flatMap(n => [...(n.config?.inputs ?? []), ...(n.config?.outputs ?? [])]),
      ...this.doc.complex.flatMap(c => [...c.interface.inputs, ...c.interface.outputs]),
    ];
  }

  /**
   * Replaces the types of this workflow (`list` holds the Library's too, unchanged: those are changed in a Custom Node, `library`). A type that ports
   * still use cannot go (nor become meaningless); wires, values and bindings that no longer fit the changed types are dropped.
   */
  setTypes(list, {library = false} = {}) {
    checkTypes(list);
    const canon = t =>
        t &&
        JSON.stringify([
          t.id,
          t.name,
          t.color ?? null,
          t.fields,
          t.control ?? null,
          t.options ?? null,
          t.alias ?? null,
        ]),
      mine = (this.doc.types ?? []).filter(t => t.library),
      now = list.filter(t => t.library);
    // A Library type is changed where it is defined: in the Custom Node that uses it (and it stays while a node does).
    if (
      mine.length !== now.length ||
      mine.some(t => !now.some(x => x.id === t.id)) ||
      (!library && mine.some(t => canon(t) !== canon(now.find(x => x.id === t.id))))
    )
      throw bad('A Library type is changed in a Custom Node of the Library');
    const table = new TypeTable(list),
      gone = this.allPorts().find(p => p.type && !table.shape(p.type));
    if (gone) throw bad(`The type ${this.typeTable().label(gone.type)} is in use`);
    this.doc.types = clone(list);
    this.pruneAll();
    return this.doc.types;
  }

  /**
   * Brings the types of a bundle into this workflow. A type is told by what it is: the workflow has it already when it has one with that ID
   * (a Library type is the Library's, whatever the bundle says of it) or one with that name and shape; otherwise it is added as a type of
   * the workflow's own (under a new ID or name if these are taken). Answers old ID -> ID here.
   */
  mergeTypes(incoming) {
    const list = incoming ?? [];
    checkTypes(list);
    const mine = clone(this.doc.types ?? []),
      byId = new Map(list.map(t => [t.id, t])),
      map = new Map(),
      done = new Set();
    const shapeOf = m => JSON.stringify([m.fields, controlOf(m)]);
    const nameFor = base => {
      const taken = new Set(mine.map(m => m.name.toLowerCase()));
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 50)} (${n})`;
      return name;
    };
    const settle = t => {
      if (done.has(t.id)) return;
      done.add(t.id);
      for (const ref of refsOf(t)) settle(byId.get(ref));
      const fields = t.fields.map(f => ({name: f.name, type: renameTypeRefs(f.type, map)})),
        extra = controlOf({...t, alias: t.alias && renameTypeRefs(t.alias, map)}),
        shape = JSON.stringify([fields, extra]);
      const home = mine.find(m => m.id === t.id);
      if (home?.library || (home && home.name === t.name && shapeOf(home) === shape)) return;
      const twin = mine.find(m => m.name.toLowerCase() === t.name.toLowerCase() && shapeOf(m) === shape);
      if (twin) return void map.set(t.id, twin.id);
      const id = home ? uid() : t.id;
      mine.push({id, name: nameFor(t.name), ...(t.color ? {color: t.color} : {}), fields, ...extra});
      if (id !== t.id) map.set(t.id, id);
    };
    for (const t of list) settle(t);
    checkTypes(mine);
    this.doc.types = mine;
    return map;
  }
  selection(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(i => typeof i !== 'string'))
      throw bad('Select nodes in the current graph');
    const nodes = new Map(this.snapshot(true).nodes.map(n => [n.id, n]));
    if (ids.some(i => !nodes.has(i))) throw bad('Select nodes in the current graph');
    return [...new Set(ids)].map(i => nodes.get(i));
  }
  /** Forgets the widgets of the nodes `predicate` picks (by node ID). */
  dropWidgets(predicate) {
    for (const id of Object.keys(this.doc.widgets)) if (predicate(id)) delete this.doc.widgets[id];
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Layout and style в”Ђв”Ђв”Ђв”Ђв”Ђ

  saveLayout(positions) {
    if (!isObject(positions) || !Object.keys(positions).length || Object.keys(positions).length > 1000)
      throw bad('Provide 1 to 1000 node positions');
    const snap = this.snapshot(true),
      nodes = Editor.nodeMap(snap);
    const pinnedMembers = new Set(snap.groups.filter(g => g.pinned).flatMap(g => g.all_members));
    for (const [nid, position] of Object.entries(positions)) {
      const node = nodes.get(nid);
      if (!node || !isObject(position)) throw bad('Layout nodes must belong to the current project graph');
      if (!finite(position.x) || !finite(position.y)) throw bad('Coordinates must be finite numbers');
      const current = node.position || {};
      const dims = ['width', 'height'].map(k => position[k] ?? current[k] ?? null);
      if (dims.some(v => v !== null && (!finite(v) || v < 64 || v > 4000)))
        throw bad('Dimensions must be finite numbers between 64 and 4000');
      if (
        (node.pinned || pinnedMembers.has(nid)) &&
        [
          ['x', position.x],
          ['y', position.y],
          ['width', dims[0]],
          ['height', dims[1]],
        ].some(([k, v]) => (current[k] ?? null) !== v)
      )
        throw new ApiError('node_pinned', 'Unpin the node before moving it', 409);
      const entry = {x: position.x, y: position.y};
      if (dims[0] !== null) entry.width = dims[0];
      if (dims[1] !== null) entry.height = dims[1];
      this.doc.layout[nid] = entry;
    }
    return {saved: true};
  }

  nodeStyle(body) {
    const groupId = body.group_id,
      isGroup = typeof groupId === 'string';
    const nid = isGroup ? 'group:' + groupId : body.node_id;
    if (typeof nid !== 'string') throw bad('Select a node');
    const snap = this.snapshot(true);
    const node = isGroup ? snap.groups.find(g => g.id === groupId) : snap.nodes.find(n => n.id === nid);
    if (!node) throw missing('Node not found in this project');
    const pinned = body.pinned ?? node.pinned,
      folded = body.folded ?? !!node.folded,
      disabled = body.disabled ?? !!node.disabled,
      color = 'color' in body ? body.color : node.color;
    if (!validStyle(pinned, color) || typeof folded !== 'boolean' || typeof disabled !== 'boolean')
      throw bad('Provide a boolean pin, fold and disabled and a #RRGGBB or #RRGGBBAA color or null');
    if (isGroup && pinned && snap.nodes.some(n => node.all_members.includes(n.id) && !n.position))
      throw bad('Save group member positions before pinning');
    if (!isGroup && pinned && !node.position) {
      if (!('position' in body)) throw bad('Save a position before pinning this node');
      this.saveLayout({[nid]: body.position});
    }
    this.doc.style[nid] = {
      pinned,
      color: color ? color.toLowerCase() : null,
      ...(folded ? {folded} : {}),
      ...(disabled ? {disabled} : {}),
    };
    return {saved: true, pinned, folded, disabled, color: color ? color.toLowerCase() : null};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Nodes в”Ђв”Ђв”Ђв”Ђв”Ђ

  /** The name of a Custom node on this workflow (what it is called on the canvas): its title, which belongs to this copy only. */
  renameNode(nodeId, title) {
    const node = this.doc.nodes.find(n => n.id === nodeId);
    if (!node || node.node_type !== 'custom') throw missing('Node not found in this project');
    if (typeof title !== 'string' || !title.trim() || title.length > 100)
      throw bad('A name is text of 1 to 100 characters');
    node.config = {...node.config, title: title.trim()};
    return {saved: true, title: node.config.title};
  }

  addRecord(record) {
    if (this.doc.nodes.some(n => n.id === record.id)) throw bad('Node ID already exists');
    this.doc.nodes.push(record);
    return record.id;
  }

  saveNode(body, nodeId = null) {
    const type = body.node_type;
    if (!Object.hasOwn(DEFINITIONS, type) || !isObject(body.config ?? {})) throw bad('Choose a supported node type');
    const config = {...clone(DEFINITIONS[type].defaults), ...(body.config || {})};
    if (type === 'custom') validateCustomConfig(config, this.typeTable());
    if (JSON.stringify(config).length > (type === 'custom' ? CUSTOM_CONFIG_LIMIT : 20000))
      throw bad('Node configuration is too large');
    const existing = !!nodeId;
    let declared = JSON.stringify(config.widgets);
    if (existing) {
      const old = this.doc.nodes.find(n => n.id === nodeId);
      if (!old || old.node_type !== type) throw bad('Node type cannot be changed');
      if (JSON.stringify(old.config.widgets) === declared) declared = null; // the definition of the widgets did not change
      old.config = config;
    } else {
      nodeId = body.id ?? 'record:' + uid();
      if (typeof nodeId !== 'string' || !/^record:[a-f0-9]{32}$/.test(nodeId)) throw bad('Invalid node ID');
      this.addRecord({
        id: nodeId,
        kind: 'function',
        node_type: type,
        config,
        label: DEFINITIONS[type].label,
        status: 'ready',
      });
    }
    if (existing && type === 'custom') this.pruneStale(nodeId);
    if (type === 'custom' && declared !== null && (existing || config.widgets))
      this.declareWidgets(nodeId, config.widgets);
    if ('position' in body) this.saveLayout({[nodeId]: body.position});
    return {id: nodeId};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ The two bricks the engine is made of: Script and Event (not Library nodes; the Add node menu offers them) в”Ђв”Ђв”Ђв”Ђв”Ђ

  /** Every type expression a document holds: the ports of its nodes and of its Complex Nodes. */
  retype(map) {
    const fix = list => {
      for (const p of list) if (typeof p.type === 'string') p.type = renameTypeRefs(p.type, map);
    };
    for (const n of this.doc.nodes) {
      fix(n.config?.inputs ?? []);
      fix(n.config?.outputs ?? []);
    }
    for (const c of this.doc.complex) {
      fix(c.interface.inputs);
      fix(c.interface.outputs);
    }
    for (const t of this.doc.types ?? [])
      if (!t.library) {
        t.fields = t.fields.map(f => ({...f, type: renameTypeRefs(f.type, map)}));
        if (t.alias) t.alias = renameTypeRefs(t.alias, map);
      }
  }
  /**
   * The type `def` (it has its `id`) in this workflow: the one it has already, under that ID or with that name and shape (a Library type
   * included), else it is added as a type of its own. Answers the ID.
   */
  ensureType(def) {
    const shape = t => JSON.stringify([t.fields, controlOf(t)]);
    const have = (this.doc.types ?? []).find(
      t => t.id === def.id || (t.name.toLowerCase() === def.name.toLowerCase() && shape(t) === shape(def))
    );
    if (have) return have.id;
    this.setTypes([...(this.doc.types ?? []), def]);
    return def.id;
  }
  /**
   * A new Script (`kind` script: In signal, a `script` code input and automatic Out signal) or Event (`kind` event: no inputs,
   * a signal output; the event it fires is chosen on the node, see setEvent).
   */
  addPrimitive(kind, point = {x: 0, y: 0}) {
    if (kind === 'event')
      return this.saveNode({
        node_type: 'custom',
        position: point,
        config: {title: 'Event', inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}], op: 'on_run'},
      });
    if (kind !== 'script') throw bad('Choose script or event');
    const text = this.ensureType({
        id: SCRIPT_TEXT_TYPE,
        name: 'text',
        color: '#669ed6',
        fields: [],
        control: 'textarea',
      }),
      code = this.ensureType({
        id: SCRIPT_CODE_TYPE,
        name: 'script',
        color: '#8a6fd6',
        fields: [],
        alias: 't:' + text,
        control: 'code',
      });
    return this.saveNode({
      node_type: 'custom',
      position: point,
      config: {
        title: 'Script',
        inputs: [
          {id: 'in', name: 'in', type: 'signal'},
          {id: 'script', name: 'script', type: 't:' + code},
        ],
        outputs: [{id: 'out', name: 'out', type: 'signal'}],
        op: 'script',
      },
    });
  }
  /** Chooses the event an Event node fires: its operation is the event (on_run, on_read, on_placed, on_deleted, on_input_connected, on_widget). */
  setEvent(nodeId, op) {
    const node = this.doc.nodes.find(n => n.id === nodeId);
    if (!node || node.node_type !== 'custom' || !EVENT_OPS.has(node.config?.op) || node.config.inputs?.length)
      throw missing('Event node not found in this project');
    if (!EVENT_OPS.has(op)) throw bad(`Choose one of ${[...EVENT_OPS].join(', ')}`);
    node.config = {...node.config, op};
    return {id: nodeId, op};
  }

  /**
   * A node's widgets as its definition (config.widgets) says: that list, in that order. The widgets that were there and stay
   * (same ID and kind) keep their value; a new one starts with the value the definition gives, else the default of its kind.
   * Runs when a node is made and whenever the definition of its widgets changes (also when a Library node is placed or refreshed).
   */
  declareWidgets(nodeId, list) {
    this.setWidgets(
      nodeId,
      (list ?? []).map(w => {
        const kept = (this.doc.widgets[nodeId] ?? []).find(x => x.id === w.id && x.kind === w.kind);
        return kept && HAS_VALUE.has(w.kind) ? {...w, value: kept.value} : w;
      })
    );
  }

  /** After a Custom node's ports changed: drops the wires and Complex Node bindings that no longer fit them. */
  pruneStale() {
    this.pruneBindings(this.pruneWires());
  }

  /** After a type changed: drops what no longer fits anywhere in the document (wires, bindings). */
  pruneAll() {
    this.dropStaleDefaults();
    this.pruneBindings(this.pruneWires());
  }

  /** Forgets the default of an input whose type no longer has a control that can hold it (the type changed or went). */
  dropStaleDefaults() {
    const table = this.typeTable();
    for (const p of this.allPorts()) {
      if (!('default' in p) && !p.editable) continue;
      const control = table.control(p.type);
      if (!control) delete p.editable;
      if ('default' in p && (!control || !fitsControl(p.default, control))) delete p.default;
    }
  }

  /**
   * Sets the values of the free inputs of a node that the control of their type can hold (the default of the input):
   * `values` is {input ID: value}, and a value of null takes the default away. `nodeId` is a Custom node or a Complex Node.
   */
  setInputValues(nodeId, values) {
    return this.setPortValues(nodeId, values, 'inputs');
  }

  /**
   * Sets the values of the outputs of a node that show a control (`editable`): the node holds the value, and it is the output
   * until the code of the node sets another. `values` is {output ID: value}; null takes the value away.
   */
  setOutputValues(nodeId, values) {
    return this.setPortValues(nodeId, values, 'outputs');
  }

  setPortValues(nodeId, values, direction) {
    const noun = direction === 'inputs' ? 'input' : 'output';
    if (!isObject(values)) throw bad(`Give the values as {${noun} ID: value}`);
    const table = this.typeTable(),
      stored = nodeId.startsWith('complex:') ? this.doc.complex.find(c => c.id === nodeId.slice(8)) : null;
    if (nodeId.startsWith('complex:') && !stored) throw missing('Complex Node not found');
    const own = stored ? null : this.customNode(nodeId),
      config = own ? clone(own.config) : null,
      set = (port, value) => (value == null ? delete port.default : (port.default = value));
    // A node inside that a slot is bound to keeps the same value, so that clearing it does not bring back the one of the definition.
    const bodyConfig = new Map();
    for (const [id, value] of Object.entries(values)) {
      const port = (stored ? stored.interface[direction] : config[direction]).find(p => p.id === id);
      if (!port) throw missing(`This node has no ${noun} вЂњ${id}вЂќ`);
      const control = table.control(port.type);
      if (!control) throw bad(`The ${noun} вЂњ${port.name}вЂќ has no control: its type does not say how to type it in`);
      if (direction === 'outputs' && !port.editable) throw bad(`The output вЂњ${port.name}вЂќ does not show a control`);
      if (value != null && !fitsControl(value, control)) throw bad(`That is not a value of the type of вЂњ${port.name}вЂќ`);
      set(port, value);
      for (const b of stored ? (port.bound ?? []) : []) {
        const inner = this.doc.nodes.find(n => n.id === b.node_id && n.node_type === 'custom');
        if (!inner) continue;
        const c = bodyConfig.get(inner.id) ?? clone(inner.config),
          q = c[direction].find(x => x.id === b.port_id);
        if (q) set(q, value);
        bodyConfig.set(inner.id, c);
      }
    }
    for (const [id, c] of bodyConfig) this.saveNode({node_type: 'custom', config: c}, id);
    if (config) this.saveNode({node_type: 'custom', config}, nodeId);
    return {saved: true};
  }

  /** Drops the wires whose ports are gone; answers the snapshot that is left. */
  pruneWires() {
    let snap;
    for (let again = true; again; ) {
      // Taking a wire away can change the type a Reroute point carries, so repeat until nothing is left to drop.
      snap = this.snapshot();
      const nodes = Editor.nodeMap(snap),
        types = new TypeTable(snap.types),
        stale = new Set();
      for (const e of snap.edges) {
        const output = nodes.get(e.source)?.outputs?.find(p => p.id === e.source_port),
          input = nodes.get(e.target)?.inputs?.find(p => p.id === e.target_port);
        if (!output || !input || !compatible(output.type, input.type, types)) stale.add(e.id);
      }
      if ((again = stale.size > 0)) this.doc.port_edges = this.doc.port_edges.filter(e => !stale.has('port:' + e.id));
    }
    return snap;
  }

  /** Breaks connections in the middle: each gets a Reroute point that the wire runs through. */
  splitConnections(body) {
    const splits = body.splits;
    if (!Array.isArray(splits) || !splits.length || splits.length > 200) throw bad('Provide the connections to split');
    const made = [],
      wires = this.snapshot().edges;
    for (const {edge_id, position} of splits) {
      if (!validPoint(position)) throw bad('Invalid position');
      const edge = wires.find(e => e.id === edge_id);
      if (!edge) throw missing('Connection not found');
      const {id} = this.saveNode({node_type: 'reroute', config: {}, position});
      this.connections({
        remove: [
          {source: edge.source, source_port: edge.source_port, target: edge.target, target_port: edge.target_port},
        ],
      });
      this.connections({
        add: [
          {source: edge.source, source_port: edge.source_port, target: id, target_port: 'in'},
          {source: id, source_port: 'out', target: edge.target, target_port: edge.target_port},
        ],
      });
      made.push(id);
    }
    return {ids: made};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Widgets: what the code of a Custom node put on it в”Ђв”Ђв”Ђв”Ђв”Ђ

  /** The Custom node `nodeId` (a Custom node, not a Complex Node). */
  customNode(nodeId) {
    const node = this.doc.nodes.find(n => n.id === nodeId);
    if (node?.node_type !== 'custom') throw missing('Custom node not found');
    return node;
  }

  /**
   * Replaces the widgets of a Custom node by `list` ([{id, kind, label?, value?, ...}], see checkWidgets). A widget that
   * stays (same ID and kind) keeps its value unless the list gives a new one.
   */
  setWidgets(nodeId, list) {
    this.customNode(nodeId);
    checkWidgets(list);
    const old = new Map((this.doc.widgets[nodeId] ?? []).map(w => [w.id, w]));
    const next = list.map(w => {
      const kept = old.get(w.id);
      const value = 'value' in w ? w.value : kept?.kind === w.kind ? kept.value : widgetDefault(w);
      const {value: _, ...rest} = w;
      return clone(HAS_VALUE.has(w.kind) ? {...rest, value} : rest);
    });
    if (next.length) this.doc.widgets[nodeId] = next;
    else delete this.doc.widgets[nodeId];
    return {saved: true};
  }

  /** Sets the values of widgets of a Custom node: `values` is {widget ID: value}. */
  setWidgetValues(nodeId, values) {
    this.customNode(nodeId);
    if (!isObject(values)) throw bad('Give the widget values as {widget ID: value}');
    const list = this.doc.widgets[nodeId] ?? [];
    for (const [id, value] of Object.entries(values)) {
      const widget = list.find(w => w.id === id);
      if (!widget) throw missing(`This node has no widget вЂњ${id}вЂќ`);
      if (!HAS_VALUE.has(widget.kind)) throw bad(`A ${widget.kind} widget has no value`);
      if (JSON.stringify(value ?? null).length > WIDGET_VALUE_LIMIT) throw bad('The widget value is too large');
      widget.value = value ?? null;
    }
    return {saved: true};
  }

  /**
   * Gives a node slots of its own: `slots` is {inputs?: [{id, name}], outputs?: [...]}; a direction that is left out stays.
   * `nodeId` is a Custom node or a placed Library node (`complex:<group>`: the slots are added to it).
   */
  setSlots(nodeId, slots) {
    if (!isObject(slots) || Object.keys(slots).some(k => !['inputs', 'outputs'].includes(k)))
      throw bad('Slots are {inputs: [...], outputs: [...]}');
    if (nodeId.startsWith('complex:')) return this.setExtras(nodeId.slice(8), slots);
    const node = this.customNode(nodeId),
      config = clone(node.config);
    for (const direction of ['inputs', 'outputs']) {
      if (!(direction in slots)) continue;
      checkPorts(slots[direction], {custom: true, types: this.typeTable()});
      config[direction] = slots[direction].map(slotOf);
    }
    this.saveNode({node_type: 'custom', config}, nodeId);
    return {saved: true};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Groups and Complex Nodes (a Complex Node is a group with an interface) в”Ђв”Ђв”Ђв”Ђв”Ђ

  /** Adds or removes the Complex Node wrapper of a group, and changes its ports, collapsed state or compact size. */
  complex(groupId, body, internal = false) {
    const snap = this.snapshot(true),
      group = snap.groups.find(g => g.id === groupId) ?? this.doc.groups.find(g => g.id === groupId);
    if (!group) throw bad('Group not found');
    const existing = this.doc.complex.find(c => c.id === groupId);
    const library = String(this.project.id).startsWith('lib-');
    if (!internal && 'extra' in body) return this.setExtras(groupId, body.extra);
    if (
      'arbitrary' in body &&
      !(isObject(body.arbitrary) && ['inputs', 'outputs'].every(k => typeof body.arbitrary[k] === 'boolean'))
    )
      throw bad('Arbitrary is {inputs: true or false, outputs: true or false}');
    if (!internal) {
      if (groupId === this.doc.root && (body.wrap === false || body.collapsed === true))
        throw bad('The main group of a Custom Node stays open and keeps its ports.');
      if (!existing && !library) throw bad('Complex Nodes are built in the Library editor');
      if (
        existing &&
        existing.source &&
        (body.wrap === false || body.interface || body.arbitrary || body.collapsed === false)
      )
        throw bad('This Complex Node comes from the Library. Edit it there.');
    }
    if (body.wrap === false) {
      if (existing) this.dropComplex(groupId);
      return {saved: true};
    }
    let stored = existing;
    if (!stored) {
      if (body.wrap !== true) throw bad('This group is not a Complex Node');
      stored = {
        id: groupId,
        interface: {inputs: [], outputs: []},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
      };
      this.doc.complex.push(stored);
    }
    const current = snap.complex.find(c => c.id === groupId);
    const interface_ = body.interface ?? current?.interface ?? stored.interface;
    if (!isObject(interface_) || Object.keys(interface_).some(k => !['inputs', 'outputs'].includes(k)))
      throw bad('Invalid Complex Node interface');
    for (const direction of ['inputs', 'outputs']) {
      checkPorts(interface_[direction] ?? [], {types: this.typeTable()});
      this.releasePorts(groupId, stored, direction, interface_[direction] ?? []);
    }
    const collapsed = body.collapsed ?? stored.collapsed;
    if (internal && 'source' in body) {
      if (body.source) stored.source = clone(body.source);
      else delete stored.source;
    }
    if ('grants' in body) {
      if (!stored.source) throw bad('Permissions belong to a node placed from the Library');
      checkManifest({grants: body.grants});
      stored.grants = [...new Set(body.grants)];
    }
    if (typeof collapsed !== 'boolean') throw bad('Collapsed must be a boolean');
    if ('compact_size' in body) {
      const size = body.compact_size;
      if (
        !isObject(size) ||
        [
          ['width', 160],
          ['height', 78],
        ].some(([k, min]) => !finite(size[k]) || size[k] < min || size[k] > 4000)
      )
        throw bad('Invalid compact Complex Node dimensions');
      stored.compact_width = size.width;
      stored.compact_height = size.height;
    }
    stored.interface = {inputs: interface_.inputs ?? [], outputs: interface_.outputs ?? []};
    stored.collapsed = collapsed;
    if (body.arbitrary) stored.arbitrary = clone(body.arbitrary);
    return {saved: true};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Slots of a placed Library node в”Ђв”Ђв”Ђв”Ђв”Ђ

  /**
   * The slots of a placed Library node that were added on the workflow (by hand or by a Script: `arbitrary` only decides whether the panel
   * offers to add them by hand): `{inputs: [{id, name, type?}], outputs: [...]}`. They are not bound to any node inside; a Script of the
   * node reads an input by its name: `node.input.<name>`.
   */
  setExtras(groupId, extra) {
    const stored = this.doc.complex.find(c => c.id === groupId);
    if (!stored?.source) throw bad('Only a Custom Node placed from the Library has slots of its own');
    if (!isObject(extra) || Object.keys(extra).some(k => !['inputs', 'outputs'].includes(k)))
      throw bad('Slots are {inputs: [...], outputs: [...]}');
    const iface = {inputs: [], outputs: []};
    for (const direction of ['inputs', 'outputs']) {
      if (!(direction in extra)) {
        iface[direction] = stored.interface[direction]; // a direction that is not mentioned stays as it is
        continue;
      }
      const list = extra[direction],
        fixed = stored.interface[direction].filter(p => !p.extra);
      checkPorts(list, {custom: true, types: this.typeTable()});
      if (list.some(p => fixed.some(f => f.id === p.id) || ['bound', 'extra'].some(k => k in p)))
        throw bad('Choose another ID for this slot');
      if (list.some(p => fixed.some(f => f.name === p.name))) throw bad('A slot needs a unique name');
      iface[direction] = [...fixed, ...list.map(slotOf).map(p => ({...p, extra: true}))];
      this.releasePorts(groupId, stored, direction, iface[direction]);
    }
    stored.interface = iface;
    return {saved: true};
  }

  /** Drops the wires and typed values of slots that are no longer in the new list. */
  releasePorts(groupId, stored, direction, next) {
    const side = direction === 'inputs' ? 'target' : 'source',
      kept = new Set(next.map(p => p.id));
    for (const p of stored.interface[direction] ?? [])
      if (!kept.has(p.id)) {
        this.doc.port_edges = this.doc.port_edges.filter(
          e => !(e[side] === 'complex:' + groupId && e[side + '_port'] === p.id)
        );
      }
  }

  /** Removes a wrapper. Wires on its ports move to the bound inner port, or disappear when the port is unbound. */
  dropComplex(groupId) {
    const old = this.doc.complex.find(c => c.id === groupId);
    if (!old) return;
    for (const [direction, side] of [
      ['inputs', 'target'],
      ['outputs', 'source'],
    ])
      for (const p of old.interface?.[direction] || []) {
        const edges = this.doc.port_edges.filter(e => e[side] === 'complex:' + groupId && e[side + '_port'] === p.id);
        if (p.bound?.length) {
          const [first, ...rest] = p.bound;
          for (const e of edges) {
            for (const b of rest)
              this.doc.port_edges.push({...e, id: uid(), [side]: b.node_id, [side + '_port']: b.port_id});
            e[side] = first.node_id;
            e[side + '_port'] = first.port_id;
          }
        } else this.doc.port_edges = this.doc.port_edges.filter(e => !edges.includes(e));
      }
    this.doc.complex = this.doc.complex.filter(c => c !== old);
    delete this.doc.layout['complex:' + groupId];
  }

  /** In a Library editor everything belongs to the main group: stray nodes move into it and other top-level groups become its children. */
  adoptIntoRoot() {
    const root = this.doc.groups.find(g => g.id === this.doc.root);
    if (!root) return;
    const inGroup = new Set(this.doc.groups.flatMap(g => g.members));
    for (const n of this.doc.nodes) if (!inGroup.has(n.id)) root.members.push(n.id);
    for (const g of this.doc.groups) if (g !== root && !g.parent) g.parent = root.id;
    // The main group is a fixed workspace: whatever was placed outside of it is moved in.
    const area = this.doc.layout['group:' + root.id];
    if (area?.width && area?.height) {
      const inside = new Set(this.doc.groups.flatMap(g => g.members));
      for (const n of this.doc.nodes) {
        const p = this.doc.layout[n.id];
        if (!inside.has(n.id)) continue;
        if (!p) {
          this.doc.layout[n.id] = {x: area.x + 40, y: area.y + 60};
          continue;
        }
        p.x = Math.round(Math.min(Math.max(p.x, area.x + 20), area.x + area.width - 120));
        p.y = Math.round(Math.min(Math.max(p.y, area.y + 44), area.y + area.height - 80));
      }
    }
  }

  groups(groups, force = false) {
    if (!Array.isArray(groups) || groups.length > 200) throw bad('Provide up to 200 node groups');
    if (!force && this.doc.root) {
      const main = groups.find(g => g.id === this.doc.root);
      if (!main || main.parent) throw bad('The main group of a Custom Node cannot be removed, ungrouped or nested.');
    }
    const ids = new Set(this.doc.nodes.map(n => n.id)),
      seen = new Set(),
      members = new Set();
    for (const group of groups) {
      if (!isObject(group)) throw bad('Invalid group');
      const {id, name, members: list} = group;
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > 100 ||
        seen.has(id) ||
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100
      )
        throw bad('Groups require a unique ID and a name of 1 to 100 characters');
      if (!Array.isArray(list) || list.some(n => typeof n !== 'string' || !ids.has(n) || members.has(n)))
        throw bad('A node can belong to one group in this project');
      if (list.length !== new Set(list).size) throw bad('Duplicate group member');
      seen.add(id);
      list.forEach(n => members.add(n));
    }
    const parents = new Map(groups.map(g => [g.id, seen.has(g.parent) && g.parent !== g.id ? g.parent : null]));
    for (const id of seen) {
      const ancestors = new Set();
      for (let at = parents.get(id); at; at = parents.get(at)) {
        if (at === id || ancestors.has(at)) throw bad('Groups cannot contain cycles');
        ancestors.add(at);
      }
    }
    for (const group of groups) {
      const hasChildren = groups.some(g => parents.get(g.id) === group.id);
      if (!group.members.length && !hasChildren && !validPoint(group.position))
        throw bad('Empty groups require a valid position');
    }
    const old = new Map(this.doc.groups.map(g => [g.id, g]));
    if (!force) {
      // A Complex Node that is an ordinary node here keeps its contents and ports; only its place among groups may change.
      const snap = this.snapshot(true),
        frozen = snap.complex.filter(c => c.locked).map(c => c.id),
        oldTree = snap.groups,
        oldById = new Map(oldTree.map(g => [g.id, g]));
      for (const root of frozen)
        for (const g of oldTree)
          if (g.id === root || isInside(oldById, g, root)) {
            const next = groups.find(x => x.id === g.id);
            const same =
              next &&
              JSON.stringify([...next.members].sort()) === JSON.stringify([...g.members].sort()) &&
              (g.id === root || (next.parent ?? null) === g.parent);
            if (!same) throw bad('A Complex Node from the Library cannot be opened, ungrouped or changed here.');
          }
    }
    for (const id of old.keys())
      if (!seen.has(id)) {
        this.dropComplex(id);
        delete this.doc.layout['group:' + id];
        delete this.doc.style['group:' + id];
      }
    this.doc.groups = groups.map(g => ({
      id: g.id,
      name: g.name.trim(),
      members: [...g.members],
      parent: parents.get(g.id),
    }));
    // Empty groups need a position before they can appear in the snapshot used by saveLayout.
    for (const group of groups)
      if (validPoint(group.position) && !this.doc.layout['group:' + group.id])
        this.doc.layout['group:' + group.id] = {x: group.position.x, y: group.position.y};
    const positions = Object.fromEntries(groups
      .filter(group => validPoint(group.position))
      .map(group => ['group:' + group.id, group.position]));
    if (Object.keys(positions).length) this.saveLayout(positions);
    this.pruneBindings();
    return {saved: true};
  }

  /** Drops interface bindings that no longer point to a fitting port inside their group (nodes or groups moved, a Custom node changed). */
  pruneBindings(snap = this.snapshot()) {
    const nodes = Editor.nodeMap(snap),
      types = new TypeTable(snap.types);
    for (const stored of this.doc.complex) {
      const cx = snap.complex.find(c => c.id === stored.id);
      if (!cx) continue;
      for (const direction of ['inputs', 'outputs'])
        for (const p of stored.interface[direction] || []) {
          if (!p.bound) continue;
          const keep = p.bound.filter(
            (b, i) => (direction === 'inputs' || i === 0) && !bindingFault(cx, nodes, b, p, direction, types)
          );
          if (keep.length) p.bound = keep;
          else delete p.bound;
        }
    }
  }

  deleteGroup(groupId) {
    const group = this.doc.groups.find(g => g.id === groupId);
    if (!group) throw bad('Group not found');
    if (groupId === this.doc.root) throw bad('The main group of a Custom Node cannot be deleted.');
    const snap = this.snapshot(true),
      byId = new Map(snap.groups.map(g => [g.id, g]));
    const doomed = new Set([groupId, ...snap.groups.filter(g => isInside(byId, g, groupId)).map(g => g.id)]);
    const nodes = snap.nodes
      .filter(n => snap.groups.some(g => doomed.has(g.id) && g.members.includes(n.id)))
      .map(n => n.id);
    if (nodes.length) this.deleteNodes(nodes);
    let rest = this.snapshot(true)
      .groups.filter(g => !doomed.has(g.id))
      .map(g => ({id: g.id, name: g.name, members: g.members, parent: g.parent, position: g.position}));
    // A parent that only held the deleted group disappears with it.
    for (let again = true; again; ) {
      const keep = rest.filter(g => g.members.length || g.position || rest.some(o => o.parent === g.id));
      again = keep.length !== rest.length;
      rest = keep;
    }
    this.groups(
      rest.map(g => ({...g, parent: rest.some(o => o.id === g.parent) ? g.parent : null})),
      true
    );
    return {deleted: groupId};
  }

  retainGroups(removed, positions = {}) {
    for (const group of this.doc.groups) {
      const remaining = group.members.filter(id => !removed.has(id));
      if (remaining.length === group.members.length) continue;
      if (!remaining.length && !this.doc.groups.some(g => g.parent === group.id)) {
        const point = positions[group.id] || this.doc.layout['group:' + group.id];
        // A group that lost its last member keeps the place its frame had, around where the members were.
        const points = group.members.map(id => this.doc.layout[id]).filter(Boolean);
        this.doc.layout['group:' + group.id] = point
          ? {x: point.x, y: point.y}
          : {
              x: points.length ? Math.min(...points.map(p => p.x)) - 24 : 0,
              y: points.length ? Math.min(...points.map(p => p.y)) - 78 : 0,
            };
      }
      group.members = remaining;
    }
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Deleting nodes в”Ђв”Ђв”Ђв”Ђв”Ђ

  deleteNodes(ids, dissolve = false, groupPositions = {}) {
    const selected = this.selection(ids);
    if (typeof dissolve !== 'boolean') throw bad('dissolve must be a boolean');
    groupPositions ??= {};
    if (
      !isObject(groupPositions) ||
      Object.keys(groupPositions).length > 200 ||
      Object.values(groupPositions).some(p => !validPoint(p))
    )
      throw bad('Invalid group positions');
    const removing = new Set(selected.map(n => n.id)),
      routes = [];
    if (dissolve) {
      const wires = this.snapshot().edges,
        leaving = new Map();
      for (const wire of wires) leaving.set(wire.source, [...(leaving.get(wire.source) || []), wire]);
      for (const entry of wires) {
        if (removing.has(entry.source) || !removing.has(entry.target)) continue;
        const pending = [entry.target],
          visited = new Set();
        while (pending.length) {
          const current = pending.pop();
          if (visited.has(current)) continue;
          visited.add(current);
          for (const exit of leaving.get(current) || []) {
            if (removing.has(exit.target)) pending.push(exit.target);
            else if (exit.target !== entry.source) routes.push([entry, exit]);
          }
        }
      }
    }
    this.retainGroups(removing, groupPositions);
    const doc = this.doc;
    doc.port_edges = doc.port_edges.filter(e => !removing.has(e.source) && !removing.has(e.target));
    this.dropWidgets(nid => removing.has(nid));
    for (const nid of removing) {
      delete doc.layout[nid];
      delete doc.style[nid];
    }
    doc.nodes = doc.nodes.filter(n => !removing.has(n.id));
    for (const cx of doc.complex)
      for (const p of [...(cx.interface?.inputs || []), ...(cx.interface?.outputs || [])])
        if (p.bound) {
          p.bound = p.bound.filter(b => !removing.has(b.node_id));
          if (!p.bound.length) delete p.bound;
        }
    for (const [entry, exit] of routes) {
      try {
        this.connections({
          add: [
            {source: entry.source, source_port: entry.source_port, target: exit.target, target_port: exit.target_port},
          ],
        });
      } catch {
        /* Incompatible or cyclic routes are dropped. */
      }
    }
    return {deleted: [...removing].sort()};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Wires в”Ђв”Ђв”Ђв”Ђв”Ђ

  connections(body) {
    const draft = body.draft === true;
    for (const action of ['remove', 'add']) {
      const changes = body[action] ?? [];
      if (!Array.isArray(changes) || changes.length > 1000) throw bad('Provide connection changes');
      // Removing a wire does not change what the other removals match, so one snapshot serves the whole
      // batch; every added wire changes what is connected, so the view is rebuilt after each of those.
      let snap = null,
        nodes = null;
      const removed = new Set(),
        types = this.typeTable();
      for (const change of changes) {
        if (!isObject(change)) throw bad('Invalid connection');
        if (!snap) {
          snap = this.snapshot();
          nodes = Editor.nodeMap(snap);
        }
        const edges = removed.size ? snap.edges.filter(e => !removed.has(e.id)) : snap.edges;
        const source = nodes.get(change.source),
          target = nodes.get(change.target);
        if (!source || !target) throw bad('Connect ports in this workflow');
        if (action === 'remove') {
          const matches = edges.filter(
            e =>
              e.source === source.id &&
              e.target === target.id &&
              ['source_port', 'target_port'].every(k => !(k in change) || change[k] === e[k])
          );
          if (matches.length !== 1) throw bad('Select one existing connection');
          this.doc.port_edges = this.doc.port_edges.filter(e => 'port:' + e.id !== matches[0].id);
          removed.add(matches[0].id);
          continue;
        }
        const output = source.outputs.find(p => p.id === (change.source_port ?? source.outputs[0]?.id));
        const free = target.inputs.find(p => !p.connected) ?? target.inputs[0];
        const input = 'target_port' in change ? target.inputs.find(p => p.id === change.target_port) : free;
        if (!output || !input) throw bad('Select an existing input and output port');
        if (!draft && source.id === target.id && !isSignal(output.type)) throw bad('A node cannot connect to itself');
        // A Reroute point with nothing wired yet takes whatever comes (it is then typed by it, see typeReroutes): signals too.
        const open = (node, port) => node.node_type === 'reroute' && isAny(port.type);
        if (!draft && !open(source, output) && !open(target, input) && !compatible(output.type, input.type, types))
          throw bad('Port types are incompatible');
        const b = Editor.resolveAll(nodes, target.id, input.id, 'inputs').map(t => t.join('|'));
        // A data input takes one connection: a new wire replaces the one that was there. A signal input takes any number, and
        // a signal may go in a circle, so signal wires are neither replaced nor looked at for cycles.
        const signal = isSignal(output.type) || isSignal(input.type);
        const replaced = signal
          ? []
          : edges.filter(e =>
              Editor.resolveAll(nodes, e.target, e.target_port, 'inputs').some(t => b.includes(t.join('|')))
            );
        if (
          signal &&
          edges.some(
            e =>
              e.source === source.id &&
              e.source_port === output.id &&
              e.target === target.id &&
              e.target_port === input.id
          )
        )
          throw bad('These ports are connected already');
        if (replaced.length) {
          const gone = new Set(replaced.map(e => e.id));
          this.doc.port_edges = this.doc.port_edges.filter(e => !gone.has('port:' + e.id));
        }
        if (!draft && !signal) {
          const adjacency = new Map();
          const data = e => !isSignal(nodes.get(e.source)?.outputs?.find(p => p.id === e.source_port)?.type);
          for (const e of [
            ...edges.filter(e => !replaced.includes(e) && data(e)),
            {source: source.id, source_port: output.id, target: target.id, target_port: input.id},
          ]) {
            const from = Editor.resolve(nodes, e.source, e.source_port, 'outputs')[0];
            if (!adjacency.has(from)) adjacency.set(from, []);
            for (const to of Editor.resolveAll(nodes, e.target, e.target_port, 'inputs'))
              adjacency.get(from).push(to[0]);
          }
          ensureAcyclic(adjacency);
        }
        this.doc.port_edges.push({
          id: uid(),
          source: source.id,
          source_port: output.id,
          target: target.id,
          target_port: input.id,
        });
        snap = null;
      }
    }
    // A Reroute point takes the type of the wire that enters it, which can leave a Complex Node port bound to it unfitting.
    if (!draft && body.add?.length && this.doc.complex.length) this.pruneBindings();
    return {saved: true};
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Library: keeping placed copies in sync в”Ђв”Ђв”Ђв”Ђв”Ђ

  /** Replaces the contents of a placed Library node with its current definition, keeping its wires, values and place. */
  refreshInstance(groupId, bundle, source) {
    const snap = this.snapshot(),
      byId = new Map(snap.groups.map(g => [g.id, g]));
    const stored = this.doc.complex.find(c => c.id === groupId),
      group = this.doc.groups.find(g => g.id === groupId);
    if (!stored || !group) throw bad('Complex Node not found');
    const extras = {
      inputs: stored.interface.inputs.filter(p => p.extra),
      outputs: stored.interface.outputs.filter(p => p.extra),
    };
    const name = group.name,
      typed = direction =>
        Object.fromEntries(
          stored.interface[direction].filter(p => !p.extra && 'default' in p).map(p => [p.id, p.default])
        ),
      typedIn = typed('inputs'),
      typedOut = typed('outputs');
    const inner = snap.groups.filter(g => isInside(byId, g, groupId)).map(g => g.id);
    const nodes = snap.nodes
      .filter(n => snap.groups.some(g => (g.id === groupId || inner.includes(g.id)) && g.members.includes(n.id)))
      .map(n => n.id);
    // The widgets of the nodes inside stay (with their values) on the nodes that take their place: the k-th node with the same title.
    const widgetsOf = ids =>
      ids
        .filter(id => this.doc.widgets[id])
        .map(id => ({title: this.doc.nodes.find(n => n.id === id).config?.title, id}));
    const oldWidgets = widgetsOf(nodes).map(({title, id}) => ({
      title,
      list: clone(this.doc.widgets[id]),
      declared: !!this.doc.nodes.find(n => n.id === id).config.widgets,
    }));
    const doomed = new Set(inner);
    if (nodes.length) this.deleteNodes(nodes);
    this.doc.groups = this.doc.groups.filter(g => !doomed.has(g.id));
    this.doc.complex = this.doc.complex.filter(c => !doomed.has(c.id));
    const gone = id => id.startsWith('complex:') && doomed.has(id.slice(8));
    this.doc.port_edges = this.doc.port_edges.filter(e => !gone(e.source) && !gone(e.target));
    for (const id of doomed)
      for (const k of ['group:', 'complex:']) {
        delete this.doc.layout[k + id];
        delete this.doc.style[k + id];
      }
    group.members = [];
    this.paste(bundle, this.doc.layout['complex:' + groupId] ?? {x: 0, y: 0}, {
      source,
      grants: [...(stored.grants ?? [])],
      into: groupId,
      parent: group.parent ?? null,
      extras,
    });
    // The name of this node on the workflow is its own: the definition does not take it back.
    this.doc.groups.find(g => g.id === groupId).name = name;
    // A widget the definition declares keeps its value; one that the code made (no declaration) comes back as it was.
    const after = this.snapshot(),
      innerAfter = after.groups
        .filter(g => isInside(new Map(after.groups.map(x => [x.id, x])), g, groupId))
        .map(g => g.id),
      fresh = after.nodes
        .filter(n =>
          after.groups.some(g => (g.id === groupId || innerAfter.includes(g.id)) && g.members.includes(n.id))
        )
        .map(n => n.id);
    const used = new Map();
    for (const id of fresh) {
      const node = this.doc.nodes.find(n => n.id === id),
        title = node.config?.title,
        taken = used.get(title) ?? 0;
      used.set(title, taken + 1);
      const before = oldWidgets.filter(w => w.title === title)[taken];
      if (!before) continue;
      if (node.config.widgets) {
        this.doc.widgets[id] = before.list;
        this.declareWidgets(id, node.config.widgets);
      } else if (!before.declared) this.doc.widgets[id] = before.list;
    }
    // What was typed into the free inputs of this node stays, as far as the inputs and their types still allow it.
    for (const [id, value] of Object.entries(typedIn))
      try {
        this.setInputValues('complex:' + groupId, {[id]: value});
      } catch {}
    for (const [id, value] of Object.entries(typedOut))
      try {
        this.setOutputValues('complex:' + groupId, {[id]: value});
      } catch {}
  }

  // в”Ђв”Ђв”Ђв”Ђв”Ђ Clipboard: copy and paste в”Ђв”Ђв”Ђв”Ђв”Ђ

  copy(ids, groupIds = []) {
    groupIds ??= [];
    if (!Array.isArray(groupIds) || groupIds.length > 200 || groupIds.some(g => typeof g !== 'string'))
      throw bad('Invalid group selection');
    const snap = this.snapshot(),
      byId = new Map(snap.groups.map(g => [g.id, g]));
    // A selected group brings everything inside it: its nodes, its subgroups and their Complex Nodes.
    const wanted = new Set(groupIds.filter(id => byId.has(id)));
    for (const g of snap.groups) if (groupIds.some(id => isInside(byId, g, id))) wanted.add(g.id);
    const groups = snap.groups.filter(g => wanted.has(g.id));
    const allIds = [...new Set([...(Array.isArray(ids) ? ids : []), ...groups.flatMap(g => g.members)])];
    const selection = allIds.length || !groups.length ? this.selection(allIds) : [];
    const copied = new Set(selection.map(n => n.id));
    const complexes = snap.complex.filter(c => wanted.has(c.id));
    const ports = new Set([...copied, ...complexes.map(c => 'complex:' + c.id)]);
    // The types its ports use, and the types those use.
    const needed = new Set(),
      wanted_ = [
        ...selection.flatMap(n => [...(n.config?.inputs ?? []), ...(n.config?.outputs ?? [])]),
        ...complexes.flatMap(c => [...c.interface.inputs, ...c.interface.outputs]),
      ].flatMap(p => typeRefs(p.type));
    for (let id = wanted_.pop(); id; id = wanted_.pop()) {
      if (needed.has(id)) continue;
      needed.add(id);
      const t = snap.types.find(x => x.id === id);
      if (t) wanted_.push(...refsOf(t));
    }
    return {
      version: BUNDLE_VERSION,
      source_project: this.project.id,
      // The node carries the definitions of the types it uses, the Library's too, so it stands alone wherever it goes.
      types: snap.types.filter(t => needed.has(t.id)).map(({library, ...t}) => clone(t)),
      records: selection
        .filter(n => n.kind === 'function')
        .map(n => ({
          id: n.id,
          payload: Object.fromEntries([...COPYABLE].map(k => [k, clone(n[k])])),
        })),
      positions: Object.fromEntries(
        snap.nodes.filter(n => copied.has(n.id) && n.position).map(n => [n.id, n.position])
      ),
      port_edges: snap.edges.filter(e => ports.has(e.source) && ports.has(e.target)),
      widgets: Object.fromEntries(
        selection.filter(n => this.doc.widgets[n.id]).map(n => [n.id, clone(this.doc.widgets[n.id])])
      ),
      styles: Object.fromEntries(
        snap.nodes
          .filter(n => copied.has(n.id))
          .map(n => [n.id, {pinned: n.pinned, color: n.color, folded: !!n.folded, disabled: !!n.disabled}])
      ),
      groups: groups.map(g => ({
        id: g.id,
        name: g.name,
        parent: wanted.has(g.parent) ? g.parent : null,
        members: g.members.filter(i => copied.has(i)),
        color: g.color,
        pinned: g.pinned,
        folded: !!g.folded,
        disabled: !!g.disabled,
        ...(g.position ? {position: clone(g.position)} : {}),
      })),
      complex: complexes.map(c => ({
        id: c.id,
        interface: clone(c.interface),
        collapsed: c.collapsed,
        compact_width: c.compact_width,
        compact_height: c.compact_height,
        position: c.position,
        ...(c.arbitrary ? {arbitrary: clone(c.arbitrary)} : {}),
        ...(c.source ? {source: clone(c.source), grants: [...(c.grants ?? [])]} : {}),
      })),
    };
  }

  paste(bundle, point, opts = {}) {
    if (
      opts.preserveIds &&
      (!String(this.project.id).startsWith('lib-') || this.doc.nodes.length || this.doc.groups.length)
    )
      throw bad('Definition IDs can only be reused in an empty Library editor');
    if (
      !isObject(bundle) ||
      bundle.version !== BUNDLE_VERSION ||
      ['records', 'groups', 'complex', 'port_edges'].some(k => !Array.isArray(bundle[k] ?? [])) ||
      !isObject(bundle.widgets ?? {})
    )
      throw bad('Clipboard does not contain graph nodes');
    const records = (bundle.records ?? []).filter(
      r =>
        isObject(r) &&
        isObject(r.payload) &&
        r.payload.kind === 'function' &&
        Object.hasOwn(DEFINITIONS, r.payload.node_type)
    );
    const items = records,
      bundleGroups = bundle.groups ?? [];
    if (!(items.length + bundleGroups.length >= 1)) throw bad('Clipboard does not contain graph nodes');
    if (
      items.some(e => !isObject(e) || typeof e.id !== 'string') ||
      new Set(items.map(e => e.id)).size !== items.length
    )
      throw bad('Invalid clipboard nodes');
    const positions = bundle.positions ?? {},
      styles = bundle.styles ?? {};
    if (!isObject(positions) || !isObject(styles) || !validPoint(point) || !Object.values(positions).every(validPoint))
      throw bad('Coordinates must be finite numbers');
    const origins = [
      ...Object.values(positions),
      ...(!opts.source ? bundleGroups.map(g => g.position).filter(validPoint) : []),
    ];
    const origin = {
      x: Math.min(...origins.map(p => p.x), Infinity),
      y: Math.min(...origins.map(p => p.y), Infinity),
    };
    if (!Number.isFinite(origin.x)) {
      origin.x = 0;
      origin.y = 0;
    }
    // The types come first: the ports of the new nodes use them (under their new IDs, if they had to change).
    const renamed = this.mergeTypes(bundle.types),
      retype = p => (p && typeof p.type === 'string' ? {...p, type: renameTypeRefs(p.type, renamed)} : p),
      retypeConfig = config =>
        renamed.size
          ? {
              ...config,
              ...(config.inputs ? {inputs: config.inputs.map(retype)} : {}),
              ...(config.outputs ? {outputs: config.outputs.map(retype)} : {}),
            }
          : config;
    const mapping = new Map();
    for (const record of records)
      mapping.set(
        record.id,
        this.saveNode({
          // Exported catalogs may use symbolic IDs; turn those into valid local record IDs.
          ...(opts.preserveIds && /^record:[a-f0-9]{32}$/.test(record.id) ? {id: record.id} : {}),
          node_type: record.payload.node_type,
          config: retypeConfig(record.payload.config ?? {}),
        }).id
      );
    // Slots the placed copy had of its own come back (unless the definition does not allow them, or uses the same name or ID).
    let kept = null;
    if (opts.extras) {
      kept = {inputs: [], outputs: []};
      const root = (bundle.complex ?? []).find(c => !c.source),
        allowed = root?.arbitrary ?? {};
      for (const direction of ['inputs', 'outputs'])
        for (const extra of allowed[direction] ? opts.extras[direction] : []) {
          const own = root.interface[direction] ?? [];
          if (own.some(p => p.name === extra.name || p.id === extra.id)) continue;
          kept[direction].push({...slotOf(extra), extra: true});
        }
    }
    const layout = {};
    let index = 0;
    for (const [old, neu] of mapping) {
      const p = positions[old] ?? {x: origin.x, y: origin.y + index++ * 112};
      layout[neu] = {
        ...Object.fromEntries(['width', 'height'].filter(k => k in p).map(k => [k, p[k]])),
        x: point.x + p.x - origin.x,
        y: point.y + p.y - origin.y,
      };
    }
    if (Object.keys(layout).length) this.saveLayout(layout);
    for (const [old, neu] of mapping)
      if (old in styles) {
        const style = isObject(styles[old]) ? styles[old] : {},
          pinned = style.pinned ?? false,
          color = style.color;
        if (!validStyle(pinned, color)) throw bad('Invalid clipboard style');
        this.doc.style[neu] = {
          pinned,
          color: color ? color.toLowerCase() : null,
          ...(style.folded === true ? {folded: true} : {}),
          ...(style.disabled === true ? {disabled: true} : {}),
        };
      }
    // Groups, with their nesting.
    const existing = this.snapshot()
      .groups.filter(g => g.id !== opts.into)
      .map(g => ({id: g.id, name: g.name, members: g.members, parent: g.parent, position: g.position}));
    const fresh = new Map(
        bundleGroups
          .filter(g => isObject(g) && typeof g.id === 'string')
          .map(g => [g.id, opts.preserveIds ? g.id : uid()])
      ),
      copied = [];
    // A Library node is placed (or refreshed in place, with opts.into) as one Complex Node: the single top-level group of its bundle. A bundle of plain nodes (the Script, an event) is placed as they are.
    let rootOld = null;
    if (opts.source && bundleGroups.length) {
      const tops = bundleGroups.filter(g => !g.parent && (bundle.complex ?? []).some(c => c.id === g.id));
      if (tops.length !== 1 || bundleGroups.filter(g => !g.parent).length !== 1)
        throw bad('A Custom Node must be exactly one Complex Node');
      rootOld = tops[0].id;
      if (opts.into) fresh.set(rootOld, opts.into);
    }
    for (const group of bundleGroups) {
      if (!fresh.has(group.id)) continue;
      const members = (group.members ?? []).filter(n => mapping.has(n)).map(n => mapping.get(n));
      const hasChildren = bundleGroups.some(g => g.parent === group.id);
      if (!members.length && !hasChildren && (group.members ?? []).length) {
        fresh.delete(group.id);
        continue;
      }
      const next = {
        id: fresh.get(group.id),
        name: String(group.name ?? 'Group').slice(0, 100) || 'Group',
        members,
        parent: group.id === rootOld && opts.into ? (opts.parent ?? null) : (fresh.get(group.parent) ?? null),
      };
      if (group.position || (!members.length && !hasChildren)) {
        const o = group.position || {x: 0, y: 0};
        next.position = {...clone(o), x: o.x - origin.x + point.x, y: o.y - origin.y + point.y};
      }
      existing.push(next);
      copied.push([group, next]);
    }
    for (const next of existing) if (next.parent && !existing.some(g => g.id === next.parent)) next.parent = null;
    this.groups(existing, true);
    const wrappers = (bundle.complex ?? []).filter(c => isObject(c) && fresh.has(c.id));
    for (const c of wrappers) mapping.set('complex:' + c.id, 'complex:' + fresh.get(c.id));
    for (const c of wrappers) {
      const iface = {inputs: [], outputs: [], ...clone(c.interface || {})};
      for (const direction of ['inputs', 'outputs'])
        iface[direction] = (iface[direction] || []).map(q => {
          const p = retype(q);
          if (!p.bound) return p;
          const {bound, ...rest} = p,
            inside = bound.filter(b => mapping.has(b.node_id)).map(b => ({...b, node_id: mapping.get(b.node_id)}));
          return inside.length ? {...rest, bound: inside} : rest;
        });
      if (kept && c.id === rootOld)
        for (const direction of ['inputs', 'outputs']) iface[direction].push(...kept[direction]);
      this.complex(
        fresh.get(c.id),
        {
          wrap: true,
          interface: iface,
          collapsed: !!c.collapsed,
          compact_size: {width: c.compact_width ?? 240, height: c.compact_height ?? 90},
          ...(c.arbitrary ? {arbitrary: c.arbitrary} : {}),
          ...(c.id === rootOld ? {source: opts.source} : c.source ? {source: c.source} : {}),
          ...((c.id === rootOld ? opts.source : c.source)
            ? {grants: (c.id === rootOld && opts.grants) || c.grants || []}
            : {}),
        },
        true
      );
      if (c.id === rootOld && !opts.into) this.doc.layout['complex:' + fresh.get(c.id)] = {x: point.x, y: point.y};
      if (c.collapsed && validPoint(c.position))
        this.doc.layout['complex:' + fresh.get(c.id)] = {
          x: c.position.x - origin.x + point.x,
          y: c.position.y - origin.y + point.y,
        };
    }
    for (const [old, next] of copied)
      if (old.color != null || old.pinned || old.folded || old.disabled)
        this.nodeStyle({
          group_id: next.id,
          color: old.color ?? null,
          pinned: old.pinned ?? false,
          folded: old.folded === true,
          disabled: old.disabled === true,
        });
    for (const edge of bundle.port_edges ?? []) {
      if (!isObject(edge) || ['source', 'target', 'source_port', 'target_port'].some(k => typeof edge[k] !== 'string'))
        throw bad('Invalid clipboard port edge');
      if (mapping.has(edge.source) && mapping.has(edge.target))
        this.doc.port_edges.push({
          id: uid(),
          source: mapping.get(edge.source),
          source_port: edge.source_port,
          target: mapping.get(edge.target),
          target_port: edge.target_port,
        });
    }
    // Widgets come along with a pasted node (not with a Library node placed from its definition: its code makes them).
    if (!opts.source)
      for (const [old, list] of Object.entries(bundle.widgets ?? {}))
        if (mapping.has(old)) {
          checkWidgets(list);
          this.doc.widgets[mapping.get(old)] = clone(list);
        }
    if (opts.into) this.pruneAll(); // a refreshed Library node may have changed a type that wires used
    return {
      ids: [...mapping].filter(([old]) => !old.startsWith('complex:')).map(([, neu]) => neu),
      groups: copied.map(([, next]) => next.id),
      roots: copied.filter(([, next]) => !next.parent).map(([, next]) => next.id),
    };
  }
}
