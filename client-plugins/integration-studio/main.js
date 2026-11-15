'use strict';

exports.activate = async api => {
  const esc = api.ui.escape;
  const configs = 'integration-connections', results = 'integration-results';
  const list = () => api.collections.records(configs, {limit: 100});
  const endpoint = data => {
    const url = new URL(data.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP endpoint without credentials.');
    for (const [key, value] of Object.entries(data.parameters || {})) url.searchParams.set(key, String(value));
    return url.href;
  };
  const render = async () => {
    try {
      const connections = await list(), saved = await api.collections.records(results, {limit: 10});
      return `<h2>Integration Studio</h2><p>Connections and results belong to the active server. Secret values stay on that server.</p>
        <button data-command="edit">New connection</button><button data-command="build">Build workflow</button>
        ${connections.records.map(r => `<article class="card"><h3>${esc(r.data.name)}</h3><p>${esc(r.data.endpoint)}</p><p>${esc(r.data.status || 'Not checked')}</p>
          <button data-command="edit" data-args='${esc(JSON.stringify([r.id]))}'>Edit</button>
          <button data-command="check" data-args='${esc(JSON.stringify([r.id]))}'>Check connection</button></article>`).join('') || '<p>No connections. Deploy the package resources, then add a connection.</p>'}
        <h3>Recent results</h3><pre>${esc(JSON.stringify(saved.records.map(r => r.data), null, 2))}</pre>`;
    } catch (error) { return `<h2>Integration Studio</h2><p class="form-error">${esc(error.message)}</p><p>Deploy resources on this server from Plugins before adding connections.</p>`; }
  };
  await api.commands.register('edit', async id => {
    const record = (await list()).records.find(r => r.id === id), data = record?.data || {};
    return api.ui.showDialog({title: 'HTTP connection', body: `<input name="id" type="hidden" value="${esc(record?.id || '')}"><input name="version" type="hidden" value="${esc(record?.version || '')}">
      ${[['name', data.name || 'Local status'], ['endpoint', data.endpoint || 'http://127.0.0.1:8791/status'], ['parameters', JSON.stringify(data.parameters || {})], ['secretName', data.secretName || '']].map(([name, value]) => `<label class="field"><span>${esc(name)}</span><input name="${name}" value="${esc(value)}"></label>`).join('')}
      <label class="field"><span>Authorization</span><select name="auth"><option value="none" ${data.auth !== 'bearer' ? 'selected' : ''}>None</option><option value="bearer" ${data.auth === 'bearer' ? 'selected' : ''}>Server bearer secret</option></select></label>`,
      actions: [{label: 'Save', command: 'save', variant: 'primary'}]});
  }, {title: 'Edit HTTP connection'});
  await api.commands.register('save', async values => {
    const data = {name: String(values.name || '').trim(), endpoint: String(values.endpoint || ''), parameters: JSON.parse(values.parameters || '{}'), auth: values.auth || 'none', secretName: String(values.secretName || ''), status: 'Not checked'};
    if (!data.name || !data.parameters || Array.isArray(data.parameters) || typeof data.parameters !== 'object') throw Error('Enter a name and a JSON parameter object.');
    endpoint(data);
    if (data.auth === 'bearer' && !/^[A-Za-z0-9_-]+$/.test(data.secretName)) throw Error('Enter a server secret name.');
    const existing = (await list()).records.find(r => r.id === values.id);
    if (values.id && !existing) throw Error('The connection no longer exists. Reload the list before saving.');
    if (existing && (!Number.isInteger(Number(values.version)) || Number(values.version) < 1)) throw Error('Reopen the connection before saving an edit.');
    const record = existing ? await api.collections.update(configs, existing.id, data, Number(values.version)) : await api.collections.create(configs, data);
    await api.ui.refresh();
    return record;
  }, {title: 'Save connection'});
  await api.commands.register('check', async id => {
    const record = (await list()).records.find(r => r.id === id);
    if (!record) throw Error('Choose a connection.');
    let status;
    try {
      const answer = await api.net.fetch({url: endpoint(record.data), timeout: 5000, headers: record.data.auth === 'bearer' ? {Authorization: 'Bearer {{secret:' + record.data.secretName + '}}'} : {}});
      status = 'HTTP ' + answer.status;
    } catch (error) { status = error.message; }
    await api.collections.update(configs, record.id, {...record.data, status}, record.version);
    await api.ui.refresh();
    return status;
  }, {title: 'Check connection'});
  await api.commands.register('build', async () => {
    const records = await list();
    if (!records.total) throw Error('Create a connection first. The workflow uses the first connection.');
    const env = await api.env.info(), key = 'workflow:' + env.id;
    const previous = await api.storage.get(key);
    let existingGraph = null;
    if (previous) {
      try {
        existingGraph = await api.request('GET', `projects/${previous.project}/workflow`, undefined, {workflow_id: previous.workflow});
        if (previous.complete !== false) return previous;
      }
      catch (error) { if (!/not found/i.test(error.message)) throw error; }
    }
    const resources = await api.library.list();
    const names = ['Read Configuration', 'HTTP Request', 'JSON Parse', 'Response Transform', 'Store Result', 'Display Result'];
    const nodes = names.map(name => {
      const resource = resources.find(r => r.name === 'Integration: ' + name && r.payload?.plugin?.id === api.id);
      if (!resource) throw Error('Deploy Integration Studio resources first.');
      return resource;
    });
    const project = existingGraph ? {id: previous.project} : await api.workflows.createProject('Integration Studio');
    const workflow = existingGraph ? {id: previous.workflow} : await api.workflows.createWorkflow(project.id, 'Fetch and store');
    await api.storage.set(key, {project: project.id, workflow: workflow.id, complete: false});
    const query = {workflow_id: workflow.id}, path = `projects/${project.id}`;
    const ids = [];
    for (let i = 0; i < nodes.length; i++) {
      const existing = existingGraph?.complex.find(node => node.source?.resource_id === nodes[i].id);
      if (existing) { ids.push('complex:' + existing.id); continue; }
      const placed = await api.workflows.placeNode(project.id, workflow.id, nodes[i].id, {x: i * 360, y: 0});
      ids.push('complex:' + placed.roots[0]);
    }
    const event = existingGraph?.nodes.find(node => node.config?.op === 'on_run') ||
      await api.request('POST', path + '/primitives', {primitive: 'event', point: {x: -360, y: 0}}, query);
    const add = [{source: event.id, source_port: 'out', target: ids[0], target_port: 'in'}];
    for (let i = 1; i < ids.length; i++) {
      add.push({source: ids[i - 1], source_port: 'out', target: ids[i], target_port: 'in'});
      add.push({source: ids[i - 1], source_port: 'value', target: ids[i], target_port: 'value'});
    }
    const missing = add.filter(edge => !existingGraph?.edges.some(saved =>
      ['source', 'source_port', 'target', 'target_port'].every(key => edge[key] === saved[key])));
    if (missing.length) await api.request('POST', path + '/port-connections', {add: missing}, query);
    const info = {project: project.id, workflow: workflow.id};
    await api.storage.set(key, info);
    return info;
  }, {title: 'Build integration workflow'});
  await api.ui.addPage({id: 'connections', title: 'Integration Studio', icon: 'globe', render});
  await api.ui.addSettingsSection({id: 'integration', title: 'Integration Studio', render: () => '<p>Network hosts and secret names are granted in the package manifest. Runtime execution also requires an explicit project policy. Removing the plugin preserves server data.</p>'});
  await api.ui.addInspectorSection({id: 'integration', title: 'Integration', when: 'any', render: context => `<p>Selected: ${esc(context.node?.id || '')}. Saved integration nodes execute on the server.</p>`});
};
