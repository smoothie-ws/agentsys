// Routes used by the canvas: read the graph, undo/redo, create and edit nodes, wires, groups,
// Complex Nodes, clipboard, styles, layout, validation and evaluation.
'use strict';

route(
  'POST',
  'projects/{project_id}/batch',
  'Apply related graph edits as one document transaction',
  async (c, params) => {
    const operations = c.body.operations;
    if (!Array.isArray(operations) || !operations.length || operations.length > 200)
      throw bad('Pass 1 to 200 operations');
    const workflow = await c.workflow(params.project_id);
    const result = [];
    for (const operation of operations) {
      if (
        !isObject(operation) ||
        typeof operation.path !== 'string' ||
        !/^[a-z-]+(?:\/[a-zA-Z0-9:-]+)?$/.test(operation.path) ||
        !EDITS.has(operation.path.split('/')[0]) ||
        ['batch', 'available-nodes'].includes(operation.path)
      )
        throw bad('Invalid batch edit path');
      const method = operation.method ?? 'PUT';
      const path = `projects/${params.project_id}/${operation.path}`;
      const found = ROUTES.find(r => r.regex.test(path) && r.methods.has(method) && !r.unlocked);
      if (!found || (operation.body !== undefined && !isObject(operation.body))) throw bad('Invalid batch edit');
      const before = c.body;
      c.body = {...(operation.body ?? {}), workflow_id: workflow.meta.id};
      try {
        result.push(await found.handler(c, {...path.match(found.regex).groups}));
      } finally {
        c.body = before;
      }
    }
    return {results: result};
  }
);

// ----- workflow canvas -----
route(
  'GET',
  'projects/{project_id}/workflow',
  'Read the workflow graph',
  async (c, {project_id}) => {
    const {project, meta, doc} = await c.workflow(project_id);
    return buildSnapshot(project, meta, doc);
  },
  {query: ['workflow_id'], returns: 'Nodes with their ports, wires, groups and diagnostics'}
);

route(
  'GET',
  'projects/{project_id}/edit-history',
  'Read the undo and redo depth',
  async (c, {project_id}) => {
    const {meta} = await c.workflow(project_id),
      h = historyOf(meta.id);
    return {undo: h.undo.length, redo: h.redo.length};
  },
  {query: ['workflow_id']}
);

for (const redo of [false, true])
  route(
    'POST',
    `projects/{project_id}/${redo ? 'redo' : 'undo'}`,
    redo ? 'Redo the last undone edit' : 'Undo the last edit',
    async (c, {project_id}) => {
      const {meta, doc} = await c.workflow(project_id),
        h = historyOf(meta.id),
        from = redo ? h.redo : h.undo,
        to = redo ? h.undo : h.redo,
        entry = from.pop();
      if (entry) {
        let state;
        if (redo) state = entry.after;
        else {
          entry.after = JSON.stringify(stateOf(doc));
          state = entry.before;
        }
        Object.assign(doc, JSON.parse(state));
        to.push(entry);
      }
      return {undo: h.undo.length, redo: h.redo.length};
    }
  );

route(
  'GET',
  'node-hooks',
  'Read the log of the on_placed, on_deleted, on_wired and on_widget signals that ran without a Run (the last 200)',
  async c => HOOKS.log.filter(e => !c.query.workflow_id || e.workflow_id === c.query.workflow_id),
  {
    unlocked: true,
    query: ['workflow_id'],
    returns: 'Entries {at, hook, node_id, project_id, workflow_id, ok, error, ms}, oldest first',
  }
);
route('GET', 'projects/{project_id}/node-types', 'List node types', async (c, {project_id}) => {
  await c.project(project_id);
  return {definitions: DEFINITIONS, widget_kinds: [...WIDGET_KINDS]};
});

route(
  'PUT',
  'projects/{project_id}/available-nodes',
  'Include or exclude a Library node or all current nodes in a Library group from this workflow’s Add menu',
  async (c, {project_id}) => {
    const {resource_id, folder, enabled} = c.body;
    if (typeof enabled !== 'boolean') throw bad('Pass enabled: true or false');
    if ((typeof resource_id === 'string') === (typeof folder === 'string'))
      throw bad('Pass either resource_id or folder');
    const items = (await c.ctx.get('resources', []));
    let targets;
    if (typeof resource_id === 'string') {
      if (!items.some(r => r.id === resource_id)) throw missing('Custom Node not found');
      if (project_id === 'lib-' + resource_id) throw bad('A Custom Node cannot contain itself');
      targets = [resource_id];
    } else {
      if (!(await nodeFolders(c)).includes(folder)) throw missing('Group not found');
      targets = items
        .filter(r => project_id !== 'lib-' + r.id && underPath(String(r.payload.folder || ''), folder))
        .map(r => r.id);
    }
    const {doc} = await c.workflow(project_id),
      available = new Set(doc.library_nodes ?? []);
    for (const id of targets) {
      if (enabled) available.add(id);
      else available.delete(id);
    }
    doc.library_nodes = [...available];
    return {library_nodes: clone(doc.library_nodes)};
  },
  {
    body: {resource_id: 'Library resource ID', enabled: true},
    query: ['workflow_id'],
    note: 'Use folder instead of resource_id to toggle a group and its subgroups. All Library nodes are excluded by default.',
  }
);

route(
  'POST',
  'projects/{project_id}/custom-nodes/{resource_id}',
  'Place a Library Custom Node on the canvas as one node',
  async (c, {project_id, resource_id}) => {
    const item = (await c.ctx.get('resources', [])).find(r => r.id === resource_id);
    if (!item) throw bad('Custom Node not found');
    if (project_id === 'lib-' + resource_id) throw bad('A Custom Node cannot contain itself');
    if (item.payload.bundle?.version !== BUNDLE_VERSION)
      throw bad(`The Custom Node “${item.name}” has a bundle this version cannot read.`);
    const {editor, doc} = await c.workflow(project_id);
    const result = editor.paste(clone(item.payload.bundle), c.body.point, {source: {resource_id, stamp: item.updated}, grants: c.body.grants ?? item.payload.grants ?? []});
    // Placement and inclusion are one edit: failed placement never changes the available set.
    doc.library_nodes = [...new Set([...(doc.library_nodes ?? []), resource_id])];
    return result;
  },
  {body: {point: {x: 0, y: 0}}, query: ['workflow_id']}
);

route(
  'POST',
  'projects/{project_id}/typed-nodes',
  'Create a Custom node',
  async (c, {project_id}) => {
    await c.requireDeveloper('Creating a Custom node');
    return (await c.workflow(project_id)).editor.saveNode(c.body);
  },
  {
    body: {
      node_type: 'custom',
      config: {
        title: 'Answer',
        op: 'script',
        inputs: [
          {id: 'in', name: 'In', type: 'signal'},
          {id: 'script', name: 'script', default: 'node.display(42);', type: 't:… (a type with the code control)'},
        ],
        outputs: [],
      },
      position: {x: 0, y: 0},
    },
    returns:
      'The new node. config: {title, inputs: [{id, name, type?}], outputs: [{id, name, type?}], op? (what the node does: script, on_run, on_read, on_placed, on_deleted, on_wired, on_widget; none: it holds the values typed into its outputs), widgets? (the widgets the node has: [{id, kind, label?, value?, ...}])}. A port of type `signal` carries no data: a signal output goes to every wire, and a signal input starts the node. A Script (op script) has exactly the signal input `in` and the code input `script`, and no outputs: it runs the code when a signal reaches it, and the code reads the data inputs of the Library node it is in (node.input.name), writes its free outputs (node.output.name) and fires its free signal outputs (node.emit(name)).',
  }
);
route(
  'POST',
  'projects/{project_id}/primitives',
  'Add a Script or an Event node',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.addPrimitive(c.body.primitive, c.body.point),
  {
    body: {primitive: 'script', point: {x: 0, y: 0}},
    returns:
      'The new node. The two nodes the engine is made of: `script` (runs its code when a signal reaches it) and `event` (no inputs, one signal output; it fires when the event chosen on it happens).',
  }
);
route(
  'PUT',
  'projects/{project_id}/primitives/{node_id}/event',
  'Choose the event of an Event node',
  async (c, {project_id, node_id}) => (await c.workflow(project_id)).editor.setEvent(node_id, c.body.event),
  {body: {event: 'on_run'}, returns: 'One of on_run, on_read, on_placed, on_deleted, on_wired, on_widget'}
);
route(
  'PUT',
  'projects/{project_id}/typed-nodes/{node_id}',
  "Change a Custom node's configuration",
  async (c, {project_id, node_id}) => {
    await c.requireDeveloper('Changing a Custom node');
    return (await c.workflow(project_id)).editor.saveNode(c.body, node_id);
  },
  {body: {node_type: 'custom', config: {title: 'Answer', outputs: [{id: 'result', name: 'result', default: 43}]}}}
);
route(
  'POST',
  'projects/{project_id}/split-connections',
  'Break connections in the middle with a Reroute point',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.splitConnections(c.body),
  {body: {splits: [{edge_id: 'port:…', position: {x: 0, y: 0}}]}, returns: 'The ids of the new Reroute points'}
);
route(
  'PUT',
  'projects/{project_id}/widgets/{node_id}',
  'Put widgets on a Custom node, or set the values of its widgets (for Script code that puts widgets on a node)',
  async (c, {project_id, node_id}) => {
    const {editor} = await c.workflow(project_id);
    if ('widgets' in c.body) editor.setWidgets(node_id, c.body.widgets);
    if ('values' in c.body) editor.setWidgetValues(node_id, c.body.values);
    if (!('widgets' in c.body || 'values' in c.body))
      throw bad('Give widgets (the list) or values ({widget ID: value})');
    return {saved: true};
  },
  {
    body: {widgets: [{id: 'name', kind: 'text', label: 'Name', value: ''}]},
    returns:
      'Widget kinds: text, textarea, number, checkbox, select (options), range (min, max, step), button (its value counts clicks), label (text), html (html, height; shown in a sandboxed frame). A widget that stays keeps its value unless the list gives one.',
  }
);
route(
  'PUT',
  'projects/{project_id}/widget-values',
  'A person changed widgets of a node: sets the values and calls on_widget of the node',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    editor.setWidgetValues(c.body.node_id, c.body.values);
    for (const id of Object.keys(c.body.values)) c.widgetEvents.push({node_id: c.body.node_id, widget_id: id});
    return {saved: true};
  },
  {body: {node_id: 'record:…', values: {name: 'Ann'}}}
);
route(
  'PUT',
  'projects/{project_id}/input-values',
  'A person typed into the control of a free input: sets the value (the default of the input) on the node; null takes it away',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    return editor.setInputValues(c.body.node_id, c.body.values);
  },
  {body: {node_id: 'record:… or complex:…', values: {name: 'Ann'}}}
);
route(
  'PUT',
  'projects/{project_id}/output-values',
  'A person typed into the control of an output that shows one (`editable`): sets the value the node holds there, which is its output until its code sets another; null takes it away',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    return editor.setOutputValues(c.body.node_id, c.body.values);
  },
  {body: {node_id: 'record:… or complex:…', values: {value: 'Ann'}}}
);
route(
  'GET',
  'projects/{project_id}/types',
  'The types this workflow defines (records of named, typed fields; ports use them as t:<id>)',
  async (c, {project_id}) => ({types: clone((await c.workflow(project_id)).editor.doc.types ?? [])}),
  {returns: '{types: [{id, name, color?, fields: [{name, type}]}]}'}
);
route(
  'PUT',
  'projects/{project_id}/types',
  'Replace the types of this workflow (a type that ports use cannot be removed)',
  async (c, {project_id}) => {
    await c.requireDeveloper('Changing types');
    // The Custom Node being edited may change the Library types it uses: they are changed for everybody once it is saved.
    return {
      types: (await c.workflow(project_id)).editor.setTypes(c.body.types, {library: project_id.startsWith('lib-')}),
    };
  },
  {
    body: {
      types: [
        {
          id: '32 hex characters',
          name: 'Person',
          color: '#7aa2f7',
          fields: [
            {name: 'name', type: 'text'},
            {name: 'age', type: 'int'},
          ],
        },
      ],
    },
  }
);
route(
  'PUT',
  'projects/{project_id}/node-slots/{node_id}',
  'Change the input and output slots of a node (for Script code that manages the slots of a Library node copy); a direction that is left out stays',
  async (c, {project_id, node_id}) => {
    const {inputs, outputs} = c.body,
      slots = {...(inputs ? {inputs} : {}), ...(outputs ? {outputs} : {})};
    return (await c.workflow(project_id)).editor.setSlots(node_id, slots);
  },
  {body: {inputs: [{id: 'a', name: 'a', type: 't:… (optional)'}], outputs: [{id: 'result', name: 'result'}]}}
);
route(
  'POST',
  'projects/{project_id}/port-connections',
  'Add or remove wires between ports',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.connections(c.body),
  {body: {add: [{source: 'node id', source_port: 'result', target: 'node id', target_port: 'input'}], remove: []}}
);
route(
  'PUT',
  'projects/{project_id}/complex/{group_id}',
  'Turn a group into a Complex Node, or change its ports, collapsed state or size',
  async (c, {project_id, group_id}) => (await c.workflow(project_id)).editor.complex(group_id, c.body),
  {body: {wrap: true, collapsed: false}}
);
route('GET POST', 'projects/{project_id}/graph-validation', 'Check the graph for problems', async (c, {project_id}) => {
  const {editor} = await c.workflow(project_id),
    issues = editor.snapshot().diagnostics;
  return {valid: !issues.length, errors: issues.map(i => i.message)};
});
route(
  'PUT',
  'projects/{project_id}/groups',
  'Replace the list of groups',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.groups(c.body.groups),
  {body: {groups: [{id: 'g1', name: 'Group', members: []}]}}
);
route(
  'DELETE',
  'projects/{project_id}/groups/{group_id}',
  'Delete a group with its nodes',
  async (c, {project_id, group_id}) => (await c.workflow(project_id)).editor.deleteGroup(group_id),
  {query: ['workflow_id']}
);
route(
  'POST',
  'projects/{project_id}/delete-nodes',
  'Delete nodes, optionally reconnecting their wires',
  async (c, {project_id}) =>
    (await c.workflow(project_id)).editor.deleteNodes(
      c.body.node_ids,
      c.body.dissolve ?? false,
      c.body.group_positions
    ),
  {body: {node_ids: [], dissolve: false}}
);
route(
  'POST',
  'projects/{project_id}/copy',
  'Copy nodes into a clipboard bundle',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.copy(c.body.node_ids, c.body.group_ids),
  {body: {node_ids: [], group_ids: []}}
);
route(
  'POST',
  'projects/{project_id}/paste',
  'Paste a clipboard bundle',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.paste(c.body.clipboard, c.body.point),
  {body: {clipboard: {version: BUNDLE_VERSION}, point: {x: 0, y: 0}}}
);
route(
  'PUT',
  'projects/{project_id}/node-style',
  'Pin, color, collapse (folded) or disable (disabled) a node or group; a disabled group disables everything in it',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.nodeStyle(c.body),
  {body: {node_id: 'node id', pinned: true, color: '#3b6ea8', folded: false, disabled: false}}
);
route(
  'PUT',
  'projects/{project_id}/node-title',
  'Rename a Custom node on this workflow (a Complex Node or a group is renamed through its group)',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.renameNode(c.body.node_id, c.body.title),
  {body: {node_id: 'node id', title: 'Name'}}
);
route(
  'PUT',
  'projects/{project_id}/layout',
  'Move or resize nodes',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.saveLayout(c.body.positions),
  {body: {positions: {'node id': {x: 0, y: 0}}}}
);

route(
  'POST',
  'projects/{project_id}/evaluate-node',
  'Evaluate nodes and return their outputs',
  async (c, {project_id}) => {
    const body = c.body,
      ids = body.node_ids ?? body.node_id;
    const multiple = Array.isArray(ids);
    const {editor,meta} = await c.workflow(project_id);
    const result = await evaluateGraph(editor.snapshot(), multiple ? ids : [ids], runPlan, {
      collect: body.collect === true, context: {project_id, workflow_id:meta.id}, signal: c.scriptContext?.signal
    });
    return {...result, outputs:multiple ? result.outputs : result.outputs[ids]};
  },
  {
    unlocked: true,
    body: {node_ids: ['node id'], collect: true},
    returns:
      'Outputs by node id, errors by node id, the state of every evaluated node and the text that nodes showed with node.display(), by node id',
  }
);
