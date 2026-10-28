// Pages of the Library: the kinds (providers, skills, Custom Nodes) as cards, the items of one kind, and one item.
'use strict';

// ----- library -----
const RESOURCE_FORMS = {
  provider: p =>
    field(
      'API base URL',
      `<input name="endpoint" required value="${esc(p.endpoint || 'http://127.0.0.1:1234/v1')}">`
    ) +
    `<div class="grid2 provider-keys">${field('API key', `<input name="api_key" type="password" autocomplete="off" value="${esc(p.api_key || '')}" placeholder="Optional">`)}
       <div class="field"><span>Default model</span><div class="input-row"><input name="default_model" list="provider-models" value="${esc(p.default_model || '')}"><button type="button" class="icon" id="provider-models-button" title="Load available models" aria-label="Load available models">${icon('refresh')}</button></div></div></div><datalist id="provider-models"></datalist>
       <details><summary>Request details</summary><div class="grid2">${field('Models path', `<input name="models_path" value="${esc(p.models_path || 'models')}">`)}${field('Chat path', `<input name="chat_path" value="${esc(p.chat_path || 'chat/completions')}">`)}</div>
       ${field('Headers (JSON)', `<textarea name="headers" class="code" rows="3">${esc(pretty(p.headers || {}))}</textarea>`)}${field('Generation options (JSON)', `<textarea name="generation" class="code" rows="3">${esc(pretty(p.generation || {}))}</textarea>`)}</details>
       `,
  skill: p => {
    const document=p.markdown?SkillFile.read(p.markdown):{meta:{description:''},instruction:''};
    return field('Description',`<textarea name="description" rows="2" required maxlength="1024">${esc(document.meta.description)}</textarea>`)+
      field('Instruction',`<textarea name="instruction" rows="10" required>${esc(document.instruction)}</textarea>`);
  },
};

/** Opens the graph editor for a Custom Node: an existing one, or a new one when no id is given. */
async function openNodeEditor(resourceId = null, folder = '', replace = false) {
  const opened = await api('library/node-editor', {method: 'POST', body: {resource_id: resourceId, folder}});
  await go(`/p/${opened.project_id}/w/${opened.workflow_id}`, replace);
}

// ----- the actions behind every "⋯", "+" and drag: on rows of the second panel and on cards alike -----
const NEW_LABEL = {provider: 'provider', skill: 'skill', custom_node: 'node'};
const refreshLibrary = async () => {
  await loadLibrary();
  await render();
};
const newItem = (kind, folder = '') => (kind === 'custom_node' ? openNodeEditor(null, folder) : go(`/resources/${kind}/new${folder?'?folder='+encodeURIComponent(folder):''}`)).catch(fail);
const folderCall = (body,kind='custom_node') => api(kind==='skill'?'library/skill-folders':'library/node-folders', {method:'POST',body});
const moveNode = (id,folder) => {const kind=app.resources.find(r=>r.id===id)?.kind;return api(`library/${kind==='skill'?'skills':'custom-nodes'}/${id}/move`,{method:'POST',body:{folder}}).then(refreshLibrary).catch(fail);};
function askGroupName(title, label, value, save) {
  dialog(title, field('Name', `<input name="name" required maxlength="100" autofocus value="${esc(value)}">`), form => save(form.name.value.trim()), label);
  $('#modal input[name=name]').select();
}
/** Switches a Custom Node, or a group of them, on or off (what the Add menu and the type catalog offer). */
const setEnabled = (target, enabled) =>
  (target.startsWith('f:')
    ? folderCall({action: 'enabled', path: target.slice(2), enabled})
    : api(`library/custom-nodes/${target.slice(2)}/enabled`, {method: 'POST', body: {enabled}})
  )
    .then(refreshLibrary)
    .catch(fail);
const enabledAction = (target, on) => [on ? 'Disable' : 'Enable', () => setEnabled(target, !on), {icon: on ? 'unlink' : 'eye'}];
const newGroup = (parent,kind='custom_node') => askGroupName('New group','Create','',name=>folderCall({action:'create',path:parent,name},kind).then(refreshLibrary));

/** Menus of the groups one can move a Custom Node to, nested like the groups. */
function moveMenu(parent, item) {
  return foldersOf(item.kind)
    .filter(f => parentPath(f) === parent)
    .map(f => {
      const here = [baseName(f), () => moveNode(item.id, f), {icon: 'folder', disabled: item.payload.folder === f}],
        inner = moveMenu(f, item);
      return inner.length ? [here[0], here[1], {...here[2], children: [[`${baseName(f)} (here)`, ...here.slice(1)], null, ...inner]}] : here;
    });
}
/** Whether the open page is (or is inside) what is about to go: it must leave first. */
const showsAny = (items, path) =>
  (path !== undefined && app.route.folder !== undefined && underPath(app.route.folder, path)) ||
  items.some(r => r.id === app.route.id || app.route.project === 'lib-' + r.id);

async function duplicateResource(item) {
  const copy =
    item.kind === 'custom_node'
      ? await api(`library/custom-nodes/${item.id}/duplicate`, {method: 'POST', body: {}})
      : (await addEntries([{kind: item.kind, name: item.name, payload: item.payload}], 'The copy'))[0];
  await loadLibrary();
  await go(resourceHref({kind: item.kind, id: copy.id}));
}
const deleteResource = item =>
  confirmDialog(
    'Delete from library?',
    `“${item.name}” will be removed.${item.kind === 'custom_node' ? ' Copies already placed on canvases keep working.' : ''}`,
    async () => {
      await api(`resources/${item.id}`, {method: 'DELETE'});
      Tabs.dropProject('lib-' + item.id);
      if (showsAny([item])) await go('/resources/' + item.kind, true);
      else await refreshLibrary();
    },
    'Delete'
  );

/** The icon of a Custom Node (the same choice as in the Properties of its main group). */
const changeNodeIcon = item =>
  dialog(
    'Node icon',
    field('Icon', iconGrid(item.payload.icon, 'complex')),
    async form => {
      const icon = form.icon.value;
      await api(`resources/${item.id}`, {method: 'PUT', body: {name: item.name, payload: {...item.payload, icon}}});
      Tabs.setIcon('lib-' + item.id, icon);
      await refreshLibrary();
    },
    'Save'
  );

/** Menu of a Library item. */
function resourceActions(item,title=()=>menuTitle('resource:'+item?.id)) {
  if (!item) return;
  const node = item.kind === 'custom_node';
  return [
    ...(node && !developerMode()
      ? []
      : [
          node
            ? ['Edit graph', () => openNodeEditor(item.id).catch(fail), {icon: 'pencil'}]
            : ['Open', () => go(resourceHref(item)).catch(fail), {icon: 'pencil'}],
          ['Rename',()=>inlineRename(title,item.name,async name=>{
            await api(`resources/${item.id}`,{method:'PUT',body:{name,payload:item.payload}});
            if(node)Tabs.rename('lib-'+item.id,name);
            await refreshLibrary();
          },item.kind==='skill'?{maxLength:64,pattern:'[a-z0-9]+(-[a-z0-9]+)*'}:{}),{icon:'pencil'}],
          ...(node ? [['Change icon', () => changeNodeIcon(item), {icon: 'star'}]] : []),
          ['Duplicate', () => duplicateResource(item).catch(fail), {icon: 'copy'}],
        ]),
    ...(groupedKind(item.kind) && canManageKind(item.kind)
      ? [['Move to', null, {icon: 'folder', children: [['No group', () => moveNode(item.id, ''), {icon: 'package', disabled: !item.payload.folder}], ...(moveMenu('', item).length ? [null, ...moveMenu('', item)] : [])]}]]
      : []),
    ['Export', () => exportResource(item), {icon: 'upload'}],
    ...(node ? [enabledAction('n:' + item.id, item.enabled !== false)] : []),
    null,
    ...(node && !developerMode() ? [] : [['Delete', () => deleteResource(item), {icon: 'trash', danger: true}]]),
  ];
}
/** Menu of a group of Custom Nodes. */
function folderActions(path,kind='custom_node',title=()=>menuTitle(folderSpec(path,kind))) {
  const toggle = kind === 'custom_node' ? [enabledAction('f:' + path, !(app.nodeDisabledFolders || []).includes(path))] : [];
  if (!canManageKind(kind)) return [['Export group', () => exportResources(resourcesOf(kind).filter(r => underPath(r.payload.folder || '', path)), baseName(path)), {icon: 'upload'}], ...toggle];
  const name = baseName(path);
  return [
    ...creationActions(kind, path),
    [
      'Rename',
      () =>
        inlineRename(title,name,async next => {
          await folderCall({action:'rename',path,name:next},kind);
          const moved = (parentPath(path) ? parentPath(path) + '/' : '') + next,
            open = app.route.folder;
          if (open !== undefined && underPath(open, path)) await go(folderHref(moved+open.slice(path.length),kind), true);
          else await refreshLibrary();
        }),
      {icon: 'pencil'},
    ],
    ['Export group',()=>exportResources(resourcesOf(kind).filter(r=>underPath(r.payload.folder || '',path)),name),{icon:'upload'}],
    [
      'Change icon',
      () =>
        dialog(
          'Group icon',
          field('Icon', iconGrid(folderIconsOf(kind)[path], 'folder')),
          form => folderCall({action:'icon',path,icon:form.icon.value},kind).then(refreshLibrary),
          'Save'
        ),
      {icon: 'star'},
    ],
    ...toggle,
    null,
    [
      'Delete group',
      () => {
        const inside = resourcesOf(kind).filter(r => underPath(r.payload.folder || '', path)),
          groups = foldersOf(kind).filter(f => f !== path && underPath(f, path)).length;
        confirmDialog(
          'Delete group and contents?',
          `“${name}” is removed with everything in it: ${plural(groups, 'group')} and ${plural(inside.length,kind==='skill'?'skill':'Custom Node')}. This cannot be undone.`,
          async () => {
            const leave = showsAny(inside, path);
            await folderCall({action:'delete',path},kind);
            for (const r of inside) Tabs.dropProject('lib-' + r.id);
            if (leave) await go(parentPath(path) ? folderHref(parentPath(path),kind) : '/resources/'+kind, true);
            else await refreshLibrary();
          },
          'Delete'
        );
      },
      {icon: 'trash', danger: true},
    ],
  ];
}
/** Add… and New group, first in the menu of a kind and of a group (what the page offers as its buttons). */
const creationActions = (kind, folder) =>
  canManageKind(kind)
    ? [
        [`Add…`, () => newItem(kind, folder), {icon: 'plus'}],
        ...(groupedKind(kind) ? [['New group', () => newGroup(folder, kind), {icon: 'folder'}]] : []),
        null,
      ]
    : [];
/** Menu of a kind (a row or card of a kind). */
function kindActions(kind) {
  const items = resourcesOf(kind);
  return [
    ...creationActions(kind, ''),
    ['Import…', () => importFiles(), {icon: 'download'}],
    ['Export all', () => exportResources(items, KINDS[kind]), {icon: 'upload', disabled: !items.length}],
    ['Restore built-in items',()=>restoreBuiltins(kind),{icon:'library'}],
  ];
}
/** The "+" of the second panel. */
const libraryAddItems = () => [
  ['Import…', () => importFiles(), {icon: 'download'}],
  ['Export all',()=>exportResources(app.resources,'Library'),{icon:'upload',disabled:!app.resources.length}],
  ['Restore built-in items', () => restoreBuiltins(), {icon: 'library'}],
];
async function importFiles() {
  const files = await pickFiles({accept:'.json,.md,application/json,text/markdown'});
  if (!files.length) return;
  try {
    const made = await importResources(files);
    toast(`${plural(made.length, 'item')} imported.`);
    await loadLibrary();
    await go(made.length === 1 && (made[0].kind !== 'custom_node' || developerMode()) ? resourceHref(made[0]) : `/resources/${made[0].kind}`, true);
  } catch (error) {
    fail(error);
  }
}

// Drag a Custom Node (a row of the second panel or a card) onto a group, or onto "Nodes" itself, to move it there.
const clearDrop = () => $$('.drop-over').forEach(e => e.classList.remove('drop-over'));
document.addEventListener('dragstart', event => {
  const node = event.target.closest?.('[data-drag]');
  if (!node) return;
  event.dataTransfer.setData('text/plain', node.dataset.drag);
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', event => {
  const spot = event.target.closest?.('[data-drop-folder]');
  if (spot && !canManageKind(spot.dataset.dropKind || 'custom_node')) return;
  if (!spot) return;
  event.preventDefault();
  clearDrop();
  spot.classList.add('drop-over');
});
document.addEventListener('dragleave', event => event.relatedTarget || clearDrop());
document.addEventListener('dragend', clearDrop);
document.addEventListener('drop', event => {
  const spot = event.target.closest?.('[data-drop-folder]'),
    id = event.dataTransfer.getData('text/plain');
  clearDrop();
  const kind=spot?.dataset.dropKind || 'custom_node';
  if (!spot || !canManageKind(kind) || !resourcesOf(kind).some(r=>r.id===id)) return;
  event.preventDefault();
  moveNode(id, spot.dataset.dropFolder);
});

function readResource(kind, form) {
  const json = name => {
    try {
      return JSON.parse(form[name].value || '{}');
    } catch {
      throw new Error(`${name} must be valid JSON.`);
    }
  };
  if (kind === 'provider')
    return {
      endpoint: form.endpoint.value,
      api_key: form.api_key.value,
      default_model: form.default_model.value,
      models_path: form.models_path.value,
      chat_path: form.chat_path.value,
      headers: json('headers'),
      generation: json('generation'),
    };
  const current=app.resources.find(r=>r.id===app.route.id);
  const meta=current?.payload.markdown?SkillFile.read(current.payload.markdown).meta:{};
  return {markdown:SkillFile.write({...meta,name:form.name.value.trim(),description:form.description.value},form.instruction.value),folder:current?.payload.folder || app.route.folder || ''};
}

// ----- import / export -----
/** Saves Library items as one JSON file (a single item is saved as an object, several as a list). */
function exportResources(items, name) {
  if(items.length===1&&items[0].kind==='skill'){downloadText(items[0].payload.markdown,'SKILL.md','text/markdown');return;}
  const entries = items.map(r => ({kind: r.kind, name: r.name, payload: r.payload}));
  const text = JSON.stringify(TextGraph.encode(entries.length === 1 ? entries[0] : entries), null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  link.download = `${name.replace(/[^\w\-. ]+/g, '_').trim() || 'library'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function downloadText(text,name,type){const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([text],{type}));link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
const exportResource = item => exportResources([item], `${item.name}.${item.kind}`);

/** Adds exported Library items. A name already taken gets a number, or with `skipTaken` the item is left out. Returns the items made. */
async function addEntries(entries, source, skipTaken = false) {
  const made = [],
    // Names must be unique per kind; the list is read once and kept in step as items are added.
    taken = new Set((await api('resources')).map(r => r.kind + '/' + r.name));
  for (const entry of entries) {
    if (!entry || !KINDS[entry.kind] || typeof entry.name !== 'string' || !entry.payload || typeof entry.payload !== 'object')
      throw new Error(`${source} is not an exported Library item.`);
    let name = entry.kind==='skill'?SkillFile.slug(entry.name):entry.name.trim().slice(0,100) || 'Imported',
      n = 1;
    const base = name,
      key = () => entry.kind + '/' + name;
    if (skipTaken && taken.has(key())) continue;
    while (taken.has(key())) name = entry.kind==='skill'?`${base.slice(0,60)}-${++n}`:`${base} ${++n}`;
    taken.add(key());
    const payload = {...entry.payload};
    if(entry.kind==='skill'&&!payload.markdown){payload.description ||= name;payload.instruction ||= '';} // a Custom Node keeps its group, so the tree comes back as it was exported
    const saved = await api('resources', {method: 'POST', body: {kind: entry.kind, name, payload}});
    // The main group of a Custom Node carries the node's name; PUT keeps that in step.
    if (entry.kind === 'custom_node') await api(`resources/${saved.id}`, {method: 'PUT', body: {name, payload: saved.payload}});
    made.push(saved);
  }
  return made;
}

/** Reads JSON files and adds their items to the Library. */
async function importResources(files) {
  const made = [];
  for (const file of files) {
    let data;
    try {
      const text=await file.text();
      if(/\.md$/i.test(file.name)||/^---\r?\n/.test(text)){const document=SkillFile.read(text);data={kind:'skill',name:document.meta.name,payload:{markdown:text}};}
      else data=TextGraph.decode(JSON.parse(text));
    } catch(error) {
      throw new Error(`${file.name}: ${error.message || 'invalid Library file'}`);
    }
    made.push(...(await addEntries(Array.isArray(data) ? data : [data], file.name)));
  }
  return made;
}

// ----- built-in items -----
// builtin/providers.json and skills/*/SKILL.md are Library exports (the files "Export" saves), one per kind.
// Their items are imported once, on the first run; after that they are ordinary items, the user's to keep, change or delete.
// "Restore built-in items" adds back the ones that are gone. A missing file is simply skipped.
const BUILTIN_FILES = ['providers'];
async function builtinEntries() {
  const entries = [];
  let found = 0;
  for (const name of BUILTIN_FILES) {
    const response = await fetch(assetURL(`builtin/${name}.json`), {cache: 'no-store'}).catch(() => null);
    if (!response?.ok) continue;
    found++;
    let data;
    try {
      data = TextGraph.decode(await response.json());
    } catch {
      throw new Error(`builtin/${name}.json is not valid JSON.`);
    }
    entries.push(...(Array.isArray(data) ? data : [data]));
  }
  const skills=await fetch(assetURL('builtin/skills/index.json'),{cache:'no-store'}).then(r=>r.ok?r.json():[]).catch(()=>[]);
  for(const name of skills){const markdown=await fetch(assetURL(`builtin/skills/${name}/SKILL.md`)).then(r=>{if(!r.ok)throw new Error('Could not load built-in skill');return r.text();});const document=SkillFile.read(markdown);entries.push({kind:'skill',name:document.meta.name,payload:{markdown}});found++;}
  if (!found) throw new Error('The built-in items are not available here.');
  return entries;
}
async function seedBuiltins() {
  const {seeded, names} = await api('library/builtins');
  const entries = await builtinEntries();
  const known = seeded ? names || entries.map(e => e.name) : [];
  const fresh = entries.filter(e => !known.includes(e.name));
  if (!fresh.length) return seeded ? undefined : api('library/builtins', {method: 'PUT', body: {names: []}});
  await addEntries(fresh, 'The built-in items', true);
  await api('library/builtins', {method: 'PUT', body: {names: entries.map(e => e.name)}});
}
/** Puts the built-in items back: the ones that are gone are added, the ones that are there are overwritten with the built-in version. */
function restoreBuiltins(kind) {
  confirmDialog(
    'Restore built-in items?',
    'Built-in items that are in the Library are overwritten with their original version (a provider loses its endpoint and key); the ones that are missing are added back.',
    async () => {
      const entries = (await builtinEntries()).filter(item => !kind || item.kind === kind),
        existing = await api('resources');
      let added = 0,
        replaced = 0;
      for (const entry of entries) {
        const name = entry.kind === 'skill' ? SkillFile.slug(entry.name) : String(entry.name).trim().slice(0, 100),
          old = existing.find(r => r.kind === entry.kind && r.name === name);
        if (!old) {
          added += (await addEntries([entry], 'The built-in items', true)).length;
          continue;
        }
        const payload = {...entry.payload};
        if (entry.kind === 'skill' && old.payload.folder && !payload.folder) payload.folder = old.payload.folder;
        await api(`resources/${old.id}`, {method: 'PUT', body: {name: old.name, payload, replace: true}});
        replaced++;
      }
      await loadLibrary();
      toast(`Built-in items restored: ${added} added, ${replaced} overwritten.`);
      await render();
    },
    'Restore'
  );
}

// ----- pages -----
/** A well listing what is inside (first rows, then a count of the rest). */
const cardList = rows =>
  rows.length
    ? `<ul>${rows.slice(0, 4).map(([glyph, name]) => `<li>${icon(glyph)}<span>${esc(name)}</span></li>`).join('')}${rows.length > 4 ? `<li class="more">+${rows.length - 4} more</li>` : ''}</ul>`
    : '<span class="preview-empty">Nothing here yet</span>';
const words = text => (text.trim().match(/\S+/g) || []).length;
/** What a card of each kind shows: a preview and a line of facts. */
const ITEM_SUMMARY = {
  provider: p => ({preview: `<p class="card-text"><code>${esc(p.endpoint)}</code></p>`, facts: p.default_model ? 'Model ' + esc(p.default_model) : 'No default model'}),
  skill: p=>{const document=SkillFile.read(p.markdown);return {preview:`<p class="card-text">${esc(document.meta.description)}</p>`,facts:plural(words(document.instruction),'word')};},
  custom_node: p => ({
    preview: `<div class="preview-layer">${previewSVG(graphFromBundle(p.bundle))}</div>`,
    facts: p.description ? esc(p.description) : '',
  }),
};
const itemCard = r => {
  const summary = ITEM_SUMMARY[r.kind in ITEM_SUMMARY ? r.kind : 'skill'](r.payload),
    node = r.kind === 'custom_node';
  return card({
    href: node && !developerMode() ? null : resourceHref(r),
    glyph: resourceIcon(r),
    title: r.name,
    ...summary,
    previewClass: node ? '' : 'card-note',
    menu: 'resource:' + r.id,
    tint: node ? 'k-complex' : '',
    enable: node
      ? {
          target: 'n:' + r.id,
          on: nodeOn(r),
          locked: !folderOn(String(r.payload.folder || '')),
          title: nodeOn(r) ? 'Enabled: offered in the Add menu' : 'Disabled: not in the Add menu',
        }
      : null,
    extra: groupedKind(r.kind) && canManageKind(r.kind) ? `draggable="true" data-drag="${esc(r.id)}"` : '',
  });
};
const folderCard = (path,nodes,kind='custom_node') => {
  const groups = foldersOf(kind).filter(f => f !== path && underPath(f, path)).length;
  return card({
    href: folderHref(path,kind),
    glyph: folderIconsOf(kind)[path] || 'folder',
    title: baseName(path),
    preview: cardList(nodes),
    previewClass: 'card-note',
    facts: groups ? plural(groups, 'group') : '',
    menu:folderSpec(path,kind),
    enable:
      kind === 'custom_node'
        ? {
            target: 'f:' + path,
            on: folderOn(path),
            locked: parentPath(path) && !folderOn(parentPath(path)),
            title: folderOn(path) ? 'Enabled: its Custom Nodes are offered in the Add menu' : 'Disabled: nothing in it is offered',
          }
        : null,
    extra: canManageKind(kind) ? `data-drop-folder="${esc(path)}" data-drop-kind="${kind}"` : '',
  });
};
const notFound = (what, href, back) => `<div class="empty"><h2>${what} not found</h2><p><a href="${esc(href)}" data-link>${esc(back)}</a></p></div>`;

/** The one button at the top right of a Library page: the "⋯" menu of what the page shows (the same menu as its row in the second panel). */
const pageMenu = (spec, name) => `<button class="icon" data-menu="${esc(spec)}" title="Actions" aria-label="Actions of ${esc(name)}">${icon('dots')}</button>`;

/** The Library itself: its kinds as cards. */
function libraryOverview(view) {
  view.innerHTML = `<div class="page">${pageHead({
    title: 'Library',
    sub: 'Model providers, reusable text and nodes.',
    actions: pageMenu('library:', 'Library'),
  })}
    <div class="cards">${Object.entries(KINDS)
      .map(([kind, label]) => {
        const items = resourcesOf(kind),
          top = groupedKind(kind)?foldersOf(kind).filter(f=>!f.includes('/')):[];
        return card({
          href: `/resources/${kind}`,
          glyph: KIND_ICONS[kind],
          title: label,
          preview: cardList([...top.map(f => [folderIconsOf(kind)[f] || 'folder', baseName(f)]), ...items.filter(r => !(r.payload.folder || '')).map(r => [resourceIcon(r), r.name])]),
          previewClass: 'card-note',
          facts: plural(items.length, 'item'),
          menu: 'kind:' + kind,
        });
      })
      .join('')}</div></div>`;
}

/** One kind of item (or one group of Custom Nodes): its items as cards. */
function resourceList(view, route) {
  const kind = route.kind,
    tree=groupedKind(kind),
    folder=tree?route.folder || '':'',
    folders = tree ? foldersOf(kind).filter(f => parentPath(f) === folder) : [],
    items = resourcesOf(kind).filter(r => !tree || (r.payload.folder || '') === folder);
  if (folder && !foldersOf(kind).includes(folder))
    return void (view.innerHTML = `<div class="page">${notFound('Group', '/resources/'+kind, 'Back to '+KINDS[kind])}</div>`);
  const chain = folder.split('/').map((name, i, parts) => [name, folderHref(parts.slice(0,i+1).join('/'),kind)]);
  const content = path => resourcesOf(kind).filter(r => (r.payload.folder || '') === path).map(r => [resourceIcon(r), r.name]);
  view.innerHTML = `<div class="page">${pageHead({
    crumbs: [['Library', '/resources'], ...(folder ? [[KINDS[kind], `/resources/${kind}`], ...chain.slice(0, -1)] : [])],
    title: esc(folder ? baseName(folder) : KINDS[kind]),
    actions: pageMenu(folder ? folderSpec(folder, kind) : 'kind:' + kind, folder ? baseName(folder) : KINDS[kind]),
  })}
    <div class="cards">${folders.map(f => folderCard(f, [...foldersOf(kind).filter(g => parentPath(g) === f).map(g => [folderIconsOf(kind)[g] || 'folder', baseName(g)]), ...content(f)],kind)).join('')}${items.map(itemCard).join('')}</div>
    ${folders.length || items.length ? '' : `<div class="empty small"><h2>No ${KINDS[kind].toLowerCase()} here yet</h2></div>`}</div>`;
  for (const box of $$('[data-enable]', view)) box.onchange = () => setEnabled(box.dataset.enable, box.checked);
}

/** One item: its form. */
function resourceEditor(view, route) {
  const kind = route.kind,
    current = resourcesOf(kind).find(r => r.id === route.id);
  if (!current && route.id !== 'new')
    return void (view.innerHTML = `<div class="page">${notFound('Item', `/resources/${kind}`, `Back to ${KINDS[kind]}`)}</div>`);
  view.innerHTML = `<div class="page form-page">${pageHead({
    crumbs: [['Library', '/resources'], [KINDS[kind], `/resources/${kind}`]],
    title: esc(current?.name || `New ${NEW_LABEL[kind]}`),
  })}
    <form id="resource-form" class="resource-editor">${field('Name', `<input name="name" required ${kind==='skill'?'maxlength="64" pattern="[a-z0-9]+(-[a-z0-9]+)*"':'maxlength="100"'} value="${esc(current?.name || '')}" ${current ? '' : 'autofocus'}>`)}
      ${RESOURCE_FORMS[kind](current?.payload || {})}
      <div class="actions">${current ? '<button type="button" class="ghost danger" id="delete-resource">Delete</button>' : ''}${current ? `<button type="button" id="export-resource">${icon('upload')}Export</button>` : ''}<button class="primary">${current ? 'Save' : 'Add'}</button></div></form></div>`;
  const form = $('#resource-form');
  if(current)bindNameField(form.name,()=>form.requestSubmit($('button.primary',form)));
  $('#export-resource', form)?.addEventListener('click', () => exportResource(current));
  $('#provider-models-button', form)?.addEventListener('click', async () => {
    try {
      const models = await api('providers/models', {method: 'POST', body: readResource('provider', form)});
      $('#provider-models').innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
      toast(`${plural(models.length, 'model')} available.`);
    } catch (error) {
      fail(error);
    }
  });
  $('#delete-resource')?.addEventListener('click', () => deleteResource(current));
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      const body = {name: form.name.value, payload: readResource(kind, form)};
      const saved = current
        ? await api(`resources/${current.id}`, {method: 'PUT', body})
        : await api('resources', {method: 'POST', body: {...body, kind}});
      toast('Saved.');
      await go(resourceHref(saved), true);
    } catch (error) {
      fail(error);
    }
  };
}

PAGES.resources = async (view, route) => {
  await loadLibrary();
  if (!KINDS[route.kind]) libraryOverview(view);
  else if (route.id && route.kind === 'custom_node' && !developerMode())
    await go('/resources/custom_node',true);
  else if (route.id && route.kind === 'custom_node') await openNodeEditor(route.id, '', true).catch(fail); // a node opens as a graph
  else if (route.id) resourceEditor(view, route);
  else resourceList(view, route);
};
