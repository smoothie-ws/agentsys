'use strict';
const {analyze} = require('./analyze');

exports.activate = async api => {
  const esc = api.ui.escape;
  const inspect = async (project, workflow) => {
    const graph = await api.request('GET', `projects/${project}/workflow`, undefined, {workflow_id: workflow});
    const report = analyze(graph), env = await api.env.info();
    await api.storage.set('report:' + env.id, {project, workflow, report});
    return report;
  };
  const render = async () => {
    const rows = [];
    for (const project of await api.workflows.projects()) {
      const {workflows} = await api.workflows.workflows(project.id);
      for (const workflow of workflows) {
        const report = await inspect(project.id, workflow.id);
        rows.push(`<article class="card"><h3>${esc(project.name)} / ${esc(workflow.name)}</h3><pre>${esc(JSON.stringify(report, null, 2))}</pre></article>`);
      }
    }
    return '<h2>Graph Developer Tools</h2><p>Structure, connections, disconnected nodes and Custom Node references from the public graph API.</p>' + (rows.join('') || '<p>No workflows on this server.</p>');
  };
  await api.commands.register('analyze', async context => {
    if (!context?.project) return api.ui.navigate(api.ui.pageHref('graphs'));
    const report = await inspect(context.project, context.workflow);
    await api.ui.showDialog({title: 'Graph analysis', body: `<pre>${esc(JSON.stringify(report, null, 2))}</pre>`});
    return report;
  }, {title: 'Analyze workflow'});
  await api.commands.register('selection', async context => {
    const env = await api.env.info();
    const value = {selection: context?.selected || context?.selection || context?.ids || [], node: context?.node || null};
    await api.storage.set('selection:' + env.id, value);
    await api.ui.toast('Selection summary saved for this environment.');
    return value;
  }, {title: 'Summarize selection'});
  await api.ui.addPage({id: 'graphs', title: 'Graph Developer Tools', icon: 'code', render});
  await api.ui.addContextMenu({label: 'Summarize selection', command: 'selection'});
  await api.ui.addToolbarButton({id: 'analyze', title: 'Graph Developer Tools', command: 'analyze', icon: 'code'});
  await api.ui.addInspectorSection({id: 'graph-tools', title: 'Graph structure', when: 'any', render: async context => {
    if (!context.project) return '<p>Open a saved workflow to analyze its structure.</p>';
    const report = await inspect(context.project, context.workflow);
    return `<p>Selected: ${esc(context.node?.id || '')}</p><p>${report.nodes} nodes, ${report.edges} connections, ${report.disconnected.length} disconnected.</p><pre>${esc(JSON.stringify(report.errors))}</pre>`;
  }});
};
