// A persistent interpreter for the live graph. Shared values survive signal dispatches.
'use strict';
function createGraphInterpreter(document, saved, env) {
  const {AsyncFunction, displayText, emit, call, gate} = env;
  let view = createGraphView(document, {context: env.context});
  const generations = new Map(),
    readScope = ctx => Object.assign(new Map(), {ctx});
  const nodes = {get: id => view.get(id)};
  let sequence = 0;
  const nextKey = () => 'i' + ++sequence;
  const latest = new Map(); // node id -> Map(port id -> {v: value} | {j: json text of an object}): what a running node left last
  const versions = new Map(), // node id -> how many times its latest result has changed
    signatures = new Map(), // node id -> its latest result as text, to see whether a new one is different
    dependencyCache = new Map(), // read scope -> [ids of the running nodes outside it that it reads]
    states = new Map(), // read scope -> {seen: Map(node id -> version read), at, done, promise, error}
    readNodes = new Map(); // read scope -> ids of its on_read nodes
  let tick = 0,
    stateRevision = 0;
  const scopeOf = node => node?.context?.instance_id ?? null;
  for (const n of view.values())
    if (n.op === 'on_read' && scopeOf(n)) readNodes.set(scopeOf(n), [...(readNodes.get(scopeOf(n)) ?? []), n.id]);
  const SCOPE = 'scope:';
  // Compiled Script code is reusable: the function has no captured state, only its text matters.
  // A bounded LRU keeps loops and repeated signals from compiling the same body again and again.
  const compiledFunctions = new Map();
  let compiledBytes = 0;
  const MAX_COMPILED = 100,
    MAX_COMPILED_BYTES = 8 * 1024 * 1024;
  const compile = code => {
    const text = code ?? '';
    const cached = compiledFunctions.get(text);
    if (cached) {
      compiledFunctions.delete(text);
      compiledFunctions.set(text, cached);
      return cached;
    }
    const fn = new AsyncFunction('node', 'agentsys', 'context', 'Date', 'Math', '"use strict";\n' + text);
    compiledFunctions.set(text, fn);
    compiledBytes += text.length * 2;
    while (compiledFunctions.size > MAX_COMPILED || compiledBytes > MAX_COMPILED_BYTES) {
      const oldest = compiledFunctions.keys().next().value;
      compiledFunctions.delete(oldest);
      compiledBytes -= oldest.length * 2;
    }
    return fn;
  };
  // State and value notifications are coalesced on a microtask: a loop of assignments sends its
  // last values once. The latest values themselves are updated synchronously (see `keep` and
  // `watchState`), so reads and dependencies never observe the deferred notification.
  const queuedEvents = new Map();
  const sentSinceFlush = new Set();
  let flushScheduled = false;
  const flushEvents = () => {
    flushScheduled = false;
    sentSinceFlush.clear();
    if (!queuedEvents.size) return;
    const events = [...queuedEvents.values()];
    queuedEvents.clear();
    for (const make of events) emit(make());
  };
  // The first notification of a key in a turn goes out at once (a long synchronous block must not
  // hide acknowledged state); later ones replace each other and only the last is sent.
  const publish = (key, make) => {
    if (!sentSinceFlush.has(key)) {
      sentSinceFlush.add(key);
      emit(make());
      return;
    }
    queuedEvents.set(key, () => {
      sentSinceFlush.delete(key);
      return make();
    });
    if (!flushScheduled) {
      flushScheduled = true;
      Promise.resolve().then(flushEvents);
    }
  };

  // ----- Flow control -----

  /** A wave is what one emit() started: the signal and everything it caused. Waves form a tree like a call stack (`parent` is the wave of
   *  the emit that started the Script that emitted). A cancelled wave (and every wave below it) starts nothing new; what already runs finishes.
   *  `handles` are the control signals ("break", "continue") that the emit which opened the wave answers; `control` says which one arrived;
   *  `failFast`: the first failure inside the wave cancels it. */
  const newWave = (parent, {handles = [], failFast = false} = {}) => ({
    parent,
    cancelled: false,
    control: null,
    handles: new Set(handles),
    failFast,
  });
  const cancelledWave = wave => {
    for (let w = wave; w; w = w.parent) if (w.cancelled) return true;
    return false;
  };
  /** What node.flow.break() & co throw to end the code of the Script that called them: not a failure of the node. */
  const control = what => Object.assign(new Error(`node.flow.${what}()`), {control: what});

  /** Pause gates new invocations and continuations. */
  const enter = async () => {
    while (gate?.paused) await new Promise(resolve => gate.waiters.push(resolve));
  };
  const unwrap = entry => (entry === undefined ? undefined : 'j' in entry ? JSON.parse(entry.j) : entry.v);
  /** What a node left for one port, as an entry that every reader copies out for itself (so nobody sees another's changes). */
  const entryOf = (value, text) =>
    typeof value === 'string' || typeof value === 'boolean'
      ? {v: value}
      : value === null
        ? {v: null}
        : typeof value === 'number'
          ? Number.isFinite(value)
            ? {v: value}
            : {v: JSON.parse(text)}
          : {j: text};
  const copyOf = value => (value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);
  /** An error that is the node's own message as it is: it does not get the "Node code:" prefix of an error in code. */
  const plain = message => Object.assign(new Error(message), {plain: true});
  const EMPTY = new Map();
  const state = copyOf(saved.state ?? {});
  const stateCopy = value =>
    JSON.parse(
      JSON.stringify(value, function (_, item) {
        if (item === undefined && Array.isArray(this)) return null;
        if (
          ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
          (typeof item === 'number' && !Number.isFinite(item))
        )
          throw plain('context.state accepts JSON values only');
        return item;
      })
    );
  /** A JSON primitive is already a value of its own; only objects and invalid values need the serializer. */
  const stateValue = value =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
      ? value
      : stateCopy(value);
  const watchState = (value, guard, proxies = new WeakMap()) => {
    if (value === null || typeof value !== 'object') return value;
    if (proxies.has(value)) return proxies.get(value);
    const changed = () => {
      stateRevision++;
      tick++;
      // The copy is taken when the notification is sent: a loop of assignments produces one.
      publish('state', () => ({ev: 'state', state: stateCopy(state)}));
    };
    const proxy = new Proxy(value, {
      get: (target, name) => watchState(Reflect.get(target, name), guard, proxies),
      set(target, name, value) {
        guard();
        if (typeof name !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(name))
          throw plain('Invalid state key');
        Reflect.set(target, name, stateValue(value));
        changed();
        return true;
      },
      deleteProperty(target, name) {
        guard();
        Reflect.deleteProperty(target, name);
        changed();
        return true;
      },
      defineProperty() {
        throw plain('Use assignment to change context.state');
      },
      setPrototypeOf() {
        throw plain('context.state accepts JSON values only');
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  for (const [id, values] of Object.entries(saved.outputs ?? {}))
    keep(id, {
      map: new Map(Object.entries(values).map(([port, value]) => [port, entryOf(value, JSON.stringify(value))])),
    });
  // A Library node copy that Scripts write to starts with what was typed into its outputs.
  for (const n of view.values())
    if (n.op === 'scope' && !latest.has(n.id)) {
      const map = new Map();
      for (const p of n.outputs) {
        const t = Object.hasOwn(n.preset, p.name) ? JSON.stringify(n.preset[p.name]) : undefined;
        if (t !== undefined) map.set(p.id, entryOf(n.preset[p.name], t));
      }
      keep(n.id, {
        map,
      });
    }

  // ----- Reading data -----
  /** The entry a ref points at (undefined: nothing). `scope` remembers the pure nodes read so far in this read; `path` the ones being read. */
  async function entryAt(ref, scope, path) {
    if (!ref) return undefined;
    if (ref.err) throw new Error(ref.err);
    return (await outputsOf(ref.n, scope, path)).get(ref.p);
  }
  /** The outputs of a node: the latest of a running one, the value of a pure one (computed once in a read). */
  function outputsOf(id, scope, path) {
    const node = nodes.get(id),
      home = scopeOf(node);
    if (!node) return Promise.reject(plain(Object.fromEntries(view.issues)?.[id] ?? 'Node not found: ' + id));
    if (node.error) return Promise.reject(plain(node.error));
    if (node.running) {
      const give = () => latest.get(id) ?? EMPTY;
      // The outputs of a read scope are brought up to date first (unless the reader is inside it).
      return readNodes.has(home) && !path.has(SCOPE + home)
        ? freshen(home, path, scope.ctx).then(give)
        : Promise.resolve(give());
    }
    if (path.has(id)) return Promise.reject(new Error('Graph contains a cycle'));
    if (!scope.has(id)) {
      const promise = Promise.resolve().then(() => compute(node, scope, new Set(path).add(id)));
      scope.set(id, promise);
    }
    return scope.get(id);
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
  /** What the code of a node left in `output` for its data ports. */
  function collect(node, output) {
    const map = new Map();
    if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
      // What the code of a Script puts in `output` must be a free output of its Library node: a slip in a name is an error, not a value that goes nowhere.
      if (node.op === 'script')
        for (const name of Object.keys(output)) {
          if (node.outputs.some(p => p.name === name)) continue;
          if (Object.hasOwn(node.signals ?? {}, name))
            throw plain(`“${name}” is a signal output: fire it with node.output.${name}.emit()`);
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
        map.set(p.id, entryOf(output[p.name], text));
      }
    }
    return {map};
  }
  /** What a node's code left in `output` becomes what readers get: a Script writes into the copy it is in (what it did not set stays as it was). */
  function commit(node, output) {
    if (!nodes.get(node.id)) return;
    const result = collect(node, output);
    if (!node.scope) return keep(node.id, result);
    const map = new Map([...(latest.get(node.scope) ?? EMPTY), ...result.map]);
    for (const p of node.outputs)
      if (!p.signal && Object.hasOwn(output, p.name) && output[p.name] === undefined) map.delete(p.id);
    keep(node.scope, {map});
  }
  /** Publish the current JSON values and invalidate dependent reads. */
  function keep(id, {map}) {
    latest.set(id, map);
    const signature = [...map]
      .map(
        ([port, entry]) =>
          port +
          '=' +
          ('j' in entry
            ? entry.j
            : typeof entry.v === 'string'
              ? JSON.stringify(entry.v)
              : typeof entry.v + ':' + String(entry.v))
      )
      .join('\u0001');
    if (signatures.get(id) !== signature) {
      signatures.set(id, signature);
      versions.set(id, (versions.get(id) ?? 0) + 1);
      tick++;
      publish('values:' + id, () => ({
        ev: 'values',
        id,
        outputs: Object.fromEntries([...map].map(([port, value]) => [port, unwrap(value)])),
      }));
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
    for (const n of view.values())
      if (scopeOf(n) === scope) for (const p of n.inputs) if (!p.signal) origin(p.ref, new Set());
    const list = [...found].filter(id => scopeOf(nodes.get(id)) !== scope);
    dependencyCache.set(scope, list);
    return list;
  }
  /** Brings the outputs of a read scope up to date: computes them if they never were, or if something they read has changed. */
  function freshen(scope, path, ctx) {
    const mark = SCOPE + scope;
    if (path.has(mark)) return Promise.reject(new Error('Graph contains a cycle'));
    let st = states.get(scope);
    if (!st) states.set(scope, (st = {seen: new Map(), at: -1, done: false, promise: null, error: null}));
    if (!st.promise) {
      if (st.done && st.at === tick) return st.error ? Promise.reject(st.error) : Promise.resolve();
      const state = st;
      state.promise = update(scope, state, new Set(path).add(mark), tick, ctx).finally(() => (state.promise = null));
    }
    return st.promise.then(() => {
      if (st.error) throw st.error;
    });
  }
  async function update(scope, st, path, at, ctx) {
    try {
      let stale = !st.done || st.contextAt !== stateRevision;
      for (const id of dependencies(scope)) {
        const home = scopeOf(nodes.get(id));
        if (readNodes.has(home)) await freshen(home, path, ctx);
        if (st.seen.get(id) !== (versions.get(id) ?? 0)) stale = true;
      }
      if (stale) {
        for (const id of dependencies(scope)) st.seen.set(id, versions.get(id) ?? 0);
        st.error = null;
        const via = new Set([...path].filter(x => typeof x === 'string' && x.startsWith(SCOPE)));
        const work = new Set();
        const outcomes = await Promise.allSettled(
          (readNodes.get(scope) ?? []).map(id =>
            track(
              run(id, {
                ...ctx,
                work,
                via,
                key: nextKey(),
                wave: newWave(ctx?.wave ?? ctx?.batch?.wave ?? null),
              }),
              work
            )
          )
        );
        while (work.size) await Promise.allSettled([...work]);
        const bad = outcomes.find(o => o.status === 'rejected');
        if (bad) st.error = bad.reason;
      }
      st.contextAt = stateRevision;
      st.done = !st.error;
    } catch (error) {
      // A scope it reads failed: this one fails with the same error, and is computed again when read again.
      st.error = error;
      st.done = false;
    }
    st.at = at;
  }

  // ----- Signals -----

  /** Signal descendants, including free Library outputs. A cycle never resets its starting node. */
  function downstream(id) {
    const seen = new Set([id]), pending = [id];
    for (let i = 0; i < pending.length; i++) {
      const node = nodes.get(pending[i]);
      for (const target of Object.values(node?.targets ?? {}).flat().concat(Object.values(node?.signals ?? {}).flat())) {
        if (seen.has(target)) continue;
        seen.add(target);
        pending.push(target);
      }
    }
    return pending.slice(1);
  }

  /** A signal leaves the output `port` of a node: every node it is wired to runs, at the same time. Answers when they and what they
   *  started have finished; throws the first error (in the order of the wires). */
  const fire = (node, port, ctx) => fireTo(nodes.get(node.id)?.targets?.[port.id] || [], ctx);
  async function fireTo(ids, ctx) {
    const outcomes = await Promise.allSettled(ids.map(id => trigger(id, {...ctx, key: nextKey()})));
    const bad = outcomes.find(o => o.status === 'rejected');
    if (bad) throw bad.reason;
  }
  /** A signal reaches a node. In a cancelled wave it does not start. */
  function trigger(id, ctx) {
    const node = nodes.get(id);
    if (!node || (!node.running && !node.error)) return Promise.resolve();
    if (cancelledWave(ctx.wave)) {
      emit({ev: 'skip', id, label: node?.label});
      return Promise.resolve();
    }
    return track(run(id, ctx), ctx.work);
  }
  const track = (promise, work) => {
    const entry = promise.catch(() => {}).finally(() => work.delete(entry));
    work.add(entry);
    return promise;
  };
  /** The execution of a running node (a Script or an event node). Answers when it and what its signals started have finished. */
  async function run(id, ctx) {
    if (cancelledWave(ctx.wave)) {
      emit({ev: 'skip', id});
      return;
    }
    const node = await execute(id, ctx);
    if (node && !cancelledWave(ctx.wave))
      for (const port of node.outputs.filter(p => p.signal)) await fire(node, port, ctx);
  }
  async function execute(id, ctx, attempt = 0) {
    let node = nodes.get(id);
    const generation = generations.get(id) ?? 0;
    const valid = () => !env.closed?.() && nodes.get(id) && (generations.get(id) ?? 0) === generation;
    const guard = (requireOpen = true) => {
      if (!valid()) {
        ctx.batch.cancelled = true;
        throw control('cancel');
      }
      if (closed && requireOpen) throw control('cancel');
    };
    const announce = event => {
      if (valid()) emit({...event, prefix: node?.prefix, invocation: ctx.key});
    };
    const started = Date.now();
    let announced = false,
      closed = false,
      shown;
    try {
      await enter();
      node = nodes.get(id);
      if (!node) throw plain(Object.fromEntries(view.issues)?.[id] ?? 'Node not found: ' + id);
      if (node.error) throw plain(node.error);
      const readingView = view;
      const data = node.inputs.filter(p => !p.signal);
      const outcomes = await Promise.allSettled(
        data.map(p => inputEntry(p, readScope(ctx), new Set([node.id, ...ctx.via])))
      );
      const bad = outcomes.find(o => o.status === 'rejected');
      if (bad) throw bad.reason;
      const values = new Map(
        data.map((p, i) => [p.id, outcomes[i].value === undefined ? undefined : unwrap(outcomes[i].value)])
      );
      await enter();
      if (view !== readingView) {
        // The graph is live: a read may see an edit. Retry a few times, then say so instead of looping.
        if (attempt >= 2) throw plain('The graph changed while its inputs were read: try again');
        return execute(id, ctx, attempt + 1);
      }
      if (cancelledWave(ctx.wave)) {
        announce({ev: 'skip', id});
        return false;
      }
      guard();
      announced = true;
      announce({ev: 'start', id: node.id, label: node.label, downstream: downstream(node.id)});
      const own = Date.now();
      const output = {...(node.preset ?? {}), ...(node.op === 'script' ? {} : (ctx.event ?? {}))};
      // A Script of a Library node reads the outputs of the node as they are now (what was typed there, what a Script left last).
      if (node.scope)
        for (const p of node.outputs) {
          const held = latest.get(node.scope)?.get(p.id);
          if (!p.signal && held !== undefined) output[p.name] = unwrap(held);
        }
      const display = (...parts) => {
        guard();
        if (closed) throw plain('The code of this node has ended');
        shown = displayText(parts);
        announce({ev: 'display', id: node.id, display: shown});
      };
      if (node.op === 'script') {
        const agentsys = async (method, route, body, query) => {
          guard(false);
          commit(node, output);
          const result = await call(node.id, method, route, body, query);
          guard(false);
          return result;
        };
        // widgets(list) puts widgets on this node (replacing its list; one that stays keeps its value); widgets.set({id: value}) sets values.
        const widgetsRoute = () => `projects/${node.context.project_id}/widgets/${node.id}`;
        const widgets = Object.assign(list => agentsys('PUT', widgetsRoute(), {widgets: list}), {
          set: values => agentsys('PUT', widgetsRoute(), {values}),
        });
        // context.event: what the event nodes beside it (in the same Library node, or at the root) carry: payload, connected, widget.
        const event = ctx.event ?? {};
        const {grant_chain, ...publicContext} = node.context;
        const context = Object.freeze({
          ...publicContext,
          event,
          state: watchState(state, () => guard(false)),
        });
        const codeInput = node.inputs.find(p => p.code);
        const code = codeInput ? values.get(codeInput.id) : '';
        if (typeof code === 'string' && /\bimport\s*\(/.test(code))
          throw plain('Dynamic import is not available in Script nodes');
        if (code !== undefined && code !== null && typeof code !== 'string')
          throw plain(`${node.prefix}: the script is text`);
        // A manual signal publishes current values and joins its own branches.
        const emitSignal = async (name, options) => {
          guard();
          if (closed) throw plain('The code of this node has ended');
          if (options !== undefined && (options === null || typeof options !== 'object'))
            throw plain('emit(options): options must be {handles, failFast}');
          const handles = options?.handles ?? [];
          if (!Array.isArray(handles) || handles.some(h => h !== 'break' && h !== 'continue'))
            throw plain('emit handles must be a list of "break" and "continue"');
          // The flow this node belongs to was cancelled: the code ends here (a loop must not go on spinning).
          if (cancelledWave(ctx.wave)) throw control('cancel');
          // A Script fires a free signal output of the Library node it belongs to.
          const current = nodes.get(node.id);
          const targets = Object.hasOwn(current?.signals ?? {}, name) ? current.signals[name] : current ? null : [];
          if (!targets)
            throw plain(
              node.scope
                ? `The Library node has no free signal output “${name}”`
                : `This Script has no signal output: “${name}”`
            );
          commit(node, output);
          flushEvents();
          announce({ev: 'pause', id: node.id, reason: 'signal'});
          const wave = newWave(ctx.wave, {handles, failFast: options?.failFast === true});
          try {
            await fireTo(targets, {...ctx, wave});
          } catch (error) {
            throw plain(error.message);
          } finally {
            await enter();
            announce({ev: 'resume', id: node.id});
          }
          return wave.control ?? undefined;
        };
        // node.flow: what the code does to the flow it is in. Each one ends the code of the Script (as `return` does), so what follows does not run;
        // do not catch it (a catch must rethrow an error that has `.control`).
        //   break(), continue()  the nearest emit above that handles it takes it: what that emit started stops starting new nodes. Without one, an error.
        //   cancel()             cancels the wave of the emit above (or, in a Script that nothing emitted for, everything started from its root): no error.
        //   abort()              cancels everything this signal call started, including its other roots.
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
            `node.flow.${what}() outside a loop: no node above handles it (node.output.name.emit({handles: ["${what}"]}))`
          );
        };
        const flow = Object.freeze({
          break: () => unwind('break'),
          continue: () => unwind('continue'),
          cancel: () => {
            ctx.batch.cancelled = true;
            ctx.wave.cancelled = true;
            throw control('cancel');
          },
          abort: () => {
            ctx.batch.cancelled = true;
            ctx.batch.wave.cancelled = true;
            throw control('abort');
          },
        });
        // `node` is the Library node the Script is in: node.input.<name> reads its data inputs, node.output.<name> sets its free data outputs,
        // node.output.name.emit() fires a signal output, node.display(...) shows text on it, node.widgets(list) puts widgets on it and
        // node.reread(name) reads an input again.
        const input = Object.freeze(
          Object.fromEntries(node.inputs.filter(p => p.wrapper).map(p => [p.name, values.get(p.id)]))
        );
        // node.reread(name) reads an input again: the latest result of the node it comes from (for a loop that watches a value).
        const reread = async name => {
          const p = nodes.get(node.id)?.inputs.find(q => q.wrapper && q.name === name);
          if (!p) throw plain(`This node has no input “${name}”`);
          guard();
          const entry = await inputEntry(p, readScope(ctx), new Set([node.id, ...ctx.via]));
          return entry === undefined ? undefined : unwrap(entry);
        };
        // node.cancelled: the flow this node belongs to was cancelled (a long code can look and end early).
        const sleep = async ms => {
          if (!Number.isFinite(ms) || ms < 0) throw plain('Invalid delay');
          commit(node, output);
          flushEvents();
          announce({ev: 'pause', id: node.id, reason: 'delay'});
          try {
            for (let remaining = ms; remaining > 0; ) {
              const chunk = Math.min(remaining, 2147483647);
              await new Promise(resolve => setTimeout(resolve, chunk));
              remaining -= chunk;
            }
          } finally {
            await enter();
            announce({ev: 'resume', id: node.id});
          }
          if (cancelledWave(ctx.wave)) throw control('cancel');
          guard();
        };
        for (const name of Object.keys(node.signals ?? {})) {
          if (Object.hasOwn(output, name)) throw plain('A data output and signal output cannot share the name ' + name);
          Object.defineProperty(output, name, {
            value: Object.freeze({emit: options => track(emitSignal(name, options), ctx.work)}),
            enumerable: false,
          });
        }
        const outputProxy = new Proxy(output, {
          get(target, name) {
            if (typeof name === 'string' && name !== 'toJSON' && !Reflect.has(target, name))
              throw plain('Unknown output ' + name);
            return Reflect.get(target, name);
          },
          set(target, name, value) {
            guard(false);
            if (Object.hasOwn(node.signals ?? {}, name))
              throw plain('Use node.output.' + String(name) + '.emit() for a signal output');
            if (!node.outputs.some(port => !port.signal && port.name === name))
              throw plain('The Library node has no free output “' + String(name) + '”');
            target[name] = value;
            commit(node, target);
            return true;
          },
          deleteProperty(target, name) {
            guard(false);
            target[name] = undefined;
            commit(node, target);
            delete target[name];
            return true;
          },
        });
        const self = Object.freeze({
          input,
          output: outputProxy,
          display,
          widgets,
          reread,
          flow,
          sleep,
          get cancelled() {
            return cancelledWave(ctx.wave);
          },
        });

        try {
          await Promise.resolve().then(() => compile(code)(self, agentsys, context, Date, Math));
        } catch (error) {
          // node.flow.* ended the code on purpose: the node ends normally.
          if (error?.code === 'permission_denied') throw Object.assign(new Error(error.message), {blocked: true});
          if (!(error && error.control))
            throw error && error.plain
              ? error
              : new Error(`${node.prefix}: ${String((error && error.message) || error)}`);
        } finally {
          closed = true;
        }
      }
      if (!valid()) {
        ctx.batch.cancelled = true;
        return false;
      }
      commit(node, output);
      flushEvents();

      announce({ev: 'done', id: node.id, label: node.label, ms: Date.now() - own, display: shown});
      return node;
    } catch (error) {
      // A failure inside a wave of an emit with failFast cancels that wave (and the ones between).
      flushEvents();
      if (ctx.errors && valid()) ctx.errors[id] = error.message;
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
    }
  }

  // ----- Roots -----

  /** The outputs of a node as the plain values a root reports. */
  const reported = id => {
    const out = {};
    for (const [port, entry] of latest.get(id) ?? EMPTY) out[port] = unwrap(entry);
    return out;
  };
  async function startRoot(id, batch, event) {
    const ctx = {
      batch,
      key: nextKey(),
      event,
      errors: batch.errors,
      work: batch.pending,
      via: new Set(),
      wave: newWave(batch.wave),
    };
    try {
      const outputs = {};
      if (event.input_port !== undefined) await fireTo(view.inputTargets(id, event.input_port), ctx);
      // A disabled node does not receive signals (docs/engine.md): it cannot report the values of an
      // earlier run as if this dispatch produced them.
      if (!view.get(id)) {
        emit({ev: 'root', id});
        return {id};
      }
      if (id.startsWith('complex:')) {
        for (const port of view.outputRefs(id))
          outputs[port.id] =
            port.ref && 'value' in port.ref
              ? copyOf(port.ref.value)
              : unwrap(await entryAt(port.ref, readScope(ctx), new Set()));
      } else {
        const node = nodes.get(id);
        if (!node) return {id, outputs};
        else if (node.running && event.input_port === undefined) {
          await track(run(id, ctx), batch.pending); // a Script runs as if a signal reached it, an event node carries its data and fires
          Object.assign(outputs, reported(node.scope ?? id));
        } else if (node.running) Object.assign(outputs, reported(node.scope ?? id));
        else for (const [port, entry] of await outputsOf(id, readScope(ctx), new Set())) outputs[port] = unwrap(entry);
      }
      if (!nodes.get(id)) return {id}; // removed while it ran: nothing to report
      emit({ev: 'root', id, outputs});
      return {id, outputs};
    } catch (error) {
      if (nodes.get(id)) emit({ev: 'root', id, error: error.message});
      return {id, error: error.message};
    }
  }

  return {
    flush: flushEvents,
    update(document) {
      flushEvents();
      const previous = view;
      view = createGraphView(document, {context: env.context});
      states.clear();
      dependencyCache.clear();
      readNodes.clear();
      const alive = new Set([...document.nodes.map(n => n.id), ...document.complex.map(c => 'complex:' + c.id)]);
      for (const n of previous.values()) if (!alive.has(n.id)) generations.set(n.id, (generations.get(n.id) ?? 0) + 1);
      for (const id of latest.keys())
        if (!alive.has(id)) {
          latest.delete(id);
          versions.delete(id);
          signatures.delete(id);
        }
      for (const n of view.values()) {
        if (n.op === 'on_read' && scopeOf(n)) readNodes.set(scopeOf(n), [...(readNodes.get(scopeOf(n)) ?? []), n.id]);
        if (n.op === 'scope') {
          const before = previous.get(n.id)?.preset ?? {},
            map = new Map(latest.get(n.id) ?? []);
          for (const port of n.outputs)
            if (!latest.has(n.id) || JSON.stringify(before[port.name]) !== JSON.stringify(n.preset[port.name])) {
              if (Object.hasOwn(n.preset, port.name))
                map.set(port.id, entryOf(n.preset[port.name], JSON.stringify(n.preset[port.name])));
              else map.delete(port.id);
            }
          keep(n.id, {map});
        }
      }
    },
    /** Signals the roots together and answers when everything they started has finished: {outputs by root, errors by node, cancelled}. */
    async signal(roots, event = {}) {
      const batch = {pending: new Set(), errors: {}, cancelled: false, wave: newWave(null)};
      const results = await Promise.all(roots.map(id => startRoot(id, batch, event)));
      while (batch.pending.size) await Promise.allSettled([...batch.pending]);
      flushEvents();
      return {
        outputs: Object.fromEntries(
          results.filter(result => result.outputs).map(result => [result.id, result.outputs])
        ),
        errors: {
          ...batch.errors,
          ...Object.fromEntries(results.filter(result => result.error).map(result => [result.id, result.error])),
        },
        cancelled: batch.cancelled,
      };
    },
  };
}
