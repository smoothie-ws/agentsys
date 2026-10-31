'use strict';
// node examples/durable-process.cjs [data-directory]
// Uses a disposable local server, real isolated Scripts, checked APIs, and the universal checkpoint library.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createServer} = require('../server');
const {createOperationRunner} = require('../sdk/operations');
async function demonstrate(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-durable-demo-'))) {
  let server, base;
  const start = async () => {
    server = createServer({dataDir});
    base = await server.listen(0);
  };
  const request = async (method, route, body = {}, query = {}) => {
    const url = new URL('/api/' + route, base);
    for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {'X-AgentSys': '1', 'Content-Type': 'application/json'},
      ...(!['GET', 'DELETE'].includes(method) ? {body: JSON.stringify(body)} : {}),
    });
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(Error(value.error?.message ?? JSON.stringify(value)), {
        code: value.error?.code,
        status: response.status,
      });
    return value;
  };
  await start();
  try {
    await request('PUT', 'settings', {developer_mode: true});
    const project = await request('POST', 'projects', {name: 'Durable parallel process'}),
      root = `projects/${project.id}/execution`;
    const {types} = await request('GET', `projects/${project.id}/types`);
    const codeType = types.find(type => type.control === 'code')?.id ?? 'd0a0b0c0d0e0f0000000000000000001';
    if (!types.some(type => type.id === codeType))
      await request('PUT', `projects/${project.id}/types`, {
        types: [...types, {id: codeType, name: 'Process code', fields: [], control: 'code'}],
      });
    await request('PUT', `projects/${project.id}/policy`, {allow: ['run.read', 'run.start']});
    const script = await request('POST', `projects/${project.id}/typed-nodes`, {
      node_type: 'custom',
      config: {
        title: 'Independent part',
        op: 'script',
        grants: ['run.start'],
        inputs: [
          {id: 'in', name: 'in', type: 'signal'},
          {
            id: 'script',
            name: 'script',
            type: 't:' + codeType,
            default: `
        await node.sleep(25);
        const id=context.event.payload.id;
        await agentsys('PUT','projects/'+context.project_id+'/execution/scopes/'+id,{
          version:0,value:{result:context.event.payload.value*2,run_id:context.execution.run_id}
        });
      `,
          },
        ],
        outputs: [{id: 'out', name: 'out', type: 'signal'}],
      },
    });
    const options = {project_id: project.id, workflow_id: project.id, parent_id: 'root'};
    let runner = createOperationRunner(request, options);
    await request('POST', root + '/operations', {
      id: 'root',
      input: {parts: ['left', 'right', 'combine']},
      policy: 'safe',
    });
    await request('PUT', root + '/operations/root', {version: 1, status: 'running'});
    const part = async (id, value) =>
      runner.execute(
        id,
        {value},
        async () => {
          const dispatch = await request('POST', root, {node_ids: [script.id], payload: {id, value}, wait: true});
          if (dispatch.dispatch_status !== 'completed') throw Error('Part failed');
          return (await request('GET', root + '/scopes/' + id)).value.result;
        },
        {policy: 'safe'}
      );
    const values = await Promise.all([part('left', 10), part('right', 11)]);
    try {
      await runner.execute(
        'combine',
        {values},
        async () => {
          throw Error('Intentional first attempt');
        },
        {policy: 'safe'}
      );
    } catch (error) {
      if (error.message !== 'Intentional first attempt') throw error;
    }
    await server.close();
    await start(); // all results and history are loaded from the same data folder
    runner = createOperationRunner(request, options);
    const result = await runner.execute(
      'combine',
      {values},
      async ({attempt}) => {
        if (attempt !== 2) throw Error('Expected persisted retry attempt');
        const left = await runner.get('left'),
          right = await runner.get('right');
        return left.result + right.result;
      },
      {policy: 'safe', retry: true}
    );
    const operation = await request('GET', root + '/operations/root');
    // Shutdown cancelled the root checkpoint. Its explicit safe retry does not replay completed parts.
    const pending = await request('POST', root + '/operations/root/retry', {version: operation.version});
    const running = await request('PUT', root + '/operations/root', {version: pending.version, status: 'running'});
    await request('PUT', root + '/operations/root', {version: running.version, status: 'completed', result});
    const dispatches = await request('GET', root + '/dispatches'),
      trace = await request('GET', root + '/trace');
    if (result !== 42 || dispatches.length !== 2 || !trace.events.some(e => e.type === 'dispatch.end'))
      throw Error('Readiness check failed');
    return {
      result,
      dataDir,
      project_id: project.id,
      dispatches: dispatches.length,
      events: trace.events.length,
      operations: await request('GET', root + '/operations'),
    };
  } finally {
    await server.close();
  }
}
if (require.main === module)
  demonstrate(process.argv[2])
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
module.exports = {demonstrate};
