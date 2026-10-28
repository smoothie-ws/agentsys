// Evaluates nodes of a snapshot (Run button, the evaluate-node API, runs): the part of the workflow the nodes need is compiled into
// a plan (compilePlan) and carried out by executePlan (executor.js), in a Web Worker (runPlan in backend/scripts.js) or in the tests
// in this process. This file does not know either: the plan is data and `execute` is a callback.
'use strict';

const MAX_RESULT = 20000000; // characters of one node's result (as JSON)
const MAX_RUN_BYTES = 100000000; // all results of one evaluation
const MAX_CHAIN = 1000; // nodes waiting for each other, or signals that follow each other
const MAX_ROOTS = 200;
const MAX_PARALLEL = 16; // Custom nodes whose code runs at the same time in one run
const MAX_DISPLAY = 100000;
const MAX_DISPLAY_IMAGE = 3000000 + 64; // an image shown with display() is a data URL of at most this many characters
/** What display() leaves for an image (see displayText in scripts.js). */
const IMAGE_DISPLAY = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const DISPLAY_PARTS = '\u001e'; // separates the values of display(a, b, ...)
const clipDisplay = text =>
  text
    .split(DISPLAY_PARTS)
    .map(part => part.slice(0, part.length > MAX_DISPLAY && IMAGE_DISPLAY.test(part) ? MAX_DISPLAY_IMAGE : MAX_DISPLAY))
    .join(DISPLAY_PARTS);

const evalLabel = node =>
  (node.node_type === 'custom' && node.config?.title) || node.label || node.name || node.node_type;

/** The first problem of every node: the snapshot's diagnostics, then those a Complex Node passes on to its members. */
function firstIssues(snapshot) {
  const issues = new Map();
  for (const {node_id, message} of snapshot.diagnostics) if (!issues.has(node_id)) issues.set(node_id, message);
  for (const cx of snapshot.complex) {
    const own = 'complex:' + cx.id;
    if (issues.has(own)) for (const member of cx.members) if (!issues.has(member)) issues.set(member, issues.get(own));
  }
  return issues;
}

/**
 * Where every input gets its value from. Wires are followed through Complex Nodes, so a wrapper costs nothing at run time:
 *  incoming    target key -> [node, port] the wire starts at (the outermost Complex Node port that publishes it)
 *  fallback    target key -> the default of an input nothing is wired to (the outermost one that has a default wins)
 */
function wireGraph(snapshot, nodes) {
  const incoming = new Map(),
    fallback = new Map(),
    signals = []; // [{source, target}]: a signal wire, from the output the wire starts at to the input it ends at
  for (const node of nodes.values())
    if (node.node_type === 'custom')
      for (const p of node.inputs || []) if ('default' in p) fallback.set(key(node.id, p.id), p.default);
  for (const cx of [...snapshot.complex].sort((a, b) => b.depth - a.depth))
    for (const p of cx.interface.inputs)
      if ('default' in p) {
        try {
          for (const target of Editor.resolveAll(nodes, 'complex:' + cx.id, p.id, 'inputs'))
            fallback.set(key(...target), p.default);
        } catch {}
      }
  // Complex Nodes, inner ones first. A wire is looked up in them by the port it is bound to, so each wire only meets
  // the wrappers that publish it, not all of them.
  const wrappers = [...snapshot.complex]
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
  for (const edge of snapshot.edges) {
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
function instanceScopes(snapshot) {
  const byId = new Map(snapshot.nodes.map(n => [n.id, n])),
    scopes = new Map();
  const composites = snapshot.complex.filter(c => c.source).sort((a, b) => b.depth - a.depth);
  for (const node of snapshot.nodes) {
    const c = composites.find(cx => cx.members.includes(node.id));
    if (c)
      scopes.set(node.id, {
        group: c.id,
        instance_id: 'complex:' + c.id,
        widgets: c.members.filter(m => !m.startsWith('complex:') && snapshot.widgets?.[m]?.length),
        // What a Script of the copy reads: every data input of the node. What it writes: the data outputs no node inside feeds. What it fires
        // with emit(name): the signal outputs no node inside feeds.
        inputs: c.interface.inputs.filter(p => !isSignal(p.type)),
        outputs: c.interface.outputs.filter(p => !isSignal(p.type) && !p.bound?.length),
        signals: c.interface.outputs.filter(p => isSignal(p.type) && !p.bound?.length),
        resource_id: c.source.resource_id,
      });
  }
  return scopes;
}

/** The plan entry of a Custom node: what it is (`op`), its data inputs (and the signal ones), its outputs and where its signals go. */
function customStep(
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
    scope_signals: scopeSignals,
    outputs: (outputs ?? (config.outputs || [])).map(p => ({
      id: p.id,
      name: p.name,
      ...(isSignal(p.type) ? {signal: true} : {}),
    })),
    // What was typed into the controls of outputs (see `editable`): the node starts with it as its output.
    preset: Object.fromEntries((config.outputs || []).filter(p => 'default' in p).map(p => [p.name, p.default])),
    targets,
    event,
    context,
    declared: {capabilities: config.capabilities ?? [], grants: config.grants ?? []},
  };
}

/**
 * Turns the part of a workflow that the roots need into a plan (plain data, see executePlan): every wire resolved through Complex
 * Nodes, every default and widget value in place, a node with a problem left out (what wires to it gets `{err}`), and for every
 * signal output the nodes its signal reaches. A root is a node to fire (an event node), to run (a Script) or to read.
 * `events` is the data the event nodes in the roots carry: {node ID: {output name: value}}.
 */
function compilePlan(snapshot, roots, {context = {}, events = {}, cache = new Map()} = {}) {
  const nodes = Editor.nodeMap(snapshot),
    {incoming, fallback, signals} = wireGraph(snapshot, nodes),
    issues = firstIssues(snapshot),
    widgets = snapshot.widgets ?? {},
    scopes = instanceScopes(snapshot),
    // The Library node copies that have a Script: their free data outputs are written by it, and kept as the results of the copy.
    scripted = new Set(
      snapshot.nodes
        .filter(n => n.node_type === 'custom' && n.config?.op === 'script' && scopes.has(n.id))
        .map(n => scopes.get(n.id).instance_id)
    ),
    types = new TypeTable(snapshot.types);
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
  const planned = new Map(),
    stack = [];
  /** Adds a node (and, later, what it needs) to the plan. */
  const need = nid => {
    if (!planned.has(nid) && nodes.has(nid) && !issues.has(nid) && !isOff(nodes.get(nid))) {
      planned.set(nid, null);
      stack.push(nid);
    }
  };
  const compileNode = nid => {
    const node = nodes.get(nid),
      custom = node.node_type === 'custom';
    const entry = (owner, p) => {
      if (isSignal(p.type)) return {id: p.id, name: p.name, signal: true};
      const wire = incoming.get(key(owner, p.id)),
        found = wire ? refOf(wire) : null,
        off = !!found?.off,
        literal = !!found && 'value' in found;
      if (literal) return {id: p.id, name: p.name, ref: null, has: true, fallback: found.value};
      const ref = off ? null : found;
      if (ref?.n) need(ref.n);
      // A wire from a node that is switched off counts as no wire: the default of the input applies.
      const has = (!wire || off) && fallback.has(key(owner, p.id));
      return {id: p.id, name: p.name, ref, has, ...(has ? {fallback: fallback.get(key(owner, p.id))} : {})};
    };
    // A Library node copy that a Script writes to: it keeps what the Scripts put in its free outputs (a running node of its own).
    if (node.kind === 'complex') {
      // Reading the copy brings its on_read nodes (and what their signals reach) along.
      for (const r of readers.get(nid) ?? []) need(r);
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
      for (const list of Object.values(targets)) list.forEach(need);
      const scope = scopes.get(nid);
      for (const r of readers.get(scope?.instance_id) ?? []) need(r);
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
      for (const list of Object.values(scopeSignals)) list.forEach(need);
      // What a Script writes goes to the copy (see above), so whatever reads the copy's output needs it planned.
      if (script && scope) need(scope.instance_id);
      return customStep(node, inputs, {
        scope: script ? (scope?.instance_id ?? null) : null,
        outputs: script ? (scope?.outputs ?? []) : null,
        scopeSignals,
        targets,
        event: EVENT_OPS.has(node.config?.op) ? (events[nid] ?? {}) : null,
        context: {
          ...context,
          node_id: nid,
          instance_id: scope?.instance_id ?? null,
          resource_id: scope?.resource_id ?? null,
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
  const rootSpecs = roots.map(nid => {
    const node = nodes.get(nid);
    if (!node) return {id: nid, node: true}; // deleted between admission and a later segment
    if (node.node_type === 'custom') {
      if (isOff(node)) return {id: nid, error: 'The node is disabled'};
      if (issues.has(nid)) return {id: nid, error: issues.get(nid)};
      need(nid);
      return {id: nid, node: true};
    }
    const ports = (node.outputs || []).map(p => {
      const found = refOf([nid, p.id]),
        ref = found?.off ? null : found;
      if (ref?.n) need(ref.n);
      return {id: p.id, ref};
    });
    return {id: nid, ports};
  });
  while (stack.length) {
    const nid = stack.pop();
    const node = nodes.get(nid),
      home = scopes.get(nid);
    // Indexes are rebuilt from the committed document. Executable entries are rebuilt only when their
    // resolved inputs, scope, signals or diagnostics change; layout never enters this key.
    const source = (owner, ports) =>
      ports.map(p => {
        const wire = incoming.get(key(owner, p.id));
        return [p.id, wire ? refOf(wire) : null, fallback.get(key(owner, p.id))];
      });
    const signature = TextGraph.canonical({
      kind: node.kind,
      node_type: node.node_type,
      config: node.config,
      inputs: node.inputs,
      interface: node.interface,
      label: evalLabel(node),
      home,
      sources: source(nid, node.inputs ?? []),
      scope_sources: home ? source(home.instance_id, home.inputs) : [],
      targets: targetsOf(node),
      scope_targets: (home?.signals ?? []).map(p => [p.name, reach(fires.get(key(home.instance_id, p.id)) ?? [])]),
      readers: readers.get(home?.instance_id ?? nid),
      widgets: [widgets[nid], ...(home?.widgets ?? []).map(id => widgets[id])],
    });
    let cached = cache.get(nid);
    if (cached?.signature !== signature) {
      const before = new Set(planned.keys());
      const step = compileNode(nid);
      // Include dependencies already planned as well as newly discovered ones.
      const needs = [
        ...(step.inputs ?? []).flatMap(p => (p.ref?.n ? [p.ref.n] : [])),
        ...Object.values(step.targets ?? {}).flat(),
        ...Object.values(step.scope_signals ?? {}).flat(),
        ...(readers.get(home?.instance_id ?? nid) ?? []),
        ...(step.scope ? [step.scope] : []),
        ...[...planned.keys()].filter(id => !before.has(id)),
      ];
      cached = {signature, step, needs};
      cache.set(nid, cached);
    }
    cached.needs.forEach(need);
    const step = clone(cached.step);
    step.context = {...step.context, ...context};
    if (step.event !== null && step.event !== undefined) step.event = events[nid] ?? {};
    planned.set(nid, step);
  }
  for (const id of cache.keys()) if (!nodes.has(id) || issues.has(id)) cache.delete(id);
  return {
    nodes: [...planned.values()],
    roots: rootSpecs,
    context: {...context},
    limits: planLimits(),
    diagnostics: Object.fromEntries(issues),
  };
}

/**
 * The plan of one hook (`hook`: on_placed, on_deleted, on_wired or on_widget) of the copy of a Library node in the group `groupId`: its event
 * nodes of that kind fire, and the graph does the rest. `data` is what the event carries (the wired inputs, the widget).
 */
function hookPlan(snapshot, hook, groupId, data, context) {
  const scopes = instanceScopes(snapshot);
  const starts = snapshot.nodes
    .filter(n => n.node_type === 'custom' && n.config?.op === hook && !isOff(n) && scopes.get(n.id)?.group === groupId)
    .map(n => n.id);
  if (!starts.length) return null;
  return compilePlan(snapshot, starts, {context, events: Object.fromEntries(starts.map(id => [id, data]))});
}
/** What the engine keeps within (see executePlan). */
const planLimits = () => ({
  result: MAX_RESULT,
  bytes: MAX_RUN_BYTES,
  chain: MAX_CHAIN,
  timeout: SCRIPT_TIMEOUT,
  parallel: MAX_PARALLEL,
});

/** The nodes to evaluate must be 1 to MAX_ROOTS nodes of this workflow; the error says which of these it is. */
function checkRoots(roots, nodes) {
  if (!roots.length) throw bad('Nothing to run: pass at least one node ID (node_ids)');
  if (roots.length > MAX_ROOTS) throw bad(`Run at most ${MAX_ROOTS} nodes at once (got ${roots.length})`);
  const unknown = roots.filter(id => typeof id !== 'string' || !nodes.has(id));
  if (unknown.length)
    throw bad(
      `Not a node of this workflow: ${unknown.slice(0, 3).map(String).join(', ')}${unknown.length > 3 ? '…' : ''}. If the workflow was just changed, reload the page.`
    );
}

/**
 * Carries out a plan with `execute(plan, onEvent, signal)` and gathers what happened: {outputs, errors, done, failed, displays}, by
 * node id. `hooks` (all optional) are told when a node starts, completes, fails or is skipped (its wave was cancelled, see node.flow in
 * docs/engine.md): onNodeStart({node_id, label}),
 * onNodeDone({node_id, label, ms, display}), onNodeFail({node_id, label, ms, error}), onNodeSkip({node_id, label}). When the run itself stops (cancelled, or the
 * Worker died) the nodes in flight fail and every root that has no result takes the error; `crash` is that error.
 */
async function runPlanned(plan, execute, {signal = null, hooks = {}, control = null} = {}) {
  const outputs = {},
    errors = {},
    done = [],
    failed = [],
    running = new Map(),
    displays = {};
  const fail = (event, error) => {
    failed.push(event.id);
    if (event.announced || !signal?.aborted)
      hooks.onNodeFail?.({node_id: event.id, label: event.label, ms: event.ms, error, blocked: event.blocked});
  };
  const onEvent = event => {
    switch (event.ev) {
      case 'start':
        running.set(event.id, event);
        hooks.onNodeStart?.({
          node_id: event.id,
          label: event.label,
          node_version: event.node_version,
          invocation: event.invocation,
          wave_path: event.wave_path,
        });
        break;
      case 'done':
        running.delete(event.id);
        done.push(event.id);
        if (typeof event.display === 'string') displays[event.id] = clipDisplay(event.display);
        hooks.onNodeDone?.({
          node_id: event.id,
          label: event.label,
          ms: event.ms,
          display: typeof event.display === 'string' ? displays[event.id] : undefined,
        });
        break;
      case 'fail':
        running.delete(event.id);
        fail(event, event.error);
        break;
      case 'skip':
        hooks.onNodeSkip?.({
          node_id: event.id,
          label: event.label,
          reason: event.reason,
          invocation: event.invocation,
          wave_path: event.wave_path,
        });
        break;
      case 'blocked':
        hooks.onNodeBlocked?.({
          node_id: event.id,
          label: event.label,
          reason: event.reason,
          node_version: event.node_version,
          invocation: event.invocation,
        });
        break;
      case 'waiting':
        running.delete(event.id);
        hooks.onNodeWait?.({node_id: event.id, label: event.label, wait: event.wait});
        break;
      case 'root':
        // A root that reports again: the last report is its result.
        if ('error' in event) {
          errors[event.id] = event.error;
          delete outputs[event.id];
        } else {
          outputs[event.id] = event.outputs;
          delete errors[event.id];
        }
    }
  };
  let crash = null;
  let execution = null;
  try {
    execution = await execute(plan, onEvent, signal, control);
  } catch (error) {
    crash = error;
    for (const event of running.values()) fail({...event, announced: true, ms: 0}, error.message);
    for (const {id} of plan.roots) if (!(id in outputs) && !(id in errors)) errors[id] = error.message;
  }
  return {outputs, errors, done, failed, displays, crash, execution};
}

/** Evaluates nodes of a snapshot. `execute(plan, onEvent, signal)` carries out a plan (runPlan in backend/scripts.js: it is
 *  where the JavaScript of Custom nodes runs). With `collect`, each root reports its own error instead of failing the call.
 *  `signal` (AbortSignal) cancels the evaluation; `hooks` are told about every node (see runPlanned).
 *  Answers {outputs, errors, status, evaluated_nodes, displays}, everything by node id. */
async function evaluateGraph(
  snapshot,
  rootIds,
  execute,
  {collect = false, context = {}, events = {}, signal = null, hooks = {}, control = null} = {}
) {
  const nodes = Editor.nodeMap(snapshot),
    roots = [...new Set(rootIds)];
  checkRoots(roots, nodes);
  const {outputs, errors, done, failed, displays, crash} = await runPlanned(
    compilePlan(snapshot, roots, {context, events}),
    execute,
    {signal, hooks, control}
  );
  if (!collect) {
    if (crash) throw crash;
    const first = roots.find(id => id in errors);
    if (first) throw new Error(errors[first]);
  }
  const status = {};
  for (const id of done) status[id] = 'completed';
  for (const id of failed) status[id] = 'failed';
  return {outputs, errors, status, evaluated_nodes: done.length, displays};
}
