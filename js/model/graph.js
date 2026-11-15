// Read-only graph snapshot operations shared by the client and the server.
// No mutation editor, snapshot construction, interpreter or browser dependencies.
'use strict';

// Shared snapshot/import contracts: event names and an empty durable document.
const EVENT_OPS = new Set(['on_run', 'on_read', 'on_placed', 'on_deleted', 'on_input_connected', 'on_widget']);
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

/**
 * Follows Complex Node ports down to the node ports they are bound to: [[node ID, port ID], ...].
 * One unbound port stays on the wrapper; only an input may be bound to several ports. The editor
 * wraps its errors as ApiError; the interpreter uses the messages as they are. The Worker source
 * carries this function (js/backend/scripts.js), so it must not use anything outside its arguments.
 */
function resolvePort(nodes, nodeId, portId, direction, seen = new Set()) {
  const address = nodeId + '|' + portId;
  if (seen.has(address)) throw Error('Cyclic interface binding');
  const node = nodes.get(nodeId);
  if (!node) throw Error('Node not found: ' + nodeId);
  if (node.kind !== 'complex') return [[nodeId, portId]];
  const item = node.interface[direction].find(p => p.id === portId);
  if (!item) throw Error('Complex Node port not found: ' + portId);
  return item.bound?.length
    ? item.bound.flatMap(b => resolvePort(nodes, b.node_id, b.port_id, direction, new Set(seen).add(address)))
    : [[nodeId, portId]];
}

const Graph = {
  nodeMap(snapshot) {
    return new Map(
      [
        ...snapshot.nodes,
        ...snapshot.groups.map(g => ({...g, id: 'group:' + g.id, kind: 'group', inputs: [], outputs: []})),
        ...snapshot.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'})),
      ].map(n => [n.id, n])
    );
  },
  /** Follows Complex Node ports down to the node ports they are bound to: [[node ID, port ID], ...] (an unbound port stays on the wrapper; only an input is bound to several). */
  resolveAll(nodes, nodeId, portId, direction, seen = new Set()) {
    try {
      return resolvePort(nodes, nodeId, portId, direction, seen);
    } catch (error) {
      // Graph edits report invalid bindings as bad requests; the resolver itself is shared with the interpreter.
      throw bad(error.message);
    }
  },
  /** The first port a Complex Node port is bound to (the only one of an output). */
  resolve(nodes, nodeId, portId, direction) {
    return Graph.resolveAll(nodes, nodeId, portId, direction)[0];
  },
};

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

const IMAGE_DISPLAY = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const DISPLAY_PARTS = '\u001e';
