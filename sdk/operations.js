// Universal checkpoint orchestration. Works with a checked app.request/agentsys adapter or an HTTP adapter.
'use strict';
function createOperationRunner(request, {project_id, workflow_id, run_id = null, parent_id = null}) {
  const base = `projects/${project_id}/execution/operations`;
  const send = (method, path, body = {}) => request(method, path, {...body, workflow_id}, {workflow_id});
  const get = id => send('GET', `${base}/${encodeURIComponent(id)}`);
  return {
    get,
    async checkpoint(id, input, policy = 'manual') {
      try {
        return await send('POST', base, {id, input, policy, run_id, parent_id});
      } catch (error) {
        if (error.code !== 'conflict' && error.status !== 409) throw error;
        const existing = await get(id);
        if (JSON.stringify(existing.input) !== JSON.stringify(input) || existing.policy !== policy)
          throw Error('Operation ID already belongs to different input or policy');
        return existing;
      }
    },
    async execute(id, input, action, {policy = 'manual', retry = false} = {}) {
      let record = await this.checkpoint(id, input, policy);
      if (record.status === 'completed') return record.result;
      if (retry && ['failed', 'interrupted', 'cancelled'].includes(record.status))
        record = await send('POST', `${base}/${encodeURIComponent(id)}/retry`, {version: record.version});
      if (record.status !== 'pending')
        throw Error(`Operation ${id} is ${record.status}; an explicit recovery decision is required`);
      record = await send('PUT', `${base}/${encodeURIComponent(id)}`, {version: record.version, status: 'running'});
      let result;
      try {
        result = await action({input: record.input, attempt: record.attempt, idempotency_key: record.idempotency_key});
      } catch (error) {
        // After Stop/restart, the operation's owner/version can already have changed. Never overwrite that decision.
        try {
          await send('PUT', `${base}/${encodeURIComponent(id)}`, {
            version: record.version,
            status: 'failed',
            error: {code: 'operation_failed'},
          });
        } catch (checkpointError) {
          if (checkpointError.code !== 'execution_cancelled' && checkpointError.code !== 'conflict')
            throw checkpointError;
        }
        throw error;
      }
      await send('PUT', `${base}/${encodeURIComponent(id)}`, {
        version: record.version,
        status: 'completed',
        result: result ?? null,
      });
      return result ?? null;
    },
  };
}
if (typeof module !== 'undefined') module.exports = {createOperationRunner};
