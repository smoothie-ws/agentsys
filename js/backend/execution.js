// A live runtime belongs to the workflow, including its durable JSON state and values.
'use strict';
const GRAPH_RUNTIMES = new Map();
const runtimeKey = id => `workflows/${id}/runtime`;
const runtimeStatus = entry => (entry.paused ? 'paused' : entry.pending.size ? 'running' : 'idle');
const EXECUTION_RUNS = new Map();
function stopExecutionRun(run_id, reason) {
  for (const entry of GRAPH_RUNTIMES.values())
    if ([...entry.dispatches.values()].some(r => r.identity.run_id === run_id))
      stopGraph(entry.workflow, reason).catch(() => {});
}
function executionBudgetExceeded(context, message = 'Execution budget exceeded') {
  const source = context?.execution,
    entry = GRAPH_RUNTIMES.get(source?.workflow_id),
    record = entry?.dispatches.get(source?.dispatch_id);
  if (record) {
    record.limit = true;
    stopExecutionRun(source.run_id, 'budget_exceeded');
  }
  return new ApiError('budget_exceeded', message, 409);
}
function assertExecutionCurrent(context) {
  if (context?.signal?.aborted || context?.current?.() === false)
    throw new ApiError('execution_cancelled', 'Execution no longer owns this operation', 409);
}
function flushTrace(entry) {
  if (entry.traceTimer) {
    clearTimeout(entry.traceTimer);
    entry.traceTimer = null;
  }
  const events = entry.traceBuffer.splice(0);
  if (!events.length) return entry.journal?.catch(() => {}) ?? Promise.resolve();
  return journal(entry, data => {
    for (const [identity, type, fields] of events) traceRecord(data, identity, type, fields);
  });
}
function traceExecution(entry, identity, type, fields = {}) {
  if (entry.tracingEnabled === false) return;
  entry.traceBuffer.push([
    {
      at: Date.now(),
      project_id: entry.project,
      workflow_id: entry.workflow,
      graph_revision: entry.graphRevision,
      ...identity,
    },
    type,
    fields,
  ]);
  if (entry.traceBuffer.length >= 1000) {
    flushTrace(entry).catch(() => {});
    return;
  }
  if (!entry.traceTimer)
    entry.traceTimer = setTimeout(() => {
      flushTrace(entry).catch(() => {});
    }, 10);
}
function executionWatchdog(started, duration, expire) {
  let timer;
  const schedule = () => {
    const remaining = duration - (Date.now() - started);
    if (remaining <= 0) expire();
    else timer = setTimeout(schedule, Math.min(remaining, 2147483647));
  };
  schedule();
  return () => clearTimeout(timer);
}
function inheritedExecution(entry, parent, policy) {
  const source = parent?.execution;
  if (source) assertExecutionCurrent(parent);
  const checked = checkExecutionPolicy(policy);
  const effective = {...source?.policy};
  for (const [key, value] of Object.entries(checked)) effective[key] = Math.min(effective[key] ?? Infinity, value);
  return {
    project_id: entry.project,
    workflow_id: entry.workflow,
    run_id: source?.run_id ?? uid(),
    dispatch_id: uid(),
    parent_dispatch_id: source?.dispatch_id ?? null,
    parent_invocation_id: source?.invocation_id ?? null,
    graph_revision: entry.graphRevision,
    policy: effective,
  };
}
async function graphData(c, workflow) {
  const live = GRAPH_RUNTIMES.get(workflow),
    saved = live ? runtimeDetail(live) : await c.ctx.get(runtimeKey(workflow), {});
  return clone({state: saved.state ?? {}, outputs: saved.outputs ?? {}, displays: saved.displays ?? {}});
}
function importGraphData(c, workflow, value) {
  if (value === undefined) return;
  if (
    !isObject(value) ||
    !isObject(value.state) ||
    !isObject(value.outputs) ||
    !isObject(value.displays) ||
    Object.values(value.outputs).some(value => !isObject(value)) ||
    Object.values(value.displays).some(text => typeof text !== 'string')
  )
    throw bad('runtime must contain JSON state, outputs and displays objects');
  c.ctx.set(runtimeKey(workflow), clone(value));
}
async function duplicateGraphData(c, source, target, ids) {
  const data = await graphData(c, source);
  for (const key of ['outputs', 'displays'])
    data[key] = Object.fromEntries(
      Object.entries(data[key])
        .filter(([id]) => ids.has(id))
        .map(([id, value]) => [ids.get(id), value])
    );
  importGraphData(c, target, data);
}
const runtimeDetail = entry => ({
  workflow_id: entry.workflow,
  status: runtimeStatus(entry),
  paused: entry.paused,
  revision: entry.revision,
  active_signals: entry.pending.size,
  nodes: [...entry.nodes.values()],
  outputs: entry.outputs,
  errors: entry.errors,
  displays: entry.displays,
  state: entry.state,
  evaluated_nodes: entry.evaluated_nodes,
  graph_revision: entry.graphRevision,
  ...(entry.storageError ? {storage_error: entry.storageError} : {}),
});
function saveRuntime(entry) {
  entry.revision++;
  entry.dirty = true;
  if (!entry.saving)
    entry.saving = Promise.resolve()
      .then(async () => {
        while (entry.dirty && !entry.deleted) {
          entry.dirty = false;
          await DB.commit({[runtimeKey(entry.workflow)]: clone(runtimeDetail(entry))});
        }
      })
      .finally(() => {
        entry.saving = null;
      });
  entry.saving.catch(error => {
    entry.storageError = error.message;
  });
  return entry.saving;
}
function runtimeDocument(entry) {
  if (!entry.detached.size) return entry.document;
  const document = clone(entry.document);
  for (const fragment of entry.detached.values()) {
    for (const name of ['nodes', 'complex', 'groups', 'edges']) {
      const known = new Set(document[name].map(item => item.id));
      document[name].push(...fragment[name].filter(item => !known.has(item.id)));
    }
    Object.assign(document.widgets, fragment.widgets);
  }
  return document;
}
function syncRuntimeGraph(workflow, document) {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (!entry) return;
  const signature = JSON.stringify(document);
  if (signature === entry.documentSignature) return;
  entry.documentSignature = signature;
  entry.graphRevision = uid();
  entry.document = {...document, graph_revision: entry.graphRevision};
  const current = runtimeDocument(entry),
    alive = new Set([...current.nodes.map(n => n.id), ...current.complex.map(c => 'complex:' + c.id)]);
  for (const id of entry.alive ?? [])
    if (!alive.has(id)) entry.nodeGenerations.set(id, (entry.nodeGenerations.get(id) ?? 0) + 1);
  entry.alive = alive;
  for (const values of [entry.outputs, entry.displays, entry.errors])
    for (const id of Object.keys(values)) if (!alive.has(id)) delete values[id];
  for (const id of entry.nodes.keys()) if (!alive.has(id)) entry.nodes.delete(id);
  entry.host?.update(current).catch(error => {
    if (entry.host) entry.errors.host = error.message;
  });
  saveRuntime(entry);
}
async function graphRuntime(c, project) {
  const metadata = await c.project(project),
    selected = c.workflowId ?? metadata.workflows[0]?.id;
  if (!metadata.workflows.some(workflow => workflow.id === selected)) throw missing('Workflow not found');
  if (GRAPH_RUNTIMES.has(selected)) return GRAPH_RUNTIMES.get(selected);
  return exclusive(async () => {
    const {editor, meta} = await c.workflow(project);
    let entry = GRAPH_RUNTIMES.get(meta.id);
    if (!entry) {
      const saved = (await DB.get(runtimeKey(meta.id))) ?? {};
      entry = {
        project,
        workflow: meta.id,
        document: editor.snapshot(),
        state: clone(saved.state ?? {}),
        outputs: clone(saved.outputs ?? {}),
        displays: clone(saved.displays ?? {}),
        errors: clone(saved.errors ?? {}),
        evaluated_nodes: saved.evaluated_nodes ?? 0,
        nodes: new Map(
          (saved.nodes ?? []).map(node => [
            node.node_id,
            {...node, status: ['running', 'sleeping', 'waiting'].includes(node.status) ? 'stopped' : node.status},
          ])
        ),
        revision: saved.revision ?? 0,
        paused: saved.paused === true,
        pending: new Set(),
        calls: new Map(),
        detached: new Map(),
        host: null,
        controller: null,
        dirty: false,
        saving: null,
        dispatches: new Map(),
        traceBuffer: [],
        traceTimer: null,
        generation: 0,
        journal: null,
        nodeGenerations: new Map(),
      };
      await recoverExecutions(entry);
      GRAPH_RUNTIMES.set(meta.id, entry);
    }
    const document = editor.snapshot();
    for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
    await c.ctx.commit();
    syncRuntimeGraph(meta.id, document);
    return entry;
  });
}
function runtimeEvent(entry, event) {
  if (event.ev === 'invocation.closed') {
    EXECUTION_RUNS.get(event.run_id)?.active.delete(event.invocation_id);
    return;
  }
  if (event.id && !entry.alive?.has(event.id)) return;
  if (event.dispatch_id && !entry.dispatches.has(event.dispatch_id) && event.ev !== 'state.changed') return;
  const run = EXECUTION_RUNS.get(event.run_id);
  if (['done', 'fail'].includes(event.ev)) run?.active.delete(event.invocation_id);
  const type = {
    start: 'invocation.start',
    done: 'invocation.end',
    fail: 'error',
    pause: 'wait.start',
    resume: 'wait.end',
    cancel: 'cancellation',
    skip: 'invocation.skipped',
    'signal.sent': 'signal.sent',
    'signal.received': 'signal.received',
    'state.changed': 'state.changed',
  }[event.ev];
  if (type)
    traceExecution(entry, event, type, {
      ...event,
      status: event.ev === 'fail' ? 'failed' : event.ev === 'done' ? 'completed' : undefined,
      duration_ms: event.ms,
    });
  if (event.ev === 'fail') traceExecution(entry, event, 'invocation.end', {status: 'failed', duration_ms: event.ms});
  if (event.ev === 'root' && event.dispatch_id) {
    const dispatch = entry.dispatches.get(event.dispatch_id);
    if (!event.error) dispatch.outputs[event.id] = clone(event.outputs);
  }
  if (event.ev === 'state') {
    entry.state = event.state;
    saveRuntime(entry);
    return;
  }
  if (event.ev === 'values') {
    entry.outputs[event.id] = event.outputs;
    saveRuntime(entry);
    return;
  }
  if (event.ev === 'display') {
    entry.displays[event.id] = event.display;
    saveRuntime(entry);
    return;
  }
  if (event.ev === 'root') {
    if (event.error) entry.errors[event.id] = event.error;
    else {
      entry.outputs[event.id] = event.outputs;
      delete entry.errors[event.id];
    }
    saveRuntime(entry);
    return;
  }
  const status = {
    start: 'running',
    resume: 'running',
    pause: event.reason === 'delay' ? 'sleeping' : 'waiting',
    done: 'completed',
    fail: event.blocked ? 'blocked' : 'failed',
    skip: 'skipped',
  }[event.ev];
  if (!status) return;
  const calls = entry.calls.get(event.id) ?? new Map(),
    key = event.invocation ?? event.id;
  if (['running', 'sleeping', 'waiting'].includes(status)) calls.set(key, status);
  else calls.delete(key);
  if (calls.size) entry.calls.set(event.id, calls);
  else entry.calls.delete(event.id);
  const current = ['running', 'sleeping', 'waiting'].find(status => [...calls.values()].includes(status)) ?? status;
  entry.nodes.set(event.id, {node_id: event.id, status: current, ...(event.error ? {error: event.error} : {})});
  if (event.ev === 'start') delete entry.errors[event.id];
  if (event.error) entry.errors[event.id] = event.error;
  if (event.ev === 'done') entry.evaluated_nodes++;
  saveRuntime(entry);
}
function ensureGraphHost(entry) {
  if (entry.host) return entry.host;
  entry.controller = new AbortController();
  let host;
  const generation = ++entry.generation;
  host = createScriptHost(runtimeDocument(entry), runtimeDetail(entry), {
    context: {project_id: entry.project, workflow_id: entry.workflow},
    paused: entry.paused,
    signal: entry.controller.signal,
    onEvent: event => {
      if (host && entry.host === host) runtimeEvent(entry, event);
    },
    onCall: (execution, node) => {
      const record = entry.dispatches.get(execution?.dispatch_id);
      const controlled = Object.keys(execution?.policy ?? {}).length > 0;
      if (
        (!record && controlled) ||
        !execution ||
        execution.workflow_id !== entry.workflow ||
        entry.host !== host ||
        entry.generation !== generation ||
        (node && !entry.alive.has(node))
      )
        throw new ApiError('execution_cancelled', 'Invocation is no longer active', 409);
      const identity = {
        ...(record?.identity ?? execution),
        invocation_id: execution.invocation_id,
        graph_revision: execution.graph_revision,
        node_id: node,
      };
      const nodeGeneration = entry.nodeGenerations.get(node) ?? 0;
      return {
        execution: identity,
        current: () =>
          entry.host === host &&
          entry.generation === generation &&
          (!controlled || entry.dispatches.has(identity.dispatch_id)) &&
          (!node || entry.alive.has(node)) &&
          (entry.nodeGenerations.get(node) ?? 0) === nodeGeneration,
      };
    },
    admit: execution => {
      const record = entry.dispatches.get(execution.dispatch_id),
        run = EXECUTION_RUNS.get(execution.run_id);
      if (!record || !run) throw bad('Execution stopped');
      const policy = record.identity.policy;
      const exceeded =
        (policy.max_invocations && run.invocations >= policy.max_invocations) ||
        (policy.max_parallelism && run.active.size >= policy.max_parallelism);
      if (exceeded) {
        record.limit = true;
        stopExecutionRun(execution.run_id, 'budget_exceeded');
        throw new ApiError('budget_exceeded', 'Execution budget exceeded', 409);
      }
      run.invocations++;
      run.active.add(execution.invocation_id);
    },
    onFailure: () => {
      if (entry.host !== host) return;
      entry.host = null;
      entry.generation++;
      entry.controller?.abort();
      for (const record of entry.dispatches.values()) if (record.host === host) record.interrupted = true;
    },
  });
  entry.host = host;
  return host;
}
function signalGraph(entry, roots, event = {}, options = {}) {
  checkRoots(roots, Editor.nodeMap(runtimeDocument(entry)));
  const identity = inheritedExecution(entry, options.parent, options.policy),
    policy = identity.policy;
  const run = EXECUTION_RUNS.get(identity.run_id) ?? {
    dispatches: 0,
    invocations: 0,
    active: new Set(),
    pending: 0,
    started: Date.now(),
  };
  if (policy.max_dispatches && run.dispatches >= policy.max_dispatches)
    throw executionBudgetExceeded(options.parent, 'Dispatch budget exceeded');
  run.dispatches++;
  run.pending++;
  EXECUTION_RUNS.set(identity.run_id, run);
  const record = {identity, outputs: {}, cancelled: false};
  entry.dispatches.set(identity.dispatch_id, record);
  let host;
  const stopping = entry.stopping;
  let timer;
  const parentSignal = options.parent?.signal;
  const parentCancelled = () => stopGraph(entry.workflow, 'parent_cancelled').catch(() => {});
  if (parentSignal && options.parent.execution?.workflow_id !== entry.workflow)
    parentSignal.addEventListener('abort', parentCancelled, {once: true});
  let admittedResolve, admittedReject;
  const admitted = new Promise((resolve, reject) => {
    admittedResolve = resolve;
    admittedReject = reject;
  });
  admitted.catch(() => {});
  const work = (async () => {
    let result = {errors: {}};
    try {
      if (stopping) await stopping;
      await journal(entry, data => {
        data.dispatches[identity.dispatch_id] = {
          ...identity,
          status: 'running',
          node_ids: clone(roots),
          created_at: Date.now(),
          owner: EXECUTION_OWNER,
        };
        traceRecord(data, identity, 'dispatch.start', {status: 'running'});
      });
      admittedResolve();
      assertExecutionCurrent(options.parent);
      if (record.cancelled) return {...runtimeDetail(entry), ...identity, dispatch_status: 'cancelled', errors: {}};
      host = roots.length ? ensureGraphHost(entry) : null;
      record.host = host;
      if (policy.max_duration_ms)
        timer = executionWatchdog(run.started, policy.max_duration_ms, () => {
          record.limit = true;
          stopExecutionRun(identity.run_id, 'budget_exceeded');
        });
      if (host) result = await host.signal(roots, event, identity);
    } catch (error) {
      admittedReject(error);
      if (!record.cancelled && !record.interrupted && !record.limit) {
        entry.errors.host = error.message;
        result = {errors: {host: error.message}};
      }
    } finally {
      timer?.();
      parentSignal?.removeEventListener('abort', parentCancelled);
      const status = record.limit
        ? 'budget_exceeded'
        : record.interrupted
          ? 'interrupted'
          : record.cancelled || result.cancelled
            ? 'cancelled'
            : Object.keys(result.errors).length
              ? 'failed'
              : 'completed';
      try {
        await flushTrace(entry);
        await journal(entry, data => {
          const saved = data.dispatches[identity.dispatch_id];
          if (saved)
            Object.assign(saved, {
              status,
              finished_at: Date.now(),
              outputs: record.outputs,
              errors: Object.fromEntries(Object.keys(result.errors).map(id => [id, {code: 'node_failed'}])),
            });
          traceRecord(data, identity, 'dispatch.end', {status});
          if (status === 'cancelled') traceRecord(data, identity, 'cancellation', {status});
        });
        record.status = status;
      } finally {
        entry.dispatches.delete(identity.dispatch_id);
        entry.pending.delete(work);
        run.pending--;
        if (!run.pending) EXECUTION_RUNS.delete(identity.run_id);
        await saveRuntime(entry);
      }
    }
    return {
      ...runtimeDetail(entry),
      ...identity,
      dispatch_status: record.status,
      dispatch_outputs: record.outputs,
      errors: result.errors,
    };
  })();
  work.identity = identity;
  work.admitted = admitted;
  // A fire-and-forget dispatch still exposes persistence failures via runtime.storage_error.
  work.catch(() => {});
  entry.pending.add(work);
  saveRuntime(entry);
  return work;
}
function stopGraph(workflow, reason = 'user') {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (!entry) return Promise.resolve();
  if (entry.stopping) return entry.stopping;
  let finish, fail;
  const work = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  entry.stopping = work;
  performStopGraph(workflow, reason).then(
    value => {
      entry.stopping = null;
      finish(value);
    },
    error => {
      entry.stopping = null;
      fail(error);
    }
  );
  return work;
}
async function performStopGraph(workflow, reason = 'user') {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (!entry) return;
  const stopped = [...entry.dispatches.values()],
    pending = [...entry.pending];
  if (!stopped.length) traceExecution(entry, {}, 'stop', {reason});
  for (const record of stopped) traceExecution(entry, record.identity, 'stop', {reason});
  const host = entry.host;
  entry.host = null;
  entry.generation++;
  for (const record of stopped) {
    record.cancelled = true;
    if (reason === 'budget_exceeded') record.limit = true;
  }
  entry.controller?.abort();
  host?.close();
  entry.paused = false;
  for (const [id, node] of entry.nodes)
    if (['running', 'sleeping', 'waiting'].includes(node.status)) entry.nodes.set(id, {...node, status: 'stopped'});
  entry.calls.clear();
  // Closing an obsolete backend must release its Worker without overwriting the new owner's data.
  if ((await executionStore(workflow)).owner !== EXECUTION_OWNER) {
    entry.deleted = true;
    if (entry.traceTimer) clearTimeout(entry.traceTimer);
    entry.traceBuffer.length = 0;
    await Promise.allSettled(pending);
    return;
  }
  await Promise.allSettled(pending);
  await flushTrace(entry);
  await journal(entry, data => {
    for (const r of Object.values(data.operations))
      if (r.status === 'running') {
        r.uncertain = r.policy !== 'safe';
        operationTransition(data, entry, r, 'cancelled');
      }
  });
  await saveRuntime(entry);
}
async function deleteGraphRuntime(workflow) {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (entry) {
    await stopGraph(workflow);
    entry.deleted = true;
    await entry.saving;
    GRAPH_RUNTIMES.delete(workflow);
  }
  await DB.commit({[runtimeKey(workflow)]: undefined});
  await DB.commit({[executionKey(workflow)]: undefined});
}
async function dispatchGraphEvent(project, workflow, hook, group, data, removed = null) {
  const entry = await graphRuntime(new Call('GET', {}, {workflow_id: workflow}, null), project);
  if (removed) {
    const root = removed.complex.find(c => c.id === group),
      ids = new Set(root?.members ?? []);
    ids.add('complex:' + group);
    const existing = new Set(entry.document.nodes.map(n => n.id));
    entry.detached.set(group, {
      ...removed,
      nodes: removed.nodes.filter(n => ids.has(n.id) && !existing.has(n.id)),
      complex: removed.complex.filter(c => ids.has('complex:' + c.id)),
      groups: removed.groups.filter(g => g.id === group || ids.has('complex:' + g.id)),
      edges: removed.edges.filter(e => ids.has(e.source) || ids.has(e.target)),
    });
    entry.documentSignature = null;
    syncRuntimeGraph(workflow, entry.document);
  }
  const view = createGraphView(runtimeDocument(entry), {context: {project_id: project, workflow_id: workflow}});
  const roots = view
    .values()
    .filter(n => n.op === hook && view.scopes.get(n.id)?.group === group)
    .map(n => n.id);
  try {
    return await signalGraph(entry, roots, data);
  } finally {
    if (removed) {
      entry.detached.delete(group);
      entry.documentSignature = null;
      syncRuntimeGraph(workflow, entry.document);
    }
  }
}

DB.subscribe(keys => {
  for (const entry of GRAPH_RUNTIMES.values())
    if (keys.includes('wf:' + entry.workflow) || keys.includes('resources')) {
      exclusive(async () => {
        if (GRAPH_RUNTIMES.get(entry.workflow) !== entry) return;
        const call = new Call('GET', {}, {workflow_id: entry.workflow}, null);
        const {editor} = await call.workflow(entry.project);
        const document = editor.snapshot();
        for (const {doc} of call.docs.values()) doc.types = ownTypes(doc.types);
        await call.ctx.commit();
        syncRuntimeGraph(entry.workflow, document);
        if (call.refreshed) DB.announce(['wf:' + entry.workflow]);
      }).catch(error => {
        entry.errors.host = error.message;
        saveRuntime(entry);
      });
    }
});
route(
  'GET POST DELETE',
  'projects/{project_id}/execution',
  'Inspect the live graph, signal on_run or stop current work',
  async (c, {project_id}) => {
    const entry = await graphRuntime(c, project_id);
    if (c.method === 'DELETE') await stopGraph(entry.workflow);
    if (c.method === 'POST') {
      const roots = c.body.node_ids ?? entry.document.nodes.filter(isRunStart).map(node => node.id);
      const event = {payload: c.body.payload ?? {}};
      if (!isObject(event.payload)) throw bad('payload must be an object');
      let parent = c.scriptContext;
      if (c.body.parent_dispatch_id && !parent?.execution) {
        const active = entry.dispatches.get(c.body.parent_dispatch_id);
        if (!active) throw missing('Parent dispatch is not active in this workflow');
        parent = {execution: active.identity, current: () => entry.dispatches.has(c.body.parent_dispatch_id)};
      }
      const work = signalGraph(entry, roots, event, {parent, policy: c.body.policy});
      if (c.body.wait === true) return await work;
      await work.admitted;
      return {...runtimeDetail(entry), ...work.identity, dispatch_status: 'running'};
    }
    await entry.saving;
    return runtimeDetail(entry);
  },
  {
    unlocked: true,
    body: {payload: {}, wait: false, node_ids: [], parent_dispatch_id: null, policy: {}},
    query: ['workflow_id'],
  }
);
registerExecutionDataRoutes();
route(
  'POST',
  'projects/{project_id}/execution/{action}',
  'Pause or resume the live graph',
  async (c, {project_id, action}) => {
    if (!['pause', 'resume'].includes(action)) throw bad('Choose pause or resume');
    const entry = await graphRuntime(c, project_id);
    entry.paused = action === 'pause';
    if (!entry.dispatches.size) traceExecution(entry, {}, action);
    for (const record of entry.dispatches.values()) traceExecution(entry, record.identity, action);
    entry.host?.pause(entry.paused).catch(() => {});
    await saveRuntime(entry);
    return runtimeDetail(entry);
  },
  {unlocked: true, query: ['workflow_id']}
);
