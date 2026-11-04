// The page frame: sidebar toggle and resizing, panel resizing, global search and boot(). The navigation itself is in nav.js.
'use strict';

function toggleSidebar(expand = document.body.classList.contains('sidebar-hidden'), persist = true) {
  document.body.classList.toggle('sidebar-hidden', !expand);
  if (persist) store.set('agentsys-sidebar-collapsed', !expand);
}
if (store.get('agentsys-sidebar-collapsed')) toggleSidebar(false);
const narrowSidebar = matchMedia('(max-width: 900px)');
if (narrowSidebar.matches) toggleSidebar(false, false);
narrowSidebar.addEventListener('change', event => {
  if (event.matches) toggleSidebar(false, false);
  else toggleSidebar(!store.get('agentsys-sidebar-collapsed', false), false);
});
$('#open-search').onclick = () => openSearch();

/** A keyboard-reachable separator on a panel's boundary; it sits just outside the panel (see .panel-resize). */
function resizeHandle(panel, edge, label, onkeydown) {
  const handle = document.createElement('div');
  handle.className = 'panel-resize edge-' + edge;
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', label);
  handle.onkeydown = onkeydown;
  panel.append(handle);
  return handle;
}
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const STEP = 24;

/** Resize a panel from its boundary; a narrow drag collapses it on release. */
function panelResize(panel, {edge, key, initial, min, max, setWidth, collapse, expand, isCollapsed}) {
  const sign = edge === 'left' ? -1 : 1;
  let width = clamp(Number(store.get(key)) || initial, min, max);
  const commit = value => {
    width = clamp(value, min, max);
    setWidth(width);
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    store.set(key, width);
  };
  const handle = resizeHandle(panel, edge, 'Resize panel', event => {
    if (event.key === 'Home') collapse();
    else if (event.key === 'End') expand();
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      expand();
      commit(width + (event.key === 'ArrowRight' ? STEP : -STEP) * sign);
    } else return;
    event.preventDefault();
  });
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  // Dragging the boundary of a collapsed panel opens it, the way the left sidebar does.
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = event.clientX,
      original = width,
      wasCollapsed = isCollapsed?.() ?? false,
      from = wasCollapsed ? 56 : width;
    let next = from;
    document.body.classList.add('resizing-panel');
    drag(
      event,
      e => {
        next = from + (e.clientX - start) * sign;
        const open = next >= min * 0.5;
        if (wasCollapsed && open === isCollapsed()) (open ? expand : collapse)();
        setWidth(clamp(next, 56, max));
        if (!wasCollapsed) panel.classList.toggle('collapse-ready', !open);
      },
      e => {
        document.body.classList.remove('resizing-panel');
        panel.classList.remove('collapse-ready');
        if (e.type === 'pointercancel') {
          if (wasCollapsed && !isCollapsed()) collapse();
          return commit(original);
        }
        if (next >= min * 0.5) commit(next);
        else {
          if (!wasCollapsed) collapse();
          requestAnimationFrame(() => commit(original));
        }
      }
    );
  };
  commit(width);
  return handle;
}
/** Left sidebar: the boundary follows the pointer; the layout previews what release will do. */
(function sidebarResize() {
  const side = $('#sidebar'),
    body = document.body,
    RAIL = 56,
    MIN = 180,
    MAX = 420,
    key = 'agentsys-sidebar-width';
  let width = Number(store.get(key)) || 232;
  const setWidth = value => {
    width = clamp(value, MIN, MAX);
    body.style.setProperty('--sidebar-width', width + 'px');
    store.set(key, width);
  };
  setWidth(width);
  const handle = resizeHandle(side, 'right', 'Resize sidebar', event => {
    if (event.key === 'Home') toggleSidebar(false);
    else if (event.key === 'End') toggleSidebar(true);
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !body.classList.contains('sidebar-hidden'))
      setWidth(width + (event.key === 'ArrowRight' ? STEP : -STEP));
    else return;
    event.preventDefault();
  });
  handle.ondblclick = () => toggleSidebar();
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const startX = event.clientX,
      startWidth = side.getBoundingClientRect().width,
      wasHidden = body.classList.contains('sidebar-hidden');
    let expand = !wasHidden,
      live = startWidth;
    body.classList.add('resizing-panel', 'sidebar-dragging');
    drag(
      event,
      e => {
        live = clamp(startWidth + e.clientX - startX, RAIL, MAX);
        expand = live >= (RAIL + MIN) / 2;
        side.style.width = live + 'px';
        body.classList.toggle('sidebar-hidden', !expand);
        body.classList.toggle('sidebar-will-collapse', !expand);
        body.classList.toggle('sidebar-will-expand', expand && wasHidden);
      },
      e => {
        body.classList.remove('resizing-panel', 'sidebar-dragging', 'sidebar-will-collapse', 'sidebar-will-expand');
        side.style.width = '';
        if (e.type === 'pointercancel') return toggleSidebar(!wasHidden);
        if (expand) setWidth(live);
        toggleSidebar(expand);
      }
    );
  };
})();
/** Second panel: the same draggable boundary as the sidebar's; a narrow drag folds it to icons, a drag on the folded one opens it. */
(function subnavResize() {
  const body = document.body,
    toggle = (expand = body.classList.contains('subnav-collapsed')) => {
      body.classList.toggle('subnav-collapsed', !expand);
      store.set('agentsys-subnav-collapsed', !expand);
    };
  if (store.get('agentsys-subnav-collapsed')) toggle(false);
  const handle = panelResize($('#subnav'), {
    edge: 'right',
    key: 'agentsys-subnav-width',
    initial: 232,
    min: 170,
    max: 420,
    setWidth: width => body.style.setProperty('--subnav-width', width + 'px'),
    collapse: () => toggle(false),
    expand: () => toggle(true),
    isCollapsed: () => body.classList.contains('subnav-collapsed'),
  });
  handle.ondblclick = () => toggle();
})();
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && keyCode(event) === 'KeyK') {
    event.preventDefault();
    openSearch();
  }
});

/** Everything one can jump to by name: the pages, the Library sections, every project and every workflow. */
async function destinations() {
  const found = [
    {label: 'Dashboard', hint: 'Page', href: '/'},
    {label: 'Projects', hint: 'Page', href: '/projects'},
    {label: 'Library', hint: 'Page', href: '/library'},
    {label: 'API', hint: 'Page', href: '/api'},
    {label: 'Plugins', hint: 'Page', href: '/plugins'},
    {label: 'Settings', hint: 'Page', href: '/settings'},
  ];
  const list = await api('projects'); // fresh: a project made a moment ago by a script is not in the sidebar's list yet
  const projects = await Promise.all(list.map(p => api(`projects/${p.id}`).catch(() => null)));
  for (const data of projects.filter(Boolean)) {
    found.push({label: data.project.name, hint: 'Project', href: `/p/${data.project.id}`});
    for (const wf of data.workflows)
      found.push({label: wf.name, hint: `Workflow · ${data.project.name}`, href: `/p/${data.project.id}/w/${wf.id}`});
  }
  const library = await api('settings').catch(() => ({})); // fresh as well: Library items are part of the places to go to
  for (const r of (library.resources || []).filter(() => library.preferences?.developer_mode))
    found.push({label: r.name, hint: 'Library · Node', href: resourceHref(r)});
  for (const path of library.node_folders || [])
    found.push({label: baseName(path), hint: 'Library · Nodes group', href: folderHref(path)});
  return found;
}

function openSearch() {
  dialog(
    'Search',
    `<input id="search-input" type="search" autofocus placeholder="Go to a project, workflow, Library node or page, or find a node or group" autocomplete="off"><div id="search-results" class="search-results"></div>`
  );
  const input = $('#search-input'),
    results = $('#search-results');
  const places = destinations().catch(() => []);
  let timer,
    sequence = 0;
  const link = (href, label, hint) =>
    `<a href="${esc(href)}" data-link><strong>${esc(label)}</strong><span class="muted small">${esc(hint)}</span></a>`;
  const run = async () => {
    if (!input.isConnected || !$('#modal').open) return;
    const mine = ++sequence,
      text = input.value.trim(),
      q = text.normalize('NFKC').toLowerCase();
    const go_ = (await places).filter(d => !q || `${d.label} ${d.hint}`.toLowerCase().includes(q)).slice(0, q ? 8 : 10);
    const found = q ? await api('search/nodes', {query: {q: text, limit: 50}}) : {nodes: []};
    if (mine !== sequence || !input.isConnected) return;
    results.innerHTML =
      (go_.length ? `<h3>Go to</h3>${go_.map(d => link(d.href, d.label, d.hint)).join('')}` : '') +
        (found.nodes.some(n => developerMode() || !n.project_id.startsWith('lib-'))
          ? `<h3>Nodes</h3>${found.nodes
              .filter(n => developerMode() || !n.project_id.startsWith('lib-'))
              .map(n =>
                link(
                  `/p/${n.project_id}/w/${n.workflow_id}?node=${encodeURIComponent(n.id)}`,
                  n.label,
                  `${n.project_name} / ${n.workflow_name} · ${n.kind === 'function' ? n.node_type || 'node' : n.kind}`
                )
              )
              .join('')}`
          : '') || '<p class="muted">Nothing matches.</p>';
  };
  input.oninput = () => {
    sequence++; // invalidate the previous request immediately, including during the debounce
    results.replaceChildren();
    clearTimeout(timer);
    timer = setTimeout(() => run().catch(fail), 150);
  };
  // Enter opens the first result; the arrow keys walk the list.
  input.onkeydown = event => {
    const first = $('a', results);
    if (event.key === 'Enter' && first) {
      event.preventDefault();
      first.click();
    } else if (event.key === 'ArrowDown' && first) {
      event.preventDefault();
      first.focus();
    }
  };
  results.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const links = $$('a', results),
      next = links[links.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    (next || input).focus();
  };
  results.onclick = event => {
    if (event.target.closest('a')) $('#modal').close();
  };
  run().catch(fail);
}

// ----- boot -----
async function boot() {
  const session = await api('session');
  Object.assign(app, {preferences: session.preferences, shortcutDefaults: session.shortcut_defaults});
  applyStyle(session.preferences.style);
  if (!Backend.persistent)
    setTimeout(() => toast('Storage is unavailable here. Changes will be lost when you close this tab.', true), 500);
  await api('library/builtin', {method: 'POST', body: {}}).catch(() => {}); // the built-in nodes join the Library
  await Promise.all([loadLibrary(), loadProjects(), loadPlugins()]);
  await render();
}
Backend.subscribe(keys => {
  if (keys.includes('projects')) {
    loadProjects().catch(() => {});
    for (const key of navOpen) if (key.startsWith('p:')) loadProjectWorkflows(key.slice(2), true);
  }
  if (keys.some(k => k === 'resources' || k.startsWith('node_folder')))
    loadLibrary()
      .then(renderSidebar)
      .catch(() => {});
});
// on_placed, on_deleted, on_input_connected and on_widget run by themselves after a change, so a failure has to be told to the person.
Backend.subscribeHooks(entry =>
  toast(
    `${entry.hook} of ${entry.hook === 'on_deleted' ? 'a Library node' : `[a Library node](node:${entry.node_id})`} failed: ${entry.error}`,
    true
  )
);
document.addEventListener('DOMContentLoaded', () =>
  boot().catch(error => {
    $('#view').innerHTML = `<div class="empty"><h2>Could not open the data</h2><p>${esc(error.message)}</p></div>`;
  })
);
