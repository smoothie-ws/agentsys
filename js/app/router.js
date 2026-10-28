// Hash routing: parse the URL, open pages, leave guards, link handling.
'use strict';

// ----- routing -----
// Pages: / (the dashboard), /projects, /runs, /api, /settings, /p/{project}, /p/{project}/settings, /p/{project}/w/{workflow},
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
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 'w' && parts[3]) return {page: 'workflow', project: parts[1], workflow: parts[3]};
    return {page: parts[2] === 'settings' ? 'project-settings' : 'project', project: parts[1]};
  }
  const page =
    {projects: 'projects', settings: 'settings', resources: 'resources', runs: 'runs', api: 'api'}[parts[0]] || 'home';
  if (page !== 'resources') return {page};
  return parts[1] === 'nodes'
    ? {page, section: 'nodes', id: parts[2], folder: query.get('folder') ?? undefined}
    : {page};
}
async function go(path, replace = false) {
  path = Tabs.resolve(path);
  if (!(await leaveView())) return;
  if (urlOf(path) !== routeURL()) history[replace ? 'replaceState' : 'pushState']({}, '', urlOf(path));
  await render();
}
let leaveGuards = [];
async function leaveView() {
  for (const guard of leaveGuards) if ((await guard()) === false) return false;
  leaveGuards = [];
  return true;
}
async function render() {
  const requested = parseRoute();
  if (
    requested.project?.startsWith('lib-') ||
    (requested.page === 'resources' && requested.id)
  ) {
    await loadLibrary();
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
  closePopup();
  Subnav.custom = false; // a page that fills the second panel itself says so while it opens
  document.body.dataset.page = route.page;
  view.className = 'view-' + route.page;
  try {
    await (PAGES[route.page] || PAGES.home)(view, route);
  } catch (error) {
    view.innerHTML = `<div class="empty"><h2>Could not open this page</h2><p>${esc(error.message)}</p><a href="/" data-link>Back to the dashboard</a></div>`;
  }
  renderSidebar();
  Tabs.visit(route);
  Tabs.render(); // an editor has opened its own tab; a page has none, so no tab is the open one
  const now = Tabs.stateOf();
  if (now && now !== previous) view.scrollTop = now.scroll || 0;
  // The project list in the second panel shows workflow counts; refresh them on the way (the projects page loads them itself).
  if (sectionOf(route) === 'projects' && route.page !== 'projects') {
    loadProjects().catch(() => {});
    if (route.project) loadProjectWorkflows(route.project, true);
  }
}
// Links are written as plain paths; give them their real address so middle-click and "copy link" work too.
const linkPath = link => link.dataset.path ?? (link.dataset.path = link.getAttribute('href').replace(/^#/, ''));
const addressed = event => {
  const link = event.target.closest?.('a[data-link]');
  if (link) link.setAttribute('href', urlOf(linkPath(link)));
};
document.addEventListener('mouseover', addressed);
document.addEventListener('focusin', addressed);
document.addEventListener('click', event => {
  if (event.target.closest('.inline-rename')) return;
  const link = event.target.closest('a[data-link]');
  if (!link || event.ctrlKey || event.metaKey || event.button) return;
  event.preventDefault();
  go(linkPath(link)).catch(fail);
});
window.addEventListener('popstate', async () => {
  try {
    if (await leaveView()) await render();
    else history.pushState({}, '', app.currentURL);
  } catch (error) {
    fail(error);
  }
});
