'use strict';
const workflowControlKey = id => workflowBase(id) + '/control';
const defaultWorkflowControl = () => ({
  status: 'enabled',
  reason: null,
  failures: 0,
  max_attempts: 3,
  backoff_ms: 1000,
  pause_after: 5,
  dedupe_ms: 86400000,
  pending_limit: 1000,
  pending: [],
  dedupe: {},
  quotas: [],
});
async function workflowControl(c, id) {
  await workflowOwner(c, id);
  return c.ctx.get(workflowControlKey(id), defaultWorkflowControl());
}
route(
  'GET PUT',
  'workflows/{workflow_id}/control',
  'Read or configure workflow supervision',
  async (c, {workflow_id}) => {
    const control = await workflowControl(c, workflow_id);
    if (c.method === 'PUT') {
      const allowed = ['status', 'max_attempts', 'backoff_ms', 'pause_after', 'dedupe_ms', 'pending_limit', 'quotas'];
      if (Object.keys(c.body).some(k => !allowed.includes(k))) throw bad('Unknown workflow setting');
      for (const key of allowed.filter(k => !['status', 'quotas'].includes(k)))
        if (key in c.body) {
          if (
            !Number.isSafeInteger(c.body[key]) ||
            c.body[key] < 1 ||
            c.body[key] > (['backoff_ms', 'dedupe_ms'].includes(key) ? 604800000 : 10000)
          )
            throw bad('Invalid ' + key);
          control[key] = c.body[key];
        }
      if ('status' in c.body) {
        if (!['enabled', 'paused', 'disabled'].includes(c.body.status)) throw bad('Invalid workflow status');
        control.status = c.body.status;
        c.workflowMode = {workflow_id, status: control.status};
        control.reason = control.status === 'enabled' ? null : 'manual';
        if (control.status === 'enabled') control.failures = 0;
      }
      if ('quotas' in c.body) {
        control.quotas = validateQuotas(c.body.quotas);
        const usageKey = workflowBase(workflow_id) + '/usage',
          usage = await c.ctx.get(usageKey, {});
        c.ctx.set(
          usageKey,
          Object.fromEntries(
            Object.entries(usage).filter(
              ([key]) =>
                ['calls', 'units', 'methods'].includes(key) || control.quotas.some(r => r.key === key)
            )
          )
        );
      }
      c.ctx.set(workflowControlKey(workflow_id), control);
    }
    return {
      workflow_id,
      ...control,
      dedupe: undefined,
      pending: control.pending.map(j => ({
        id: j.activation_id,
        due: j.due,
        trigger_id: j.trigger_id,
        attempt: j.attempt,
      })),
    };
  },
  {body: {status: 'enabled', max_attempts: 3, backoff_ms: 1000, pause_after: 5, quotas: []}}
);
async function admitActivation(c, spec) {
  const ctl = await workflowControl(c, spec.workflow_id),
    at = Date.now();
  ctl.dedupe = Object.fromEntries(Object.entries(ctl.dedupe).filter(([, e]) => e.expires > at));
  if (!spec.from_pending && spec.dedupe_key !== null && spec.dedupe_key !== undefined) {
    if (typeof spec.dedupe_key !== 'string' || !spec.dedupe_key || spec.dedupe_key.length > 200)
      throw bad('dedupe_key is text of 1 to 200 characters');
    // Trigger identity separates independent sources of equal delivery keys.
    const key = `${spec.trigger_id ?? 'api'}:${spec.dedupe_key}`;
    const found = ctl.dedupe[key];
    if (found) {
      const existing = RUNS.byId.get(found.id) ?? (await DB.get(runKey(found.id)));
      const summary = ((await DB.get('run_summaries')) ?? []).find(r => r.id === found.id);
      return {
        duplicate:
          existing?.nodes instanceof Map
            ? existing
            : existing
              ? hydrateRun(existing)
              : (summary ?? {id: found.id, status: found.status ?? 'queued', duplicate: true}),
      };
    }
    if (Object.keys(ctl.dedupe).length >= 10000) throw new ApiError('dedupe_full', 'Dedupe window is full', 429);
    ctl.dedupe[key] = {id: spec.id, expires: at + ctl.dedupe_ms};
  }
  if (ctl.status !== 'enabled')
    throw new ApiError('workflow_paused', 'Workflow is ' + ctl.status + ': ' + ctl.reason, 409);
  const busy =
    spec.trigger_id &&
    ([...RUNS.byId.values()].some(r => r.trigger_id === spec.trigger_id && !terminalRun(r.status)) ||
      ctl.pending.some(j => j.trigger_id === spec.trigger_id));
  if (busy && spec.overlap !== 'parallel' && !spec.from_pending) {
    if (spec.overlap === 'skip') {
      if (spec.dedupe_key) ctl.dedupe[`${spec.trigger_id ?? 'api'}:${spec.dedupe_key}`].status = 'skipped';
      c.ctx.set(workflowControlKey(spec.workflow_id), ctl);
      await c.ctx.commit();
      return {duplicate: {id: spec.id, status: 'skipped', reason: 'overlap', workflow_id: spec.workflow_id}};
    }
    if (ctl.pending.length >= ctl.pending_limit)
      throw new ApiError('activation_queue_full', 'Activation queue is full', 429);
    ctl.pending.push({...spec, activation_id: spec.id, activation_started: at / 1000, attempt: 1, due: at});
    c.ctx.set(workflowControlKey(spec.workflow_id), ctl);
    await c.ctx.commit();
    return {duplicate: {id: spec.id, status: 'queued', workflow_id: spec.workflow_id}};
  }
  c.ctx.set(workflowControlKey(spec.workflow_id), ctl);
  return {control: ctl};
}
async function finishActivation(run) {
  if (run.replay || run.deleted || run.supervised || run.restarting) return;
  await exclusive(async () => {
    if (run.deleted || run.supervised || run.restarting) return;
    const c = new Call('PUT', {}, {}, null),
      ctl = await workflowControl(c, run.workflow_id);
    const retry =
      run.status === 'failed' &&
      !run.lifetime_exceeded &&
      (run.attempt ?? 1) < ctl.max_attempts &&
      ctl.pending.length < ctl.pending_limit;
    const due = Date.now() + ctl.backoff_ms * 2 ** Math.min(16, (run.attempt ?? 1) - 1);
    if (run.queue_delivery) {
      const {name, receipt} = run.queue_delivery,
        {log, state} = await queueRead(c, run.workflow_id, name),
        item = state.items.find(i => i.receipt === receipt);
      if (item) {
        if (run.status === 'completed') {
          await queueWrite(c, run.workflow_id, name, log, [{op: 'remove', id: item.id}]);
          c.queueFreed = {workflow_id: run.workflow_id, name};
        } else
          await queueWrite(c, run.workflow_id, name, log, [
            {
              op: 'lease',
              id: item.id,
              lease: {
                receipt: retry ? receipt : null,
                visible_at: retry ? due + state.options.visibility_ms : Date.now() + ctl.backoff_ms,
              },
            },
          ]);
      }
    }
    if (retry) {
      ctl.pending.push({
        id: uid(),
        project_id: run.project_id,
        workflow_id: run.workflow_id,
        node_ids: run.roots,
        trigger: run.trigger,
        trigger_id: run.trigger_id,
        payload: run.payload,
        activation_id: run.activation_id,
        activation_started: run.activation_started ?? run.started,
        retry_of: run.id,
        attempt: (run.attempt ?? 1) + 1,
        due,
        queue_delivery: run.queue_delivery,
        overlap: run.overlap,
      });
      emit(run, 'retry_scheduled', {attempt: (run.attempt ?? 1) + 1, due});
    } else if (run.status === 'failed') ctl.failures++;
    else if (run.status === 'completed') ctl.failures = 0;
    if (ctl.failures >= ctl.pause_after) {
      ctl.status = 'paused';
      ctl.reason = 'consecutive_failures';
      emit(run, 'workflow_paused', {reason: ctl.reason});
    }
    run.supervised = true;
    for (const entry of Object.values(ctl.dedupe)) if (entry.id === run.id) entry.status = run.status;
    c.ctx.set(workflowControlKey(run.workflow_id), ctl);
    try {
      await persistRun(run, true, c.ctx.changes());
    } catch (error) {
      run.supervised = false;
      throw error;
    }
    if (ctl.status !== 'enabled') applyWorkflowMode({workflow_id: run.workflow_id, status: ctl.status});
    if (c.queueFreed) queueMicroWake(c.queueFreed);
  });
}
async function renewQueueDelivery(c, workflow_id, delivery, at) {
  if (!delivery) return;
  const {log, state} = await queueRead(c, workflow_id, delivery.name),
    item = state.items.find(i => i.receipt === delivery.receipt);
  if (item && item.visible_at - at < state.options.visibility_ms / 2)
    await queueWrite(c, workflow_id, delivery.name, log, [
      {op: 'lease', id: item.id, lease: {receipt: item.receipt, visible_at: at + state.options.visibility_ms}},
    ]);
}

function queueMicroWake({workflow_id, name}) {
  setTimeout(
    () =>
      queueSpaceEvent(workflow_id, name)
        .then(event => wakeEvent(event, {space: true}))
        .catch(error => console.warn(error.message)),
    0
  );
}
function applyWorkflowMode({workflow_id, status}) {
  for (const run of RUNS.byId.values())
    if (run.workflow_id === workflow_id && run.status === 'running') run.control.set(status !== 'enabled', 'workflow');
}
async function failPendingActivation(c, job, message, lifetime_exceeded = false) {
  const run = hydrateRun({
    ...job,
    id: job.id,
    status: 'failed',
    started: nowSeconds(),
    finished: nowSeconds(),
    roots: job.node_ids ?? [],
    nodes: [],
    outputs: {},
    displays: {},
    errors: {},
    trace: [],
    segments: [],
    evaluated_nodes: 0,
    error: message,
    lifetime_exceeded,
  });
  RUNS.byId.set(run.id, run);
  emit(run, 'run_finished', {status: 'failed', error: message});
  await persistRun(run, true, c.ctx.changes());
  setTimeout(() => finishActivation(run).catch(error => console.warn(error.message)), 0);
}
async function dispatchPending(c, at, fired) {
  for (const project of await c.projects())
    for (const wf of project.workflows) {
      if (project.id.startsWith('lib-')) continue;
      const ctl = await workflowControl(c, wf.id);
      if (ctl.status !== 'enabled') continue;
      const jobs = [...ctl.pending];
      for (const job of jobs) await renewQueueDelivery(c, wf.id, job.queue_delivery, Math.max(at, job.due));
      for (const job of jobs) {
        if (
          job.activation_started &&
          at - job.activation_started * 1000 > limitOf(await c.prefs(), 'run_lifetime_ms')
        ) {
          ctl.pending = ctl.pending.filter(j => j.id !== job.id);
          c.ctx.set(workflowControlKey(wf.id), ctl);
          await failPendingActivation(c, job, 'Run lifetime exceeded', true);
          fired.push({activation_id: job.activation_id, error: 'Run lifetime exceeded'});
          continue;
        }
        if (job.due > at || RUNS.active >= MAX_ACTIVE_RUNS) continue;
        if (job.trigger_id) {
          const trigger = (await c.ctx.get('triggers', [])).find(t => t.id === job.trigger_id);
          const active = [...RUNS.byId.values()].filter(
            r => r.trigger_id === job.trigger_id && !terminalRun(r.status)
          ).length;
          if (
            trigger?.type === 'queue'
              ? active >= trigger.max_concurrency
              : active > 0 && (trigger?.overlap ?? job.overlap) !== 'parallel'
          )
            continue;
        }
        // startRun commits this context together with the new run before launching it.
        ctl.pending = ctl.pending.filter(j => j !== job && j.id !== job.id);
        c.ctx.set(workflowControlKey(wf.id), ctl);
        try {
          const run = await startRun(c, {
            ...job,
            run_id: job.id,
            locked: true,
            from_pending: true,
            overlap: 'parallel',
          });
          fired.push({run_id: run.id, retry_of: job.retry_of ?? null});
        } catch (error) {
          if (['invalid_request', 'not_found'].includes(error.code)) {
            await failPendingActivation(c, job, error.message);
          } else {
            ctl.pending.push(job);
            c.ctx.set(workflowControlKey(wf.id), ctl);
          }
          fired.push({activation_id: job.activation_id, error: error.message});
        }
      }
    }
}
async function dropWorkflowState(c, id) {
  const base = workflowBase(id),
    state = await c.ctx.get(base + '/state_index', {entries: {}});
  for (const key of Object.keys(state.entries)) await c.ctx.remove(stateEntryKey(id, key));
  for (const name of await c.ctx.get(base + '/queue_index', [])) await c.ctx.remove(queueKey(id, name));
  for (const key of ['state_index', 'queue_index', 'control', 'usage']) await c.ctx.remove(base + '/' + key);
}
