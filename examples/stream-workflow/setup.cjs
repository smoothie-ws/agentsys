// Import and enable the example on a running AgentSys server. No external services.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const packet = JSON.parse(fs.readFileSync(path.join(__dirname, '../stream-workflow.json'), 'utf8'));
async function install(call) {
  const project = await call('POST', 'projects', {name: 'Durable stream'});
  const workflow = await call('POST', `projects/${project.id}/workflows/import`, packet);
  await call('PUT', `projects/${project.id}/policy`, {allow: ['graph.read', 'graph.write']});
  const snapshot = await call('GET', `projects/${project.id}/workflow`, null, {workflow_id: workflow.id});
  const roots = Object.fromEntries(
    ['webhook', 'queue', 'wait'].map(kind => [kind, snapshot.nodes.find(n => n.config?.title === kind + ' entry').id])
  );
  await call('PUT', `workflows/${workflow.id}/queues/jobs`, {limit: 1000, overflow: 'fail', visibility_ms: 30000});
  const webhook = await call('POST', 'triggers', {
    name: 'Stream webhook',
    type: 'webhook',
    overlap: 'queue',
    project_id: project.id,
    workflow_id: workflow.id,
    node_ids: [roots.webhook],
  });
  await call('POST', 'triggers', {
    name: 'Stream consumer',
    type: 'queue',
    queue: 'jobs',
    max_concurrency: 2,
    project_id: project.id,
    workflow_id: workflow.id,
    node_ids: [roots.queue],
  });
  const waiting = await call('POST', `projects/${project.id}/runs`, {
    workflow_id: workflow.id,
    node_ids: [roots.wait],
    wait: 2,
  });
  return {project_id: project.id, workflow_id: workflow.id, webhook_token: webhook.token, waiting_run: waiting.id};
}
module.exports = {install};
if (require.main === module) {
  const base = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  const call = async (method, route, body, query) => {
    const suffix = query ? '?' + new URLSearchParams(query) : '';
    const response = await fetch(base + '/api/' + route + suffix, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-AgentSys': '1',
        ...(process.env.AGENTSYS_TOKEN ? {Authorization: 'Bearer ' + process.env.AGENTSYS_TOKEN} : {}),
      },
      ...(body == null || method === 'GET' ? {} : {body: JSON.stringify(body)}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  install(call)
    .then(info =>
      console.log(
        JSON.stringify(
          {...info, webhook: `${base}/hooks/${info.webhook_token}`, event: `${base}/api/events/stream-answer`},
          null,
          2
        )
      )
    )
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
