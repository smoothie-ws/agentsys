// Durable execution metadata uses the same key-value store as runtime and plugin data.
'use strict';
const EXECUTION_OWNER = uid(),
  EXECUTION_WRITERS = new Map();
const executionKey = workflow => `workflows/${workflow}/executions`;
const executionRecord = (records, id) => (Object.hasOwn(records, id) ? records[id] : undefined);
const executionDefaults = () => ({
  version: 0,
  scopes: {},
  operations: {},
  dispatches: {},
  trace: [],
  sequence: 0,
  retention: {enabled: true, max_events: 1000, max_bytes: 1048576, max_age_ms: 604800000, max_dispatches: 200},
});
function requireVersion(expected, actual) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw bad('A nonnegative version is required');
  if (expected !== actual) throw new ApiError('conflict', 'Version changed; read again and retry.', 409);
}
async function executionStore(workflow) {
  return clone((await DB.get(executionKey(workflow), {fresh: true})) ?? executionDefaults());
}
function retainExecution(data) {
  const policy = data.retention,
    cutoff = Date.now() - policy.max_age_ms;
  data.trace = data.trace.filter(event => event.at >= cutoff).slice(-policy.max_events);
  if (!policy.max_events) data.trace = [];
  let bytes = 2,
    first = data.trace.length;
  for (let i = data.trace.length - 1; i >= 0; i--) {
    bytes += utf8Bytes(data.trace[i]) + 1;
    if (bytes > policy.max_bytes) break;
    first = i;
  }
  data.trace = data.trace.slice(first);
  const records = Object.values(data.dispatches).sort((a, b) => b.created_at - a.created_at);
  for (const record of records.slice(policy.max_dispatches))
    if (!['pending', 'running'].includes(record.status)) delete data.dispatches[record.dispatch_id];
}
function executionUpdate(workflow, change) {
  const previous = EXECUTION_WRITERS.get(workflow) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      for (;;) {
        const data = await executionStore(workflow),
          version = data.version;
        const result = change(data);
        retainExecution(data);
        data.version++;
        try {
          await DB.compareAndSet(executionKey(workflow), version, data);
          return clone(result);
        } catch (error) {
          if (error.code !== 'conflict') throw error;
        }
      }
    });
  EXECUTION_WRITERS.set(workflow, work);
  work
    .finally(() => {
      if (EXECUTION_WRITERS.get(workflow) === work) EXECUTION_WRITERS.delete(workflow);
    })
    .catch(() => {});
  return work;
}
// Only metadata is admitted to traces. In particular, never accept arbitrary error text or API arguments.
function traceRecord(data, identity, type, fields = {}) {
  if (!data.retention.enabled) return;
  const event = {sequence: ++data.sequence, at: identity.at ?? Date.now(), type};
  for (const key of [
    'project_id',
    'workflow_id',
    'run_id',
    'dispatch_id',
    'parent_dispatch_id',
    'parent_invocation_id',
    'invocation_id',
    'graph_revision',
    'node_id',
    'operation_id',
  ])
    if (identity[key] != null) event[key] = identity[key];
  for (const key of [
    'status',
    'reason',
    'method',
    'route',
    'port_id',
    'signal_id',
    'parent_invocation_id',
    'duration_ms',
    'attempt',
  ])
    if (fields[key] != null) event[key] = fields[key];
  data.trace.push(event);
}
function operationTransition(data, entry, record, status, identity = {}) {
  record.status = status;
  record.version++;
  record.updated_at = Date.now();
  (record.history ??= []).push({
    status,
    attempt: record.attempt,
    at: record.updated_at,
    ...(status === 'failed' && record.error !== undefined ? {error: clone(record.error)} : {}),
  });
  traceRecord(
    data,
    {...record, ...identity, operation_id: record.id, project_id: entry.project, workflow_id: entry.workflow},
    'operation.state',
    {status, attempt: record.attempt}
  );
  return record;
}
function journal(entry, change) {
  const work = executionUpdate(entry.workflow, data => {
    if (data.owner !== EXECUTION_OWNER) {
      entry.deleted = true;
      throw new ApiError('execution_cancelled', 'Execution storage belongs to a newer backend', 409);
    }
    return change(data);
  });
  entry.journal = work;
  work.catch(error => {
    if (
      ![
        'conflict',
        'invalid_request',
        'not_found',
        'permission_denied',
        'manual_resolution_required',
        'budget_exceeded',
        'execution_cancelled',
      ].includes(error.code)
    )
      entry.storageError = 'Execution journal could not be saved';
  });
  return work;
}
async function recoverExecutions(entry) {
  await executionUpdate(entry.workflow, data => {
    data.owner = EXECUTION_OWNER;
    entry.tracingEnabled = data.retention.enabled;
    for (const record of Object.values(data.dispatches))
      if (['pending', 'running'].includes(record.status)) {
        record.status = 'interrupted';
        record.finished_at = Date.now();
        record.reason = 'restart';
        traceRecord(data, record, 'dispatch.end', {status: 'interrupted', reason: 'restart'});
      }
    for (const record of Object.values(data.operations))
      if (record.status === 'running') {
        record.uncertain = record.policy !== 'safe';
        operationTransition(data, entry, record, 'interrupted');
      }
  });
}
const executionPolicies = new Set(['safe', 'idempotent', 'manual']);
function checkExecutionPolicy(value = {}) {
  if (!isObject(value)) throw bad('policy must be an object');
  const keys = ['max_duration_ms', 'max_invocations', 'max_dispatches', 'max_parallelism', 'max_active_operations'];
  for (const [key, limit] of Object.entries(value))
    if (!keys.includes(key) || !Number.isSafeInteger(limit) || limit < 1) throw bad('Invalid execution budget: ' + key);
  return clone(value);
}
// Registration is intentionally after execution.js; route order keeps concrete routes before {action}.
function registerExecutionDataRoutes() {
  const options = {unlocked: true, query: ['workflow_id']};
  route(
    'GET PUT',
    'projects/{project_id}/execution/retention',
    'Read or configure bounded execution diagnostics',
    async (c, {project_id}) => {
      const entry = await graphRuntime(c, project_id);
      if (c.method === 'GET') return (await executionStore(entry.workflow)).retention;
      if (c.scriptContext) throw new ApiError('permission_denied', 'Diagnostic policy is managed by the user', 403);
      const result = await journal(entry, data => {
        const policy = {...data.retention, ...c.body};
        delete policy.workflow_id;
        if (
          Object.keys(policy).some(
            k => !['enabled', 'max_events', 'max_bytes', 'max_age_ms', 'max_dispatches'].includes(k)
          ) ||
          typeof policy.enabled !== 'boolean' ||
          !Number.isSafeInteger(policy.max_events) ||
          policy.max_events < 0 ||
          policy.max_events > 100000 ||
          !Number.isSafeInteger(policy.max_bytes) ||
          policy.max_bytes < 0 ||
          policy.max_bytes > 104857600 ||
          !Number.isSafeInteger(policy.max_age_ms) ||
          policy.max_age_ms < 0 ||
          !Number.isSafeInteger(policy.max_dispatches) ||
          policy.max_dispatches < 1 ||
          policy.max_dispatches > 10000
        )
          throw bad('Invalid retention policy');
        return (data.retention = policy);
      });
      entry.tracingEnabled = result.enabled;
      return result;
    },
    {
      ...options,
      needs: {GET: ['run.read'], PUT: ['system.admin']},
      body: {enabled: true, max_events: 1000, max_bytes: 1048576, max_age_ms: 604800000, max_dispatches: 200},
    }
  );
  route(
    'GET',
    'projects/{project_id}/execution/trace',
    'Read metadata-only execution history',
    async (c, {project_id}) => {
      const entry = await graphRuntime(c, project_id);
      await entry.journal?.catch(() => {});
      const data = await executionStore(entry.workflow);
      retainExecution(data);
      const after = Number(c.query.after ?? 0),
        limit = Math.min(10000, Math.max(1, Number(c.query.limit ?? 1000)));
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit)) throw bad('Invalid trace cursor or limit');
      const events = data.trace
        .filter(
          event =>
            event.sequence > after &&
            ['run_id', 'dispatch_id', 'node_id'].every(key => !c.query[key] || event[key] === c.query[key])
        )
        .slice(0, limit);
      return {events, next: events.at(-1)?.sequence ?? after, oldest: data.trace[0]?.sequence ?? data.sequence + 1};
    },
    {...options, query: ['workflow_id', 'run_id', 'dispatch_id', 'node_id', 'after', 'limit']}
  );
  route(
    'GET',
    'projects/{project_id}/execution/dispatches',
    'List retained dispatch records',
    async (c, {project_id}) => {
      const entry = await graphRuntime(c, project_id);
      await entry.journal?.catch(() => {});
      return Object.values((await executionStore(entry.workflow)).dispatches).filter(
        r => !c.query.run_id || r.run_id === c.query.run_id
      );
    },
    {...options, query: ['workflow_id', 'run_id']}
  );
  route(
    'GET DELETE',
    'projects/{project_id}/execution/dispatches/{id}',
    'Inspect a dispatch or stop its workflow host',
    async (c, {project_id, id}) => {
      const entry = await graphRuntime(c, project_id);
      await entry.journal?.catch(() => {});
      if (!executionRecord((await executionStore(entry.workflow)).dispatches, id)) throw missing('Dispatch not found');
      if (c.method === 'DELETE') await stopGraph(entry.workflow);
      return executionRecord((await executionStore(entry.workflow)).dispatches, id);
    },
    options
  );
  route(
    'GET DELETE',
    'projects/{project_id}/execution/scopes',
    'List areas or clean temporary areas for one run',
    async (c, {project_id}) => {
      const entry = await graphRuntime(c, project_id);
      if (c.method === 'GET')
        return Object.entries((await executionStore(entry.workflow)).scopes)
          .filter(([, r]) => !r.deleted)
          .map(([id, r]) => ({id, ...r}));
      if (!c.query.run_id) throw bad('run_id is required for temporary cleanup');
      return journal(entry, data => {
        let removed = 0;
        for (const [id, r] of Object.entries(data.scopes))
          if (!r.deleted && r.temporary && r.run_id === c.query.run_id) {
            data.scopes[id] = {version: r.version + 1, deleted: true};
            removed++;
          }
        return {removed};
      });
    },
    {...options, query: ['workflow_id', 'run_id']}
  );
  route(
    'GET PUT DELETE',
    'projects/{project_id}/execution/scopes/{id}',
    'Read or compare-and-set a JSON area',
    async (c, {project_id, id}) => {
      stateKey(id);
      const entry = await graphRuntime(c, project_id);
      if (c.method === 'GET') {
        const r = executionRecord((await executionStore(entry.workflow)).scopes, id);
        return r && !r.deleted ? {id, ...r} : {id, version: r?.version ?? 0, value: null, deleted: true};
      }
      if (c.body.run_id != null) stateKey(c.body.run_id);
      if (c.body.temporary !== undefined && typeof c.body.temporary !== 'boolean')
        throw bad('temporary must be a boolean');
      const value = c.method === 'PUT' ? jsonData(c.body.value) : null;
      return journal(entry, data => {
        assertExecutionCurrent(c.scriptContext);
        const previous = executionRecord(data.scopes, id);
        requireVersion(c.body.version ?? Number(c.query.version), previous?.version ?? 0);
        const record = {
          version: (previous?.version ?? 0) + 1,
          ...(c.method === 'DELETE'
            ? {deleted: true}
            : {
                value,
                temporary: c.body.temporary === true,
                run_id: c.scriptContext?.execution?.run_id ?? c.body.run_id ?? null,
              }),
        };
        data.scopes[id] = record;
        return {id, ...record};
      });
    },
    {...options, query: ['workflow_id', 'version'], body: {version: 0, value: {}, temporary: false}}
  );
  route(
    'GET POST',
    'projects/{project_id}/execution/operations',
    'List or register durable operations',
    async (c, {project_id}) => {
      const entry = await graphRuntime(c, project_id);
      if (c.method === 'GET')
        return Object.values((await executionStore(entry.workflow)).operations).filter(
          r => !c.query.run_id || r.run_id === c.query.run_id
        );
      const id = stateKey(c.body.id),
        policy = c.body.policy ?? 'manual';
      if (c.body.parent_id != null) stateKey(c.body.parent_id);
      if (c.body.run_id != null) stateKey(c.body.run_id);
      if (!executionPolicies.has(policy)) throw bad('Operation policy is safe, idempotent or manual');
      const input = jsonData(c.body.input ?? null),
        key = c.body.idempotency_key ?? uid();
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) throw bad('Invalid idempotency key');
      return journal(entry, data => {
        assertExecutionCurrent(c.scriptContext);
        if (executionRecord(data.operations, id)) throw new ApiError('conflict', 'Operation already exists', 409);
        if (c.body.parent_id != null && !executionRecord(data.operations, c.body.parent_id))
          throw missing('Parent operation not found');
        return (data.operations[id] = {
          id,
          version: 1,
          status: 'pending',
          attempt: 0,
          input,
          policy,
          idempotency_key: key,
          graph_revision: entry.graphRevision,
          ...(c.scriptContext?.execution
            ? {
                dispatch_id: c.scriptContext.execution.dispatch_id,
                invocation_id: c.scriptContext.execution.invocation_id,
              }
            : {}),
          run_id: c.scriptContext?.execution?.run_id ?? c.body.run_id ?? null,
          parent_id: c.body.parent_id ?? null,
          created_at: Date.now(),
          updated_at: Date.now(),
          history: [{status: 'pending', attempt: 0, at: Date.now()}],
        });
      });
    },
    {...options, query: ['workflow_id', 'run_id'], body: {id: 'step', input: {}, policy: 'manual'}}
  );
  route(
    'GET PUT',
    'projects/{project_id}/execution/operations/{id}',
    'Read or commit a checkpoint with an expected version',
    async (c, {project_id, id}) => {
      stateKey(id);
      const entry = await graphRuntime(c, project_id);
      if (c.method === 'GET') {
        const r = executionRecord((await executionStore(entry.workflow)).operations, id);
        if (!r) throw missing('Operation not found');
        return r;
      }
      return journal(entry, data => {
        assertExecutionCurrent(c.scriptContext);
        const r = executionRecord(data.operations, id);
        if (!r) throw missing('Operation not found');
        requireVersion(c.body.version, r.version);
        const status = c.body.status;
        if (
          !(
            (r.status === 'pending' && ['running', 'cancelled'].includes(status)) ||
            (r.status === 'running' && ['completed', 'failed', 'cancelled'].includes(status))
          )
        )
          throw bad('Invalid operation transition; retry requires an explicit policy decision');
        if (status === 'running') {
          const limit = c.scriptContext?.execution?.policy?.max_active_operations;
          const run_id = c.scriptContext?.execution?.run_id ?? r.run_id;
          if (
            limit &&
            Object.values(data.operations).filter(
              o => (o.attempt_run_id ?? o.run_id) === run_id && o.status === 'running'
            ).length >= limit
          )
            throw executionBudgetExceeded(c.scriptContext, 'Active operation budget exceeded');
          r.attempt++;
          r.attempt_run_id = run_id;
          r.attempt_dispatch_id = c.scriptContext?.execution?.dispatch_id ?? null;
          r.owner = EXECUTION_OWNER;
        }
        if (Object.hasOwn(c.body, 'result')) r.result = jsonData(c.body.result);
        // Explicit checkpoint data is user data. Structured tracing never copies it.
        if (Object.hasOwn(c.body, 'error')) r.error = stripSecrets(jsonData(c.body.error));
        if (status === 'failed' || status === 'cancelled') r.uncertain = r.policy !== 'safe';
        return operationTransition(data, entry, r, status, c.scriptContext?.execution);
      });
    },
    {...options, body: {version: 1, status: 'running'}}
  );
  route(
    'POST',
    'projects/{project_id}/execution/operations/{id}/retry',
    'Explicitly retry an allowed operation',
    async (c, {project_id, id}) => {
      stateKey(id);
      const entry = await graphRuntime(c, project_id);
      return journal(entry, data => {
        assertExecutionCurrent(c.scriptContext);
        const r = executionRecord(data.operations, id);
        if (!r) throw missing('Operation not found');
        requireVersion(c.body.version, r.version);
        if (!['failed', 'interrupted', 'cancelled'].includes(r.status))
          throw bad('Only failed, interrupted or cancelled operations can retry');
        if (r.policy === 'manual')
          throw new ApiError('manual_resolution_required', 'Outcome may be uncertain; a person must resolve it', 409);
        r.uncertain = false;
        delete r.error;
        return operationTransition(data, entry, r, 'pending', c.scriptContext?.execution);
      });
    },
    {...options, body: {version: 2}}
  );
  route(
    'POST',
    'projects/{project_id}/execution/operations/{id}/resolve',
    'Record a user decision about an uncertain operation',
    async (c, {project_id, id}) => {
      stateKey(id);
      const entry = await graphRuntime(c, project_id);
      return journal(entry, data => {
        const r = executionRecord(data.operations, id);
        if (!r) throw missing('Operation not found');
        requireVersion(c.body.version, r.version);
        if (
          !['failed', 'cancelled', 'interrupted'].includes(r.status) ||
          !['completed', 'pending', 'cancelled'].includes(c.body.status)
        )
          throw bad('Invalid resolution');
        r.uncertain = false;
        if (c.body.status !== 'cancelled') delete r.error;
        if (Object.hasOwn(c.body, 'result')) r.result = jsonData(c.body.result);
        return operationTransition(data, entry, r, c.body.status);
      });
    },
    {...options, needs: {POST: ['system.admin']}, body: {version: 3, status: 'completed', result: null}}
  );
}
