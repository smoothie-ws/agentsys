'use strict';

// A document commit is the publication boundary. This runs under the backend writer lock.
let publishingGraph = false;
async function currentRunPlan(run) {
  const c = new Call('GET', {}, {workflow_id: run.workflow_id});
  const {editor} = await c.workflow(run.project_id, run.workflow_id);
  const snapshot = editor.snapshot();
  for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
  if (c.refreshed) await c.ctx.commit();
  run.compileCache ??= new Map();
  const plan = compilePlan(snapshot, run.roots, {
    context: run.plan.context,
    events: Object.fromEntries(run.plan.nodes.filter(n => n.event).map(n => [n.id, n.event])),
    cache: run.compileCache,
  });
  await preparePlanPermissions(plan);
  await versionPlan(plan);
  return plan;
}
async function publishGraphChanges(changes) {
  if (
    publishingGraph ||
    !Object.keys(changes).some(k => k.startsWith('wf:') || ['resources', 'library_types'].includes(k))
  )
    return;
  publishingGraph = true;
  try {
    for (const run of RUNS.byId.values()) {
      if (run.status !== 'running' || run.replay) continue;
      if (!changes.resources && !changes.library_types && !Object.hasOwn(changes, 'wf:' + run.workflow_id)) continue;
      const next = await currentRunPlan(run);
      const old = new Map(run.plan.nodes.map(n => [n.id, n]));
      const ids = new Set(next.nodes.map(n => n.id));
      const patch = {
        upsert: next.nodes.filter(n => TextGraph.canonical(n) !== TextGraph.canonical(old.get(n.id) ?? null)),
        remove: [...old.keys()].filter(id => !ids.has(id)),
        roots: next.roots,
        diagnostics: next.diagnostics,
      };
      if (
        !patch.upsert.length &&
        !patch.remove.length &&
        TextGraph.canonical(run.plan.roots) === TextGraph.canonical(next.roots) &&
        TextGraph.canonical(run.plan.diagnostics ?? {}) === TextGraph.canonical(next.diagnostics)
      )
        continue;
      Object.assign(run.plan, next);
      run.control.patch(patch);
    }
  } finally {
    publishingGraph = false;
  }
}
// External file changes follow the same publication path as API commits.
DB.subscribe(keys => {
  if (keys.some(k => k.startsWith('wf:') || ['resources', 'library_types'].includes(k)))
    exclusive(() => publishGraphChanges(Object.fromEntries(keys.map(k => [k, true])))).catch(error =>
      console.error('Live graph update:', error)
    );
});

// The host retains manifests for versions of invocations that are still running. A bridge call
// cannot acquire the grants of a replacement node with the same ID.
function planHost(plan, onEvent, control) {
  const versions = new Map();
  const authorized = new Map();
  const current = new Map(plan.nodes.map(n => [n.id, n.content_hash]));
  const prune = () => {
    if (plan.replay) return;
    const retained = new Set([...authorized.values()].map(n => n.id + '/' + n.content_hash));
    for (const [key, step] of versions)
      if (current.get(step.id) !== step.content_hash && !retained.has(key)) versions.delete(key);
  };
  const remember = nodes => nodes.forEach(n => versions.set(n.id + '/' + n.content_hash, n));
  remember(plan.nodes);
  for (const entry of plan.replay_patches ?? []) remember(entry.patch.upsert);
  const stepOf = (id, version) => {
    const step = versions.get(id + '/' + version);
    if (!step) throw new ApiError('node_version_missing', 'Unknown executable node version', 409);
    return step;
  };
  return {
    attach(send) {
      control?.attach(message => {
        if (message.type === 'patch') {
          remember(message.patch.upsert);
          for (const id of message.patch.remove) current.delete(id);
          for (const step of message.patch.upsert) current.set(step.id, step.content_hash);
          prune();
        }
        send(message);
      });
    },
    authorize: (id, version, invocation) =>
      exclusive(async () => {
        if (!plan.replay && current.get(id) !== version) {
          // The patch precedes this reply on the Worker channel. Its start boundary will retry/skip.
          recordPlanEntry(RUNS.byId.get(plan.context.run_id), 'authorizations', {
            invocation,
            node_version: version,
            reason: null,
          });
          return null;
        }
        const step = stepOf(id, version);
        const reason = await nodeStartPermission(plan, step, invocation);
        if (!reason) authorized.set(invocation, step);
        return reason;
      }),
    call: (id, method, path, body, query, invocation) =>
      bridgeFor({
        ...plan.context,
        node_id: id,
        plan,
        invocation,
        step: stepOf(id, invocation.node_version),
      }).request([method, path, body, query]),
    checkpoint: value => saveExecutionBoundary(plan.context.run_id, value),
    emit(event) {
      if (event.ev === 'wave') {
        const run = RUNS.byId.get(plan.context.run_id);
        if (run) {
          (run.waves ??= {})[event.path] = {parent: event.parent, cancelled: event.cancelled};
          emit(run, 'wave_opened', event);
        }
      } else if (event.ev === 'wave_cancelled') {
        const run = RUNS.byId.get(plan.context.run_id);
        recordPlanEntry(run, 'controls', {at: event.at, path: event.path});
        if (run) emit(run, 'wave_cancelled', {path: event.path});
      } else if (event.ev === 'overridden') {
        const run = RUNS.byId.get(plan.context.run_id);
        if (run) {
          run.nodes.set(event.id, {
            node_id: event.id,
            label: versions.get(event.id + '/' + event.node_version)?.label ?? event.id,
            status: 'overridden',
            invocation: event.invocation,
            node_version: event.node_version,
          });
          emit(run, 'node_output_replaced', {
            node_id: event.id,
            invocation: event.invocation,
            node_version: event.node_version,
          });
        }
      } else if (event.ev === 'patched') {
        const run = RUNS.byId.get(plan.context.run_id);
        recordPlanEntry(run, 'patches', {at: event.at, patch: event.patch});
        if (run)
          emit(run, 'plan_patched', {
            at: event.at,
            updated: event.patch.upsert.map(n => n.id),
            removed: event.patch.remove,
          });
      } else {
        onEvent(event);
        if (['done', 'fail', 'skip'].includes(event.ev)) {
          authorized.delete(event.invocation);
          prune();
        }
      }
    },
  };
}

function recordPlanEntry(run, field, value) {
  const segment = run?.segments?.at(-1);
  if (!segment || run.replay || run.trace_limited) return;
  const bytes = utf8Bytes(value);
  if ((run.plan_bytes ?? 0) + bytes > run.plan_byte_limit) {
    run.trace_limited = true;
    run.segments = [];
    return;
  }
  run.plan_bytes = (run.plan_bytes ?? 0) + bytes;
  segment[field].push(clone(value));
}
