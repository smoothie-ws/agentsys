// Bounded at-least-once queues. Append-only between bounded compactions.
'use strict';
const queueKey = (id, name) => `${workflowBase(id)}/queues/${stateKey(name)}/journal`;
const queueSpaceEvent = async (id, name) => `queue-space:${id}:${(await hashText(name)).slice(0, 24)}`;
function queueSnapshot(log) {
  const state = {options: {limit: 1000, overflow: 'fail', visibility_ms: 30000}, items: []};
  for (const entry of log) {
    if (entry.op === 'snapshot') Object.assign(state, clone(entry.state));
    if (entry.op === 'options') Object.assign(state.options, entry.value);
    if (entry.op === 'push') state.items.push(clone(entry.item));
    if (entry.op === 'remove') state.items = state.items.filter(i => i.id !== entry.id);
    if (entry.op === 'lease') Object.assign(state.items.find(i => i.id === entry.id) ?? {}, entry.lease);
  }
  return state;
}
function queueOptions(value, old) {
  if (Object.keys(value).some(k => !['limit', 'visibility_ms', 'overflow'].includes(k)))
    throw bad('Unknown queue option');
  const out = {...old, ...value};
  for (const name of ['limit', 'visibility_ms'])
    if (!Number.isSafeInteger(out[name]) || out[name] < 1 || out[name] > (name === 'limit' ? 100000 : 604800000))
      throw bad('Invalid queue ' + name);
  if (!['fail', 'drop_oldest', 'drop_new', 'block'].includes(out.overflow)) throw bad('Invalid queue overflow');
  return {limit: out.limit, overflow: out.overflow, visibility_ms: out.visibility_ms};
}
async function queueRead(c, id, name) {
  await workflowOwner(c, id);
  const log = await c.ctx.get(queueKey(id, name), []);
  return {log, state: queueSnapshot(log)};
}
async function queueWrite(c, id, name, log, entries) {
  const indexKey = workflowBase(id) + '/queue_index',
    index = await c.ctx.get(indexKey, []);
  if (!index.includes(name)) {
    if (index.length >= 100) throw bad('At most 100 queues per workflow');
    index.push(name);
    c.ctx.set(indexKey, index);
  }
  const next = [...log, ...entries];
  c.ctx.set(queueKey(id, name), next.length > 256 ? [{op: 'snapshot', state: queueSnapshot(next)}] : next);
}
async function queuePull(c, id, name, {max = 1, visibility_ms} = {}, at = Date.now()) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) throw bad('pull max is an integer from 1 to 100');
  const {log, state} = await queueRead(c, id, name),
    duration = visibility_ms ?? state.options.visibility_ms;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 604800000) throw bad('Invalid visibility_ms');
  const entries = [],
    result = state.items
      .filter(i => (i.visible_at ?? 0) <= at)
      .slice(0, max)
      .map(item => {
        const lease = {receipt: uid(), visible_at: at + duration};
        entries.push({op: 'lease', id: item.id, lease});
        return {id: lease.receipt, item_id: item.id, value: clone(item.value), visible_at: lease.visible_at};
      });
  if (entries.length) await queueWrite(c, id, name, log, entries);
  return result;
}
async function queueAck(c, id, name, receipt, at = Date.now()) {
  const {log, state} = await queueRead(c, id, name),
    item = state.items.find(i => i.receipt === receipt);
  if (!item || item.visible_at <= at)
    throw new ApiError('conflict', 'Queue delivery expired or was already acknowledged', 409);
  await queueWrite(c, id, name, log, [{op: 'remove', id: item.id}]);
  c.queueFreed = {workflow_id: id, name};
  return {acked: receipt};
}
route('GET', 'workflows/{workflow_id}/queues', 'List workflow queues', async (c, {workflow_id}) => {
  await workflowOwner(c, workflow_id);
  const names = await c.ctx.get(workflowBase(workflow_id) + '/queue_index', []),
    result = [];
  for (const name of names) {
    const {state} = await queueRead(c, workflow_id, name);
    result.push({
      name,
      ...state.options,
      size: state.items.length,
      available: state.items.filter(i => i.visible_at <= Date.now()).length,
    });
  }
  return result;
});
route(
  'GET PUT',
  'workflows/{workflow_id}/queues/{name}',
  'Inspect or configure a queue',
  async (c, {workflow_id, name}) => {
    const {log, state} = await queueRead(c, workflow_id, name);
    if (c.method === 'PUT') {
      const options = queueOptions(c.body, state.options);
      if (state.items.length > options.limit) throw bad('Drain the queue before reducing its limit');
      await queueWrite(c, workflow_id, name, log, [{op: 'options', value: options}]);
      state.options = options;
    }
    return {name, ...state.options, size: state.items.length};
  },
  {body: {limit: 1000, overflow: 'fail', visibility_ms: 30000}}
);
route(
  'POST',
  'workflows/{workflow_id}/queues/{name}/push',
  'Push a JSON item',
  async (c, {workflow_id, name}) => {
    if (!Object.hasOwn(c.body, 'item') || c.body.item === undefined) throw bad('Pass the JSON item');
    const value = jsonData(c.body.item),
      {log, state} = await queueRead(c, workflow_id, name),
      entries = [],
      bytes = utf8Bytes(value),
      prefs = await c.prefs();
    if (bytes > limitOf(prefs, 'queue_item_bytes')) throw bad('Queue item is too large');
    if (state.items.length >= state.options.limit) {
      if (state.options.overflow === 'drop_new') return {accepted: false, dropped: 'new'};
      if (state.options.overflow === 'fail') throw new ApiError('queue_full', 'Queue is full', 409);
      if (state.options.overflow === 'block')
        return {blocked: true, event: await queueSpaceEvent(workflow_id, name), created_at: Date.now()};
      const oldest = state.items.find(i => i.visible_at <= Date.now());
      if (!oldest) throw new ApiError('queue_full', 'Queue is full of leased items', 409);
      entries.push({op: 'remove', id: oldest.id});
      state.items = state.items.filter(i => i !== oldest);
    }
    if (state.items.reduce((n, i) => n + utf8Bytes(i.value), 0) + bytes > limitOf(prefs, 'queue_total_bytes'))
      throw bad('Queue exceeds queue_total_bytes');
    const item = {id: uid(), value, visible_at: 0, receipt: null, created: Date.now()};
    entries.push({op: 'push', item});
    await queueWrite(c, workflow_id, name, log, entries);
    return {id: item.id, accepted: true};
  },
  {body: {item: 'JSON'}}
);
route(
  'POST',
  'workflows/{workflow_id}/queues/{name}/pull',
  'Lease queue items',
  (c, {workflow_id, name}) => queuePull(c, workflow_id, name, c.body),
  {body: {max: 1, visibility_ms: 30000}}
);
route(
  'POST',
  'workflows/{workflow_id}/queues/{name}/ack',
  'Acknowledge a delivery receipt',
  (c, {workflow_id, name}) => queueAck(c, workflow_id, name, c.body.id),
  {body: {id: 'delivery receipt'}}
);
