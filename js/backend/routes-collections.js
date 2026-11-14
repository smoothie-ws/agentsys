// Generic JSON collections: a client plugin (or a Script) defines a collection's shape and stores records.
// The server validates the shape and persists the data; it assigns no meaning to fields such as provider or database.
'use strict';

const COLLECTION_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const RECORD_LIMIT = 10000;
const RECORD_SIZE = 1000000;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const definitionsKey = 'collections';

function checkCollectionSchema(schema, depth = 0) {
  if (depth > 12) throw bad('A collection schema is nested too deeply');
  if (schema === undefined) return {type: 'object'};
  if (!isObject(schema)) throw bad('schema must be an object');
  if (schema.type !== undefined && !SCHEMA_TYPES.has(schema.type))
    throw bad('schema.type must be one of ' + [...SCHEMA_TYPES].join(', '));
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 200))
    throw bad('schema.enum must be a list of at most 200 values');
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw bad('schema.properties must be an object');
    if (Object.keys(schema.properties).length > 200) throw bad('A collection has at most 200 fields');
    for (const value of Object.values(schema.properties)) checkCollectionSchema(value, depth + 1);
  }
  if (schema.items !== undefined) checkCollectionSchema(schema.items, depth + 1);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(v => typeof v !== 'string')))
    throw bad('schema.required must be a list of field names');
  return clone(schema);
}

function validateAgainst(schema, value, path = 'data') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok =
      schema.type === 'integer'
        ? Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : actual === schema.type;
    if (!ok) return `${path} must be ${schema.type}`;
  }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
    return `${path} must be one of its allowed values`;
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength)
    return `${path} is longer than ${schema.maxLength} characters`;
  if (Array.isArray(value) && schema.items)
    for (let i = 0; i < value.length; i++) {
      const error = validateAgainst(schema.items, value[i], `${path}[${i}]`);
      if (error) return error;
    }
  if (isObject(value) && schema.properties) {
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
        continue;
      }
      const error = validateAgainst(schema.properties[key], child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

async function collectionDefinition(c, name) {
  if (!COLLECTION_NAME.test(name)) throw bad('A collection name is lower-case letters, digits and "-"');
  const definitions = await c.ctx.get(definitionsKey, {});
  if (!Object.hasOwn(definitions, name)) throw missing('Collection not found: ' + name);
  return {definitions, definition: definitions[name]};
}

const recordsKey = name => `collection:${name}`;
const versionOf = record => record.version ?? 1;
const publicRecord = record => ({
  id: record.id,
  data: clone(record.data),
  created: record.created,
  updated: record.updated,
  // The version is what a client sends back as If-Match to make its next write conditional.
  version: versionOf(record),
});

/** The version a conditional write expects (`If-Match` arrives as `if_version`), or null for an unconditional one. */
function expectedVersion(c) {
  const raw = c.query.if_version;
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw bad('if_version must be a positive integer (the record version)');
  return value;
}
function assertVersion(record, expected) {
  if (expected === null) return;
  if (versionOf(record) !== expected)
    throw new ApiError(
      'conflict',
      `The record changed since it was read (version is ${versionOf(record)}, not ${expected}). Read it again and retry.`,
      409
    );
}

route('GET', 'collections', 'List generic JSON collection definitions', async c => {
  const definitions = await c.ctx.get(definitionsKey, {});
  return Object.entries(definitions).map(([name, definition]) => ({
    name,
    ...clone(definition),
  }));
});

route(
  'PUT DELETE',
  'collections/{name}',
  'Define, change or remove a generic JSON collection',
  async (c, {name}) => {
    if (!COLLECTION_NAME.test(name)) throw bad('A collection name is lower-case letters, digits and "-"');
    const definitions = await c.ctx.get(definitionsKey, {});
    if (c.method === 'DELETE') {
      if (!definitions[name]) throw missing('Collection not found');
      if (c.query.force !== '1') {
        const records = await c.ctx.get(recordsKey(name), []);
        if (records.length) throw bad('The collection has records; pass ?force=1 to delete them');
      }
      delete definitions[name];
      c.ctx.set(definitionsKey, definitions);
      await c.ctx.remove(recordsKey(name));
      return {deleted: true, name};
    }
    const title = String(c.body.title || name).slice(0, 120);
    const description = String(c.body.description || '').slice(0, 2000);
    const schema = checkCollectionSchema(c.body.schema ?? {type: 'object'});
    const definition = {title, description, schema, updated: Date.now() / 1000};
    definitions[name] = definition;
    c.ctx.set(definitionsKey, definitions);
    return {name, ...definition};
  },
  {body: {title: 'Providers', description: '', schema: {type: 'object', properties: {}}}}
);

route(
  'GET POST',
  'collections/{name}/records',
  'List or create records in a generic JSON collection',
  async (c, {name}) => {
    const {definition} = await collectionDefinition(c, name);
    const records = await c.ctx.get(recordsKey(name), []);
    if (c.method === 'GET') {
      const offset = Math.max(0, Number(c.query.offset ?? 0) || 0),
        limit = Math.min(500, Math.max(1, Number(c.query.limit ?? 100) || 100)),
        q = String(c.query.q ?? '').toLocaleLowerCase();
      const matching = q
        ? records.filter(record => JSON.stringify(record.data).toLocaleLowerCase().includes(q))
        : records;
      return {
        total: matching.length,
        records: matching.slice(offset, offset + limit).map(publicRecord),
        next_offset: offset + limit < matching.length ? offset + limit : null,
      };
    }
    if (records.length >= RECORD_LIMIT) throw bad('This collection has reached its record limit');
    const data = c.body.data === undefined ? c.body : c.body.data;
    if (!isObject(data)) throw bad('data must be a JSON object');
    const text = JSON.stringify(data);
    if (text.length > RECORD_SIZE) throw bad('A record is at most 1 MB');
    const error = validateAgainst(definition.schema, data);
    if (error) throw bad(error);
    const now = Date.now() / 1000,
      record = {
        id: c.body.id && /^[A-Za-z0-9_-]{1,100}$/.test(c.body.id) ? c.body.id : uid(),
        data,
        created: now,
        updated: now,
        version: 1,
      };
    if (records.some(item => item.id === record.id)) throw bad('A record with that id already exists');
    records.push(record);
    c.ctx.set(recordsKey(name), records);
    return publicRecord(record);
  },
  {query: ['offset', 'limit', 'q'], body: {data: {}}}
);

route(
  'GET PUT DELETE',
  'collections/{name}/records/{record_id}',
  'Read, replace or delete one record in a generic JSON collection',
  async (c, {name, record_id}) => {
    const {definition} = await collectionDefinition(c, name);
    const records = await c.ctx.get(recordsKey(name), []),
      record = records.find(item => item.id === record_id);
    if (!record) throw missing('Record not found');
    if (c.method === 'GET') return publicRecord(record);
    const expected = expectedVersion(c);
    assertVersion(record, expected);
    if (c.method === 'DELETE') {
      c.ctx.set(
        recordsKey(name),
        records.filter(item => item !== record)
      );
      return {deleted: true, id: record.id, version: versionOf(record)};
    }
    const data = c.body.data === undefined ? c.body : c.body.data;
    if (!isObject(data)) throw bad('data must be a JSON object');
    if (JSON.stringify(data).length > RECORD_SIZE) throw bad('A record is at most 1 MB');
    const error = validateAgainst(definition.schema, data);
    if (error) throw bad(error);
    record.data = data;
    record.updated = Date.now() / 1000;
    record.version = versionOf(record) + 1;
    c.ctx.set(recordsKey(name), records);
    return publicRecord(record);
  },
  {
    query: ['if_version'],
    body: {data: {}},
    returns:
      'The record with its version. Send the version back as If-Match (?if_version) to make the next write conditional; a mismatch is 409 conflict.',
  }
);
