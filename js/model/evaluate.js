// The current graph is indexed for port lookup. Nodes are interpreted on demand; the graph stays live.
'use strict';
function createGraphView(document, {context = {}} = {}) {
  const key = (node, port) => node + '|' + port;
  const isSignal = type => type === 'signal',
    isOff = node => !!(node?.disabled || node?.muted);
  const EVENT_OPS = new Set(['on_run', 'on_read', 'on_placed', 'on_deleted', 'on_input_connected', 'on_widget']);
  const isRunning = node =>
    node.node_type === 'custom' && (node.config?.op === 'script' || EVENT_OPS.has(node.config?.op));
  const SCRIPT_PREFIX = 'Node code';
  const widgetValues = list => Object.fromEntries((list ?? []).map(w => [w.id, w.value]));
  const Editor = {
    nodeMap: s =>
      new Map(
        [...s.nodes, ...s.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'}))].map(n => [n.id, n])
      ),
    resolveAll(nodes, id, port, direction, seen = new Set()) {
      const k = key(id, port);
      if (seen.has(k)) throw Error('Cyclic interface binding');
      const node = nodes.get(id);
      if (!node) throw Error('Node not found: ' + id);
      if (node.kind !== 'complex') return [[id, port]];
      const item = node.interface[direction].find(p => p.id === port);
      if (!item) throw Error('Port not found: ' + port);
      return item.bound?.length
        ? item.bound.flatMap(b => Editor.resolveAll(nodes, b.node_id, b.port_id, direction, new Set(seen).add(k)))
        : [[id, port]];
    },
    resolve(nodes, id, port, direction) {
      return this.resolveAll(nodes, id, port, direction)[0];
    },
  };
  class TypeTable {
    constructor(list) {
      this.list = list;
    }
    control(ref, seen = new Set()) {
      if (!ref || seen.has(ref)) return null;
      seen.add(ref);
      const item = this.list.find(t => 't:' + t.id === ref);
      return item?.control ? item : item?.alias ? this.control(item.alias, seen) : null;
    }
  }

  const evalLabel = node =>
    (node.node_type === 'custom' && node.config?.title) || node.label || node.name || node.node_type;

  /** The first problem of every node: the document's diagnostics, then those a Complex Node passes on to its members. */
  function firstIssues(document) {
    const issues = new Map();
    for (const {node_id, message} of document.diagnostics) if (!issues.has(node_id)) issues.set(node_id, message);
    for (const cx of document.complex) {
      const own = 'complex:' + cx.id;
      if (issues.has(own))
        for (const member of cx.members) if (!issues.has(member)) issues.set(member, issues.get(own));
    }
    return issues;
  }

  /**
   * Where every input gets its value from. Wires are followed through Complex Nodes, so a wrapper costs nothing at run time:
   *  incoming    target key -> [node, port] the wire starts at (the outermost Complex Node port that publishes it)
   *  fallback    target key -> the default of an input nothing is wired to (the outermost one that has a default wins)
   */
  function wireGraph(document, nodes) {
    const incoming = new Map(),
      fallback = new Map(),
      signals = []; // [{source, target}]: a signal wire, from the output the wire starts at to the input it ends at
    for (const node of nodes.values())
      if (node.node_type === 'custom')
        for (const p of node.inputs || []) if ('default' in p) fallback.set(key(node.id, p.id), p.default);
    for (const cx of [...document.complex].sort((a, b) => b.depth - a.depth))
      for (const p of cx.interface.inputs)
        if ('default' in p) {
          try {
            for (const target of Editor.resolveAll(nodes, 'complex:' + cx.id, p.id, 'inputs'))
              fallback.set(key(...target), p.default);
          } catch {}
        }
    // Complex Nodes, inner ones first. A wire is looked up in them by the port it is bound to, so each wire only meets
    // the wrappers that publish it, not all of them.
    const wrappers = [...document.complex]
      .sort((a, b) => b.depth - a.depth)
      .map(cx => {
        const bound = ports => {
          const byTarget = new Map();
          for (const p of ports) {
            const b = p.bound?.[0];
            if (b && !byTarget.has(key(b.node_id, b.port_id))) byTarget.set(key(b.node_id, b.port_id), p);
          }
          return byTarget;
        };
        return {
          id: 'complex:' + cx.id,
          members: new Set(cx.members),
          outputs: bound(cx.interface.outputs),
        };
      });
    /** Port key -> the wrappers (by position) that publish the port on their interface, as `outputs` or `inputs`. */
    const publishing = side => {
      const index = new Map();
      wrappers.forEach((wrapper, i) => {
        for (const k of wrapper[side].keys()) {
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(i);
        }
      });
      return index;
    };
    const outputsAt = publishing('outputs');
    /** The first wrapper at or after position `from` that publishes the output `source` without containing `inside`. */
    const publisher = (source, from, inside) =>
      outputsAt.get(key(...source))?.find(i => i >= from && !wrappers[i].members.has(inside));
    for (const edge of document.edges) {
      let targets, origin;
      try {
        targets = Editor.resolveAll(nodes, edge.target, edge.target_port, 'inputs');
        origin = Editor.resolve(nodes, edge.source, edge.source_port, 'outputs')[0];
      } catch {
        continue;
      }
      // An input bound to several ports inside a group feeds all of them.
      for (const target of targets) {
        const targetKey = key(...target);
        // Where the wire starts: each wrapper, inner to outer, that publishes it as an output and lacks the target.
        let source = [edge.source, edge.source_port];
        for (let i = publisher(source, 0, target[0]); i !== undefined; i = publisher(source, i + 1, target[0]))
          source = [wrappers[i].id, wrappers[i].outputs.get(key(...source)).id];
        if (isSignal(nodes.get(target[0])?.inputs?.find(p => p.id === target[1])?.type)) signals.push({source, target});
        else incoming.set(targetKey, source);
      }
    }
    return {incoming, fallback, signals};
  }

  /**
   * Where each Custom node lives: the placed Library node (a group copy) that is the closest around it. That copy is the node's unit
   * (its scope). Event nodes belong to their unit and a Script runs in its scope (`context`).
   * Answers node ID -> {group: the group ID of the copy, instance_id: 'complex:<group>', widgets: the IDs of the nodes with widgets in it, inputs: its free inputs}.
   */
  function instanceScopes(document) {
    const byId = new Map(document.nodes.map(n => [n.id, n])),
      scopes = new Map();
    const composites = [...document.complex].sort((a, b) => b.depth - a.depth);
    for (const node of document.nodes) {
      const c = composites.find(cx => cx.members.includes(node.id));
      if (c)
        scopes.set(node.id, {
          group: c.id,
          instance_id: 'complex:' + c.id,
          widgets: c.members.filter(m => !m.startsWith('complex:') && document.widgets?.[m]?.length),
          // What a Script of the copy reads: every data input of the node. What it writes: the data outputs no node inside feeds. What it fires
          // with emit(name): the signal outputs no node inside feeds.
          inputs: c.interface.inputs.filter(p => !isSignal(p.type)),
          outputs: c.interface.outputs.filter(p => !isSignal(p.type) && !p.bound?.length),
          signals: c.interface.outputs.filter(p => isSignal(p.type) && !p.bound?.length),
          resource_id: composites.find(cx => cx.source && cx.members.includes(node.id))?.source.resource_id ?? null,
          // The permissions of every placed node around it, the closest first: it can do only what all of them allow.
          grant_chain: composites.filter(cx => cx.source && cx.members.includes(node.id)).map(cx => cx.grants ?? []),
        });
    }
    return scopes;
  }

  /** The current description of a Custom node: what it is (`op`), its data inputs (and the signal ones), its outputs and where its signals go. */
  function describeCustom(
    node,
    inputs,
    {context, scope = null, outputs = null, scopeSignals = {}, targets = {}, event = null}
  ) {
    const config = node.config || {},
      op = config.op ?? null;
    return {
      id: node.id,
      label: evalLabel(node),
      kind: 'custom',
      op,
      running: isRunning(node),
      prefix: SCRIPT_PREFIX,
      inputs,
      scope,
      signals: {
        ...scopeSignals,
        ...Object.fromEntries(
          (config.outputs ?? []).filter(p => isSignal(p.type)).map(p => [p.name, targets[p.id] ?? []])
        ),
      },
      outputs: [
        ...(outputs ?? (config.outputs || [])),
        ...(config.op === 'script' ? (config.outputs ?? []).filter(p => isSignal(p.type)) : []),
      ].map(p => ({
        id: p.id,
        name: p.name,
        ...(isSignal(p.type) ? {signal: true} : {}),
      })),
      // What was typed into the controls of outputs (see `editable`): the node starts with it as its output.
      preset: Object.fromEntries((config.outputs || []).filter(p => 'default' in p).map(p => [p.name, p.default])),
      targets,
      event,
      context,
      grants: config.grants ?? [],
    };
  }

  const nodes = Editor.nodeMap(document),
    {incoming, fallback, signals} = wireGraph(document, nodes),
    issues = firstIssues(document),
    widgets = document.widgets ?? {},
    scopes = instanceScopes(document),
    // The Library node copies that have a Script: their free data outputs are written by it, and kept as the results of the copy.
    scripted = new Set(
      document.nodes
        .filter(n => n.node_type === 'custom' && n.config?.op === 'script' && scopes.has(n.id))
        .map(n => scopes.get(n.id).instance_id)
    ),
    types = new TypeTable(document.types);
  /** Where the value of the output `source` ([node, port]) comes from once Complex Nodes are looked through. */
  const refOf = source => {
    let [nid, port] = source;
    for (;;) {
      const node = nodes.get(nid);
      if (isOff(node)) return {off: true}; // a node that is disabled gives nothing
      if (issues.has(nid)) return {err: issues.get(nid)};
      if (node.kind !== 'complex') return {n: nid, p: port};
      const [inside, inner] = Editor.resolve(nodes, nid, port, 'outputs');
      if (inside === nid) {
        if (scripted.has(nid)) return {n: nid, p: port}; // written by a Script of the copy
        // An output of the Complex Node itself that nothing inside feeds: if it is `editable`, what is typed there is its value.
        const item = node.interface.outputs.find(p => p.id === port);
        if (!item?.editable) return null;
        if ('default' in item) return {value: item.default};
        const control = types.control(item.type)?.control;
        return control === 'checkbox'
          ? {value: false}
          : ['text', 'textarea', 'code'].includes(control)
            ? {value: ''}
            : null;
      }
      [nid, port] = [inside, inner];
    }
  };
  // Where the signal of each output goes: the nodes (a Reroute passes it on) that are on and have no problem.
  const fires = new Map();
  for (const {source, target} of signals) {
    const from = refOf(source),
      to = nodes.get(target[0]);
    if (!to || isOff(to) || issues.has(to.id)) continue;
    // A signal output of a Library node copy that nothing inside feeds is fired by a Script of the copy (emit): it is keyed as itself.
    const free =
      !from?.n &&
      nodes.get(source[0])?.kind === 'complex' &&
      !nodes.get(source[0]).interface.outputs.find(p => p.id === source[1])?.bound?.length;
    if (!from?.n && !free) continue;
    const k = free ? key(source[0], source[1]) : key(from.n, from.p);
    if (!fires.has(k)) fires.set(k, []);
    if (!fires.get(k).includes(to.id)) fires.get(k).push(to.id);
  }
  const reach = (list, seen = new Set()) =>
    list.flatMap(id => {
      if (nodes.get(id)?.node_type !== 'reroute') return [id];
      if (seen.has(id)) return [];
      seen.add(id);
      return reach(fires.get(key(id, 'out')) ?? [], seen);
    });
  const targetsOf = node => {
    const out = {};
    for (const p of node.config?.outputs || [])
      if (isSignal(p.type)) out[p.id] = [...new Set(reach(fires.get(key(node.id, p.id)) ?? []))];
    return out;
  };
  // The on_read nodes of each Library node copy: a node of the copy that is needed brings them (and what their signals reach) along.
  const readers = new Map();
  for (const n of nodes.values())
    if (n.node_type === 'custom' && n.config?.op === 'on_read' && !isOff(n) && !issues.has(n.id) && scopes.has(n.id)) {
      const k = scopes.get(n.id).instance_id;
      readers.set(k, [...(readers.get(k) ?? []), n.id]);
    }
  const describe = nid => {
    const node = nodes.get(nid);
    if (!node || isOff(node)) return null;
    if (issues.has(nid)) return {id: nid, error: issues.get(nid)};
    const custom = node.node_type === 'custom';
    const entry = (owner, p) => {
      if (isSignal(p.type)) return {id: p.id, name: p.name, signal: true};
      const wire = incoming.get(key(owner, p.id)),
        found = wire ? refOf(wire) : null,
        off = !!found?.off,
        literal = !!found && 'value' in found;
      if (literal) return {id: p.id, name: p.name, ref: null, has: true, fallback: found.value};
      const ref = off ? null : found;

      // A wire from a node that is switched off counts as no wire: the default of the input applies.
      const has = (!wire || off) && fallback.has(key(owner, p.id));
      return {id: p.id, name: p.name, ref, has, ...(has ? {fallback: fallback.get(key(owner, p.id))} : {})};
    };
    // A Library node copy that a Script writes to: it keeps what the Scripts put in its free outputs (a running node of its own).
    if (node.kind === 'complex') {
      // Reading the copy brings its on_read nodes (and what their signals reach) along.

      const free = (
        scopes.get(nid)?.outputs ?? node.interface.outputs.filter(p => !isSignal(p.type) && !p.bound?.length)
      ).map(p => ({id: p.id, name: p.name, ...('default' in p ? {default: p.default} : {})}));
      return {
        id: nid,
        label: evalLabel(node),
        kind: 'custom',
        op: 'scope',
        running: true,
        prefix: SCRIPT_PREFIX,
        inputs: [],
        outputs: free.map(({id, name}) => ({id, name})),
        preset: Object.fromEntries(free.filter(p => 'default' in p).map(p => [p.name, p.default])),
        targets: {},
        event: null,
        context: {...context, node_id: nid, instance_id: nid, widgets: {}},
      };
    }
    const inputs = (node.inputs || []).map(p => ({
      ...entry(nid, p),
      ...(custom && node.config?.op === 'script' && p.id === 'script' ? {code: true} : {}),
    }));
    if (custom) {
      const targets = targetsOf(node);

      const scope = scopes.get(nid);

      const script = node.config?.op === 'script';
      // A Script reads every data input of the Library node it is in (the value that arrives there), whatever it is bound to inside.
      if (script)
        for (const p of scope?.inputs ?? []) {
          let target = [scope.instance_id, p.id];
          try {
            target = Editor.resolve(nodes, scope.instance_id, p.id, 'inputs');
          } catch {}
          inputs.push({...entry(target[0], {...p, id: target[1]}), id: 'wrapper:' + p.id, wrapper: true});
        }
      const scopeSignals = Object.fromEntries(
        (scope?.signals ?? []).map(p => [p.name, [...new Set(reach(fires.get(key(scope.instance_id, p.id)) ?? []))]])
      );

      return describeCustom(node, inputs, {
        scope: script ? (scope?.instance_id ?? null) : null,
        outputs: script ? (scope?.outputs ?? []) : null,
        scopeSignals,
        targets,
        event: EVENT_OPS.has(node.config?.op) ? {} : null,
        context: {
          ...context,
          node_id: nid,
          instance_id: scope?.instance_id ?? null,
          resource_id: scope?.resource_id ?? null,
          grant_chain: scope?.grant_chain ?? null,
          // The widgets of the Library node (its nodes' together), or the node's own if it is not part of one.
          widgets: Object.assign(
            {},
            ...(scope ? scope.widgets : []).map(id => widgetValues(widgets[id])),
            widgetValues(widgets[nid])
          ),
        },
      });
    }
    const kind = node.node_type === 'reroute' ? 'reroute' : 'plain';
    return {id: nid, label: evalLabel(node), kind, inputs, outputs: [], targets: {}, context: {}};
  };

  return {
    get: describe,
    values: () => [...nodes.keys()].map(describe).filter(Boolean),
    raw: document,
    issues,
    scopes,
    readers,
    inputTargets: (id, port) => {
      const node = nodes.get(id);
      const inputs = node?.kind === 'complex' ? node.interface.inputs : node?.inputs;
      if (!inputs?.some(p => p.id === port && isSignal(p.type))) throw Error('Signal input not found: ' + port);
      if (isOff(node) || issues.has(id)) throw Error(issues.get(id) ?? 'Node is disabled');
      const targets = [...new Set(Editor.resolveAll(nodes, id, port, 'inputs').map(([target]) => target))];
      for (const target of targets) {
        const executable = describe(target);
        if (executable?.error) throw Error(executable.error);
        if (!executable?.running || executable.op === 'scope')
          throw Error('Signal input has no enabled executable target: ' + port);
      }
      return targets;
    },
    outputRefs: id => {
      const node = nodes.get(id);
      return (node?.kind === 'complex' ? node.interface.outputs : (node?.outputs ?? []))
        .filter(p => !isSignal(p.type))
        .map(p => ({id: p.id, ref: refOf([id, p.id])}));
    },
  };
}

const IMAGE_DISPLAY = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const DISPLAY_PARTS = '\u001e';
function checkRoots(roots, nodes) {
  if (!Array.isArray(roots) || roots.some(id => typeof id !== 'string' || !nodes.has(id)))
    throw bad('node_ids must name nodes of this workflow');
}
