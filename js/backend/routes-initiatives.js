'use strict';

const initiativeKey = id => 'initiatives/' + id;
const requiredText = (value, field, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw bad(`${field} must contain 1 to ${max} characters`);
  return value.trim();
};
async function readInitiative(c, id) {
  const log = await c.ctx.get(initiativeKey(id) + '/log', []);
  if (!log.length) throw missing('Initiative not found');
  return {log, state: initiativeState(log)};
}
function expectVersion(body, old) {
  if (body.version !== old.version)
    throw new ApiError('conflict', `Expected version ${old.version}; read and retry`, 409);
}
function appendInitiative(c, id, log, collection, value) {
  const event = {seq: log.length + 1, at: new Date().toISOString(), collection, value: clone(value)};
  const events = [...log, event];
  c.ctx.set(initiativeKey(id) + '/log', events);
  c.ctx.set(
    collection === 'initiative' ? initiativeKey(id) : initiativeKey(id) + '/' + collection + '/' + value.id,
    value
  );
  return value;
}
route(
  'GET POST',
  'initiatives',
  'List or create managed Initiatives',
  async c => {
    const ids = await c.ctx.get('initiative_index', []);
    if (c.method === 'GET') return Promise.all(ids.map(async id => (await readInitiative(c, id)).state.initiative));
    const id = uid(),
      b = c.body;
    const value = {
      id,
      title: requiredText(b.title, 'title', 200),
      goal: requiredText(b.goal, 'goal'),
      status: 'active',
      constraints: b.constraints ?? [],
      budget_id: b.budget_id ?? null,
      created_at: new Date().toISOString(),
      version: 1,
    };
    if (!Array.isArray(value.constraints) || value.constraints.some(x => typeof x !== 'string'))
      throw bad('constraints is a list of text');
    c.ctx.set('initiative_index', [...ids, id]);
    return appendInitiative(c, id, [], 'initiative', value);
  },
  {body: {title: 'Initiative', goal: 'Deliver a result', constraints: []}}
);
route('GET PUT', 'initiatives/{initiative_id}', 'Read or update an Initiative', async (c, {initiative_id: id}) => {
  const {state, log} = await readInitiative(c, id);
  if (c.method === 'GET')
    return {
      ...state.initiative,
      tasks: Object.values(state.tasks),
      decisions: Object.values(state.decisions),
      artifacts: Object.values(state.artifacts),
      facts: Object.values(state.facts),
      journal_version: state.version,
    };
  expectVersion(c.body, state.initiative);
  const value = {...state.initiative};
  for (const field of ['title', 'goal', 'constraints', 'status', 'budget_id'])
    if (field in c.body) value[field] = clone(c.body[field]);
  requiredText(value.title, 'title', 200);
  requiredText(value.goal, 'goal');
  if (!['active', 'paused', 'done', 'cancelled'].includes(value.status)) throw bad('Invalid initiative status');
  if (!Array.isArray(value.constraints) || value.constraints.some(x => typeof x !== 'string'))
    throw bad('constraints is a list of text');
  value.version++;
  return appendInitiative(c, id, log, 'initiative', value);
});
route(
  'GET',
  'initiatives/{initiative_id}/log',
  'Read immutable Initiative events',
  async (c, {initiative_id: id}) => (await readInitiative(c, id)).log
);
for (const collection of ['tasks', 'decisions', 'artifacts', 'facts']) {
  const build = (state, id, body, old = null) => {
    const at = new Date().toISOString();
    const value = {...old, id: old?.id ?? uid(), initiative_id: id, version: (old?.version ?? 0) + 1};
    const fields = {
      tasks: ['title', 'description', 'status', 'assignee', 'depends_on', 'parent_id', 'due', 'result_ref'],
      decisions: ['summary', 'rationale', 'made_by', 'supersedes'],
      artifacts: ['kind', 'title', 'uri', 'content_ref'],
      facts: ['text', 'source', 'confidence'],
    }[collection];
    for (const k of fields) if (k in body) value[k] = clone(body[k]);
    if (collection === 'tasks') {
      Object.assign(value, {
        description: value.description ?? '',
        status: value.status ?? 'todo',
        assignee: value.assignee ?? {kind: 'agent', ref: 'controller'},
        depends_on: value.depends_on ?? [],
      });
      requiredText(value.title, 'title', 200);
      checkTask(state, value, old);
    } else if (collection === 'decisions') {
      requiredText(value.summary, 'summary');
      requiredText(value.rationale, 'rationale');
      requiredText(value.made_by, 'made_by', 200);
      if (value.supersedes && !state.decisions[value.supersedes]) throw bad('Superseded decision not found');
      value.at = at;
    } else if (collection === 'artifacts') {
      requiredText(value.kind, 'kind', 100);
      requiredText(value.title, 'title', 200);
      if ((!value.uri && !value.content_ref) || (value.uri && value.content_ref))
        throw bad('Artifact needs either uri or content_ref');
    } else {
      requiredText(value.text, 'text');
      requiredText(value.source, 'source');
      if (!finite(value.confidence) || value.confidence < 0 || value.confidence > 1)
        throw bad('confidence must be from 0 to 1');
      value.at = at;
    }
    if (JSON.stringify(value).length > 64000) throw bad('Record is too large');
    return value;
  };
  route(
    'GET POST',
    `initiatives/{initiative_id}/${collection}`,
    `List or append ${collection}`,
    async (c, {initiative_id: id}) => {
      const {state, log} = await readInitiative(c, id);
      if (c.method === 'POST') return appendInitiative(c, id, log, collection, build(state, id, c.body));
      let values =
        c.query.ready === 'true' && collection === 'tasks' ? unblockedTasks(state) : Object.values(state[collection]);
      if (c.query.status) values = values.filter(v => v.status === c.query.status);
      if (c.query.assignee) values = values.filter(v => v.assignee?.ref === c.query.assignee);
      if (c.query.depends_on) values = values.filter(v => v.depends_on?.includes(c.query.depends_on));
      if (c.query.q)
        values = values.filter(v => JSON.stringify(v).toLowerCase().includes(String(c.query.q).toLowerCase()));
      return values;
    },
    {query: ['status', 'assignee', 'depends_on', 'ready', 'q']}
  );
  route(
    ['decisions', 'facts'].includes(collection) ? 'GET' : 'GET PUT',
    `initiatives/{initiative_id}/${collection}/{item_id}`,
    `Read or update ${collection}`,
    async (c, {initiative_id: id, item_id}) => {
      const {state, log} = await readInitiative(c, id),
        old = state[collection][item_id];
      if (!old) throw missing('Record not found');
      if (c.method === 'GET') return old;
      expectVersion(c.body, old);
      return appendInitiative(c, id, log, collection, build(state, id, c.body, old));
    }
  );
}
