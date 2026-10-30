// One current execution per workflow. No persisted history, scheduler, retries or recovery.
'use strict';
const EXECUTIONS = new Map();
const executionActive = entry => entry && ['running', 'paused'].includes(entry.status);
function executionControl() {
  let send;
  return {
    paused: false,
    attach(receiver) {send = receiver; receiver({type: this.paused ? 'pause' : 'resume'});},
    set(paused) {this.paused = paused; send?.({type: paused ? 'pause' : 'resume'});},
  };
}
const executionDetail = entry => entry ? {
  id: entry.id, status: entry.status, paused: entry.control.paused,
  nodes: [...entry.nodes.values()], outputs: entry.outputs, errors: entry.errors,
  displays: entry.displays, evaluated_nodes: entry.evaluated_nodes,
} : {status: 'idle', nodes: [], outputs: {}, errors: {}, displays: {}, evaluated_nodes: 0};

async function beginExecution(c, project) {
  const entry = await exclusive(async () => {
    const {editor, meta} = await c.workflow(project);
    if (executionActive(EXECUTIONS.get(meta.id))) throw new ApiError('execution_active', 'This workflow is already executing', 409);
    const snapshot = editor.snapshot(), roots = c.body.node_ids ?? snapshot.nodes.filter(isRunStart).map(node => node.id);
    checkRoots(roots, Editor.nodeMap(snapshot));
    const payload = c.body.payload ?? {};
    if (!isObject(payload) || JSON.stringify(payload).length > 64000) throw bad('payload must be an object of at most 64000 characters');
    const entry = {id: uid(), project, workflow: meta.id, status: 'running', control: executionControl(),
      controller: new AbortController(), nodes: new Map(), outputs: {}, errors: {}, displays: {}, evaluated_nodes: 0};
    entry.plan = compilePlan(snapshot, [...new Set(roots)], {context: {project_id: project, workflow_id: meta.id, payload},
      events: Object.fromEntries(roots.map(id => [id, {payload}]))});
    for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
    await c.ctx.commit(); EXECUTIONS.set(meta.id, entry); return entry;
  });
  const onEvent = event => {
    if (entry.controller.signal.aborted) return;
    if (event.ev === 'root') {
      if (event.error) entry.errors[event.id] = event.error;
      else entry.outputs[event.id] = event.outputs;
      return;
    }
    const statuses = {start: 'running', resume: 'running', pause: 'working', done: 'completed', fail: 'failed', skip: 'skipped'};
    if (!statuses[event.ev]) return;
    entry.nodes.set(event.id, {node_id: event.id, status: event.blocked ? 'blocked' : statuses[event.ev], error: event.error});
    if (event.ev === 'done') {entry.evaluated_nodes++; if (event.display !== undefined) entry.displays[event.id] = event.display;}
    if (event.ev === 'fail') entry.errors[event.id] = event.error;
  };
  entry.done = runPlan(entry.plan, onEvent, entry.controller.signal, entry.control)
    .then(() => {if (!entry.controller.signal.aborted) entry.status = Object.keys(entry.errors).length ? 'failed' : 'completed';})
    .catch(error => {
      if (entry.controller.signal.aborted) entry.status = 'stopped';
      else {
        entry.status = 'failed'; entry.errors.execution = error.message;
        for (const [id,node] of entry.nodes) if (['running','working'].includes(node.status)) {
          entry.nodes.set(id,{...node,status:'failed',error:error.message}); entry.errors[id]=error.message;
        }
      }
    }).finally(() => {entry.control.paused = false; delete entry.plan;});
  return entry;
}

async function currentExecution(c, project) {
  const {workflows} = await c.project(project);
  const workflow = c.workflowId ?? workflows[0]?.id;
  if (!workflows.some(item => item.id === workflow)) throw missing('Record not found');
  const entry = EXECUTIONS.get(workflow);
  const expected = c.body.id ?? c.query.id;
  if (expected && entry?.id !== expected) throw new ApiError('execution_changed', 'A different execution is now selected', 409);
  return entry;
}
function stopExecution(workflow) {
  const entry = EXECUTIONS.get(workflow);
  if (executionActive(entry)) {entry.status = 'stopped'; entry.controller.abort();}
}
route('GET POST DELETE', 'projects/{project_id}/execution', 'Start, inspect or stop the current workflow execution', async (c, {project_id}) => {
  if (c.method === 'POST') {
    const entry = await beginExecution(c, project_id);
    if (c.body.wait === true) await entry.done;
    return executionDetail(entry);
  }
  const entry = await currentExecution(c, project_id);
  if (c.method === 'DELETE' && entry) {stopExecution(entry.workflow); await entry.done;}
  return executionDetail(entry);
}, {unlocked: true, body: {payload: {}, wait: false}, query: ['workflow_id', 'id']});
route('POST', 'projects/{project_id}/execution/{action}', 'Pause or resume the current workflow execution', async (c, {project_id, action}) => {
  if (!['pause', 'resume'].includes(action)) throw bad('Choose pause or resume');
  const entry = await currentExecution(c, project_id);
  if (!executionActive(entry)) return executionDetail(entry);
  entry.control.set(action === 'pause'); entry.status = action === 'pause' ? 'paused' : 'running';
  return executionDetail(entry);
}, {unlocked: true, query: ['workflow_id']});
