// The page frame: sidebar toggle and resizing, panel resizing, global search and boot(). The navigation itself is in nav.js.
'use strict';

function toggleSidebar(expand, persist = true) {
  const mobile = matchMedia('(max-width: 760px)').matches,
    className = mobile ? 'mobile-sidebar-hidden' : 'sidebar-hidden',
    key = mobile ? 'agentsys-mobile-sidebar-collapsed' : 'agentsys-sidebar-collapsed';
  expand ??= document.body.classList.contains(className);
  document.body.classList.toggle(className, !expand);
  if (persist) store.set(key, !expand);
  syncSubnavToggle();
}
const narrowSidebar = matchMedia('(max-width: 900px)');
function restoreSidebar() {
  const mobile = matchMedia('(max-width: 760px)').matches;
  toggleSidebar(mobile
    ? !store.get('agentsys-mobile-sidebar-collapsed', false)
    : !narrowSidebar.matches && !store.get('agentsys-sidebar-collapsed', true), false);
}
store.ready.then(restoreSidebar).catch(fail);
narrowSidebar.addEventListener('change', restoreSidebar);
$('#open-search').onclick = () => openSearch();

// A browser close is not a route change, so the leave guards do not run. Warn only when an autosave or an inline
// edit still holds text that was not sent; a clean page closes silently.
addEventListener('beforeunload', event => {
  let dirty = false;
  try {
    dirty = !!(app.pageSave?.element?.isConnected && app.pageSave.isDirty?.());
    if (!dirty && typeof W !== 'undefined' && W?.inlineDirty) dirty = W.inlineDirty();
  } catch {
    dirty = false;
  }
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

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
  store.ready.then(() => commit(clamp(Number(store.get(key)) || initial, min, max))).catch(fail);
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
  store.ready.then(() => setWidth(Number(store.get(key)) || 232)).catch(fail);
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
        body.style.setProperty('--sidebar-live-width', live + 'px');
        body.classList.toggle('sidebar-hidden', !expand);
        body.classList.toggle('sidebar-will-collapse', !expand);
      },
      e => {
        body.classList.remove('resizing-panel', 'sidebar-dragging', 'sidebar-will-collapse');
        side.style.width = '';
        body.style.removeProperty('--sidebar-live-width');
        if (e.type === 'pointercancel') return toggleSidebar(!wasHidden);
        if (expand) setWidth(live);
        toggleSidebar(expand);
      }
    );
  };
})();
/** Second panel: the same draggable boundary as the sidebar's; a narrow drag folds it to icons, a drag on the folded one opens it. */
function syncSubnavToggle() {
  const open = matchMedia('(max-width: 760px)').matches
    ? !document.body.classList.contains('mobile-sidebar-hidden')
    : !document.body.classList.contains('sidebar-hidden');
  const button = $('#toggle-subnav');
  button.setAttribute('aria-controls', 'sidebar');
  button.setAttribute('aria-expanded', String(open));
  button.title = open ? 'Collapse navigation' : 'Expand navigation';
  button.setAttribute('aria-label', button.title);
}
function toggleSubnav(expand = document.body.classList.contains('subnav-collapsed')) {
  document.body.classList.toggle('subnav-collapsed', !expand);
  store.set('agentsys-subnav-collapsed', !expand);
  syncSubnavToggle();
}
$('#toggle-subnav').onclick = () => {
  toggleSidebar();
};
(function subnavResize() {
  const body = document.body;
  store.ready
    .then(() => {
      toggleSubnav(!store.get('agentsys-subnav-collapsed', false));
    })
    .catch(fail);
  const handle = panelResize($('#subnav'), {
    edge: 'right',
    key: 'agentsys-subnav-width',
    initial: 232,
    min: 170,
    max: 420,
    setWidth: width => body.style.setProperty('--subnav-width', width + 'px'),
    collapse: () => toggleSubnav(false),
    expand: () => toggleSubnav(true),
    isCollapsed: () => body.classList.contains('subnav-collapsed'),
  });
  handle.ondblclick = () => toggleSubnav();
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
    {label: 'Server', hint: 'Page', href: '/environments'},
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
  if (typeof Extensions !== 'undefined') found.push(...Extensions.destinations());
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
    const commands =
      typeof Extensions === 'undefined'
        ? []
        : Extensions.commands()
            .filter(c => !q || `${c.title} ${c.pluginTitle}`.toLowerCase().includes(q))
            .slice(0, q ? 6 : 4);
    const found = q ? await api('search/nodes', {query: {q: text, limit: 50}}) : {nodes: []};
    if (mine !== sequence || !input.isConnected) return;
    results.innerHTML =
      (go_.length ? `<h3>Go to</h3>${go_.map(d => link(d.href, d.label, d.hint)).join('')}` : '') +
        (commands.length
          ? `<h3>Commands</h3>${commands
              .map(
                c =>
                  `<button type="button" class="search-command" data-command="${esc(c.key)}"><strong>${esc(c.title)}</strong><span class="muted small">Plugin · ${esc(c.pluginTitle)}</span></button>`
              )
              .join('')}`
          : '') +
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
  // Enter opens the first result; the arrow keys walk the list. Escape closes the search from the field as well:
  // a `type="search"` input would otherwise spend the first Escape on clearing its text in Chromium.
  input.onkeydown = event => {
    const first = $('a, button', results);
    if (event.key === 'Escape') {
      event.preventDefault();
      $('#modal').close();
    } else if (event.key === 'Enter' && first) {
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
    const links = $$('a, button', results),
      next = links[links.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    (next || input).focus();
  };
  results.onclick = event => {
    const command = event.target.closest('[data-command]');
    if (command) {
      $('#modal').close();
      Extensions.execute(command.dataset.command).catch(() => {});
      return;
    }
    if (event.target.closest('a')) $('#modal').close();
  };
  run().catch(fail);
}

// ----- environments -----
const ENVIRONMENT_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  unauthorized: 'Unauthorized',
  incompatible: 'Incompatible version',
  error: 'Connection error',
};
let lastEnvironmentStatus = null;

function renderEnvironmentIndicator(state = Environment.status()) {
  const button = $('#environment-indicator');
  if (!button) return;
  const name = state.environment?.name || 'Server';
  $('.env-name', button).textContent = name;
  $('.env-dot', button).dataset.status = state.status;
  button.title = `Server: ${name} · ${ENVIRONMENT_LABEL[state.status] || state.status}${
    state.detail ? ' · ' + state.detail : ''
  }`;
  button.setAttribute('aria-label', button.title);
}

/** Used by the Manage servers page: switch the active server and report a failed connection. */
async function chooseEnvironment(id) {
  toast('Switching server…');
  const ok = await Environment.setActive(id);
  if (!ok) {
    toast(stateMessage(Environment.status()), true);
    await go('/environments');
  }
}

const stateMessage = state => {
  if (state.status === 'unauthorized') return 'This server requires a token. Add it on the Server page.';
  if (state.status === 'incompatible') return state.detail || 'This client and server speak different protocol versions.';
  if (state.status === 'disconnected') return state.detail || 'The server could not be reached.';
  return state.detail || 'The server is not connected.';
};

// ----- boot -----
async function boot() {
  await store.ready;
  Tabs.load();
  renderEnvironmentIndicator();
  Environment.subscribeStatus(state => {
    renderEnvironmentIndicator(state);
    const was = lastEnvironmentStatus;
    lastEnvironmentStatus = state.status;
    // A client that lost the stream for a while gets the current state, never a replay of its own mutations.
    if (was && was !== 'connected' && state.status === 'connected' && app.booted) refreshAfterReconnect().catch(fail);
    if (state.status === 'unauthorized' && was !== 'unauthorized' && app.booted)
      toast('The server rejected this client. Add its token on the Server page.', true);
  });
  const connected = await Environment.start();
  lastEnvironmentStatus = Environment.status().status;
  if (!connected) {
    await go('/environments', true).catch(error => {
      $('#view').innerHTML = `<div class="empty"><h2>Could not open Server</h2><p>${esc(error.message)}</p></div>`;
    });
    return;
  }
  const session = await api('session');
  Object.assign(app, {preferences: session.preferences, shortcutDefaults: session.shortcut_defaults});
  applyStyle(session.preferences.style);
  await api('library/builtin', {method: 'POST', body: {}}).catch(() => {}); // the built-in nodes join the Library
  await Promise.all([loadLibrary(), loadProjects(), loadPlugins()]);
  app.booted = true;
  await render();
  await Tabs.refreshRuntimes();
}

async function refreshAfterReconnect() {
  const route = app.route;
  await Promise.all([loadProjects().catch(() => {}), loadLibrary().catch(() => {}), loadPlugins().catch(() => {})]);
  if (route && ['workflow', 'project', 'home', 'resources'].includes(route.page)) await render().catch(() => {});
  await Tabs.refreshRuntimes().catch(() => {});
}

/** Flush every open editor and forget per-server view state before the transport points somewhere else. */
Environment.onBeforeSwitch(async () => {
  if (!app.booted) return;
  try {
    await flushNodeEdits?.();
  } catch {}
  app.pageDispose?.();
  app.pageDispose = null;
  Tabs.items = [];
  Tabs.pages = {};
  Tabs.runtimes.clear();
  Tabs.seen.clear();
  Tabs.save();
  Tabs.render();
  app.projects = [];
  app.resources = [];
  navOpen.clear();
  projectTree.workflows.clear();
});
Environment.onAfterSwitch(async () => {
  if (!app.booted) return;
  const session = await api('session');
  Object.assign(app, {preferences: session.preferences, shortcutDefaults: session.shortcut_defaults});
  applyStyle(session.preferences.style);
  await api('library/builtin', {method: 'POST', body: {}}).catch(() => {});
  // A plugin's private storage is scoped to the environment, and its UI may show what it read there: restart the
  // sandboxes so nothing from the previous server is still on screen or in memory.
  await Promise.all([loadLibrary(), loadProjects(), loadPlugins({reload: true})]);
  await go('/');
  toast(`Connected to ${Environment.status().environment?.name || 'the server'}.`);
});

Environment.subscribe(keys => {
  if (!app.booted) return;
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
Environment.subscribeHooks(entry =>
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
