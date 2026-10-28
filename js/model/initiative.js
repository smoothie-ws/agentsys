'use strict';

// A managed Initiative is separate from an editor Project. The journal is authoritative;
// projections can be discarded and rebuilt with this pure reducer.
const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'];
const TASK_TRANSITIONS = {
  todo: ['doing', 'blocked', 'cancelled'],
  doing: ['blocked', 'done', 'cancelled'],
  blocked: ['todo', 'doing', 'cancelled'],
  done: [],
  cancelled: [],
};
function initiativeState(log) {
  return log.reduce(applyInitiativeEvent, {
    initiative: null,
    tasks: {},
    decisions: {},
    artifacts: {},
    facts: {},
    version: 0,
  });
}
function applyInitiativeEvent(state, event) {
  const next = clone(state);
  if (event.collection === 'initiative') next.initiative = clone(event.value);
  else next[event.collection][event.value.id] = clone(event.value);
  next.version = event.seq;
  return next;
}
function unblockedTasks(state) {
  return Object.values(state.tasks).filter(
    t => ['todo', 'blocked'].includes(t.status) && t.depends_on.every(id => state.tasks[id]?.status === 'done')
  );
}
function checkTask(state, task, old) {
  if (!TASK_STATUSES.includes(task.status)) throw bad('Invalid task status');
  if (old && task.status !== old.status && !TASK_TRANSITIONS[old.status].includes(task.status))
    throw bad(`Cannot change ${old.status} to ${task.status}`);
  if (
    !Array.isArray(task.depends_on) ||
    task.depends_on.some(id => typeof id !== 'string' || !state.tasks[id] || id === task.id)
  )
    throw bad('Dependencies must be existing other tasks');
  if (new Set(task.depends_on).size !== task.depends_on.length) throw bad('Duplicate dependencies');
  const tasks = {...state.tasks, [task.id]: task};
  const visit = (id, path) => {
    if (path.has(id)) throw bad('Tasks cannot contain a dependency cycle');
    const next = new Set(path).add(id);
    for (const dep of tasks[id]?.depends_on ?? []) visit(dep, next);
  };
  visit(task.id, new Set());
  if (task.parent_id && !state.tasks[task.parent_id]) throw bad('Parent task not found');
  for (let id = task.parent_id, seen = new Set([task.id]); id; id = tasks[id]?.parent_id) {
    if (seen.has(id)) throw bad('Tasks cannot contain a parent cycle');
    seen.add(id);
  }
  if (['doing', 'done'].includes(task.status) && task.depends_on.some(id => state.tasks[id]?.status !== 'done'))
    throw bad('Task dependencies are not done');
  if (
    !isObject(task.assignee) ||
    !['node', 'human', 'agent'].includes(task.assignee.kind) ||
    typeof task.assignee.ref !== 'string'
  )
    throw bad('Invalid assignee');
  if (task.due && !Number.isFinite(Date.parse(task.due))) throw bad('Invalid due date');
}
