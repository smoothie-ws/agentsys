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

PAGES.home = async (view, route) => {
  const [projects, runs] = await Promise.all([api('projects'), api('runs', {query: {limit: 200}}), loadPlugins()]);
  const details = await Promise.all(projects.map(p => api(`projects/${p.id}`)));
  if (app.route !== route) return;
  const workflows = details.flatMap(d => d.workflows),
    recent = runs.filter(r => r.started >= Date.now() / 1000 - 86400),
    active = runs.filter(r => ['running', 'waiting'].includes(r.status)),
    bad = recent.filter(r => RUN_BAD.has(r.status)),
    plugTiles = (app.plugins || [])
      .filter(p => p.enabled)
      .flatMap(plugin => plugin.manifest.contributes.tiles.map(tile => ({plugin, tile})));
  view.innerHTML = `<div class="page dashboard">${pageHead({title: 'Dashboard'})}
    <div class="dashboard-metrics">${tile('Projects', projects.length, '/projects')}${tile('Workflows', workflows.length, '/projects')}${tile('Active runs', active.length, '/runs')}${tile('Failures, 24 h', bad.length, '/runs')}</div>
    ${bad.length ? `<p class="dashboard-notice">${plural(bad.length, 'run')} failed or interrupted in the last 24 hours. <a href="/runs" data-link>Review runs</a></p>` : ''}
    <div class="dashboard-columns"><section><div class="section-head"><h2>Projects</h2><a href="/projects" data-link>View all</a></div>
      <ul class="dashboard-projects">${
        details
          .slice(0, 5)
          .map(
            d =>
              `<li><a href="/p/${esc(d.project.id)}" data-link>${icon('folder')}<span>${esc(d.project.name)}</span><small>${plural(d.workflows.length, 'workflow')}</small>${icon('chevron')}</a></li>`
          )
          .join('') || '<li class="muted">No projects yet.</li>'
      }</ul>
    </section><section><div class="section-head"><h2>Recent runs</h2><a href="/runs" data-link>View all</a></div>
      ${
        runs.length
          ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Started</th><th>Status</th><th>Time</th></tr></thead><tbody>${runs
              .slice(0, 5)
              .map(
                r =>
                  `<tr><td>${esc(when(r.started))}</td><td>${statusBadge(r.paused ? 'paused' : r.status)}</td><td>${esc(duration(r.ms))}</td></tr>`
              )
              .join('')}</tbody></table></div>`
          : '<p class="muted">No runs yet.</p>'
      }
    </section></div>
    ${plugTiles.length ? `<section class="dashboard-plugins"><h2>From plugins</h2><div class="plugin-tiles">${plugTiles.map(t => `<div class="plugin-tile" data-plugin-tile="${esc(t.plugin.id)}:${esc(t.tile.id)}"><h3>${esc(t.tile.title)}</h3><div class="plugin-host"></div></div>`).join('')}</div></section>` : ''}
  </div>`;
  const stops = [];
  for (const t of plugTiles) {
    const host = $(`[data-plugin-tile="${t.plugin.id}:${t.tile.id}"] .plugin-host`, view);
    mountPluginFrame(host, t.plugin.id, t.tile.entry, {height: t.tile.height})
      .then(stop => (host.isConnected ? stops.push(stop) : stop()))
      .catch(error => {
        if (host.isConnected) host.textContent = error.message;
      });
  }
  stopPluginFrame = () => stops.forEach(stop => stop());
};
