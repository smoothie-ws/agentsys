// The API page (/api, reached from the dashboard): the reference generated from the route table, a searchable list of calls and the details of the chosen one.
'use strict';

/** Fills `box` with the reference. Returns nothing; everything it needs is the route table (`Backend.openapi()`). */
function mountApiReference(box, spec = Backend.openapi()) {
  const rows = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, op]) => ({path, method, op}))
  );
  box.innerHTML = `<div class="api-reference">
    <div class="api-list"><input type="search" placeholder="Find a call…" aria-label="Find an API call"><div class="api-calls" role="list">${rows
      .map(
        (row, index) =>
          `<button type="button" class="api-call" role="listitem" data-call="${index}"><span class="method m-${row.method}">${row.method.toUpperCase()}</span><span>${esc(row.path.replace(/^\/api\//, ''))}</span></button>`
      )
      .join('')}</div></div>
    <article class="api-method" aria-live="polite"><p class="muted">Choose a call.</p></article></div>`;
  const detail = $('.api-method', box),
    buttons = $$('[data-call]', box);
  const select = index => {
    const {path, method, op} = rows[index];
    buttons.forEach((b, i) => b.classList.toggle('active', i === index));
    detail.innerHTML = `<div class="api-method-heading"><span class="method m-${method}">${method.toUpperCase()}</span><code>${esc(path)}</code></div><h3>${esc(op.summary)}</h3>${op.description ? `<p class="muted">${esc(op.description)}</p>` : ''}
      <pre class="code">await agentsys('${method.toUpperCase()}', '${esc(path.replace(/^\/api\//, ''))}'${op.requestBody ? ', body' : ''})</pre>
      ${op.parameters?.length ? `<div class="table-scroll"><table><thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Description</th></tr></thead><tbody>${op.parameters.map(p => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' *' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.schema?.type || '')}</td><td>${esc(p.description || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${op.requestBody ? `<h3>Request body</h3><pre class="code">${esc(pretty(op.requestBody.content?.['application/json']?.example || op.requestBody))}</pre>` : ''}
      <h3>Responses</h3><ul class="api-responses">${Object.entries(op.responses || {})
        .map(([status, response]) => `<li><code>${esc(status)}</code><span>${esc(response.description)}</span></li>`)
        .join('')}</ul>`;
  };
  $('.api-calls', box).onclick = event => {
    const button = event.target.closest('[data-call]');
    if (button) select(Number(button.dataset.call));
  };
  $('input', box).oninput = event => {
    const q = event.target.value.toLocaleLowerCase();
    buttons.forEach((b, i) => {
      const {path, method, op} = rows[i];
      b.hidden = !`${path} ${method} ${op.summary}`.toLocaleLowerCase().includes(q);
    });
  };
  if (rows.length) select(0);
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
