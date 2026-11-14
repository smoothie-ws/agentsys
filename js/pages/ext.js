// A page a plugin registered (js/app/extensions.js): its own render(container, context) draws the body.
'use strict';

PAGES.ext = async (view, route) => {
  const page = typeof Extensions === 'undefined' ? null : Extensions.page(route.plugin, route.id);
  if (!page) {
    view.innerHTML = `<div class="page">${pageHead({title: 'Page not found', sub: 'The plugin is not loaded or the page is gone.', menu: ''})}<p><a class="button" href="/plugins" data-link>Back to Plugins</a></p></div>`;
    return;
  }
  const menu = Extensions.hasMenu(`ext:${route.plugin}:${route.id}`) ? `ext:${route.plugin}:${route.id}` : '';
  view.innerHTML = `<div class="page ext-page">${pageHead({
    title: esc(page.title),
    sub: esc(page.description || ''),
    glyph: page.icon || 'plug',
    menu,
  })}<div class="page-body ext-body" id="ext-page-body"></div></div>`;
  const body = $('#ext-page-body', view);
  try {
    const result = await page.render(body, {
      page,
      route,
      api: Extensions.apiOf(route.plugin),
      go: path => go(path),
      refresh: () => render(),
    });
    if (app.route !== route) {
      if (typeof result === 'function') result();
      return;
    }
    if (typeof result === 'function') app.pageDispose = result;
    else if (typeof result === 'string' && !body.childNodes.length) body.innerHTML = result;
    else if (result instanceof Node) body.append(result);
  } catch (error) {
    body.innerHTML = `<div class="empty small"><h2>The plugin page could not be drawn</h2><p>${esc(error.message)}</p></div>`;
    fail(error);
  }
};
