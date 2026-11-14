// A compact workspace overview: projects and workflows.
'use strict';
const tile = (label, value, href) =>
  `<a class="tile" href="${esc(href)}" data-link><span class="tile-label">${esc(label)}</span><strong class="tile-value">${esc(value)}</strong></a>`;

const welcomeHTML = () =>
  `<div class="welcome-panel"><span class="muted small">YOUR FIRST WORKFLOW</span><h2 title="Start with a small example: one node starts the workflow, another shows its result. Then make it your own.">Turn an idea into a running workflow</h2><div class="button-row"><button type="button" class="primary" data-example>Open example</button><button type="button" data-new-project>New project</button></div></div>`;
async function openStarterWorkflow() {
  const start = 'record:' + uid(),
    result = 'record:' + uid(),
    doc = emptyDoc();
  doc.nodes = [
    {
      id: start,
      kind: 'function',
      node_type: 'custom',
      label: 'Start',
      status: 'ready',
      config: {
        title: 'Start here',
        op: 'on_run',
        inputs: [],
        outputs: [{id: 'out', name: 'out', type: 'signal'}],
      },
    },
    {
      id: result,
      kind: 'function',
      node_type: 'custom',
      label: 'Result',
      status: 'ready',
      config: {
        title: 'Your first result',
        op: 'script',
        inputs: [
          {id: 'in', name: 'in', type: 'signal'},
          {id: 'script', name: 'script', default: 'node.display("Hello! Your workflow is running.");'},
        ],
        outputs: [],
      },
    },
  ];
  doc.layout = {[start]: {x: 0, y: 0}, [result]: {x: 340, y: 0}};
  doc.port_edges = [{id: uid(), source: start, source_port: 'out', target: result, target_port: 'in'}];
  const project = await api('projects/import', {
    method: 'POST',
    body: TextGraph.encode({
      kind: 'project',
      name: 'Getting started',
      description: 'Choose Run to see a result on the second node.',
      workflows: [{name: 'Hello workflow', document: doc}],
    }),
  });
  await loadProjects();
  await go(`/p/${project.id}/w/${project.workflows[0].id}`);
  toast('Choose Run. The second node will show your first result.');
}
function bindWelcome(root) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-new-project], [data-example]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await (button.hasAttribute('data-example') ? openStarterWorkflow() : newProjectDialog());
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  });
}
PAGES.home = async (view, route) => {
  const projects = await api('projects');
  if (app.route !== route) return;
  view.innerHTML =
    '<div class="page dashboard">' + pageHead({title: 'Dashboard'}) + '<div id="dashboard-projects"></div></div>';
  const region = $('#dashboard-projects', view);
  bindWelcome(region);
  const draw = projects => {
    region.innerHTML =
      '<div class="dashboard-metrics">' +
      tile('Projects', projects.length, '/projects') +
      tile(
        'Workflows',
        projects.reduce((n, p) => n + p.workflow_count, 0),
        '/projects'
      ) +
      '</div>' +
      (!projects.length ? welcomeHTML() : '') +
      (projects.length
        ? '<section><div class="section-head"><h2>Projects</h2><a href="/projects" data-link>View all</a></div><ul class="dashboard-projects">' +
          projects
            .slice(0, 5)
            .map(
              p =>
                '<li><a data-link href="/p/' +
                esc(p.id) +
                '">' +
                icon('folder') +
                '<span>' +
                esc(p.name) +
                '</span><small>' +
                plural(p.workflow_count, 'workflow') +
                '</small></a></li>'
            )
            .join('') +
          '</ul></section>'
        : '') +
      '<div id="dashboard-extensions"></div>';
    if (typeof Extensions !== 'undefined') Extensions.renderHome($('#dashboard-extensions', region));
  };
  draw(projects);
  livePage(route, async () => {
    const projects = await api('projects');
    if (app.route === route) draw(projects);
  });
};
