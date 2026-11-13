// A live runtime belongs to the workflow, including its durable JSON state and values.
'use strict';
const GRAPH_RUNTIMES = new Map();
const runtimeKey = id => `workflows/${id}/runtime`;
const runtimeStatus = entry => (entry.paused ? 'paused' : entry.pending.size ? 'running' : 'idle');
const BUSY = ['running', 'sleeping', 'waiting'];

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
  runs: entry.runs,
  activity: entry.activity,
  outputs: entry.outputs,
  errors: entry.errors,
  displays: entry.displays,
  state: entry.state,
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
          const {runs: _passes, activity: _activity, ...saved} = runtimeDetail(entry);
          await DB.commit({[runtimeKey(entry.workflow)]: clone(saved)});
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
  entry.document = document;
  const current = runtimeDocument(entry);
  entry.alive = new Set([...current.nodes.map(n => n.id), ...current.complex.map(c => 'complex:' + c.id)]);
  for (const values of [entry.outputs, entry.displays, entry.errors])
    for (const id of Object.keys(values)) if (!entry.alive.has(id)) delete values[id];
  for (const id of Object.keys(entry.runs)) if (!entry.alive.has(id)) delete entry.runs[id];
  for (const id of entry.nodes.keys()) if (!entry.alive.has(id)) entry.nodes.delete(id);
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
    if (!GRAPH_RUNTIMES.has(meta.id)) {
      const saved = (await DB.get(runtimeKey(meta.id))) ?? {};
      GRAPH_RUNTIMES.set(meta.id, {
        project,
        workflow: meta.id,
        document: editor.snapshot(),
        state: clone(saved.state ?? {}),
        outputs: clone(saved.outputs ?? {}),
        displays: clone(saved.displays ?? {}),
        errors: clone(saved.errors ?? {}),
        // Nothing runs after a restart: what was busy was stopped.
        nodes: new Map(
          (saved.nodes ?? []).map(node => [
            node.node_id,
            {...node, status: BUSY.includes(node.status) ? 'stopped' : node.status},
          ])
        ),
        // node id -> how many times it finished or failed: the editor lights a node for each pass, however short
        runs: {},
        activity: [], // bounded start order for the canvas; transient, never replayed after a restart
        activitySequence: 0,
        revision: saved.revision ?? 0,
        paused: saved.paused === true,
        pending: new Set(), // the signal calls in progress
        dispatches: new Set(), // their records, for Stop
        calls: new Map(), // node id -> status of each of its overlapping invocations
        detached: new Map(),
        host: null,
        controller: null,
        dirty: false,
        saving: null,
      });
    }
    const document = editor.snapshot();
    for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
    await c.ctx.commit();
    syncRuntimeGraph(meta.id, document);
    return GRAPH_RUNTIMES.get(meta.id);
  });
}
function runtimeEvent(entry, event) {
  if (event.id && !entry.alive?.has(event.id)) return;
  if (event.ev === 'state') {
    entry.state = event.state;
    return saveRuntime(entry);
  }
  if (event.ev === 'values') {
    entry.outputs[event.id] = event.outputs;
    return saveRuntime(entry);
  }
  if (event.ev === 'display') {
    entry.displays[event.id] = event.display;
    return saveRuntime(entry);
  }
  if (event.ev === 'root') {
    if (event.error) entry.errors[event.id] = event.error;
    else {
      entry.outputs[event.id] = event.outputs;
      delete entry.errors[event.id];
    }
    return saveRuntime(entry);
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
  if (event.ev === 'start')
    for (const id of event.downstream ?? []) {
      // A parallel invocation owns its live state; only previous, settled work is cleared.
      const previous = entry.nodes.get(id);
      if (id !== event.id && previous && !entry.calls.get(id)?.size && !BUSY.includes(previous.status))
        entry.nodes.set(id, {node_id: id, status: 'ready'});
    }
  if (event.ev === 'start') {
    entry.activity.push({sequence: ++entry.activitySequence, node_id: event.id});
    if (entry.activity.length > 128) entry.activity.splice(0, entry.activity.length - 128);
  }
  // A node with overlapping invocations stays active until all of them have settled.
  const calls = entry.calls.get(event.id) ?? new Map(),
    key = event.invocation ?? event.id;
  if (BUSY.includes(status)) calls.set(key, status);
  else calls.delete(key);
  if (calls.size) entry.calls.set(event.id, calls);
  else entry.calls.delete(event.id);
  const current = BUSY.find(status => [...calls.values()].includes(status)) ?? status;
  entry.nodes.set(event.id, {node_id: event.id, status: current, ...(event.error ? {error: event.error} : {})});
  if (event.ev === 'done' || event.ev === 'fail') entry.runs[event.id] = (entry.runs[event.id] ?? 0) + 1;
  if (event.ev === 'start') delete entry.errors[event.id];
  if (event.error) entry.errors[event.id] = event.error;
  saveRuntime(entry);
}
function ensureGraphHost(entry) {
  if (entry.host) return entry.host;
  entry.controller = new AbortController();
  let host;
  host = createScriptHost(runtimeDocument(entry), runtimeDetail(entry), {
    context: {project_id: entry.project, workflow_id: entry.workflow},
    paused: entry.paused,
    signal: entry.controller.signal,
    onEvent: event => {
      if (host && entry.host === host) runtimeEvent(entry, event);
    },
    onFailure: () => {
      if (entry.host !== host) return;
      entry.host = null;
      entry.controller?.abort();
    },
  });
  entry.host = host;
  return host;
}
/**
 * Signals the roots and answers, when everything they started has finished, with the runtime plus `dispatch_status`
 * and `dispatch_outputs` (the outputs of the roots). `caller` is the Script context of a checked API call: stopping
 * the caller's workflow stops this one too.
 */
function signalGraph(entry, roots, event = {}, caller = null) {
  checkRoots(roots, Editor.nodeMap(runtimeDocument(entry)));
  const record = {cancelled: false},
    stopping = entry.stopping,
    callerSignal = caller?.signal,
    stopWithCaller = () => stopGraph(entry.workflow).catch(() => {});
  if (callerSignal && caller.workflow_id !== entry.workflow)
    callerSignal.addEventListener('abort', stopWithCaller, {once: true});
  entry.dispatches.add(record);
  const work = (async () => {
    let result = {errors: {}, outputs: {}};
    try {
      await stopping; // a Run that arrives while Stop is in progress starts after it
      if (!record.cancelled && roots.length) result = await ensureGraphHost(entry).signal(roots, event);
      // The host answered: a failure recorded by an earlier dispatch is history, not the state of this one.
      delete entry.errors.host;
    } catch (error) {
      if (!record.cancelled) {
        entry.errors.host = error.message;
        result = {errors: {host: error.message}, outputs: {}};
      }
    } finally {
      callerSignal?.removeEventListener('abort', stopWithCaller);
      entry.dispatches.delete(record);
      entry.pending.delete(work);
      await saveRuntime(entry);
    }
    const failed = Object.keys(result.errors).length > 0;
    return {
      ...runtimeDetail(entry),
      dispatch_status: record.cancelled || result.cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      dispatch_outputs: result.outputs,
      errors: result.errors,
    };
  })();
  // A fire-and-forget signal still exposes persistence failures via runtime.storage_error.
  work.catch(() => {});
  entry.pending.add(work);
  saveRuntime(entry);
  return work;
}
/** Stops the workflow's host (and so its timers and checked network calls). Data stays; waits for the work to end. */
function stopGraph(workflow) {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (!entry) return Promise.resolve();
  if (entry.stopping) return entry.stopping;
  const pending = [...entry.pending];
  for (const record of entry.dispatches) record.cancelled = true;
  const host = entry.host;
  entry.host = null;
  entry.controller?.abort();
  host?.close();
  entry.paused = false;
  for (const [id, node] of entry.nodes)
    if (BUSY.includes(node.status)) entry.nodes.set(id, {...node, status: 'stopped'});
  entry.calls.clear();
  const work = Promise.allSettled(pending)
    .then(() => saveRuntime(entry))
    .finally(() => {
      entry.stopping = null;
    });
  entry.stopping = work;
  return work;
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
}
/** Release a deleted workflow's live work, durable state and undo history together. */
async function removeWorkflow(c, workflow) {
  await deleteGraphRuntime(workflow);
  await c.ctx.remove('wf:' + workflow);
  histories.delete(workflow);
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
      if (c.body.input_port !== undefined) {
        if (typeof c.body.input_port !== 'string') throw bad('input_port must name a signal input');
        event.input_port = c.body.input_port;
      }
      if (!isObject(event.payload)) throw bad('payload must be an object');
      const work = signalGraph(entry, roots, event, c.scriptContext);
      if (c.body.wait === true) return await work;
      return {...runtimeDetail(entry), dispatch_status: 'running'};
    }
    await entry.saving;
    return runtimeDetail(entry);
  },
  {
    unlocked: true,
    body: {payload: {}, wait: false, node_ids: [], input_port: null},
    query: ['workflow_id'],
  }
);
route(
  'POST',
  'projects/{project_id}/execution/{action}',
  'Pause or resume the live graph',
  async (c, {project_id, action}) => {
    if (!['pause', 'resume'].includes(action)) throw bad('Choose pause or resume');
    const entry = await graphRuntime(c, project_id);
    entry.paused = action === 'pause';
    entry.host?.pause(entry.paused).catch(() => {});
    await saveRuntime(entry);
    return runtimeDetail(entry);
  },
  {unlocked: true, query: ['workflow_id']}
);
