// Phone navigation: bottom destinations, section tabs, and a tree in an accessible sheet.
'use strict';
const phoneLayout = matchMedia('(max-width: 760px)');
/** Whether the canvas side panel is hidden: the phone layout remembers its own choice; unless chosen, narrow screens start with it hidden. */
const sideHiddenKey = () => (phoneLayout.matches ? 'agentsys-side-hidden-mobile' : 'agentsys-side-hidden');
const sideHidden = () => store.get(sideHiddenKey(), narrowSidebar.matches);
for (const link of $$('#sidebar [data-section]')) link.setAttribute('aria-label', SECTION_TITLES[link.dataset.section]);
let desktopSubnavFolded = document.body.classList.contains('subnav-collapsed');
let mobileReturnFocus = null;
function toggleMobileNavigation(open = !document.body.classList.contains('mobile-subnav-open')) {
  if (!phoneLayout.matches) return;
  document.body.classList.toggle('mobile-subnav-open', open);
  $('#mobile-nav-backdrop').hidden = !open;
  $('#mobile-browse').setAttribute('aria-expanded', String(open));
  $('main').inert = open;
  const panel = $('#subnav');
  if (open) {
    mobileReturnFocus = document.activeElement;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    $('#mobile-subnav-close').focus({preventScroll: true});
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    if (mobileReturnFocus?.isConnected) mobileReturnFocus.focus({preventScroll: true});
    mobileReturnFocus = null;
  }
  requestAnimationFrame(() => placePills(true, true));
}
function syncMobileNavigation() {
  const bar = $('#mobile-secondary');
  if (!bar) return;
  const section = sectionOf(app.route || {}),
    title = SECTION_TITLES[section] || 'Browse';
  $('#mobile-browse-label').textContent = $('#subnav .subnav-row.active a span')?.textContent || title;
  $('#mobile-browse').setAttribute('aria-label', `Browse ${title}`);
  requestAnimationFrame(() => placePills());
}
$('#mobile-browse').onclick = () => toggleMobileNavigation();
$('#mobile-subnav-close').onclick = () => toggleMobileNavigation(false);
$('#mobile-nav-backdrop').onclick = () => toggleMobileNavigation(false);
document.addEventListener(
  'click',
  event => {
    if (!phoneLayout.matches) return;
    if (event.target.closest('.inline-rename')) return;
    const current = event.target.closest('#sidebar a.active[data-section]');
    if (current && (current.id !== 'brand' || app.route?.page === 'home')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleMobileNavigation();
    } else if (event.target.closest('#sidebar [data-section], #subnav a[data-link]')) toggleMobileNavigation(false);
  },
  true
);
document.addEventListener('click', () => {
  if (phoneLayout.matches) syncMobileNavigation();
});
document.addEventListener(
  'keydown',
  event => {
    if (!phoneLayout.matches || !document.body.classList.contains('mobile-subnav-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleMobileNavigation(false);
    }
    if (event.key === 'Tab' && event.target.closest('#subnav')) {
      const controls = $$('button,input,a[href],[tabindex="0"]', $('#subnav')).filter(
        el => !el.disabled && el.getClientRects().length
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  },
  true
);
function updatePhoneLayout() {
  if (phoneLayout.matches) {
    desktopSubnavFolded = document.body.classList.contains('subnav-collapsed');
    document.body.classList.remove('subnav-collapsed');
  } else {
    document.body.classList.remove('mobile-subnav-open');
    $('#subnav').removeAttribute('role');
    $('#subnav').removeAttribute('aria-modal');
    mobileReturnFocus = null;
    document.body.classList.toggle('subnav-collapsed', desktopSubnavFolded);
    $('#mobile-nav-backdrop').hidden = true;
    $('main').inert = false;
    $('#subnav').removeAttribute('role');
    $('#subnav').removeAttribute('aria-modal');
  }
  syncMobileNavigation();
  if ($('#side')) Inspector.toggle(!sideHidden(), false);
  requestAnimationFrame(() => placePills(true, true));
}
phoneLayout.addEventListener('change', updatePhoneLayout);
updatePhoneLayout();
let restingViewportHeight = innerHeight;
function updateVisualViewport() {
  const view = window.visualViewport;
  const visible = view?.height || innerHeight;
  const editing = document.activeElement?.matches(
    'input:not([type=checkbox]):not([type=radio]):not([type=color]):not([type=file]),textarea,select'
  );
  if (!editing) restingViewportHeight = innerHeight;
  document.documentElement.style.setProperty('--visual-height', visible + 'px');
  document.body.classList.toggle(
    'keyboard-open',
    phoneLayout.matches && editing && Math.max(restingViewportHeight, innerHeight) - visible > 140
  );
  if (phoneLayout.matches)
    for (const menu of $$('.popup:not(.closing),.submenu'))
      menu.style.top = Math.max(8, Math.min(parseFloat(menu.style.top) || 8, visible - menu.offsetHeight - 8)) + 'px';
}
window.visualViewport?.addEventListener('resize', updateVisualViewport);
window.addEventListener('resize', updateVisualViewport);
document.addEventListener('focusin', updateVisualViewport);
document.addEventListener('focusout', updateVisualViewport);
updateVisualViewport();

/** Two touches on empty canvas zoom around their centre; single-touch dragging keeps its existing behaviour. */
function wireCanvasTouch(canvas) {
  const points = new Map(),
    controller = new AbortController();
  let pinch = null,
    cancelling = false;
  leaveGuards.push(() => controller.abort());
  canvas.addEventListener(
    'pointerdown',
    event => {
      if (
        event.pointerType !== 'touch' ||
        event.target.closest('input,textarea,button,select,.toolbar,.map,.selection-tools')
      )
        return;
      if (pinch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      points.set(event.pointerId, {x: event.clientX, y: event.clientY, target: event.target});
      if (points.size !== 2) return;
      const [[id, a], [, b]] = [...points];
      if (a.target.closest('.node,.frame,.sock')) {
        points.delete(event.pointerId);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      cancelling = true;
      a.target.dispatchEvent(new PointerEvent('pointercancel', {bubbles: true, pointerId: id, pointerType: 'touch'}));
      cancelling = false;
      const rect = canvas.getBoundingClientRect(),
        x = (a.x + b.x) / 2 - rect.left,
        y = (a.y + b.y) / 2 - rect.top;
      pinch = {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom: W.camera.zoom,
        worldX: W.camera.x + x / W.camera.zoom,
        worldY: W.camera.y + y / W.camera.zoom,
      };
      event.preventDefault();
      event.stopImmediatePropagation();
      canvas.setPointerCapture(event.pointerId);
    },
    true
  );
  canvas.addEventListener(
    'pointermove',
    event => {
      if (!points.has(event.pointerId)) return;
      Object.assign(points.get(event.pointerId), {x: event.clientX, y: event.clientY});
      if (!pinch || points.size < 2) return;
      const [a, b] = [...points.values()],
        rect = canvas.getBoundingClientRect();
      const zoom = clamp((pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance, MIN_ZOOM, MAX_ZOOM);
      setCamera(
        pinch.worldX - ((a.x + b.x) / 2 - rect.left) / zoom,
        pinch.worldY - ((a.y + b.y) / 2 - rect.top) / zoom,
        zoom
      );
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
  const end = event => {
    if (cancelling || !points.has(event.pointerId)) return;
    points.delete(event.pointerId);
    if (points.size < 2) pinch = null;
  };
  window.addEventListener('pointerup', end, {capture: true, signal: controller.signal});
  window.addEventListener('pointercancel', end, {capture: true, signal: controller.signal});
}
