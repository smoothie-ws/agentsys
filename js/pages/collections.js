// Generic JSON collections: server-validated resources a client plugin or a person can define without teaching
// the server what a "provider" or an "integration" means.
'use strict';

PAGES.collections = async (view, route) => {
  const definitions = await api('collections');
  if (app.route !== route) return;
  const selected = route.name ? definitions.find(item => item.name === route.name) : null;
  view.innerHTML = `<div class="page collections-page">${pageHead({
    title: selected ? esc(selected.title || selected.name) : 'Collections',
    sub: selected ? `Collection <code>${esc(selected.name)}</code>` : 'Structured JSON resources with a schema the server validates.',
    menu: '',
    actions: selected
      ? '<span id="collections-actions"></span>'
      : `<button type="button" class="primary" data-collection-add>${icon('plus')}<span>New collection</span></button>`,
  })}
    ${
      selected
        ? `<p class="muted">${esc(selected.description || '')}</p><div class="table-scroll"><table><thead><tr><th>Record</th><th>Updated</th><th></th></tr></thead><tbody id="collection-records"></tbody></table></div><p class="form-error" data-collections-error hidden></p>`
        : definitions.length
          ? `<div class="cards">${definitions
              .map(
                item => `<a class="card" href="#/collections/${encodeURIComponent(item.name)}" data-link><div class="card-main"><header class="card-head"><span class="head-icon">${icon('database')}</span><h3>${esc(item.title || item.name)}</h3></header><div class="card-preview card-note"><code>${esc(item.name)}</code><p class="muted">${esc(item.description || '')}</p></div></div></a>`
              )
              .join('')}</div>`
          : '<div class="empty small"><h2>No collections</h2><p>A client plugin can define one through <code>PUT /api/collections/&lt;name&gt;</code>.</p></div>'
    }
  </div>`;
  const error = $('[data-collections-error]', view);
  const failHere = message => {
    if (!error) return fail(new Error(message));
    error.hidden = false;
    error.textContent = message;
  };
  const addDefinition = () =>
    dialog(
      'New collection',
      `${field('Name', '<input name="name" required pattern="[a-z][a-z0-9-]{0,63}" placeholder="providers" autocomplete="off">')}
       ${field('Title', '<input name="title" maxlength="120" placeholder="Providers">')}
       ${field('Description', '<textarea name="description" rows="2" maxlength="2000"></textarea>')}
       ${field('Schema (JSON)', '<textarea name="schema" rows="10" spellcheck="false" placeholder=\'{"type":"object","properties":{}}\'></textarea>')}
       <p class="form-error" data-form-error hidden></p>`,
      async form => {
        try {
          const schema = form.elements.schema.value.trim() ? JSON.parse(form.elements.schema.value) : {type: 'object'};
          await api('collections/' + encodeURIComponent(form.elements.name.value.trim()), {
            method: 'PUT',
            body: {
              title: form.elements.title.value.trim() || form.elements.name.value.trim(),
              description: form.elements.description.value,
              schema,
            },
          });
          await go('/collections/' + encodeURIComponent(form.elements.name.value.trim()));
        } catch (problem) {
          const output = $('[data-form-error]', form);
          output.hidden = false;
          output.textContent = problem.message;
          return false;
        }
      },
      'Create'
    );
  $('[data-collection-add]', view)?.addEventListener('click', addDefinition);
  if (!selected) return;

  const records = await api(`collections/${encodeURIComponent(selected.name)}/records`, {query: {limit: 500}});
  if (app.route !== route) return;
  const body = $('#collection-records', view);
  body.innerHTML = records.records.length
    ? records.records
        .map(
          record =>
            `<tr data-record="${esc(record.id)}"><td><code>${esc(record.id)}</code><pre class="code">${esc(pretty(record.data))}</pre></td><td>${esc(when(record.updated))}</td><td><button type="button" class="icon danger" data-record-delete title="Delete record" aria-label="Delete record">${icon('x')}</button></td></tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="muted">No records yet.</td></tr>';
  const actions = $('#collections-actions', view);
  actions.innerHTML = `<button type="button" data-record-add>${icon('plus')}<span>Add record</span></button><button type="button" class="icon danger" data-collection-delete title="Delete collection" aria-label="Delete collection">${icon('x')}</button>`;
  $('[data-record-add]', view).onclick = () =>
    dialog(
      'Add record',
      `${field('Data (JSON object)', '<textarea name="data" rows="10" spellcheck="false" required placeholder=\'{"name":"local"}\'></textarea>')}<p class="form-error" data-form-error hidden></p>`,
      async form => {
        try {
          await api(`collections/${encodeURIComponent(selected.name)}/records`, {
            method: 'POST',
            body: {data: JSON.parse(form.elements.data.value)},
          });
          await render();
        } catch (problem) {
          const output = $('[data-form-error]', form);
          output.hidden = false;
          output.textContent = problem.message;
          return false;
        }
      },
      'Add'
    );
  for (const button of $$('[data-record-delete]', view))
    button.onclick = async () => {
      const id = button.closest('[data-record]').dataset.record;
      try {
        await api(`collections/${encodeURIComponent(selected.name)}/records/${encodeURIComponent(id)}`, {method: 'DELETE'});
        await render();
      } catch (problem) {
        failHere(problem.message);
      }
    };
  $('[data-collection-delete]', view).onclick = () =>
    confirmDialog(
      'Delete collection?',
      `Delete "${selected.title || selected.name}" and every record in it? This cannot be undone.`,
      async () => {
        try {
          await api(`collections/${encodeURIComponent(selected.name)}?force=1`, {method: 'DELETE'});
          await go('/collections');
        } catch (problem) {
          failHere(problem.message);
        }
      },
      'Delete'
    );
};
