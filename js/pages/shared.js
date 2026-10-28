// Pieces shared by pages: the PAGES registry, the page header and the card every page uses, inline rename, graph previews, Library helpers.
'use strict';

const PAGES = {};
const COMMON_CAPABILITIES = [
  'graph.read',
  'graph.write',
  'library.read',
  'library.write',
  'net.fetch:*',
  'run.read',
  'run.start',
];
function manifestControls(payload = {}) {
  const list = (field, attr) =>
    COMMON_CAPABILITIES.map(
      cap =>
        `<label class="check"><input type="checkbox" ${attr}="${esc(cap)}" ${(payload[field] ?? []).includes(cap) ? 'checked' : ''}>${esc(cap)}</label>`
    ).join('');
  const extra = field => (payload[field] ?? []).filter(v => !COMMON_CAPABILITIES.includes(v)).join(', ');
  return `<fieldset><legend>Declared capabilities</legend>${list('capabilities', 'data-capability')}<label>Specific capabilities<input name="extra_capabilities" value="${esc(extra('capabilities'))}" placeholder="net.fetch:example.com, secrets.use:service"></label></fieldset><fieldset><legend>Explicit user grants</legend>${list('grants', 'data-grant')}<label>Specific grants<input name="extra_grants" value="${esc(extra('grants'))}"></label></fieldset>`;
}
function readManifestControls(form) {
  const read = (attr, name) => [
    ...new Set([
      ...$$(`input[${attr}]:checked`, form).map(el => el.getAttribute(attr)),
      ...(form.elements[name]?.value ?? '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean),
    ]),
  ];
  return {capabilities: read('data-capability', 'extra_capabilities'), grants: read('data-grant', 'extra_grants')};
}

/**
 * Splits a settings form into sections shown one at a time. The list of sections lives in the second panel
 * (a form with one section needs none); the open one is remembered by the page's tab.
 */
function sectionTabs(form, definitions, title = 'Settings') {
  if (definitions.length < 2) return;
  const sections = [...form.children].filter(el => el.tagName === 'SECTION');
  const requested = definitions.findIndex(([label]) => markdownSlug(label) === routeQuery().get('section'));
  const start = requested >= 0 ? requested : Math.min(Tabs.stateOf()?.section ?? 0, definitions.length - 1);
  Subnav.mount({
    title,
    body: `<nav class="subnav-tree" role="tablist" aria-label="${esc(title)} sections">${definitions
      .map(([label, glyph], i) => navTab(label, glyph, i === start))
      .join('')}</nav>`,
  });
  const nav = $('#subnav-list .subnav-tree'),
    tabs = $$('[role=tab]', nav);
  sections.forEach((section, i) => {
    section.id = 'section-panel-' + i;
    section.setAttribute('role', 'tabpanel');
    tabs[i].id = 'section-tab-' + i;
    tabs[i].setAttribute('aria-controls', section.id);
    section.setAttribute('aria-labelledby', tabs[i].id);
    section.hidden = i !== start;
  });
  const activate = index => {
    const tab = Tabs.stateOf();
    if (tab && tab.section !== index) {
      tab.section = index;
      Tabs.save();
    }
    const params = routeQuery();
    if (params.has('section')) {
      params.set('section', markdownSlug(definitions[index][0]));
      history.replaceState({}, '', urlOf(routePath() + '?' + params));
      const state = Tabs.stateOf();
      if (state) {
        state.href = routeTarget();
        Tabs.save();
      }
    }
    selectNavTab(nav, index);
    placePills();
    sections.forEach((section, i) => (section.hidden = i !== index));
  };
  tabs.forEach((tab, i) => {
    tab.onclick = () => activate(i);
    tab.onkeydown = event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (i + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
      activate(index);
      tabs[index].focus();
    };
  });
  form.addEventListener(
    'invalid',
    event => {
      const i = sections.findIndex(section => section.contains(event.target));
      if (i >= 0) activate(i);
    },
    true
  );
}

/** The header of a page: where it is (links up the tree), its name, a line about it, and its buttons. `title` and `sub` are HTML. */
const pageHead = ({crumbs = [], title, sub = '', actions = ''}) =>
  `<div class="page-head"><div>${crumbs.length ? `<nav class="crumbs" aria-label="Path">${crumbs.map(([label, href]) => `<a href="${esc(href)}" data-link>${esc(label)}</a>`).join('<span aria-hidden="true">/</span>')}</nav>` : ''}<h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div><div class="actions">${actions}</div></div>`;

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
  run = '',
  tint = '',
  extra = '',
}) {
  const tag = href ? 'a' : 'div';
  return `<article class="card ${tint}" ${extra}><${tag} class="card-main" ${href ? `href="${esc(href)}" data-link` : ''}><header class="card-head"><span class="head-icon">${icon(glyph)}</span><h3><span ${attrs}>${esc(title)}</span></h3></header><div class="card-preview ${previewClass}" ${previewAttrs}>${preview}</div>${facts ? `<p class="card-facts">${facts}</p>` : ''}</${tag}><span class="card-actions">${run}${menu ? `<button class="icon" data-menu="${esc(menu)}" aria-label="Actions of ${esc(title)}">${icon('dots')}</button>` : ''}</span></article>`;
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

/** Existing name fields stage changes until Enter; unrelated autosaves read the committed name. */
const nameValue = input => input.dataset.committedName ?? input.value;
function bindNameField(input, commit = () => input.dispatchEvent(new Event('change', {bubbles: true}))) {
  input.dataset.committedName = input.value;
  let committing = false;
  input.addEventListener('input', event => event.stopPropagation());
  input.addEventListener('change', event => {
    if (!committing) event.stopPropagation();
  });
  input.addEventListener('blur', () => {
    input.value = nameValue(input);
  });
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      input.value = nameValue(input);
      input.blur();
    }
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    input.value = input.value.trim();
    if (!input.reportValidity()) return;
    input.dataset.committedName = input.value;
    committing = true;
    try {
      commit();
    } finally {
      committing = false;
    }
  });
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
  const settings = await api('settings');
  app.resources = settings.resources;
  app.nodeFolders = settings.node_folders || [];
  app.nodeFolderIcons = settings.node_folder_icons || {};
  app.preferences = settings.preferences;
  return settings;
}
const baseName = path => path.slice(path.lastIndexOf('/') + 1);
/** The Library has sections (now one: Nodes) under /resources; the nodes live at /resources/nodes. */
const NODES_PATH = '/resources/nodes';
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
