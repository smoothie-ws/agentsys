// Pan, zoom, fit and reveal.
'use strict';

// ----- camera -----
function viewRect() {
  const c = W.camera || {x: 0, y: 0, zoom: 1};
  const size = W.viewportSize ?? (W.viewportSize = {width: W.canvas.clientWidth, height: W.canvas.clientHeight});
  return {x: c.x, y: c.y, w: size.width / c.zoom, h: size.height / c.zoom};
}
function setCamera(x, y, zoom) {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const zoomChanged = W.camera?.zoom !== zoom;
  W.camera = {x, y, zoom};
  W.world.style.transform = `scale(${zoom}) translate(${-x}px,${-y}px)`;
  if (zoomChanged) W.world.style.setProperty('--sw', `${1.25 / zoom}px`);
  // Two nested grid levels crossfade; every fourth point becomes the next level.
  const level = Math.floor(Math.log(1 / zoom) / Math.log(4)),
    spacing = 24 * 4 ** level * zoom;
  const phase = Math.log(1 / zoom) / Math.log(4) - level;
  const fineOpacity = 1 - phase,
    coarseOpacity = phase;
  const fineRadius = spacing / 24,
    coarseRadius = spacing / 6;
  if (zoomChanged) {
    W.canvas.style.backgroundImage = `radial-gradient(circle, color-mix(in srgb, var(--theme-canvas-grid, var(--grid-colour)) ${fineOpacity * 100}%, transparent) ${fineRadius}px, transparent ${fineRadius + 0.35}px), radial-gradient(circle, color-mix(in srgb, var(--theme-canvas-grid, var(--grid-colour)) ${coarseOpacity * 100}%, transparent) ${coarseRadius}px, transparent ${coarseRadius + 0.35}px)`;
    W.canvas.style.backgroundSize = `${spacing}px ${spacing}px, ${spacing * 4}px ${spacing * 4}px`;
    $('#zoom-level').textContent = Math.round(zoom * 100) + '%';
  }
  // CSS gradients center each dot in its tile, so offset both levels to the same world origin.
  W.canvas.style.backgroundPosition = `${-x * zoom - spacing / 2}px ${-y * zoom - spacing / 2}px, ${-x * zoom - spacing * 2}px ${-y * zoom - spacing * 2}px`;
  onNextFrame('camera', () => {
    drawSelectionTools();
    drawMinimap();
  });
  // Saved a moment later; the key and the view are taken now, so opening another workflow in between cannot mix them up.
  const key = 'agentsys-camera:' + W.workflow,
    view = W.camera;
  clearTimeout(W.cameraTimer);
  W.cameraTimer = setTimeout(() => store.set(key, view), 300);
}
const loadCamera = () => store.get('agentsys-camera:' + W.workflow);
function toWorld(clientX, clientY) {
  const rect = W.canvas.getBoundingClientRect(),
    c = W.camera;
  return {x: c.x + (clientX - rect.left) / c.zoom, y: c.y + (clientY - rect.top) / c.zoom};
}
function zoomAt(clientX, clientY, factor) {
  const before = toWorld(clientX, clientY),
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, W.camera.zoom * factor)),
    rect = W.canvas.getBoundingClientRect();
  setCamera(before.x - (clientX - rect.left) / zoom, before.y - (clientY - rect.top) / zoom, zoom);
}
function fit(ids) {
  const boxes = (ids ? [...ids] : [...W.pos.keys()]).map(id => W.pos.get(id)).filter(p => p && p.w);
  if (!boxes.length) return setCamera(-80, -80, 1);
  const x0 = Math.min(...boxes.map(b => b.x)),
    y0 = Math.min(...boxes.map(b => b.y)),
    x1 = Math.max(...boxes.map(b => b.x + b.w)),
    y1 = Math.max(...boxes.map(b => b.y + b.h));
  const padX = Math.min(120, W.canvas.clientWidth * 0.12), // 120px on a wide canvas, less on a phone
    padY = Math.min(120, W.canvas.clientHeight * 0.12);
  const zoom = Math.min(1.1, (W.canvas.clientWidth - padX) / (x1 - x0), (W.canvas.clientHeight - padY) / (y1 - y0));
  setCamera(
    (x0 + x1) / 2 - W.canvas.clientWidth / 2 / Math.max(MIN_ZOOM, zoom),
    (y0 + y1) / 2 - W.canvas.clientHeight / 2 / Math.max(MIN_ZOOM, zoom),
    zoom
  );
}
function reveal(id) {
  if (id.startsWith('group:')) {
    const gid = id.slice(6);
    if (!W.groups.has(gid)) return;
    const outer = W.snapshot.complex
      .filter(c => c.collapsed && (c.id === gid || isUnder(W.groups.get(gid), c.id)))
      .sort((a, b) => a.depth - b.depth)[0];
    id = outer ? 'complex:' + outer.id : 'frame:' + gid;
  } else {
    if (!W.nodes.has(id)) return;
    const outer = W.snapshot.complex
      .filter(c => c.collapsed && c.members.includes(id))
      .sort((a, b) => a.depth - b.depth)[0];
    if (outer) id = 'complex:' + outer.id;
  }
  select([id]);
  fit([id]);
  if (W.camera.zoom > 1) setCamera(W.camera.x, W.camera.y, 1);
}
