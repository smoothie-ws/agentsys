// Runs and triggers.
//
// A run evaluates a workflow in the background: POST starts it and answers at once, the run can be watched
// (status, a trace of every node, an event log you can long-poll), cancelled, and is remembered in the workflow's
// run history. Triggers start runs by themselves: on an interval (the headless server ticks the scheduler) or from a
// webhook. The canvas "Run" button still uses evaluate-node; both go through evaluateGraph.
'use strict';

const MAX_ACTIVE_RUNS = 16;
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
async function persistRun(run, locked = false, extra = {}, retentionAt = Date.now(), expireCurrent = false) {
  if (run.deleted) return;
  const save = async () => {
    const ids = (await DB.get('run_index')) ?? [];
    if (!ids.includes(run.id)) ids.push(run.id);
    const data = {
      ...storedRun(run),
      payload: run.payload,
      plan: run.plan,
      checkpoint_count: run.checkpoint_count ?? 0,
      seq: run.seq,
      event_limit: run.event_limit ?? limitOf(null, 'max_run_events'),
      event_bytes: run.event_bytes ?? 0,
      event_byte_limit: run.event_byte_limit ?? limitOf(null, 'max_event_bytes'),
      trace: run.trace ?? [],
      trace_bytes: run.trace_bytes ?? 0,
      trace_calls: run.trace_calls ?? 0,
      redacted_result: run.redacted_result ?? false,
      trace_limited: run.trace_limited ?? false,
      segments: run.segments ?? [],
      plan_bytes: run.plan_bytes ?? 0,
      segment: run.segment ?? 0,
      replay_of: run.replay_of ?? null,
      queue_delivery: run.queue_delivery ?? null,
      supervised: run.supervised ?? false,
      lifetime_exceeded: run.lifetime_exceeded ?? false,
      pending_resolutions: run.pending_resolutions ?? {},
      cancelled_waves: run.cancelled_waves ?? [],
      restarted_from: run.restarted_from ?? null,
      recovery_input: run.recovery_input ?? null,
      recovery_unavailable: run.recovery_unavailable ?? null,
      waves: run.waves ?? {},
      recovery_spec: run.recovery_spec ?? null,
      restarting: run.restarting ?? false,
      restart_request: run.restart_request ?? null,
      restarted_by: run.restarted_by ?? null,
      restart_error: run.restart_error ?? null,
      wave_cancel_pending: run.wave_cancel_pending ?? false,
    };
    // The run record is the commit point: checkpoint/events must reach disk first.
    const changes = {
      ...extra,
      ...(run.checkpoint ? {[runKey(run.id) + '/checkpoint']: clone(run.checkpoint)} : {}),
      [runKey(run.id) + '/events']: clone(run.events),
      [runKey(run.id)]: clone(data),
      run_index: ids,
    };
    const prefs = (await DB.get('prefs')) ?? {},
      at = retentionAt;
    let summaries = clone((await DB.get('run_summaries')) ?? []);
    if (terminalRun(run.status)) {
      summaries = summaries.filter(r => r.id !== run.id);
      summaries.push({...runSummary(run), details_available: true});
    }
    const completed = [];
    for (const id of ids) {
      const candidate = id === run.id ? data : await DB.get(runKey(id));
      if (candidate && terminalRun(candidate.status) && candidate.supervised && !candidate.restart_request)
        completed.push(candidate);
    }
    completed.sort((a, b) => (b.finished ?? b.started) - (a.finished ?? a.started));
    for (const [position, old] of completed.entries()) {
      const expired =
        position >= limitOf(prefs, 'run_retention') ||
        at - old.finished * 1000 > limitOf(prefs, 'run_retention_ms');
      if (!expired || (old.id === run.id && !expireCurrent)) continue;
      await clearBridgeTrace(old, changes);
      for (const suffix of ['', '/checkpoint', '/events']) changes[runKey(old.id) + suffix] = undefined;
      ids.splice(ids.indexOf(old.id), 1);
      RUNS.byId.delete(old.id);
      const summary = summaries.find(r => r.id === old.id);
      if (summary) {
        summary.details_available = false;
        summary.replay_available = false;
      }
    }
    summaries = summaries
      .filter(r => at - r.finished * 1000 <= limitOf(prefs, 'run_summary_retention_ms'))
      .sort((a, b) => b.started - a.started)
      .slice(0, limitOf(prefs, 'run_summary_retention'));
    changes.run_summaries = summaries;
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
    for (const entry of stored?.trace ?? [])
      for (const key of [entry.request_ref, entry.response_ref]) if (key) await c.ctx.remove(key);
    for (const suffix of ['', '/checkpoint', '/events']) await c.ctx.remove(runKey(id) + suffix);
  }
  c.ctx.set('run_index', keep);
  c.ctx.set(
    'run_summaries',
    (await c.ctx.get('run_summaries', [])).filter(r => r.workflow_id !== workflowId)
  );
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
      if (terminalRun(run.status) && !run.supervised)
        setTimeout(() => finishActivation(run).catch(error => console.warn(error.message)), 0);
      if (run.status === 'running') {
        run.status = 'interrupted';
        emit(run, 'run_interrupted');
        await persistRun(run, true);
      }
      if (run.restart_request) scheduleOutputRestart(run);
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
        await finishActivation(run);
      } catch (storageError) {
        run.error += '; persistence failed: ' + storageError.message;
      }
    });
}
async function continueRun(run, resolutions, locked = false) {
  if (run.restarting) throw bad('An output restart is in progress');
  if (!['waiting', 'interrupted'].includes(run.status) || !run.checkpoint) throw bad('Run has no resumable checkpoint');
  if (((await DB.get(workflowControlKey(run.workflow_id)))?.status ?? 'enabled') !== 'enabled')
    throw new ApiError('workflow_paused', 'Enable the workflow before resuming an activation', 409);
  if (RUNS.active >= MAX_ACTIVE_RUNS) throw new ApiError('too_many_runs', 'Too many active runs', 429);
  const earlier = run.plan.resolutions;
  if (!run.replay) run.plan = await currentRunPlan(run);
  run.plan.cancelled_waves = run.cancelled_waves ?? [];
  if (run.recovery_spec) run.plan.recovery = clone(run.recovery_spec);
  run.plan.checkpoint = clone(run.checkpoint);
  run.plan.resolutions = {...earlier, ...run.plan.resolutions, ...resolutions};
  run.pending_resolutions = {};
  run.wave_cancel_pending = false;
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
const eventMatchesWait = (event, runId, wait) =>
  event.name === wait.wait_spec.event &&
  (!event.target || (event.target.run_id === runId && event.target.key === wait.key)) &&
  (wait.wait_spec.match === undefined || matchEvent(wait.wait_spec.match, event.payload));
async function wakeEvent(name, payload, locked = false, target = null) {
  const wake = async () => {
    if (target && (target.run_id !== undefined || target.key !== undefined)) {
      const run = RUNS.byId.get(target.run_id),
        wait = run?.checkpoint?.waits.find(w => w.key === target.key);
      if (!run || run.status !== 'waiting' || !wait || !eventMatchesWait({name, payload}, run.id, wait))
        throw bad('Event does not match the selected wait');
      target = {run_id: target.run_id, key: target.key};
    } else target = null;
    if (JSON.stringify(payload).length > MAX_PAYLOAD) throw bad('Event payload is too large');
    const deliveryChanges = {};
    if (payload?.dedupe_key !== undefined) {
      if (typeof payload.dedupe_key !== 'string' || !payload.dedupe_key || payload.dedupe_key.length > 200)
        throw bad('Invalid dedupe_key');
      const at = Date.now(),
        key = await hashText(name + (target ? ':' + JSON.stringify(target) : '') + ':' + payload.dedupe_key),
        ledger = Object.fromEntries(
          Object.entries((await DB.get('event_dedupe')) ?? {}).filter(([, expires]) => expires > at)
        );
      if (ledger[key]) return {resumed: [], duplicate: true};
      if (Object.keys(ledger).length >= 10000) throw new ApiError('dedupe_full', 'Event dedupe window is full', 429);
      ledger[key] = at + limitOf(await DB.get('prefs'), 'event_dedupe_ms');
      deliveryChanges.event_dedupe = ledger;
    }
    const oldest = Math.min(
      Date.now(),
      ...[...RUNS.byId.values()].filter(r => r.status === 'running').map(r => r.started * 1000)
    );
    const inbox = clone((await DB.get('event_inbox')) ?? []).filter(e => e.at >= oldest);
    if (inbox.length >= MAX_EVENTS) throw new ApiError('event_inbox_full', 'Event inbox is full; retry delivery', 429);
    inbox.push({name, payload, at: Date.now(), ...(target ? {target} : {})});
    await DB.commit({...deliveryChanges, event_inbox: inbox});
    const resumed = [];
    for (const run of RUNS.byId.values()) {
      if (run.status !== 'waiting') continue;
      if (run.restarting) continue;
      if (target && target.run_id !== run.id) continue;
      const resolutions = Object.fromEntries(
        (run.checkpoint?.waits ?? [])
          .filter(
            w =>
              (!target || target.key === w.key) &&
              w.wait_spec.event === name &&
              (w.wait_spec.match === undefined || matchEvent(w.wait_spec.match, payload))
          )
          .map(w => [w.key, {key: w.key, value: payload}])
      );
      if (!Object.keys(resolutions).length) continue;
      const status = (await DB.get(workflowControlKey(run.workflow_id)))?.status ?? 'enabled';
      if (status !== 'enabled') {
        run.pending_resolutions = {...run.pending_resolutions, ...resolutions};
        await persistRun(run, true);
        continue;
      }
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
    manualPaused: false,
    workflowPaused: false,
    send: null,
    patches: [],
    cancelWave(path) {
      if (this.send) this.send({type: 'cancel_wave', path});
      else this.patches.push({cancel: path});
    },
    patch(patch) {
      if (this.send) this.send({type: 'patch', patch});
      else this.patches.push(patch);
    },
    attach(send) {
      this.send = send;
      for (const patch of this.patches.splice(0))
        send(patch.cancel ? {type: 'cancel_wave', path: patch.cancel} : {type: 'patch', patch});
      if (this.paused) send({type: 'pause'});
    },
    set(paused, kind = 'manual') {
      this[kind === 'workflow' ? 'workflowPaused' : 'manualPaused'] = paused;
      this.paused = this.manualPaused || this.workflowPaused;
      this.send?.({type: this.paused ? 'pause' : 'resume'});
    },
  };
}

function emit(run, type, data = {}) {
  const event = {seq: ++run.seq, at: nowSeconds(), type, ...data};
  run.event_bytes ??= run.events.reduce((bytes, e) => bytes + utf8Bytes(e), 0);
  run.events.push(event);
  run.event_bytes += utf8Bytes(event);
  while (run.events.length > (run.event_limit ?? limitOf(null, 'max_run_events')) || run.event_bytes > (run.event_byte_limit ?? limitOf(null, 'max_event_bytes')))
    run.event_bytes -= utf8Bytes(run.events.shift());
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

const runSummary = run =>
  !(run.nodes instanceof Map)
    ? run
    : {
        id: run.id,
        project_id: run.project_id,
        workflow_id: run.workflow_id,
        status: run.status,
        paused: run.control?.paused === true,
        trigger: run.trigger,
        trigger_id: run.trigger_id ?? null,
        overlap: run.overlap,
        activation_id: run.activation_id ?? run.id,
        activation_started: run.activation_started ?? run.started,
        attempt: run.attempt ?? 1,
        retry_of: run.retry_of ?? null,
        started: run.started,
        finished: run.finished,
        ms: run.ms,
        evaluated_nodes: run.evaluated_nodes,
        failed_nodes: [...run.nodes.values()].filter(n => ['failed', 'blocked'].includes(n.status)).length,
        error: run.error ?? null,
        waits: ['waiting', 'interrupted'].includes(run.status) ? (run.checkpoint?.waits ?? []) : [],
        replay_available:
          terminalRun(run.status) && !!run.plan && !!run.segments?.length && !run.redacted_result && !run.trace_limited,
        replay_unavailable_reason: run.redacted_result ? 'redacted_result' : run.trace_limited ? 'trace_limit' : null,
        details_available: true,
        restarted_from: run.restarted_from ?? null,
        recovery_available: !!run.checkpoint && !run.recovery_unavailable,
      };
const runDetail = run =>
  !(run.nodes instanceof Map)
    ? runSummary(run)
    : {
        ...runSummary(run),
        roots: run.roots,
        nodes: [...run.nodes.values()],
        outputs: run.outputs,
        displays: run.displays,
        errors: run.errors,
        invocations: Object.entries(run.checkpoint?.journal ?? {}).map(([invocation, entry]) => ({
          invocation,
          ...entry,
        })),
        waves: run.waves ?? run.checkpoint?.waves ?? {},
      };
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
  run.plan_byte_limit = limitOf(await DB.get('prefs'), 'max_trace_bytes');
  const segment = {
    plan: clone(run.plan),
    resolutions: clone(run.plan.resolutions ?? {}),
    draws: {},
    patches: [],
    authorizations: [],
    controls: [],
    checkpoint: clone(run.recovery_input ?? null),
  };
  delete segment.plan.checkpoint;
  const segmentBytes = utf8Bytes(segment);
  if (run.replay) run.segments.push(segment);
  else if ((run.plan_bytes ?? 0) + segmentBytes > run.plan_byte_limit) {
    run.trace_limited = true;
    run.segments = [];
  } else if (!run.trace_limited) {
    run.plan_bytes = (run.plan_bytes ?? 0) + segmentBytes;
    run.segments.push(segment);
  }
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
    onNodeStart: ({node_id, label, node_version, invocation, wave_path}) => {
      Object.assign(nodeEntry(node_id, label), {status: 'running', error: null, node_version, invocation, wave_path});
      emit(run, 'node_started', {node_id, label, node_version, invocation, wave_path});
    },
    onNodeBlocked: entry => {
      Object.assign(nodeEntry(entry.node_id, entry.label), {...entry, status: 'blocked', error: entry.reason});
      emit(run, 'node_blocked', entry);
    },
    onNodeDone: ({node_id, label, ms, display}) => {
      Object.assign(nodeEntry(node_id, label), {status: 'completed', ms});
      if (display !== undefined) run.displays[node_id] = display; // what the node showed is there while the run goes on
      emit(run, 'node_completed', {node_id, label, ms, ...(display !== undefined && {display})});
    },
    onNodeSkip: ({node_id, label, reason, invocation, wave_path}) => {
      if (run.nodes.get(node_id)?.status === 'waiting') run.nodes.get(node_id).status = 'cancelled';
      emit(run, 'node_skipped', {node_id, label, reason, invocation, wave_path});
    },
    onNodeFail: ({node_id, label, ms, error, blocked}) => {
      // A node stopped by cancel is "cancelled", not "failed".
      const cancelled = run.controller.signal.aborted;
      Object.assign(nodeEntry(node_id, label), {
        status: cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed',
        ms,
        error,
      });
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
  if (result?.crash) run.error = result.crash.message;
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
  if (result?.execution?.checkpoint && !run.controller.signal.aborted) {
    await saveExecutionBoundary(run.id, result.execution.checkpoint);
  }
  if (result?.execution?.status === 'suspended' && !run.controller.signal.aborted) {
    run.checkpoint = {...result.execution.checkpoint, run_id: run.id, graph_ref: run.workflow_id};
    run.checkpoint_count = (run.checkpoint_count ?? 0) + 1;
    const prefs = (await DB.get('prefs')) ?? {};
    if (
      run.checkpoint_count > limitOf(prefs, 'max_checkpoints') ||
      JSON.stringify(run.checkpoint).length > limitOf(prefs, 'max_checkpoint_bytes')
    ) {
      run.error = 'Checkpoint limit exceeded';
    } else {
      await exclusive(async () => {
        run.status = 'waiting';
        RUNS.active--;
        emit(run, 'run_suspended', {waits: run.checkpoint.waits});
        await persistRun(run, true);
        if (!run.replay) {
          const inbox = (await DB.get('event_inbox')) ?? [],
            resolutions = {};
          for (const wait of run.checkpoint.waits) {
            const event = inbox.find(e => e.at >= wait.created_at && eventMatchesWait(e, run.id, wait));
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
  await persistRun(run);
  await finishActivation(run);
  // Detailed runs in memory and on disk share the configured retention bound.
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
    replay = null,
    dedupe_key = null,
    overlap = 'parallel',
    from_pending = false,
    run_id = null,
    activation_id = null,
    activation_started = null,
    attempt = 1,
    retry_of = null,
    queue_delivery = null,
  }
) {
  if (!locked)
    return exclusive(() =>
      startRun(c, {
        project_id,
        workflow_id,
        node_ids,
        trigger,
        trigger_id,
        payload,
        replay,
        dedupe_key,
        overlap,
        from_pending,
        run_id,
        activation_id,
        activation_started,
        attempt,
        retry_of,
        queue_delivery,
        locked: true,
      })
    );
  if (String(project_id).startsWith('lib-')) throw bad('A Custom Node editor cannot be run');
  if (payload !== null && (!isObject(payload) || JSON.stringify(payload).length > MAX_PAYLOAD))
    throw bad(`payload must be an object of at most ${MAX_PAYLOAD} characters`);
  const runId = run_id ?? uid();
  const prepare = async () => {
    const {editor, meta, doc} = await c.workflow(project_id, workflow_id);
    // A scheduler request can prepare several activations from the same document.
    // Storage keeps only owned types; every snapshot still needs the Library types.
    doc.types = unifyTypes(await c.libraryTypes(), doc.types).types;
    const admission = await admitActivation(c, {
      id: runId,
      project_id,
      workflow_id: meta.id,
      node_ids,
      trigger,
      trigger_id,
      payload,
      dedupe_key,
      overlap,
      from_pending,
    });
    if (admission.duplicate) return {duplicate: admission.duplicate};
    if (RUNS.active >= MAX_ACTIVE_RUNS) throw new ApiError('too_many_runs', 'Too many active runs', 429);
    const snapshot = editor.snapshot(),
      all = Editor.nodeMap(snapshot);
    const roots = node_ids ?? snapshot.nodes.filter(isRunStart).map(n => n.id);
    if (!Array.isArray(roots) || roots.some(id => typeof id !== 'string'))
      throw bad('node_ids must be a list of node IDs');
    if (!roots.length)
      throw bad('Nothing to run: add a node with the operation on_run and wire its signal to a Script');
    checkRoots(roots, all);
    for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
    // Only graph refreshes precede version pinning. Queue claims and pending-job
    // removal must commit atomically with the new run, never in an earlier write.
    const graphChanges = Object.fromEntries(
      Object.entries(c.ctx.changes()).filter(
        ([key]) => key.startsWith('wf:') || ['resources', 'library_types'].includes(key)
      )
    );
    if (Object.keys(graphChanges).length) await versionedCommit(graphChanges);
    const compileCache = new Map();
    const plan = compilePlan(snapshot, roots, {
      cache: compileCache,
      events: Object.fromEntries(roots.map(id => [id, {payload}])),
      context: {
        project_id,
        workflow_id: meta.id,
        run_id: runId,
        virtual_run_id: activation_id ?? runId,
        trigger,
        payload,
      },
    });
    await preparePlanPermissions(plan);
    await versionPlan(plan);
    RUNS.active++;
    return {snapshot, workflow_id: meta.id, roots, plan, compileCache};
  };
  const prepared = locked ? await prepare() : await exclusive(prepare);
  if (prepared.duplicate) return prepared.duplicate;
  const run = {
    compileCache: prepared.compileCache,
    id: runId,
    overlap,
    activation_id: activation_id ?? runId,
    activation_started: activation_started ?? nowSeconds(),
    attempt,
    retry_of,
    queue_delivery,
    event_limit: limitOf(await c.prefs(), 'max_run_events'),
    event_byte_limit: limitOf(await c.prefs(), 'max_event_bytes'),
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
    trace: [],
    replay,
  };
  run.plan = prepared.plan;
  RUNS.byId.set(run.id, run);
  try {
    await persistRun(run, locked, c.ctx.changes());
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
async function runRecordedHook(plan) {
  const run = hydrateRun({
    id: uid(),
    project_id: plan.context.project_id,
    workflow_id: plan.context.workflow_id,
    trigger: 'hook',
    status: 'running',
    started: nowSeconds(),
    finished: null,
    roots: plan.roots.map(r => r.id),
    outputs: {},
    displays: {},
    errors: {},
    trace: [],
    segments: [],
    evaluated_nodes: 0,
    payload: null,
  });
  plan.context.run_id = run.id;
  for (const n of plan.nodes) n.context.run_id = run.id;
  run.plan = plan;
  await exclusive(async () => {
    if (RUNS.active >= MAX_ACTIVE_RUNS) throw new ApiError('too_many_runs', 'Too many active runs', 429);
    RUNS.byId.set(run.id, run);
    RUNS.active++;
    await persistRun(run, true);
  });
  run.done = executeRun(run);
  await run.done;
  if (run.status === 'failed') throw new Error(run.error ?? Object.values(run.errors)[0] ?? 'Hook failed');
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
    const {workflow_id = c.workflowId ?? undefined, node_ids, payload = null, wait = 0, dedupe_key = null} = c.body;
    if (!(typeof wait === 'number' && wait >= 0 && wait <= 120)) throw bad('wait is a number of seconds from 0 to 120');
    const run = await startRun(c, {
      project_id,
      workflow_id,
      node_ids,
      payload,
      dedupe_key,
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
    const saved = ((await DB.get('run_summaries')) ?? []).filter(
      r => r.workflow_id === meta.id && !memory.some(m => m.id === r.id)
    );
    let runs = [...memory, ...saved].sort((a, b) => b.started - a.started);
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
    const live = [...RUNS.byId.values()].map(runSummary);
    let runs = [...live, ...((await DB.get('run_summaries')) ?? []).filter(r => !live.some(m => m.id === r.id))].sort(
      (a, b) => b.started - a.started
    );
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
    if (!stored) {
      const summary = ((await DB.get('run_summaries')) ?? []).find(r => r.id === run_id);
      if (summary) return summary;
      throw missing('Run not found');
    }
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
      await finishActivation(run);
    }
    await untilDone(run, 2000);
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
      truncated: run.events.length > 0 && after < run.events[0].seq - 1,
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
route(
  'POST',
  'events/{name}',
  'Deliver a deduplicated event to waiting runs',
  (c, {name}) => wakeEvent(name, c.body, false, c.query),
  {
    unlocked: true,
    body: {},
  }
);
const TRIGGER_TYPES = ['interval', 'webhook', 'queue'];
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
  out.overlap = body.overlap ?? out.overlap ?? (out.type === 'interval' ? 'skip' : 'parallel');
  if ('node_ids' in body) {
    if (
      !Array.isArray(body.node_ids) ||
      !body.node_ids.length ||
      body.node_ids.length > MAX_ROOTS ||
      body.node_ids.some(id => typeof id !== 'string')
    )
      throw bad('Invalid trigger node_ids');
    out.node_ids = [...new Set(body.node_ids)];
  }
  if (!['skip', 'queue', 'parallel'].includes(out.overlap)) throw bad('Invalid overlap');
  if (out.type === 'queue') {
    out.queue = stateKey(body.queue ?? out.queue ?? '');
    out.max_concurrency = body.max_concurrency ?? out.max_concurrency ?? 1;
    if (!Number.isSafeInteger(out.max_concurrency) || out.max_concurrency < 1 || out.max_concurrency > 16)
      throw bad('Invalid max_concurrency');
    out.overlap = 'parallel';
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
async function fireTrigger(c, trigger, payload, dedupe_key = null, queue_delivery = null) {
  const run = await startRun(c, {
    project_id: trigger.project_id,
    workflow_id: trigger.workflow_id,
    trigger: trigger.type,
    trigger_id: trigger.id,
    node_ids: trigger.node_ids,
    payload,
    dedupe_key,
    overlap: trigger.overlap ?? (trigger.type === 'interval' ? 'skip' : 'parallel'),
    queue_delivery,
    locked: true,
  });
  trigger.last_run_at = run.started ?? nowSeconds();
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
    const run = await fireTrigger(c, trigger, c.body.payload ?? null, c.body.dedupe_key ?? null);
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
    const run = await fireTrigger(
      c,
      trigger,
      isObject(c.body) && Object.keys(c.body).length ? c.body : null,
      c.body.dedupe_key ?? null
    );
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
      if (run.restart_request) {
        scheduleOutputRestart(run);
        continue;
      }
      if (!['running', 'waiting', 'interrupted'].includes(run.status)) continue;
      if (run.status !== 'interrupted') await renewQueueDelivery(c, run.workflow_id, run.queue_delivery, at * 1000);
      const life = limitOf(await c.prefs(), 'run_lifetime_ms');
      if (at * 1000 - (run.activation_started ?? run.started) * 1000 > life) {
        run.lifetime_exceeded = true;
        if (run.status === 'running') {
          run.error = 'Run lifetime exceeded';
          run.controller.abort();
          continue;
        }
        run.status = 'failed';
        run.error = 'Run lifetime exceeded';
        run.finished = at;
        emit(run, 'run_finished', {status: run.status});
        await persistRun(run, true);
        setTimeout(() => finishActivation(run).catch(error => console.warn(error.message)), 0);
        continue;
      }
      if (run.restarting) continue;
      if (
        run.wave_cancel_pending &&
        ['waiting', 'interrupted'].includes(run.status) &&
        (await workflowControl(c, run.workflow_id)).status === 'enabled' &&
        RUNS.active < MAX_ACTIVE_RUNS
      ) {
        await continueRun(run, {}, true);
        continue;
      }
      if (run.status !== 'waiting' || (await workflowControl(c, run.workflow_id)).status !== 'enabled') continue;
      const inbox = await c.ctx.get('event_inbox', []),
        held = {...run.pending_resolutions};
      for (const wait of run.checkpoint?.waits ?? []) {
        const event = inbox.find(e => e.at >= wait.created_at && eventMatchesWait(e, run.id, wait));
        if (event) held[wait.key] = {key: wait.key, value: event.payload};
      }
      if (Object.keys(held).length) {
        await continueRun(run, held, true);
        continue;
      }
      const due = (run.checkpoint?.waits ?? []).filter(w => w.due !== null && w.due <= at * 1000);
      if (due.length)
        await continueRun(run, Object.fromEntries(due.map(w => [w.key, {key: w.key, value: {at}}])), true);
    }
    for (const run of RUNS.byId.values()) {
      if (
        terminalRun(run.status) &&
        (run.trace?.length || run.segments?.length) &&
        at * 1000 - (run.finished ?? run.started) * 1000 > limitOf(await c.prefs(), 'trace_retention_ms')
      ) {
        const expiredBlobs = {};
        await clearBridgeTrace(run, expiredBlobs);
        await DB.commit(expiredBlobs);
        emit(run, 'trace_expired');
        await persistRun(run, true);
      }
    }
    await dispatchPending(c, at * 1000, fired);
    for (const trigger of triggers) {
      if (trigger.type !== 'interval' || !trigger.enabled) continue;
      if (at < (trigger.last_run_at ?? trigger.created) + trigger.every_seconds) continue;
      if ((await workflowControl(c, trigger.workflow_id)).status !== 'enabled') continue;
      try {
        const run = await fireTrigger(c, trigger, null);
        trigger.last_run_at = at;
        fired.push({trigger_id: trigger.id, run_id: run.id});
      } catch (error) {
        trigger.last_run_at = at; // a trigger that cannot start (empty workflow, too many runs) is retried next interval
        fired.push({trigger_id: trigger.id, error: error.message});
      }
    }
    for (const trigger of triggers.filter(t => t.type === 'queue' && t.enabled)) {
      if ((await workflowControl(c, trigger.workflow_id)).status !== 'enabled') continue;
      const count =
        [...RUNS.byId.values()].filter(r => r.trigger_id === trigger.id && !terminalRun(r.status)).length +
        (await workflowControl(c, trigger.workflow_id)).pending.filter(j => j.trigger_id === trigger.id).length;
      for (let i = count; i < trigger.max_concurrency && RUNS.active < MAX_ACTIVE_RUNS; i++) {
        const [item] = await queuePull(c, trigger.workflow_id, trigger.queue, {}, at * 1000);
        if (!item) break;
        const run = await fireTrigger(c, trigger, {queue: trigger.queue, item}, null, {
          name: trigger.queue,
          receipt: item.id,
        });
        fired.push({trigger_id: trigger.id, run_id: run.id});
      }
    }
    if (fired.length) c.ctx.set('triggers', triggers);
    const completed = [...RUNS.byId.values()].find(r => terminalRun(r.status) && r.supervised);
    if (completed) await persistRun(completed, true, {}, at * 1000, true);
    return {fired};
  },
  {body: {}, returns: 'The triggers that fired, with the id of the run or the reason it could not start'}
);
