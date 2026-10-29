'use strict';

// Runs: durable runs (resume, cancel, replay, trace), version history and run settings.
let runsPageRevision = 0;
PAGES.runs = async (view, route) => {
  const revision = ++runsPageRevision;
  const current = () => revision === runsPageRevision && app.route === route;
  const saved = Tabs.stateOf()?.runFilters ?? {};
  const params = routeQuery(), linked = params.has('status') || params.has('workflow_id') || params.has('period');
  const filters = {
    status: params.get('status') ?? (linked ? '' : saved.status ?? ''),
    workflow_id: params.get('workflow_id') ?? (linked ? '' : saved.workflow_id ?? ''),
    period: params.get('period') ?? (linked ? '' : saved.period ?? ''),
  };
  let cursor = null, previous = [], next = null, queryRevision = 0;
  const query = () => ({status: filters.status, workflow_id: filters.workflow_id,
    since: filters.period ? Math.floor(Date.now()/1000)-Number(filters.period) : 0, cursor, limit: 50,
    controls: selectedPanel('runs') === 'workflows' ? '1' : undefined});
  const [overview, {limits}] = await Promise.all([api('runs/overview', {query: {...query(), controls: '1'}}), api('settings')]);
  if (!current()) return;
  let runs = overview.items;
  const workflowItems = overview.workflows;
  const controls = workflowItems.map(w => w.control);
  const workflowForm = (w, c) => `<form class="workflow-policy" data-workflow-control="${esc(w.id)}">
    <div class="workflow-policy-head"><div><h3>${esc(w.name)}</h3><p class="muted small" data-workflow-counts>${plural(c.pending.length, 'queued activation')} &middot; ${plural(c.failures, 'consecutive failure')}</p></div><span data-workflow-status>${statusBadge(c.status)}${c.reason ? `<small class="muted"> ${esc(c.reason)}</small>` : ''}</span><div class="button-row"><button type="button" data-workflow-status-action="${c.status === 'enabled' ? 'paused' : 'enabled'}">${c.status === 'enabled' ? 'Pause' : 'Enable'}</button><button type="button" data-workflow-status-action="disabled" ${c.status === 'disabled' ? 'disabled' : ''}>Disable</button></div></div>
    <details class="workflow-policy-details"><summary>Retry policy and diagnostics</summary><div class="grid2">${[
      ['max_attempts', 'Attempts', c.max_attempts],
      ['backoff_ms', 'Retry delay (ms)', c.backoff_ms],
      ['pause_after', 'Pause after failures', c.pause_after],
      ['dedupe_ms', 'Dedupe window (ms)', c.dedupe_ms],
      ['pending_limit', 'Queue limit', c.pending_limit],
    ]
      .map(([name, label, value]) => field(label, `<input name="${name}" type="number" min="1" value="${value}">`))
      .join('')}</div>
    ${field('Bridge quotas (JSON)', `<textarea name="quotas" rows="3">${esc(pretty(c.quotas))}</textarea>`)}
    <div class="button-row"><button type="submit">Save policy</button><button type="button" data-workflow-inspect>State, queues and usage</button></div><pre data-workflow-data hidden></pre></details></form>`;
  view.innerHTML = `<div class="page runs-page">${pageHead({title: 'Runs', actions: '<span class="live-status muted small" data-live-status role="status">Live</span>'})}
    <section id="runs-runs"><div class="section-head"><div><h2>Activations</h2><p class="muted small">Follow each execution, inspect its result or continue a waiting run.</p></div></div>
    <div class="run-filters">
      <label class="field"><span>Status</span><select id="runs-filter"><option value="">All statuses</option>${['active','attention','running','waiting','completed','failed','interrupted','cancelled'].map(s=>`<option value="${s}">${s==='active'?'Active':s==='attention'?'Needs attention':s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select></label>
      <label class="field"><span>Workflow</span><select id="runs-workflow-filter"><option value="">All workflows</option>${workflowItems.map(w=>`<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Started</span><select id="runs-period"><option value="">All retained history</option><option value="86400">Last 24 hours</option><option value="604800">Last 7 days</option><option value="2592000">Last 30 days</option></select></label>
      <button id="runs-clear" class="ghost" type="button">Clear filters</button>
    </div>
    <div id="run-list"></div><div class="run-pagination"><span data-run-count class="muted small" aria-live="polite"></span><div class="button-row"><button id="runs-previous" type="button">Previous</button><button id="runs-next" type="button">Next</button></div></div>
    <div id="runs-detail-header" hidden></div><div id="runs-intervention" hidden></div><div id="runs-nodes" class="table-scroll" hidden></div><details id="runs-trace-panel" hidden><summary>Raw trace</summary><pre id="runs-trace"></pre></details></section>
    <section id="runs-workflows"><h2>Workflows</h2><div class="workflow-policies">${workflowItems.map((w, i) => workflowForm(w, controls[i])).join('') || '<p class="muted">No workflows yet.</p>'}</div></section>
    <section id="runs-versions"><h2>Versions</h2>${field('Workflow', '<select id="version-workflow"><option value="">Select a workflow</option></select>')}<div id="runs-history"></div><pre id="runs-diff"></pre></section>
    <section id="runs-settings"><h2>Run limits</h2><p class="muted">Leave a field empty to use its default.</p><form id="runs-settings-form"><div class="grid2">${Object.entries(
      limits
    )
      .map(([key, l]) =>
        field(
          `${l.label} (${l.unit})`,
          `<input name="${esc(key)}" type="number" min="1" step="1" placeholder="${esc(l.default)}" value="${esc(app.preferences[key] ?? '')}">`
        )
      )
      .join('')}</div><button>Save limits</button></form></section></div>`;
  showSectionPanel($('.runs-page', view), 'runs');
  const filter = $('#runs-filter'), workflowFilter = $('#runs-workflow-filter'), period = $('#runs-period');
  filter.value = filters.status; workflowFilter.value = filters.workflow_id; period.value = filters.period;
  if (filter.selectedIndex < 0) filters.status = filter.value = '';
  if (workflowFilter.selectedIndex < 0) filters.workflow_id = workflowFilter.value = '';
  const paintControl = (form, state) => {
    $('[data-workflow-status]', form).innerHTML = statusBadge(state.status) +
      (state.reason ? `<small class="muted"> ${esc(state.reason)}</small>` : '');
    $('[data-workflow-counts]', form).textContent = `${plural(state.pending.length, 'queued activation')} / ${plural(state.failures, 'consecutive failure')}`;
    const toggle = $('[data-workflow-status-action]', form);
    toggle.dataset.workflowStatusAction = state.status === 'enabled' ? 'paused' : 'enabled';
    toggle.textContent = state.status === 'enabled' ? 'Pause' : 'Enable';
    $('[data-workflow-status-action="disabled"]', form).disabled = state.status === 'disabled';
  };
  let listSignature = '';
  const drawRuns = result => {
    runs = result.items; next = result.next_cursor;
    for (const workflow of result.workflows) {
      const form = $(`[data-workflow-control="${CSS.escape(workflow.id)}"]`, view);
      if (form && workflow.control && !form.dataset.changingStatus) paintControl(form, workflow.control);
    }
    if (document.activeElement !== workflowFilter) {
      const options = '<option value="">All workflows</option>' + result.workflows.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');
      if (workflowFilter.innerHTML !== options && (!filters.workflow_id || result.workflows.some(w => w.id === filters.workflow_id))) {
        workflowFilter.innerHTML = options; workflowFilter.value = filters.workflow_id;
      }
    }
    const names = new Map(result.workflows.map(w => [w.id, w.name]));
    const html = runs.length ? `<div class="table-scroll"><table class="data-table runs-table"><thead><tr><th>Workflow / started</th><th>Status</th><th>Waiting for / duration</th><th>Actions</th></tr></thead><tbody>${runs.map(r => `<tr data-run="${esc(r.id)}" data-status="${esc(r.status)}"><td><a href="/p/${esc(r.project_id)}/w/${esc(r.workflow_id)}" data-link><strong>${esc(names.get(r.workflow_id) || 'Workflow')}</strong></a><small>${esc(when(r.started))} &middot; attempt ${r.attempt ?? 1}</small></td><td>${statusBadge(r.paused ? 'paused' : r.status)}</td><td>${esc((r.waits ?? []).map(w => w.wait_spec?.event ?? (w.due ? new Date(w.due).toLocaleString() : '')).join(', ') || duration(r.ms))}</td><td><div class="button-row">${['waiting','interrupted'].includes(r.status) ? '<button data-run-action="resume">Resume</button><button data-run-action="cancel">Cancel</button>' : r.status === 'running' ? `<button data-run-action="${r.paused?'resume':'pause'}">${r.paused?'Resume':'Pause'}</button><button data-run-action="cancel">Cancel</button>` : r.replay_available ? '<button data-run-action="replay">Replay</button>' : ''}${r.details_available === false ? '<span class="muted small">Details expired</span>' : '<button data-run-action="trace">Trace</button>'}</div></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty runs-empty"><h3>${result.total ? 'No more runs on this page' : filters.status || filters.workflow_id || filters.period ? 'No matching runs' : 'No runs yet'}</h3><p class="muted">${filters.status || filters.workflow_id || filters.period ? 'Try another workflow, status or time range.' : 'Open a workflow and choose Run. Its progress and results will appear here automatically.'}</p><a href="/projects" data-link class="button">Open projects</a></div>`;
    if (html !== listSignature) {
      const focused = document.activeElement, id = focused?.closest('[data-run]')?.dataset.run, action = focused?.dataset.runAction;
      $('#run-list').innerHTML = html; listSignature = html;
      if (id && action) $(`[data-run="${CSS.escape(id)}"] [data-run-action="${action}"]`, view)?.focus({preventScroll: true});
    }
    $('[data-run-count]', view).textContent = `${runs.length} shown / ${result.total} matching runs`;
    $('#runs-previous').disabled = !previous.length; $('#runs-next').disabled = !next;
    $('.run-pagination', view).hidden = !result.total && !previous.length;
  };
  const updateRuns = async () => {
    const request = ++queryRevision, result = await api('runs/overview', {query: query()});
    if (current() && request === queryRevision) drawRuns(result);
  };
  const applyFilters = () => {
    Object.assign(filters, {status: filter.value, workflow_id: workflowFilter.value, period: period.value});
    cursor = null; previous = [];
    const state = Tabs.stateOf(); if (state) {state.runFilters = {...filters}; Tabs.save();}
    const search = routeQuery();
    for (const [key, value] of Object.entries(filters)) value ? search.set(key, value) : search.delete(key);
    history.replaceState({}, '', urlOf('/runs' + (search.size ? '?' + search : '')));
    app.currentURL = routeURL();
    updateRuns().catch(fail);
  };
  filter.onchange = workflowFilter.onchange = period.onchange = applyFilters;
  $('#runs-clear').onclick = () => {filter.value = workflowFilter.value = period.value = ''; applyFilters();};
  $('#runs-next').onclick = () => {if (next) {previous.push(cursor); cursor = next; updateRuns().catch(fail);}};
  $('#runs-previous').onclick = () => {if (previous.length) {cursor = previous.pop(); updateRuns().catch(fail);}};
  drawRuns(overview);
  livePage(route, updateRuns);
  for (const form of $$('[data-workflow-control]', view)) {
    const id = form.dataset.workflowControl;
    for (const button of $$('[data-workflow-status-action]', form))
      button.onclick = async () => {
        if (form.dataset.changingStatus) return;
        form.dataset.changingStatus = '1';
        for (const action of $$('[data-workflow-status-action]', form)) action.disabled = true;
        try {
          const state = await api(`workflows/${id}/control`, {
            method: 'PUT',
            body: {status: button.dataset.workflowStatusAction},
          });
          paintControl(form, state);
        } catch (error) {
          fail(error);
        } finally {
          delete form.dataset.changingStatus;
          $('[data-workflow-status-action]', form).disabled = false;
          $('[data-workflow-status-action="disabled"]', form).disabled = $('[data-workflow-status] [data-status]', form)?.dataset.status === 'disabled';
        }
      };
    pageAutosave(form, () => ({
      max_attempts: Number(form.max_attempts.value), backoff_ms: Number(form.backoff_ms.value),
      pause_after: Number(form.pause_after.value), dedupe_ms: Number(form.dedupe_ms.value),
      pending_limit: Number(form.pending_limit.value), quotas: JSON.parse(form.quotas.value),
    }), body => api(`workflows/${id}/control`, {method: 'PUT', body}));
    $('[data-workflow-inspect]', form).onclick = async () => {
      try {
        const [state, queues, usage] = await Promise.all(
          ['state', 'queues', 'usage'].map(path => api(`workflows/${id}/${path}`))
        );
        const out = $('[data-workflow-data]', form);
        out.hidden = false;
        out.textContent = pretty({state, queues, usage});
      } catch (error) {
        fail(error);
      }
    };
  }

  const limitsForm = $('#runs-settings-form');
  pageAutosave(limitsForm, () => Object.fromEntries(Object.keys(limits).map(key =>
    [key, limitsForm[key].value === '' ? limits[key].default : Number(limitsForm[key].value)])),
    async body => { app.preferences = await api('settings', {method: 'PUT', body}); });
  let traceRequest = 0;
  const showTrace = async id => {
    const request = ++traceRequest;
    const [detail, events] = await Promise.all([api('runs/' + id), api('runs/' + id + '/events')]);
    if (!current() || request !== traceRequest) return;
    const header = $('#runs-detail-header');
    header.hidden = false;
    header.innerHTML = `<div class="section-head"><h3>Run details ${statusBadge(detail.paused ? 'paused' : detail.status)}</h3><button type="button" class="icon" aria-label="Close run details">${icon('x')}</button></div><p class="muted small">${esc(when(detail.started))} &middot; ${esc(id.slice(0,12))}</p>`;
    $('button', header).onclick = () => {
      ++traceRequest;
      for (const selector of ['#runs-detail-header','#runs-intervention','#runs-nodes','#runs-trace-panel']) $(selector).hidden = true;
    };
    const out = $('#runs-trace');
    $('#runs-trace-panel').hidden = false;
    out.textContent = pretty({run: detail, events: events.events});
    const panel = $('#runs-intervention');
    panel.hidden = false;
    mountRunIntervention(panel, detail, async nextId => {
      if (!current() || request !== traceRequest) return;
      await updateRuns();
      if (current()) await showTrace(nextId);
    });
    const nodes = $('#runs-nodes');
    nodes.hidden = false;
    nodes.innerHTML =
      '<table><thead><tr><th>Node</th><th>Status</th><th>Version at start</th></tr></thead><tbody>' +
      (detail.nodes ?? [])
        .map(
          n =>
            `<tr><td>${esc(n.label || n.node_id)}</td><td title="${esc(n.error || '')}">${esc(n.status)}</td><td><code title="${esc(n.node_version || '')}">${esc(n.node_version?.slice(0, 12) || '?')}</code></td></tr>`
        )
        .join('') +
      '</tbody></table>';

  };

  $('#run-list').onclick = async event => {
      const button = event.target.closest('[data-run-action]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        const id = button.closest('[data-run]').dataset.run,
          action = button.dataset.runAction;
        if (action === 'trace' || (action === 'resume' && runs.find(r => r.id === id)?.status !== 'running')) {
          await showTrace(id);
          return;
        }
        await api(`runs/${id}/${action}`, {method: 'POST', body: action === 'replay' ? {wait: 5} : {}});
        await updateRuns();
      } catch (error) {
        fail(error);
      } finally { button.disabled = false; }
    };
  const select = $('#version-workflow'), entries = workflowItems;
  select.innerHTML += [
    ...entries.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`),
    ...app.resources.map(r => `<option value="node:${esc(r.id)}">Node / ${esc(r.name)}</option>`),
  ].join('');
  let versionRequest = 0;
  select.onchange = async () => {
    const request = ++versionRequest;
    $('#runs-history').replaceChildren(); $('#runs-diff').textContent = '';
    try {
      const node = select.value.startsWith('node:'),
        id = node ? select.value.slice(5) : select.value,
        kind = node ? 'node' : 'workflow';
      if (!id) return;
      const history = await api(`versions/${kind}/${id}`),
        head = await api(`versions/${kind}/${id}/${history.current}`);
      if (!current() || request !== versionRequest) return;
      $('#runs-history').innerHTML = history.entries
        .slice()
        .reverse()
        .map(
          v =>
            `<div class="button-row"><code>${esc(v.hash.slice(0, 12))}</code><span>${esc(new Date(v.at).toLocaleString())}</span><button data-diff="${esc(v.hash)}">Diff</button><button data-restore="${esc(v.hash)}">Restore</button></div>`
        )
        .join('');
      for (const b of $$('[data-diff]'))
        b.onclick = async () => {
          try {
            const previous = await api(`versions/${kind}/${id}/${b.dataset.diff}`);
            if (!current() || request !== versionRequest) return;
            const changes = [];
            for (const file of new Set([...Object.keys(head.files), ...Object.keys(previous.files)]))
              if (head.files[file] !== previous.files[file])
                changes.push(
                  `--- ${file} (selected)\n${previous.files[file] ?? ''}\n+++ ${file} (current)\n${head.files[file] ?? ''}`
                );
            $('#runs-diff').textContent = changes.join('\n') || 'Identical content';
          } catch (e) {
            fail(e);
          }
        };
      for (const b of $$('[data-restore]'))
        b.onclick = async () => {
          try {
            await api(`versions/${kind}/${id}/${b.dataset.restore}/restore`, {method: 'POST'});
            if (current() && request === versionRequest) await select.onchange();
          } catch (e) {
            fail(e);
          }
        };
    } catch (error) {
      if (!current() || request !== versionRequest) return;
      $('#runs-history').innerHTML = `<p class="muted">${esc(error.status === 404 ? 'No saved versions yet. Edit this workflow to create its first version.' : error.message)}</p>`;
    }
  };
};
