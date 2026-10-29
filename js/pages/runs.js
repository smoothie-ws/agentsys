'use strict';

// Runs: durable runs (resume, cancel, replay, trace), version history, workspace permission policy and run settings.
let runsPageRevision = 0;
PAGES.runs = async view => {
  const revision = ++runsPageRevision;
  const current = () => revision === runsPageRevision && app.route?.page === 'runs';
  const [runs, projects, {limits}] = await Promise.all([api('runs'), api('projects'), api('settings')]);
  if (!current()) return;
  const workflowProjects = await Promise.all(projects.map(p => api('projects/' + p.id)));
  if (!current()) return;
  const workflowItems = workflowProjects.flatMap(p =>
    p.workflows.map(w => ({...w, name: p.project.name + ' / ' + w.name}))
  );
  const controls = await Promise.all(workflowItems.map(w => api(`workflows/${w.id}/control`)));
  if (!current()) return;
  const workflowForm = (w, c) => `<form class="workflow-policy" data-workflow-control="${esc(w.id)}">
    <div class="workflow-policy-head"><div><h3>${esc(w.name)}</h3><p class="muted small">${plural(c.pending.length, 'queued activation')} &middot; ${plural(c.failures, 'consecutive failure')}</p></div><span data-workflow-status>${statusBadge(c.status)}${c.reason ? `<small class="muted"> ${esc(c.reason)}</small>` : ''}</span><div class="button-row"><button type="button" data-workflow-status-action="${c.status === 'enabled' ? 'paused' : 'enabled'}">${c.status === 'enabled' ? 'Pause' : 'Enable'}</button><button type="button" data-workflow-status-action="disabled" ${c.status === 'disabled' ? 'disabled' : ''}>Disable</button></div></div>
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
  view.innerHTML = `<div class="page runs-page">${pageHead({title: 'Runs'})}
    <section id="runs-runs"><div class="section-head"><h2>Activations <small class="muted" data-run-count>${runs.length}</small></h2><label class="runs-filter"><span>Status</span><select id="runs-filter"><option value="">All statuses</option>${[
      ...new Set(runs.map(r => r.status)),
    ]
      .sort()
      .map(status => `<option value="${esc(status)}">${esc(status)}</option>`)
      .join('')}</select></label></div>
    ${runs.length ? `<div class="table-scroll"><table class="data-table runs-table"><thead><tr><th>Workflow / started</th><th>Status</th><th>Waiting for</th><th>Actions</th></tr></thead><tbody>${runs.map(r => `<tr data-run="${esc(r.id)}" data-status="${esc(r.status)}"><td><strong>${esc(workflowItems.find(w => w.id === r.workflow_id)?.name || 'Workflow')}</strong><small>${esc(when(r.started))} &middot; attempt ${r.attempt ?? 1}</small></td><td>${statusBadge(r.paused ? 'paused' : r.status)}</td><td>${esc((r.waits ?? []).map(w => w.wait_spec.event ?? (w.due ? new Date(w.due).toLocaleString() : '')).join(', ') || '-')}</td><td><div class="button-row">${['waiting', 'interrupted'].includes(r.status) ? '<button data-run-action="resume">Resume</button><button data-run-action="cancel">Cancel</button>' : r.status === 'running' ? `<button data-run-action="${r.paused ? 'resume' : 'pause'}">${r.paused ? 'Resume' : 'Pause'}</button><button data-run-action="cancel">Cancel</button>` : '<button data-run-action="replay">Replay</button>'}<button data-run-action="trace">Trace</button></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted runs-empty">No runs yet.</p>'}
    <p id="runs-filter-empty" class="muted" hidden>No runs match this status.</p><div id="runs-intervention" hidden></div><div id="runs-nodes" class="table-scroll" hidden></div><details id="runs-trace-panel" hidden><summary>Raw trace</summary><pre id="runs-trace"></pre></details></section>
    <section id="runs-workflows"><h2>Workflows</h2><div class="workflow-policies">${workflowItems.map((w, i) => workflowForm(w, controls[i])).join('') || '<p class="muted">No workflows yet.</p>'}</div></section>
    <section id="runs-versions"><h2>Versions</h2>${field('Workflow', '<select id="version-workflow"><option value="">Select a workflow</option></select>')}<div id="runs-history"></div><pre id="runs-diff"></pre></section>
    <section id="runs-permissions"><h2>Permissions</h2><form id="runs-policy" class="runs-form">${field('Workspace', `<select name="project_id">${projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`)}${field('Allowed capabilities (comma separated)', '<textarea name="allow" rows="3"></textarea>')}<button ${projects.length ? '' : 'disabled'}>Save policy</button></form></section>
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
  showSectionPanel($('.runs-page', view));
  const filter = $('#runs-filter');
  filter.value = Tabs.stateOf()?.runsFilter ?? '';
  if (filter.selectedIndex < 0) filter.value = '';
  filter.onchange = () => {
    let visible = 0;
    for (const row of $$('[data-run]', view)) {
      row.hidden = !!filter.value && row.dataset.status !== filter.value;
      if (!row.hidden) visible++;
    }
    $('[data-run-count]', view).textContent = String(visible);
    $('#runs-filter-empty').hidden = !runs.length || visible > 0;
    const state = Tabs.stateOf();
    if (state) {
      state.runsFilter = filter.value;
      Tabs.save();
    }
  };
  filter.onchange();
  for (const form of $$('[data-workflow-control]', view)) {
    const id = form.dataset.workflowControl;
    for (const button of $$('[data-workflow-status-action]', form))
      button.onclick = async () => {
        try {
          const state = await api(`workflows/${id}/control`, {
            method: 'PUT',
            body: {status: button.dataset.workflowStatusAction},
          });
          $('[data-workflow-status]', form).innerHTML =
            statusBadge(state.status) + (state.reason ? `<small class="muted"> ${esc(state.reason)}</small>` : '');
          const toggle = $('[data-workflow-status-action]', form);
          toggle.dataset.workflowStatusAction = state.status === 'enabled' ? 'paused' : 'enabled';
          toggle.textContent = state.status === 'enabled' ? 'Pause' : 'Enable';
          $('[data-workflow-status-action="disabled"]', form).disabled = state.status === 'disabled';
        } catch (error) {
          fail(error);
        }
      };
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api(`workflows/${id}/control`, {
          method: 'PUT',
          body: {
            max_attempts: Number(form.max_attempts.value),
            backoff_ms: Number(form.backoff_ms.value),
            pause_after: Number(form.pause_after.value),
            dedupe_ms: Number(form.dedupe_ms.value),
            pending_limit: Number(form.pending_limit.value),
            quotas: JSON.parse(form.quotas.value),
          },
        });
        toast('Workflow policy saved.');
      } catch (error) {
        fail(error);
      }
    };
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

  $('#runs-settings-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      // A cleared field is a default again: the limit is stored only when it differs from the default.
      const body = Object.fromEntries(
        Object.keys(limits).map(key => [key, form[key].value === '' ? limits[key].default : Number(form[key].value)])
      );
      app.preferences = await api('settings', {method: 'PUT', body});
      toast('Run limits saved.');
    } catch (error) {
      fail(error);
    }
  };
  const policy = $('#runs-policy');
  policy.project_id.onchange = async () => {
    try {
      policy.allow.value = (await api(`projects/${policy.project_id.value}/policy`)).allow.join(', ');
    } catch (e) {
      fail(e);
    }
  };
  if (projects.length) await policy.project_id.onchange();
  if (!current()) return;
  policy.onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`projects/${policy.project_id.value}/policy`, {
        method: 'PUT',
        body: {
          allow: policy.allow.value
            .split(',')
            .map(v => v.trim())
            .filter(Boolean),
        },
      });
      toast('Policy saved.');
    } catch (e) {
      fail(e);
    }
  };
  for (const row of $$('[data-run]', view)) {
    const run = runs.find(r => r.id === row.dataset.run);
    if (!run.replay_available) $('[data-run-action=replay]', row)?.remove();
    if (run.details_available === false) $('[data-run-action=trace]', row)?.remove();
  }
  let traceRequest = 0;
  for (const button of $$('[data-run-action]', view))
    button.onclick = async () => {
      try {
        const id = button.closest('[data-run]').dataset.run,
          action = button.dataset.runAction;
        if (action === 'trace' || (action === 'resume' && runs.find(r => r.id === id)?.status !== 'running')) {
          const request = ++traceRequest;
          const [detail, events] = await Promise.all([api('runs/' + id), api('runs/' + id + '/events')]);
          if (!current() || request !== traceRequest) return;
          const out = $('#runs-trace');
          $('#runs-trace-panel').hidden = false;
          out.textContent = pretty({run: detail, events: events.events});
          const panel = $('#runs-intervention');
          panel.hidden = false;
          mountRunIntervention(panel, detail, async nextId => {
            if (!current() || request !== traceRequest) return;
            const before = runsPageRevision;
            await render();
            if (app.route?.page !== 'runs' || runsPageRevision !== before + 1) return;
            document.querySelector(`[data-run="${CSS.escape(nextId)}"] [data-run-action=trace]`)?.click();
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
          return;
        }
        await api(`runs/${id}/${action}`, {method: 'POST', body: action === 'replay' ? {wait: 5} : {}});
        await render();
      } catch (error) {
        fail(error);
      }
    };
  const select = $('#version-workflow'),
    entries = [];
  for (const p of projects) {
    const project = workflowProjects.find(item => item.project.id === p.id);
    for (const w of project.workflows) entries.push({project: p.id, id: w.id, name: p.name + ' / ' + w.name});
  }
  select.innerHTML += [
    ...entries.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`),
    ...app.resources.map(r => `<option value="node:${esc(r.id)}">Node / ${esc(r.name)}</option>`),
  ].join('');
  select.onchange = async () => {
    try {
      const node = select.value.startsWith('node:'),
        id = node ? select.value.slice(5) : select.value,
        kind = node ? 'node' : 'workflow';
      if (!id) return;
      const history = await api(`versions/${kind}/${id}`),
        head = await api(`versions/${kind}/${id}/${history.current}`);
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
            await select.onchange();
          } catch (e) {
            fail(e);
          }
        };
    } catch (error) {
      fail(error);
    }
  };
};
