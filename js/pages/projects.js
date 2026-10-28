// Pages: the project list and one project with its workflows.
'use strict';

// ----- projects -----
const EMPTY_PROJECTS = '<div class="empty"><h2>Start your first project</h2></div>';
PAGES.projects = async view => {
  await loadProjects();
  view.innerHTML = `<div class="page">${pageHead({title: 'Projects', actions: `<button class="ghost" id="import-project">${icon('download')}Import project</button><button class="primary" id="create-project">${icon('plus')}New project</button>`})}
    <div class="cards">${app.projects
      .map(p =>
        card({
          href: `/p/${p.id}`,
          glyph: 'folder',
          title: p.name,
          attrs: `data-project-title="${esc(p.id)}"`,
          previewAttrs: `data-preview-project="${esc(p.id)}" aria-label="Project workflow previews"`,
          previewClass: 'preview-stack',
          facts: plural(p.workflow_count, 'workflow') + (p.description ? ' · ' + esc(p.description) : ''),
          menu: 'project:' + p.id,
        })
      )
      .join('')}</div>${app.projects.length ? '' : EMPTY_PROJECTS}</div>`;
  $('#create-project').onclick = () => newProjectDialog();
  $('#import-project').onclick = () => importProjects().catch(fail);
  loadCardPreviews(view);
};

/** Menu of a project (card or row of the second panel). `title` is the element showing its name, if it is on the page. */
function projectActions(project, title = $(`[data-project-title="${CSS.escape(project.id)}"]`)) {
  return [
    [
      'Rename',
      () =>
        inlineRename(
          title,
          project.name,
          async name => {
            await api(`projects/${project.id}`, {method: 'PATCH', body: {name}});
            project.name = name;
            Tabs.renameProject(project.id, name);
            renderSidebar();
            if (app.route.project === project.id) await render();
          }
        ),
    ],
    [
      'Duplicate',
      async () => {
        const copy = await api(`projects/${project.id}/duplicate`, {method: 'POST'});
        toast(copy?.id ? `Project duplicated. [Open the copy](/p/${encodeURIComponent(copy.id)})` : 'Project duplicated.');
        await loadProjects();
        await render();
      },
    ],
    ['Export project', () => exportProject(project), {icon:'upload'}],
    ['Import workflow', () => importWorkflows(project.id), {icon:'download'}],
    ['Settings', () => go(`/p/${project.id}/settings`)],
    null,
    [
      'Delete',
      () =>
        confirmDialog(
          'Delete project?',
          `“${project.name}” and all of its workflows will be removed.`,
          async () => {
            await api(`projects/${project.id}`, {method: 'DELETE'});
            Tabs.dropProject(project.id);
            await loadProjects();
            if (app.route.project === project.id) await go('/projects');
            else await render();
          },
          'Delete project'
        ),
      {danger: true},
    ],
  ];
}

async function newProjectDialog() {
  const defaults = await api('project-defaults');
  dialog(
    'New project',
    field('Name', `<input name="name" maxlength="100" autofocus placeholder="${esc(defaults.name)}">`),
    async form => {
      const created = await api('projects', {
        method: 'POST',
        body: {name: form.name.value.trim(), auto_name: !form.name.value.trim()},
      });
      await loadProjects();
      await go(`/p/${created.id}`);
    },
    'Create project'
  );
}

/** Runs a workflow without opening it: the same evaluation as the Run button, result stored as the last run. */
async function runFromCard(projectId, workflow, button) {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('busy');
  try {
    const graph = await api(`projects/${projectId}/workflow`, {query: {workflow_id: workflow.id}});
    const starts = startNodes(graph.nodes);
    if (!starts.length) return toast('Add an on_run node to run.');
    const started = Date.now(),
      result = await api(`projects/${projectId}/evaluate-node`, {
        method: 'POST',
        body: {workflow_id: workflow.id, node_ids: starts.map(n => n.id), collect: true},
      });
    const {failed, last, results, log} = runRecord(graph.nodes, result, started);
    await api(`projects/${projectId}/last-run`, {
      method: 'PUT',
      body: {workflow_id: workflow.id, results, status: Object.entries(result.status), last, log},
    });
    // The name is a link to the workflow (brackets would end the link early).
    const link = `“[${workflow.name.replace(/[\[\]]/g, '')}](/p/${encodeURIComponent(projectId)}/w/${encodeURIComponent(workflow.id)})”`;
    toast(failed.size ? `${link} finished with ${plural(failed.size, 'error')}.` : `${link} done.`, failed.size > 0);
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
}

// ----- project -----
PAGES.project = async (view, route) => {
  const {project, workflows} = await api(`projects/${route.project}`);
  view.innerHTML = `<div class="page">${pageHead({
    crumbs: [['Projects', '/projects']],
    title: esc(project.name),
    sub: esc(project.description || ''),
    actions: `<button class="ghost" id="import-workflow">${icon('download')}Import workflow</button><button class="ghost" id="export-project">${icon('upload')}Export project</button><a class="button ghost" href="/p/${esc(project.id)}/settings" data-link>${icon('settings')}Settings</a><button class="primary" id="new-workflow">${icon('plus')}New workflow</button>`,
  })}
    <div class="cards">${workflows
      .map(w =>
        card({
          href: `/p/${project.id}/w/${w.id}`,
          glyph: 'node',
          title: w.name,
          attrs: `data-workflow-title="${esc(w.id)}"`,
          previewAttrs: `data-preview-workflow="${esc(w.id)}" aria-label="Workflow preview"`,
          run: `<button class="icon card-run" data-run="${esc(w.id)}" title="Run the workflow" aria-label="Run the workflow">${icon('play')}</button>`,
          menu: `workflow:${project.id}:${w.id}`,
        })
      )
      .join('')}</div></div>`;
  loadCardPreviews(view, project.id);
  $('#import-workflow').onclick = () => importWorkflows(project.id).catch(fail);
  $('#export-project').onclick = () => exportProject(project).catch(fail);
  $('#new-workflow').onclick = () =>
    dialog(
      'New workflow',
      field('Name', '<input name="name" required maxlength="100" autofocus value="Workflow">'),
      async form => {
        const created = await api(`projects/${project.id}/workflows`, {method: 'POST', body: {name: form.name.value}});
        await go(`/p/${project.id}/w/${created.id}`);
      },
      'Create'
    );
  view.onclick = event => {
    const run = event.target.closest('.card-run');
    if (run) runFromCard(project.id, workflows.find(w => w.id === run.dataset.run), run);
  };
};

/** Menu of a workflow (its card or its row in the second panel). */
function workflowActions(projectId, workflow, title) {
  const refresh = async () => {
    await Promise.all([loadProjects(), loadProjectWorkflows(projectId, true)]);
    await render();
  };
  return [
    [
      'Rename',
      () =>
        inlineRename(
          title,
          workflow.name,
          async name => {
            await api(`projects/${projectId}/workflows/${workflow.id}`, {method: 'PATCH', body: {name}});
            workflow.name = name;
            Tabs.rename(workflow.id, name);
            await refresh();
          }
        ),
    ],
    [
      'Duplicate',
      async () => {
        await api(`projects/${projectId}/workflows/${workflow.id}/duplicate`, {method: 'POST', body: {}});
        await refresh();
      },
    ],
    ['Export workflow', () => exportWorkflow(projectId, workflow), {icon:'upload'}],
    ['Import workflow', () => importWorkflows(projectId), {icon:'download'}],
    null,
    [
      'Delete',
      () =>
        confirmDialog(
          'Delete workflow?',
          `“${workflow.name}” and its canvas will be removed.`,
          async () => {
            await api(`projects/${projectId}/workflows/${workflow.id}`, {method: 'DELETE'});
            Tabs.drop(workflow.id);
            await Promise.all([loadProjects(), loadProjectWorkflows(projectId, true)]);
            if (app.route.workflow === workflow.id) await go(`/p/${projectId}`);
            else await render();
          },
          'Delete workflow'
        ),
      {danger: true},
    ],
  ];
}

async function exportProject(project) {
  if (W.project === project.id && document.querySelector('#canvas')) await flushNodeEdits();
  downloadJSON(await api(`projects/${project.id}/export`), `${project.name}.project`);
}
async function exportWorkflow(projectId, workflow) {
  if (W.project === projectId && W.workflow === workflow.id && document.querySelector('#canvas')) await flushNodeEdits();
  downloadJSON(await api(`projects/${projectId}/workflows/${workflow.id}/export`), `${workflow.name}.workflow`);
}
async function importProjects() {
  const files = await pickFiles();
  let last;
  for (const file of files) {
    const data = JSON.parse(await file.text());
    if (TextGraph.decode(data).kind !== 'project') throw new Error(`${file.name}: choose an exported project.`);
    last = await api('projects/import', {method:'POST',body:data});
  }
  if (last) { await loadProjects(); await go(`/p/${last.id}`); }
}
async function importWorkflows(projectId) {
  const files = await pickFiles();
  let last;
  for (const file of files) {
    const data = JSON.parse(await file.text());
    if (TextGraph.decode(data).kind !== 'workflow') throw new Error(`${file.name}: choose an exported workflow.`);
    last = await api(`projects/${projectId}/workflows/import`, {method:'POST',body:data});
  }
  if (last) {
    await Promise.all([loadProjects(),loadProjectWorkflows(projectId,true)]);
    await go(`/p/${projectId}/w/${last.id}`);
  }
}
