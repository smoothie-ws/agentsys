// The API reference (/api): a searchable call tree in the Dashboard sidebar and the selected call on the page.
'use strict';

/** Shared path tree for Dashboard navigation and the searchable reference. */
const apiCallKey = row => row.method + ' ' + row.path;
const apiCallHref = row => '/api?call=' + encodeURIComponent(apiCallKey(row));
const apiReferenceRows = spec => Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, op]) => ({path, method, op}))
);
function selectedApiCallKey() {
  const rows = app.apiReference?.rows || apiReferenceRows(Backend.openapi());
  const row = rows.find(row => apiCallKey(row) === routeQuery().get('call')) || rows[0];
  return row ? apiCallKey(row) : null;
}
function apiPathTree(rows) {
  const root = {children: new Map(), calls: []};
  rows.forEach(row => {
    let level = root, path = '';
    for (const segment of row.path.replace(/^\/api\//, '').split('/')) {
      path += '/' + segment;
      if (!level.children.has(segment)) level.children.set(segment, {segment, path, children: new Map(), calls: []});
      level = level.children.get(segment);
    }
    level.calls.push(row);
  });
  return root;
}
function apiNavigationRows(query = '') {
  const q = query.trim().toLocaleLowerCase();
  const calls = apiReferenceRows(app.apiReference?.spec || Backend.openapi()).filter(row =>
    `${row.path} ${row.method} ${row.op.summary}`.toLocaleLowerCase().includes(q)
  );
  const tree = apiPathTree(calls);
  const rows = level => [
    ...level.calls.map(row => ({key: 'api-call:' + apiCallKey(row), label: row.method.toUpperCase(), icon: 'code', href: apiCallHref(row)})),
    ...[...level.children.values()].map(child => ({key: 'api-path:' + child.path, label: child.segment, icon: 'folder', open: q ? true : undefined, children: rows(child)})),
  ];
  return rows(tree);
}

/** The page shows the selected call; the endpoint tree and search live in Dashboard's sidebar. */
function mountApiReference(box, spec = Backend.openapi()) {
  const rows = apiReferenceRows(spec);
  box.innerHTML = '<article class="api-method" aria-live="polite"><p class="muted">Choose a call in the sidebar.</p></article>';
  const detail = $('.api-method', box);
  const select = index => {
    const {path, method, op} = rows[index];
    detail.innerHTML = `<div class="api-method-heading"><span class="method m-${method}">${method.toUpperCase()}</span><code>${esc(path)}</code></div><h3>${esc(op.summary)}</h3>${op.description ? `<p class="muted">${esc(op.description)}</p>` : ''}
      <pre class="code">await agentsys('${method.toUpperCase()}', '${esc(path.replace(/^\/api\//, ''))}'${op.requestBody ? ', body' : ''})</pre>
      ${op.parameters?.length ? `<div class="table-scroll"><table><thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Description</th></tr></thead><tbody>${op.parameters.map(p => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' *' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.schema?.type || '')}</td><td>${esc(p.description || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${op.requestBody ? `<h3>Request body</h3><pre class="code">${esc(pretty(op.requestBody.content?.['application/json']?.example || op.requestBody))}</pre>` : ''}
      <h3>Responses</h3><ul class="api-responses">${Object.entries(op.responses || {})
        .map(([status, response]) => `<li><code>${esc(status)}</code><span>${esc(response.description)}</span></li>`)
        .join('')}</ul>`;
  };
  const requested = routeQuery().get('call'), selected = rows.findIndex(row => apiCallKey(row) === requested);
  if (rows.length) select(selected < 0 ? 0 : selected);
  return {
    rows,
    spec,
    download() {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], {type: 'application/json'}));
      link.download = 'agentsys-openapi.json';
      link.click();
      URL.revokeObjectURL(link.href);
    },
  };
}

PAGES.api = async (view, route) => {
  const spec = DB.mode === 'files' ? await api('openapi.json') : Backend.openapi();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page api-page">${pageHead({title: 'API reference', crumbs: [['Dashboard', '/']], sub: 'Every action of the app is an API call.'})}
    <section id="api-reference"><p class="muted">With the server running: <code>${esc(location.origin)}/api/…</code>. In scripts: <code>agentsys(method, path, body)</code>.</p><div id="api-box"></div></section></div>`;
  const reference = mountApiReference($('#api-box'), spec);
  app.apiReference = reference;
};
