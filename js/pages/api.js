// The API reference: a searchable method tree beside the selected method, inside the page.
'use strict';

/** Stable addresses and a path tree for the searchable reference. */
const apiCallKey = row => row.method + ' ' + row.path;
const apiCallHref = row => '/api?call=' + encodeURIComponent(apiCallKey(row));
const apiReferenceRows = spec =>
  Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, op]) => ({path, method, op}))
  );
function apiPathTree(rows) {
  const root = {children: new Map(), calls: []};
  rows.forEach(row => {
    let level = root,
      path = '';
    for (const segment of row.path.replace(/^\/api\//, '').split('/')) {
      path += '/' + segment;
      if (!level.children.has(segment)) level.children.set(segment, {segment, path, children: new Map(), calls: []});
      level = level.children.get(segment);
    }
    level.calls.push(row);
  });
  return root;
}
/** Keep method navigation on the page so folding the application sidebar never hides it. */
function mountApiReference(box, spec = Backend.openapi()) {
  const rows = apiReferenceRows(spec),
    state = Tabs.stateOf('api'),
    open = new Set(state.apiOpen ?? []);
  box.innerHTML = `<nav class="api-navigation" aria-label="API methods"><label class="api-search"><span>Search methods</span><input id="api-method-search" type="search" placeholder="GET, path or description" aria-label="Search API methods"></label><span class="muted small" data-api-count role="status"></span><div class="api-call-tree"></div></nav><article class="api-method" aria-live="polite"></article>`;
  const detail = $('.api-method', box),
    tree = $('.api-call-tree', box),
    search = $('#api-method-search', box);
  let selected = rows.findIndex(row => apiCallKey(row) === routeQuery().get('call'));
  if (selected < 0) selected = 0;
  const reveal = row => {
    let path = '';
    for (const segment of row.path.replace(/^\/api\//, '').split('/')) {
      path += '/' + segment;
      open.add(path);
    }
  };
  const drawTree = () => {
    const scroll = tree.scrollTop;
    const query = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),
      filtered = rows.filter(row =>
        query.every(q => `${row.method} ${row.path} ${row.op.summary}`.toLocaleLowerCase().includes(q))
      );
    const branch = level =>
      level.calls
        .map(row => {
          const index = rows.indexOf(row);
          return `<a class="api-call" href="${esc(urlOf(apiCallHref(row)))}" data-api-call="${index}" ${index === selected ? 'aria-current="page"' : ''}><span class="method m-${row.method}">${row.method.toUpperCase()}</span><span><code>${esc(row.path)}</code></span></a>`;
        })
        .join('') +
      [...level.children.values()]
        .map(
          child =>
            `<details data-api-path="${esc(child.path)}" ${query.length || open.has(child.path) ? 'open' : ''}><summary><code>${esc(child.segment)}</code></summary><div>${branch(child)}</div></details>`
        )
        .join('');
    tree.innerHTML = filtered.length ? branch(apiPathTree(filtered)) : '<p class="muted">No matching methods.</p>';
    tree.scrollTop = scroll;
    $('[data-api-count]', box).textContent = `${filtered.length} of ${rows.length} methods`;
  };
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
  search.value = state.apiFilter ?? '';
  search.oninput = () => {
    state.apiFilter = search.value;
    Tabs.save();
    drawTree();
    tree.scrollTop = 0;
  };
  tree.addEventListener(
    'toggle',
    event => {
      const group = event.target;
      if (!group.matches('details[data-api-path]') || search.value.trim()) return;
      group.open ? open.add(group.dataset.apiPath) : open.delete(group.dataset.apiPath);
      state.apiOpen = [...open];
      Tabs.save();
    },
    true
  );
  tree.onclick = event => {
    const link = event.target.closest('[data-api-call]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
    event.preventDefault();
    selected = Number(link.dataset.apiCall);
    reveal(rows[selected]);
    select(selected);
    drawTree();
    $('[data-api-call="' + selected + '"]', tree)?.focus({preventScroll: true});
    const href = urlOf(apiCallHref(rows[selected]));
    if (href !== routeURL()) history.pushState({}, '', href);
    app.currentURL = routeURL();
  };
  if (rows.length) {
    reveal(rows[selected]);
    select(selected);
  }
  drawTree();
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
  view.innerHTML = `<div class="page api-page">${pageHead({title: 'API reference', menu: '', sub: 'Every action of the app is an API call.', actions: '<button type="button" id="api-download">Download OpenAPI</button>'})}
    <section id="api-reference"><p class="muted">With the server running: <code>${esc(location.origin)}/api/…</code>.</p><div id="api-box"></div></section></div>`;
  const reference = mountApiReference($('#api-box'), spec);
  app.apiReference = reference;
  $('#api-download', view).onclick = () => reference.download();
};
