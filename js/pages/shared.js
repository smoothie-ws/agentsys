// Pieces shared by pages: the PAGES registry, the page header and the card every page uses, inline rename, graph previews, Library helpers.
'use strict';

const PAGES = {};
/** Update only a page's live regions; keep forms and focus. */
function livePage(route, update) {
  let stopped = false,
    busy = false,
    again = false,
    timer;
  const run = async () => {
    if (stopped || app.route !== route || document.hidden) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await update();
      if (!stopped && app.route === route) {
        const status = $('[data-live-status]');
        if (status) status.textContent = 'Live';
      }
    } catch {
      if (!stopped && app.route === route) {
        const status = $('[data-live-status]');
        if (status) status.textContent = 'Connection interrupted · retrying';
      }
    } finally {
      busy = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        run();
      }, 250);
  };
  const unsubscribe = Backend.subscribe(schedule, {own: true});
  const interval = setInterval(run, 3000);
  document.addEventListener('visibilitychange', schedule);
  app.pageDispose = () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    unsubscribe();
    document.removeEventListener('visibilitychange', schedule);
  };
  return run;
}
/** A common save lifecycle for settings pages and Library resource editors. */
function pageAutosave(form, read, write) {
  const save = autoForm(form, read, write),
    status = $('.save-status', form);
  $('#save-slot', $('#view'))?.replaceWith(status);
  app.pageSave = save;
  leaveGuards.push(() => leaveAutosave(save));
  return save;
}
const COMMON_CAPABILITIES = [
  'graph.read',
  'graph.write',
  'library.read',
  'library.write',
  'net.fetch:*',
  'run.read',
  'run.start',
];
function permissionChoices(capabilities, grants, attr = 'data-grant', prefix = 'grant') {
  return `<table class="permission-table"><thead><tr><th scope="col">Permission</th><th scope="col">Allow</th><th scope="col">Disallow</th></tr></thead><tbody>${capabilities.map(cap => `<tr><th scope="row">${esc(cap)}</th><td><label class="permission-choice"><input type="radio" name="${prefix}:${esc(cap)}" value="allow" ${attr}="${esc(cap)}" aria-label="Allow ${esc(cap)}" ${grants.includes(cap) ? 'checked' : ''}></label></td><td><label class="permission-choice"><input type="radio" name="${prefix}:${esc(cap)}" value="disallow" aria-label="Disallow ${esc(cap)}" ${grants.includes(cap) ? '' : 'checked'}></label></td></tr>`).join('')}</tbody></table>`;
}
function grantControls(
  grants = [],
  {hint = 'Permissions are limited by the parent node.', title = 'Permissions', prefix = 'grant'} = {}
) {
  const extra = grants.filter(v => !COMMON_CAPABILITIES.includes(v)).join(', ');
  return `<fieldset class="permission-controls" data-grants title="${esc(hint)}"><legend title="${esc(hint)}">${esc(title)}</legend><div class="permission-fields">${permissionChoices(COMMON_CAPABILITIES, grants, 'data-grant', prefix)}<label class="field"><span>Specific permissions</span><input name="extra_grants" value="${esc(extra)}" placeholder="net.fetch:example.com"></label></div></fieldset>`;
}
function readGrantControls(root) {
  const box = $('[data-grants]', root);
  return [
    ...new Set([
      ...$$('input[data-grant]:checked', box).map(el => el.getAttribute('data-grant')),
      ...(box.querySelector('[name=extra_grants]').value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean),
    ]),
  ];
}
/**
 * Splits a settings form into sections shown one at a time. The list of sections lives in the second panel
 * (a form with one section needs none); the open one is remembered by the page's tab.
 */
function showSectionPanel(form, section = sectionOf(app.route)) {
  const definitions = SECTION_PANELS[section];
  const sections = [...form.children].filter(el => el.tagName === 'SECTION');
  if (!definitions || definitions.length < 2) return;
  const index = definitions.findIndex(([key]) => key === selectedPanel(section));
  sections.forEach((section, i) => {
    section.id ||= 'section-panel-' + i;
    section.hidden = i !== index;
  });
  form.addEventListener(
    'invalid',
    event => {
      const i = sections.findIndex(s => s.contains(event.target));
      if (i >= 0 && sections[i].hidden) go(sectionHref(section, definitions[i][0])).catch(fail);
    },
    true
  );
}
const actionButton = (menu, label = 'Actions') =>
  menu
    ? `<button type="button" class="icon" data-menu="${esc(menu)}" title="${esc(label)}" aria-label="${esc(label)}">${icon('dots')}</button>`
    : '';

/** The common page heading, description and actions. `title` and `sub` are HTML. */
const pageHead = ({title, sub = '', glyph = '', actions = '', menu = pageMenu()}) =>
  `<header class="page-head"><div><h1 class="page-title"${sub ? ` title="${sub.replace(/"/g, '&quot;')}"` : ''}>${glyph ? icon(glyph) : ''}${title}</h1></div><div class="actions">${actions}${actionButton(menu)}</div></header>`;

/**
 * The card of every page (projects, workflows, Library nodes and groups), built like a node of the canvas: a header with an icon
 * and the name, a well showing what is inside, a line of facts, and its buttons. `menu` is what its "⋯" opens (see menuItems in nav.js);
 * `attrs` marks the title for renaming on the spot; `tint` is "k-complex" for what is made of other nodes; `extra` goes on the card itself.
 */
function card({
  href,
  glyph,
  title,
  attrs = '',
  preview = '',
  previewAttrs = '',
  previewClass = '',
  facts = '',
  menu = '',
  tint = '',
  extra = '',
}) {
  const tag = href ? 'a' : 'div';
  return `<article class="card ${tint}" ${extra}><${tag} class="card-main" ${href ? `href="${esc(href)}" data-link` : ''}><header class="card-head"><span class="head-icon">${icon(glyph)}</span><h3><span ${attrs}>${esc(title)}</span></h3></header><div class="card-preview ${previewClass}" ${previewAttrs}>${preview}</div>${facts ? `<p class="card-facts">${facts}</p>` : ''}</${tag}><span class="card-actions">${menu ? `<button class="icon" data-menu="${esc(menu)}" aria-label="Actions of ${esc(title)}">${icon('dots')}</button>` : ''}</span></article>`;
}

function inlineRename(title, value, save, {maxLength = 100, pattern = ''} = {}) {
  if (typeof title === 'function') title = title();
  title ||= $('.page-head h1');
  if (!title || $('.inline-rename', title)) return;
  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = value;
  input.maxLength = maxLength;
  input.required = true;
  if (pattern) input.pattern = pattern;
  input.setAttribute('aria-label', 'Rename');
  title.replaceChildren(input);
  title.closest('[draggable]')?.setAttribute('draggable', 'false');
  const folded = title.closest('#subnav') && document.body.classList.contains('subnav-collapsed');
  if (folded) document.body.classList.remove('subnav-collapsed');
  let saving = false;
  const finish = text => {
    title.textContent = text;
    title.closest('[draggable]')?.setAttribute('draggable', 'true');
    if (folded) {
      document.body.classList.add('subnav-collapsed');
      followPills();
    }
  };
  const restore = () => {
    if (!saving) finish(value);
  };
  input.onblur = restore;
  input.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
  };
  input.onpointerdown = event => event.stopPropagation();
  input.oninput = input.onchange = event => event.stopPropagation();
  input.onkeydown = async event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
    }
    if (event.key !== 'Enter' || event.isComposing || saving) return;
    event.preventDefault();
    const next = input.value.trim();
    input.value = next;
    if (!input.reportValidity()) return;
    if (next === value) return restore();
    saving = true;
    input.disabled = true;
    try {
      await save(next);
      finish(next);
    } catch (error) {
      saving = false;
      restore();
      fail(error);
    }
  };
  input.focus();
  input.select();
}

function menuTitle(spec, owner) {
  const button = $(`[data-menu="${CSS.escape(spec)}"]`);
  const root = owner?.closest?.('.card,.subnav-row,.tab') || button?.closest('.card,.subnav-row');
  return root && $('h3 > span, :scope > a > span, :scope > .subnav-static > span, .tab-title', root);
}

document.addEventListener('keydown', async event => {
  if (
    event.defaultPrevented ||
    !matches('renameGroup', event) ||
    $('#modal').open ||
    event.target.closest('input,textarea,select,[contenteditable=true]')
  )
    return;
  const owner = event.target.closest('.card,.subnav-row,.tab');
  let spec = owner?.querySelector('[data-menu]')?.dataset.menu || owner?.dataset.menu;
  if (owner?.dataset.tab) {
    const [project, workflow] = owner.dataset.tab.split('/');
    spec = project.startsWith('lib-') ? 'resource:' + project.slice(4) : `workflow:${project}:${workflow}`;
  }
  if (!spec && app.route.workflow) {
    event.preventDefault();
    return renameSelection();
  }
  if (!spec && app.route.id && app.route.id !== 'new') spec = 'resource:' + app.route.id;
  if (!spec && app.route.folder) spec = 'folder:' + app.route.folder;
  if (!spec && app.route.project) spec = 'project:' + app.route.project;
  if (!spec) return;
  event.preventDefault();
  try {
    const action = (await menuItems(spec, owner))?.find(item => item?.[0] === 'Rename');
    action?.[1]();
  } catch (error) {
    fail(error);
  }
});

function previewSVG(graph) {
  const map = Editor.nodeMap(graph),
    groupsById = new Map(graph.groups.map(g => [g.id, g]));
  // Everything inside a collapsed Complex Node is drawn as that one node (the outermost one wins).
  const collapsed = graph.complex.filter(c => c.collapsed).sort((x, y) => x.depth - y.depth),
    hiddenBy = new Map(),
    hiddenGroups = new Set();
  for (const c of collapsed) {
    if (hiddenBy.has('complex:' + c.id)) continue;
    for (const id of c.members) if (!hiddenBy.has(id)) hiddenBy.set(id, 'complex:' + c.id);
    for (const g of graph.groups) if (g.id === c.id || isInside(groupsById, g, c.id)) hiddenGroups.add(g.id);
  }
  const nodes = [
    ...graph.nodes.filter(n => !hiddenBy.has(n.id)),
    ...collapsed
      .filter(c => !hiddenBy.has('complex:' + c.id))
      .map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'})),
  ];
  if (!nodes.length) return '<span class="preview-empty">Empty workflow</span>';
  const positions = new Map(
    nodes.map((n, i) => {
      const p = n.position || {x: i * 280, y: 0};
      return [
        n.id,
        {
          x: p.x,
          y: p.y,
          w: n.kind === 'complex' ? n.compact_width : p.width || 236,
          h: n.kind === 'complex' ? n.compact_height : p.height || 90,
        },
      ];
    })
  );
  const boxes = [...positions.values()],
    x = Math.min(...boxes.map(p => p.x)) - 30,
    y = Math.min(...boxes.map(p => p.y)) - 30;
  const w = Math.max(...boxes.map(p => p.x + p.w)) - x + 30,
    h = Math.max(...boxes.map(p => p.y + p.h)) - y + 30;
  const endpoint = (id, port, direction) => {
    let at = id;
    try {
      at = Editor.resolve(map, id, port, direction)[0];
    } catch {
      /* dangling port */
    }
    return hiddenBy.get(at) || at;
  };
  const edges = graph.edges
    .map(e => {
      const from = endpoint(e.source, e.source_port, 'outputs'),
        to = endpoint(e.target, e.target_port, 'inputs');
      if (from === to) return '';
      const a = positions.get(from),
        b = positions.get(to);
      if (!a || !b) return '';
      const x1 = a.x + a.w,
        y1 = a.y + 20,
        x2 = b.x,
        y2 = b.y + 20,
        d = Math.max(40, Math.abs(x2 - x1) / 2);
      return `<path d="M${x1} ${y1} C${x1 + d} ${y1} ${x2 - d} ${y2} ${x2} ${y2}"/>`;
    })
    .join('');
  const frames = graph.groups
    .filter(g => !hiddenGroups.has(g.id))
    .sort((p, q) => p.depth - q.depth)
    .map(g => {
      const members = g.all_members.map(id => positions.get(id)).filter(Boolean);
      if (!members.length) return '';
      const pad = 15 + 8 * (3 - Math.min(3, g.depth));
      const left = Math.min(...members.map(p => p.x)) - pad,
        top = Math.min(...members.map(p => p.y)) - pad - 7;
      const width = Math.max(...members.map(p => p.x + p.w)) - left + pad,
        height = Math.max(...members.map(p => p.y + p.h)) - top + pad;
      return `<rect class="preview-frame" ${g.color ? `style="--c:${esc(g.color)}" ` : ''}x="${left}" y="${top}" width="${width}" height="${height}" rx="16"/>`;
    })
    .join('');
  return `<svg viewBox="${x} ${y} ${w} ${h}" aria-hidden="true">${frames}<g class="preview-wires">${edges}</g>${nodes
    .map(n => {
      const p = positions.get(n.id);
      return `<rect class="preview-node k-${n.kind === 'complex' ? 'complex' : 'node'} s-${esc(n.status || 'ready')}" ${n.color ? `style="--c:${esc(n.color)}" ` : ''}x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="12"/>`;
    })
    .join('')}</svg>`;
}

/** Load only visible cards, with a bounded number of requests. */
function loadCardPreviews(view, projectId = null) {
  const queue = [];
  let active = 0,
    stopped = false;
  const run = () => {
    while (!stopped && active < 3 && queue.length) {
      const card = queue.shift();
      active++;
      (async () => {
        const pid = projectId || card.dataset.previewProject;
        const workflows = projectId
          ? [{id: card.dataset.previewWorkflow}]
          : (await api(`projects/${pid}/workflows`)).slice(0, 3);
        const graphs = [];
        for (const workflow of workflows) {
          if (stopped) return;
          graphs.push(await api(`projects/${pid}/workflow`, {query: {workflow_id: workflow.id}}));
        }
        if (stopped || !card.isConnected) return;
        card.innerHTML =
          graphs.map((g, i) => `<div class="preview-layer" style="--layer:${i}">${previewSVG(g)}</div>`).join('') ||
          '<span class="preview-empty">No workflows</span>';
      })()
        .catch(() => {
          if (card.isConnected) card.innerHTML = '<span class="preview-empty">Preview unavailable</span>';
        })
        .finally(() => {
          active--;
          run();
        });
    }
  };
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          queue.push(entry.target);
        }
      run();
    },
    {root: $('#view'), rootMargin: '100px'}
  );
  $$('[data-preview-project], [data-preview-workflow]', view).forEach(card => observer.observe(card));
  leaveGuards.push(() => {
    stopped = true;
    observer.disconnect();
  });
}

async function loadLibrary() {
  const [settings, sections] = await Promise.all([api('settings'), api('library/sections')]);
  app.librarySections = sections;
  app.resources = settings.resources;
  app.nodeFolders = settings.node_folders || [];
  app.nodeFolderIcons = settings.node_folder_icons || {};
  app.preferences = settings.preferences;
  return settings;
}
const baseName = path => path.slice(path.lastIndexOf('/') + 1);
/** The Library has sections (now one: Nodes) under /library; the nodes live at /library/nodes. */
const NODES_PATH = '/library/nodes';
const resourceHref = r => `${NODES_PATH}/${r.id}`;
const folderHref = path => `${NODES_PATH}?folder=${encodeURIComponent(path)}`;
const folderKey = path => 'f:' + path;
const resourceIcon = r => r.payload.icon || 'complex';

/** A saved Custom Node as the graph previewSVG draws: its nodes where they are, the groups around their members, the wires. */
function graphFromBundle(bundle) {
  const groups = bundle?.groups || [],
    byId = new Map(groups.map(g => [g.id, g])),
    depth = g => (byId.has(g.parent) ? 1 + depth(byId.get(g.parent)) : 0),
    members = g => [...g.members, ...groups.filter(x => x.parent === g.id).flatMap(members)];
  return {
    nodes: [
      ...(bundle?.notes || []).map(n => ({id: n.id, kind: 'node'})),
      ...(bundle?.records || []).map(n => ({id: n.id, kind: 'function'})),
    ].map(n => ({
      ...n,
      position: bundle.positions?.[n.id],
      color: bundle.styles?.[n.id]?.color,
      inputs: [],
      outputs: [],
    })),
    edges: bundle?.port_edges || [],
    complex: [],
    groups: groups.map(g => ({...g, depth: depth(g), all_members: members(g)})),
  };
}
