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
  'batch',
  'available-nodes',
  'custom-nodes',
  'typed-nodes',
  'primitives',
  'widgets',
  'widget-values',
  'output-values',
  'node-slots',
  'port-connections',
  'split-connections',
  'complex',
  'layout',
  'groups',
  'paste',
  'import-graph',
  'node-style',
  'node-title',
  'input-values',
  'types',
  'node-permissions',
  'nodes',
  'delete-nodes',
]);
const histories = new Map();
const HISTORY_LIMIT = 2000; // client+workflow stacks are in memory; a scripted client cannot grow them without bound
// Undo belongs to the client that made the edit: two tabs sharing one stack would undo each other's work.
const historyOwner = client => client || 'default';
const historyKey = (id, client) => historyOwner(client) + '\u0000' + id;
const historyOf = (id, client) => {
  const key = historyKey(id, client);
  if (!histories.has(key)) {
    while (histories.size >= HISTORY_LIMIT) histories.delete(histories.keys().next().value);
    histories.set(key, {undo: [], redo: []});
  }
  return histories.get(key);
};
/** Drops every other client's undo stack for one workflow: their next undo would revert work they never saw. */
const clearOtherHistories = (id, keep) => {
  const owner = historyOwner(keep);
  for (const key of [...histories.keys()]) {
    const cut = key.indexOf('\u0000');
    if (key.slice(cut + 1) === id && key.slice(0, cut) !== owner) histories.delete(key);
  }
};
const clearHistories = id => {
  for (const key of [...histories.keys()]) if (key.slice(key.indexOf('\u0000') + 1) === id) histories.delete(key);
};
DB.subscribe(keys => {
  for (const key of keys) if (key.startsWith('wf:')) clearHistories(key.slice(3));
});

let queue = Promise.resolve();
const exclusive = work => {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
};

// ----- on_placed / on_deleted / on_input_connected / on_widget: the event nodes of a Library node, fired when a copy is added, removed, rewired or used -----
const HOOKS = {pending: new Set(), log: [], listeners: new Set()};
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
    const work = Promise.resolve()
      .then(async () => {
        const started = Date.now();
        try {
          const result = await dispatchGraphEvent(
            event.project_id,
            event.workflow_id,
            event.hook,
            event.group,
            event.data,
            event.removed
          );
          if (Object.keys(result.errors).length) throw new Error(Object.values(result.errors)[0]);
          DB.announce(['wf:' + event.workflow_id]); // the code may have edited the workflow: open editors reload it
        } catch (error) {
          Object.assign(entry, {ok: false, error: error.message || String(error)});
        }
        entry.ms = Date.now() - started;
        noteHook(entry);
      })
      .finally(() => HOOKS.pending.delete(work));
    HOOKS.pending.add(work);
  }
}

class Call {
  constructor(method, body, query, edit, client = null) {
    Object.assign(this, {
      method,
      body,
      query,
      edit,
      client,
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
      const item = (await this.ctx.get('resources', [])).find(r => r.id === id.slice(4));
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
    // The used ids are collected once per request: the caller checks many types against the same data.
    if (!this.usedTypes) {
      const used = new Set();
      const collect = value => {
        for (const match of JSON.stringify(value ?? null).matchAll(/"t:([A-Za-z0-9_-]+)"/g)) used.add(match[1]);
      };
      for (const project of await this.projects())
        for (const wf of project.workflows) collect(await this.ctx.get('wf:' + wf.id, emptyDoc()));
      for (const r of await this.ctx.get('resources', [])) collect(await this.ctx.get('wf:lib-' + r.id, null));
      this.usedTypes = used;
    }
    return this.usedTypes.has(id);
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
        .filter(r => Array.isArray(r.payload.bundle?.types))
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
      for (let p = parent.get(id); p; p = parent.get(p)) if (doc.complex.some(x => x.id === p && x.source)) return true;
      return false;
    };
    for (const id of ids) {
      const stored = doc.complex.find(c => c.id === id),
        item = stored && resources.find(r => r.id === stored.source.resource_id);
      if (!item || item.updated === stored.source.stamp || nested(id)) continue;
      const backup = clone(doc);
      try {
        delete stored.refresh_error;
        editor.refreshInstance(id, clone(item.payload.bundle), {resource_id: item.id, stamp: item.updated});
        this.refreshed = true; // the copy is new (its nodes have new IDs): it is stored by whatever request found it out of date, even a read
      } catch (error) {
        Object.assign(doc, backup);
        // A broken definition has no executable last-valid fallback. Keep the wrapper and its external
        // interface for diagnosis, remove the obsolete implementation, and retry on the next definition.
        const snapshot = editor.snapshot(),
          cx = snapshot.complex.find(c => c.id === id);
        editor.deleteNodes(cx.members.filter(member => !member.startsWith('complex:')));
        const current = doc.complex.find(c => c.id === id);
        current.source.stamp = item.updated;
        current.refresh_error = 'Library update failed: ' + String(error.message).slice(0, 1000);
        this.refreshed = true;
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
      item = resources.find(r => r.id === id.slice(4));
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
      validateResource({...item.payload, bundle});
      const taken = resources.some(r => r.id !== item.id && r.name === name);
      Object.assign(item, {
        name: taken ? item.name : name,
        payload: {...item.payload, bundle},
        updated: Date.now() / 1000,
      });
      if (this.scriptContext) {
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
   * on_placed, on_deleted, on_input_connected and on_widget: the copies of Library nodes that are in this workflow now but were not before
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
      const graph = snapshotOf(state),
        view = createGraphView(graph, {context});
      if (view.values().some(node => node.op === hook && view.scopes.get(node.id)?.group === group))
        this.hookEvents.push({
          hook,
          group,
          data,
          project_id: project,
          workflow_id: workflow,
          node_id: 'complex:' + group,
          ...(hook === 'on_deleted' ? {removed: graph} : {}),
        });
    };
    for (const id of now.keys()) if (!old.has(id)) event('on_placed', id, doc, {});
    for (const id of old.keys()) if (!now.has(id)) event('on_deleted', id, was, {});
    // on_input_connected: a copy whose wired inputs are not the ones they were.
    const wiredIds = (state, id) =>
      state.port_edges
        .filter(e => e.target === 'complex:' + id)
        .map(e => e.target_port)
        .sort();
    for (const [id, c] of now) {
      const ids = wiredIds(doc, id);
      const sources = state =>
        state.port_edges
          .filter(e => e.target === 'complex:' + id)
          .map(e => JSON.stringify([e.target_port, e.source, e.source_port]))
          .sort();
      if (!old.has(id) || JSON.stringify(sources(doc)) === JSON.stringify(sources(was))) continue;
      event('on_input_connected', id, doc, {
        connected: ids.map(pid => c.interface.inputs.find(p => p.id === pid)?.name ?? pid),
      });
    }
    // on_widget: one call for each widget a person changed, on every Library node copy around the node that has the widget.
    const around = nodeId => {
      const found = [];
      for (let g = doc.groups.find(x => x.members.includes(nodeId)); g; g = doc.groups.find(x => x.id === g.parent))
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
      this.docs.get(id).presentationOnly = semanticKey(JSON.parse(before)) === semanticKey(stateOf(doc));
      await this.collectHooks(project, id, doc, before);
      doc.cursor = (doc.cursor || 0) + 1;
      if (id.startsWith('lib-')) await this.syncLibraryNode(id, doc);
      if (!EDITS.has(action)) continue;
      const history = historyOf(id, this.client),
        limit = (await this.prefs()).undo_steps ?? 50,
        branched = history.redo.length > 0;
      history.redo = [];
      clearOtherHistories(id, this.client);
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
  /** Resolves with the parsed result or throws an ApiError. */
  async request(method, path, {body = {}, query = {}, edit = null, scriptContext = null, client = null} = {}) {
    path = path.replace(/^\/+|\/+$/g, '');
    const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
    if (!found) {
      // A known path with another method is a 405 with the methods it does accept, not a 404.
      const allowed = [...new Set(ROUTES.filter(r => r.regex.test(path)).flatMap(r => [...r.methods]))];
      if (allowed.length) {
        const error = new ApiError('method_not_allowed', `Use ${allowed.join(', ')} for /${path}`, 405);
        error.allow = allowed.join(', ');
        throw error;
      }
      throw missing('API endpoint not found');
    }
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
    const call = new Call(method, body ?? {}, query ?? {}, edit, client);
    call.scriptContext = scriptContext;
    // Stop aborts the signal of a Script: its API calls neither start nor save after that.
    const running = () => {
      if (scriptContext?.signal?.aborted) throw bad('Execution stopped');
    };
    running();
    if (found.unlocked) return found.handler(call, params);
    const result = await exclusive(async () => {
      running();
      const result = await found.handler(call, params);
      if (method !== 'GET') await call.finish(found.pattern.split('/')[2] || found.pattern.split('/')[0]);
      // A read that found something to bring up to date (a copy of a Library node, a type) stores it.
      if (method === 'GET' && call.refreshed) for (const {doc} of call.docs.values()) doc.types = ownTypes(doc.types);
      running();
      if (method !== 'GET' || call.refreshed) await call.ctx.commit();
      // The live interpreter follows a document only when it changed in a way it can observe (not a move or a colour),
      // and only if one is running for it.
      if (method !== 'GET' || call.refreshed)
        for (const [id, {doc, project, presentationOnly}] of call.docs) {
          if (presentationOnly || !GRAPH_RUNTIMES.has(id)) continue;
          const types = [...(await call.libraryTypes()), ...ownTypes(doc.types)];
          syncRuntimeGraph(id, buildSnapshot({id: project}, {id, name: ''}, {...doc, types}, false));
        }
      return result;
    });
    if (call.libraryTouched) {
      for (const entry of GRAPH_RUNTIMES.values())
        if (!call.docs.has(entry.workflow)) {
          const refresh = new Call('GET', {}, {workflow_id: entry.workflow}, null);
          await exclusive(async () => {
            const {editor} = await refresh.workflow(entry.project),
              document = editor.snapshot();
            for (const {doc} of refresh.docs.values()) doc.types = ownTypes(doc.types);
            await refresh.ctx.commit();
            syncRuntimeGraph(entry.workflow, document);
          });
          DB.announce(['wf:' + entry.workflow]);
        }
    }
    // Event handlers run after the edit is saved and the writer lock is free.
    runHooks(call.hookEvents);
    return result;
  },
  /** Called with a log entry whenever hook code (on_placed, on_deleted, on_input_connected, on_widget) fails. Returns the function that stops listening. */
  subscribeHooks(listener) {
    HOOKS.listeners.add(listener);
    return () => HOOKS.listeners.delete(listener);
  },
  /** Resolves when no hook code is running or waiting (for tests and programs that must see its effects). */
  async hooksIdle() {
    while (HOOKS.pending.size) await Promise.allSettled([...HOOKS.pending]);
  },
  subscribe(listener, options) {
    return DB.subscribe(listener, options);
  },
  async shutdownExecutions() {
    await Promise.all([...GRAPH_RUNTIMES.keys()].map(stopGraph));
  },
  get persistent() {
    return DB.persistent;
  },
  get storage() {
    return {mode: DB.mode, directory: DB.directory};
  },
  /** A read-only server diagnostics snapshot: counts and the states of live runtimes, never workflow data or secrets. */
  diagnostics() {
    const runtimes = [...GRAPH_RUNTIMES.values()].map(entry => ({
      workflow_id: entry.workflow,
      status: runtimeStatus(entry),
      paused: entry.paused,
      active_signals: entry.pending.size,
      detached: entry.detached.size,
      last_used: entry.lastUsed,
      storage_error: entry.storageError || null,
    }));
    return {
      routes: ROUTES.length,
      runtimes,
      running: runtimes.filter(item => item.status !== 'idle').length,
      hook_log: HOOKS.log.slice(-20),
      pending_hooks: HOOKS.pending.size,
    };
  },
  /** The capabilities a scoped token needs for a call (see permissions.js). Used by the HTTP layer. */
  async scopedNeeds(method, path, body) {
    return scopedNeeds(String(method || 'GET').toUpperCase(), String(path || '').replace(/^\/+|\/+$/g, ''), body ?? {});
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
            403: {description: 'Permission denied'},
            409: {description: 'The workflow changed since it was read'},
          },
          'x-needs': r.needs[method],
        };
    }
    return {info: {title: 'AgentSys Server API', version: '0.3.0'}, paths};
  },
};
