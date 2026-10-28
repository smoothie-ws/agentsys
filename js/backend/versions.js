'use strict';

async function versionedCommit(changes) {
  const add = async (kind, id, value) => {
    const hash = await hashText(TextGraph.canonical(kind === 'node' ? {...value, updated: 0} : value));
    const key = `versions/${kind}/${id}`;
    const history = clone((await DB.get(key)) ?? {current: null, entries: []});
    if (history.current === hash) return;
    history.current = hash;
    history.entries.push({hash, at: Date.now()});
    changes[key] = history;
    if (!(await DB.get('versions/content/' + hash))) changes['versions/content/' + hash] = value;
  };
  for (const [key, value] of Object.entries({...changes})) {
    if (value === undefined) continue;
    if (key.startsWith('wf:')) await add('workflow', key.slice(3), value);
    if (key === 'resources') for (const r of value) if (r.kind === 'custom_node') await add('node', r.id, r);
  }
  return DB.commit(changes);
}
async function pinPlanVersions(plan, locked = false) {
  if (plan.version_refs) return;
  const pin = async () => {
    const changes = {},
      wf = plan.context.workflow_id;
    if (wf && !(await DB.get('versions/workflow/' + wf))) {
      const doc = await DB.get('wf:' + wf);
      if (doc) changes['wf:' + wf] = doc;
    }
    const resources = (await DB.get('resources')) ?? [];
    for (const n of plan.nodes)
      if (
        n.context?.resource_id &&
        resources.some(r => r.id === n.context.resource_id) &&
        !(await DB.get('versions/node/' + n.context.resource_id))
      )
        changes.resources = resources;
    if (Object.keys(changes).length) await versionedCommit(changes);
    plan.version_refs = {};
    if (wf)
      plan.version_refs.workflow =
        (await DB.get('versions/workflow/' + wf))?.current ?? (await hashText(TextGraph.canonical(plan.nodes)));
    for (const n of plan.nodes)
      if (n.context?.resource_id && !plan.version_refs[n.context.resource_id])
        plan.version_refs[n.context.resource_id] =
          (await DB.get('versions/node/' + n.context.resource_id))?.current ??
          n.manifest?.code_hash ??
          (await hashText(TextGraph.canonical(n)));
  };
  return locked ? pin() : exclusive(pin);
}
route('GET', 'versions/{kind}/{id}', 'List immutable versions and the current pointer', async (c, {kind, id}) => {
  if (!['node', 'workflow'].includes(kind)) throw bad('Unknown version kind');
  const value = await c.ctx.get(`versions/${kind}/${id}`);
  if (!value) throw missing('No versions');
  return value;
});
route('GET', 'versions/{kind}/{id}/{hash}', 'Read a version as canonical text files', async (c, {kind, id, hash}) => {
  const history = await c.ctx.get(`versions/${kind}/${id}`);
  if (!history?.entries.some(e => e.hash === hash)) throw missing('Version not found');
  return TextGraph.encode(await c.ctx.get('versions/content/' + hash));
});
route('POST', 'versions/{kind}/{id}/{hash}/restore', 'Restore an immutable version', async (c, {kind, id, hash}) => {
  const history = await c.ctx.get(`versions/${kind}/${id}`);
  if (!history?.entries.some(e => e.hash === hash)) throw missing('Version not found');
  const value = clone(await c.ctx.get('versions/content/' + hash));
  if (kind === 'workflow') {
    const projects = await c.projects();
    if (!id.startsWith('lib-') && !projects.some(p => p.workflows.some(w => w.id === id)))
      throw missing('Workflow no longer exists');
    c.ctx.set('wf:' + id, value);
  } else {
    const resources = await c.ctx.get('resources', []),
      index = resources.findIndex(r => r.id === id);
    if (index < 0) throw missing('Node no longer exists');
    resources[index] = value;
    value.updated = Date.now() / 1000;
    c.ctx.set('resources', resources);
    await c.ctx.remove('wf:lib-' + id);
    c.libraryTouched = true;
  }
  return {id, hash};
});
