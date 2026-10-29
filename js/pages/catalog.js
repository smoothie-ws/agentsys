// Native Library UI. Plugins supply schemas and actions; cards, navigation, folders and editors belong to the host.
'use strict';

const catalogHref = (section, folder = '', id = '') =>
  `/resources/${encodeURIComponent(section)}${id ? '/' + encodeURIComponent(id) : ''}${folder ? '?folder=' + encodeURIComponent(folder) : ''}`;
const catalogDefinition = id => (app.librarySections ?? []).find(s => s.id === id);
const catalogFolderMenu = (section, folder) => 'catalog-folder:' + section + ':' + encodeURIComponent(folder);
const catalogItemMenu = (section, id) => 'catalog-item:' + section + ':' + id;
const catalogSectionMenu = id => (id === 'nodes' ? 'nodes:' : 'catalog-section:' + id);
const collectionSnapshot = id => app.catalogCollections?.get(id) ?? {folders: [], items: []};
function catalogLibraryRows() {
  const definitions = app.librarySections ?? [];
  const sections = parent =>
    definitions
      .filter(s => s.parent === parent)
      .map(s => {
        if (s.id === 'nodes')
          return {
            key: 's:nodes',
            label: s.title,
            icon: s.icon,
            href: NODES_PATH,
            menu: 'nodes:',
            children: folderRows(''),
          };
        const data = collectionSnapshot(s.id);
        const contents = folder => [
          ...data.folders
            .filter(p => parentPath(p) === folder)
            .map(p => ({
              key: `cf:${s.id}:${p}`,
              label: baseName(p),
              icon: 'folder',
              href: catalogHref(s.id, p),
              menu: catalogFolderMenu(s.id, p),
              children: contents(p),
            })),
          ...data.items
            .filter(r => r.folder === folder)
            .map(r => ({
              key: `ci:${s.id}:${r.id}`,
              label: r.name,
              icon: s.icon,
              href: catalogHref(s.id, r.folder, r.id),
              menu: catalogItemMenu(s.id, r.id),
            })),
        ];
        const children = [...sections(s.id), ...(s.item ? contents('') : [])];
        return {
          key: 'cs:' + s.id,
          label: s.title,
          icon: s.icon,
          href: catalogHref(s.id),
          menu: catalogSectionMenu(s.id),
          ...(children.length || s.item ? {children} : {}),
        };
      });
  return sections(undefined);
}
function catalogSectionCard(section) {
  const children = (app.librarySections ?? []).filter(s => s.parent === section.id),
    data = collectionSnapshot(section.id);
  const rows = children.length
    ? children.map(s => [s.icon, s.title])
    : section.id === 'nodes'
      ? app.resources.slice(0, 4).map(r => [resourceIcon(r), r.name])
      : data.items.slice(0, 4).map(r => [section.icon, r.name]);
  return card({
    href: section.id === 'nodes' ? NODES_PATH : catalogHref(section.id),
    glyph: section.icon,
    title: section.title,
    preview: cardList(rows),
    previewClass: 'card-note',
    facts: section.description,
    menu: catalogSectionMenu(section.id),
  });
}
function catalogCrumbs(section, folder = '') {
  const definitions = app.librarySections ?? [],
    chain = [];
  let parent = section;
  while (parent.parent) {
    parent = definitions.find(s => s.id === parent.parent);
    chain.unshift([parent.title, catalogHref(parent.id)]);
  }
  return [
    ['Library', '/resources'],
    ...chain,
    ...(folder
      ? [
          [section.title, catalogHref(section.id)],
          ...folder
            .split('/')
            .slice(0, -1)
            .map((name, i, parts) => [name, catalogHref(section.id, parts.slice(0, i + 1).join('/'))]),
        ]
      : []),
  ];
}
function catalogControls(section, item = {}) {
  const values = item.values ?? {};
  const fields =
    section.item.format === 'skill'
      ? [{key: 'instructions', label: 'Instructions', type: 'textarea', required: true}]
      : section.item.fields;
  return (
    field(
      'Name',
      `<input name="item_name" required maxlength="${section.item.format === 'skill' ? 64 : 100}" ${section.item.format === 'skill' ? 'pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="skill-name"' : ''} value="${esc(item.name ?? '')}" autofocus>`
    ) +
    field(
      'Description',
      `<textarea name="item_description" rows="2" maxlength="1024" ${section.item.format === 'skill' ? 'required' : ''}>${esc(item.description ?? '')}</textarea>`
    ) +
    fields
      .map(f => {
        const value = values[f.key] ?? f.default ?? '',
          attrs = `name="value_${esc(f.key)}" ${f.required && !(f.type === 'secret' && item.secrets?.[f.key]) ? 'required' : ''}`;
        let control;
        if (f.type === 'boolean')
          control = `<label class="check"><input ${attrs} type="checkbox" ${value ? 'checked' : ''}>${esc(f.label)}</label>`;
        else if (f.type === 'select')
          control = `<select ${attrs}>${f.options.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        else if (f.type === 'json')
          control = `<textarea ${attrs} rows="4" spellcheck="false">${esc(pretty(value === '' ? (f.shape === 'array' ? [] : {}) : value))}</textarea>`;
        else if (f.type === 'textarea')
          control = `<textarea ${attrs} rows="${f.key === 'instructions' ? 12 : 4}">${esc(value)}</textarea>`;
        else if (f.type === 'secret')
          control = `<input ${attrs} type="password" autocomplete="new-password" placeholder="${item.secrets?.[f.key] ? 'Saved key (leave empty to keep)' : 'Not configured'}">${item.secrets?.[f.key] ? `<label class="check small"><input type="checkbox" name="clear_${esc(f.key)}">Remove saved key</label>` : ''}`;
        else
          control = `<input ${attrs} type="${f.type === 'number' ? 'number' : f.format === 'url' ? 'url' : 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(value)}">`;
        const help = f.help ? `<small>${esc(f.help)}</small>` : '';
        if (f.type === 'boolean') return `<div class="field">${control}${help}</div>`;
        if (f.type === 'secret') {
          const split = control.indexOf('<label');
          return (
            field(f.label, (split < 0 ? control : control.slice(0, split)) + help) +
            (split < 0 ? '' : control.slice(split))
          );
        }
        return field(f.label, control + help);
      })
      .join('')
  );
}
function readCatalogControls(form, section) {
  const values = {},
    fields = section.item.format === 'skill' ? [{key: 'instructions', type: 'textarea'}] : section.item.fields;
  for (const field of fields) {
    const el = form.elements.namedItem('value_' + field.key);
    if (field.type === 'secret' && !el.value && !form.elements.namedItem('clear_' + field.key)?.checked) continue;
    if (field.type === 'json') {
      try {
        values[field.key] = JSON.parse(el.value);
      } catch {
        throw new Error(field.label + ': invalid JSON');
      }
    } else
      values[field.key] = field.type === 'boolean' ? el.checked : field.type === 'number' ? Number(el.value) : el.value;
    if (field.type === 'secret' && form.elements.namedItem('clear_' + field.key)?.checked) values[field.key] = '';
  }
  return {name: form.elements.item_name.value.trim(), description: form.elements.item_description.value, values};
}
function newCatalogItem(section, folder = '') {
  dialog(
    'New ' + section.item.name,
    catalogControls(section),
    async form => {
      await api(`library/sections/${section.id}/items`, {
        method: 'POST',
        body: {...readCatalogControls(form, section), folder},
      });
      await loadLibrary();
      await render();
    },
    'Create'
  );
}
function newCatalogFolder(section, folder = '') {
  askGroupName('New group', 'Create', '', async name => {
    await api(`library/sections/${section.id}/folders`, {method: 'POST', body: {action: 'create', path: folder, name}});
    await loadLibrary();
    await render();
  });
}
const catalogRefresh = async () => {
  if (!(await leaveView())) return;
  await loadLibrary();
  await render();
};
function catalogCustomActions(section, actions, context) {
  return (actions ?? []).map(action => [
    action.title,
    async () => {
      const result = await api(`plugins/${section.plugin}/call/${action.endpoint}`, {
        method: 'POST',
        body: {section: section.id, ...context},
      });
      await catalogRefresh();
      if (result?.message) toast(result.message);
    },
  ]);
}
function catalogSectionActions(section, folder = '', actions = section.actions) {
  return [
    ...(section.item
      ? [
          ['New ' + section.item.name, () => newCatalogItem(section, folder), {icon: 'plus'}],
          ['New group', () => newCatalogFolder(section, folder), {icon: 'folder'}],
        ]
      : []),
    ...(section.item?.format === 'skill'
      ? [
          [
            'Import SKILL.md',
            async () => {
              const [file] = await pickFiles({accept: '.md,text/markdown'});
              if (!file) return;
              await api(`library/sections/${section.id}/items`, {
                method: 'POST',
                body: {content: await file.text(), folder},
              });
              await catalogRefresh();
            },
            {icon: 'download'},
          ],
        ]
      : []),
    ...catalogCustomActions(section, actions, {folder}),
    ['Refresh', catalogRefresh, {icon: 'refresh'}],
  ];
}
function catalogFolderActions(section, folder) {
  return [
    ...catalogSectionActions(section, folder, section.folderActions),
    null,
    [
      'Rename',
      () =>
        askGroupName('Rename group', 'Rename', baseName(folder), async name => {
          await api(`library/sections/${section.id}/folders`, {
            method: 'POST',
            body: {action: 'rename', path: folder, name},
          });
          const next = parentPath(folder) ? parentPath(folder) + '/' + name : name;
          await loadLibrary();
          await go(catalogHref(section.id, next), true);
        }),
    ],
    [
      'Delete',
      () =>
        confirmDialog(
          'Delete group?',
          'The group and its items will be removed.',
          async () => {
            await api(`library/sections/${section.id}/folders`, {
              method: 'POST',
              body: {action: 'delete', path: folder},
            });
            await loadLibrary();
            await go(catalogHref(section.id, parentPath(folder)), true);
          },
          'Delete'
        ),
      {danger: true},
    ],
  ];
}
async function catalogItemActions(section, id) {
  const item = await api(`library/sections/${section.id}/items/${id}`);
  return [
    ['Settings', () => go(catalogHref(section.id, item.folder, id)), {icon: 'settings'}],
    [
      'Move',
      () =>
        dialog(
          'Move ' + section.item.name,
          field(
            'Group',
            `<select name="folder"><option value="">${esc(section.title)}</option>${collectionSnapshot(section.id)
              .folders.map(f => `<option ${f === item.folder ? 'selected' : ''}>${esc(f)}</option>`)
              .join('')}</select>`
          ),
          async form => {
            await api(`library/sections/${section.id}/items/${id}`, {
              method: 'PUT',
              body: {folder: form.elements.folder.value},
            });
            await loadLibrary();
            await go(catalogHref(section.id, form.elements.folder.value), true);
          },
          'Move'
        ),
      {icon: 'folder'},
    ],
    [
      'Export resource',
      () => {
        if (section.item.format !== 'skill')
          return downloadJSON({name: item.name, description: item.description, values: item.values}, item.name);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([item.content], {type: 'text/markdown'}));
        link.download = 'SKILL.md';
        link.click();
        URL.revokeObjectURL(link.href);
      },
      {icon: 'upload'},
    ],
    ...catalogCustomActions(section, section.item.actions, {item: id, folder: item.folder}),
    null,
    [
      'Delete',
      () =>
        confirmDialog(
          'Delete ' + section.item.name + '?',
          item.name,
          async () => {
            await api(`library/sections/${section.id}/items/${id}`, {method: 'DELETE'});
            await loadLibrary();
            await go(catalogHref(section.id, item.folder), true);
          },
          'Delete'
        ),
      {danger: true},
    ],
  ];
}
async function catalogPage(view, route) {
  const section = catalogDefinition(route.section);
  if (!section)
    return void (view.innerHTML = `<div class="page">${notFound('Section', '/resources', 'Back to Library')}</div>`);
  const folder = route.folder ?? '',
    data = collectionSnapshot(section.id);
  if (route.id) {
    const item = await api(`library/sections/${section.id}/items/${route.id}`);
    if (app.route !== route) return;
    const crumbs = [
      ...catalogCrumbs(section, item.folder),
      item.folder
        ? [baseName(item.folder), catalogHref(section.id, item.folder)]
        : [section.title, catalogHref(section.id)],
    ];
    view.innerHTML = `<div class="page resource-settings">${pageHead({title: esc(item.name), crumbs, menu: catalogItemMenu(section.id, item.id), actions: '<span id="save-slot"></span>'})}<form id="catalog-item-form" class="catalog-form">${catalogControls(section, item)}</form></div>`;
    const form = $('#catalog-item-form', view);
    pageAutosave(
      form,
      () => readCatalogControls(form, section),
      async body => {
        await api(`library/sections/${section.id}/items/${item.id}`, {method: 'PUT', body});
        await loadLibrary();
        if (form.isConnected) {
          $('.page-head h1', view).textContent = body.name;
          renderSidebar();
        }
      }
    );
    return;
  }
  if (folder && !data.folders.includes(folder))
    return void (view.innerHTML = `<div class="page">${notFound('Group', catalogHref(section.id), 'Back to ' + esc(section.title))}</div>`);
  const children = (app.librarySections ?? []).filter(s => s.parent === section.id),
    folders = data.folders.filter(p => parentPath(p) === folder),
    items = data.items.filter(r => r.folder === folder);
  view.innerHTML = `<div class="page">${pageHead({title: esc(folder ? baseName(folder) : section.title), sub: folder ? '' : esc(section.description), crumbs: catalogCrumbs(section, folder), menu: folder ? catalogFolderMenu(section.id, folder) : catalogSectionMenu(section.id)})}<div class="cards">${children.map(catalogSectionCard).join('')}${folders
    .map(path =>
      card({
        href: catalogHref(section.id, path),
        glyph: 'folder',
        title: baseName(path),
        preview: cardList(
          data.items
            .filter(r => r.folder === path)
            .slice(0, 4)
            .map(r => [section.icon, r.name])
        ),
        previewClass: 'card-note',
        menu: catalogFolderMenu(section.id, path),
      })
    )
    .join(
      ''
    )}${items.map(item => card({href: catalogHref(section.id, folder, item.id), glyph: section.icon, title: item.name, preview: `<p class="resource-description">${esc(item.description || section.item.name)}</p>`, previewClass: 'card-note', menu: catalogItemMenu(section.id, item.id)})).join('')}</div>${children.length || folders.length || items.length ? '' : '<div class="empty small"><h2>No items yet</h2></div>'}</div>`;
}
