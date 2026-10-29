// A compact workspace overview: current activity, recent projects and runs.
'use strict';
const RUN_BAD = new Set(['failed', 'interrupted']);
const duration = ms =>
  ms == null
    ? '-'
    : ms < 1000
      ? ms + ' ms'
      : ms < 60000
        ? (ms / 1000).toFixed(1) + ' s'
        : Math.round(ms / 60000) + ' min';
const tile = (label, value, href) =>
  `<a class="tile" href="${esc(href)}" data-link><span class="tile-label">${esc(label)}</span><strong class="tile-value">${esc(value)}</strong></a>`;

const welcomeHTML = () => `<div class="welcome-panel"><span class="muted small">YOUR FIRST WORKFLOW</span><h2>Turn an idea into a running workflow</h2><p class="muted">Start with a small example: one node starts the workflow, another shows its result. Then make it your own.</p><div class="button-row"><button type="button" class="primary" data-example>Open example</button><button type="button" data-new-project>New project</button></div></div>`;
async function openStarterWorkflow() {
  const start = 'record:' + uid(), result = 'record:' + uid(), doc = emptyDoc();
  doc.nodes = [
    {id: start, kind: 'function', node_type: 'custom', label: 'Start', status: 'ready', config: {
      title: 'Start here', op: 'on_run', inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}]}},
    {id: result, kind: 'function', node_type: 'custom', label: 'Result', status: 'ready', config: {
      title: 'Your first result', op: 'script', inputs: [{id: 'in', name: 'in', type: 'signal'},
        {id: 'script', name: 'script', default: 'node.display("Hello! Your workflow is running.");'}], outputs: []}}
  ];
  doc.layout = {[start]: {x: 0, y: 0}, [result]: {x: 340, y: 0}};
  doc.port_edges = [{id: uid(), source: start, source_port: 'out', target: result, target_port: 'in'}];
  const project = await api('projects/import', {method: 'POST', body: TextGraph.encode({kind: 'project',
    name: 'Getting started', description: 'Choose Run to see a result on the second node.', workflows: [{name: 'Hello workflow', document: doc}]})});
  await loadProjects();
  await go(`/p/${project.id}/w/${project.workflows[0].id}`);
  toast('Choose Run. The second node will show your first result.');
}
function bindWelcome(root) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-new-project], [data-example]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try { await (button.hasAttribute('data-example') ? openStarterWorkflow() : newProjectDialog()); }
    catch (error) { fail(error); }
    finally { button.disabled = false; }
  });
}
PAGES.home = async (view, route) => {
  const [projects, overview] = await Promise.all([api('projects'), api('runs/overview', {query: {limit: 5}}), loadPlugins()]);
  if (app.route !== route) return;
  const plugTiles = (app.plugins || []).filter(p => p.enabled)
    .flatMap(plugin => plugin.manifest.contributes.tiles.map(tile => ({plugin, tile})));
  view.innerHTML = `<div class="page dashboard">${pageHead({title: 'Dashboard', actions: '<span class="live-status muted small" data-live-status role="status">Live</span>'})}
    <p class="storage-context muted small">${DB.mode === 'files' ? 'Server workspace: workflows can continue while this tab is closed.' : 'Browser workspace: keep this tab open while workflows are running.'}</p>
    <div id="dashboard-live"></div>
    ${plugTiles.length ? `<section class="dashboard-plugins"><h2>From plugins</h2><div class="plugin-tiles">${plugTiles.map(t => `<div class="plugin-tile" data-plugin-tile="${esc(t.plugin.id)}:${esc(t.tile.id)}"><h3>${esc(t.tile.title)}</h3><div class="plugin-host"></div></div>`).join('')}</div></section>` : ''}
  </div>`;
  const region = $('#dashboard-live', view);
  bindWelcome(region);
  let signature = '';
  const drawOverview = (projects, data) => {
    const {metrics, items: runs} = data, names = new Map(data.workflows.map(w => [w.id, w.name]));
    const html = `<div class="dashboard-metrics">${tile('Projects', metrics.projects, '/projects')}${tile('Workflows', metrics.workflows, '/projects')}${tile('Active runs', metrics.active, '/runs?status=active')}${tile('Failures, 24 h', metrics.failed_24h, '/runs?status=attention&period=86400')}</div>
      ${!projects.length ? welcomeHTML() : ''}
      ${metrics.failed_24h ? `<p class="dashboard-notice">${plural(metrics.failed_24h, 'run')} failed or was interrupted in the last 24 hours. <a href="/runs?status=attention&period=86400" data-link>Review runs</a></p>` : ''}
      <div class="dashboard-columns"><section><div class="section-head"><h2>Projects</h2><a href="/projects" data-link>View all</a></div>
      <ul class="dashboard-projects">${projects.slice(0,5).map(d=>`<li><a href="/p/${esc(d.id)}" data-link>${icon('folder')}<span>${esc(d.name)}</span><small>${plural(d.workflow_count,'workflow')}</small>${icon('chevron')}</a></li>`).join('') || '<li class="muted">Your projects will appear here.</li>'}</ul></section>
      <section><div class="section-head"><h2>Recent runs</h2><a href="/runs" data-link>View all</a></div>${runs.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Workflow / started</th><th>Status</th><th>Time</th></tr></thead><tbody>${runs.map(r=>`<tr><td><a href="/p/${esc(r.project_id)}/w/${esc(r.workflow_id)}" data-link>${esc(names.get(r.workflow_id) || 'Workflow')}</a><small class="run-started">${esc(when(r.started))}</small></td><td>${statusBadge(r.paused?'paused':r.status)}</td><td>${esc(duration(r.ms))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No runs yet. Start a workflow to see its progress here.</p>'}</section></div>`;
    if (signature !== html) {
      const focused = document.activeElement;
      // Do not replace an action while it is creating a project.
      if (region.contains(focused) && focused.matches('button:disabled')) return;
      const href = region.contains(focused) ? focused.getAttribute('href') : null;
      region.innerHTML = html; signature = html;
      if (href) $$('a', region).find(a => a.getAttribute('href') === href)?.focus({preventScroll: true});
    }
  };
  drawOverview(projects, overview);
  livePage(route, async () => {
    const [projects, data] = await Promise.all([api('projects'), api('runs/overview', {query: {limit: 5}})]);
    if (app.route === route) drawOverview(projects, data);
  });
  const stops = [];
  for (const t of plugTiles) {
    const host = $(`[data-plugin-tile="${t.plugin.id}:${t.tile.id}"] .plugin-host`, view);
    mountPluginFrame(host, t.plugin.id, t.tile.entry, {height: t.tile.height})
      .then(stop => (host.isConnected ? stops.push(stop) : stop()))
      .catch(error => {if (host.isConnected) host.textContent = error.message;});
  }
  stopPluginFrame = () => stops.forEach(stop => stop());
};
