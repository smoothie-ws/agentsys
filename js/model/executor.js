// The part of the engine that runs a workflow. A run is compiled into a plan (compilePlan in evaluate.js: plain data, every wire
// already resolved) and this function carries it out: one Web Worker (or, in the tests, this process) for the whole run.
// It is written to be embedded as source text in the Worker (see backend/scripts.js), so it uses nothing but its own body and `env`.
'use strict';

/**
 * Carries out a plan (the model is in docs/engine.md). Data is read when a node runs and needs it; things happen when a
 * signal reaches a node.
 *
 *   plan.nodes   [{id, label, kind: 'custom' | 'reroute' | 'plain', op, running, prefix, inputs: [{id, name, signal?, ref, has, fallback}],
 *                  outputs: [{id, name, signal?}], preset: {output name: typed value},
 *                  targets: {signal output ID: [node ID]}, event: {output name: value} | null, context}]
 *   plan.roots   [{id, node: true} | {id, ports: [{id, ref}]} | {id, error}]
 *   a `ref` says where a value comes from: {n: node id, p: port id}, {err: message} or null (nothing: undefined)
 *   env          {AsyncFunction, displayText(values), emit(event), call(node id, method, path, body, query), gate? ({paused, waiters}: a pause),
 *                 limits: {result, bytes, chain, timeout, parallel}}
 *   events       {ev: 'start' | 'done' | 'fail' | 'skip' | 'pause' | 'resume' | 'root', ...}; every root ends with one 'root' event
 *                ('skip': a node did not start because the wave it belongs to was cancelled, see *Flow control* below)
 *
 * Nodes are *pure* (values, Reroutes: computed when read, once in each read) or *running* (a Script, the
 * event nodes: they do something when a signal reaches them and keep their latest outputs, which is what a read of them gives;
 * before they ran, undefined). A Library node's copy that contains an on_read node (a *read scope*) computes its outputs when they
 * are read: the first read fires the on_read and waits until what its signal started has finished; later reads give the result
 * again until something the scope reads has changed (a result of another node that is not the same as before), and then it is
 * computed again. Dependencies are brought up to date first, in the order of the inputs. A signal output goes to every node it is wired to at once; they run independently. A root is
 * fired (an event node), run as if a signal reached it (a Script) or read (a pure node, or the ports of a Complex Node).
 * The run lasts until nothing is running.
 *
 * Every value that crosses from one node to another is kept as JSON and read back for each reader, so a node can change what it
 * received without anyone else seeing it. The code of a Script gets `node` (the Library node it is in: input, output, emit, display, widgets, reread),
 * `agentsys` and `context` as its own variables; nothing is added to the global scope.
 */
async function executePlan(plan, env) {
  const {AsyncFunction, displayText, emit, call, limits, gate, authorize} = env;
  const nodes = new Map(plan.nodes.map(n => [n.id, n]));
  const saved = plan.checkpoint;
  const journal = saved?.journal ?? {};
  const waiting = new Map();
  const writers = new Map((saved?.writers ?? []).map(([id, entries]) => [id, new Map(entries)]));
  const affected = new Set(plan.recovery?.affected ?? []);
  const ready = new Map(
    [...affected].map(key => {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => {});
      return [key, {promise, resolve, reject}];
    })
  );
  const saveBoundary = async () => {
    if (env.checkpoint && plan.capture_boundaries) await env.checkpoint(copyOf(snapshot()));
  };
  const stateUpdates = new Map();
  const serializeStateUpdate = (key, work) => {
    const next = (stateUpdates.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    stateUpdates.set(key, next);
    return next.finally(() => {
      if (stateUpdates.get(key) === next) stateUpdates.delete(key);
    });
  };
  const suspend = () => Object.assign(new Error('Run suspended'), {suspend: true, control: 'suspend'});
  const latest = new Map(); // node id -> Map(port id -> {v: value} | {j: json text of an object}): what a running node left last
  const sizes = new Map(); // node id -> characters of its latest result (what counts against limits.bytes)
  const pending = new Set(); // runs of Scripts that have not ended: the run lasts until they have
  const queue = [];
  const versions = new Map(), // node id -> how many times its latest result has changed
    signatures = new Map(), // node id -> its latest result as text, to see whether a new one is different
    dependencyCache = new Map(), // read scope -> [ids of the running nodes outside it that it reads]
    states = new Map(), // read scope -> {seen: Map(node id -> version read), at, done, promise, error}
    readNodes = new Map(); // read scope -> ids of its on_read nodes
  let bytes = 0,
    active = 0,
    tick = 0; // grows whenever any latest result changes
  const scopeOf = node => node?.context?.instance_id ?? null;
  for (const n of plan.nodes)
    if (n.op === 'on_read' && scopeOf(n)) readNodes.set(scopeOf(n), [...(readNodes.get(scopeOf(n)) ?? []), n.id]);
  const SCOPE = 'scope:';
  const nodeVersions = {...saved?.node_versions};
  let boundaryIndex = 0,
    graphRevision = 0;
  const patches = [];
  const cancellations = [];
  const cancelledPaths = new Set(plan.cancelled_waves ?? []);
  const cancelWave = path => {
    cancelledPaths.add(path);
    if (waves.has(path)) waves.get(path).cancelled = true;
  };
  if (gate) gate.cancelWave = path => cancellations.push(path);
  if (gate) gate.patch = patch => patches.push(patch);
  const applyPatch = patch => {
    for (const id of patch.remove) nodes.delete(id);
    for (const step of patch.upsert) nodes.set(step.id, step);
    plan.nodes = [...nodes.values()];
    plan.roots = patch.roots;
    plan.diagnostics = patch.diagnostics;
    readNodes.clear();
    for (const n of nodes.values())
      if (n.op === 'on_read' && scopeOf(n)) readNodes.set(scopeOf(n), [...(readNodes.get(scopeOf(n)) ?? []), n.id]);
    dependencyCache.clear();
    graphRevision++;
    tick++;
    for (const st of states.values()) {
      st.done = false;
      st.key = null;
    }
    for (const n of patch.upsert) if (n.op === 'scope' && !latest.has(n.id)) keep(n.id, collect(n, n.preset));
  };
  const boundary = () => {
    const at = boundaryIndex++;
    if (plan.replay) {
      while (plan.replay_patches?.[0]?.at === at) applyPatch(plan.replay_patches.shift().patch);
      while (plan.replay_controls?.[0]?.at === at) cancelWave(plan.replay_controls.shift().path);
    } else {
      for (const path of cancellations.splice(0)) {
        cancelWave(path);
        emit({ev: 'wave_cancelled', at, path});
      }
      for (const patch of patches.splice(0)) {
        applyPatch(patch);
        emit({ev: 'patched', at, patch});
      }
    }
  };

  // ----- Flow control -----

  /** A wave is what one emit() started: the signal and everything it caused. Waves form a tree like a call stack (`parent` is the wave of
   *  the emit that started the Script that emitted). A cancelled wave (and every wave below it) starts nothing new; what already runs finishes.
   *  `handles` are the control signals ("break", "continue") that the emit which opened the wave answers; `control` says which one arrived;
   *  `failFast`: the first failure inside the wave cancels it. */
  const waves = new Map();
  const newWave = (parent, {handles = [], failFast = false} = {}, key = 'run') => {
    const old = saved?.waves?.[key];
    const wave = {
      key,
      parent,
      cancelled: (old?.cancelled ?? false) || cancelledPaths.has(key),
      control: old?.control ?? null,
      handles: new Set(handles),
      failFast,
    };
    waves.set(key, wave);
    emit({ev: 'wave', path: key, parent: parent?.key ?? null, cancelled: wave.cancelled});
    return wave;
  };
  const runWave = newWave(null); // every wave is below it: cancelling it stops the whole run (node.flow.abort())
  const recoveredReads = new Map();
  const restoreWave = path => {
    if (waves.has(path)) return waves.get(path);
    const old = saved?.waves?.[path];
    return newWave(old?.parent ? restoreWave(old.parent) : null, old ?? {}, path);
  };
  const recoverRead = key => {
    const record = journal[key];
    if (!record?.read_key || record.status === 'done') return Promise.resolve();
    let root = key;
    while (journal[root]?.parent && journal[journal[root].parent]?.read_key === record.read_key)
      root = journal[root].parent;
    if (!recoveredReads.has(root)) {
      const entry = journal[root];
      recoveredReads.set(
        root,
        run(entry.node_id, {
          key: root,
          parent: entry.parent,
          depth: 0,
          via: new Set(),
          read_key: entry.read_key,
          wave: restoreWave(entry.wave_path),
        })
      );
    }
    return recoveredReads.get(root);
  };
  const cancelledWave = wave => {
    for (let w = wave; w; w = w.parent) if (w.cancelled) return true;
    return false;
  };
  /** What node.flow.break() & co throw to end the code of the Script that called them: not a failure of the node. */
  const control = what => Object.assign(new Error(`node.flow.${what}()`), {control: what});

  /** Code runs a few nodes at a time; the rest wait here (a node waiting for its inputs or in emit() does not take a place). */
  const take = () =>
    active < limits.parallel ? (active++, Promise.resolve()) : new Promise(resolve => queue.push(resolve));
  /** While the run is paused (`gate.paused`) no code starts and none goes on after an emit(); what is running finishes first. */
  const enter = async () => {
    while (gate?.paused) await new Promise(resolve => gate.waiters.push(resolve));
    return take();
  };
  const leave = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  const unwrap = entry => (entry === undefined ? undefined : 'j' in entry ? JSON.parse(entry.j) : entry.v);
  /** What a node left for one port, as an entry that every reader copies out for itself (so nobody sees another's changes). */
  const entryOf = (value, text) =>
    typeof value === 'string' || typeof value === 'boolean'
      ? {v: value}
      : value !== null && typeof value === 'object'
        ? {j: text}
        : {v: JSON.parse(text)};
  const copyOf = value => (value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);
  const jsonValue = value =>
    JSON.parse(
      JSON.stringify(value, (_, v) => {
        if (['function', 'symbol', 'bigint'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)))
          throw plain('Value must be JSON data');
        return v;
      })
    );
  /** An error that is the node's own message as it is: it does not get the "Node code:" prefix of an error in code. */
  const plain = message => Object.assign(new Error(message), {plain: true});
  const EMPTY = new Map();
  // A Library node copy that Scripts write to starts with what was typed into its outputs.
  for (const n of plan.nodes)
    if (n.op === 'scope') {
      const map = new Map(),
        text = {};
      for (const p of n.outputs) {
        const t = Object.hasOwn(n.preset, p.name) ? JSON.stringify(n.preset[p.name]) : undefined;
        if (t !== undefined) map.set(p.id, entryOf(n.preset[p.name], t));
      }
      keep(n.id, {
        map,
        size: [...map.values()].reduce((a, e) => a + ('j' in e ? e.j.length : JSON.stringify(e.v).length), 0),
      });
    }

  // ----- Reading data -----
  if (saved) {
    latest.clear();
    sizes.clear();
    versions.clear();
    signatures.clear();
    for (const [id, entries] of saved.latest) latest.set(id, new Map(entries));
    for (const [id, size] of saved.sizes) sizes.set(id, size);
    for (const [id, version] of saved.versions) versions.set(id, version);
    for (const [id, signature] of saved.signatures) signatures.set(id, signature);
    for (const [id, state] of saved.read_states ?? [])
      states.set(id, {
        ...state,
        seen: new Map(state.seen),
        promise: null,
        error: state.error ? new Error(state.error) : null,
      });
    bytes = saved.bytes;
    tick = saved.tick;
    if (Object.entries(saved.node_versions ?? {}).some(([id, version]) => nodes.get(id)?.content_hash !== version)) {
      tick++;
      for (const st of states.values()) {
        st.done = false;
        st.key = null;
      }
    }
  }

  /** The entry a ref points at (undefined: nothing). `scope` remembers the pure nodes read so far in this read; `path` the ones being read. */
  async function entryAt(ref, scope, path) {
    if (!ref) return undefined;
    if (ref.err) throw new Error(ref.err);
    const result = (await outputsOf(ref.n, scope, path)).get(ref.p);
    const writer = writers.get(ref.n)?.get(ref.p);
    if (writer && scope.consumer && writer !== scope.consumer) {
      const record = journal[scope.consumer];
      if (!record.dependencies.includes(writer)) record.dependencies.push(writer);
      const source = {invocation: writer, port: ref.p};
      const sources = (record.input_sources[scope.input] ??= []);
      if (!sources.some(s => s.invocation === writer && s.port === ref.p)) sources.push(source);
    }
    return result;
  }
  /** The outputs of a node: the latest of a running one, the value of a pure one (computed once in a read). */
  function outputsOf(id, scope, path) {
    boundary();
    const node = nodes.get(id),
      home = scopeOf(node);
    if (!node) return Promise.reject(plain(plan.diagnostics?.[id] ?? 'Node removed: ' + id));
    nodeVersions[id] = node.content_hash;
    if (node.running) {
      const give = () => latest.get(id) ?? EMPTY;
      // The outputs of a read scope are brought up to date first (unless the reader is inside it).
      return readNodes.has(home) && !path.has(SCOPE + home) ? freshen(home, path).then(give) : Promise.resolve(give());
    }
    if (path.has(id)) return Promise.reject(new Error('Graph contains a cycle'));
    if (path.size >= limits.chain)
      return Promise.reject(new Error(`Graph evaluation reaches more than ${limits.chain} chained nodes`));
    const cacheKey = id + '/' + node.content_hash;
    if (!scope.has(cacheKey)) {
      const promise = Promise.resolve().then(() => {
        boundary();
        const current = nodes.get(id);
        if (!current) throw plain(plan.diagnostics?.[id] ?? 'Node removed: ' + id);
        return compute(current, scope, new Set(path).add(id));
      });
      scope.set(cacheKey, promise);
    }
    return scope.get(cacheKey);
  }
  /** The entry an input gives: what is wired to it, else its default (none: undefined). */
  async function inputEntry(p, scope, path) {
    if (p.ref) return entryAt(p.ref, scope, path);
    if (!p.has || p.fallback === undefined) return undefined;
    const text = JSON.stringify(p.fallback);
    return text === undefined ? undefined : entryOf(copyOf(p.fallback), text);
  }
  /** A node that is computed when read: a Reroute (passes its input on) or a node that holds the values typed into its outputs. */
  async function compute(node, scope, path) {
    const result = new Map();
    if (node.kind === 'reroute') {
      const entry = node.inputs[0] && (await inputEntry(node.inputs[0], scope, path));
      if (entry !== undefined) result.set('out', entry);
    } else if (node.kind === 'custom') {
      // A node without an operation only holds what was typed into its outputs.
      for (const p of node.outputs)
        if (!p.signal && node.preset && Object.hasOwn(node.preset, p.name)) {
          const text = JSON.stringify(node.preset[p.name]);
          if (text !== undefined) result.set(p.id, entryOf(node.preset[p.name], text));
        }
    }
    return result;
  }
  /** What the code of a node left in `output` for its data ports: {map, size}. */
  function collect(node, output) {
    const map = new Map();
    let size = 0;
    if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
      // What the code of a Script puts in `output` must be a free output of its Library node: a slip in a name is an error, not a value that goes nowhere.
      if (node.op === 'script')
        for (const name of Object.keys(output)) {
          if (node.outputs.some(p => p.name === name)) continue;
          if (Object.hasOwn(node.scope_signals ?? {}, name))
            throw plain(`“${name}” is a signal output: fire it with node.emit("${name}")`);
          throw plain(
            node.scope
              ? `The Library node has no free output “${name}” (an output that a node inside feeds cannot be set by code)`
              : `This Script is not in a Library node, so it has no outputs to set: “${name}”`
          );
        }
      for (const p of node.outputs) {
        if (p.signal || !Object.hasOwn(output, p.name)) continue;
        const text = JSON.stringify(output[p.name]);
        if (text === undefined) {
          if (output[p.name] !== undefined && node.op === 'script')
            throw plain(`node.output.${p.name} cannot be sent: a function or a symbol is not data`);
          continue;
        }
        size += text.length + p.id.length + 4;
        if (size > limits.result) throw plain('Graph evaluation exceeds the output size limit');
        map.set(p.id, entryOf(output[p.name], text));
      }
    }
    return {map, size};
  }
  /** What a node's code left in `output` becomes what readers get: a Script writes into the copy it is in (what it did not set stays as it was). */
  function commit(node, output, invocation) {
    const result = collect(node, output);
    if (invocation) {
      const owner = node.scope ?? node.id;
      if (!writers.has(owner)) writers.set(owner, new Map());
      for (const port of result.map.keys()) writers.get(owner).set(port, invocation);
      Object.assign(journal[invocation], {result: [...result.map], output_value: copyOf(output)});
    }
    if (!node.scope) return keep(node.id, result);
    const map = new Map([...(latest.get(node.scope) ?? EMPTY), ...result.map]);
    let size = 0;
    for (const [port, entry] of map)
      size += ('j' in entry ? entry.j.length : JSON.stringify(entry.v).length) + port.length + 4;
    if (size > limits.result) throw plain('Graph evaluation exceeds the output size limit');
    keep(node.scope, {map, size});
  }
  /** The result of a running node from now on (what readers get), counted against the limit of the run. */
  function keep(id, {map, size}) {
    bytes += size - (sizes.get(id) || 0);
    sizes.set(id, size);
    if (bytes > limits.bytes) throw plain('Graph evaluation exceeds the output size limit');
    latest.set(id, map);
    const signature = [...map]
      .map(([port, entry]) => port + '=' + ('j' in entry ? entry.j : JSON.stringify(entry.v)))
      .join('\u0001');
    if (signatures.get(id) !== signature) {
      signatures.set(id, signature);
      versions.set(id, (versions.get(id) ?? 0) + 1);
      tick++;
    }
  }

  // ----- Read scopes -----

  /** The running nodes outside the scope whose results its nodes read (through Reroutes and nodes that are computed when read). */
  function dependencies(scope) {
    if (dependencyCache.has(scope)) return dependencyCache.get(scope);
    const found = new Set();
    const origin = (ref, seen) => {
      const n = ref?.n && nodes.get(ref.n);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      if (n.running) found.add(n.id);
      else for (const p of n.inputs) if (!p.signal) origin(p.ref, seen);
    };
    for (const n of plan.nodes)
      if (scopeOf(n) === scope) for (const p of n.inputs) if (!p.signal) origin(p.ref, new Set());
    const list = [...found].filter(id => scopeOf(nodes.get(id)) !== scope);
    dependencyCache.set(scope, list);
    return list;
  }
  /** Brings the outputs of a read scope up to date: computes them if they never were, or if something they read has changed. */
  function freshen(scope, path) {
    const mark = SCOPE + scope;
    if (path.has(mark)) return Promise.reject(new Error('Graph contains a cycle'));
    if (path.size >= limits.chain)
      return Promise.reject(new Error(`Graph evaluation reaches more than ${limits.chain} chained nodes`));
    let st = states.get(scope);
    if (!st) states.set(scope, (st = {seen: new Map(), at: -1, done: false, promise: null, error: null}));
    if (!st.promise) {
      if (st.done && st.at === tick) return st.error ? Promise.reject(st.error) : Promise.resolve();
      const state = st;
      state.promise = update(scope, state, new Set(path).add(mark), tick).finally(() => (state.promise = null));
    }
    return st.promise.then(() => {
      if (st.error) throw st.error;
    });
  }
  async function update(scope, st, path, at) {
    const revision = graphRevision;
    try {
      let stale = !st.done;
      for (const id of dependencies(scope)) {
        const home = scopeOf(nodes.get(id));
        if (readNodes.has(home)) await freshen(home, path);
        if (st.seen.get(id) !== (versions.get(id) ?? 0)) stale = true;
      }
      if (stale) {
        for (const id of dependencies(scope)) st.seen.set(id, versions.get(id) ?? 0);
        st.error = null;
        const via = new Set([...path].filter(x => typeof x === 'string' && x.startsWith(SCOPE)));
        st.key ??= `read:${scope}:${tick}`;
        const outcomes = await Promise.allSettled(
          (readNodes.get(scope) ?? []).map(id =>
            track(
              run(id, {
                depth: 0,
                read_key: st.key,
                via,
                key: `${st.key}:${id}`,
                wave: newWave(runWave, {}, `${st.key}:${id}`),
              })
            )
          )
        );
        const bad = outcomes.find(o => o.status === 'rejected');
        if (bad) st.error = bad.reason;
      }
      st.done = !st.error?.suspend && revision === graphRevision;
      if (st.done) st.key = null;
    } catch (error) {
      // A scope it reads failed: this one fails with the same error, and is computed again when read again.
      st.error = error;
      st.done = false;
    }
    st.at = at;
  }

  // ----- Signals -----

  /** A signal leaves the output `port` of a node: every node it is wired to runs, at the same time. Answers when they and what they
   *  started have finished; throws the first error (in the order of the wires). */
  const fire = (node, port, ctx) => {
    boundary();
    return fireTo(nodes.get(node.id)?.targets[port.id] || [], {...ctx, invocation: ctx.key});
  };
  async function fireTo(ids, ctx) {
    if (!ids.length) return;
    if (ctx.depth >= limits.chain) throw plain(`Signal chain is longer than ${limits.chain} nodes`);
    const outcomes = await Promise.allSettled(
      ids.map((id, i) =>
        trigger(id, {...ctx, parent: ctx.invocation ?? ctx.key, depth: ctx.depth + 1, key: `${ctx.key}/${i}:${id}`})
      )
    );
    const bad =
      outcomes.find(o => o.status === 'rejected' && !o.reason?.suspend) ?? outcomes.find(o => o.status === 'rejected');
    if (bad) throw bad.reason;
  }
  /** A signal reaches a node. In a cancelled wave it does not start. */
  function trigger(id, ctx) {
    const node = nodes.get(id);
    if (node && !node.running) return Promise.resolve();
    if (cancelledWave(ctx.wave)) {
      emit({ev: 'skip', id, label: node?.label});
      return Promise.resolve();
    }
    return track(run(id, ctx));
  }
  const track = promise => {
    const entry = promise.catch(() => {}).finally(() => pending.delete(entry));
    pending.add(entry);
    return promise;
  };
  /** The execution of a running node (a Script or an event node). Answers when it and what its signals started have finished. */
  async function run(id, ctx) {
    boundary();
    let node = nodes.get(id);
    const previous = journal[ctx.key];
    if (previous && ['waiting', 'running'].includes(previous.status) && previous.node_version !== node?.content_hash) {
      delete journal[ctx.key];
      if (plan.resolutions) delete plan.resolutions[ctx.key];
    }
    if (previous?.status === 'done') {
      if (plan.recovery && previous.output_value && node) commit(node, previous.output_value, ctx.key);
      return;
    }
    if (cancelledWave(ctx.wave)) {
      journal[ctx.key] = {
        ...previous,
        node_id: id,
        status: 'done',
        wave_path: ctx.wave.key,
        parent: ctx.parent ?? null,
      };
      emit({ev: 'skip', id, invocation: ctx.key, wave_path: ctx.wave.key, reason: 'wave_cancelled'});
      return;
    }
    if (previous?.status === 'failed') throw plain(previous.error);
    if (journal[ctx.key]?.status === 'waiting' && !plan.resolutions?.[ctx.key]) {
      waiting.set(ctx.key, previous.wait);
      throw suspend();
    }
    journal[ctx.key] ??= {node_id: id, status: 'running'};
    Object.assign(journal[ctx.key], {
      parent: ctx.parent ?? null,
      wave_path: ctx.wave.key,
      read_key: ctx.read_key ?? null,
    });
    const record = journal[ctx.key];
    record.status = 'running';
    if (node)
      Object.assign(record, {
        node_version: node.content_hash,
        label: node.label,
        scope: node.scope ?? node.id,
        schema: node.outputs.filter(p => !p.signal),
        signals:
          node.op === 'script'
            ? Object.keys(node.scope_signals ?? {})
            : node.outputs.filter(p => p.signal).map(p => p.id),
      });
    record.dependencies ??= [];
    record.input_sources ??= {};
    record.emissions ??= [];
    const replacement = plan.recovery?.override;
    if (replacement?.invocation === ctx.key) {
      if (!node) throw plain('Cannot replace output of a removed node');
      commit(node, replacement.output, ctx.key);
      if (node.op !== 'script') node.event = copyOf(replacement.output);
      Object.assign(record, {status: 'running', overridden: true, error: null});
      waiting.delete(ctx.key);
      ready.get(ctx.key)?.resolve();
      emit({ev: 'overridden', id, invocation: ctx.key, node_version: node.content_hash, wave_path: ctx.wave.key});
      await saveBoundary();
      for (let i = 0; i < replacement.signals.length; i++) {
        const name = replacement.signals[i];
        const original = replacement.emissions?.[i];
        const childKey = original?.key ?? `${ctx.key}/emit:${i}`;
        const wave = newWave(ctx.wave, original?.options, childKey);
        const targets = node.op === 'script' ? nodes.get(id)?.scope_signals?.[name] : nodes.get(id)?.targets?.[name];
        record.emissions.push({name, key: childKey, options: original?.options ?? {}});
        if (!targets) throw plain('Selected signal output was removed');
        await fireTo(targets, {...ctx, invocation: ctx.key, wave, key: childKey});
      }
      record.status = 'done';
      await saveBoundary();
      return;
    }
    try {
      const result = await execute(id, ctx);
      if (result === false) {
        journal[ctx.key].status = 'done';
        ready.get(ctx.key)?.resolve();
        await saveBoundary();
        return;
      }
      node = result;
      // An event node fires its signal output when it is fired; a Script fires nothing by itself (it has emit).
      if (node.op !== 'script') for (const port of node.outputs.filter(p => p.signal)) await fire(node, port, ctx);
      journal[ctx.key].status = 'done';
      ready.get(ctx.key)?.resolve();
      await saveBoundary();
    } catch (error) {
      if (!error.suspend) {
        Object.assign(journal[ctx.key], {status: 'failed', error: error.message});
        ready.get(ctx.key)?.reject(error);
      }
      await saveBoundary();
      throw error;
    }
  }
  async function execute(id, ctx) {
    let node = nodes.get(id);
    const announce = event => emit({...event, prefix: node?.prefix, invocation: ctx.key, wave_path: ctx.wave.key});
    const started = Date.now();
    let announced = false,
      holding = false,
      closed = false,
      shown,
      clock = null;
    const give = () => {
      if (holding) {
        holding = false;
        leave();
      }
    };
    try {
      let data, outcomes, record, values;
      while (true) {
        boundary();
        node = nodes.get(id);
        if (!node) {
          if (plan.diagnostics?.[id]) throw plain(plan.diagnostics[id]);
          announce({ev: 'skip', id, reason: 'node_removed', invocation: ctx.key, wave_path: ctx.wave.key});
          return false;
        }
        const retained = journal[ctx.key];
        if (retained.node_version && retained.node_version !== node.content_hash) {
          journal[ctx.key] = {
            node_id: id,
            status: 'running',
            dependencies: [],
            input_sources: {},
            emissions: [],
            parent: ctx.parent ?? null,
            wave_path: ctx.wave.key,
          };
          if (plan.resolutions) delete plan.resolutions[ctx.key];
        }
        const path = new Set([node.id, ...ctx.via]); // the scopes being read on the way here are in the path too
        // Every data input at once; the first failure (in port order) is the node's own.
        data = node.inputs.filter(p => !p.signal);
        outcomes = await Promise.allSettled(
          data.map(async p => {
            const sources = journal[ctx.key].input_sources[p.id] ?? [];
            const source = plan.recovery && sources.find(s => affected.has(s.invocation));
            if (source) {
              await recoverRead(source.invocation);
              if (source.invocation !== plan.recovery.override.invocation) await ready.get(source.invocation)?.promise;
              const record = journal[source.invocation];
              if (record?.status === 'failed') throw plain(record.error);
              const entries = new Map(record?.result ?? []);
              return entries.get(source.port);
            }
            const scope = new Map();
            scope.consumer = ctx.key;
            scope.input = p.id;
            return inputEntry(p, scope, path);
          })
        );
        boundary();
        if (nodes.get(id) !== node) continue;
        const bad = outcomes.find(o => o.status === 'rejected');
        if (bad) throw bad.reason;
        record = journal[ctx.key];
        values = record.inputs
          ? new Map(record.inputs)
          : new Map(
              data.map((p, i) => [p.id, outcomes[i].value === undefined ? undefined : unwrap(outcomes[i].value)])
            );
        record.inputs ??= copyOf([...values]);
        await enter();
        holding = true;
        boundary();
        if (nodes.get(id) !== node) {
          give();
          delete record.inputs;
          continue;
        }
        if (cancelledWave(ctx.wave)) {
          announce({ev: 'skip', id, label: node?.label});
          return false;
        }
        const reason = await authorize?.(node.id, node.content_hash, ctx.key);
        boundary();
        if (nodes.get(id) !== node) {
          give();
          delete record.inputs;
          continue;
        }
        if (reason) {
          const error = plain(reason);
          error.blocked = true;
          announce({
            ev: 'blocked',
            id,
            label: node.label,
            reason,
            node_version: node.content_hash,
            invocation: ctx.key,
          });
          throw error;
        }
        break;
      }
      announced = true;
      Object.assign(record, {
        node_version: node.content_hash,
        label: node.label,
        scope: node.scope ?? node.id,
        schema: node.outputs.filter(p => !p.signal),
        signals:
          node.op === 'script'
            ? Object.keys(node.scope_signals ?? {})
            : node.outputs.filter(p => p.signal).map(p => p.id),
      });
      await saveBoundary();
      nodeVersions[node.id] = node.content_hash;
      announce({
        ev: 'start',
        id: node.id,
        label: node.label,
        node_version: node.content_hash,
        invocation: ctx.key,
        wave_path: ctx.wave.key,
      });
      const own = Date.now();
      const output = {...(node.preset ?? {}), ...(node.event ?? {})};
      // A Script of a Library node reads the outputs of the node as they are now (what was typed there, what a Script left last).
      if (node.scope)
        for (const p of node.outputs) {
          const held = latest.get(node.scope)?.get(p.id);
          if (!p.signal && held !== undefined) output[p.name] = unwrap(held);
        }
      if (record.output) Object.assign(output, copyOf(record.output));
      else record.output = copyOf(output);
      const display = (...parts) => {
        shown = displayText(parts);
      };
      if (node.op === 'script') {
        let callIndex = 0;
        const agentsys = async (method, route, body, query) =>
          call(node.id, method, route, body, query, {
            invocation: ctx.key,
            index: callIndex++,
            node_version: node.content_hash,
          });
        // widgets(list) puts widgets on this node (replacing its list; one that stays keeps its value); widgets.set({id: value}) sets values.
        const widgetsRoute = () => `projects/${node.context.project_id}/widgets/${node.id}`;
        const widgets = Object.assign(list => agentsys('PUT', widgetsRoute(), {widgets: list}), {
          set: values => agentsys('PUT', widgetsRoute(), {values}),
        });
        // context.event: what the event nodes beside it (in the same Library node, or at the root) carry: payload, wired, widget.
        const event = Object.assign(
          {},
          ...plan.nodes.filter(n => n.event && scopeOf(n) === scopeOf(node)).map(n => n.event)
        );
        const context = Object.freeze({...node.context, event});
        const codeInput = node.inputs.find(p => p.code);
        const code = codeInput ? values.get(codeInput.id) : '';
        if (typeof code === 'string' && /\bimport\s*\(/.test(code))
          throw plain('Dynamic import is not available in Script nodes');
        if (code !== undefined && code !== null && typeof code !== 'string')
          throw plain(`${node.prefix}: the script is text`);
        // emit(name): the signal output `name` of the Library node fires now, from the middle of the code; the code does not run, so neither its time
        // limit nor its place among the running nodes counts the wait. The outputs as they are now are what readers get from then on.
        // emit(name, {handles, failFast}) answers what the signal started once it has finished: `handles` (["break", "continue"]) are the control
        // signals this emit takes: when a node calls node.flow.break() or .continue(), the rest of what this emit started does not start, and
        // emit answers "break" or "continue" (else undefined). `failFast`: the first failure in what this emit started cancels the rest of it.
        let emitIndex = 0;
        const emitSignal = async (name, options) => {
          if (typeof name !== 'string') throw plain('node.emit needs the name of a signal output: node.emit("Out")');
          if (closed) throw plain('The code of this node has ended');
          if (options !== undefined && (options === null || typeof options !== 'object'))
            throw plain('node.emit(name, options): the options are an object {handles, failFast}');
          const handles = options?.handles ?? [];
          if (!Array.isArray(handles) || handles.some(h => h !== 'break' && h !== 'continue'))
            throw plain('node.emit: handles is a list of "break" and "continue"');
          // The flow this node belongs to was cancelled: the code ends here (a loop must not go on spinning).
          if (cancelledWave(ctx.wave)) throw control('cancel');
          // A Script has no outputs of its own: it fires a signal output of the Library node it is in that no node inside feeds.
          boundary();
          if (cancelledWave(ctx.wave)) throw control('cancel');
          const current = nodes.get(node.id);
          const targets = Object.hasOwn(current?.scope_signals ?? {}, name)
            ? current.scope_signals[name]
            : current
              ? null
              : [];
          if (!targets)
            throw plain(
              node.scope
                ? `The Library node has no free signal output “${name}”`
                : `This Script is not in a Library node, so it has no signal outputs to fire: “${name}”`
            );
          commit(node, output, ctx.key);
          clock.pause();
          announce({ev: 'pause', id: node.id});
          give();
          const childKey = `${ctx.key}/emit:${emitIndex++}`;
          record.emissions.push({name, key: childKey, options: copyOf(options ?? {})});
          await saveBoundary();
          const wave = newWave(ctx.wave, {handles, failFast: options?.failFast === true}, childKey);
          try {
            await fireTo(targets, {...ctx, invocation: ctx.key, wave, key: childKey});
          } catch (error) {
            if (error.suspend && !cancelledWave(wave)) throw error;
            if (error.suspend) return wave.control ?? undefined;
            throw plain(error.message);
          } finally {
            await enter();
            holding = true;
            announce({ev: 'resume', id: node.id});
            clock.resume();
          }
          return wave.control ?? undefined;
        };
        // node.flow: what the code does to the flow it is in. Each one ends the code of the Script (as `return` does), so what follows does not run;
        // do not catch it (a catch must rethrow an error that has `.control`).
        //   break(), continue()  the nearest emit above that handles it takes it: what that emit started stops starting new nodes. Without one, an error.
        //   cancel()             cancels the wave of the emit above (or, in a Script that nothing emitted for, everything started from its root): no error.
        //   abort()              ends the whole run.
        const unwind = what => {
          const below = [];
          for (let w = ctx.wave; w; w = w.parent) {
            below.push(w);
            if (w.handles.has(what)) {
              for (const x of below) x.cancelled = true;
              w.control = what;
              throw control(what);
            }
          }
          throw plain(
            `node.flow.${what}() outside a loop: no node above handles it (node.emit(name, {handles: ["${what}"]}))`
          );
        };
        const flow = Object.freeze({
          break: () => unwind('break'),
          continue: () => unwind('continue'),
          cancel: () => {
            ctx.wave.cancelled = true;
            throw control('cancel');
          },
          abort: () => {
            runWave.cancelled = true;
            throw control('abort');
          },
        });
        // `node` is the Library node the Script is in: node.input.<name> reads its data inputs, node.output.<name> sets its free data outputs,
        // node.emit(name) fires a free signal output, node.display(...) shows text on it, node.widgets(list) puts widgets on it and
        // node.reread(name) reads an input again.
        const input = Object.freeze(
          Object.fromEntries(node.inputs.filter(p => p.wrapper).map(p => [p.name, values.get(p.id)]))
        );
        // node.reread(name) reads an input again: the latest result of the node it comes from (for a loop that watches a value).
        const reread = async name => {
          const p = node.inputs.find(q => q.wrapper && q.name === name);
          if (!p) throw plain(`This node has no input “${name}”`);
          const scope = new Map();
          scope.consumer = ctx.key;
          scope.input = p.id;
          const entry = await inputEntry(p, scope, new Set([node.id, ...ctx.via]));
          return entry === undefined ? undefined : unwrap(entry);
        };
        // node.cancelled: the flow this node belongs to was cancelled (a long code can look and end early).
        const wait = async (spec, since = null) => {
          if (closed) throw plain('The code of this node has ended');
          if (cancelledWave(ctx.wave)) throw control('cancel');
          if (!spec || typeof spec !== 'object' || Array.isArray(spec))
            throw plain('node.wait needs an event, delay or until');
          const kinds = ['event', 'delay', 'until'].filter(k => Object.hasOwn(spec, k));
          if (kinds.length !== 1) throw plain('node.wait needs exactly one condition');
          if (
            kinds[0] === 'event' &&
            (typeof spec.event !== 'string' ||
              !spec.event ||
              spec.event.length > 100 ||
              (spec.match !== undefined &&
                (!spec.match || typeof spec.match !== 'object' || Array.isArray(spec.match))))
          )
            throw plain('Invalid wait event/match');
          if (kinds[0] === 'delay' && (!Number.isFinite(spec.delay) || spec.delay < 0))
            throw plain('Invalid wait delay');
          if (kinds[0] === 'until' && !Number.isFinite(Date.parse(spec.until))) throw plain('Invalid wait until');
          commit(node, output, ctx.key);
          const created = Date.now();
          const entry = {
            key: ctx.key,
            node_id: node.id,
            wave_path: ctx.wave.key,
            inputs_snapshot: [...values],
            wait_spec: copyOf(spec),
            created_at: since ?? created,
            due: kinds[0] === 'delay' ? created + spec.delay : kinds[0] === 'until' ? Date.parse(spec.until) : null,
          };
          record.status = 'waiting';
          record.wait = entry;
          waiting.set(ctx.key, entry);
          announce({ev: 'waiting', id: node.id, label: node.label, wait: entry});
          await saveBoundary();
          throw suspend();
        };
        const self = Object.freeze({
          state: Object.freeze({
            get: key => agentsys('GET', `workflows/${node.context.workflow_id}/state/${encodeURIComponent(key)}`),
            set: (key, value, options = {}) =>
              agentsys('PUT', `workflows/${node.context.workflow_id}/state/${encodeURIComponent(key)}`, {
                value: jsonValue(value),
                ...options,
              }),
            delete: (key, options = {}) =>
              agentsys('DELETE', `workflows/${node.context.workflow_id}/state/${encodeURIComponent(key)}`, {}, options),
            list: (prefix = '') => agentsys('GET', `workflows/${node.context.workflow_id}/state`, {}, {prefix}),
            update: (key, fn) =>
              serializeStateUpdate(key, async () => {
                if (typeof fn !== 'function') throw plain('state.update requires a function');
                for (let attempt = 0; attempt < 256; attempt++) {
                  let entry;
                  try {
                    entry = await agentsys(
                      'GET',
                      `workflows/${node.context.workflow_id}/state/${encodeURIComponent(key)}`
                    );
                  } catch (error) {
                    if (error.code !== 'not_found') throw error;
                  }
                  const value = jsonValue(await fn(entry?.value));
                  try {
                    return await agentsys(
                      'PUT',
                      `workflows/${node.context.workflow_id}/state/${encodeURIComponent(key)}`,
                      {value, version: entry?.version ?? 0}
                    );
                  } catch (error) {
                    if (error.code !== 'conflict') throw error;
                  }
                }
                throw plain('state.update exhausted its conflict retries');
              }),
          }),
          queue: name => {
            if (typeof name !== 'string' || !name) throw plain('node.queue requires a queue name');
            const path = `workflows/${node.context.workflow_id}/queues/${encodeURIComponent(name)}`;
            return Object.freeze({
              push: async item => {
                const result = await agentsys('POST', path + '/push', {item: jsonValue(item)});
                if (result.blocked) await wait({event: result.event}, result.created_at);
                return result;
              },
              pull: (options = {}) => agentsys('POST', path + '/pull', options),
              ack: id => agentsys('POST', path + '/ack', {id}),
            });
          },
          input,
          output,
          emit: emitSignal,
          display,
          widgets,
          reread,
          flow,
          wait,
          runKey:
            (record.run_key ??= `${affected.has(ctx.key) ? plan.recovery.run_key_root : (plan.context?.virtual_run_id ?? plan.context?.run_id ?? 'evaluation')}/${ctx.key}`),
          resumed: plan.resolutions?.[ctx.key] ?? null,
          get cancelled() {
            boundary();
            return cancelledWave(ctx.wave);
          },
        });
        let drawIndex = 0;
        record.draws ??= [];
        const draw = (kind, real) => {
          const index = drawIndex++;
          const captured = plan.replay ? plan.determinism?.[ctx.key]?.[index] : record.draws[index];
          if (captured) {
            if (captured.kind !== kind)
              throw plain(`Replay diverged at ${node.id}: expected ${captured.kind}, got ${kind}`);
            return captured.value;
          }
          if (plan.replay) throw plain(`Replay diverged at ${node.id}: missing ${kind} #${index}`);
          const value = real();
          record.draws.push({kind, value});
          return value;
        };
        const NativeDate = Date;
        const ScriptDate = function (...args) {
          if (!new.target) return new NativeDate(draw('time', () => NativeDate.now())).toString();
          const value = args.length ? new NativeDate(...args) : new NativeDate(draw('time', () => NativeDate.now()));
          return Object.setPrototypeOf(value, ScriptDate.prototype);
        };
        ScriptDate.now = () => draw('time', () => NativeDate.now());
        ScriptDate.parse = NativeDate.parse;
        ScriptDate.UTC = NativeDate.UTC;
        const dateDescriptors = Object.getOwnPropertyDescriptors(NativeDate.prototype);
        delete dateDescriptors.constructor;
        ScriptDate.prototype = Object.create(Object.prototype, dateDescriptors);
        Object.defineProperty(ScriptDate.prototype, 'constructor', {value: ScriptDate});
        Object.freeze(ScriptDate.prototype);
        const mathDescriptors = Object.getOwnPropertyDescriptors(Math);
        delete mathDescriptors.random;
        const scriptMath = Object.freeze(
          Object.defineProperty(Object.create(null, mathDescriptors), 'random', {
            value: () => draw('random', () => Math.random()),
          })
        );
        clock = deadline(limits.timeout, node.prefix);
        try {
          await Promise.race([
            Promise.resolve().then(() =>
              new AsyncFunction('node', 'agentsys', 'context', 'Date', 'Math', '"use strict";\n' + (code ?? ''))(
                self,
                agentsys,
                context,
                ScriptDate,
                scriptMath
              )
            ),
            clock.limit,
          ]);
        } catch (error) {
          // node.flow.* ended the code on purpose: the node ends normally.
          if (error?.suspend) throw error;
          if (!(error && error.control))
            throw error && (error.timeout || error.plain)
              ? error
              : new Error(`${node.prefix}: ${String((error && error.message) || error).slice(0, 2000)}`);
        } finally {
          clock.stop();
          closed = true;
        }
      }
      commit(node, output, ctx.key);
      give();
      record.display = shown;
      announce({ev: 'done', id: node.id, label: node.label, ms: Date.now() - own, display: shown});
      return node;
    } catch (error) {
      // A failure inside a wave of an emit with failFast cancels that wave (and the ones between).
      if (error?.suspend) throw error;
      const between = [];
      for (let w = ctx.wave; w; w = w.parent) {
        between.push(w);
        if (w.failFast) {
          for (const x of between) x.cancelled = true;
          break;
        }
      }
      announce({
        ev: 'fail',
        id,
        label: node?.label,
        ms: Date.now() - started,
        error: error.message,
        announced,
        blocked: !!error.blocked,
      });
      throw error;
    } finally {
      give();
    }
  }

  /** A time limit that can be paused: the promise `limit` is rejected when the code has run `ms` (not counting the pauses). */
  function deadline(ms, prefix) {
    let timer,
      held = 0,
      stopped = false,
      reject;
    const limit = new Promise((_, no) => (reject = no));
    limit.catch(() => {});
    const arm = () => {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(() => {
        const error = new Error(`${prefix} execution timed out`);
        error.timeout = true;
        reject(error);
      }, ms);
    };
    arm();
    return {
      limit,
      pause: () => (held++, clearTimeout(timer)),
      resume: () => (--held === 0 ? arm() : undefined),
      stop: () => ((stopped = true), clearTimeout(timer)),
    };
  }

  // ----- Roots -----

  /** The outputs of a node as the plain values a root reports. */
  const reported = id => {
    const out = {};
    for (const [port, entry] of latest.get(id) ?? EMPTY) out[port] = unwrap(entry);
    return out;
  };
  async function startRoot(root) {
    try {
      if (root.error) throw new Error(root.error);
      const outputs = {};
      if (root.node) {
        const node = nodes.get(root.id);
        if (!node || node.running) {
          await track(
            run(root.id, {
              depth: 0,
              via: new Set(),
              key: `root:${root.id}`,
              wave: newWave(runWave, {}, `root:${root.id}`),
            })
          ); // a Script runs as if a signal reached it, an event node carries its data and fires
          Object.assign(outputs, reported(node?.scope ?? root.id)); // what a Script sets belongs to its Library node: that is what it reports
        } else
          for (const [port, entry] of await outputsOf(root.id, new Map(), new Set())) outputs[port] = unwrap(entry);
      } else {
        const scope = new Map(),
          path = new Set();
        const got = await Promise.allSettled(root.ports.map(p => entryAt(p.ref, scope, path)));
        const bad = got.find(o => o.status === 'rejected');
        if (bad) throw bad.reason;
        root.ports.forEach((p, i) => (outputs[p.id] = unwrap(got[i].value)));
      }
      emit({ev: 'root', id: root.id, outputs});
    } catch (error) {
      if (error?.suspend) return;
      emit({ev: 'root', id: root.id, error: error.message});
    }
  }

  for (const wait of saved?.waits ?? [])
    if (!nodes.has(wait.node_id) && !plan.diagnostics?.[wait.node_id]) {
      journal[wait.key] = {...journal[wait.key], status: 'done'};
      emit({ev: 'skip', id: wait.node_id, reason: 'node_removed', invocation: wait.key, wave_path: wait.wave_path});
    }
  await Promise.all(plan.roots.map(startRoot));
  // The run lasts as long as there is code running: a Script that signals from a loop is part of it.
  while (pending.size) await Promise.allSettled([...pending]);
  for (const [key, entry] of waiting) {
    const wave = waves.get(entry.wave_path);
    if (wave && cancelledWave(wave)) {
      waiting.delete(key);
      journal[key].status = 'done';
      emit({ev: 'skip', id: entry.node_id, label: nodes.get(entry.node_id)?.label});
    }
  }
  function snapshot() {
    const result = {
      writers: [...writers].map(([id, entries]) => [id, [...entries]]),
      node_versions: nodeVersions,
      journal,
      latest: [...latest].map(([id, entries]) => [id, [...entries]]),
      sizes: [...sizes],
      versions: [...versions],
      signatures: [...signatures],
      bytes,
      tick,
      read_states: [...states].map(([id, s]) => [
        id,
        {
          seen: [...s.seen],
          at: s.at,
          key: s.key ?? null,
          done: s.done,
          error: s.error?.suspend ? null : (s.error?.message ?? null),
        },
      ]),
      waves: {
        ...saved?.waves,
        ...Object.fromEntries(
          [...waves].map(([key, w]) => [
            key,
            {
              parent: w.parent?.key ?? null,
              cancelled: w.cancelled,
              control: w.control,
              handles: [...w.handles],
              failFast: w.failFast,
            },
          ])
        ),
      },
      waits: [...waiting.values()],
      signals_pending: [...waiting.keys()],
      created_at: Date.now(),
    };
    for (const wave of Object.values(result.waves)) wave.active = false;
    for (const entry of Object.values(journal))
      if (['running', 'waiting', 'pending'].includes(entry.status)) {
        for (
          let path = entry.wave_path;
          path && result.waves[path] && !result.waves[path].active;
          path = result.waves[path].parent
        )
          result.waves[path].active = true;
      }
    return result;
  }
  const checkpoint = snapshot();
  if (plan.replay && plan.replay_controls?.length)
    throw plain('Replay diverged: recorded wave controls were not applied');
  if (plan.replay && plan.replay_patches?.length)
    throw plain('Replay diverged: recorded graph patches were not applied');
  return {status: waiting.size ? 'suspended' : 'completed', checkpoint};
}
