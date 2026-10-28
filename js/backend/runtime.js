// The in-browser "server": route table, one request context (Call), undo history and Backend.request().
// api() in app/helpers.js calls Backend.request(). Routes are added with route() in the routes-*.js files.
'use strict';

// ----- request plumbing -----
const ROUTES = [];
function route(methods, pattern, summary, handler, options = {}) {
  ROUTES.push({
    methods: new Set(methods.split(' ')),
    pattern,
    summary,
    handler,
    regex: new RegExp('^' + pattern.replace(/{(\w+)}/g, '(?<$1>[^/]+)') + '$'),
    ...options,
    needs: options.needs ?? Object.fromEntries(methods.split(' ').map(method => [method, routeNeeds(pattern, method)])),
  });
}
const EDITS = new Set([
  'custom-nodes',
  'typed-nodes',
  'widgets',
  'widget-values',
  'node-slots',
  'port-connections',
  'complex',
  'layout',
  'groups',
  'paste',
  'node-style',
  'node-title',
  'input-values',
  'nodes',
  'delete-nodes',
]);
const histories = new Map();
const historyOf = id => {
  if (!histories.has(id)) histories.set(id, {undo: [], redo: []});
  return histories.get(id);
};
DB.subscribe(keys => {
  for (const key of keys) if (key.startsWith('wf:')) histories.delete(key.slice(3));
});

let queue = Promise.resolve();
const exclusive = work => {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
};

// ----- on_placed / on_deleted / on_wired / on_widget: the event nodes of a Library node, fired when a copy is added, removed, rewired or used -----
const HOOKS = {queue: Promise.resolve(), waiting: 0, log: [], listeners: new Set()};
const MAX_WAITING_HOOKS = 100;
const MAX_HOOK_LOG = 200;
function noteHook(entry) {
  HOOKS.log.push(entry);
  if (HOOKS.log.length > MAX_HOOK_LOG) HOOKS.log.splice(0, HOOKS.log.length - MAX_HOOK_LOG);
  if (entry.ok) return;
  if (HOOKS.listeners.size) for (const listener of HOOKS.listeners) listener(entry);
  else console.warn(`[agentsys] ${entry.hook} of ${entry.node_id} failed: ${entry.error}`);
}
function runHooks(events) {
  for (const event of events) {
    const entry = {
      at: Date.now() / 1000,
      hook: event.hook,
      node_id: event.node_id,
      project_id: event.project_id,
      workflow_id: event.workflow_id,
      ok: true,
      error: null,
      ms: 0,
    };
    // A hook that keeps creating nodes that run hooks would never end: past a limit the rest is dropped and logged.
    if (HOOKS.waiting >= MAX_WAITING_HOOKS) {
      noteHook({...entry, ok: false, error: `More than ${MAX_WAITING_HOOKS} hooks are waiting; this one was skipped`});
      continue;
    }
    HOOKS.waiting++;
    HOOKS.queue = HOOKS.queue.then(async () => {
      const started = Date.now();
      try {
        await runHook(event.plan, runPlan);
        DB.announce(['wf:' + event.workflow_id]); // the code may have edited the workflow: open editors reload it
      } catch (error) {
        Object.assign(entry, {ok: false, error: error.message || String(error)});
      }
      entry.ms = Date.now() - started;
      HOOKS.waiting--;
      noteHook(entry);
    });
  }
}

class Call {
  constructor(method, body, query, edit) {
    Object.assign(this, {
      method,
      body,
      query,
      edit,
      ctx: new Context(),
      docs: new Map(),
      hookEvents: [],
      widgetEvents: [],
      editedNodes: new Set(),
      libraryTouched: false,
    });
    this.workflowId = body.workflow_id || query.workflow_id || null;
  }
  async projects() {
    return this.ctx.get('projects', []);
  }
  /** `manage`: the project is about to be changed, renamed or deleted, which only the user's own projects allow. */
  async project(id, manage = false) {
    // A Library node being edited is a private workflow of its own, not a project of the user.
    if (String(id).startsWith('lib-')) {
      if (manage) throw bad('A Custom Node is managed in the Library, not as a project');
      const item = (await this.ctx.get('resources', [])).find(r => r.id === id.slice(4) && r.kind === 'custom_node');
      return {
        id,
        name: item?.name ?? 'New Custom Node',
        workflows: [{id, name: 'Node', created: 0}],
        library: id.slice(4),
      };
    }
    const project = (await this.projects()).find(p => p.id === id);
    if (!project) throw missing('Record not found');
    return project;
  }
  /** The project, one of its workflows and an editor on a private copy of that workflow's document. */
  async workflow(projectId, workflowId = this.workflowId) {
    if (String(projectId).startsWith('lib-') && this.method !== 'GET')
      await this.requireDeveloper('Editing a Custom Node');
    const project = await this.project(projectId);
    const meta = workflowId ? project.workflows.find(w => w.id === workflowId) : project.workflows[0];
    if (!meta) throw missing('Record not found');
    const doc = await this.ctx.get('wf:' + meta.id, emptyDoc());
    // The types of the workflow are the Library's and its own, one list while it is open (and stored as the workflow's own only).
    if (!this.docs.has(meta.id)) {
      const {types, absorbed, changed} = unifyTypes(await this.libraryTypes(), doc.types);
      doc.types = types;
      if (absorbed.size) new Editor(project, meta, doc).retype(absorbed);
      if (changed) this.refreshed = true; // a read that brought something up to date stores it
    }
    await this.refreshInstances(project, meta, doc);
    if (!this.docs.has(meta.id)) {
      // `if_cursor` makes an edit conditional: it only applies if nobody changed the workflow since it was read
      // (the snapshot's `cursor`). Over HTTP this is the If-Match header.
      const expected = this.query.if_cursor;
      if (this.method !== 'GET' && expected !== undefined && expected !== '' && Number(expected) !== (doc.cursor || 0))
        throw new ApiError(
          'conflict',
          `The workflow changed since it was read (cursor is ${doc.cursor || 0}, not ${expected}). Read it again and retry.`,
          409
        );
      this.docs.set(meta.id, {doc, before: JSON.stringify(stateOf(doc)), project: project.id});
    }
    const editor = new Editor(project, meta, doc);
    return {project, meta, doc, editor};
  }
  /** The types of the Library: [{id, name, color?, fields, control?, options?, alias?, library: true}]. They are made by the Custom Nodes (see reconcileLibraryTypes). */
  async libraryTypes() {
    return (await this.ctx.get('library_types', [])).map(libraryType);
  }
  /** Whether a workflow or the editor of a Custom Node mentions the Library type `id`. */
  async typeInUse(id) {
    const mentions = value => JSON.stringify(value ?? null).includes('t:' + id);
    for (const project of await this.projects())
      for (const wf of project.workflows) if (mentions(await this.ctx.get('wf:' + wf.id, emptyDoc()))) return true;
    for (const r of await this.ctx.get('resources', []))
      if (r.kind === 'custom_node' && mentions(await this.ctx.get('wf:lib-' + r.id, null))) return true;
    return false;
  }
  /**
   * The types of the Library are the types the Custom Nodes define, kept once, in one list. After the Library's nodes changed (saved by the
   * editor, imported, duplicated, deleted):
   * - a type a node defines that the Library does not have yet is added (a type with the name and shape of one it has is that type, and
   *   a name that is taken by another shape is changed, in the node);
   * - a type the node being edited changed is changed for everybody (the other nodes carry the new definition);
   * - a node carries the definition of every type it uses, so it stands alone;
   * - a type no node defines and no workflow uses is removed.
   */
  async reconcileLibraryTypes() {
    const resources = await this.ctx.get('resources', []),
      nodes = resources
        .filter(r => r.kind === 'custom_node' && Array.isArray(r.payload.bundle?.types))
        .sort((a, b) => Number(this.editedNodes.has(b.id)) - Number(this.editedNodes.has(a.id))),
      stored = await this.ctx.get('library_types', []),
      lib = clone(stored);
    const canon = t =>
      JSON.stringify([t.name, t.color ?? null, t.fields, t.control ?? null, t.options ?? null, t.alias ?? null]);
    // What the node that was edited says of its types is the truth.
    for (const r of nodes)
      if (this.editedNodes.has(r.id))
        for (const t of r.payload.bundle.types) {
          const i = lib.findIndex(x => x.id === t.id);
          if (i >= 0 && canon(lib[i]) !== canon(t)) lib[i] = plainType(t);
        }
    const changedNodes = [];
    for (const r of nodes) {
      const before = JSON.stringify(r.payload.bundle),
        {types, absorbed} = unifyTypes(lib, r.payload.bundle.types);
      let text = before;
      for (const [from, to] of absorbed) text = text.split(from).join(to);
      const bundle = JSON.parse(text),
        names = new Map(types.map(t => [t.id, t.name])),
        libIds = new Set(lib.map(t => t.id)),
        uses = new Set([...bundle.types.map(t => t.id).filter(id => libIds.has(id)), ...absorbed.values()]);
      const own = bundle.types.filter(t => !libIds.has(t.id)).map(t => ({...t, name: names.get(t.id) ?? t.name}));
      lib.push(...own.map(plainType));
      // Every type a Library type is made of goes along as well.
      for (let more = true; more; ) {
        more = false;
        for (const id of [...uses, ...own.map(t => t.id)]) {
          const t = lib.find(x => x.id === id);
          for (const ref of t ? [...typeRefs(t.alias), ...t.fields.flatMap(f => typeRefs(f.type))] : [])
            if (lib.some(x => x.id === ref) && !uses.has(ref) && !own.some(o => o.id === ref)) {
              uses.add(ref);
              more = true;
            }
        }
      }
      bundle.types = [...uses].map(id => plainType(lib.find(x => x.id === id))).concat(own.map(plainType));
      if (JSON.stringify(bundle) !== before) {
        r.payload.bundle = bundle;
        if (absorbed.size) r.updated = Date.now() / 1000; // its IDs changed: the copies on canvases follow
        changedNodes.push(r);
      }
    }
    // A type nobody needs goes.
    const needed = new Set(nodes.flatMap(r => r.payload.bundle.types.map(t => t.id)));
    const idle = lib.filter(t => !needed.has(t.id));
    for (const t of idle) if (await this.typeInUse(t.id)) needed.add(t.id);
    for (let more = true; more; ) {
      more = false;
      for (const t of lib)
        if (needed.has(t.id))
          for (const ref of [...typeRefs(t.alias), ...t.fields.flatMap(f => typeRefs(f.type))])
            if (!needed.has(ref)) {
              needed.add(ref);
              more = true;
            }
    }
    const next = lib
      .filter(t => needed.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
    checkTypes(next.map(t => ({...t})));
    if (JSON.stringify(next) !== JSON.stringify(stored)) this.ctx.set('library_types', next);
    if (changedNodes.length) this.ctx.set('resources', resources);
    // A type of an open workflow that is the Library's now is no longer its own.
    const ids = new Set(next.map(t => t.id));
    for (const {doc} of this.docs.values()) doc.types = (doc.types || []).filter(t => t.library || !ids.has(t.id));
  }
  /** Placed Library nodes follow their definition: when it was saved again, their contents are replaced. */
  async refreshInstances(project, meta, doc) {
    const ids = doc.complex.filter(c => c.source).map(c => c.id);
    if (!ids.length) return;
    const resources = await this.ctx.get('resources', []),
      editor = new Editor(project, meta, doc);
    const nested = id => {
      const parent = new Map(doc.groups.map(g => [g.id, g.parent]));
      for (let p = parent.get(id), n = 0; p && n < 64; p = parent.get(p), n++)
        if (doc.complex.some(x => x.id === p && x.source)) return true;
      return false;
    };
    for (const id of ids) {
      const stored = doc.complex.find(c => c.id === id),
        item = stored && resources.find(r => r.id === stored.source.resource_id && r.kind === 'custom_node');
      if (!item || item.updated === stored.source.stamp || nested(id)) continue;
      const backup = clone(doc);
      try {
        editor.refreshInstance(id, clone(item.payload.bundle), {resource_id: item.id, stamp: item.updated});
        this.refreshed = true; // the copy is new (its nodes have new IDs): it is stored by whatever request found it out of date, even a read
      } catch {
        Object.assign(doc, backup);
      }
    }
  }
  /** Making or changing Custom nodes by hand is for developers: the Settings switch must be on. */
  async requireDeveloper(what) {
    if (!(await this.prefs()).developer_mode)
      throw new ApiError('developer_mode_required', `${what} needs developer mode (Settings > Developer mode)`, 403);
  }
  async prefs() {
    return this.ctx.get('prefs', {});
  }
  /** The Custom Node being edited is saved to the Library after every change, like a workflow. */
  async syncLibraryNode(id, doc) {
    const resources = await this.ctx.get('resources', []),
      item = resources.find(r => r.id === id.slice(4) && r.kind === 'custom_node');
    if (!item) return;
    try {
      const project = await this.project(id),
        editor = new Editor(project, project.workflows[0], doc),
        root = editor.snapshot().groups.find(g => g.id === doc.root);
      if (!root || !root.has_complex) return;
      const bundle = editor.copy([], [root.id]),
        name =
          String(root.name || item.name)
            .trim()
            .slice(0, 100) || item.name;
      validateResource('custom_node', {...item.payload, bundle});
      const taken = resources.some(r => r.kind === 'custom_node' && r.id !== item.id && r.name === name);
      Object.assign(item, {
        name: taken ? item.name : name,
        payload: {...item.payload, bundle},
        updated: Date.now() / 1000,
      });
      if (this.scriptContext) {
        item.payload.origin = 'ai';
        item.payload.grants = ['graph.read'];
      }
      // The size of the main group's frame is remembered, relative to the nodes inside it.
      const frame = doc.layout['group:' + doc.root],
        spots = doc.nodes.map(n => doc.layout[n.id]).filter(Boolean);
      if (frame) {
        const x0 = spots.length ? Math.min(...spots.map(s => s.x)) : 0,
          y0 = spots.length ? Math.min(...spots.map(s => s.y)) : 0;
        item.payload.frame = {dx: frame.x - x0, dy: frame.y - y0, width: frame.width, height: frame.height};
      }
      this.ctx.set('resources', resources);
      this.editedNodes.add(item.id);
      this.libraryTouched = true;
    } catch {
      /* a half-built node is kept in the editor and saved once it is valid */
    }
  }
  /**
   * on_placed, on_deleted, on_wired and on_widget: the copies of Library nodes that are in this workflow now but were not before
   * (placed, pasted, created by a script, brought back by redo), the ones that were and are gone, copies whose wired inputs
   * changed, and the widgets a person used. For each, the event nodes of that kind inside the copy fire (see hookPlan), and the graph
   * does the rest. Comparing the two documents means every way of adding or removing a node is covered, and nothing else is:
   * moving, editing or refreshing a copy is not. A copy without event nodes of the kind runs nothing.
   */
  async collectHooks(project, workflow, doc, before) {
    const was = JSON.parse(before),
      copies = state => new Map(state.complex.filter(c => c.source).map(c => [c.id, c]));
    const old = copies(was),
      now = copies(doc),
      context = {project_id: project, workflow_id: workflow};
    const snapshots = new Map();
    const snapshotOf = state => {
      if (!snapshots.has(state))
        snapshots.set(state, buildSnapshot({id: project}, {id: workflow, name: ''}, state, false));
      return snapshots.get(state);
    };
    const event = (hook, group, state, data) => {
      const plan = hookPlan(snapshotOf(state), hook, group, data, context);
      if (plan)
        this.hookEvents.push({hook, project_id: project, workflow_id: workflow, node_id: 'complex:' + group, plan});
    };
    for (const id of now.keys()) if (!old.has(id)) event('on_placed', id, doc, {});
    for (const id of old.keys()) if (!now.has(id)) event('on_deleted', id, was, {});
    // on_wired: a copy whose wired inputs are not the ones they were.
    const wiredIds = (state, id) =>
      state.port_edges
        .filter(e => e.target === 'complex:' + id)
        .map(e => e.target_port)
        .sort();
    for (const [id, c] of now) {
      const ids = wiredIds(doc, id);
      if (!old.has(id) || JSON.stringify(ids) === JSON.stringify(wiredIds(was, id))) continue;
      event('on_wired', id, doc, {wired: ids.map(pid => c.interface.inputs.find(p => p.id === pid)?.name ?? pid)});
    }
    // on_widget: one call for each widget a person changed, on every Library node copy around the node that has the widget.
    const around = nodeId => {
      const found = [];
      for (
        let g = doc.groups.find(x => x.members.includes(nodeId)), n = 0;
        g && n < 64;
        g = doc.groups.find(x => x.id === g.parent), n++
      )
        if (now.has(g.id)) found.push(g);
      return found;
    };
    for (const {node_id, widget_id} of this.widgetEvents) {
      const widget = doc.widgets[node_id]?.find(w => w.id === widget_id);
      if (widget)
        for (const group of around(node_id))
          event('on_widget', group.id, doc, {
            widget: {id: widget.id, kind: widget.kind, label: widget.label, value: widget.value},
          });
    }
  }
  /** Records undo history and bumps the change cursor of every workflow this call modified. */
  async finish(action) {
    for (const [id, {doc, before, project}] of this.docs) {
      if (doc.root) new Editor({id: 'lib-' + id}, {id}, doc).adoptIntoRoot();
      const after = JSON.stringify(stateOf(doc));
      if (after === before) continue;
      await this.collectHooks(project, id, doc, before);
      doc.cursor = (doc.cursor || 0) + 1;
      if (id.startsWith('lib-')) await this.syncLibraryNode(id, doc);
      if (!EDITS.has(action)) continue;
      const history = historyOf(id),
        limit = (await this.prefs()).undo_steps ?? 50,
        branched = history.redo.length > 0;
      history.redo = [];
      if (!limit) continue;
      const last = history.undo.at(-1);
      if (!branched && last && this.edit && this.edit === last.token) continue;
      history.undo.push({before, after: null, action, token: this.edit || null});
      while (history.undo.length > limit) history.undo.shift();
    }
    if (this.libraryTouched) await this.reconcileLibraryTypes();
    // What a workflow stores of the Library's types is nothing: they are read from the Library.
    for (const {doc} of this.docs.values()) doc.types = ownTypes(doc.types);
  }
}

const Backend = {
  /** Same contract as the old REST API: resolves with the parsed result or throws an ApiError. */
  async request(method, path, {body = {}, query = {}, edit = null, scriptContext = null} = {}) {
    await recoverRuns();
    path = path.replace(/^\/+|\/+$/g, '');
    const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
    if (!found) throw missing('API endpoint not found');
    const params = Object.fromEntries(
      Object.entries(path.match(found.regex).groups || {}).map(([k, v]) => {
        let value;
        try {
          value = decodeURIComponent(v);
        } catch {
          throw bad('Invalid path escape');
        }
        if (/[\\/\0]/.test(value) || value === '.' || value === '..') throw bad('Invalid path component');
        return [k, value];
      })
    );
    const call = new Call(method, body ?? {}, query ?? {}, edit);
    call.scriptContext = scriptContext;
    if (found.unlocked) return found.handler(call, params);
    const result = await exclusive(async () => {
      const result = await found.handler(call, params);
      if (method !== 'GET') await call.finish(found.pattern.split('/')[2] || found.pattern.split('/')[0]);
      // A read that found something to bring up to date (a copy of a Library node, a type) stores it.
      if (method === 'GET' && call.refreshed) for (const {doc} of call.docs.values()) doc.types = ownTypes(doc.types);
      if (method !== 'GET' || call.refreshed) await call.ctx.commit();
      return result;
    });
    // The code of on_placed / on_deleted / on_wired / on_widget runs after the change is saved and the request lock is free, so it can call the API.
    runHooks(call.hookEvents);
    return result;
  },
  /** Called with a log entry whenever hook code (on_placed, on_deleted, on_wired, on_widget) fails. Returns the function that stops listening. */
  subscribeHooks(listener) {
    HOOKS.listeners.add(listener);
    return () => HOOKS.listeners.delete(listener);
  },
  /** Resolves when no hook code is running or waiting (for tests and programs that must see its effects). */
  async hooksIdle() {
    for (let queue; queue !== HOOKS.queue; ) await (queue = HOOKS.queue);
  },
  subscribe(listener, options) {
    return DB.subscribe(listener, options);
  },
  get persistent() {
    return DB.persistent;
  },
  get storage() {
    return {mode: DB.mode, directory: DB.directory};
  },
  /** An OpenAPI-style description of every call, for the API page. */
  openapi() {
    const paths = {};
    for (const r of ROUTES) {
      const item = (paths['/api/' + r.pattern] ??= {});
      const parameters = [...r.pattern.matchAll(/{(\w+)}/g)].map(m => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: {type: 'string'},
      }));
      for (const method of r.methods)
        item[method.toLowerCase()] = {
          summary: r.summary,
          description: r.description || '',
          parameters: [...parameters, ...(r.query || []).map(q => ({name: q, in: 'query', schema: {type: 'string'}}))],
          ...(method !== 'GET' && method !== 'DELETE' && r.body
            ? {requestBody: {content: {'application/json': {example: r.body}}}}
            : {}),
          responses: {
            200: {description: r.returns || 'Success'},
            400: {description: 'Invalid request'},
            404: {description: 'Not found'},
          },
          'x-needs': r.needs[method],
        };
    }
    return {info: {title: 'AgentSys browser API'}, paths};
  },
};
