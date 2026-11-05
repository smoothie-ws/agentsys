'use strict';
// API-level tests: they drive the in-browser backend exactly as the UI does (see harness.js).
// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

/** A project with one workflow; returns helpers bound to it. */
async function newProject(app, name = 'Test') {
  const {id} = await app.api('POST', 'projects', {name});
  const workflow = {workflow_id: id};
  return {
    id,
    workflow,
    node: (node_type, config = {}, position = {x: 0, y: 0}) =>
      app.api('POST', `projects/${id}/typed-nodes`, {...workflow, node_type, config, position}),
    connect: (source, source_port, target, target_port) =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...workflow,
        add: [{source, source_port, target, target_port}],
      }),
    snapshot: () => app.api('GET', `projects/${id}/workflow`, {}, workflow),
    evaluate: node_ids => app.api('POST', `projects/${id}/evaluate-node`, {...workflow, node_ids, collect: true}),
    /** A node that shows what reaches its input `input` (a Library node around a Script): wire to `.wrapper`, read `.id` in the displays. */
    show: () => fn(app, id, workflow, {code: 'node.display(input)', inputs: ['input']}),
    /** A Library node around a Script (see fn in harness.js). */
    fn: options => fn(app, id, workflow, options),
    /** An on_run wired to the nodes one after another; the ID of the on_run. */
    flow: (...steps) => flow(app, id, workflow, steps),
    /** Runs an on_run wired to the nodes one after another. */
    run: async (...steps) => {
      const start = await flow(app, id, workflow, steps);
      return app.api('POST', `projects/${id}/evaluate-node`, {...workflow, node_ids: [start], collect: true});
    },
  };
}
const script = nodes.script;
/** What a Preview node showed: the text it passed to node.display(). */
const shown = (run, id) => run.displays[id];

test('Custom nodes evaluate through wires: a value, some code, and a node that displays what reaches it', async () => {
  const app = createApp(),
    p = await newProject(app);
  const text = await p.node('custom', nodes.value('text', 'hi'));
  const code = await p.fn({code: 'node.output.result = v + "!"', inputs: ['v'], outputs: ['result'], signals: ['out']});
  const preview = await p.show();
  await p.connect(text.id, 'value', code.wrapper, 'v');
  await p.connect(code.wrapper, 'result', preview.wrapper, 'input');
  const result = await p.run(code.step, preview.step);
  assert.equal(shown(result, preview.id), 'hi!');
});

test('Custom is the only node type besides Reroute', async () => {
  const app = createApp(),
    p = await newProject(app);
  await rejects(p.node('script'), /supported node type/);
  await rejects(app.api('POST', `projects/${p.id}/nodes`, {...p.workflow, text: 'Note'}), /not found/);
});

test('Complex Nodes are built in the Library editor and behave as plain nodes in projects', async () => {
  const app = createApp();
  // 1. Open a new editor: it starts with a main group (a Complex Node) that everything is built inside.
  const opened = await app.api('POST', 'library/node-editor', {});
  const lib = {id: opened.project_id, workflow: {workflow_id: opened.workflow_id}};
  const add = (node_type, config) =>
    app.api('POST', `projects/${lib.id}/typed-nodes`, {...lib.workflow, node_type, config, position: {x: 40, y: 80}});
  const inner = await add(
    'custom',
    script('node.output.result = "A:" + node.input.text; await node.output.done.emit()')
  );
  let snap = await app.api('GET', `projects/${lib.id}/workflow`, {}, lib.workflow);
  const root = snap.groups.find(g => g.id === snap.root);
  assert.ok(root.members.includes(inner.id), 'new nodes are adopted into the main group');
  // 2. The main group cannot be deleted, ungrouped or collapsed.
  await rejects(app.api('DELETE', `projects/${lib.id}/groups/${root.id}`, {}, lib.workflow), /main group/);
  await rejects(app.api('PUT', `projects/${lib.id}/groups`, {...lib.workflow, groups: []}), /main group/);
  await rejects(app.api('PUT', `projects/${lib.id}/complex/${root.id}`, {...lib.workflow, wrap: false}), /main group/);
  // 3. Bind ports and save to the Library.
  await app.api('PUT', `projects/${lib.id}/complex/${root.id}`, {
    ...lib.workflow,
    interface: {
      inputs: [
        {id: 'text', name: 'text'},
        {id: 'go', name: 'in', type: 'signal', bound: [{node_id: inner.id, port_id: 'in'}]},
      ],
      outputs: [
        {id: 'out', name: 'result'},
        {id: 'done', name: 'done', type: 'signal'},
      ],
    },
  });
  await app.api('PUT', `projects/${lib.id}/groups`, {
    ...lib.workflow,
    groups: [{id: root.id, name: 'Wrap', members: root.members, parent: null}],
  });
  const saved = (await app.api('GET', 'resources', {})).find(r => r.id === opened.resource_id);
  assert.equal(saved?.name, 'Wrap', 'renaming the main group renames the node');
  assert.ok(saved && !('kind' in saved) && !('version' in saved), 'the node is saved automatically, without versions');
  assert.equal(saved.payload.bundle.complex[0].interface.inputs.length, 2);
  // 4. Place it in a project: one collapsed, locked node.
  const p = await newProject(app);
  const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {
    ...p.workflow,
    point: {x: 10, y: 10},
  });
  const gid = placed.roots[0];
  let psnap = await p.snapshot();
  const cx = psnap.complex.find(c => c.id === gid);
  assert.ok(cx.locked && cx.collapsed, 'placed Complex Nodes are locked and collapsed');
  await rejects(app.api('PUT', `projects/${p.id}/complex/${gid}`, {...p.workflow, collapsed: false}), /Library/);
  await rejects(app.api('PUT', `projects/${p.id}/groups`, {...p.workflow, groups: []}), /Library|cannot/);
  // 5. Wire through it and evaluate.
  const text = await p.node('custom', nodes.value('text', 'hi')),
    preview = await p.show();
  await p.connect(text.id, 'value', 'complex:' + gid, 'text');
  await p.connect('complex:' + gid, 'out', preview.wrapper, 'input');
  const start = await p.flow(['complex:' + gid, 'go', 'done'], preview.step);
  assert.equal(shown(await p.evaluate([start]), preview.id), 'A:hi');
  // 6. Edit the definition in the Library: placed copies follow, wires stay.
  const again = await app.api('POST', 'library/node-editor', {resource_id: opened.resource_id});
  const lib2 = {workflow_id: again.workflow_id};
  snap = await app.api('GET', `projects/${again.project_id}/workflow`, {}, lib2);
  const script2 = snap.nodes.find(n => n.node_type === 'custom');
  await app.api('PUT', `projects/${again.project_id}/typed-nodes/${encodeURIComponent(script2.id)}`, {
    ...lib2,
    node_type: 'custom',
    config: {
      ...script2.config,
      inputs: script2.config.inputs.map(i =>
        i.name === 'script'
          ? {...i, default: 'node.output.result = "B:" + node.input.text; await node.output.done.emit()'}
          : i
      ),
    },
  });
  psnap = await p.snapshot();
  assert.equal(psnap.edges.length, 4, 'wires survive the refresh');
  assert.equal(shown(await p.evaluate([start]), preview.id), 'B:hi');
});

test('Custom Node groups form a tree: create, nest, move, rename, delete with contents', async () => {
  const app = createApp();
  const bundle = {
    version: 3,
    groups: [{id: 'g', name: 'N', members: [], parent: null, position: {x: 0, y: 0}}],
    complex: [{id: 'g', interface: {inputs: [], outputs: []}}],
    notes: [],
    records: [],
    port_edges: [],
    positions: {},
    styles: {},
  };
  const node = await app.api('POST', 'resources', {name: 'If', payload: {bundle}});
  const folders = body => app.api('POST', 'library/node-folders', body);
  await folders({action: 'create', path: '', name: 'Logic'});
  assert.deepEqual(await folders({action: 'create', path: 'Logic', name: 'Boolean'}), ['Logic', 'Logic/Boolean']);
  await rejects(folders({action: 'create', path: 'Logic', name: 'Boolean'}), /already exists/);
  await app.api('POST', `library/custom-nodes/${node.id}/move`, {folder: 'Logic/Boolean'});
  assert.deepEqual(await folders({action: 'rename', path: 'Logic', name: 'Gates'}), ['Gates', 'Gates/Boolean']);
  assert.equal((await app.api('GET', `resources/${node.id}`)).payload.folder, 'Gates/Boolean');
  // Deleting a group deletes what is inside it (groups and Custom Nodes).
  assert.deepEqual(await folders({action: 'delete', path: 'Gates'}), []);
  assert.deepEqual(await app.api('GET', 'resources'), []);
});

test('groups nest, and deleting a group deletes what is inside', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'a')),
    b = await p.node('custom', nodes.value('text', 'b'));
  await app.api('PUT', `projects/${p.id}/groups`, {
    ...p.workflow,
    groups: [
      {id: 'outer', name: 'Outer', members: [a.id], parent: null},
      {id: 'inner', name: 'Inner', members: [b.id], parent: 'outer'},
    ],
  });
  let snap = await p.snapshot();
  assert.deepEqual(snap.groups.find(g => g.id === 'outer').all_members.sort(), [a.id, b.id].sort());
  await app.api('DELETE', `projects/${p.id}/groups/outer`, {}, p.workflow);
  snap = await p.snapshot();
  assert.equal(snap.nodes.length, 0);
  assert.equal(snap.groups.length, 0);
});

test('copy and paste keeps groups, Complex Node ports and wires', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'a')),
    s = await p.node('custom', {title: 'S', inputs: [{id: 'v', name: 'v'}], outputs: [{id: 'result', name: 'result'}]});
  await p.connect(a.id, 'value', s.id, 'v');
  await app.api('PUT', `projects/${p.id}/groups`, {
    ...p.workflow,
    groups: [{id: 'g', name: 'G', members: [a.id, s.id], parent: null}],
  });
  const bundle = await app.api('POST', `projects/${p.id}/copy`, {...p.workflow, node_ids: [], group_ids: ['g']});
  const result = await app.api('POST', `projects/${p.id}/paste`, {
    ...p.workflow,
    clipboard: bundle,
    point: {x: 500, y: 0},
  });
  assert.equal(result.roots.length, 1);
  const snap = await p.snapshot();
  assert.equal(snap.nodes.length, 4);
  assert.equal(snap.edges.length, 2);
});

test('settings reject shortcuts that clash', async () => {
  const app = createApp();
  await rejects(app.api('PUT', 'settings', {shortcuts: {copy: 'Ctrl+KeyV'}}), /unique/);
});

test('Graph Editor appearance settings are validated and saved', async () => {
  const app = createApp();
  const saved = await app.api('PUT', 'settings', {style: {wire_style: 'rounded', node_radius: 6, wire_width: 3}});
  assert.equal(saved.style.wire_style, 'rounded');
  assert.equal(saved.style.node_radius, 6);
  await rejects(app.api('PUT', 'settings', {style: {wire_style: 'zigzag'}}), /wire style/i);
  await rejects(app.api('PUT', 'settings', {style: {node_radius: 99}}), /node_radius/);
});

test('the code of a Custom node can be a bare expression, and it can run code that arrives through a wire', async () => {
  const app = createApp(),
    p = await newProject(app);
  const flag = await p.node('custom', nodes.value('boolean', false));
  const expr = await p.fn({
    code: 'node.output.result = condition ? "yes" : "no"',
    inputs: ['condition'],
    outputs: ['result'],
    signals: ['out'],
  });
  const preview = await p.show();
  await p.connect(flag.id, 'value', expr.wrapper, 'condition');
  await p.connect(expr.wrapper, 'result', preview.wrapper, 'input');
  assert.equal(shown(await p.run(expr.step, preview.step), preview.id), 'no');

  // Code arriving as text is just a text input and `new AsyncFunction`: nothing special is needed for it.
  const source = await p.node('custom', nodes.value('text', '40 + 2'));
  const dynamic = await p.fn({
    code: 'node.output.result = await new (Object.getPrototypeOf(async function () {}).constructor)("return (" + code + ")")()',
    inputs: ['code'],
    outputs: ['result'],
    signals: ['out'],
  });
  const out = await p.show();
  await p.connect(source.id, 'value', dynamic.wrapper, 'code');
  await p.connect(dynamic.wrapper, 'result', out.wrapper, 'input');
  assert.equal(shown(await p.run(dynamic.step, out.step), out.id), '42');
});

test('a new connection replaces the one on an occupied input', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'a')),
    b = await p.node('custom', nodes.value('text', 'b')),
    preview = await p.show();
  await p.connect(a.id, 'value', preview.wrapper, 'input');
  await p.connect(b.id, 'value', preview.wrapper, 'input');
  const snap = await p.snapshot();
  assert.equal(snap.edges.length, 1);
  assert.equal(snap.edges[0].source, b.id);
});

test('a Custom node knows its own node, workflow and project through context', async () => {
  const app = createApp(),
    p = await newProject(app);
  const s = await p.fn({
    code: 'node.display(JSON.stringify([context.node_id, context.workflow_id, context.project_id]))',
  });
  const out = await p.run(s.step);
  assert.deepEqual(JSON.parse(shown(out, s.id)), [s.id, p.id, p.id]);
});

test('splitting a connection puts a Reroute point on the wire that passes the value on', async () => {
  const app = createApp(),
    p = await newProject(app);
  const v = await p.node('custom', nodes.value('text', 'hi')),
    a = await p.show(),
    b = await p.show();
  await p.connect(v.id, 'value', a.wrapper, 'input');
  const edge = (await p.snapshot()).edges[0];
  const {ids} = await app.api('POST', `projects/${p.id}/split-connections`, {
    ...p.workflow,
    splits: [{edge_id: edge.id, position: {x: 5, y: 5}}],
  });
  await p.connect(ids[0], 'out', b.wrapper, 'input');
  const snap = await p.snapshot();
  assert.equal(snap.edges.length, 3, 'source→point, point→first, point→second');
  const out = await p.evaluate([a.id, b.id]);
  assert.equal(shown(out, a.id), 'hi');
  assert.equal(shown(out, b.id), 'hi');
  await app.api('POST', `projects/${p.id}/delete-nodes`, {...p.workflow, node_ids: ids, dissolve: true});
  assert.equal((await p.snapshot()).edges.length, 2, 'dissolving joins the wires back');
});

test('a Reroute joins any ports: nothing says what flows through a wire', async () => {
  const app = createApp(),
    p = await newProject(app);
  const text = await p.node('custom', nodes.value('text', 'hi')),
    anything = await p.show();
  await p.connect(text.id, 'value', anything.wrapper, 'input');
  const edge = (await p.snapshot()).edges[0];
  const {ids} = await app.api('POST', `projects/${p.id}/split-connections`, {
    ...p.workflow,
    splits: [{edge_id: edge.id, position: {x: 5, y: 5}}],
  });
  const point = (await p.snapshot()).nodes.find(n => n.id === ids[0]);
  assert.deepEqual(
    point.inputs.map(i => i.id),
    ['in']
  );
  assert.equal(shown(await p.evaluate([anything.id]), anything.id), 'hi');
});

test('a node can be folded; the fold is saved, copied and validated', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'hi'));
  assert.equal((await p.snapshot()).nodes[0].folded, false);
  await app.api('PUT', `projects/${p.id}/node-style`, {...p.workflow, node_id: a.id, folded: true});
  let node = (await p.snapshot()).nodes[0];
  assert.equal(node.folded, true);
  assert.equal(node.pinned, false, 'folding leaves the pin alone');
  await app.api('PUT', `projects/${p.id}/node-style`, {
    ...p.workflow,
    node_id: a.id,
    pinned: true,
    position: {x: 1, y: 1},
  });
  assert.equal((await p.snapshot()).nodes[0].folded, true, 'pinning leaves the fold alone');
  await rejects(
    app.api('PUT', `projects/${p.id}/node-style`, {...p.workflow, node_id: a.id, folded: 'yes'}),
    /boolean/i
  );
  const clipboard = await app.api('POST', `projects/${p.id}/copy`, {...p.workflow, node_ids: [a.id]});
  await app.api('POST', `projects/${p.id}/paste`, {...p.workflow, clipboard, point: {x: 300, y: 0}});
  const all = (await p.snapshot()).nodes;
  assert.equal(all.length, 2);
  assert.ok(
    all.every(n => n.folded),
    'the copy is folded too'
  );
  await app.api('PUT', `projects/${p.id}/node-style`, {...p.workflow, node_id: a.id, folded: false});
  assert.equal((await p.snapshot()).nodes.find(n => n.id === a.id).folded, false);
});

test('deleting a Library group deletes its groups and Custom Nodes with it', async () => {
  const app = createApp();
  const bundle = {version: 3, groups: [{id: 'g', name: 'N', members: [], parent: null}], complex: []};
  const node = (name, folder) => app.api('POST', 'resources', {name, payload: {bundle, folder}});
  await app.api('POST', 'library/node-folders', {action: 'create', path: '', name: 'Logic'});
  await app.api('POST', 'library/node-folders', {action: 'create', path: 'Logic', name: 'Text'});
  const keep = await node('Keep', ''),
    inner = await node('Inner', 'Logic/Text'),
    top = await node('Top', 'Logic');
  const folders = await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Logic'});
  assert.deepEqual(folders, []);
  const names = (await app.api('GET', 'resources')).map(r => r.name);
  assert.deepEqual(names, ['Keep']);
  assert.ok(keep.id && inner.id && top.id);
});

test('changing the ports of a Custom node drops the wires of the slots that are gone', async () => {
  const app = createApp(),
    p = await newProject(app);
  const update = (id, config) =>
    app.api('PUT', `projects/${p.id}/typed-nodes/${encodeURIComponent(id)}`, {
      ...p.workflow,
      node_type: 'custom',
      config,
    });
  const source = await p.node('custom', {title: 'Source', inputs: [], outputs: [{id: 'result', name: 'result'}]}),
    target = await p.node('custom', {
      title: 'Target',
      inputs: [
        {id: 't', name: 't'},
        {id: 'u', name: 'u'},
      ],
      outputs: [],
    });
  await p.connect(source.id, 'result', target.id, 't');
  // The input keeps its wire while the slot is there.
  await update(target.id, {title: 'Target', inputs: [{id: 't', name: 't'}], outputs: []});
  let snap = await p.snapshot();
  assert.equal(snap.edges.length, 1);
  await update(target.id, {title: 'Target', inputs: [{id: 'u', name: 'u'}], outputs: []});
  snap = await p.snapshot();
  assert.equal(snap.edges.length, 0, 'the slot t is gone, so is its wire');
  assert.deepEqual(snap.diagnostics, []);
});

test('a Custom Node port loses its binding when the port inside is gone', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const lib = {id: opened.project_id, workflow: {workflow_id: opened.workflow_id}};
  const call = (method, path, body = {}) =>
    app.api(method, `projects/${lib.id}/${path}`, {...lib.workflow, ...body}, lib.workflow);
  const inner = await call('POST', 'typed-nodes', {
    node_type: 'custom',
    config: {title: 'Inner', inputs: [{id: 'v', name: 'v'}], outputs: [{id: 'result', name: 'result'}]},
  });
  const snapshot = () => call('GET', 'workflow');
  const group = (await snapshot()).root;
  await call('PUT', `complex/${group}`, {
    interface: {inputs: [{id: 'in', name: 'in', bound: [{node_id: inner.id, port_id: 'v'}]}], outputs: []},
  });
  const bound = async () => (await snapshot()).complex[0].interface.inputs[0].bound?.[0].node_id;
  assert.equal(await bound(), inner.id);
  await call('PUT', `typed-nodes/${encodeURIComponent(inner.id)}`, {
    node_type: 'custom',
    config: {title: 'Inner', inputs: [{id: 'w', name: 'w'}], outputs: [{id: 'result', name: 'result'}]},
  });
  assert.equal(await bound(), undefined, 'the port v is gone, so the binding is');
  assert.deepEqual((await snapshot()).diagnostics, []);
});

test('a Custom Node being edited can be read like a project, but not renamed, deleted or filled with workflows', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const id = opened.project_id;
  assert.equal((await app.api('GET', `projects/${id}`)).workflows.length, 1);
  await rejects(app.api('PATCH', `projects/${id}`, {name: 'X'}), /Library/);
  await rejects(app.api('DELETE', `projects/${id}`), /Library/);
  await rejects(app.api('POST', `projects/${id}/duplicate`, {}), /Library/);
  await rejects(app.api('POST', `projects/${id}/workflows`, {name: 'W'}), /Library/);
  await rejects(app.api('DELETE', `projects/${id}/workflows/${opened.workflow_id}`), /Library/);
  const snap = await app.api('GET', `projects/${id}/workflow`, {}, {workflow_id: opened.workflow_id});
  assert.ok(snap.root, 'the node is still there');
});

test('uploaded icons persist with Library nodes and folders', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCTYAAAAASUVORK5CYII=';
  const item = await app.api('GET', `resources/${opened.resource_id}`);
  await app.api('PUT', `resources/${item.id}`, {name: item.name, payload: {...item.payload, icon: image}});
  assert.equal((await app.api('GET', `resources/${item.id}`)).payload.icon, image);
  await app.api('POST', 'library/node-folders', {action: 'create', path: '', name: 'Images'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Images', icon: image});
  assert.equal((await app.api('GET', 'settings')).node_folder_icons.Images, image);
  await rejects(
    app.api('POST', 'library/node-folders', {action: 'icon', path: 'Images', icon: 'data:text/html;base64,eA=='}),
    /icon/
  );
  await rejects(
    app.api('PUT', `resources/${item.id}`, {
      name: item.name,
      payload: {...item.payload, icon: 'data:image/png;base64,' + 'a'.repeat(100000)},
    }),
    /icon/
  );
});

test('turning Developer mode off also protects a previously opened Library graph', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const path = `projects/${opened.project_id}`;
  const snapshot = await app.api('GET', `${path}/workflow`);
  await app.api('PUT', 'settings', {developer_mode: false});
  await rejects(app.api('POST', 'library/node-editor', {resource_id: opened.resource_id}), /developer mode/);
  await rejects(app.api('PUT', `${path}/layout`, {positions: {}}), /developer mode/);
  await rejects(app.api('PUT', `${path}/groups`, {groups: snapshot.groups}), /developer mode/);
  assert.deepEqual(await app.api('GET', `${path}/workflow`), snapshot);
});

test('a key removed during a request stays removed when it is read again', async () => {
  const app = createApp();
  const result = await app.eval(`(async () => {
    await DB.commit({k: {a: 1}});
    const ctx = new Context();
    await ctx.remove('k');
    const again = await ctx.get('k', null);
    return JSON.stringify({again, changes: Object.keys(ctx.changes())});
  })()`);
  assert.deepEqual(JSON.parse(result), {again: null, changes: ['k']});
});

test('a project may have no workflow: the last one can be deleted and a new one added', async () => {
  const app = createApp();
  const {id} = await app.api('POST', 'projects', {name: 'Empty'});
  assert.equal((await app.api('GET', `projects/${id}`)).workflows.length, 1);
  await app.api('DELETE', `projects/${id}/workflows/${id}`);
  assert.deepEqual((await app.api('GET', `projects/${id}`)).workflows, []);
  const made = await app.api('POST', `projects/${id}/workflows`, {name: 'Again'});
  assert.equal((await app.api('GET', `projects/${id}`)).workflows.length, 1);
  assert.ok(made.id);
});

test('renaming a Library group to itself preserves its icons and descendant icons', async () => {
  const app = createApp();
  await app.api('POST', 'library/node-folders', {action: 'create', name: 'Logic'});
  await app.api('POST', 'library/node-folders', {action: 'create', path: 'Logic', name: 'Nested'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Logic', icon: 'bolt'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Logic/Nested', icon: 'star'});
  await app.api('POST', 'library/node-folders', {action: 'rename', path: 'Logic', name: 'Logic'});
  assert.deepEqual((await app.api('GET', 'settings')).node_folder_icons, {Logic: 'bolt', 'Logic/Nested': 'star'});
});

test('duplicate names stay unique and within 100 characters for workflows and Library nodes', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'P'.repeat(100)});
  await app.api('PATCH', `projects/${project.id}/workflows/${project.id}`, {name: 'W'.repeat(100)});
  const resource = await app.api('POST', 'resources', {
    name: 'N'.repeat(100),
    payload: {
      bundle: {version: 3, groups: [{id: 'g', name: 'N', members: [], parent: null}], complex: []},
    },
  });
  for (const route of [
    `projects/${project.id}/duplicate`,
    `projects/${project.id}/workflows/${project.id}/duplicate`,
    `library/custom-nodes/${resource.id}/duplicate`,
  ]) {
    const copies = [];
    for (let i = 0; i < 3; i++) copies.push(await app.api('POST', route));
    assert.equal(new Set(copies.map(c => c.name)).size, 3);
    assert.ok(copies.every(c => c.name.length <= 100));
  }
});

test('invalid ports and inherited node type names are rejected as invalid requests', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Validation'});
  for (const node_type of ['constructor', 'toString', '__proto__']) {
    await assert.rejects(
      app.api('POST', `projects/${project.id}/typed-nodes`, {node_type}),
      e => e.code === 'invalid_request'
    );
  }
  for (const direction of ['inputs', 'outputs']) {
    await assert.rejects(
      app.api('POST', `projects/${project.id}/typed-nodes`, {node_type: 'custom', config: {[direction]: [null]}}),
      e => e.code === 'invalid_request'
    );
  }
  assert.equal((await app.api('GET', `projects/${project.id}/workflow`)).nodes.length, 0);
});

test('deleting a project removes its stored permission policy', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Policy'});
  assert.ok(await app.eval(`DB.get('policy:${project.id}')`));
  await app.api('DELETE', `projects/${project.id}`);
  assert.equal(await app.eval(`DB.get('policy:${project.id}')`), undefined);
});

test('independent UI state updates merge without overwriting other clients', async () => {
  const app = createApp();
  await Promise.all([
    app.api('PUT', 'ui-state', {values: {'agentsys-snap': true}}),
    app.api('PUT', 'ui-state', {values: {'agentsys-hints': false}}),
  ]);
  const state = JSON.parse(JSON.stringify(await app.eval("DB.get('ui-state')")));
  assert.deepEqual(state, {'agentsys-snap': true, 'agentsys-hints': false});
  for (const values of [null, [], {'unrelated-key': true}, JSON.parse('{"__proto__":{}}')]) {
    await assert.rejects(app.api('PUT', 'ui-state', {values}), e => e.code === 'invalid_request');
  }
});

test('malformed imported types and inherited shortcut names return validation errors', async () => {
  const app = createApp();
  const TextGraph = require('../js/storage/format');
  const project = await app.api('POST', 'projects', {name: 'Invalid imports'});
  for (const type of [null, 42, 'invalid']) {
    await assert.rejects(
      app.api('POST', `projects/${project.id}/workflows/import`, TextGraph.encode({document: {types: [type]}})),
      e => e.code === 'invalid_request'
    );
  }
  for (const key of ['constructor', 'toString', '__proto__']) {
    await assert.rejects(app.api('PUT', 'settings', {shortcuts: {[key]: ''}}), e => e.code === 'invalid_request');
  }
});

test('deleting a Library group also reconciles types owned only by its removed nodes', async () => {
  const app = createApp();
  const id = '1234567890abcdef1234567890abcdef';
  await app.api('POST', 'resources', {
    name: 'Disposable type owner',
    payload: {
      folder: 'Disposable',
      bundle: {
        version: 3,
        types: [{id, name: 'Disposable type', fields: []}],
        groups: [{id: 'g', name: 'Owner', members: [], parent: null}],
        complex: [],
        records: [],
      },
    },
  });
  assert.equal(
    (await app.eval("DB.get('library_types')")).some(t => t.id === id),
    true
  );
  await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Disposable'});
  assert.equal(
    (await app.eval("DB.get('library_types')")).some(t => t.id === id),
    false
  );
});

test('graph import inserts connected nodes and nested groups into the chosen workflow and supports undo', async () => {
  const app = createApp(), p = await newProject(app, 'Graph exchange');
  const a = await p.node('custom', {title: 'Source', outputs: [{id: 'out', name: 'out'}]}, {x: 20, y: 40});
  const b = await p.node('custom', {title: 'Target', inputs: [{id: 'in', name: 'in'}], outputs: []}, {x: 320, y: 40});
  await p.connect(a.id, 'out', b.id, 'in');
  await app.api('PUT', `projects/${p.id}/groups`, {...p.workflow, groups: [
    {id: 'outer', name: 'Outer', members: [a.id], parent: null},
    {id: 'inner', name: 'Inner', members: [b.id], parent: 'outer'},
  ]});
  const packet = await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`);
  const other = await app.api('POST', `projects/${p.id}/workflows`, {name: 'Existing target'});
  const body = {workflow_id: other.id, graph: packet, point: {x: 500, y: 600}};
  await app.api('POST', `projects/${p.id}/import-graph`, body);
  const snapshot = () => app.api('GET', `projects/${p.id}/workflow`, {}, {workflow_id: other.id});
  let snap = await snapshot();
  assert.equal(snap.nodes.length, 2);
  assert.equal(snap.groups.length, 2);
  assert.equal(snap.edges.length, 1);
  assert.ok(snap.nodes.every(n => ![a.id, b.id].includes(n.id)));
  assert.ok(snap.edges.every(e => snap.nodes.some(n => n.id === e.source) && snap.nodes.some(n => n.id === e.target)));
  const outer = snap.groups.find(g => g.name === 'Outer'), inner = snap.groups.find(g => g.name === 'Inner');
  assert.equal(inner.parent, outer.id);
  assert.equal(snap.nodes.find(n => n.config.title === 'Source').position.x, 500);
  await app.api('POST', `projects/${p.id}/import-graph`, body);
  snap = await snapshot();
  assert.equal(snap.nodes.length, 4);
  assert.equal(snap.edges.length, 2);
  assert.equal((await app.api('GET', `projects/${p.id}`)).workflows.length, 2);
  assert.equal((await p.snapshot()).nodes.length, 2);
  await app.api('POST', `projects/${p.id}/undo`, {workflow_id: other.id});
  assert.equal((await snapshot()).nodes.length, 2);
  await app.api('POST', `projects/${p.id}/undo`, {workflow_id: other.id});
  assert.equal((await snapshot()).nodes.length, 0);
  await assert.rejects(app.api('POST', `projects/${p.id}/import-graph`, {...body, graph: {}}), /Expected/);
  assert.equal((await snapshot()).nodes.length, 0);
});
