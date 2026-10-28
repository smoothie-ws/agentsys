// The dashboard (the page of the logo): what the sidebar holds as counts and links, how the runs are going, what needs attention,
// and the way to the API.
'use strict';

const RUN_BAD = new Set(['failed', 'interrupted']);
const median = list => {
  const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const duration = ms => (ms === null ? '–' : ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms / 60000) + ' min');
const tile = (label, value, sub = '', href = '') =>
  `<${href ? 'a href="' + esc(href) + '" data-link' : 'div'} class="tile"><span class="tile-value">${esc(value)}</span><span class="tile-label">${esc(label)}</span>${sub ? `<span class="tile-sub">${esc(sub)}</span>` : ''}</${href ? 'a' : 'div'}>`;

PAGES.home = async view => {
  const [projects, runs] = await Promise.all([api('projects'), api('runs', {query: {limit: 200}})]);
  const details = await Promise.all(projects.map(p => api(`projects/${p.id}`)));
  await loadLibrary();
  const workflows = details.flatMap(d => d.workflows.map(w => ({...w, project: d.project})));
  const controls = await Promise.all(workflows.map(w => api(`workflows/${w.id}/control`).catch(() => null)));
  if (app.route?.page !== 'home') return;

  const day = Date.now() / 1000 - 86400,
    recent = runs.filter(r => r.started >= day),
    bad = recent.filter(r => RUN_BAD.has(r.status)),
    finished = recent.filter(r => r.status !== 'running' && r.status !== 'waiting'),
    count = status => runs.filter(r => r.status === status).length,
    states = {enabled: 0, paused: 0, disabled: 0};
  for (const c of controls) if (c) states[c.status] = (states[c.status] ?? 0) + 1;
  const stuck = workflows
    .map((w, i) => ({w, c: controls[i]}))
    .filter(({c}) => c && (c.status !== 'enabled' || c.pending.length || c.failures));

  Subnav.mount({
    title: 'Dashboard',
    body: sectionRows('home', [
      ['overview', 'Overview', 'chart'],
      ['workspace', 'Workspace', 'folder'],
      ['attention', 'Needs attention', 'bell'],
      ['recent', 'Recent runs', 'activity'],
      ['api', 'API', 'code'],
    ]),
  });
  view.innerHTML = `<div class="page dashboard">${pageHead({title: 'Dashboard', sub: 'Everything in one place.', actions: '<button id="home-refresh">Refresh</button>'})}
    <section id="home-overview"><h2>Overview</h2><div class="tiles">
      ${tile('Projects', projects.length, '', '/projects')}
      ${tile('Workflows', workflows.length, `${states.enabled} enabled · ${states.paused} paused · ${states.disabled} disabled`, '/runs')}
      ${tile('Library nodes', app.resources.length, plural(app.nodeFolders.length, 'group'), NODES_PATH)}
      ${tile('Runs, last 24 h', recent.length, `${count('running')} running · ${count('waiting')} waiting`, '/runs')}
      ${tile('Failures, last 24 h', bad.length, finished.length ? Math.round((100 * (finished.length - bad.length)) / finished.length) + '% succeeded' : 'no finished runs', '/runs')}
      ${tile('Median run time', duration(median(finished.map(r => r.ms))), 'finished runs, last 24 h')}
    </div></section>
    <section id="home-workspace"><h2>Workspace</h2><div class="cards">
      ${card({href: '/projects', glyph: 'folder', title: 'Projects', preview: cardList(projects.slice(0, 4).map(p => ['folder', p.name])), previewClass: 'card-note', facts: plural(projects.length, 'project') + ' · ' + plural(workflows.length, 'workflow')})}
      ${card({href: '/resources', glyph: 'library', title: 'Library', preview: cardList(app.resources.slice(0, 4).map(r => [resourceIcon(r), r.name])), previewClass: 'card-note', facts: plural(app.resources.length, 'node')})}
      ${card({href: '/runs', glyph: 'activity', title: 'Runs', preview: cardList(runs.slice(0, 4).map(r => ['play', `${r.status} · ${when(r.started)}`])), previewClass: 'card-note', facts: plural(runs.length, 'recent run')})}
      ${card({href: '/settings', glyph: 'settings', title: 'Settings', preview: '<span class="preview-empty">Appearance, shortcuts, run limits</span>', previewClass: 'card-note'})}
    </div></section>
    <section id="home-attention"><h2>Needs attention</h2>${
      stuck.length || bad.length
        ? `<ul class="attention">${stuck
            .map(
              ({w, c}) =>
                `<li><a href="/p/${esc(w.project.id)}/w/${esc(w.id)}" data-link>${esc(w.project.name)} / ${esc(w.name)}</a><span>${esc(c.status !== 'enabled' ? c.status + (c.reason ? ' (' + c.reason + ')' : '') : '')}${c.pending.length ? ` ${plural(c.pending.length, 'queued activation')}` : ''}${c.failures ? ` ${plural(c.failures, 'consecutive failure')}` : ''}</span></li>`
            )
            .join('')}${bad
            .slice(0, 5)
            .map(r => `<li><a href="/runs" data-link>${esc(r.status)} run</a><span>${esc(when(r.started))}</span></li>`)
            .join('')}</ul>`
        : '<p class="muted">Nothing needs attention.</p>'
    }</section>
    <section id="home-recent"><h2>Recent runs</h2>${
      runs.length
        ? `<table><thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Time</th></tr></thead><tbody>${runs
            .slice(0, 8)
            .map(r => `<tr><td>${esc(when(r.started))}</td><td>${esc(r.status)}</td><td>${esc(r.trigger ?? '')}</td><td>${esc(duration(r.ms ?? null))}</td></tr>`)
            .join('')}</tbody></table>`
        : '<p class="muted">No runs yet.</p>'
    }</section>
    <section id="home-api"><h2>API</h2>
      <div class="cards">${card({href: '/api', glyph: 'code', title: 'API reference', preview: '<span class="preview-empty">Every action of the app is an API call</span>', previewClass: 'card-note', facts: plural(Object.keys(Backend.openapi().paths).length, 'path')})}</div></section></div>`;
  $('#home-refresh').onclick = () => render().catch(fail);
  followSections(view, 'home');
};
