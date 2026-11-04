// The workflow canvas page: state object W, toolbar and mounting (PAGES.workflow).
// The canvas is split by concern: data, render, camera, selection, interaction, wires, menus, commands, run.
'use strict';

const W = {}; // State of the open workflow; reset by PAGES.workflow.
const MIN_ZOOM = 0.02,
  MAX_ZOOM = 3;

/** A Custom node is called what its title says (“Custom” until it is renamed). */
const nodeLabel = node =>
  node.kind === 'function'
    ? node.config?.title || node.label
    : node.kind === 'group' || node.kind === 'complex'
      ? node.name
      : node.label;
const editToken = () => uuid();
const wf = (body = {}) => ({...body, workflow_id: W.workflow});

PAGES.workflow = async (view, route) => {
  W.unsubscribe?.();
  clearTimeout(W.reloadTimer);
  let project, policy;
  try {
    [project, , policy] = await Promise.all([
      api(`projects/${route.project}`),
      loadLibrary(),
      api(`projects/${route.project}/policy`),
    ]);
  } catch (error) {
    if (app.route !== route) return;
    Tabs.drop(route.workflow);
    throw error;
  }
  if (app.route !== route) return;
  Object.assign(W, {
    project: route.project,
    workflow: route.workflow,
    snapshot: null,
    nodes: new Map(),
    groups: new Map(),
    complex: new Map(),
    hidden: {nodes: new Set(), groups: new Set(), folded: new Set(), holders: new Map()},
    nodeMap: new Map(),
    elements: new Map(),
    pos: new Map(),
    sockets: new Map(),
    selected: new Set(),
    edges: new Set(),
    results: new Map(),
    runStatus: new Map(),
    runs: new Map(), // node id -> how many passes it has had (the backend counts them)
    glowUntil: new Map(), // node id -> when the glow of its last pass may end (performance.now())
    history: {undo: 0, redo: 0},
    drag: null,
    spawn: null,
    reloadTimer: null,
    reloadTask: null,
    policyDirty: false,
    unsubscribe: null,
    camera: null,
    running: false,
    runtimeRevision: null,
    runtimeState: {},
    runPaused: false,
    executionReady: false,
    executionCommand: null,
    executionStatus: 'idle',
    mapDrag: null,
    frameWork: new Map(),
    frameHandle: 0,
    graphCache: null,
    nodeSignatures: new WeakMap(),
    innerNodeCache: new WeakMap(),
    dirtyGeometry: new Set(),
    socketKeys: new Map(),
    frameElements: new Map(),
    wireElements: new Map(),
    sceneRevision: 0,
    minimapScene: null,
    minimapTheme: null,
    viewportSize: null,
  });
  W.projectData = project;
  W.policy = policy;
  const workflow = project.workflows.find(w => w.id === route.workflow);
  if (!workflow) {
    Tabs.drop(route.workflow);
    throw new Error('This workflow no longer exists.');
  }
  W.library = route.project.startsWith('lib-') ? route.project.slice(4) : null;
  if (W.library && !developerMode()) {
    Tabs.dropProject(route.project);
    return go('/library', true);
  }
  Tabs.open({
    project: route.project,
    workflow: route.workflow,
    title: W.library ? project.project.name : workflow.name,
    sub: W.library ? '' : project.project.name,
    library: !!W.library,
    icon: W.library ? (app.resources || []).find(r => r.id === W.library)?.payload.icon || '' : '',
  });
  const collapsed = sideHidden();
  view.innerHTML = `<div class="editor opening" data-side-collapsed="${collapsed}">
    <div class="canvas" id="canvas" tabindex="0" aria-label="Workflow canvas">
      <div class="toolbar" role="toolbar" aria-label="Workflow actions">
        ${W.library ? '' : `<button class="run" id="start" title="Run the workflow (${esc(shortcutText('run'))})">${icon('play')}<span>Run</span></button><button class="icon" id="pause" title="Pause graph" aria-label="Pause graph" hidden>${icon('pause')}</button>`}
        <button class="icon mobile-only" type="button" data-empty-add title="Add node" aria-label="Add node">${icon('plus')}</button>
        <button class="icon" id="undo" title="Undo (${esc(shortcutText('undo'))})" aria-label="Undo">${icon('undo')}</button>
        <button class="icon" id="redo" title="Redo (${esc(shortcutText('redo'))})" aria-label="Redo">${icon('redo')}</button>
        ${W.library ? '' : `<button class="icon" data-menu="workflow:${esc(W.project)}:${esc(W.workflow)}" title="Workflow actions" aria-label="Workflow actions">${icon('dots')}</button>`}
        <span id="run-summary" role="status" aria-live="polite"></span>
      </div>
      <div class="world" id="world"><div id="frames"></div><svg class="wires" id="wires"></svg><div id="nodes"></div></div>
      <div class="marquee" id="marquee" hidden></div>
      <div id="unparent-zone" class="unparent-zone">Drop here to take out of the group</div>
      <div id="selection-tools" class="selection-tools" hidden><button class="icon" data-selection-color title="Color" aria-label="Node color">${icon('palette')}</button><button class="icon" data-selection-disable title="Disable" aria-label="Disable">${icon('power')}</button><button class="icon" data-selection-pin title="Pin" aria-label="Pin node">${icon('pin')}</button><button class="icon mobile-only" type="button" data-selection-actions aria-label="Node actions">${icon('dots')}</button></div>
      <div class="canvas-empty" id="canvas-empty" hidden>${W.library ? '<h2>Build a Custom Node</h2>' : '<h2>Build a workflow</h2>'}<button class="primary" data-empty-add>${icon('plus')}Add node</button></div>
      <div class="map${store.get('agentsys-minimap-hidden', phoneLayout.matches) ? ' collapsed' : ''}"><div class="map-view"><canvas id="minimap" width="180" height="112" aria-label="Minimap"></canvas></div><div class="zoom">
        <button class="icon" id="zoom-out" aria-label="Zoom out">−</button><span id="zoom-level">100%</span><button class="icon" id="zoom-in" aria-label="Zoom in">+</button>
        <button class="icon" id="fit" title="Fit to view (${esc(shortcutText('fit'))})" aria-label="Fit to view">${icon('fit')}</button>
        <button class="icon map-toggle" id="map-toggle" aria-controls="minimap">${icon('chevron')}</button></div></div>
      <div class="hints" id="hints"><div class="hint-list" id="hint-list"></div><button class="icon" type="button" id="snap-toggle" aria-pressed="false" aria-label="Snap to the grid">${icon('magnet')}</button><button class="icon" type="button" id="hints-toggle" aria-pressed="true" aria-label="Key hints">${icon('keyboard')}</button></div>
    </div>
    <aside class="side" id="side" data-collapsed="${collapsed}"></aside>
  </div>`;
  W.canvas = $('#canvas');
  W.executionSession = {canvas: W.canvas, project: W.project, workflow: W.workflow, revision: 0, starts: new Set()};
  W.world = $('#world');
  wireCanvas();
  Inspector.mount($('#side'));
  // Subscribe before reading the first snapshot: a hook may finish while the page is mounting.
  W.unsubscribe = Backend.subscribe(
    keys => {
      if (app.route !== route) return;
      if (keys.includes('policy:' + route.project)) W.policyDirty = true;
      if (keys.includes('wf:' + route.workflow) || keys.includes('policy:' + route.project)) scheduleReload();
    },
    {own: true}
  );
  leaveGuards.push(async () => {
    for (const element of W.elements.values()) forgetFieldHeights(element);
    clearTimeout(W.reloadTimer);
    W.executionSession?.unfollow?.();
    W.unsubscribe?.();
    W.unsubscribe = null;
    return Inspector.leave();
  });
  await reload(true);
  if (app.route !== route) return;
  if (W.library && W.snapshot.root) select(['frame:' + W.snapshot.root]);
  // Opening a graph fits it to the view; coming back to a tab already shown this session restores its camera.
  const tabKey = Tabs.key(route),
    camera = Tabs.seen.has(tabKey) ? loadCamera() : null;
  Tabs.seen.add(tabKey);
  if (camera) setCamera(camera.x, camera.y, camera.zoom);
  else fit();
  const focus = routeQuery().get('node');
  if (focus) reveal(focus);
  const execution = await api('projects/' + W.project + '/execution', {query: {workflow_id: W.workflow}});
  if (app.route !== route) return;
  W.executionReady = true;
  followExecution(execution).catch(fail);
  const editor = $('.editor', view);
  requestAnimationFrame(() => requestAnimationFrame(() => editor.classList.remove('opening')));
};
