// Loading the workflow from the backend and deriving what is visible (collapsed Complex Nodes, groups, positions).
'use strict';

/** What a node shows after a run: the text it passed to display(), or the error that stopped it. */
function previewText(result) {
  if (!result) return '';
  if (result.error != null && result.text == null) return result.error;
  return result.text ?? '';
}

/** The preview of a result on a node: the texts and images display() left one after another (or the error). */
function previewHTML(result) {
  const part = text =>
    IMAGE_DISPLAY.test(text)
      ? `<img class="preview-image" src="${text}" alt="Image shown by the node">`
      : `<pre class="preview-text" tabindex="0">${esc(text)}</pre>`;
  return previewText(result).split(DISPLAY_PARTS).map(part).join('');
}

// ----- data -----
function scheduleReload(delay = 50) {
  if (W.reloadTask?.canvas === W.canvas) {
    W.reloadTask.again = true;
    return;
  }
  if (W.reloadTimer) return;
  W.reloadTimer = setTimeout(() => {
    W.reloadTimer = null;
    reload().catch(fail);
  }, delay);
}

async function reload(first = false) {
  const canvas = W.canvas;
  if (!canvas?.isConnected) return;
  clearTimeout(W.reloadTimer);
  W.reloadTimer = null;
  if (W.drag) return scheduleReload(300);
  if (W.reloadTask?.canvas === canvas) {
    W.reloadTask.again = true;
    return W.reloadTask.promise;
  }
  const task = {canvas, again: false, promise: null};
  W.reloadTask = task;
  task.promise = (async () => {
    do {
      task.again = false;
      if (await loadWorkflowSnapshot(first, task)) first = false;
    } while (task.again && W.canvas === canvas && canvas.isConnected);
  })().finally(() => {
    if (W.reloadTask === task) W.reloadTask = null;
  });
  return task.promise;
}

async function loadWorkflowSnapshot(first, task) {
  const canvas = task.canvas;
  const [snapshot, policy] = await Promise.all([
    api(`projects/${W.project}/workflow`, {query: {workflow_id: W.workflow}}),
    W.policy && !W.policyDirty ? W.policy : api(`projects/${W.project}/policy`),
  ]);
  if (canvas !== W.canvas || !canvas.isConnected || snapshot.workflow_id !== W.workflow) return;
  // An edit arrived after these reads began. Fetch its state before painting, without flashing an older graph.
  if (task.again) return;
  W.snapshot = snapshot;
  W.policy = policy;
  W.policyDirty = false;
  W.history = snapshot.history;
  discardStaleRun();
  for (const node of snapshot.nodes) if (W.runStatus.has(node.id)) node.status = W.runStatus.get(node.id);
  W.nodes = new Map(snapshot.nodes.map(n => [n.id, n]));
  W.groups = new Map(snapshot.groups.map(g => [g.id, g]));
  W.complex = new Map(snapshot.complex.map(c => [c.id, c]));
  for (const cx of snapshot.complex)
    W.nodes.set('complex:' + cx.id, {...cx, id: 'complex:' + cx.id, group_id: cx.id, kind: 'complex', label: cx.name});
  syncComplexStatus();
  W.nodeMap = Editor.nodeMap(snapshot);
  W.types = new TypeTable(snapshot.types);
  paintTypes(snapshot.types);
  W.hidden = hiddenSets();
  for (const id of [...W.selected])
    if (!W.nodes.has(id) && !W.groups.has(id.replace('frame:', ''))) W.selected.delete(id);
  if (W.library && snapshot.root) {
    const name = W.groups.get(snapshot.root)?.name;
    if (name && name !== W.projectData.project.name) {
      W.projectData.project.name = name;
      Tabs.rename(W.workflow, name);
      loadLibrary().catch(() => {});
    }
  }
  draw();
  syncToolbar();
  if (!first) Inspector.refresh();
  else Inspector.show();
  return true;
}

/** What the canvas does not draw: what a collapsed Complex Node hides (every node and group inside it, including inner Complex Nodes). */
function hiddenSets() {
  const nodes = new Set(),
    groups = new Set(),
    folded = new Set(), // hidden by a collapsed group (still placed: they move with it)
    holders = new Map(); // node or Complex Node hidden by a collapsed group -> the outermost collapsed group
  for (const cx of W.snapshot.complex)
    if (cx.collapsed) {
      cx.members.forEach(id => nodes.add(id));
      for (const g of W.snapshot.groups) if (g.id === cx.id || isUnder(g, cx.id)) groups.add(g.id);
    }
  // A collapsed plain group hides what is in it, the groups inside it and the Complex Nodes inside it.
  for (const group of [...W.snapshot.groups].sort((a, b) => a.depth - b.depth)) {
    if (!group.folded || W.complex.has(group.id) || groups.has(group.id) || holders.has('group:' + group.id)) continue;
    const inside = [group, ...descendantGroups(group.id)];
    for (const g of inside) {
      if (g !== group) groups.add(g.id);
      for (const id of g.members) holders.set(id, group.id);
      if (g !== group && W.complex.has(g.id)) holders.set('complex:' + g.id, group.id);
      if (g !== group) holders.set('group:' + g.id, group.id);
    }
    for (const id of group.all_members) {
      nodes.add(id);
      folded.add(id);
    }
    for (const g of inside)
      if (g !== group && W.complex.has(g.id)) {
        nodes.add('complex:' + g.id);
        folded.add('complex:' + g.id);
      }
  }
  return {nodes, groups, folded, holders};
}
const isUnder = (group, ancestor) => isInside(W.groups, group, ancestor);
function visibleNodes() {
  const cache = canvasGraphCache();
  return (cache.nodes ??= [...W.nodes.values()].filter(
    n => !W.hidden.nodes.has(n.id) && (n.kind !== 'complex' || n.collapsed)
  ));
}
// Visibility and port resolution depend on the graph, not selection, execution status or camera.
function canvasGraphCache() {
  if (W.graphCache?.snapshot !== W.snapshot || W.graphCache?.hidden !== W.hidden) {
    W.graphCache = {
      snapshot: W.snapshot,
      hidden: W.hidden,
      chains: new Map(),
      descendants: new Map(),
      complexOf: new Map(),
    };
    W.innerNodeCache = new WeakMap();
  }
  return W.graphCache;
}
/** The groups a node sits in, innermost first. */
function groupChain(id) {
  const cache = canvasGraphCache();
  if (!cache.chains.has(id)) {
    const chain = [];
    for (let g = W.snapshot.groups.find(x => x.members.includes(id)), n = 0; g && n < 64; g = W.groups.get(g.parent), n++)
      chain.push(g);
    cache.chains.set(id, chain);
  }
  return cache.chains.get(id);
}
function descendantGroups(gid) {
  const cache = canvasGraphCache();
  if (!cache.descendants.has(gid)) cache.descendants.set(gid, W.snapshot.groups.filter(g => isUnder(g, gid)));
  return cache.descendants.get(gid);
}
/** Everything that moves with a group frame: its nodes and collapsed Complex Nodes, also in subgroups. */
function frameContent(gid) {
  const group = W.groups.get(gid),
    groups = [group, ...descendantGroups(gid)];
  const ids = groups.flatMap(g => g.members).filter(id => !W.hidden.nodes.has(id) || W.hidden.folded.has(id));
  for (const g of groups)
    if (
      W.complex.get(g.id)?.collapsed &&
      g.id !== gid &&
      (!W.hidden.nodes.has('complex:' + g.id) || W.hidden.folded.has('complex:' + g.id))
    )
      ids.push('complex:' + g.id);
  return {ids, groups};
}
const selectionIdOf = gid => (W.complex.get(gid)?.collapsed ? 'complex:' + gid : 'frame:' + gid);

function position(node) {
  const saved = node.position;
  if (saved) return {x: saved.x, y: saved.y};
  if (node.kind === 'complex') {
    const points = node.members
      .filter(id => !id.startsWith('complex:'))
      .map(id => W.pos.get(id) || W.nodes.get(id)?.position)
      .filter(Boolean);
    return {x: Math.min(0, ...points.map(p => p.x)), y: Math.min(0, ...points.map(p => p.y))};
  }
  return {x: 0, y: 0};
}
