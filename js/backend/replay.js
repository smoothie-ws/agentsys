'use strict';

async function recordBridge(context, args, live) {
  const run = RUNS.byId.get(context.run_id);
  if (!run) return live();
  const key = `${run.segment ?? 0}/${context.invocation?.invocation ?? context.node_id}/${context.invocation?.index ?? run.trace.length}`;
  const request = redactText(TextGraph.canonical(args));
  const requestHash = await hashText(TextGraph.canonical(args));
  if (run.replay) {
    const entry = run.replay.trace.find(t => t.key === key);
    if (!entry || entry.request !== request || entry.request_hash !== requestHash)
      throw new ApiError('replay_diverged', `Replay diverged at ${context.node_id} (${key}): unexpected request`, 409);
    if (run.replay.used.has(key)) throw new ApiError('replay_diverged', 'Duplicate replay call at ' + key, 409);
    run.replay.used.add(key);
    // Release responses in recorded completion order, even when calls run in parallel.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ApiError('replay_diverged', 'Missing earlier parallel call before ' + key, 409)),
        1000
      );
      run.replay.pending.set(entry.order, () => {
        clearTimeout(timer);
        resolve();
      });
      while (run.replay.pending.has(run.replay.next)) {
        const next = run.replay.pending.get(run.replay.next);
        run.replay.pending.delete(run.replay.next++);
        next();
      }
    });
    if (entry.error) throw new ApiError(entry.error.code, entry.error.message, entry.error.status);
    return clone(entry.result);
  }
  const entry = {key, node_id: context.node_id, request, request_hash: requestHash, started: Date.now()};
  try {
    entry.result = clone(await live());
  } catch (error) {
    entry.error = {
      code: error.code ?? 'script_call_failed',
      message: redactText(error.message),
      status: error.status ?? 500,
    };
  }
  entry.order = run.trace.length;
  entry.finished = Date.now();
  run.trace.push(entry);
  emit(run, 'bridge_call', {
    key,
    node_id: context.node_id,
    method: args[0],
    path: args[1],
    order: entry.order,
    error: entry.error?.code ?? null,
  });
  await persistRun(run);
  if (entry.error) throw new ApiError(entry.error.code, entry.error.message, entry.error.status);
  return clone(entry.result);
}
route(
  'POST',
  'runs/{run_id}/replay',
  'Reproduce a run using pinned code and recorded calls, offline',
  async (c, {run_id}) => {
    const source = RUNS.byId.get(run_id) ?? (await DB.get(runKey(run_id)));
    if (!source || !terminalRun(source.status) || !source.plan) throw bad('A finished recorded run is required');
    const run = hydrateRun({
      ...storedRun(source.nodes instanceof Map ? source : hydrateRun(source)),
      id: uid(),
      status: 'running',
      started: nowSeconds(),
      finished: null,
      ms: null,
      nodes: [],
      events: [],
      outputs: {},
      displays: {},
      errors: {},
      error: null,
      evaluated_nodes: 0,
      seq: 0,
      plan: clone(source.plan),
      payload: source.payload,
      budget: source.budget,
      usage: {calls: 0, tokens: 0, cost: 0, ms: 0},
      trace: [],
      segments: [],
      replay: {source: run_id, trace: clone(source.trace), used: new Set(), pending: new Map(), next: 0},
      replay_of: run_id,
    });
    delete run.plan.checkpoint;
    delete run.plan.resolutions;
    run.plan.context.run_id = run.id;
    run.plan.context.virtual_run_id = source.plan.context.virtual_run_id ?? source.plan.context.run_id;
    run.plan.replay = true;
    RUNS.byId.set(run.id, run);
    const segments = clone(source.segments ?? [{resolutions: {}, draws: {}}]);
    run.done = (async () => {
      for (let i = 0; i < segments.length; i++) {
        run.segment = i;
        run.plan.resolutions = segments[i].resolutions;
        run.plan.determinism = segments[i].draws;
        if (i) run.plan.checkpoint = clone(run.checkpoint);
        run.status = 'running';
        RUNS.active++;
        await executeRun(run);
        if (run.status === 'failed' || run.status === 'cancelled') break;
      }
      if (run.replay.used.size !== run.replay.trace.length) {
        run.status = 'failed';
        run.error = 'Replay diverged: recorded calls were not consumed';
      }
      run.trace = clone(source.trace);
      run.segments = segments;
      await persistRun(run);
    })();
    if (c.body.wait) await untilDone(run, Math.min(120, c.body.wait) * 1000);
    return c.body.wait ? runDetail(run) : runSummary(run);
  },
  {unlocked: true, body: {wait: 0}}
);
