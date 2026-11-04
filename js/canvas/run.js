// Controls and previews of the workflow's live runtime.
'use strict';
function syncToolbar() {
  if (!W.canvas?.isConnected || !$('#run-summary')) return;
  const summary = W.executionCommand
    ? {stop: 'Stopping…', pause: 'Pausing…', resume: 'Resuming…'}[W.executionCommand]
    : W.runPaused
      ? 'Paused'
      : W.running
        ? 'Working'
        : 'Ready';
  if ($('#run-summary').textContent !== summary) $('#run-summary').textContent = summary;
  // One button starts the work and, while there is work, stops it; Pause and Resume only make sense while there is work.
  const start = $('#start'),
    pause = $('#pause');
  const active = runActive();
  const disabled = !W.executionReady || !!W.executionCommand;
  if (start) {
    if (start.disabled !== disabled) start.disabled = disabled;
    if (start.classList.contains('stop') !== active) {
      start.classList.toggle('stop', active);
      start.innerHTML = icon(active ? 'stop' : 'play') + `<span>${active ? 'Stop' : 'Run'}</span>`;
      start.title = active ? 'Stop current work' : `Run the workflow (${shortcutText('run')})`;
    }
  }
  if (pause) {
    if (pause.hidden === active) pause.hidden = !active;
    if (pause.disabled !== disabled) pause.disabled = disabled;
    const mode = W.runPaused ? 'Resume' : 'Pause';
    if (pause.title !== mode) pause.title = mode;
    if (pause.ariaLabel !== mode) pause.ariaLabel = mode;
    if (pause.dataset.mode !== mode) {
      pause.dataset.mode = mode;
      pause.innerHTML = icon(W.runPaused ? 'play' : 'pause');
    }
  }
  if ($('#undo').disabled !== !W.history.undo) $('#undo').disabled = !W.history.undo;
  if ($('#redo').disabled !== !W.history.redo) $('#redo').disabled = !W.history.redo;
  W.canvas.classList.toggle('busy', !!W.running);
  W.canvas.closest('.editor')?.classList.toggle('running', !!W.running);
}
function syncComplexStatus() {
  const memo = new Map();
  const stateOf = id => {
    if (!id.startsWith('complex:')) return W.runStatus.get(id);
    if (memo.has(id)) return memo.get(id);
    memo.set(id, undefined); // a group inside itself is not possible; this only guards the recursion
    const states = (W.complex.get(id.slice('complex:'.length))?.members || []).map(stateOf);
    const state = ['running', 'sleeping', 'blocked', 'failed', 'waiting', 'stopped', 'completed', 'skipped'].find(s =>
      states.includes(s) && (s !== 'completed' || !states.includes('ready'))
    );
    memo.set(id, state);
    return state;
  };
  for (const cx of W.snapshot.complex) {
    const node = W.nodes.get('complex:' + cx.id);
    if (node) {
      node.status = stateOf(node.id) || 'ready';
      if (node.status === 'ready') W.glowUntil.delete(node.id);
    }
  }
}

function applyExecution(detail) {
  W.executionStatus = detail.status;
  W.running = detail.active_signals > 0;
  W.runPaused = detail.paused;
  const first = W.runtimeRevision === null; // the first look: what happened before it is not shown
  W.runtimeRevision = detail.revision;
  W.runtimeState = detail.state ?? {};
  W.runStatus.clear();
  for (const item of detail.nodes ?? []) {
    W.runStatus.set(item.node_id, item.status);
    // A new upstream pass invalidates the old completion, including its minimum glow hold.
    if (!['running', 'sleeping', 'waiting', 'completed'].includes(item.status)) {
      W.glowUntil.delete(item.node_id);
      W.glowPending.delete(item.node_id);
    }
  }
  for (const [id, count] of Object.entries(detail.runs ?? {})) {
    W.runs.set(id, count);
  }
  W.results.clear();
  for (const [id, text] of Object.entries(detail.displays ?? {})) W.results.set(id, {text});
  for (const item of detail.nodes ?? []) if (item.error) W.results.set(item.node_id, {error: item.error});
  for (const node of W.nodes.values()) node.status = W.runStatus.get(node.id) || 'ready';
  syncComplexStatus();
  const activity = detail.activity ?? [];
  if (!first) queuePassGlows(activity.filter(event => event.sequence > W.activitySequence));
  W.activitySequence = activity.at(-1)?.sequence ?? W.activitySequence;
  syncToolbar();
  draw();
}
const GLOW_MS = 480; // short passes remain visible without delaying execution
/** Preserve start order when several fast nodes finish between two UI updates. */
function queuePassGlows(events) {
  if (document.documentElement.dataset.motion === 'false' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const session = W.executionSession;
  const latest = new Map(events.map(event => [event.node_id, event]));
  const passes = events.filter(
    event => latest.get(event.node_id) === event &&
      ['running', 'sleeping', 'waiting', 'completed'].includes(W.runStatus.get(event.node_id))
  );
  const step = passes.length > 1 ? Math.min(90, 450 / (passes.length - 1)) : 0;
  passes.forEach((event, index) => {
    W.glowPending.set(event.node_id, event.sequence);
    const show = () => {
      if (
        W.executionSession !== session || !session?.canvas.isConnected ||
        W.glowPending.get(event.node_id) !== event.sequence
      ) return;
      W.glowPending.delete(event.node_id);
      if (W.runPaused || !['running', 'sleeping', 'waiting', 'completed'].includes(W.runStatus.get(event.node_id))) return;
      holdGlow(event.node_id);
    };
    if (WORKING.includes(W.runStatus.get(event.node_id)) || index === 0) show();
    else {
      const timer = setTimeout(() => {
        W.glowTimers.delete(timer);
        show();
      }, index * step);
      W.glowTimers.add(timer);
    }
  });
}
/**
 * A pass lights its node and the enclosing Complex Nodes. Data suppliers do not imply execution.
 */
function litBy(id) {
  const found = new Set();
  const visit = x => {
    if (found.has(x)) return;
    found.add(x);
    for (const c of W.complex.values()) if (c.members.includes(x)) visit('complex:' + c.id);
  };
  visit(id);
  return found;
}
/** A node that had a pass glows for at least GLOW_MS, however short the pass was. */
function holdGlow(id) {
  const session = W.executionSession;
  const lit = [...litBy(id)],
    until = performance.now() + GLOW_MS;
  for (const x of lit) W.glowUntil.set(x, Math.max(until, W.glowUntil.get(x) ?? 0));
  for (const x of lit) if (W.nodes.get(x) && W.elements.get(x)) setGlow(W.elements.get(x), W.nodes.get(x));
  drawWires();
  const timer = setTimeout(() => {
    if (W.executionSession !== session) return;
    W.glowTimers.delete(timer);
    for (const x of lit) if (W.nodes.get(x) && W.elements.get(x)) setGlow(W.elements.get(x), W.nodes.get(x));
    drawWires();
  }, GLOW_MS + 20);
  W.glowTimers.add(timer);
}
const executionVisible = session => !!session && session === W.executionSession && session.canvas.isConnected;
async function followExecution(detail, session = W.executionSession) {
  if (!executionVisible(session)) return;
  applyExecution(detail);
  // The runtime is saved at every change, and every save is announced: no polling. A change that arrives while the last
  // one is being fetched is not lost, the fetch just runs once more.
  const key = `workflows/${session.workflow}/runtime`;
  let fetching = false,
    again = false;
  session.pull = async () => {
    if (!executionVisible(session)) return session.unfollow();
    if (fetching) return (again = true);
    fetching = true;
    try {
      do {
        again = false;
        const revision = session.revision;
        const current = await api('projects/' + session.project + '/execution', {
          query: {workflow_id: session.workflow},
        });
        if (!executionVisible(session)) return session.unfollow();
        // While a Stop, Pause or Resume is under way its own answer is applied; what it changes is announced after.
        if (revision === session.revision && !W.executionCommand && current.revision !== W.runtimeRevision)
          applyExecution(current);
      } while (again);
    } finally {
      fetching = false;
    }
  };
  session.unfollow?.();
  const unsubscribe = Backend.subscribe(keys => keys.includes(key) && session.pull().catch(fail), {commits: true});
  session.unfollow = () => {
    unsubscribe();
    session.unfollow = session.pull = null;
  };
  session.pull().catch(fail); // what changed since the answer we started from
}
async function runAction() {
  const session = W.executionSession;
  if (!executionVisible(session) || !W.executionReady) return;
  const revision = ++session.revision;
  const request = (async () => {
    await flushNodeEdits();
    await Inspector.leave();
    return api('projects/' + session.project + '/execution', {method: 'POST', body: {workflow_id: session.workflow}});
  })();
  session.starts.add(request);
  syncToolbar();
  try {
    const detail = await request;
    if (executionVisible(session) && revision === session.revision && !W.executionCommand) applyExecution(detail);
  } finally {
    session.starts.delete(request);
    syncToolbar();
  }
}
async function controlRun(action) {
  const session = W.executionSession;
  if (!executionVisible(session) || !W.executionReady || W.executionCommand) return;
  W.executionCommand = action;
  session.revision++;
  syncToolbar();
  try {
    await Promise.allSettled([...session.starts]);
    if (!executionVisible(session)) return;
    const detail = await api(
      'projects/' + session.project + '/execution' + (action === 'stop' ? '' : '/' + action),
      action === 'stop'
        ? {method: 'DELETE', query: {workflow_id: session.workflow}}
        : {method: 'POST', body: {workflow_id: session.workflow}}
    );
    if (executionVisible(session)) applyExecution(detail);
  } finally {
    if (executionVisible(session)) {
      W.executionCommand = null;
      session.revision++;
      syncToolbar();
      session.pull?.().catch(fail); // what was announced meanwhile was left out
    }
  }
}
/** There is work to stop: running, paused, or a Run request that has not been answered yet. */
const runActive = () => !!W.running || !!W.runPaused || !!W.executionSession?.starts.size;
/** Run, or Stop when there is work to stop. */
const toggleRun = () => (runActive() ? stopRun() : runAction());
const stopRun = () => controlRun('stop'),
  pauseRun = () => controlRun(W.runPaused ? 'resume' : 'pause');
async function flushNodeEdits() {
  await Inspector.flushPermissions?.();
  await W.flushInline?.();
  await Inspector.flushConnections?.();
  await Inspector.pending?.();
}
