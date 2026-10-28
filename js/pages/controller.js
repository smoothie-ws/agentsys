'use strict';

// Read models and human decisions use the same API as Scripts and the scheduler.
PAGES.controller = async view => {
  const [initiatives, runs, approvals, projects] = await Promise.all([
    api('initiatives'),
    api('runs'),
    api('approvals'),
    api('projects'),
  ]);
  Subnav.mount({
    title: 'Controller',
    body:
      '<nav class="subnav-tree controller-nav">' +
      [
        ['initiatives', 'Initiatives'],
        ['approvals', 'Approvals'],
        ['runs', 'Runs'],
        ['versions', 'Versions'],
        ['permissions', 'Permissions'],
        ['settings', 'Run settings'],
      ]
        .map(([key, label]) => `<a href="#controller-${key}" data-controller-section="${key}">${label}</a>`)
        .join('') +
      '</nav>',
  });
  view.innerHTML = `<div class="page controller-page">${pageHead({title: 'Controller', actions: '<button id="controller-refresh">Refresh</button>'})}
    <section id="controller-initiatives"><h2>Initiatives</h2><div id="initiative-list">${initiatives.length ? initiatives.map(i => `<details data-initiative="${esc(i.id)}"><summary>${esc(i.title)} · ${esc(i.status)}</summary><div class="initiative-detail"></div></details>`).join('') : '<p class="muted">No initiatives yet. A workflow can create one and manage its tasks.</p>'}</div></section>
    <section id="controller-approvals"><h2>Approvals</h2>${approvals.length ? approvals.map(a => `<article class="controller-card" data-approval="${esc(a.id)}"><h3>${esc(a.question)}</h3><p>${esc(a.status)} · Expires ${esc(new Date(a.expires_at).toLocaleString())}</p>${a.code ? `<details><summary>Code and requested capabilities</summary><pre>${esc(a.code)}</pre><pre>${esc(pretty(a.capabilities))}</pre></details>` : ''}<label>Comment<input name="comment" maxlength="2000"></label>${a.budget ? '<label>New budget limits (JSON)<textarea name="budget">{"calls":200,"tokens":2000000,"cost":20,"ms":604800000}</textarea></label>' : ''}<div class="button-row">${a.options.map(option => `<button data-answer="${esc(option)}">${esc(option)}</button>`).join('')}</div></article>`).join('') : '<p class="muted">No pending approvals.</p>'}</section>
    <section id="controller-runs"><h2>Runs</h2>${runs.length ? `<table><thead><tr><th>Started</th><th>Status</th><th>Waiting for</th><th>Actions</th></tr></thead><tbody>${runs.map(r => `<tr data-run="${esc(r.id)}"><td>${esc(when(r.started))}</td><td>${esc(r.status)}</td><td>${esc(r.waits.map(w => w.wait_spec.event ?? w.wait_spec.approval?.question ?? new Date(w.due).toLocaleString()).join(', '))}</td><td><div class="button-row">${['waiting', 'interrupted'].includes(r.status) ? '<button data-run-action="resume">Resume</button><button data-run-action="cancel">Cancel</button>' : r.status === 'running' ? '<button data-run-action="cancel">Cancel</button>' : '<button data-run-action="replay">Replay</button>'}<button data-run-action="trace">Trace</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No runs yet.</p>'}<pre id="controller-trace" hidden></pre></section>
    <section id="controller-versions"><h2>Versions and graph checks</h2><label>Workflow<select id="version-workflow"><option value="">Select a workflow</option></select></label><div id="controller-history"></div><pre id="controller-diff"></pre><div id="controller-lint"></div></section>
    <section id="controller-permissions"><h2>Permissions</h2><form id="controller-policy"><label>Workspace<select name="project_id">${projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label>Allowed capabilities (comma separated)<textarea name="allow" rows="3"></textarea></label><button>Save policy</button></form><form id="controller-review"><label>Library node<select name="resource_id">${resourcesOf(
      'custom_node'
    )
      .map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`)
      .join('')}</select></label><button>Request code and capability review</button></form></section></div>`;
  $('#controller-refresh').onclick = () => render().catch(fail);
  for (const link of $$('[data-controller-section]'))
    link.onclick = event => {
      event.preventDefault();
      $('#controller-' + link.dataset.controllerSection)?.scrollIntoView({behavior: 'smooth'});
    };
  view
    .querySelector('.controller-page')
    .insertAdjacentHTML(
      'beforeend',
      `<section id="controller-settings"><h2>Run settings</h2><form id="controller-settings-form"><label>Default budget (JSON)<textarea name="budget" rows="5">${esc(pretty(app.preferences.default_budget ?? {calls: 100, tokens: 1000000, cost: 10, ms: 604800000}))}</textarea></label><label>Allowed models (Provider/model, one per line; empty permits all)<textarea name="models" rows="3">${esc((app.preferences.allowed_models ?? []).join('\n'))}</textarea></label><label>Budget limit action<select name="budget_policy"><option value="fail">Fail the run</option><option value="approval" ${app.preferences.budget_policy === 'approval' ? 'selected' : ''}>Request approval</option></select></label><label>Finished runs to retain<input name="retention" type="number" min="1" value="${esc(app.preferences.run_retention ?? 200)}"></label><label>Maximum run lifetime (days)<input name="lifetime" type="number" min="1" value="${esc((app.preferences.run_lifetime_ms ?? 604800000) / 86400000)}"></label><label class="check"><input name="blobs" type="checkbox" ${app.preferences.trace_blobs !== false ? 'checked' : ''}>Keep redacted prompt and response text</label><label>Text and replay retention (days)<input name="trace_days" type="number" min="1" value="${esc((app.preferences.blob_retention_ms ?? 604800000) / 86400000)}"></label><button>Save run settings</button></form></section>`
    );
  $('#controller-settings-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      app.preferences = await api('settings', {
        method: 'PUT',
        body: {
          default_budget: JSON.parse(form.budget.value),
          allowed_models: form.models.value
            .split('\n')
            .map(v => v.trim())
            .filter(Boolean),
          budget_policy: form.budget_policy.value,
          run_retention: Number(form.retention.value),
          run_lifetime_ms: Number(form.lifetime.value) * 86400000,
          trace_blobs: form.blobs.checked,
          blob_retention_ms: Number(form.trace_days.value) * 86400000,
          trace_retention_ms: Number(form.trace_days.value) * 86400000,
        },
      });
      toast('Run settings saved.');
    } catch (error) {
      fail(error);
    }
  };
  const policy = $('#controller-policy');
  policy.project_id.onchange = async () => {
    try {
      policy.allow.value = (await api(`projects/${policy.project_id.value}/policy`)).allow.join(', ');
    } catch (e) {
      fail(e);
    }
  };
  if (projects.length) await policy.project_id.onchange();
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
  $('#controller-review').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`projects/${policy.project_id.value}/permission-approvals`, {
        method: 'POST',
        body: {resource_id: event.currentTarget.resource_id.value},
      });
      await render();
    } catch (e) {
      fail(e);
    }
  };
  for (const detail of $$('[data-initiative]', view))
    detail.ontoggle = async () => {
      if (!detail.open || detail.dataset.loaded) return;
      try {
        const i = await api('initiatives/' + detail.dataset.initiative);
        const taskTree = (parent, seen = new Set()) =>
          i.tasks
            .filter(t => (t.parent_id ?? null) === parent && !seen.has(t.id))
            .map(
              t =>
                `<li>${esc(t.title)} · ${esc(t.status)}${i.tasks.some(c => c.parent_id === t.id) ? `<ul>${taskTree(t.id, new Set(seen).add(t.id))}</ul>` : ''}</li>`
            )
            .join('');
        $('.initiative-detail', detail).innerHTML =
          `<p>${esc(i.goal)}</p><h3>Tasks</h3><ul>${taskTree(null)}</ul><h3>Decisions</h3>${i.decisions.map(d => `<p><strong>${esc(d.summary)}</strong> — ${esc(d.rationale)}</p>`).join('')}<h3>Artifacts and memory</h3><pre>${esc(pretty({artifacts: i.artifacts, facts: i.facts}))}</pre>`;
        detail.dataset.loaded = '1';
      } catch (error) {
        fail(error);
      }
    };
  for (const button of $$('[data-answer]', view))
    button.onclick = async () => {
      try {
        const card = button.closest('[data-approval]'),
          budget = $('[name=budget]', card)?.value;
        await api('approvals/' + card.dataset.approval, {
          method: 'POST',
          body: {
            answer: button.dataset.answer,
            comment: $('[name=comment]', card).value,
            ...(budget ? {budget: JSON.parse(budget)} : {}),
          },
        });
        await render();
      } catch (error) {
        fail(error);
      }
    };
  for (const row of $$('[data-run]', view)) {
    const run = runs.find(r => r.id === row.dataset.run);
    if (!run.replay_available) $('[data-run-action=replay]', row)?.remove();
  }
  for (const button of $$('[data-run-action]', view))
    button.onclick = async () => {
      try {
        const id = button.closest('[data-run]').dataset.run,
          action = button.dataset.runAction;
        if (action === 'trace') {
          const [detail, events] = await Promise.all([api('runs/' + id), api('runs/' + id + '/events')]);
          const out = $('#controller-trace');
          out.hidden = false;
          out.textContent = pretty({run: detail, events: events.events});
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
    const project = await api('projects/' + p.id);
    for (const w of project.workflows) entries.push({project: p.id, id: w.id, name: p.name + ' / ' + w.name});
  }
  select.innerHTML += [
    ...entries.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`),
    ...resourcesOf('custom_node').map(r => `<option value="node:${esc(r.id)}">Node / ${esc(r.name)}</option>`),
  ].join('');
  select.onchange = async () => {
    try {
      const node = select.value.startsWith('node:'),
        id = node ? select.value.slice(5) : select.value,
        kind = node ? 'node' : 'workflow';
      if (!id) return;
      const history = await api(`versions/${kind}/${id}`),
        head = await api(`versions/${kind}/${id}/${history.current}`);
      $('#controller-history').innerHTML = history.entries
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
            $('#controller-diff').textContent = changes.join('\n') || 'Identical content';
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
      if (!node) {
        const entry = entries.find(w => w.id === id),
          lint = await api(`projects/${entry.project}/lint`, {query: {workflow_id: id}});
        $('#controller-lint').innerHTML =
          `<h3>Graph checks</h3>${lint.warnings.map(w => `<p>${esc(w.message)}</p>`).join('') || '<p>No warnings.</p>'}<p>${lint.statistics.script_count} Scripts · ${lint.statistics.library_nodes} Library nodes</p>`;
      }
    } catch (error) {
      fail(error);
    }
  };
};
