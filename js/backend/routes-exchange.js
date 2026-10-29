// Export and import of whole workflows and projects as one JSON document (what a person, a script or another
// program can save, diff, generate and bring back). Custom Nodes placed in a workflow travel as they are; they
// refresh from the Library when the same Library item exists in the target.
'use strict';

const EXCHANGE_KEYS = ['types', 'nodes', 'layout', 'style', 'groups', 'complex', 'port_edges', 'widgets', 'library_nodes'];
const decodeExchange = packet => {
  try {
    return TextGraph.decode(packet);
  } catch (error) {
    throw bad(error.message);
  }
};

/** The document as exchanged: its stored parts, without the change counter. It carries the types it uses (the Library's too), so the file stands alone. */
const exportedDocument = async (c, doc) => {
  const out = clone(stateOf(doc)),
    library = await c.libraryTypes();
  out.types = [...library.filter(t => !out.types.some(o => o.id === t.id)).map(clone), ...out.types];
  const byId = new Map(out.types.map(t => [t.id, t])),
    used = new Set(),
    todo = [
      ...out.nodes.flatMap(n => [...(n.config?.inputs ?? []), ...(n.config?.outputs ?? [])]),
      ...out.complex.flatMap(x => [...x.interface.inputs, ...x.interface.outputs]),
    ].flatMap(p => typeRefs(p.type));
  for (const id of todo) {
    if (used.has(id)) continue;
    used.add(id);
    if (byId.has(id)) todo.push(...refsOf(byId.get(id)));
  }
  out.types = out.types.filter(t => used.has(t.id)).map(({library, ...t}) => t);
  return out;
};

/** Checks a document from outside and returns a clean copy; throws a readable error if it cannot be a workflow. */
function importedDocument(project, input) {
  if (!isObject(input)) throw bad('document must be an object');
  const doc = emptyDoc();
  for (const key of EXCHANGE_KEYS) {
    if (!(key in input)) continue;
    const kind = ['types', 'nodes', 'groups', 'complex', 'port_edges', 'library_nodes'].includes(key)
      ? Array.isArray(input[key])
      : isObject(input[key]);
    if (!kind) throw bad(`document.${key} has the wrong shape`);
    doc[key] = clone(input[key]);
  }
  if (JSON.stringify(doc).length > 20000000) throw bad('This workflow is too large to import');
  if (doc.nodes.length > 1000) throw bad('A workflow has at most 1000 nodes');
  if (doc.library_nodes.some(id => typeof id !== 'string')) throw bad('document.library_nodes must contain resource IDs');
  doc.library_nodes = [...new Set(doc.library_nodes)];
  const ids = new Set();
  for (const node of doc.nodes) {
    if (!isObject(node) || typeof node.id !== 'string' || ids.has(node.id))
      throw bad('Every node needs a unique string id');
    ids.add(node.id);
    if (node.kind !== 'function' || !(node.node_type in DEFINITIONS)) throw bad('A node has an unsupported type');
  }
  // An imported type is the workflow's own until it turns out to be a Library type of this installation (see unifyTypes).
  doc.types = doc.types.map(({library, ...t}) => t);
  checkTypes(doc.types);
  for (const [id, list] of Object.entries(doc.widgets)) {
    if (!ids.has(id)) throw bad('Widgets belong to a node that does not exist');
    checkWidgets(list);
  }
  try {
    new Editor(project, {id: 'import', name: 'import'}, doc).snapshot();
  } catch (error) {
    throw bad('The document is not a valid workflow: ' + (error.message || error));
  }
  return doc;
}
/** A name that is not used yet: "Name", then "Name 2", "Name 3"… */
const freeName = (taken, base) => {
  let name = base.slice(0, 100),
    n = 2;
  while (taken.has(name)) name = base.slice(0, 100 - ` ${n}`.length).trimEnd() + ` ${n++}`;
  return name;
};
const wrapDocument = (kind, extra) => TextGraph.encode({kind, ...extra});

route(
  'GET',
  'projects/{project_id}/workflows/{workflow_id}/export',
  'Export a workflow as one JSON document',
  async (c, {project_id, workflow_id}) => {
    if (String(project_id).startsWith('lib-')) throw bad('Export a Custom Node from the Library');
    const project = await c.project(project_id),
      wf = project.workflows.find(w => w.id === workflow_id);
    if (!wf) throw missing('Record not found');
    return wrapDocument('workflow', {
      name: wf.name,
      document: await exportedDocument(c, await c.ctx.get('wf:' + wf.id, emptyDoc())),
    });
  },
  {returns: '{format: "agentsys.text/1", files: {"graph.json": text, "layout.json": text, "scripts/…js": source}}'}
);
route(
  'POST',
  'projects/{project_id}/workflows/import',
  'Add a workflow from an exported document',
  async (c, {project_id}) => {
    if (String(project_id).startsWith('lib-')) throw bad('Workflows are imported into projects');
    const project = await c.project(project_id),
      body = decodeExchange(c.body);
    const input = body.kind === 'workflow' || body.document ? body : null;
    if (!input?.document) throw bad('Pass {name, document} as exported by the export route');
    const doc = importedDocument(project, input.document),
      name = freeName(
        new Set(project.workflows.map(w => w.name)),
        String(body.name ?? input.name ?? 'Imported workflow').trim() || 'Imported workflow'
      );
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    c.ctx.set('wf:' + id, doc);
    c.ctx.set('projects', await c.projects());
    await c.collectHooks(project_id, id, doc, JSON.stringify(stateOf(emptyDoc())));
    return {id, name, diagnostics: new Editor(project, {id, name}, doc).snapshot().diagnostics.map(d => d.message)};
  },
  {
    body: TextGraph.encode({
      kind:'workflow',
      name: 'optional new name',
      document: {types: [], nodes: [], layout: {}, groups: [], complex: [], port_edges: [], widgets: {}},
    }),
  }
);
route(
  'GET',
  'projects/{project_id}/export',
  'Export a project with all its workflows as one JSON document',
  async (c, {project_id}) => {
    if (String(project_id).startsWith('lib-')) throw bad('Export a Custom Node from the Library');
    const project = await c.project(project_id),
      workflows = [];
    for (const wf of project.workflows)
      workflows.push({name: wf.name, document: await exportedDocument(c, await c.ctx.get('wf:' + wf.id, emptyDoc()))});
    return wrapDocument('project', {name: project.name, description: project.description || '', workflows});
  },
  {returns: '{format: "agentsys.text/1", files: canonical project files}'}
);
/** Creates a project from a decoded project document (`projects/import`, and the templates of plugins). */
async function importProjectDocument(c, body) {
  if (!Array.isArray(body.workflows) || !body.workflows.length || body.workflows.length > 100)
    throw bad('Pass {name, workflows: [{name, document}]} as exported by the export route');
  const projects = await c.projects(),
    id = uid(),
    project = {
      id,
      name: freeName(
        new Set(projects.map(p => p.name)),
        String(body.name ?? 'Imported project').trim() || 'Imported project'
      ),
      description: typeof body.description === 'string' ? body.description.slice(0, 2000) : '',
      created: Date.now() / 1000,
      workflows: [],
    };
  const docs = [];
  for (const item of body.workflows) {
    if (!isObject(item)) throw bad('Every workflow needs a name and a document');
    const doc = importedDocument(project, item.document),
      name = freeName(
        new Set(project.workflows.map(w => w.name)),
        String(item.name ?? 'Workflow').trim() || 'Workflow'
      ),
      wid = project.workflows.length ? uid() : id;
    project.workflows.push({id: wid, name, created: Date.now() / 1000});
    docs.push([wid, doc]);
  }
  for (const [wid, doc] of docs) {
    c.ctx.set('wf:' + wid, doc);
    await c.collectHooks(id, wid, doc, JSON.stringify(stateOf(emptyDoc())));
  }
  projects.push(project);
  c.ctx.set('projects', projects);
  return {id, name: project.name, workflows: project.workflows.map(w => ({id: w.id, name: w.name}))};
}
route(
  'POST',
  'projects/import',
  'Create a project from an exported document',
  async c => importProjectDocument(c, decodeExchange(c.body)),
  {body: TextGraph.encode({kind:'project',name: 'My project', workflows: [{name: 'Main', document: {}}]})}
);
