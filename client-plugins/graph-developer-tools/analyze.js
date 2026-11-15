'use strict';

exports.analyze = graph => {
  const ids = new Set([...(graph.nodes || []).map(n => n.id), ...(graph.complex || []).map(n => 'complex:' + n.id)]);
  const connected = new Set(), errors = [];
  for (const edge of graph.edges || []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push({kind: 'dangling', edge});
    connected.add(edge.source); connected.add(edge.target);
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
