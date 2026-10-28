// Creating, moving and removing wires, and binding Complex Node ports.
'use strict';

// ----- wires -----
function startWire(event, nodeId, socket) {
  const endpoint = (id, sock) => ({
    id,
    port: sock.dataset.port,
    dir: sock.dataset.dir,
    face: sock.dataset.face || '',
    interface: sock.dataset.interface,
  });
  let from = endpoint(nodeId, socket),
    previous = null,
    sides = null,
    origin = null,
    moved = false;
  // A Complex Node's interface slot is one dot with two faces. Dragging it toward something inside the group
  // uses the internal face (acts as the opposite kind of socket); anywhere else uses the external one.
  const frameComplex = nodeId.startsWith('complex:') ? W.complex.get(nodeId.slice(8)) : null;
  if (frameComplex && socket.closest('.frame-ports')) {
    sides = {
      complex: frameComplex,
      external: from,
      internal: endpoint(nodeId, socket.closest('.port').querySelector('.sock.internal')),
    };
  }
  if (from.dir === 'in' && !from.face) {
    previous = visibleEdges().find(e => e.target === nodeId && e.target_port === from.port);
    if (previous) {
      origin = {id: nodeId, port: from.port};
      from = {id: previous.source, port: previous.source_port, dir: 'out', face: ''};
      if (sides) sides.external = from;
    }
  }
  const pointOf = f => socketPoint(f.id, f.dir, f.port, f.face);
  const press = {x: event.clientX, y: event.clientY};
  W.canvas.classList.add('wiring');
  drag(
    event,
    e => {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) moved = true;
      const cursor = toWorld(e.clientX, e.clientY);
      $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
      target(e)?.element.classList.add('drop-target');
      const a = pointOf(from);
      drawWires(from.dir === 'out' ? {a, b: cursor} : {a: cursor, b: a});
    },
    async e => {
      W.canvas.classList.remove('wiring');
      $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
      const drop = target(e);
      drawWires();
      if (e.type === 'pointercancel') return;
      // Dragging a wire off the input it was attached to, and letting go in empty space, unplugs it.
      if (previous && moved && !drop) return disconnect(previous.id);
      if (!drop || drop.id === from.id) return;
      if (previous && origin && drop.id === origin.id && drop.port === origin.port) return;
      const out = from.dir === 'out' ? from : drop,
        input = from.dir === 'in' ? from : drop;
      if (out.face === 'internal') return bindComplexPort(out.id.slice(8), 'inputs', out.port, input);
      if (input.face === 'internal') return bindComplexPort(input.id.slice(8), 'outputs', input.port, out);
      await connect(out, input, previous);
    }
  );
  function target(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY),
      element = hit?.closest('.node,.frame');
    if (sides) from = sides.complex.members.includes(element?.dataset.id) ? sides.internal : sides.external;
    if (!element) return null;
    const id = element.dataset.id,
      node = W.nodes.get(id),
      desired = from.dir === 'out' ? 'in' : 'out';
    if (element.classList.contains('frame')) {
      const framePort = hit.closest('.frame-ports .port');
      if (!framePort) return null;
      // A node inside the group binds to the port's internal face (toward the group's own members);
      // anything else wires to its external face (toward the outside world).
      const complex = W.complex.get(element.dataset.frame);
      const internal = complex?.members.includes(from.id);
      const sock = framePort.querySelector(internal ? '.sock.internal' : '.sock.external');
      const hitFrame = sock && sock.dataset.dir === desired ? {...endpoint(id, sock), element: sock} : null;
      return hitFrame && endpointsFit(from, hitFrame) ? hitFrame : null;
    }
    const sock = hit.closest('.sock') || hit.closest('.port')?.querySelector(`.sock[data-dir=${desired}]`);
    if (sock) {
      const hitSocket = sock.dataset.dir === desired ? {...endpoint(id, sock), element: sock} : null;
      return hitSocket && endpointsFit(from, hitSocket) ? hitSocket : null;
    }
    // Dropped on the node itself: the first free port that the wire fits.
    const free = (node?.[desired === 'in' ? 'inputs' : 'outputs'] || []).find(
      p => (desired === 'out' || !p.connected || isSignal(p.type)) && endpointsFit(from, {id, port: p.id, dir: desired, face: ''})
    );
    return free ? {id, port: free.id, dir: desired, face: '', element} : null;
  }
}

/**
 * Binds the slot `portId` of a Complex Node to the port `endpoint` inside it, or (`unbind`: {node_id, port_id}) takes one binding away.
 * An input may be bound to several ports inside, so a new binding is added; an output has one, so the new binding replaces it.
 */
async function bindComplexPort(groupId, direction, portId, endpoint, unbind = null) {
  await Inspector.pending?.();
  const cx = W.complex.get(groupId);
  if (endpoint && !cx.members.includes(endpoint.id))
    throw new Error('Connect this port to something inside the Complex Node.');
  const memberPort = endpoint && W.nodes.get(endpoint.id)?.[direction].find(p => p.id === endpoint.port);
  if (endpoint && !memberPort) throw new Error('Connect this port to a port inside the Complex Node.');
  const next = {
    ...cx.interface,
    [direction]: cx.interface[direction].map(p => {
      if (p.id !== portId) return p;
      const {bound = [], ...rest} = p,
        other = b => !(endpoint && b.node_id === endpoint.id && b.port_id === endpoint.port) && !(unbind && b.node_id === unbind.node_id && b.port_id === unbind.port_id),
        added = endpoint ? [{node_id: endpoint.id, port_id: endpoint.port}] : [],
        next = direction === 'inputs' ? [...bound.filter(other), ...added] : endpoint ? added : bound.filter(other);
      return next.length ? {...rest, bound: next} : rest;
    }),
  };
  await api(`projects/${W.project}/complex/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    body: wf({interface: next}),
    edit: editToken(),
  });
  Inspector.editing = null;
  Inspector.pending = null;
  await reload();
}
const edgeChange = edge => ({
  source: edge.source,
  target: edge.target,
  source_port: edge.source_port,
  target_port: edge.target_port,
});
async function connect(from, to, previous = null) {
  const change = {source: from.id, source_port: from.port, target: to.id, ...(to.port ? {target_port: to.port} : {})};
  await api(`projects/${W.project}/port-connections`, {
    method: 'POST',
    body: wf({add: [change], ...(previous ? {remove: [edgeChange(previous)]} : {})}),
    edit: editToken(),
  });
  await reload();
}

const disconnect = edgeId => disconnectMany([edgeId]);

async function disconnectMany(ids) {
  const edges = W.snapshot.edges.filter(e => ids.includes(e.id));
  if (!edges.length) return;
  await api(`projects/${W.project}/port-connections`, {
    method: 'POST',
    body: wf({remove: edges.map(edgeChange)}),
    edit: editToken(),
  });
  W.edges.clear();
  await reload();
}

/** The middle of a wire, in canvas coordinates. */
function edgeMiddle(edge) {
  const a = socketPoint(edge.source, 'out', edge.source_port),
    b = socketPoint(edge.target, 'in', edge.target_port);
  return a && b ? {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2} : null;
}

/** Breaks wires in the middle: a Reroute point appears there, which can be moved and wired onward. */
async function splitEdges(ids) {
  const splits = W.snapshot.edges
    .filter(e => ids.includes(e.id))
    .map(e => ({edge_id: e.id, position: edgeMiddle(e)}))
    .filter(s => s.position)
    .map(s => ({edge_id: s.edge_id, position: {x: Math.round(s.position.x - 11), y: Math.round(s.position.y - 11)}}));
  if (!splits.length) return;
  const result = await api(`projects/${W.project}/split-connections`, {
    method: 'POST',
    body: wf({splits}),
    edit: editToken(),
  });
  W.edges.clear();
  await reload();
  select(result.ids);
}
