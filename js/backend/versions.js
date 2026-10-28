'use strict';

const nodeContentVersion = step =>
  hashText(
    TextGraph.canonical({
      op: step.op,
      kind: step.kind,
      label: step.label,
      running: step.running,
      scope: step.scope,
      inputs: step.inputs,
      outputs: step.outputs,
      preset: step.preset,
      targets: step.targets,
      scope_signals: step.scope_signals,
      declared: step.declared,
      manifest: step.manifest,
      widgets: step.context?.widgets,
    })
  );

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
    if (key === 'resources') for (const r of value) await add('node', r.id, r);
  }
  await DB.commit(changes);
  await publishGraphChanges(changes);
}
async function versionPlan(plan) {
  for (const step of plan.nodes) step.content_hash ??= await nodeContentVersion(step);
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
