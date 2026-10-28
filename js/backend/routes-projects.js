// Routes: projects and workflows (create, rename, duplicate, delete).
'use strict';

// ----- projects -----
const trimmedName = (value, label = 'Project') => {
  if (typeof value !== 'string' || !(value.trim().length >= 1 && value.trim().length <= 100))
    throw bad(`${label} name must contain 1 to 100 characters`);
  return value.trim();
};
async function nextUntitled(c, projects) {
  const meta = await c.ctx.get('meta', {project_number: 0});
  const numbers = projects
    .map(p => /^untitled(\d+)$/i.exec(p.name))
    .filter(Boolean)
    .map(m => Number(m[1]));
  return Math.max(meta.project_number || 0, ...numbers) + 1;
}

/** Deleting a project or workflow also deletes the triggers that would have run it. */
async function dropTriggers(c, doomed) {
  const triggers = await c.ctx.get('triggers', []);
  if (triggers.some(doomed))
    c.ctx.set(
      'triggers',
      triggers.filter(t => !doomed(t))
    );
}

route('GET', 'project-defaults', 'Suggest a name for a new project', async c => ({
  name: 'Untitled' + (await nextUntitled(c, await c.projects())),
}));

route(
  'GET POST',
  'projects',
  'List or create projects',
  async c => {
    const projects = await c.projects();
    if (c.method === 'GET')
      return projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        workflow_count: p.workflows.length,
      }));
    const number = await nextUntitled(c, projects);
    const name = c.body.auto_name || !String(c.body.name || '').trim() ? 'Untitled' + number : trimmedName(c.body.name);
    const match = /^untitled(\d+)$/i.exec(name);
    if (match) c.ctx.set('meta', {project_number: Math.max(number - 1, Number(match[1]))});
    const id = uid();
    projects.push({
      id,
      name,
      description: '',
      created: Date.now() / 1000,
      workflows: [{id, name: 'Main', created: Date.now() / 1000}],
    });
    c.ctx.set('projects', projects);
    return {id, name};
  },
  {body: {name: 'My project'}}
);

route(
  'GET PUT PATCH DELETE',
  'projects/{project_id}',
  'Read, change, rename or delete a project',
  async (c, {project_id}) => {
    const projects = await c.projects(),
      project = await c.project(project_id, c.method !== 'GET');
    if (c.method === 'GET')
      return {
        project: {id: project.id, name: project.name, description: project.description || ''},
        workflows: project.workflows.map(wf => ({...wf, project_id})),
      };
    if (c.method === 'DELETE') {
      for (const wf of project.workflows) {
        await c.ctx.remove('wf:' + wf.id);
        await c.ctx.remove('run:' + wf.id);
        await dropWorkflowRuns(c, wf.id);
        await dropWorkflowState(c, wf.id);
        histories.delete(wf.id);
      }
      await dropTriggers(c, t => t.project_id === project_id);
      c.ctx.set(
        'projects',
        projects.filter(p => p !== project)
      );
      return {deleted: project_id};
    }
    project.name = trimmedName(c.body.name ?? project.name);
    if ('description' in c.body) {
      if (typeof c.body.description !== 'string' || c.body.description.length > 2000)
        throw bad('Description must be text of at most 2000 characters');
      project.description = c.body.description;
    }
    return {id: project_id, name: project.name, description: project.description || ''};
  },
  {body: {name: 'New name'}}
);

route('POST', 'projects/{project_id}/duplicate', 'Duplicate a project with its workflows', async (c, {project_id}) => {
  const projects = await c.projects(),
    source = await c.project(project_id, true),
    names = new Set(projects.map(p => p.name));
  const base = source.name.slice(0, 95) + ' copy';
  let name = base,
    n = 2;
  while (names.has(name)) name = base.slice(0, 95) + ' ' + n++;
  const id = uid(),
    copy = {id, name, description: source.description || '', created: Date.now() / 1000, workflows: []};
  for (const wf of source.workflows) {
    const wid = copy.workflows.length ? uid() : id;
    copy.workflows.push({id: wid, name: wf.name, created: Date.now() / 1000});
    c.ctx.set('wf:' + wid, duplicateDocument(await c.ctx.get('wf:' + wf.id, emptyDoc())));
  }
  projects.push(copy);
  c.ctx.set('projects', projects);
  return {id, name};
});

route(
  'GET POST',
  'projects/{project_id}/workflows',
  'List or create workflows',
  async (c, {project_id}) => {
    const project = await c.project(project_id, c.method === 'POST');
    if (c.method === 'GET') return project.workflows.map(w => ({...w, project_id}));
    const name = trimmedName(c.body.name ?? 'Workflow', 'Workflow');
    if (project.workflows.some(w => w.name === name)) throw bad('A workflow with that name already exists');
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    c.ctx.set('wf:' + id, emptyDoc());
    return {id};
  },
  {body: {name: 'Workflow'}}
);

route(
  'PATCH DELETE',
  'projects/{project_id}/workflows/{workflow_id}',
  'Rename or delete a workflow',
  async (c, {project_id, workflow_id}) => {
    const project = await c.project(project_id, true),
      wf = project.workflows.find(w => w.id === workflow_id);
    if (!wf) throw missing('Record not found');
    if (c.method === 'DELETE') {
      // A Custom Node's editor is its project's only workflow; an ordinary project may have none.
      if (project_id.startsWith('lib-') && project.workflows.length < 2) throw bad('A Custom Node needs its workflow');
      project.workflows = project.workflows.filter(w => w !== wf);
      await c.ctx.remove('wf:' + workflow_id);
      await c.ctx.remove('run:' + workflow_id);
      await dropWorkflowRuns(c, workflow_id);
      await dropWorkflowState(c, workflow_id);
      await dropTriggers(c, t => t.workflow_id === workflow_id);
      histories.delete(workflow_id);
      return {deleted: workflow_id};
    }
    const name = trimmedName(c.body.name, 'Workflow');
    if (project.workflows.some(w => w.name === name && w.id !== workflow_id))
      throw bad('A workflow with that name already exists');
    wf.name = name;
    return {id: workflow_id, name};
  },
  {body: {name: 'New name'}}
);

route(
  'POST',
  'projects/{project_id}/workflows/{workflow_id}/duplicate',
  'Duplicate a workflow',
  async (c, {project_id, workflow_id}) => {
    const project = await c.project(project_id, true),
      source = project.workflows.find(w => w.id === workflow_id);
    if (!source) throw missing('Record not found');
    const existing = new Set(project.workflows.map(w => w.name)),
      base = c.body.name != null ? trimmedName(c.body.name, 'Workflow') : source.name + ' copy';
    let name = base,
      n = 2;
    while (existing.has(name)) name = base.slice(0, 100 - ` ${n}`.length).trimEnd() + ` ${n++}`;
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    c.ctx.set('wf:' + id, duplicateDocument(await c.ctx.get('wf:' + workflow_id, emptyDoc())));
    return {id, name};
  }
);

// ----- the result of the last run of a workflow, shown again when it is opened -----
const MAX_LAST_RUN = 20000000; // characters (images shown with display() are part of it)
route(
  'GET PUT',
  'projects/{project_id}/last-run',
  'Read or store the result of the last run of a workflow',
  async (c, {project_id}) => {
    const project = await c.project(project_id),
      id = c.body.workflow_id || c.query.workflow_id || project.workflows[0]?.id;
    if (!project.workflows.some(w => w.id === id)) throw missing('Record not found');
    if (c.method === 'GET') return (await c.ctx.get('run:' + id, null)) || {};
    const {results = [], status = [], last = null, log = []} = c.body;
    if (!Array.isArray(results) || !Array.isArray(status) || !Array.isArray(log) || (last !== null && !isObject(last)))
      throw bad('results, status and log are lists, last is an object or null');
    if (JSON.stringify([results, status, last, log]).length > MAX_LAST_RUN)
      throw bad('The last run is too large to keep');
    c.ctx.set('run:' + id, {results, status, last, log});
    return {saved: true};
  },
  {body: {results: [], status: [], last: null, log: []}, query: ['workflow_id']}
);
