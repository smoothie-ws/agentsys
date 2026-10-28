// Running the workflow (Start) and the toolbar status.
'use strict';

// ----- runs -----
function syncToolbar() {
  const last = W.lastRun;
  $('#run-summary').innerHTML = W.running
    ? `<span class="dot busy"></span>${W.runPaused ? 'Paused' : 'Running…'}`
    : W.waitingRun
      ? `<span class="dot busy"></span>Waiting <a href="/controller" data-link>Details</a><button id="wait-resume">Resume</button><button id="wait-cancel">Cancel</button>`
      : W.observedRun
        ? `<span class="dot busy"></span>Running <a href="/controller" data-link>Details</a>`
        : last?.failed && W.results.size + W.runStatus.size
          ? `<span class="warn">${last.failed} failed</span>`
          : '';
  for (const action of ['resume', 'cancel']) {
    const button = $('#wait-' + action);
    if (button)
      button.onclick = async () => {
        try {
          const id = W.waitingRun.id;
          const run = await api(`runs/${id}/${action}`, {method: 'POST'});
          W.followedRunId = terminalRun(run.status) ? null : id;
          W.observedRun = run.status === 'running' ? run : null;
          W.waitingRun = null;
          await reload();
          syncToolbar();
        } catch (e) {
          fail(e);
        }
      };
  }
  const start = $('#start');
  if (start) {
    start.classList.toggle('stop', !!W.running);
    start.title = W.running ? 'Stop the run' : `Run the workflow (${shortcutText('run')})`;
    start.innerHTML = W.running ? `${icon('stop')}<span>Stop</span>` : `${icon('play')}<span>Run</span>`;
  }
  const pause = $('#pause');
  if (pause) {
    pause.hidden = !W.running;
    pause.title = pause.ariaLabel = W.runPaused ? 'Resume the run' : 'Pause the run';
    pause.innerHTML = icon(W.runPaused ? 'play' : 'pause');
  }
  $('#undo').disabled = !W.history.undo || W.running;
  $('#redo').disabled = !W.history.redo || W.running;
  W.canvas.classList.toggle('busy', !!W.running);
  W.canvas.closest('.editor')?.classList.toggle('running', !!W.running);
}

/** The nodes a Run fires: the on_run nodes that are on. */
const startNodes = (nodes = W.snapshot.nodes) => nodes.filter(isRunStart);

/** What a finished run leaves behind: what the nodes showed, the summary and the log (a line for each node that showed something or failed). */
function runRecord(nodes, result, started) {
  // An event node is the root of what follows it: an error of a node after it is reported for that node, not for the event node too.
  const events = new Set(nodes.filter(n => EVENT_OPS.has(n.config?.op)).map(n => n.id)),
    own = Object.keys(result.errors).filter(id => !events.has(id)),
    failed = new Set(own.length ? own : Object.keys(result.errors)),
    displays = result.displays || {},
    last = {
      ran: result.evaluated_nodes,
      failed: Object.values(result.status).filter(s => s === 'failed').length,
      at: Date.now(),
      ms: Date.now() - started,
    };
  return {
    failed,
    last,
    results: [
      ...Object.entries(displays).map(([id, text]) => [id, {text}]),
      ...[...failed].map(id => [id, {error: result.errors[id]}]),
    ],
    log: [
      {kind: 'summary', ...last},
      ...nodes
        .filter(n => n.id in displays || failed.has(n.id))
        .map(n => ({
          kind: 'sink',
          id: n.id,
          label: nodeLabel(n),
          error: result.errors[n.id] || null,
          value: failed.has(n.id) ? undefined : sinkValue(displays[n.id], result.outputs[n.id]),
        })),
    ],
  };
}

/** What the log shows for a sink: its display() text, else its outputs as JSON, else nothing. */
const sinkValue = (shown, outputs) =>
  shown !== undefined
    ? {
        text: shown
          .split(DISPLAY_PARTS)
          .map(part => (IMAGE_DISPLAY.test(part) ? '[image]' : part))
          .join('\n'),
      }
    : outputs && Object.keys(outputs).length
      ? {text: JSON.stringify(outputs, null, 2)}
      : undefined;

/** A Complex Node (a placed Library node, shown collapsed) runs nothing itself: its state is that of what runs inside it,
 *  running while anything in it runs, else failed if anything failed, else completed, else skipped. It is derived, never stored in `W.runStatus`. */
function syncComplexStatus() {
  const memo = new Map();
  const stateOf = id => {
    if (!id.startsWith('complex:')) return W.runStatus.get(id);
    if (memo.has(id)) return memo.get(id);
    memo.set(id, undefined); // a group inside itself is not possible; this only guards the recursion
    const states = (W.complex.get(id.slice('complex:'.length))?.members || []).map(stateOf);
    const state = ['running', 'waiting', 'failed', 'completed', 'skipped'].find(s => states.includes(s));
    memo.set(id, state);
    return state;
  };
  for (const cx of W.snapshot.complex) {
    const node = W.nodes.get('complex:' + cx.id);
    if (node) {
      node.status = stateOf(node.id) || 'ready';
      if (node.status === 'waiting') node.wait = cx.members.map(id => W.nodes.get(id)?.wait).find(Boolean);
    }
  }
}

/** What one event of the run changes on the canvas: a node starts (running), is done (what it showed) or fails (its error). */
function applyRunEvent(event) {
  const node = W.nodes.get(event.node_id);
  if (!node) return;
  const states = {
    node_started: 'running',
    node_waiting: 'waiting',
    node_completed: 'completed',
    node_failed: 'failed',
    node_skipped: 'skipped',
    node_cancelled: 'ready',
  };
  const status = states[event.type];
  if (!status) return;
  node.status = status;
  if (event.wait) node.wait = event.wait;
  W.runStatus.set(node.id, status);
  syncComplexStatus();
  if (event.type === 'node_completed' && typeof event.display === 'string')
    W.results.set(node.id, {text: event.display});
  if (event.type === 'node_failed') W.results.set(node.id, {error: event.error});
}

/** Starts the run in the background and shows it on the graph as it goes: the events of the run are followed until it finishes.
 *  Answers what a finished run answers (outputs, errors, status, evaluated_nodes, displays by node id), or nothing when the page was left. */
async function watchRun(roots) {
  const canvas = W.canvas;
  const run = await api(`projects/${W.project}/runs`, {method: 'POST', body: wf({node_ids: roots})});
  W.runId = run.id;
  W.followedRunId = run.id;
  syncToolbar();
  let after = 0;
  for (let finished = false; !finished; ) {
    const batch = await api(`runs/${run.id}/events`, {query: {after, wait: 5000}});
    if (W.canvas !== canvas || !canvas.isConnected) return null;
    after = batch.next;
    finished = batch.finished;
    const changing = batch.events.filter(e => e.node_id);
    for (const event of changing) applyRunEvent(event);
    if (changing.length) draw();
  }
  const detail = await api(`runs/${run.id}`);
  W.waitingRun = detail.status === 'waiting' ? detail : null;
  const cancelled = detail.status === 'cancelled',
    status = {},
    errors = cancelled ? {} : {...detail.errors};
  for (const entry of detail.nodes) {
    if (cancelled) {
      if (entry.status === 'completed') status[entry.node_id] = 'completed';
      continue;
    }
    status[entry.node_id] = entry.status;
    if (entry.status !== 'completed' && entry.error && !(entry.node_id in errors)) errors[entry.node_id] = entry.error;
  }
  return {
    outputs: detail.outputs ?? {},
    errors,
    status,
    evaluated_nodes: detail.evaluated_nodes,
    displays: detail.displays ?? {},
    cancelled,
  };
}

/** The Stop button: the run is cancelled; what has run stays on the graph. */
async function stopRun() {
  if (W.runId) await api(`runs/${W.runId}/cancel`, {method: 'POST', body: {}});
}

/** The Pause button: no node starts until Resume (the nodes already running finish). */
async function pauseRun() {
  if (!W.runId) return;
  const run = await api(`runs/${W.runId}/${W.runPaused ? 'resume' : 'pause'}`, {method: 'POST', body: {}});
  W.runPaused = run.paused;
  syncToolbar();
}

/** Run fires every on_run of the workflow: the signals go from there, and the run lasts until nothing is running. */
async function runAction() {
  if (W.running) return;
  await flushNodeEdits();
  await Inspector.leave();
  const starts = startNodes();
  if (!starts.length) return toast('Place a node with the operation on_run and wire its signal to a node that runs.');
  const workflow = W.workflow,
    started = Date.now();
  W.running = true;
  W.runPaused = false;
  W.runId = null;
  W.runStatus.clear();
  W.results.clear();
  for (const node of W.snapshot.nodes) node.status = 'ready';
  syncComplexStatus();
  draw();
  syncToolbar();
  let result;
  try {
    result = await watchRun(starts.map(n => n.id));
  } finally {
    W.running = false;
    W.runPaused = false;
    W.runId = null;
    for (const [id, status] of [...W.runStatus]) if (!['failed', 'waiting'].includes(status)) W.runStatus.delete(id);
    for (const node of W.snapshot.nodes) if (!['failed', 'waiting'].includes(node.status)) node.status = 'ready';
    syncComplexStatus();
    // The toolbar and the nodes must come back to rest even when the call itself failed.
    draw();
    syncToolbar();
  }
  if (!result || W.workflow !== workflow || !W.canvas?.isConnected) return;
  const {failed, last, results, log} = runRecord(W.snapshot.nodes, result, started);
  // Only a failure stays after the run (its icon, with the error); a node that did its work is not marked.
  for (const [id, status] of Object.entries(result.status)) if (status === 'failed') W.runStatus.set(id, status);
  for (const [id, value] of results) W.results.set(id, value);
  W.lastRun = last;
  W.runLog = log;
  api(`projects/${W.project}/last-run`, {
    method: 'PUT',
    body: wf({results: [...W.results], status: [...W.runStatus], last: W.lastRun, log: W.runLog}),
  }).catch(() => {});
  // The failed nodes are on the canvas: the count links to the first of them.
  const firstFailed = [...failed][0];
  toast(
    W.waitingRun
      ? 'Waiting. Manage this run in Controller.'
      : result.cancelled
        ? 'Stopped.'
        : failed.size
          ? `Finished with [${plural(failed.size, 'error')}](node:${firstFailed}).`
          : 'Evaluated.',
    failed.size > 0
  );
  await reload();
  if (Inspector.tab === 'activity') Inspector.show();
}

async function flushNodeEdits() {
  await W.flushInline?.();
  await Inspector.flushConnections?.();
  await Inspector.pending?.();
}
