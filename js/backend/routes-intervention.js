'use strict';

function scheduleOutputRestart(run) {
  if (!run.restart_request || run.restart_processing) return;
  run.restart_processing = true;
  const request = clone(run.restart_request);
  setTimeout(async () => {
    try {
      await completeOutputRestart(run, request);
    } catch (error) {
      if (run.deleted) return;
      run.restart_error = String(error.message);
      if ([400, 404].includes(error.status)) {
        run.restart_request = null;
        run.restarting = false;
        emit(run, 'output_restart_failed', {error: run.restart_error});
      }
      try {
        await persistRun(run);
        if (!run.restarting) await finishActivation(run);
      } catch {}
    } finally {
      run.restart_processing = false;
    }
  }, 0);
}

async function saveExecutionBoundary(id, value) {
  const run = RUNS.byId.get(id);
  if (!run || run.deleted) return;
  const checkpoint = {...clone(value), run_id: id, graph_ref: run.workflow_id};
  const prefs = (await DB.get('prefs')) ?? {};
  if (utf8Bytes(checkpoint) > limitOf(prefs, 'max_checkpoint_bytes')) {
    run.recovery_unavailable = 'checkpoint_limit';
    throw new ApiError('checkpoint_limit', 'Checkpoint limit exceeded', 429);
  }
  await exclusive(async () => {
    if (run.deleted || run.status !== 'running') return;
    run.checkpoint = checkpoint;
    run.waves = clone(checkpoint.waves);
    run.recovery_unavailable = null;
    if (!run.replay) await persistRun(run, true);
  });
}

const waveContains = (waves, path, inside) => {
  const seen = new Set();
  for (let p = inside; p && !seen.has(p); p = waves[p]?.parent) {
    if (p === path) return true;
    seen.add(p);
  }
  return false;
};

function replacementSpec(run, body, plan) {
  if (!run.checkpoint || run.recovery_unavailable) throw bad('No retained recovery checkpoint');
  const entry = run.checkpoint.journal[body.invocation];
  if (typeof body.invocation !== 'string' || !entry?.schema) throw bad('Select a retained invocation');
  const node = plan.nodes.find(n => n.id === entry.node_id);
  if (!node) throw bad('The selected node was removed or has a diagnostic');
  const output = body.output;
  if (!isObject(output)) throw bad('Output must be a JSON object keyed by output name');
  let text;
  try {
    text = JSON.stringify(output, (_, v) => {
      if (
        typeof v === 'function' ||
        typeof v === 'symbol' ||
        typeof v === 'bigint' ||
        (typeof v === 'number' && !Number.isFinite(v))
      )
        throw Error();
      return v;
    });
  } catch {
    throw bad('Output must be JSON data');
  }
  if (utf8Bytes(text) > MAX_RESULT) throw bad('Output size limit exceeded');
  if (Object.keys(output).some(name => !node.outputs.some(p => !p.signal && p.name === name)))
    throw bad('Unknown data output');
  if (
    !Array.isArray(body.signals) ||
    body.signals.length > 200 ||
    body.signals.some(name => typeof name !== 'string' || !(entry.signals ?? []).includes(name))
  )
    throw bad('Select valid signal outputs explicitly');
  const emitted = [...(entry.emissions ?? [])];
  let nextEmission = Math.max(-1, ...emitted.map(e => Number(/\/emit:(\d+)$/.exec(e.key)?.[1] ?? -1))) + 1;
  const emissions = body.signals.map((name, index) => {
    const at = emitted.findIndex(e => e.name === name);
    return at < 0 ? {name, key: `${body.invocation}/emit:${nextEmission++}`, options: {}} : emitted.splice(at, 1)[0];
  });
  return {invocation: body.invocation, output: clone(output), signals: [...body.signals], emissions};
}

function prepareReplacement(checkpoint, replacement, plan) {
  const saved = clone(checkpoint),
    journal = saved.journal;
  const affected = new Set([replacement.invocation]);
  for (let more = true; more; ) {
    more = false;
    for (const [key, entry] of Object.entries(journal)) {
      if (affected.has(key)) continue;
      const selectedChild =
        entry.parent === replacement.invocation
          ? replacement.emissions.some(e => key.startsWith(e.key + '/'))
          : affected.has(entry.parent);
      if (selectedChild || (entry.dependencies ?? []).some(id => affected.has(id))) {
        affected.add(key);
        more = true;
      }
    }
  }
  const ancestors = new Set();
  for (const key of affected) {
    const seen = new Set();
    for (let parent = journal[key]?.parent; parent && !seen.has(parent); parent = journal[parent]?.parent) {
      seen.add(parent);
      if (!affected.has(parent)) ancestors.add(parent);
    }
  }
  for (const key of new Set([...affected, ...ancestors])) {
    const record = journal[key];
    if (!record) continue;
    record.status = 'pending';
    record.error = null;
    record.emissions = [];
    delete record.inputs;
    delete record.wait;
    delete record.display;
    if (affected.has(key)) {
      delete record.output_value;
      delete record.result;
      delete record.draws;
      delete record.run_key;
    }
    for (let path = record.wave_path; path; path = saved.waves[path]?.parent) {
      if (!saved.waves[path]) break;
      saved.waves[path].cancelled = false;
      saved.waves[path].control = null;
    }
    if (record.read_key) {
      const step = plan.nodes.find(n => n.id === record.node_id);
      const state = saved.read_states.find(([id]) => id === step?.context?.instance_id)?.[1];
      if (state) {
        state.key = record.read_key;
        state.done = false;
        state.at = -1;
        state.error = null;
      }
    }
  }
  const target = journal[replacement.invocation],
    step = plan.nodes.find(n => n.id === target.node_id);
  target.output_value = clone(replacement.output);
  target.result = step.outputs
    .filter(p => !p.signal && Object.hasOwn(replacement.output, p.name))
    .map(p => [p.id, {j: JSON.stringify(replacement.output[p.name])}]);
  const writer = new Map(new Map(saved.writers).get(target.scope) ?? []);
  const latest = new Map(saved.latest),
    held = new Map(latest.get(target.scope) ?? []);
  for (const [port, value] of target.result) if (writer.get(port) === replacement.invocation) held.set(port, value);
  latest.set(target.scope, [...held]);
  saved.latest = [...latest];
  saved.waits = saved.waits.filter(w => !affected.has(w.key) && !ancestors.has(w.key));
  saved.signals_pending = saved.waits.map(w => w.key);
  return {checkpoint: saved, recovery: {affected: [...affected], ancestors: [...ancestors], override: replacement}};
}

async function replaceInvocationOutput(id, body) {
  let source, request;
  await exclusive(async () => {
    source = RUNS.byId.get(id);
    if (!source || source.deleted) throw missing('Run not found');
    if (source.replay || source.restarting) throw bad('This run cannot be restarted now');
    if (((await DB.get(workflowControlKey(source.workflow_id)))?.status ?? 'enabled') !== 'enabled')
      throw bad('Enable the workflow before restarting');
    if (RUNS.active >= MAX_ACTIVE_RUNS && source.status !== 'running')
      throw new ApiError('too_many_runs', 'Too many active runs', 429);
    const plan = await currentRunPlan(source);
    const replacement = replacementSpec(source, body, plan);
    if ([...RUNS.byId.values()].some(r => r.retry_of === id && !terminalRun(r.status)))
      throw bad('Cancel the active retry before restarting its source');
    request = {id: uid(), replacement, at: Date.now()};
    source.restart_request = request;
    source.restarting = true;
    if (source.status === 'running') source.control.set(true);
    else if (!terminalRun(source.status)) {
      source.status = 'cancelled';
      source.finished = nowSeconds();
      emit(source, 'run_finished', {status: 'cancelled', reason: 'output_restart'});
    }
    await persistRun(source, true);
  });
  if (source.status === 'running') {
    source.controller.abort();
    await source.done;
  }
  return completeOutputRestart(source, request);
}

async function completeOutputRestart(source, request) {
  return exclusive(async () => {
    if (source.restarted_by === request.id) return RUNS.byId.get(request.id);
    if (source.deleted) throw missing('Run was deleted');
    if (RUNS.active >= MAX_ACTIVE_RUNS) throw new ApiError('too_many_runs', 'Too many active runs', 429);
    const plan = await currentRunPlan(source);
    if (!plan.nodes.some(n => n.id === source.checkpoint?.journal?.[request.replacement.invocation]?.node_id))
      throw bad('Selected node was removed before the restart');
    const {checkpoint, recovery} = prepareReplacement(source.checkpoint, request.replacement, plan);
    const c = new Call('PUT', {}, {}),
      ctl = await workflowControl(c, source.workflow_id);
    ctl.pending = ctl.pending.filter(job => job.retry_of !== source.id);
    const newId = request.id;
    recovery.run_key_root = newId;
    for (const entry of Object.values(ctl.dedupe))
      if (entry.id === source.id) Object.assign(entry, {id: newId, status: 'running'});
    let delivery = null;
    if (source.queue_delivery) {
      const {state} = await queueRead(c, source.workflow_id, source.queue_delivery.name);
      if (state.items.some(item => item.receipt === source.queue_delivery.receipt)) delivery = source.queue_delivery;
      await renewQueueDelivery(c, source.workflow_id, delivery, Date.now());
    }
    const dirty = new Set([...recovery.affected, ...recovery.ancestors]);
    const dirtyIds = new Set([...dirty].map(key => checkpoint.journal[key]?.node_id));
    const outputs = clone(source.outputs ?? {}),
      errors = clone(source.errors ?? {}),
      displays = clone(source.displays ?? {});
    for (const root of source.roots)
      if ([...dirty].some(key => key === `root:${root}` || key.startsWith(`root:${root}/`))) {
        delete outputs[root];
        delete errors[root];
      }
    for (const node of dirtyIds) delete displays[node];
    plan.context = {...plan.context, run_id: newId};
    for (const step of plan.nodes) step.context = {...step.context, run_id: newId};
    plan.checkpoint = clone(checkpoint);
    plan.recovery = clone(recovery);
    plan.resolutions = clone(source.plan.resolutions ?? {});
    const run = hydrateRun({
      id: newId,
      project_id: source.project_id,
      workflow_id: source.workflow_id,
      status: 'running',
      trigger: 'intervention',
      roots: [...source.roots],
      payload: clone(source.payload),
      started: nowSeconds(),
      activation_started: nowSeconds(),
      activation_id: newId,
      attempt: 1,
      finished: null,
      ms: null,
      evaluated_nodes: 0,
      nodes: [...source.nodes.values()].filter(n => !dirtyIds.has(n.node_id)),
      outputs,
      errors,
      displays,
      events: [],
      trace: [],
      segments: [],
      plan,
      checkpoint: clone(checkpoint),
      recovery_input: clone(checkpoint),
      recovery_spec: clone(recovery),
      restarted_from: source.id,
      supervised: false,
      queue_delivery: delivery,
      segment: 0,
    });
    if (ctl.status !== 'enabled') run.control.set(true, 'workflow');
    RUNS.byId.set(newId, run);
    RUNS.active++;
    const sourceBefore = {
      status: source.status,
      finished: source.finished,
      supervised: source.supervised,
      restarted_by: source.restarted_by,
      queue_delivery: source.queue_delivery,
    };
    if (!terminalRun(source.status)) {
      source.status = 'cancelled';
      source.finished = nowSeconds();
      emit(source, 'run_finished', {status: 'cancelled', reason: 'output_restart'});
    }
    source.supervised = true;
    source.restarting = false;
    source.restart_request = null;
    source.restarted_by = newId;
    source.queue_delivery = null;
    const previous = {
      ...clone(await DB.get(runKey(source.id))),
      ...storedRun(source),
      supervised: true,
      restarting: false,
      restart_request: null,
      restarted_by: newId,
      queue_delivery: null,
    };
    c.ctx.set(workflowControlKey(source.workflow_id), ctl);
    emit(run, 'output_restart', {
      source_run: source.id,
      invocation: request.replacement.invocation,
      signals: request.replacement.signals,
    });
    try {
      await persistRun(run, true, {...c.ctx.changes(), [runKey(source.id)]: previous});
    } catch (error) {
      RUNS.byId.delete(newId);
      RUNS.active--;
      Object.assign(source, sourceBefore, {restarting: true, restart_request: request});
      throw error;
    }
    run.done = launchRun(run);
    return run;
  });
}

route(
  'POST',
  'runs/{run_id}/output',
  'Replace one invocation output and restart dependent work',
  async (c, {run_id}) => {
    const run = await replaceInvocationOutput(run_id, c.body);
    if (c.body.wait) await untilDone(run, Math.min(120, c.body.wait) * 1000);
    return c.body.wait ? runDetail(run) : runSummary(run);
  },
  {unlocked: true, body: {invocation: 'Invocation path', output: {}, signals: [], wait: 0}}
);

route(
  'POST',
  'runs/{run_id}/waves/cancel',
  'Cancel one wave and its descendants cooperatively',
  async (c, {run_id}) =>
    exclusive(async () => {
      const run = RUNS.byId.get(run_id),
        path = c.body.path;
      if (!run) throw missing('Run not found');
      if (run.restarting || !['running', 'waiting', 'interrupted'].includes(run.status)) throw bad('Run is not active');
      const waves = {...run.checkpoint?.waves, ...run.waves};
      if (typeof path !== 'string' || !Object.hasOwn(waves, path)) throw bad('Unknown wave');
      if (waves[path].cancelled) return runSummary(run);
      if (waves[path].active === false) throw bad('Wave has already finished');
      run.cancelled_waves = [...new Set([...(run.cancelled_waves ?? []), path])];
      if (run.checkpoint) {
        for (const [key, wave] of Object.entries(run.checkpoint.waves))
          if (waveContains(waves, path, key)) wave.cancelled = true;
      }
      if (run.waves?.[path]) run.waves[path].cancelled = true;
      emit(run, 'wave_cancel_requested', {path});
      if (run.status !== 'running') run.wave_cancel_pending = true;
      await persistRun(run, true);
      if (run.status === 'running') run.control.cancelWave(path);
      else if (
        ((await DB.get(workflowControlKey(run.workflow_id)))?.status ?? 'enabled') === 'enabled' &&
        RUNS.active < MAX_ACTIVE_RUNS
      )
        await continueRun(run, {}, true);
      return runSummary(run);
    }),
  {unlocked: true, body: {path: 'Wave path'}}
);
