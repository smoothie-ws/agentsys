// Page: API reference generated from the route table.
'use strict';

// ----- API reference -----
PAGES['api-docs'] = async view => {
  const spec = Backend.openapi();
  const rows = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method))
      .map(([method, op]) => ({path, method, op}))
  );
  const tree = {children: new Map(), methods: []};
  rows.forEach((row, index) => {
    let branch = tree;
    for (const segment of row.path.split('/').filter(Boolean).slice(1)) {
      if (!branch.children.has(segment)) branch.children.set(segment, {children: new Map(), methods: []});
      branch = branch.children.get(segment);
    }
    branch.methods.push(index);
  });
  const branchHTML = (branch, path = '') =>
    branch.methods
      .map(
        index =>
          `<button type="button" class="subnav-row subnav-call" data-method="${index}" title="${esc(rows[index].op.summary)}"><span class="method m-${rows[index].method}">${rows[index].method.toUpperCase()}</span><span>${esc(rows[index].op.summary)}</span></button>`
      )
      .join('') +
    [...branch.children]
      .map(([segment, child]) => {
        const key = `a:${path}/${segment}`,
          open = navOpen.has(key);
        return `<div class="subnav-group ${open ? 'open' : ''}" data-group="${esc(key)}"><div class="subnav-row"><button type="button" class="subnav-toggle" aria-label="Show or hide" aria-expanded="${open}">${icon('chevron')}</button><button type="button" class="subnav-name" data-toggle>${icon('folder')}<code>${esc(segment)}</code></button></div><div class="subnav-branch"><div>${branchHTML(child, `${path}/${segment}`)}</div></div></div>`;
      })
      .join('');
  view.innerHTML = `<div class="page api">${pageHead({title: 'API', actions: '<button class="button ghost" id="download-spec">Download OpenAPI</button>'})}
    <article class="api-method" id="api-method" aria-live="polite"></article></div>`;
  // The tree of calls is the sub-navigation of this section.
  Subnav.mount({
    title: 'API',
    body: `<input type="search" id="api-search" placeholder="Find a method…" aria-label="Find an API method"><nav class="subnav-tree" aria-label="API method tree"><span class="muted small">/api</span>${branchHTML(tree)}</nav>`,
  });
  const panel = $('#subnav-list');
  const selectMethod = (index, expand = true) => {
    const row = rows[index];
    if (!row) return;
    const {path, method, op} = row;
    $$('[data-method]', panel).forEach(button => {
      button.classList.toggle('active', Number(button.dataset.method) === index);
      button.setAttribute('aria-current', Number(button.dataset.method) === index ? 'true' : 'false');
    });
    $('#api-method').innerHTML =
      `<div class="api-method-heading"><span class="method m-${method}">${method.toUpperCase()}</span><code>${esc(path)}</code></div><h2>${esc(op.summary)}</h2>${op.description ? `<p class="muted">${esc(op.description)}</p>` : ''}
      <h3>Usage</h3><pre class="code">await agentsys('${method.toUpperCase()}', '${esc(path.replace(/^\/api\//, ''))}'${op.requestBody ? ', body' : ''})</pre>
      ${op.parameters?.length ? `<h3>Parameters</h3><div class="table-scroll"><table><thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Description</th></tr></thead><tbody>${op.parameters.map(p => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' *' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.schema?.type || '')}</td><td>${esc(p.description || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${op.requestBody ? `<h3>Request body</h3><pre class="code">${esc(pretty(op.requestBody.content?.['application/json']?.example || op.requestBody))}</pre>` : ''}
      <h3>Responses</h3><ul class="api-responses">${Object.entries(op.responses || {})
        .map(([status, response]) => `<li><code>${esc(status)}</code><span>${esc(response.description)}</span></li>`)
        .join('')}</ul>`;
    history.replaceState({}, '', urlOf('/api-docs?' + new URLSearchParams({method, path})));
    const selected = $(`[data-method="${index}"]`, panel);
    if (expand) for (let group = selected?.closest('.subnav-group'); group; group = group.parentElement.closest('.subnav-group')) setGroupOpen(group, true, false);
    placePills();
    syncMobileNavigation();
  };
  $('#download-spec').onclick = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], {type: 'application/json'}));
    link.download = 'agentsys-openapi.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  $('.subnav-tree', panel).onclick = event => {
    const button = event.target.closest('[data-method]');
    if (button) return selectMethod(Number(button.dataset.method));
    const folder = event.target.closest('[data-toggle]');
    if (folder && document.body.classList.contains('subnav-collapsed')) {
      event.stopPropagation();
      const group = folder.closest('.subnav-group'), rect = folder.getBoundingClientRect();
      const items = $$('[data-method]', group).map(row => {
        const index = Number(row.dataset.method), entry = rows[index];
        return [`${entry.method.toUpperCase()} ${entry.path} — ${entry.op.summary}`, () => selectMethod(index, false)];
      });
      popup(rect.right + 8, rect.top, items, {search: true});
    }
  };
  $('#api-search').oninput = event => {
    const q = event.target.value.toLocaleLowerCase();
    $$('[data-method]', panel).forEach(button => {
      const row = rows[Number(button.dataset.method)];
      button.hidden = !`${row.path} ${row.method} ${row.op.summary}`.toLocaleLowerCase().includes(q);
    });
    $$('.subnav-group', panel)
      .reverse()
      .forEach(folder => {
        folder.hidden = !$$('[data-method]', folder).some(b => !b.hidden);
        if (q) setGroupOpen(folder, true, false);
      });
    placePills();
  };
  const params = routeQuery(),
    index = rows.findIndex(r => r.path === params.get('path') && r.method === params.get('method'));
  // Folders start collapsed; a method named in the address (or clicked) opens its folders.
  selectMethod(
    index < 0 ? Math.max(0, rows.findIndex(r => r.path === '/api/projects' && r.method === 'get')) : index,
    index >= 0
  );
};
