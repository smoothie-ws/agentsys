// The stored shape of a workflow document, and copying one with fresh ids.
//
// A document holds: nodes (function nodes: Custom and Reroute), layout, style, groups, complex, port_edges, widgets
// (the widgets code put on nodes: {node ID: [{id, kind, label, value, ...}]}), types (see model/types.js),
// and library_nodes (the Library resource IDs included in this workflow's Add menu; empty by default).
// A group is only a visual frame around nodes (and other groups). A Complex Node wraps one group: it adds ports
// bound to ports inside the group and is shown as one node. docs/architecture.md describes the data model.
'use strict';

const emptyDoc = () => ({
  cursor: 0,
  nodes: [],
  layout: {},
  style: {},
  groups: [],
  complex: [],
  port_edges: [],
  widgets: {},
  types: [],
  library_nodes: [],
});
const stateOf = doc => ({
  nodes: doc.nodes,
  layout: doc.layout,
  style: doc.style,
  groups: doc.groups,
  complex: doc.complex,
  port_edges: doc.port_edges,
  widgets: doc.widgets,
  types: doc.types ?? [],
  library_nodes: doc.library_nodes ?? [],
});

/** What the interpreter can observe of a document: everything but where nodes sit and how they are coloured, pinned or folded. */
const semanticKey = state =>
  JSON.stringify([
    state.nodes,
    state.groups,
    state.complex,
    state.port_edges,
    state.widgets,
    state.types ?? [],
    state.library_nodes ?? [],
    Object.entries(state.style ?? {})
      .filter(([, style]) => style?.disabled)
      .map(([id]) => id)
      .sort(),
  ]);

/** Copies a workflow document with fresh IDs (used for duplicated workflows and projects). */
function duplicateDocument(doc, mapped = () => {}) {
  const map = new Map();
  const fresh = () => 'record:' + uid();
  for (const n of doc.nodes) map.set(n.id, fresh());
  const groupMap = new Map(doc.groups.map(g => [g.id, uid()]));
  for (const [old, neu] of groupMap) {
    map.set('group:' + old, 'group:' + neu);
    map.set('complex:' + old, 'complex:' + neu);
  }
  const m = id => map.get(id) ?? id;
  const copy = emptyDoc();
  copy.types = clone(doc.types ?? []);
  copy.library_nodes = clone(doc.library_nodes ?? []);
  copy.nodes = doc.nodes.map(n => ({...clone(n), id: m(n.id)}));
  copy.layout = Object.fromEntries(
    Object.entries(doc.layout)
      .filter(([k]) => map.has(k))
      .map(([k, v]) => [m(k), clone(v)])
  );
  copy.style = Object.fromEntries(
    Object.entries(doc.style)
      .filter(([k]) => map.has(k))
      .map(([k, v]) => [m(k), clone(v)])
  );
  copy.groups = doc.groups.map(g => ({
    ...clone(g),
    id: groupMap.get(g.id),
    members: g.members.filter(i => map.has(i)).map(m),
    parent: g.parent ? (groupMap.get(g.parent) ?? null) : null,
  }));
  copy.complex = doc.complex
    .filter(c => groupMap.has(c.id))
    .map(c => {
      const iface = clone(c.interface || {inputs: [], outputs: []});
      for (const p of [...(iface.inputs || []), ...(iface.outputs || [])])
        if (p.bound) p.bound = p.bound.map(b => ({...b, node_id: m(b.node_id)}));
      return {...clone(c), id: groupMap.get(c.id), interface: iface};
    });
  copy.port_edges = doc.port_edges
    .filter(e => map.has(e.source) && map.has(e.target))
    .map(e => ({...e, id: uid(), source: m(e.source), target: m(e.target)}));
  for (const [nid, list] of Object.entries(doc.widgets)) if (map.has(nid)) copy.widgets[m(nid)] = clone(list);
  mapped(map);
  return copy;
}
