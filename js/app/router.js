// Hash routing: parse the URL, open pages, leave guards, link handling.
'use strict';

// ----- routing -----
// Pages: / (the dashboard), /projects, /runs, /api, /settings, /p/{project}, /p/{project}/settings, /p/{project}/w/{workflow},
// /plugins (the installed plugins), /plugins/{id} (one plugin) and /plugins/{id}/{page} (a page it adds),
// /resources (the Library: its sections as cards), /resources/nodes[?folder=…] (the Nodes section: nodes and groups as cards)
// and /resources/nodes/{id} (one node).
// Served by server.js the editor is at /editor/ and these are real paths (/editor/p/…). Opened any other way (a static server,
// a file) there is no server to answer them, so they live in the URL hash (#/p/…). `urlOf` makes the address of a page for either.
const PATH_BASE = '/editor';
const pathMode = /^\/editor(\/|$)/.test(location.pathname);
const urlOf = path => (pathMode ? PATH_BASE + (path === '/' ? '/' : path) : '#' + path);
/** The page now, as `path?query`. */
const routeTarget = () =>
  (pathMode ? location.pathname.slice(PATH_BASE.length) + location.search : location.hash.replace(/^#/, '')) || '/';
const routePath = () => routeTarget().split('?')[0] || '/';
const routeQuery = () => new URLSearchParams(routeTarget().split('?')[1] || '');
const routeURL = () => urlOf(routeTarget());
// An address with the old hash form (/editor/#/p/…) becomes the path.
if (pathMode && location.hash.startsWith('#/')) history.replaceState({}, '', urlOf(location.hash.slice(1)));
function parseRoute(path = routePath(), query = routeQuery()) {
  let parts;
  try {
    parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return {page: 'not-found'};
  }
  if (!parts.length) return {page: 'home'};
  if (parts[0] === 'p' && parts[1]) {
    if (parts.length === 4 && parts[2] === 'w') return {page: 'workflow', project: parts[1], workflow: parts[3]};
    if (parts.length === 2 || (parts.length === 3 && parts[2] === 'settings'))
      return {page: parts.length === 3 ? 'project-settings' : 'project', project: parts[1]};
    return {page: 'not-found'};
  }
  const page =
    {projects: 'projects', settings: 'settings', resources: 'resources', runs: 'runs', api: 'api', plugins: 'plugins'}[
      parts[0]
    ] || 'not-found';
  if (page === 'plugins') return parts.length <= 3 ? {page, id: parts[1], view: parts[2]} : {page: 'not-found'};
  if (page !== 'resources') return parts.length === 1 ? {page} : {page: 'not-found'};
  if (parts.length > 3) return {page: 'not-found'};
  return parts[1] ? {page, section: parts[1], id: parts[2], folder: query.get('folder') ?? undefined} : {page};
}
/** A deterministic way out of a deep link, including one opened without browser history. */
function parentPage(route) {
  if (route.workflow && route.project?.startsWith('lib-')) {
    const item = app.resources.find(r => r.id === route.project.slice(4));
    return [item?.payload.folder ? baseName(item.payload.folder) : 'Nodes', folderHref(item?.payload.folder || '')];
  }
  if (route.project)
    return route.page === 'project'
      ? ['Projects', '/projects']
      : ['Project', `/p/${encodeURIComponent(route.project)}`];
  if (route.page === 'resources' && route.section) {
    if (route.section !== 'nodes') {
      const section = catalogDefinition(route.section);
      if (route.id) return [section?.title ?? 'Collection', catalogHref(route.section, route.folder)];
      if (route.folder)
        return [
          parentPath(route.folder) ? baseName(parentPath(route.folder)) : (section?.title ?? 'Collection'),
          catalogHref(route.section, parentPath(route.folder)),
        ];
      const parent = catalogDefinition(section?.parent);
      return parent ? [parent.title, catalogHref(parent.id)] : ['Library', '/resources'];
    }
    if (route.folder)
      return [
        parentPath(route.folder) ? baseName(parentPath(route.folder)) : 'Nodes',
        folderHref(parentPath(route.folder)),
      ];
    return ['Library', '/resources'];
  }
  if (route.page === 'plugins' && route.view) {
    const plugin = pluginById(route.id),
      page = plugin?.manifest.contributes.pages.find(p => p.id === route.view);
    if (page?.parent)
      return [
        plugin.manifest.contributes.pages.find(p => p.id === page.parent).title,
        pluginHref(route.id, page.parent),
      ];
    if (page?.section === 'library') return ['Library', '/resources'];
    return [plugin?.manifest.name || 'Plugin', pluginHref(route.id)];
  }
  return route.page === 'plugins' && route.id ? ['Plugins', '/plugins'] : ['Dashboard', '/'];
}
let navigationRevision = 0,
  renderRevision = 0;
async function go(path, replace = false) {
  const revision = ++navigationRevision;
  if (!(await leaveView())) return;
  if (revision !== navigationRevision) return;
  if (document.body.classList.contains('mobile-subnav-open')) toggleMobileNavigation(false);
  if (urlOf(path) !== routeURL()) history[replace ? 'replaceState' : 'pushState']({}, '', urlOf(path));
  await render();
}
let leaveGuards = [];
let leavingView = null;
function leaveView() {
  if (leavingView) return leavingView;
  const guards = [...leaveGuards];
  leavingView = (async () => {
    for (const guard of guards) if ((await guard()) === false) return false;
    leaveGuards = leaveGuards.filter(guard => !guards.includes(guard));
    return true;
  })().finally(() => {
    leavingView = null;
  });
  return leavingView;
}
async function render() {
  const revision = ++renderRevision;
  const requested = parseRoute();
  if (
    requested.project?.startsWith('lib-') ||
    (requested.page === 'resources' && requested.section === 'nodes' && requested.id)
  ) {
    await loadLibrary();
    if (revision !== renderRevision) return;
    if (!developerMode()) {
      Tabs.items = Tabs.items.filter(tab => !tab.library && !tab.project.startsWith('lib-'));
      Tabs.save();
      history.replaceState({}, '', urlOf('/resources'));
      return render();
    }
  }
  app.currentURL = routeURL();
  const view = $('#view'),
    previous = Tabs.stateOf();
  if (previous) previous.scroll = view.scrollTop; // the tab being left remembers how far it was scrolled
  const route = (app.route = parseRoute());
  app.pageSave = null;
  closePopup();
  endPluginFrame(); // a plugin page that was open stops listening
  document.body.dataset.page = route.page;
  view.className = 'view-' + route.page;
  try {
    await (PAGES[route.page] || showMissingPage)(view, route);
  } catch (error) {
    if (revision !== renderRevision) return;
    const [label, href] = parentPage(route);
    view.innerHTML = `<div class="empty"><h2>Could not open this page</h2><p>${esc(error.message)}</p><a href="${esc(href)}" data-link>Back to ${esc(label)}</a></div>`;
  }
  if (revision !== renderRevision) return;
  app.currentURL = routeURL();
  renderSidebar();
  Tabs.render(); // an editor has opened its own tab; a page has none, so no tab is the open one
  const now = Tabs.stateOf();
  if (now && now !== previous) view.scrollTop = now.scroll || 0;
  // The project list in the second panel shows workflow counts; refresh them on the way (the projects page loads them itself).
  if (sectionOf(route) === 'projects' && route.page !== 'projects') {
    loadProjects().catch(() => {});
    if (route.project) loadProjectWorkflows(route.project, true);
  }
}
async function showMissingPage(view) {
  view.innerHTML = `<div class="page">${pageHead({title: 'Page not found', crumbs: [['Dashboard', '/']]})}<p class="muted">This address does not match a page.</p></div>`;
}
// Links are written as plain paths; give them their real address so middle-click and "copy link" work too.
const linkPath = link => {
  if (link.dataset.path !== undefined) return link.dataset.path;
  const raw = link.getAttribute('href') || '/';
  if (raw.startsWith('#/')) return (link.dataset.path = raw.slice(1));
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin) return null;
  const path =
    url.pathname === PATH_BASE || url.pathname.startsWith(PATH_BASE + '/')
      ? url.pathname.slice(PATH_BASE.length) || '/'
      : url.pathname;
  return (link.dataset.path = path + url.search);
};
const addressed = event => {
  const link = event.target.closest?.('a[data-link]');
  if (!link) return;
  const path = linkPath(link);
  if (path !== null) link.setAttribute('href', urlOf(path));
};
document.addEventListener('mouseover', addressed);
document.addEventListener('focusin', addressed);
document.addEventListener('pointerdown', addressed);
document.addEventListener('contextmenu', addressed, true);
document.addEventListener('click', event => {
  if (event.target.closest('.inline-rename')) return;
  const link = event.target.closest('a[data-link]');
  if (
    !link ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.button ||
    link.hasAttribute('download') ||
    (link.target && link.target !== '_self')
  )
    return;
  const path = linkPath(link);
  if (path === null) return;
  event.preventDefault();
  go(path).catch(fail);
});
window.addEventListener('popstate', async () => {
  ++navigationRevision;
  try {
    if (await leaveView()) await render();
    else history.pushState({}, '', app.currentURL);
  } catch (error) {
    fail(error);
  }
});
