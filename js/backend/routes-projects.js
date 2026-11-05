// Routes: projects and workflows (create, rename, duplicate, delete).
'use strict';

// ----- projects -----
const trimmedName = (value, label = 'Project') => {
  if (typeof value !== 'string' || !(value.trim().length >= 1 && value.trim().length <= 100))
    throw bad(`${label} name must contain 1 to 100 characters`);
  return value.trim();
};
/** A name that is not used yet: "Name", then "Name 2", "Name 3"… */
const freeName = (taken, base) => {
  let name = base.slice(0, 100),
    n = 2;
  while (taken.has(name)) name = base.slice(0, 100 - ` ${n}`.length).trimEnd() + ` ${n++}`;
  return name;
};
async function nextUntitled(c, projects) {
  const meta = await c.ctx.get('meta', {project_number: 0});
  const numbers = projects
    .map(p => /^untitled(\d+)$/i.exec(p.name))
    .filter(Boolean)
    .map(m => Number(m[1]));
  return Math.max(meta.project_number || 0, ...numbers) + 1;
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
      for (const wf of project.workflows) await removeWorkflow(c, wf.id);
      await c.ctx.remove('policy:' + project_id);
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
    name = freeName(new Set(projects.map(p => p.name)), source.name.slice(0, 95) + ' copy');
  const id = uid(),
    copy = {id, name, description: source.description || '', created: Date.now() / 1000, workflows: []};
  for (const wf of source.workflows) {
    const wid = copy.workflows.length ? uid() : id;
    copy.workflows.push({id: wid, name: wf.name, created: Date.now() / 1000});
    let ids;
    c.ctx.set(
      'wf:' + wid,
      duplicateDocument(await c.ctx.get('wf:' + wf.id, emptyDoc()), map => {
        ids = map;
      })
    );
    await duplicateGraphData(c, wf.id, wid, ids);
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
      project.workflows = project.workflows.filter(w => w !== wf);
      await removeWorkflow(c, workflow_id);
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
      base = c.body.name != null ? trimmedName(c.body.name, 'Workflow') : source.name.slice(0, 95) + ' copy',
      name = freeName(existing, base);
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    let ids;
    c.ctx.set(
      'wf:' + id,
      duplicateDocument(await c.ctx.get('wf:' + workflow_id, emptyDoc()), map => {
        ids = map;
      })
    );
    await duplicateGraphData(c, workflow_id, id, ids);
    return {id, name};
  }
);
