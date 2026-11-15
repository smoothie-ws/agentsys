'use strict';

exports.analyze = graph => {
  const ids = new Set([...(graph.nodes || []).map(n => n.id), ...(graph.complex || []).map(n => 'complex:' + n.id)]);
  const connected = new Set(), errors = [];
  for (const edge of graph.edges || []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push({kind: 'dangling', edge});
    connected.add(edge.source); connected.add(edge.target);
  }
  // A Library wrapper's interface binds its internal Script ports. Those are connected through the wrapper
  // even though the public edge list stores the external connection at the complex node boundary.
  for (const node of graph.complex || []) {
    if (!connected.has('complex:' + node.id)) continue;
    for (const port of [...(node.interface?.inputs || []), ...(node.interface?.outputs || [])])
      for (const binding of port.bound || []) if (binding.node_id) connected.add(binding.node_id);
  }
  return {
    nodes: ids.size,
    edges: (graph.edges || []).length,
    disconnected: [...ids].filter(id => !connected.has(id)),
    customNodes: (graph.complex || []).filter(n => n.source).map(n => ({id: n.id, resource: n.source.resource_id})),
    errors,
    diagnostics: graph.diagnostics || [],
  };
};
