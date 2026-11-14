// Turns a stored workflow document into the "snapshot" the canvas draws: nodes with their ports, wires,
// groups, Complex Nodes and a list of problems (diagnostics). Read-only: it never changes the document.
'use strict';

/** Attach port lists to nodes and Complex Nodes and return the canvas edge list. */
function annotate(nodes, groups, complexes, stored, schemaOf) {
  const all = new Map(nodes.map(n => [n.id, n]));
  for (const group of groups) all.set('group:' + group.id, {id: 'group:' + group.id, kind: 'group', name: group.name});
  for (const cx of complexes) all.set('complex:' + cx.id, {...cx, id: 'complex:' + cx.id, kind: 'complex'});
  const complexById = new Map(complexes.map(cx => ['complex:' + cx.id, cx]));
  const edges = [];
  for (const e of stored)
    if (all.has(e.source) && all.has(e.target)) edges.push({...e, id: 'port:' + e.id, kind: 'data'});
  const binding = (nid, pid, direction) => {
    const node = all.get(nid);
    return node?.kind === 'complex' ? node.interface[direction].find(p => p.id === pid) : undefined;
  };
  const occupied = {inputs: new Set(), outputs: new Set()};
  for (const edge of edges)
    for (const [direction, side] of [
      ['inputs', 'target'],
      ['outputs', 'source'],
    ]) {
      occupied[direction].add(key(edge[side], edge[side + '_port']));
      if (!complexById.has(edge[side])) continue;
      for (const b of binding(edge[side], edge[side + '_port'], direction)?.bound ?? [])
        occupied[direction].add(key(b.node_id, b.port_id));
    }
  // Inner Complex Nodes first, so a wire on a bound port marks every wrapper above it as connected.
  for (const cx of [...complexes].sort((a, b) => b.depth - a.depth))
    for (const direction of ['inputs', 'outputs'])
      for (const p of cx.interface[direction])
        if ((p.bound ?? []).some(b => occupied[direction].has(key(b.node_id, b.port_id))))
          occupied[direction].add(key('complex:' + cx.id, p.id));
  const exposed = new Set(
    complexes.flatMap(c => c.interface.inputs.flatMap(p => (p.bound ?? []).map(b => key(b.node_id, b.port_id))))
  );
  for (const node of all.values()) {
    const spec = schemaOf(node),
      inputs = signalsFirst(spec.inputs.map(p => ({...p})));
    node.inputs = inputs;
    node.outputs = signalsFirst(spec.outputs.map(p => ({...p})));
    // A slot fed by a wire, or exposed on a group's interface (its value then comes from outside), is connected.
    for (const p of inputs) p.connected = occupied.inputs.has(key(node.id, p.id)) || exposed.has(key(node.id, p.id));
    for (const p of node.outputs) p.connected = occupied.outputs.has(key(node.id, p.id));
    if (node.kind === 'complex') {
      const cx = complexById.get(node.id);
      Object.assign(cx, {inputs, outputs: node.outputs});
    }
  }
  typeReroutes(all, edges);
  return edges;
}

/** A Reroute passes values through, so it takes the type of what feeds it (or, unfed, of what it feeds). */
function typeReroutes(nodes, edges) {
  let reroutes = false;
  for (const node of nodes.values())
    if (node.node_type === 'reroute') {
      reroutes = true;
      break;
    }
  if (!reroutes) return;
  const portType = (nodeId, portId, direction) =>
    nodes.get(nodeId)?.[direction]?.find(p => p.id === portId)?.type || '';
  // The wires of each node, in the order they are stored (the first one with a known type decides).
  const feeding = new Map(),
    fed = new Map();
  for (const e of edges) {
    if (!feeding.has(e.target)) feeding.set(e.target, []);
    feeding.get(e.target).push(e);
    if (!fed.has(e.source)) fed.set(e.source, []);
    fed.get(e.source).push(e);
  }
  const typeOf = (id, seen) => {
    if (seen.has(id)) return '';
    seen.add(id);
    const through = (nodeId, portId, direction) =>
      nodes.get(nodeId).node_type === 'reroute' ? typeOf(nodeId, seen) : portType(nodeId, portId, direction);
    for (const e of feeding.get(id) || []) {
      const type = through(e.source, e.source_port, 'outputs');
      if (!isAny(type)) return type;
    }
    for (const e of fed.get(id) || []) {
      const type = through(e.target, e.target_port, 'inputs');
      if (!isAny(type)) return type;
    }
    return '';
  };
  const types = new Map();
  for (const node of nodes.values()) if (node.node_type === 'reroute') types.set(node.id, typeOf(node.id, new Set()));
  for (const [id, type] of types) {
    const node = nodes.get(id);
    for (const p of [...node.inputs, ...node.outputs]) if (type) p.type = type;
  }
}

/** What is wrong with one port `b` ({node_id, port_id}) that the interface port `p` is bound to (none: a fitting port inside the group). */
function bindingFault(cx, nodes, b, p, direction, types) {
  const member = nodes.get(b.node_id),
    bound = (member?.[direction] || []).find(item => item.id === b.port_id);
  if (!bound || !cx.members.includes(member.id)) return 'Complex Node binding is not a port inside its group: ';
  return (direction === 'inputs' ? compatible(p.type, bound.type, types) : compatible(bound.type, p.type, types))
    ? ''
    : 'Complex Node binding types do not match: ';
}
/** What is wrong with what an interface port is bound to (none: it is unbound, or bound to fitting ports inside the group; only an input may have several). */
function bindingProblem(cx, nodes, p, direction, types) {
  const list = p.bound ?? [];
  if (direction === 'outputs' && list.length > 1) return 'Complex Node binding of an output takes one port inside: ';
  for (const b of list) {
    const fault = bindingFault(cx, nodes, b, p, direction, types);
    if (fault) return fault;
  }
  return '';
}

function diagnostics(snapshot, schemaOf = schema) {
  const nodes = new Map(snapshot.nodes.map(n => [n.id, n]));
  for (const c of snapshot.complex) nodes.set('complex:' + c.id, {...c, id: 'complex:' + c.id, kind: 'complex'});
  const types = new TypeTable(snapshot.types);
  const issues = [];
  const report = (message, node_id, port_id = null, direction = null, edge_id = null) =>
    issues.push({message, node_id, port_id, direction, edge_id});
  for (const [nid, node] of nodes) {
    if (node.refresh_error) report(node.refresh_error, nid);
    if (node.node_type === 'custom') {
      const declared = node.config?.inputs || [],
        names = declared.map(p => p.name);
      for (const p of declared)
        if (names.filter(n => n === p.name).length > 1)
          report('Custom node input names must be unique', nid, p.id, 'inputs');
      const outputs = (node.config?.outputs || []).map(p => p.name);
      for (const p of node.config?.outputs || [])
        if (outputs.filter(n => n === p.name).length > 1)
          report('Custom node output names must be unique', nid, p.id, 'outputs');
    }
    for (const direction of ['inputs', 'outputs'])
      for (const p of schemaOf(node)[direction]) {
        if (!p.name.trim()) report('Name this slot', nid, p.id, direction);
        if (!types.shape(p.type)) report('Unknown type of ' + p.name, nid, p.id, direction);
        const problem = node.kind === 'complex' && bindingProblem(node, nodes, p, direction, types);
        if (problem) report(problem + p.name, nid, p.id, direction);
      }
  }
  /** The ports a wire end lands on once Complex Nodes are looked through (an input bound to several ports lands on all of them). */
  const endpoints = (nid, pid, direction, seen = new Set()) => {
    const address = nid + '|' + pid;
    if (seen.has(address)) throw bad('Cyclic interface binding');
    const list = (nodes.get(nid)?.interface?.[direction] || []).find(p => p.id === pid)?.bound ?? [];
    return list.length
      ? list.flatMap(b => endpoints(b.node_id, b.port_id, direction, new Set(seen).add(address)))
      : [[nid, pid]];
  };
  const adjacency = new Map(),
    occupied = new Map(),
    resolved = [];
  for (const edge of snapshot.edges) {
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    const output = source?.outputs?.find(p => p.id === edge.source_port),
      input = target?.inputs?.find(p => p.id === edge.target_port);
    if (!output || !input || !compatible(output.type, input.type, types))
      report('A saved connection has incompatible ports', edge.target, edge.target_port, 'inputs', edge.id);
    // A signal is not a dependency: a signal input takes any number of wires, and signals may go in circles.
    if (isSignal(output?.type)) continue;
    const a = endpoints(edge.source, edge.source_port, 'outputs')[0][0];
    for (const b of endpoints(edge.target, edge.target_port, 'inputs')) {
      const bk = key(...b);
      if (occupied.has(bk))
        for (const item of [occupied.get(bk), edge])
          report('Each input accepts only one connection', item.target, item.target_port, 'inputs', item.id);
      occupied.set(bk, edge);
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a).push(b[0]);
      resolved.push([a, b[0], edge]);
    }
  }
  // Iterative strongly connected components (Kosaraju) avoid recursion limits on large graphs.
  const reverse = new Map(),
    order = [],
    seen = new Set();
  for (const [a, targets] of adjacency)
    for (const b of targets) {
      if (!reverse.has(b)) reverse.set(b, []);
      reverse.get(b).push(a);
    }
  for (const root of adjacency.keys()) {
    const stack = [[root, false]];
    while (stack.length) {
      const [nid, finished] = stack.pop();
      if (finished) order.push(nid);
      else if (!seen.has(nid)) {
        seen.add(nid);
        stack.push([nid, true]);
        for (const t of adjacency.get(nid) || []) stack.push([t, false]);
      }
    }
  }
  const components = new Map(),
    assigned = new Set();
  for (const root of order.reverse()) {
    if (assigned.has(root)) continue;
    const component = new Set(),
      stack = [root];
    while (stack.length) {
      const nid = stack.pop();
      if (assigned.has(nid)) continue;
      assigned.add(nid);
      component.add(nid);
      stack.push(...(reverse.get(nid) || []));
    }
    for (const nid of component) components.set(nid, component);
  }
  for (const [a, b, edge] of resolved)
    if (components.get(a)?.has(b) && (a === b || components.get(a).size > 1))
      report('Graph contains a cycle', edge.target, edge.target_port, 'inputs', edge.id);
  return issues.sort(
    (x, y) =>
      Number(!x.message.startsWith('Complex Node binding')) - Number(!y.message.startsWith('Complex Node binding'))
  );
}

/** Fills in children, depth and the nodes of every group, including those of the groups inside it. */
function groupTree(groups) {
  const byId = new Map(groups.map(g => [g.id, g])),
    children = new Map();
  for (const g of groups) {
    const list = children.get(g.parent) ?? [];
    list.push(g.id);
    children.set(g.parent, list);
  }
  for (const g of groups) g.children = children.get(g.id) ?? [];
  const visit = (g, trail = new Set()) => {
    if (g.all_members) return g;
    trail.add(g.id);
    g.depth = g.parent && byId.has(g.parent) && !trail.has(g.parent) ? visit(byId.get(g.parent), trail).depth + 1 : 0;
    g.all_members = [...g.members];
    return g;
  };
  for (const g of groups) visit(g);
  for (const g of [...groups].sort((a, b) => b.depth - a.depth)) {
    const parent = byId.get(g.parent);
    if (parent) parent.all_members.push(...g.all_members);
  }
  return groups;
}

/** `structure`: only the nodes, groups and Complex Nodes, with no ports, wires or diagnostics (cheap; enough where only what exists, where it sits or how it is styled matters). */
function buildSnapshot(project, workflow, doc, structure = false) {
  // Shallow copies: the document of a request is its own, and nothing edits a node's config in place.
  const nodes = doc.nodes.map(n => ({...n}));
  for (const node of nodes) {
    if (doc.layout[node.id]) node.position = {...doc.layout[node.id]};
    const style = doc.style[node.id] || {};
    node.pinned = !!style.pinned;
    node.folded = !!style.folded;
    node.disabled = !!style.disabled;
    node.color = style.color ?? null;
  }
  const ids = new Set(nodes.map(n => n.id));
  const groups = doc.groups.map(g => ({
    ...g,
    members: g.members.filter(id => ids.has(id)),
    parent: g.parent ?? null,
  }));
  for (const group of groups) {
    const k = 'group:' + group.id,
      style = doc.style[k] || {};
    if (doc.layout[k]) group.position = {...doc.layout[k]};
    group.pinned = !!style.pinned;
    group.folded = !!style.folded;
    group.disabled = !!style.disabled;
    group.color = style.color ?? null;
  }
  groupTree(groups);
  // A group that is disabled switches off everything inside it: `muted` marks what is off only because of a group around it.
  const mutedNodes = new Set(groups.filter(g => g.disabled).flatMap(g => g.all_members));
  for (const node of nodes) node.muted = mutedNodes.has(node.id);
  const groupById = new Map(groups.map(g => [g.id, g]));
  for (const group of groups) {
    group.muted = false;
    const ancestors = new Set();
    for (let up = groupById.get(group.parent); up; up = groupById.get(up.parent)) {
      if (ancestors.has(up.id)) throw bad('Groups cannot contain cycles');
      ancestors.add(up.id);
      if (up.disabled) group.muted = true;
    }
  }
  const byId = new Map(groups.map(g => [g.id, g]));
  const wrapped = new Set(doc.complex.map(c => c.id).filter(id => byId.has(id)));
  // The Complex Nodes nested in each one, in group order: one walk up the parents instead of a
  // scan of every group for every Complex Node.
  const innerOf = new Map();
  for (const g of groups)
    if (wrapped.has(g.id)) {
      const trail = new Set();
      for (let up = byId.get(g.parent); up && !trail.has(up.id); up = byId.get(up.parent)) {
        trail.add(up.id);
        if (!wrapped.has(up.id)) continue;
        const list = innerOf.get(up.id) ?? [];
        list.push('complex:' + g.id);
        innerOf.set(up.id, list);
      }
    }
  const complexes = doc.complex
    .filter(c => byId.has(c.id))
    .map(c => {
      const g = byId.get(c.id),
        inner = innerOf.get(g.id) ?? [];
      // Linked Library instances keep their definition ownership. Inline compositions
      // belong to this workflow and can be opened and edited with the existing controls.
      const locked = !!c.source;
      return {
        id: c.id,
        group_id: c.id,
        name: g.name,
        depth: g.depth,
        color: g.color,
        pinned: g.pinned,
        folded: g.folded,
        disabled: g.disabled,
        muted: g.muted,
        position: doc.layout['complex:' + c.id],
        locked,
        source: c.source ?? null,
        grants: c.source && c.grants ? [...c.grants] : null,
        ...(c.refresh_error ? {refresh_error: c.refresh_error} : {}),
        // The nodes inside that have widgets: a node placed from the Library shows them on itself.
        widget_nodes: c.source ? g.all_members.filter(id => doc.widgets?.[id]?.length) : [],
        arbitrary: {inputs: !!c.arbitrary?.inputs, outputs: !!c.arbitrary?.outputs},
        interface: {inputs: [], outputs: [], ...clone(c.interface)},
        collapsed: locked || !!c.collapsed,
        compact_width: c.compact_width ?? 240,
        compact_height: c.compact_height ?? 90,
        members: [...g.all_members, ...inner],
      };
    });
  for (const g of groups) g.has_complex = wrapped.has(g.id);
  const types = doc.types ?? [];
  // schema() copies port lists: ask once per node, for ports and diagnostics alike.
  const schemas = new Map();
  const schemaOf = node => {
    let found = schemas.get(node.id);
    if (!found) {
      found = schema(node);
      schemas.set(node.id, found);
    }
    return found;
  };
  const edges = structure ? [] : annotate(nodes, groups, complexes, doc.port_edges, schemaOf);
  const snapshot = {
    project_id: project.id,
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    cursor: doc.cursor,
    nodes,
    edges,
    groups: groups.filter(g => g.members.length || g.children.length || g.position),
    complex: complexes,
    widgets: clone(doc.widgets ?? {}),
    types: clone(types),
    library_nodes: clone(doc.library_nodes ?? []),
    root: doc.root ?? null,
  };
  snapshot.diagnostics = structure ? [] : diagnostics(snapshot, schemaOf);
  return snapshot;
}
/** True when `group` sits somewhere below the group `ancestor`. */
function isInside(byId, group, ancestor) {
  const seen = new Set();
  for (let g = byId.get(group.parent); g; g = byId.get(g.parent)) {
    if (seen.has(g.id)) throw bad('Groups cannot contain cycles');
    seen.add(g.id);
    if (g.id === ancestor) return true;
  }
  return false;
}
