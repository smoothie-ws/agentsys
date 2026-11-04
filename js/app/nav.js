// Navigation: the sidebar sections and the second panel. Every section is a tree of rows shown in the second panel
// (projects → workflows, Library groups → nodes) and the page beside it shows the open row's children as cards.
// Also the sliding highlight of "connected navigation" (css/nav-joined.css).
'use strict';

// ----- connected navigation follows the Effects appearance preference -----
let navJoinedKey = null;
const applyNavJoined = (on, layoutKey = '') => {
  const switched = document.body.classList.contains('nav-joined') !== on;
  document.body.classList.toggle('nav-joined', on);
  document.documentElement.classList.toggle('nav-joined-root', on);
  if (!switched && layoutKey === navJoinedKey) return; // a colour change leaves every row where it was: no layout pass for it
  navJoinedKey = layoutKey;
  requestAnimationFrame(() => placePills(true, true));
};

/** Which primary section owns a route; Dashboard contains its overview and API. */
function sectionOf(route) {
  if (route.project?.startsWith('lib-')) return 'library'; // a Custom Node is edited as a workflow
  if (route.project || route.page === 'projects') return 'projects';
  return {resources: 'library', plugins: 'plugins', settings: 'settings', api: 'home'}[route.page] || 'home';
}
const SECTION_TITLES = {
  home: 'Dashboard',
  plugins: 'Plugins',
  projects: 'Projects',
  library: 'Library',
  settings: 'Settings',
  api: 'API reference',
};

// ----- the second panel -----
/** The second panel's content: a section fills it from its tree (below), Settings from its page (`mount`). */
const Subnav = {
  changed: false,
  html: '',
  set(section, {title, actions = '', body = ''}) {
    const panel = $('#subnav'),
      area = $('#subnav-body'),
      list = $('#subnav-list'),
      scroll = area.scrollTop,
      changed = panel.dataset.section !== section;
    panel.dataset.section = section;
    $('#subnav-title').textContent = title;
    $('#subnav-actions').innerHTML = actions;
    if (typeof body !== 'string') {
      list.replaceChildren(body);
      this.html = '';
    } else if (changed || body !== this.html) {
      list.innerHTML = this.html = body; // the rows are replaced; the highlight is not among them, so it glides
    }
    if (changed) {
      this.changed = true;
      list.classList.remove('enter');
      void list.offsetWidth; // restart the fade
      list.classList.add('enter');
    }
    area.scrollTop = changed ? 0 : scroll;
    if (typeof syncMobileNavigation === 'function') syncMobileNavigation();
  },
};

// ----- the rows -----
/** The unfolded groups of the trees. Every tree starts folded on each visit; a group opens only when you open it. */
const navOpen = new Set();

/**
 * One row: {key, label, icon, href, count, menu, children, drop, drag}. `children` (an array, or null while they load)
 * makes it a group with a chevron and a branch that unfolds; `menu` is what its "⋯" opens (see menuItems);
 * `drag`/`drop` make it a Custom Node that can be moved, or a place it can be moved to.
 */
const holdsActive = (n, active) => !!n.children?.some(c => c.key === active || holdsActive(c, active));
function navRow(n, active) {
  const group = n.children !== undefined,
    open = group && (n.open ?? navOpen.has(n.key)),
    here = n.key === active;
  const row = `<div class="subnav-row ${here ? 'active' : ''}" data-key="${esc(n.key)}"${n.drop !== undefined ? ` data-drop-folder="${esc(n.drop)}"` : ''}${n.drag ? ` draggable="true" data-drag="${esc(n.drag)}"` : ''}>${
    group
      ? `<button type="button" class="subnav-toggle" aria-label="Show or hide" aria-expanded="${open}">${icon('chevron')}</button>`
      : '<span class="subnav-pad"></span>'
  }${n.href ? `<a href="${esc(n.href)}" data-link title="${esc(n.label)}" ${here ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${esc(n.label)}</span></a>` : `<div class="subnav-static">${icon(n.icon)}<span>${esc(n.label)}</span></div>`}${n.menu ? `<button type="button" class="icon subnav-menu" data-menu="${esc(n.menu)}" aria-label="Actions of ${esc(n.label)}">${icon('dots')}</button>` : ''}</div>`;
  if (!group) return row;
  const kids = n.children ? n.children.map(c => navRow(c, active)).join('') : '';
  return `<div class="subnav-group ${open ? 'open' : ''}${holdsActive(n, active) ? ' on-path' : ''}" data-group="${esc(n.key)}">${row}<div class="subnav-branch"><div>${kids || `<p class="muted small">${n.children ? 'Nothing here yet.' : '…'}</p>`}</div></div></div>`;
}

/** Opens or closes a group; its branch slides, and the highlight follows the rows below it while they move. */
function setGroupOpen(group, open, remember = true) {
  group.classList.toggle('open', open);
  $(':scope > .subnav-row > .subnav-toggle', group)?.setAttribute('aria-expanded', String(open));
  $(':scope > .subnav-row > [data-toggle]', group)?.setAttribute('aria-expanded', String(open));
  if (remember) {
    open ? navOpen.add(group.dataset.group) : navOpen.delete(group.dataset.group);
  }
  if (open && group.dataset.group.startsWith('p:')) loadProjectWorkflows(group.dataset.group.slice(2));
  followPills();
}

// ----- the trees of the sections -----
// Projects form a tree like the API calls: a project, and under it its workflows.
const projectTree = {workflows: new Map()};
async function loadProjects() {
  app.projects = await api('projects');
  renderSidebar();
  return app.projects;
}
async function loadProjectWorkflows(id, force = false) {
  if (!force && projectTree.workflows.has(id)) return;
  try {
    projectTree.workflows.set(id, (await api(`projects/${id}`)).workflows);
  } catch {
    return;
  }
  renderSidebar();
}
/** The groups of Custom Nodes below `parent` with the nodes inside them. */
function folderRows(parent) {
  return [
    ...app.nodeFolders
      .filter(f => parentPath(f) === parent)
      .map(path => ({
        key: folderKey(path),
        label: baseName(path),
        icon: (app.nodeFolderIcons || {})[path] || 'folder',
        href: folderHref(path),
        menu: 'folder:' + path,
        drop: developerMode() ? path : undefined,
        children: folderRows(path),
      })),
    ...app.resources.filter(r => (r.payload.folder || '') === parent).map(resourceRow),
  ];
}
const resourceRow = r => ({
  key: 'r:' + r.id,
  label: r.name,
  icon: resourceIcon(r),
  href: developerMode() ? resourceHref(r) : null,
  menu: 'resource:' + r.id,
  drag: developerMode() ? r.id : undefined,
});
/** What each section shows: the open row (`active`), the groups to unfold to reach it, and the rows. */
// One definition of each primary section. Pages never replace this tree.
const SECTION_PANELS = {
  home: [['overview', 'Overview', 'chart']],
  settings: [
    ['editing', 'Editing', 'settings'],
    ['appearance', 'Appearance', 'palette'],
    ['keyboard-shortcuts', 'Keyboard shortcuts', 'keyboard'],
  ],
};
const sectionHref = (section, key) =>
  (section === 'home' ? '/' : '/' + section) + (SECTION_PANELS[section]?.length > 1 ? '?section=' + key : '');
function panelTree(section) {
  const current = selectedPanel(section);
  return {
    active: 'panel:' + current,
    rows: () =>
      SECTION_PANELS[section].map(([key, label, glyph]) => ({
        key: 'panel:' + key,
        label,
        icon: glyph,
        href: sectionHref(section, key),
        menu: sectionActions(section).length ? 'section:' + section : undefined,
      })),
  };
}
function selectedPanel(section) {
  const definitions = SECTION_PANELS[section],
    requested = routeQuery().get('section');
  return definitions.some(([key]) => key === requested) ? requested : definitions[0][0];
}
const NAV_TREES = {
  home: route => ({
    active: route.page === 'api' ? 'dashboard:api' : 'panel:overview',
    rows: () => [
      ...panelTree('home').rows(),
      {key: 'dashboard:api', label: 'API', icon: 'code', href: '/api', menu: 'section:api'},
    ],
  }),
  settings: () => panelTree('settings'),
  projects: route => ({
    active: route.workflow ? 'w:' + route.workflow : route.project ? 'p:' + route.project : 'overview:projects',
    rows: () => [
      ...(app.projects || []).map(p => {
        const loaded = projectTree.workflows.get(p.id);
        if (!loaded && navOpen.has('p:' + p.id)) loadProjectWorkflows(p.id);
        return {
          key: 'p:' + p.id,
          label: p.name,
          icon: 'folder',
          href: `/p/${p.id}`,
          menu: 'project:' + p.id,
          children: loaded
            ? [
                ...loaded.map(w => ({
                  key: 'w:' + w.id,
                  label: w.name,
                  icon: 'node',
                  href: `/p/${p.id}/w/${w.id}`,
                  menu: `workflow:${p.id}:${w.id}`,
                })),
              ]
            : null,
        };
      }),
    ],
  }),
  plugins: route => ({
    active: route.id ? 'pl:' + route.id : 'overview:plugins',
    rows: () =>
      (app.plugins || []).map(p => ({
        key: 'pl:' + p.id,
        label: p.title,
        icon: 'plug',
        href: '/plugins/' + encodeURIComponent(p.id),
        menu: 'plugin:' + p.id,
      })),
  }),
  library: route => {
    const nodeId = route.project?.startsWith('lib-') ? route.project.slice(4) : route.id;
    return {
      active: nodeId
        ? 'r:' + nodeId
        : route.section
          ? route.folder
            ? folderKey(route.folder)
            : 's:nodes'
          : 'overview:library',
      rows: () => [
        {key: 's:nodes', label: 'Nodes', icon: 'complex', href: NODES_PATH, menu: 'nodes:', children: folderRows('')},
      ],
    };
  },
};
function pageMenu(route = app.route || {}) {
  if (route.page === 'resources')
    return route.id ? 'resource:' + route.id : route.folder ? 'folder:' + route.folder : 'nodes:';
  if (route.page === 'plugins' && route.id) return 'plugin:' + route.id;
  if (route.project) return route.workflow ? `workflow:${route.project}:${route.workflow}` : 'project:' + route.project;
  return route.page === 'home' ? '' : 'section:' + route.page;
}
let shownSection = '',
  shownTarget = '';
function renderSubnav(route) {
  const section = sectionOf(route),
    tree = NAV_TREES[section]?.(route),
    target = Tabs.keyOf(route) + (route.page === 'api' ? ':' + (routeQuery().get('call') || '') : ''),
    changed = section !== shownSection || target !== shownTarget;
  $('#subnav').hidden = false;
  if (section !== shownSection) {
    navOpen.clear(); // Only an explicit toggle opens a Library branch.
  }
  shownSection = section;
  shownTarget = target;
  if (!tree) return Subnav.set(section, {title: SECTION_TITLES[section] || 'Navigation'});
  if (changed && section === 'projects' && route.project) navOpen.add('p:' + route.project);
  const rows = tree.rows();
  Subnav.set(section, {
    title: SECTION_TITLES[section],
    actions: sectionActions(section).length ? actionButton('section:' + section, 'Section actions') : '',
    body: `<nav class="subnav-tree" aria-label="${esc(SECTION_TITLES[section])}">${rows.map(n => navRow(n, tree.active)).join('')}${rows.length ? '' : `<p class="muted small">Nothing here yet.</p>`}</nav>`,
  });
}

// ----- the sliding highlight -----
/** One element per panel that glides to the open row, and the glow that flows out of it into the next panel (css/nav-joined.css). */
const navPills = {
  side: document.createElement('i'),
  sub: document.createElement('i'),
  mobile: document.createElement('i'),
};
for (const pill of Object.values(navPills)) pill.className = 'nav-pill off';
$('#sidebar').append(navPills.side);
$('#subnav-body').prepend(navPills.sub);
$('#mobile-secondary').prepend(navPills.mobile);
/** The glow of a panel is created on demand: one `.nav-seam` per host panel. */
function navSeam(host) {
  let seam = $(':scope > .nav-seam', host);
  if (!seam) {
    seam = document.createElement('i');
    seam.className = 'nav-seam off';
    host.prepend(seam);
  }
  return seam;
}
/** `jump`: the element moves at once (no transition) and starts gliding again two frames later. */
function settle(el, jump) {
  el.classList.toggle('jump', jump);
  const generation = (el.generation = (el.generation || 0) + 1);
  if (jump)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => el.generation === generation && el.classList.remove('jump'))
    );
}
/** What makes two rows "the same row" even when the list was redrawn between them. */
const rowId = el =>
  el.dataset.key || el.dataset.section || el.dataset.sideTab || el.dataset.method || el.textContent.trim();
const GLIDE_MS = 340; // a little more than the transition (--slow)
/**
 * Puts `pill` (inside `box`) over `row`, and the seam of the next panel (`host`) at the same height.
 * Another row than before: the pill glides there. The same row (it only moved: a group unfolded, the list scrolled): the pill
 * stays glued to it. `instant` (first placement, resize, another section) moves it at once.
 */
function placePill(pill, row, box, instant, host) {
  const seam = host && navSeam(host);
  if (!row || !row.offsetParent) {
    pill.classList.add('off');
    seam?.classList.add('off');
    host?.style.removeProperty('--row-top');
    host?.style.removeProperty('--row-bottom');
    return;
  }
  const r = row.getBoundingClientRect(),
    b = box.getBoundingClientRect(),
    now = performance.now(),
    id = rowId(row),
    other = pill.rowId !== id;
  pill.rowId = id;
  pill.style.setProperty('--space-before', Math.max(0, r.top - b.top) + 'px');
  pill.style.setProperty('--space-after', Math.max(0, b.bottom - r.bottom) + 'px');
  pill.style.setProperty('--x', r.left - b.left + box.scrollLeft - box.clientLeft + 'px');
  let jump = instant || pill.classList.contains('off');
  if (other && !jump) pill.glideUntil = now + GLIDE_MS;
  else jump = jump || now > (pill.glideUntil || 0); // still gliding to this row: only the target moves
  pill.style.setProperty('--y', r.top - b.top + box.scrollTop - box.clientTop + 'px');
  pill.style.setProperty('--h', r.height + 'px');
  pill.style.setProperty('--w', r.width + 'px');
  pill.classList.remove('off');
  settle(pill, jump);
  if (!seam) return;
  // A row scrolled out of its list keeps its pill (it scrolls along) but sends no glow into the next panel.
  if (r.bottom <= b.top || r.top >= b.bottom) {
    seam.classList.add('off');
    return;
  }
  const h = host.getBoundingClientRect();
  host.style.setProperty('--row-top', Math.max(0, r.top - h.top) + 'px');
  host.style.setProperty('--row-bottom', Math.max(0, h.bottom - r.bottom) + 'px');
  settle(seam, jump || seam.classList.contains('off'));
  seam.style.setProperty('--y', r.top - h.top - host.clientTop + 'px');
  seam.style.setProperty('--h', r.height + 'px');
  seam.classList.remove('off');
}
/** A row inside a closed group (or in the folded panel) is represented by the group's own row. */
function shownRow(row) {
  const folded = document.body.classList.contains('subnav-collapsed');
  let shown = row;
  for (let branch = row?.closest('.subnav-branch'); branch; branch = branch.parentElement.closest('.subnav-branch')) {
    const group = branch.parentElement;
    if (folded || !group.classList.contains('open')) shown = $(':scope > .subnav-row', group);
  }
  return shown;
}
/** `list`: the second panel's pill jumps (another section filled it); `all`: both jump (resize, switching the design on). */
function placePills(list = false, all = false) {
  if (!document.body.classList.contains('nav-joined')) return;
  placeRailPill(all);
  if (typeof phoneLayout !== 'undefined' && phoneLayout.matches) {
    const sheet = document.body.classList.contains('mobile-subnav-open');
    const host = sheet ? $('#subnav') : $('#mobile-secondary');
    const inactive = sheet ? $('#mobile-secondary') : $('#subnav');
    $(':scope > .nav-seam', inactive)?.classList.add('off');
    placePill(navPills.side, $('#sidebar a.active'), $('#sidebar'), all, host);
    placePill(navPills.mobile, $('#mobile-browse'), $('#mobile-secondary'), list || all, $('main'));
    navPills.sub.classList.add('off');
    return;
  }
  placePill(navPills.side, $('#sidebar a.active'), $('#sidebar'), all, $('#subnav'));
  placePill(navPills.sub, shownRow($('#subnav .subnav-row.active')), $('#subnav-body'), list || all, $('main'));
}
/** The Properties panel's icon rail has its own pill (it flows left into the panel); the editor calls this when the open section changes. */
function placeRailPill(instant = false) {
  const nav = $('.side-tabs');
  if (!nav || !document.body.classList.contains('nav-joined')) return;
  let pill = $('.nav-pill', nav);
  if (!pill) {
    pill = document.createElement('i');
    pill.className = 'nav-pill off';
    nav.prepend(pill);
  }
  placePill(pill, $('button.active', nav), nav, instant, $('.side-content'));
}
/** Keeps the highlight on its row for a while: rows move while a group unfolds or the panel changes its width. */
let followUntil = 0,
  following = false;
function followPills(ms = 400) {
  followUntil = performance.now() + ms;
  if (following) return;
  following = true;
  const step = () => {
    placePills();
    if (performance.now() < followUntil) requestAnimationFrame(step);
    else following = false;
  };
  requestAnimationFrame(step);
}
addEventListener('resize', () => placePills(true, true));
// Follow both left highlights on every frame of a panel resize or collapse.
// Watching the list alone misses changes to the sidebar width and panel padding.
const pillResizeObserver = new ResizeObserver(() => {
  const dragging = document.body.classList.contains('resizing-panel');
  placePills(dragging, dragging);
});
for (const pill of Object.values(navPills)) pillResizeObserver.observe(pill);
for (const panel of [$('#sidebar'), $('#subnav')]) pillResizeObserver.observe(panel);
// Whatever changes the size of the list (a row added, a group unfolded, the panel folded) moves the rows: the highlight follows.
pillResizeObserver.observe($('#subnav-list'));
$('#subnav').addEventListener('transitionend', event => event.target === event.currentTarget && placePills());
// The glow in the content panel follows the open row while the second panel's list scrolls.
let seamFrame = 0;
$('#subnav-body').addEventListener('scroll', () => {
  if (seamFrame) return;
  seamFrame = requestAnimationFrame(() => {
    seamFrame = 0;
    placePills();
  });
});

function renderSidebar() {
  const route = app.route || {},
    section = sectionOf(route);
  for (const link of $$('#sidebar [data-section]')) {
    const on = link.dataset.section === section;
    link.classList.toggle('active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  renderSubnav(route);
  placePills(Subnav.changed);
  Subnav.changed = false;
  if (typeof syncMobileNavigation === 'function') syncMobileNavigation();
}

// ----- menus and folding -----
/** The menu behind a "⋯" (`data-menu="type:argument"`) on a row of the second panel or on a card. In the panel a rename asks in a dialog; on a card it happens on the spot. */
async function menuItems(spec, owner) {
  const items = await resolveMenuItems(spec, owner);
  return items?.map(item => {
    if (!item || typeof item[1] !== 'function') return item;
    const [label, action, options] = item;
    return [
      label,
      async (...args) => {
        if (app.pageSave && (await app.pageSave()) === false) return;
        return action(...args);
      },
      options,
    ];
  });
}
async function resolveMenuItems(spec, owner) {
  const colon = spec.indexOf(':'),
    type = spec.slice(0, colon),
    arg = spec.slice(colon + 1),
    title = () => menuTitle(spec, owner);
  if (type === 'project') {
    const project = app.projects.find(p => p.id === arg);
    return project && projectActions(project, title);
  }
  if (type === 'workflow') {
    const [projectId, workflowId] = arg.split(':'),
      workflow =
        (projectTree.workflows.get(projectId) || []).find(w => w.id === workflowId) ||
        (await api(`projects/${projectId}`)).workflows.find(w => w.id === workflowId);
    return workflow && workflowActions(projectId, workflow, title);
  }
  if (type === 'section') return sectionActions(arg);
  if (type === 'nodes') return nodesActions();
  if (type === 'resource')
    return resourceActions(
      app.resources.find(r => r.id === arg),
      title
    );
  if (type === 'folder') return folderActions(arg, title);
  if (type === 'plugin') return pluginActions((app.plugins || []).find(p => p.id === arg));
}

function sectionActions(section) {
  if (section === 'library') return nodesActions();
  if (section === 'projects')
    return [
      ['New project', newProjectDialog, {icon: 'plus'}],
      ['Import project', importProjects, {icon: 'download'}],
    ];
  if (section === 'plugins') return [['Reload plugins', reloadPlugins, {icon: 'refresh'}]];
  if (section === 'settings')
    return [['Restore defaults', () => app.restoreSettings?.(), {icon: 'refresh', disabled: !app.restoreSettings}]];
  if (section === 'api')
    return [['Download OpenAPI', () => app.apiReference?.download(), {icon: 'download', disabled: !app.apiReference}]];
  return [];
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-menu]');
  if (!button) return;
  event.preventDefault();
  const rect = button.getBoundingClientRect();
  menuItems(button.dataset.menu, button)
    .then(items => items && popup(rect.left, rect.bottom + 4, items))
    .catch(fail);
});
// Cards and rows with actions keep their own menu; ordinary links retain native open/copy-link actions.
const plainNavigationLink = target => {
  const link = target.closest?.('a[data-link]');
  if (!link || link.closest('#tabs')) return false;
  return !link.closest('.card,.subnav-row')?.querySelector('[data-menu]');
};
// Text is the exception to every other menu: right-click on a text field (or on selected text) always opens the text menu.
const TEXT_FIELD =
  'textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=tel], input[type=email], input[type=password], input[type=number], [contenteditable=""], [contenteditable=true]';
function textMenuItems(field, selected) {
  const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+',
    editable = !!field && !field.readOnly && !field.disabled,
    secret = field?.type === 'password',
    range = field && 'selectionStart' in field ? [field.selectionStart, field.selectionEnd] : null,
    back = () => {
      field?.focus();
      if (range && field.setSelectionRange) field.setSelectionRange(...range);
    };
  const run = command => () => {
    back();
    document.execCommand(command);
  };
  const paste = async () => {
    back();
    const text = await navigator.clipboard.readText();
    if (text && !document.execCommand('insertText', false, text) && field.setRangeText) {
      field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
      field.dispatchEvent(new Event('input', {bubbles: true}));
    }
  };
  const all = () => {
    if (field) {
      back();
      if (field.select) field.select();
      else document.execCommand('selectAll');
    } else document.execCommand('selectAll');
  };
  return [
    ['Cut', run('cut'), {icon: 'cut', hint: mod + 'X', disabled: !editable || secret || !selected}],
    ['Copy', run('copy'), {icon: 'copy', hint: mod + 'C', disabled: secret || !selected}],
    ['Paste', paste, {icon: 'paste', hint: mod + 'V', disabled: !editable}],
    null,
    [
      'Select all',
      all,
      {icon: 'expand', hint: mod + 'A', disabled: field ? !(field.value ?? field.textContent) : false},
    ],
  ];
}
document.addEventListener(
  'contextmenu',
  event => {
    if (plainNavigationLink(event.target)) return;
    event.preventDefault();
    const field = event.target.closest?.(TEXT_FIELD),
      selection = getSelection();
    const picked =
      field && 'selectionStart' in field ? field.selectionStart !== field.selectionEnd : !!selection?.toString();
    if (!field && !(picked && selection.containsNode(event.target, true))) return;
    event.stopImmediatePropagation();
    if (field && document.activeElement !== field) field.focus();
    const items = field
        ? textMenuItems(
            field,
            'selectionStart' in field ? field.selectionStart !== field.selectionEnd : !!getSelection().toString()
          )
        : [textMenuItems(null, true)[1]],
      menu = popup(event.clientX, event.clientY, items),
      dialog = event.target.closest('dialog');
    // Inside a modal dialog everything else is inert, so the menu goes into the dialog.
    if (dialog) {
      dialog.append(menu);
      menu.classList.add('in-dialog');
    }
  },
  true
);
document.addEventListener('contextmenu', event => {
  if (plainNavigationLink(event.target)) return;
  const custom = event.target.closest('[data-context-menu]');
  if (custom) return custom.click();
  if (!event.target.closest('[data-menu]') && event.target.closest('#canvas, #tabs, .popup')) return;
  const owner = event.target.closest('[data-menu], .card, .subnav-row');
  const button = owner?.matches('[data-menu]') ? owner : owner?.querySelector('[data-menu]');
  if (!button) return;
  menuItems(button.dataset.menu, button)
    .then(items => items && popup(event.clientX, event.clientY, items))
    .catch(fail);
});
$('#subnav').addEventListener('click', event => {
  const toggle = event.target.closest('.subnav-toggle, [data-toggle]');
  if (!toggle) return;
  event.preventDefault();
  const group = toggle.closest('.subnav-group');
  setGroupOpen(group, !group.classList.contains('open'));
});
