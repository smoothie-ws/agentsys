// One durable state namespace per workflow. All writes use the request lock.
'use strict';
const STATE_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const utf8Bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const workflowBase = id => 'workflows/' + id;
const stateKey = key => {
  if (!STATE_KEY.test(key) || ['__proto__', 'constructor', 'prototype', '.', '..'].includes(key))
    throw bad('A state key has 1 to 100 characters: letters, digits and _ . : -');
  return key;
};
function jsonData(value) {
  return JSON.parse(
    JSON.stringify(value, (_, item) => {
      if (
        ['function', 'symbol', 'bigint'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw bad('Value must be JSON data');
      return item;
    })
  );
}
async function workflowOwner(c, id) {
  const project = (await c.projects()).find(p => !p.id.startsWith('lib-') && p.workflows.some(w => w.id === id));
  if (!project) throw missing('Workflow not found');
  if (c.scriptContext && c.scriptContext.workflow_id !== id)
    throw new ApiError('permission_denied', 'State and queues are private to the current workflow', 403);
  return project;
}
const stateEntryKey = (id, key) => `${workflowBase(id)}/state/${key}`;
route(
  'GET',
  'workflows/{workflow_id}/state',
  'List workflow state entries',
  async (c, {workflow_id}) => {
    await workflowOwner(c, workflow_id);
    const index = await c.ctx.get(`${workflowBase(workflow_id)}/state_index`, {entries: {}, bytes: 0}),
      result = [];
    for (const [key, meta] of Object.entries(index.entries).sort(([a], [b]) => a.localeCompare(b)))
      if (meta.present && key.startsWith(String(c.query.prefix ?? '')))
        result.push(await c.ctx.get(stateEntryKey(workflow_id, key)));
    return result;
  },
  {query: ['prefix']}
);
route(
  'GET PUT DELETE',
  'workflows/{workflow_id}/state/{key}',
  'Read, compare-and-set or delete workflow state',
  async (c, {workflow_id, key}) => {
    await workflowOwner(c, workflow_id);
    stateKey(key);
    const base = workflowBase(workflow_id),
      index = await c.ctx.get(base + '/state_index', {entries: {}, bytes: 0}),
      meta = index.entries[key],
      current = meta?.version ?? 0,
      entryKey = stateEntryKey(workflow_id, key);
    if (c.method === 'GET') {
      const entry = meta?.present && (await c.ctx.get(entryKey));
      if (!entry) throw missing('No such state key');
      return entry;
    }
    const expected = c.body.version ?? c.query.version;
    if (Object.keys(c.body).some(k => !['value', 'version'].includes(k))) throw bad('Unknown state field');
    if (
      expected !== undefined &&
      typeof expected !== 'number' &&
      !(typeof expected === 'string' && /^[0-9]+$/.test(expected))
    )
      throw bad('version is a whole number of 0 or more');
    if (expected !== undefined && (!Number.isSafeInteger(Number(expected)) || Number(expected) < 0))
      throw bad('version is a whole number of 0 or more');
    if (expected !== undefined && Number(expected) !== (meta?.present ? current : 0))
      throw new ApiError('conflict', `The version of "${key}" changed. Read it again and retry.`, 409);
    if (c.method === 'DELETE') {
      if (!meta?.present) throw missing('No such state key');
      index.bytes -= meta.bytes;
      index.entries[key] = {version: current + 1, present: false, bytes: 0};
      await c.ctx.remove(entryKey);
      c.ctx.set(base + '/state_index', index);
      return {deleted: key};
    }
    if (!Object.hasOwn(c.body, 'value') || c.body.value === undefined) throw bad('Pass the JSON value to store');
    const value = jsonData(c.body.value),
      bytes = utf8Bytes(value),
      prefs = await c.prefs();
    if (bytes > limitOf(prefs, 'state_value_bytes')) throw bad('State value exceeds state_value_bytes');
    if (index.bytes - (meta?.bytes ?? 0) + bytes > limitOf(prefs, 'state_total_bytes'))
      throw bad('Workflow state exceeds state_total_bytes');
    if (!meta && Object.keys(index.entries).length >= limitOf(prefs, 'state_max_keys')) throw bad('Too many state keys');
    const entry = {key, value, version: current + 1, updated: Date.now() / 1000};
    index.bytes += bytes - (meta?.bytes ?? 0);
    index.entries[key] = {present: true, version: entry.version, bytes};
    c.ctx.set(entryKey, entry);
    c.ctx.set(base + '/state_index', index);
    return entry;
  },
  {body: {value: 'JSON', version: 0}, query: ['version']}
);
