// Controls and previews of the workflow's live runtime.
'use strict';
function syncToolbar() {
  if (!W.canvas?.isConnected || !$('#run-summary')) return;
  $('#run-summary').textContent = W.executionCommand
    ? {stop: 'Stopping…', pause: 'Pausing…', resume: 'Resuming…'}[W.executionCommand]
    : W.runPaused
      ? 'Paused'
      : W.running
        ? 'Working'
        : 'Ready';
  const start = $('#start'),
    stop = $('#stop'),
    pause = $('#pause');
  if (start) start.disabled = !W.executionReady || !!W.executionCommand;
  if (stop) stop.disabled = !W.executionReady || !!W.executionCommand;
  if (pause) {
    pause.disabled = !W.executionReady || !!W.executionCommand;
    const mode = W.runPaused ? 'Resume' : 'Pause';
    pause.title = pause.ariaLabel = mode;
    if (pause.dataset.mode !== mode) {
      pause.dataset.mode = mode;
      pause.innerHTML = icon(W.runPaused ? 'play' : 'pause');
    }
  }
  $('#undo').disabled = !W.history.undo;
  $('#redo').disabled = !W.history.redo;
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
      states.includes(s)
    );
    memo.set(id, state);
    return state;
  };
  for (const cx of W.snapshot.complex) {
    const node = W.nodes.get('complex:' + cx.id);
    if (node) {
      node.status = stateOf(node.id) || 'ready';
    }
  }
}

function applyExecution(detail) {
  W.executionStatus = detail.status;
  W.running = detail.active_signals > 0;
  W.runPaused = detail.paused;
  W.runtimeRevision = detail.revision;
  W.runtimeState = detail.state ?? {};
  W.runStatus.clear();
  for (const item of detail.nodes ?? []) {
    W.runStatus.set(item.node_id, item.status);
  }
  W.results.clear();
  for (const [id, text] of Object.entries(detail.displays ?? {})) W.results.set(id, {text});
  for (const item of detail.nodes ?? []) if (item.error) W.results.set(item.node_id, {error: item.error});
  for (const node of W.nodes.values()) node.status = W.runStatus.get(node.id) || 'ready';
  syncComplexStatus();
  syncToolbar();
  draw();
}

const executionVisible = session => !!session && session === W.executionSession && session.canvas.isConnected;
async function followExecution(detail, session = W.executionSession) {
  if (!executionVisible(session)) return;
  applyExecution(detail);
  const token = (session.poll = {});
  while (executionVisible(session) && session.poll === token) {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!executionVisible(session) || session.poll !== token) return;
    if (W.executionCommand) continue;
    const revision = session.revision;
    const current = await api('projects/' + session.project + '/execution', {query: {workflow_id: session.workflow}});
    if (!executionVisible(session) || session.poll !== token) return;
    if (revision !== session.revision || W.executionCommand) continue;
    if (current.revision !== W.runtimeRevision) applyExecution(current);
  }
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
  try {
    const detail = await request;
    if (executionVisible(session) && revision === session.revision && !W.executionCommand) applyExecution(detail);
  } finally {
    session.starts.delete(request);
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
    }
  }
}
const stopRun = () => controlRun('stop'),
  pauseRun = () => controlRun(W.runPaused ? 'resume' : 'pause');
async function flushNodeEdits() {
  await Inspector.flushPermissions?.();
  await W.flushInline?.();
  await Inspector.flushConnections?.();
  await Inspector.pending?.();
}

async function showExecutionHistory() {
  const project = W.project,
    workflow = W.workflow;
  const path = `projects/${project}/execution`;
  const [dispatches, trace] = await Promise.all([
    api(path + '/dispatches', {query: {workflow_id: workflow}}),
    api(path + '/trace', {query: {workflow_id: workflow, limit: 300}}),
  ]);
  if (W.project !== project || W.workflow !== workflow) return;
  dialog(
    'Execution history',
    `<p class="muted small">Retained diagnostic events. Values and request bodies are excluded.</p><h3>Dispatches</h3>${
      dispatches
        .slice(-30)
        .reverse()
        .map(r => `<p class="small"><code>${esc(r.dispatch_id)}</code> · ${esc(r.status)}</p>`)
        .join('') || '<p>No dispatches yet.</p>'
    }<h3>Events</h3><div style="max-height:45vh;overflow:auto">${trace.events.map(e => `<p class="small">${esc(new Date(e.at).toLocaleTimeString())} · ${esc(e.type)}${e.node_id ? ` · <button type="button" class="link" data-trace-node="${esc(e.node_id)}">${esc(nodeLabel(W.nodes.get(e.node_id) ?? {}) || e.node_id)}</button>` : ''}</p>`).join('') || '<p>No events retained.</p>'}</div>`,
    null
  );
  for (const button of $$('[data-trace-node]', $('#modal-body')))
    button.onclick = () => {
      $('#modal').close();
      reveal(button.dataset.traceNode);
    };
}
