'use strict';

async function recordBridge(context, args, live) {
  const run = RUNS.byId.get(context.run_id);
  if (context.plan?.replay && !run?.replay)
    throw new ApiError('replay_diverged', 'Replay trace is unavailable; restart replay from its source', 409);
  if (!run) return live();
  const key = `${run.segment ?? 0}/${context.invocation?.invocation ?? context.node_id}/${context.invocation?.index ?? run.trace.length}`;
  const request = TextGraph.canonical(stripSecrets(args)),
    requestHash = await hashText(request);
  if (run.replay) {
    const entry = run.replay.trace.find(t => t.key === key);
    if (!entry || entry.request_hash !== requestHash || entry.node_version !== context.step?.content_hash)
      throw new ApiError('replay_diverged', `Replay diverged at ${context.node_id} (${key}): unexpected request`, 409);
    if (run.replay.used.has(key)) throw new ApiError('replay_diverged', 'Duplicate replay call at ' + key, 409);
    run.replay.used.add(key);
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
    const blob = await DB.get(entry.response_ref);
    if (!blob) throw new ApiError('replay_diverged', 'Replay response expired: ' + key, 409);
    return JSON.parse(blob.text);
  }
  const prefs = (await DB.get('prefs')) ?? {};
  const requestBytes = new TextEncoder().encode(request).length,
    byteLimit = limitOf(prefs, 'max_trace_bytes');
  if ((run.trace_bytes ?? 0) + (run.trace_requests ?? 0) + requestBytes > byteLimit) {
    run.trace_limited = true;
    throw new ApiError('trace_limit', 'Bridge journal byte limit exceeded', 429);
  }
  if ((run.trace_calls ?? run.trace.length) >= limitOf(prefs, 'max_bridge_calls')) {
    run.trace_limited = true;
    throw new ApiError('trace_limit', 'Bridge call journal limit exceeded', 429);
  }
  run.trace_calls = (run.trace_calls ?? run.trace.length) + 1;
  const entry = {
    key,
    node_id: context.node_id,
    method: String(args[0]).toUpperCase(),
    path: redactText(args[1]),
    request_hash: requestHash,
    request_bytes: requestBytes,
    node_version: context.step?.content_hash ?? null,
    started: Date.now(),
  };
  let result;
  run.trace_requests = (run.trace_requests ?? 0) + requestBytes;
  try {
    result = await live();
  } catch (error) {
    entry.error = {
      code: error.code ?? 'script_call_failed',
      message: redactText(error.message),
      status: error.status ?? 500,
    };
  }
  if (run.deleted) {
    if (entry.error) throw new ApiError(entry.error.code, entry.error.message, entry.error.status);
    return result;
  }
  let response = JSON.stringify(stripSecrets(result ?? null));
  if (response !== JSON.stringify(result ?? null)) run.redacted_result = true;
  if ((run.trace_bytes ?? 0) + run.trace_requests + new TextEncoder().encode(response).length > byteLimit) {
    entry.error = {code: 'trace_limit', message: 'Bridge journal byte limit exceeded', status: 429};
    response = 'null';
  }
  run.trace_requests -= requestBytes;
  run.trace_bytes = (run.trace_bytes ?? 0) + requestBytes + new TextEncoder().encode(response).length;
  entry.response_hash = await hashText(response);
  entry.response_bytes = new TextEncoder().encode(response).length;
  entry.order = run.trace.length;
  entry.finished = Date.now();
  entry.duration_ms = entry.finished - entry.started;
  entry.request_ref = `${runKey(run.id)}/blobs/${entry.request_hash}`;
  entry.response_ref = `${runKey(run.id)}/blobs/${entry.response_hash}`;
  const expires = Date.now() + (limitOf(prefs, 'trace_retention_ms'));
  await exclusive(async () => {
    await DB.commit({[entry.request_ref]: {text: request, expires}, [entry.response_ref]: {text: response, expires}});
    // Assign the order in the same section that persists the metadata.
    entry.order = run.trace.length;
    run.trace.push(entry);
    emit(run, 'bridge_call', {...entry, error: entry.error?.code ?? null});
    await persistRun(run, true);
  });
  if (entry.error) throw new ApiError(entry.error.code, entry.error.message, entry.error.status);
  return result;
}
async function clearBridgeTrace(run, changes) {
  for (const entry of run.trace ?? []) {
    if (entry.request_ref) changes[entry.request_ref] = undefined;
    if (entry.response_ref) changes[entry.response_ref] = undefined;
  }
  run.trace = [];
  run.segments = [];
  run.trace_bytes = 0;
  run.trace_calls = 0;
}

route(
  'POST',
  'runs/{run_id}/replay',
  'Reproduce recorded node versions, plan patches and calls offline',
  async (c, {run_id}) => {
    const source = RUNS.byId.get(run_id) ?? (await DB.get(runKey(run_id)));
    if (!source || !terminalRun(source.status) || !source.plan) throw bad('A finished recorded run is required');
    if (source.redacted_result)
      throw new ApiError('replay_redacted', 'Replay is unavailable because a returned value was redacted', 409);
    if (source.trace_limited)
      throw new ApiError('replay_unavailable', 'Replay is unavailable because the journal limit was reached', 409);
    if (
      !source.segments?.length ||
      source.segments.some(s => !s.plan || !Array.isArray(s.patches) || !Array.isArray(s.authorizations))
    )
      throw new ApiError('replay_unavailable', 'Replay executable recording is unavailable', 409);
    const run = hydrateRun({
      ...storedRun(source.nodes instanceof Map ? source : hydrateRun(source)),
      id: uid(),
      status: 'running',
      started: nowSeconds(),
      activation_started: nowSeconds(),
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
      trace: [],
      segments: [],
      replay: {source: run_id, trace: clone(source.trace), used: new Set(), pending: new Map(), next: 0},
      replay_of: run_id,
      supervised: true,
    });
    delete run.plan.checkpoint;
    delete run.plan.resolutions;
    run.plan.context.run_id = run.id;
    run.plan.context.virtual_run_id = source.plan.context.virtual_run_id ?? source.plan.context.run_id;
    run.plan.replay = true;
    RUNS.byId.set(run.id, run);
    const segments = clone(source.segments);
    run.done = (async () => {
      for (let i = 0; i < segments.length; i++) {
        run.segment = i;
        run.plan = clone(segments[i].plan);
        run.plan.context.run_id = run.id;
        run.plan.context.virtual_run_id = source.plan.context.virtual_run_id ?? source.plan.context.run_id;
        run.plan.replay = true;
        run.plan.replay_patches = clone(segments[i].patches);
        run.plan.replay_controls = clone(segments[i].controls ?? []);
        run.replay.authorizations = clone(segments[i].authorizations);
        run.plan.resolutions = segments[i].resolutions;
        run.plan.determinism = segments[i].draws;
        if (i) run.plan.checkpoint = clone(run.checkpoint);
        else if (segments[i].checkpoint) run.plan.checkpoint = clone(segments[i].checkpoint);
        run.status = 'running';
        RUNS.active++;
        await executeRun(run);
        if (run.replay.authorizations.length) {
          run.status = 'failed';
          run.error = 'Replay diverged: recorded authorizations were not consumed';
        }
        if (run.status === 'failed' || run.status === 'cancelled') break;
      }
      if (run.replay.used.size !== run.replay.trace.length) {
        run.status = 'failed';
        run.error = 'Replay diverged: recorded calls were not consumed';
      }
      run.trace = clone(source.trace);
      const blobs = {};
      for (const entry of run.trace)
        for (const field of ['request_ref', 'response_ref']) {
          const blob = await DB.get(entry[field]);
          const own = `${runKey(run.id)}/blobs/${entry[field].split('/').at(-1)}`;
          if (blob)
            blobs[own] = {...blob, expires: Date.now() + limitOf(await DB.get('prefs'), 'trace_retention_ms')};
          entry[field] = own;
        }
      await exclusive(() => DB.commit(blobs));
      run.segments = segments;
      await persistRun(run);
    })();
    if (c.body.wait) await untilDone(run, Math.min(120, c.body.wait) * 1000);
    return c.body.wait ? runDetail(run) : runSummary(run);
  },
  {unlocked: true, body: {wait: 0}}
);
