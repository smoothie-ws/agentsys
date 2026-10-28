// Runs and triggers.
//
// A run evaluates a workflow in the background: POST starts it and answers at once, the run can be watched
// (status, a trace of every node, an event log you can long-poll), cancelled, and is remembered in the workflow's
// run history. Triggers start runs by themselves: on an interval (the headless server ticks the scheduler) or from a
// webhook. The canvas "Run" button still uses evaluate-node; both go through evaluateGraph.
'use strict';

const MAX_ACTIVE_RUNS = 16;
const KEEP_RUNS = 200; // finished runs kept in memory (details of older ones come from the history)
const HISTORY_OUTPUT_LIMIT = 256000; // characters of outputs stored per run in the history
const MAX_EVENTS = 2000;
const MAX_PAYLOAD = 64000;
const MAX_TRIGGERS = 100;
/** Waits for a run to finish, but at most `ms` (the timer does not outlive the wait: `wait` can be up to 120 s). */
function untilDone(run, ms) {
  let timer;
  const timeout = new Promise(resolve => (timer = setTimeout(resolve, ms)));
  return Promise.race([run.done, timeout]).finally(() => clearTimeout(timer));
}
const nowSeconds = () => Date.now() / 1000;

const RUNS = {active: 0, byId: new Map()};
const terminalRun = status => ['completed', 'failed', 'cancelled'].includes(status);
const runKey = id => 'runs/' + id;
function hydrateRun(detail) {
  return {
    ...detail,
    nodes: new Map((detail.nodes ?? []).map(n => [n.node_id, n])),
    events: detail.events ?? [],
    seq: detail.seq ?? 0,
    waiters: new Set(),
    controller: new AbortController(),
    control: runControl(),
    done: Promise.resolve(),
  };
}
async function persistRun(run, locked = false) {
  if (run.deleted) return;
  const save = async () => {
    const ids = (await DB.get('run_index')) ?? [];
    if (!ids.includes(run.id)) ids.push(run.id);
    const data = {
      ...storedRun(run),
      payload: run.payload,
      plan: run.plan,
      checkpoint_count: run.checkpoint_count ?? 0,
      budget: run.budget,
      usage: run.usage,
      initiative_id: run.initiative_id,
      seq: run.seq,
      trace: run.trace ?? [],
      segments: run.segments ?? [],
      segment: run.segment ?? 0,
      replay_of: run.replay_of ?? null,
    };
    // The run record is the commit point: checkpoint/events must reach disk first.
    const changes = {
      ...(run.checkpoint ? {[runKey(run.id) + '/checkpoint']: clone(run.checkpoint)} : {}),
      [runKey(run.id) + '/events']: clone(run.events),
      [runKey(run.id)]: clone(data),
      run_index: ids,
    };
    const keep = (await DB.get('prefs'))?.run_retention ?? KEEP_RUNS;
    let completed = 0;
    for (const id of ids) {
      const candidate = id === run.id ? data : await DB.get(runKey(id));
      if (candidate && terminalRun(candidate.status)) completed++;
    }
    let excess = completed - keep;
    for (const id of [...ids]) {
      if (excess <= 0) break;
      const old = await DB.get(runKey(id));
      if (id === run.id || !old || !terminalRun(old.status)) continue;
      changes[runKey(id)] = undefined;
      changes[runKey(id) + '/checkpoint'] = undefined;
      changes[runKey(id) + '/events'] = undefined;
      ids.splice(ids.indexOf(id), 1);
      RUNS.byId.delete(id);
      excess--;
    }
    await DB.commit(changes);
  };
  return locked ? save() : exclusive(save);
}
async function dropWorkflowRuns(c, workflowId) {
  const ids = await c.ctx.get('run_index', []),
    keep = [];
  for (const id of ids) {
    const run = RUNS.byId.get(id),
      stored = await c.ctx.get(runKey(id));
    if ((run?.workflow_id ?? stored?.workflow_id) !== workflowId) {
      keep.push(id);
      continue;
    }
    if (run) {
      run.deleted = true;
      run.controller.abort();
      RUNS.byId.delete(id);
    }
    await cancelRunApprovals(id, true);
    for (const suffix of ['', '/checkpoint', '/events', '/budget']) await c.ctx.remove(runKey(id) + suffix);
  }
  c.ctx.set('run_index', keep);
}
let recovery;
function recoverRuns() {
  return (recovery ??= exclusive(async () => {
    for (const id of (await DB.get('run_index')) ?? []) {
      const data = await DB.get(runKey(id));
      if (!data) continue;
      const run = hydrateRun({...data, events: await DB.get(runKey(id) + '/events')});
      run.checkpoint = await DB.get(runKey(id) + '/checkpoint');
      RUNS.byId.set(id, run);
      if (run.status === 'running') {
        run.status = 'interrupted';
        emit(run, 'run_interrupted');
        await persistRun(run, true);
      }
    }
  }));
}
function launchRun(run) {
  return new Promise(resolve => setTimeout(resolve, 0))
    .then(() => executeRun(run))
    .catch(async error => {
      if (run.status === 'running') RUNS.active--;
      run.error = error.message || String(error);
      run.status = 'failed';
      run.finished = nowSeconds();
      emit(run, 'run_finished', {status: 'failed', error: run.error});
      try {
        await persistRun(run);
      } catch (storageError) {
        run.error += '; persistence failed: ' + storageError.message;
      }
    });
}
async function continueRun(run, resolutions, locked = false) {
  if (!['waiting', 'interrupted'].includes(run.status) || !run.checkpoint) throw bad('Run has no resumable checkpoint');
  if (RUNS.active >= MAX_ACTIVE_RUNS) throw new ApiError('too_many_runs', 'Too many active runs', 429);
  run.plan.checkpoint = clone(run.checkpoint);
  run.plan.resolutions = {...run.plan.resolutions, ...resolutions};
  run.controller = new AbortController();
  run.control = runControl();
  run.status = 'running';
  run.finished = null;
  emit(run, 'run_resumed', {keys: Object.keys(resolutions)});
  RUNS.active++;
  run.segment = (run.segment ?? 0) + 1;
  await persistRun(run, locked);
  // Defer execution until a caller holding exclusive has committed its own context.
  run.done = launchRun(run);
  return run;
}
function matchEvent(expected, value) {
  if (!isObject(expected)) return JSON.stringify(expected) === JSON.stringify(value);
  return isObject(value) && Object.entries(expected).every(([k, v]) => matchEvent(v, value[k]));
}
async function wakeEvent(name, payload, locked = false) {
  const wake = async () => {
    if (JSON.stringify(payload).length > MAX_PAYLOAD) throw bad('Event payload is too large');
    const inbox = clone((await DB.get('event_inbox')) ?? []);
    inbox.push({name, payload, at: Date.now()});
    await DB.commit({event_inbox: inbox.slice(-MAX_EVENTS)});
    const resumed = [];
    for (const run of RUNS.byId.values()) {
      if (run.status !== 'waiting') continue;
      const resolutions = Object.fromEntries(
        (run.checkpoint?.waits ?? [])
          .filter(
            w =>
              w.wait_spec.event === name && (w.wait_spec.match === undefined || matchEvent(w.wait_spec.match, payload))
          )
          .map(w => [w.key, {key: w.key, value: payload}])
      );
      if (!Object.keys(resolutions).length) continue;
      await continueRun(run, resolutions, true);
      resumed.push(run.id);
    }
    return {resumed};
  };
  return locked ? wake() : exclusive(wake);
}

/** What pauses a run: `set(true)` stops new nodes from starting (the ones running finish), `set(false)` goes on. The Worker attaches itself. */
function runControl() {
  return {
    paused: false,
    send: null,
    attach(send) {
      this.send = send;
      if (this.paused) send({type: 'pause'});
    },
    set(paused) {
      this.paused = paused;
      this.send?.({type: paused ? 'pause' : 'resume'});
    },
  };
}

function emit(run, type, data = {}) {
  run.events.push({seq: ++run.seq, at: nowSeconds(), type, ...data});
  for (const wake of [...run.waiters]) wake();
}
const waitForChange = (run, ms) =>
  new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      run.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    run.waiters.add(done);
  });

const runSummary = run => ({
  id: run.id,
  project_id: run.project_id,
  workflow_id: run.workflow_id,
  status: run.status,
  paused: run.control?.paused === true,
  trigger: run.trigger,
  trigger_id: run.trigger_id ?? null,
  started: run.started,
  finished: run.finished,
  ms: run.ms,
  evaluated_nodes: run.evaluated_nodes,
  failed_nodes: [...run.nodes.values()].filter(n => n.status === 'failed').length,
  error: run.error ?? null,
  waits: ['waiting', 'interrupted'].includes(run.status) ? (run.checkpoint?.waits ?? []) : [],
  usage: run.usage ?? {},
  initiative_id: run.initiative_id ?? null,
  replay_available: terminalRun(run.status) && !!run.plan && !!run.segments?.length,
});
const runDetail = run => ({
  ...runSummary(run),
  roots: run.roots,
  nodes: [...run.nodes.values()],
  outputs: run.outputs,
  displays: run.displays,
  errors: run.errors,
});
/** What the history keeps: the detail, with outputs dropped when they are too big to store. */
const storedRun = run => {
  const detail = runDetail(run);
  if (JSON.stringify(detail.outputs ?? null).length > HISTORY_OUTPUT_LIMIT) detail.outputs = {truncated: true};
  if (JSON.stringify(detail.displays ?? null).length > HISTORY_OUTPUT_LIMIT) detail.displays = {truncated: true};
  return detail;
};

async function executeRun(run) {
  run.callController = new AbortController();
  run.segments ??= [];
  const segment = {resolutions: clone(run.plan.resolutions ?? {}), draws: {}};
  run.segments.push(segment);
  const nodeEntry = (id, label) => {
    let entry = run.nodes.get(id);
    if (!entry)
      run.nodes.set(
        id,
        (entry = {node_id: id, label, status: 'running', started: nowSeconds(), ms: null, error: null})
      );
    return entry;
  };
  const hooks = {
    onNodeWait: ({node_id, label, wait}) => {
      Object.assign(nodeEntry(node_id, label), {status: 'waiting', wait});
      emit(run, 'node_waiting', {node_id, label, wait});
    },
    onNodeStart: ({node_id, label}) => {
      Object.assign(nodeEntry(node_id, label), {status: 'running', error: null}); // a node that runs again (a loop) is running again
      emit(run, 'node_started', {node_id, label});
    },
    onNodeDone: ({node_id, label, ms, display}) => {
      Object.assign(nodeEntry(node_id, label), {status: 'completed', ms});
      if (display !== undefined) run.displays[node_id] = display; // what the node showed is there while the run goes on
      emit(run, 'node_completed', {node_id, label, ms, ...(display !== undefined && {display})});
    },
    onNodeSkip: ({node_id, label}) => {
      if (run.nodes.get(node_id)?.status === 'waiting') run.nodes.get(node_id).status = 'cancelled';
      emit(run, 'node_skipped', {node_id, label});
    },
    onNodeFail: ({node_id, label, ms, error}) => {
      // A node stopped by cancel is "cancelled", not "failed".
      const cancelled = run.controller.signal.aborted;
      Object.assign(nodeEntry(node_id, label), {status: cancelled ? 'cancelled' : 'failed', ms, error});
      emit(run, cancelled ? 'node_cancelled' : 'node_failed', {node_id, label, ms, error});
    },
  };
  emit(run, 'run_started', {roots: run.roots});
  let result = null;
  try {
    result = await runPlanned(run.plan, runPlan, {
      signal: run.controller.signal,
      control: run.control,
      hooks,
    });
  } catch (error) {
    run.error = error.message || String(error);
  }
  if (run.pendingCalls?.size) run.callController.abort();
  while (run.pendingCalls?.size) await Promise.allSettled([...run.pendingCalls]);
  if (result)
    Object.assign(run, {
      outputs: {...run.outputs, ...result.outputs},
      displays: {...run.displays, ...result.displays},
      errors: {...run.errors, ...result.errors},
      evaluated_nodes: run.evaluated_nodes + result.done.length,
    });
  segment.draws = Object.fromEntries(
    Object.entries(result?.execution?.checkpoint?.journal ?? {}).map(([key, value]) => [key, value.draws ?? []])
  );
  if (result?.execution?.status === 'suspended' && !run.controller.signal.aborted) {
    run.checkpoint = {...result.execution.checkpoint, run_id: run.id, plan_ref: run.id};
    run.checkpoint_count = (run.checkpoint_count ?? 0) + 1;
    const prefs = (await DB.get('prefs')) ?? {};
    if (
      run.checkpoint_count > (prefs.max_checkpoints ?? 1000) ||
      JSON.stringify(run.checkpoint).length > (prefs.max_checkpoint_bytes ?? 20000000)
    ) {
      run.error = 'Checkpoint limit exceeded';
    } else {
      await exclusive(async () => {
        run.status = 'waiting';
        RUNS.active--;
        emit(run, 'run_suspended', {waits: run.checkpoint.waits});
        if (!run.replay && typeof registerApprovals === 'function') await registerApprovals(run, true);
        await persistRun(run, true);
        if (!run.replay) {
          const inbox = (await DB.get('event_inbox')) ?? [],
            resolutions = {};
          for (const wait of run.checkpoint.waits) {
            const event = inbox.find(
              e =>
                e.at >= wait.created_at &&
                e.name === wait.wait_spec.event &&
                (wait.wait_spec.match === undefined || matchEvent(wait.wait_spec.match, e.payload))
            );
            if (event) resolutions[wait.key] = {key: wait.key, value: event.payload};
          }
          if (Object.keys(resolutions).length) await continueRun(run, resolutions, true);
        }
      });
      return;
    }
  }
  run.finished = nowSeconds();
  run.ms = Math.round((run.finished - run.started) * 1000);
  const cancelled = run.controller.signal.aborted;
  for (const entry of run.nodes.values())
    if (['running', 'waiting'].includes(entry.status))
      Object.assign(entry, {status: run.error ? 'failed' : 'cancelled', error: run.error ?? 'Run cancelled'});
  run.status =
    cancelled && run.error !== 'Run lifetime exceeded'
      ? 'cancelled'
      : run.error || Object.keys(run.errors).length
        ? 'failed'
        : 'completed';
  RUNS.active--;
  emit(run, 'run_finished', {status: run.status});
  if (run.status === 'cancelled' || run.error === 'Run lifetime exceeded') await cancelRunApprovals(run.id);
  await persistRun(run);
  // Old finished runs leave memory; their detail stays in the history.
  const finished = [...RUNS.byId.values()].filter(r => terminalRun(r.status));
  for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_RUNS))) RUNS.byId.delete(old.id);
}

/**
 * Starts a run and returns it (still running). `locked` says the caller already holds the request lock, so the
 * snapshot must be taken without waiting for it again.
 */
async function startRun(
  c,
  {
    project_id,
    workflow_id,
    node_ids,
    trigger = 'api',
    trigger_id = null,
    payload = null,
    locked = false,
    budget,
    initiative_id = null,
    replay = null,
  }
) {
  if (String(project_id).startsWith('lib-')) throw bad('A Custom Node editor cannot be run');
  if (RUNS.active >= MAX_ACTIVE_RUNS)
    throw new ApiError('too_many_runs', `At most ${MAX_ACTIVE_RUNS} runs can be active at once`, 429);
  if (payload !== null && (!isObject(payload) || JSON.stringify(payload).length > MAX_PAYLOAD))
    throw bad(`payload must be an object of at most ${MAX_PAYLOAD} characters`);
  const runId = uid();
  const prepare = async () => {
    if (RUNS.active >= MAX_ACTIVE_RUNS) throw new ApiError('too_many_runs', 'Too many active runs', 429);
    const {editor, meta} = await c.workflow(project_id, workflow_id);
    const snapshot = editor.snapshot(),
      all = Editor.nodeMap(snapshot);
    const roots = node_ids ?? snapshot.nodes.filter(isRunStart).map(n => n.id);
    if (!Array.isArray(roots) || roots.some(id => typeof id !== 'string'))
      throw bad('node_ids must be a list of node IDs');
    if (!roots.length)
      throw bad('Nothing to run: add a node with the operation on_run and wire its signal to a Script');
    checkRoots(roots, all);
    for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
    await c.ctx.commit();
    const plan = compilePlan(snapshot, roots, {
      events: Object.fromEntries(roots.map(id => [id, {payload}])),
      context: {
        project_id,
        workflow_id: meta.id,
        run_id: runId,
        trigger,
        payload,
        initiative_id,
        budget_policy: (await c.prefs()).budget_policy ?? 'fail',
      },
    });
    await preparePlanPermissions(plan);
    await pinPlanVersions(plan, true);
    const limits = validateBudget(
      budget ?? (await c.prefs()).default_budget ?? {calls: 100, tokens: 1000000, cost: 10, ms: 604800000}
    );
    RUNS.active++;
    return {snapshot, workflow_id: meta.id, roots, plan, budget: limits};
  };
  const prepared = locked ? await prepare() : await exclusive(prepare);
  const run = {
    id: runId,
    project_id,
    workflow_id: prepared.workflow_id,
    status: 'running',
    trigger,
    trigger_id,
    payload,
    roots: [...new Set(prepared.roots)],
    started: nowSeconds(),
    finished: null,
    ms: null,
    evaluated_nodes: 0,
    nodes: new Map(),
    outputs: null,
    displays: {},
    errors: {},
    error: null,
    events: [],
    seq: 0,
    waiters: new Set(),
    controller: new AbortController(),
    control: runControl(),
    done: null,
    budget: prepared.budget,
    usage: {calls: 0, tokens: 0, cost: 0, ms: 0},
    initiative_id,
    trace: [],
    replay,
  };
  run.plan = prepared.plan;
  RUNS.byId.set(run.id, run);
  try {
    await persistRun(run, locked);
  } catch (error) {
    RUNS.active--;
    RUNS.byId.delete(run.id);
    throw error;
  }
  run.done = launchRun(run);
  return run;
}

async function findStoredRun(c, id) {
  return (await c.ctx.get(runKey(id))) ?? null;
}
const listLimit = c => {
  const limit = Number(c.query.limit ?? 50);
  if (!(limit >= 1 && limit <= 200)) throw bad('limit must be from 1 to 200');
  return limit;
};
const asSummary = r => {
  const {nodes, outputs, displays, errors, roots, ...rest} = r;
  return rest;
};

// ----- runs -----
route(
  'POST',
  'projects/{project_id}/runs',
  'Start a run of a workflow in the background',
  async (c, {project_id}) => {
    const {workflow_id = c.workflowId ?? undefined, node_ids, payload = null, wait = 0} = c.body;
    if (!(typeof wait === 'number' && wait >= 0 && wait <= 120)) throw bad('wait is a number of seconds from 0 to 120');
    const run = await startRun(c, {
      project_id,
      workflow_id,
      node_ids,
      payload,
      budget: c.body.budget,
      initiative_id: c.body.initiative_id,
    });
    if (wait) await untilDone(run, wait * 1000);
    return wait ? runDetail(run) : runSummary(run);
  },
  {
    unlocked: true,
    body: {
      workflow_id: 'optional',
      node_ids: ['optional: what to evaluate; default every on_run node'],
      payload: {},
      wait: 0,
    },
    returns:
      'The run (status "running"). It evaluates in the background; poll GET runs/{run_id}, follow GET runs/{run_id}/events, or pass wait (seconds, up to 120) to get the finished run back. A Script sees {run_id, trigger, payload} in `context`, and an on_run node has the payload as its output `payload`.',
  }
);
route(
  'GET',
  'projects/{project_id}/runs',
  'List the runs of a workflow, newest first',
  async (c, {project_id}) => {
    const {meta} = await c.workflow(project_id),
      limit = listLimit(c);
    const memory = [...RUNS.byId.values()].filter(r => r.workflow_id === meta.id).map(r => asSummary(runSummary(r)));
    let runs = memory.sort((a, b) => b.started - a.started);
    if (c.query.status) runs = runs.filter(r => r.status === c.query.status);
    return runs.slice(0, limit);
  },
  {query: ['workflow_id', 'status', 'limit'], returns: 'Run summaries (no node trace or outputs), newest first'}
);
route(
  'GET',
  'runs',
  'List the runs this application started recently',
  async c => {
    let runs = [...RUNS.byId.values()].map(runSummary).sort((a, b) => b.started - a.started);
    if (c.query.status) runs = runs.filter(r => r.status === c.query.status);
    return runs.slice(0, listLimit(c));
  },
  {unlocked: true, query: ['status', 'limit']}
);
route(
  'GET',
  'runs/{run_id}',
  'Read a run: status, a trace of every node, outputs and errors',
  async (c, {run_id}) => {
    const run = RUNS.byId.get(run_id);
    if (run) return runDetail(run);
    const stored = await findStoredRun(c, run_id);
    if (!stored) throw missing('Run not found');
    return stored;
  },
  {unlocked: true}
);
route(
  'POST',
  'runs/{run_id}/cancel',
  'Cancel a running run',
  async (c, {run_id}) => {
    const run = RUNS.byId.get(run_id);
    if (!run) {
      if (await findStoredRun(c, run_id)) throw bad('This run is already finished');
      throw missing('Run not found');
    }
    if (run.status === 'running' && !run.controller.signal.aborted) {
      run.controller.abort();
      emit(run, 'cancel_requested');
    }
    if (['waiting', 'interrupted'].includes(run.status)) {
      run.status = 'cancelled';
      run.finished = nowSeconds();
      for (const node of run.nodes.values())
        if (['waiting', 'running'].includes(node.status)) node.status = 'cancelled';
      emit(run, 'run_finished', {status: run.status});
      await persistRun(run);
    }
    await untilDone(run, 2000);
    if (run.status === 'cancelled') await cancelRunApprovals(run.id);
    return runSummary(run);
  },
  {unlocked: true, body: {}, returns: 'The run; its status becomes "cancelled" once the running node has been stopped'}
);
for (const [action, paused] of [
  ['pause', true],
  ['resume', false],
])
  route(
    'POST',
    `runs/{run_id}/${action}`,
    paused
      ? 'Pause a running run: no node starts until it is resumed (the nodes already running finish)'
      : 'Resume a paused run',
    async (c, {run_id}) => {
      const run = RUNS.byId.get(run_id);
      if (!run) {
        if (await findStoredRun(c, run_id)) throw bad('This run is already finished');
        throw missing('Run not found');
      }
      if (!paused && ['waiting', 'interrupted'].includes(run.status)) {
        const waits = run.checkpoint?.waits ?? [];
        if (waits.some(w => w.wait_spec.approval)) throw bad('Answer the pending approval to resume this run');
        return runSummary(
          await exclusive(() =>
            continueRun(
              run,
              Object.fromEntries(
                waits
                  .filter(w => !c.body.key || w.key === c.body.key)
                  .map(w => [w.key, {key: w.key, value: c.body.value ?? null}])
              ),
              true
            )
          )
        );
      }
      if (run.status !== 'running') throw bad('This run is already finished');
      if (run.control.paused !== paused) {
        run.control.set(paused);
        emit(run, paused ? 'run_paused' : 'run_resumed');
      }
      return runSummary(run);
    },
    {unlocked: true, body: {}, returns: 'The run, with `paused`'}
  );
route(
  'GET',
  'runs/{run_id}/events',
  'Events of a run since `after`, optionally waiting for new ones (long poll)',
  async (c, {run_id}) => {
    const after = Number(c.query.after ?? 0),
      wait = Math.min(Math.max(Number(c.query.wait ?? 0), 0), 30000);
    if (!Number.isFinite(after) || !Number.isFinite(wait)) throw bad('after and wait must be numbers');
    const run = RUNS.byId.get(run_id);
    if (!run) {
      const stored = await findStoredRun(c, run_id);
      if (!stored) throw missing('Run not found');
      return {events: [], next: after, status: stored.status, finished: true};
    }
    const deadline = Date.now() + wait;
    while (run.status === 'running' && run.seq <= after && Date.now() < deadline)
      await waitForChange(run, deadline - Date.now());
    return {
      events: run.events.filter(e => e.seq > after),
      next: Math.max(after, run.seq),
      status: run.status,
      finished: run.status !== 'running',
    };
  },
  {
    unlocked: true,
    query: ['after', 'wait'],
    returns:
      '{events, next, status, finished}; pass `next` as `after` of the following call. wait is in milliseconds (up to 30000).',
  }
);

// ----- triggers -----
route('POST', 'events/{name}', 'Deliver an event to waiting runs', (c, {name}) => wakeEvent(name, c.body), {
  unlocked: true,
  body: {},
});
const TRIGGER_TYPES = ['interval', 'webhook'];
async function triggerInput(c, body, old = null) {
  const out = {...(old || {})};
  if ('name' in body || !old) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 100) throw bad('A trigger name has 1 to 100 characters');
    out.name = name;
  }
  if (!old) {
    if (!TRIGGER_TYPES.includes(body.type)) throw bad(`type must be one of: ${TRIGGER_TYPES.join(', ')}`);
    out.type = body.type;
    out.project_id = String(body.project_id ?? '');
  }
  if (!old || 'workflow_id' in body) {
    const project = await c.project(out.project_id);
    if (out.project_id.startsWith('lib-')) throw bad('Triggers belong to projects');
    const workflow = project.workflows.find(w => w.id === (body.workflow_id ?? project.workflows[0]?.id));
    if (!workflow) throw missing('Workflow not found');
    out.workflow_id = workflow.id;
  }
  if (out.type === 'interval' && (!old || 'every_seconds' in body)) {
    const every = body.every_seconds;
    if (!Number.isInteger(every) || every < 10 || every > 2592000)
      throw bad('every_seconds is a whole number from 10 to 2592000');
    out.every_seconds = every;
  }
  if ('enabled' in body || !old) {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('enabled must be true or false');
    out.enabled = body.enabled ?? true;
  }
  return out;
}
route(
  'GET POST',
  'triggers',
  'List or create triggers that start runs by themselves',
  async c => {
    const triggers = await c.ctx.get('triggers', []);
    if (c.method === 'GET')
      return c.query.project_id ? triggers.filter(t => t.project_id === c.query.project_id) : triggers;
    if (triggers.length >= MAX_TRIGGERS) throw bad(`At most ${MAX_TRIGGERS} triggers`);
    const trigger = {
      id: uid(),
      ...(await triggerInput(c, c.body)),
      created: nowSeconds(),
      last_run_at: null,
      last_run_id: null,
    };
    if (trigger.type === 'webhook') trigger.token = uid();
    triggers.push(trigger);
    c.ctx.set('triggers', triggers);
    return trigger;
  },
  {
    query: ['project_id'],
    body: {
      name: 'Every minute',
      type: 'interval',
      project_id: 'project id',
      workflow_id: 'optional',
      every_seconds: 60,
      enabled: true,
    },
    returns:
      'The trigger. "interval" triggers fire while the AgentSys server runs (node server.js); "webhook" triggers have a token: POST /hooks/{token} starts a run with the request body as `payload`.',
  }
);
route(
  'GET PUT DELETE',
  'triggers/{trigger_id}',
  'Read, change or delete a trigger',
  async (c, {trigger_id}) => {
    const triggers = await c.ctx.get('triggers', []),
      index = triggers.findIndex(t => t.id === trigger_id);
    if (index < 0) throw missing('Trigger not found');
    if (c.method === 'GET') return triggers[index];
    if (c.method === 'DELETE') {
      triggers.splice(index, 1);
      c.ctx.set('triggers', triggers);
      return {deleted: trigger_id};
    }
    triggers[index] = await triggerInput(c, c.body, triggers[index]);
    c.ctx.set('triggers', triggers);
    return triggers[index];
  },
  {body: {enabled: false}}
);

/** Starts a run for a trigger and notes it on the trigger. Called with the request lock held. */
async function fireTrigger(c, trigger, payload) {
  const run = await startRun(c, {
    project_id: trigger.project_id,
    workflow_id: trigger.workflow_id,
    trigger: trigger.type,
    trigger_id: trigger.id,
    payload,
    locked: true,
  });
  trigger.last_run_at = run.started;
  trigger.last_run_id = run.id;
  return run;
}
route(
  'POST',
  'triggers/{trigger_id}/fire',
  'Start the run of a trigger now',
  async (c, {trigger_id}) => {
    const triggers = await c.ctx.get('triggers', []),
      trigger = triggers.find(t => t.id === trigger_id);
    if (!trigger) throw missing('Trigger not found');
    const run = await fireTrigger(c, trigger, c.body.payload ?? null);
    c.ctx.set('triggers', triggers);
    return runSummary(run);
  },
  {body: {payload: {}}}
);
route(
  'POST',
  'hooks/{token}',
  'Webhook: start the run of a webhook trigger with the request body as its payload',
  async (c, {token}) => {
    const triggers = await c.ctx.get('triggers', []),
      trigger = triggers.find(t => t.type === 'webhook' && t.enabled && t.token === token);
    if (!trigger) throw missing('Unknown webhook');
    const run = await fireTrigger(c, trigger, isObject(c.body) && Object.keys(c.body).length ? c.body : null);
    await wakeEvent(trigger.name, c.body, true);
    c.ctx.set('triggers', triggers);
    return runSummary(run);
  },
  {body: {}, returns: 'The started run'}
);
route(
  'POST',
  'scheduler/tick',
  'Start every interval trigger that is due (the headless server calls this every second)',
  async c => {
    const at = typeof c.body.now === 'number' ? c.body.now : nowSeconds(),
      triggers = await c.ctx.get('triggers', []),
      fired = [];
    for (const run of RUNS.byId.values()) {
      if (!['running', 'waiting', 'interrupted'].includes(run.status)) continue;
      const life = (await c.prefs()).run_lifetime_ms ?? 604800000;
      if (at * 1000 - run.started * 1000 > life) {
        if (run.status === 'running') {
          run.error = 'Run lifetime exceeded';
          run.controller.abort();
          continue;
        }
        run.status = 'failed';
        run.error = 'Run lifetime exceeded';
        run.finished = at;
        await cancelRunApprovals(run.id, true);
        emit(run, 'run_finished', {status: run.status});
        await persistRun(run, true);
        continue;
      }
      if (run.status !== 'waiting') continue;
      const due = (run.checkpoint?.waits ?? []).filter(w => w.due !== null && w.due <= at * 1000);
      if (due.length)
        await continueRun(run, Object.fromEntries(due.map(w => [w.key, {key: w.key, value: {at}}])), true);
    }
    if (typeof expireApprovals === 'function') await expireApprovals(at * 1000);
    const blobIndex = clone((await DB.get('blob_index')) ?? {}),
      cleanup = {};
    for (const [hash, created] of Object.entries(blobIndex))
      if (at * 1000 - created > ((await c.prefs()).blob_retention_ms ?? 604800000)) {
        cleanup['blobs/' + hash] = undefined;
        delete blobIndex[hash];
      }
    if (Object.keys(cleanup).length) await DB.commit({...cleanup, blob_index: blobIndex});
    for (const run of RUNS.byId.values()) {
      if (
        terminalRun(run.status) &&
        run.trace?.length &&
        at * 1000 - (run.finished ?? run.started) * 1000 > ((await c.prefs()).trace_retention_ms ?? 604800000)
      ) {
        run.trace = [];
        run.segments = [];
        emit(run, 'trace_expired');
        await persistRun(run, true);
      }
    }
    for (const trigger of triggers) {
      if (trigger.type !== 'interval' || !trigger.enabled) continue;
      if (at < (trigger.last_run_at ?? trigger.created) + trigger.every_seconds) continue;
      // A run that is still going is not overlapped; the trigger waits for its turn after it.
      if ([...RUNS.byId.values()].some(r => r.trigger_id === trigger.id && r.status === 'running')) continue;
      try {
        const run = await fireTrigger(c, trigger, null);
        trigger.last_run_at = at;
        fired.push({trigger_id: trigger.id, run_id: run.id});
      } catch (error) {
        trigger.last_run_at = at; // a trigger that cannot start (empty workflow, too many runs) is retried next interval
        fired.push({trigger_id: trigger.id, error: error.message});
      }
    }
    if (fired.length) c.ctx.set('triggers', triggers);
    return {fired};
  },
  {body: {}, returns: 'The triggers that fired, with the id of the run or the reason it could not start'}
);
