// Project state: a small key-value store per project that scripts and outside programs share, so a run can leave
// something for the next one (memory, counters, queues, flags). Every entry has a revision; a write may demand the
// revision it expects (`if_revision`, 0 = "must not exist yet"), which makes read-modify-write safe.
'use strict';

const STATE_MAX_KEYS = 500;
const STATE_MAX_VALUE = 256000; // characters of JSON per value
const STATE_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

async function projectState(c, project_id) {
  if (String(project_id).startsWith('lib-')) throw bad('State belongs to projects');
  await c.project(project_id);
  return c.ctx.get('state:' + project_id, {});
}
const stateKey = key => {
  if (!STATE_KEY.test(key)) throw bad('A state key has 1 to 100 characters: letters, digits and _ . : -');
  return key;
};
const stateEntry = (key, entry) => ({key, value: entry.value, revision: entry.revision, updated: entry.updated});
const expectedRevision = (c, name = 'if_revision') => {
  const raw = c.body[name] ?? c.query[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw bad(`${name} is a whole number of 0 or more`);
  return n;
};

route(
  'GET',
  'projects/{project_id}/state',
  'List the state keys of a project',
  async (c, {project_id}) => {
    const state = await projectState(c, project_id),
      prefix = String(c.query.prefix ?? ''),
      withValues = c.query.values === 'true';
    return Object.entries(state)
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) =>
        withValues ? stateEntry(key, entry) : {key, revision: entry.revision, updated: entry.updated}
      );
  },
  {query: ['prefix', 'values'], returns: 'Keys with their revision; values=true includes the values'}
);
route(
  'GET PUT DELETE',
  'projects/{project_id}/state/{key}',
  'Read, write or delete one state value',
  async (c, {project_id, key}) => {
    stateKey(key);
    const state = await projectState(c, project_id),
      entry = state[key];
    if (c.method === 'GET') {
      if (!entry) throw missing('No such state key');
      return stateEntry(key, entry);
    }
    const expected = expectedRevision(c),
      current = entry ? entry.revision : 0;
    if (expected !== null && expected !== current)
      throw new ApiError(
        'conflict',
        `The revision of "${key}" is ${current}, not ${expected}. Read it again and retry.`,
        409
      );
    if (c.method === 'DELETE') {
      if (!entry) throw missing('No such state key');
      delete state[key];
      c.ctx.set('state:' + project_id, state);
      return {deleted: key};
    }
    if (!('value' in c.body) || c.body.value === undefined) throw bad('Pass the value to store');
    const text = JSON.stringify(c.body.value);
    if (text === undefined || text.length > STATE_MAX_VALUE)
      throw bad(`A state value is JSON of at most ${STATE_MAX_VALUE} characters`);
    if (!entry && Object.keys(state).length >= STATE_MAX_KEYS)
      throw bad(`At most ${STATE_MAX_KEYS} state keys per project`);
    state[key] = {value: JSON.parse(text), revision: current + 1, updated: Date.now() / 1000};
    c.ctx.set('state:' + project_id, state);
    return stateEntry(key, state[key]);
  },
  {
    body: {value: {any: 'JSON'}, if_revision: 0},
    query: ['if_revision'],
    returns: 'The entry {key, value, revision, updated}',
  }
);
