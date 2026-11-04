'use strict';
// Types: the Library's and the workflow's own (only any is built in), structural compatibility, and the types travelling with copied nodes.
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const hex = n => String(n).padStart(32, '0');
const T = n => 't:' + hex(n);
const kind = (id, name) => ({id, name, fields: []});
const TEXT = kind(hex(11), 'Text'),
  NUMBER = kind(hex(12), 'Number');
const person = (id = hex(1), name = 'Person') => ({
  id,
  name,
  fields: [
    {name: 'name', type: T(11)},
    {name: 'age', type: T(12)},
  ],
});
const base = () => [TEXT, NUMBER];

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Types'});
  return {
    id,
    types: list => app.api('PUT', `projects/${id}/types`, {types: list}),
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {node_ids: ids, collect: true}),
    snapshot: () => app.api('GET', `projects/${id}/workflow`),
  };
}

test('only any is built in: no other type exists until the document defines it', async () => {
  const app = createApp(),
    p = await project(app);
  assert.deepEqual((await p.snapshot()).types, []);
  await rejects(p.node({outputs: [{id: 'o', name: 'o', type: 'text'}]}), /type/);
  const anyNode = await p.node({outputs: [{id: 'o', name: 'o', type: 'any'}]}); // the built-in
  assert.equal(anyNode.id.startsWith('record:'), true);
  // Any other name is free, “text” too: it is just a name.
  await p.types([kind(hex(1), 'text'), kind(hex(2), 'number')]);
});

test('type expressions: shapes, labels and structural compatibility', () => {
  const {context} = createApp();
  const run = code => (context.eval ? context.eval(code) : require('node:vm').runInContext(code, context));
  const result = run(`
    (() => {
      const b = ${JSON.stringify({...person(hex(2), 'B'), fields: [...person().fields, {name: 'mail', type: T(11)}]})};
      const t = new TypeTable([${JSON.stringify(TEXT)}, ${JSON.stringify(NUMBER)}, ${JSON.stringify(person(hex(1), 'A'))}, b]);
      return JSON.stringify([
        compatible('${T(2)}', '${T(1)}', t), // more fields fits fewer
        compatible('${T(1)}', '${T(2)}', t),
        compatible('${T(11)}', '${T(11)}', t),
        compatible('${T(11)}', '${T(12)}', t), // named kinds fit only themselves
        compatible('${T(11)}', '${T(1)}', t),
        compatible('${T(1)}', '${T(11)}', t),
        compatible('any', '${T(1)}', t), // any fits everything, both ways
        compatible('${T(1)}', undefined, t),
        compatible('${T(99)}', '${T(1)}', t), // unknown means nothing
        t.label('${T(1)}'),
        renameTypeRefs('${T(1)}', new Map([['${hex(1)}', '${hex(5)}']])),
      ]);
    })()`);
  assert.deepEqual(JSON.parse(result), [true, false, true, false, false, false, true, true, false, 'A', T(5)]);
});

test('types are checked: names, fields, unknown and self-containing types', async () => {
  const app = createApp(),
    p = await project(app);
  await rejects(p.types([person(), person(hex(2))]), /unique/);
  await rejects(p.types([{...person(), fields: [{name: 'x', type: T(7)}]}]), /unknown type/);
  await rejects(p.types([{...person(), fields: [{name: 'me', type: T(1)}]}]), /contains itself/);
  await rejects(
    p.types([
      {
        ...person(),
        fields: [
          {name: 'a', type: 'any'},
          {name: 'a', type: 'any'},
        ],
      },
    ]),
    /unique name/
  );
  const saved = await p.types([
    ...base(),
    person(),
    {
      id: hex(2),
      name: 'Team',
      fields: [
        {name: 'people', type: T(1)},
        {name: 'note', type: 'any'},
      ],
    },
  ]);
  assert.equal(saved.types.length, 4);
  assert.equal((await app.api('GET', `projects/${p.id}/types`)).types.length, 4);
  assert.equal((await p.snapshot()).types.length, 4);
});

test('wires are checked by type; ports of type any take anything; the run never looks at types', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([
    ...base(),
    person(),
    person(hex(2), 'Human'),
    {id: hex(3), name: 'Named', fields: [{name: 'name', type: T(11)}]},
  ]);
  const make = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.who = {name: "Ann", age: 30}', outputs: [{name: 'who', type: T(1)}], signals: ['out']}
  );
  const take = type =>
    fn(app, p.id, {}, {code: 'node.display(who.name)', inputs: [{name: 'who', ...(type ? {type} : {})}]});
  const human = await take(T(2)),
    named = await take(T(3)),
    other = await take(T(12)),
    kindOnly = await take(T(11)),
    free = await take();
  await p.connect(make.wrapper, 'who', human.wrapper, 'who'); // the same fields under another name
  await p.connect(make.wrapper, 'who', named.wrapper, 'who'); // fewer fields
  await p.connect(make.wrapper, 'who', free.wrapper, 'who'); // any
  await rejects(p.connect(make.wrapper, 'who', other.wrapper, 'who'), /incompatible/);
  await rejects(p.connect(make.wrapper, 'who', kindOnly.wrapper, 'who'), /incompatible/);
  // The signal runs the Scripts one after another, the data is read when they run.
  const start = await flow(app, p.id, {}, [make.step]);
  for (const t of [human, named, free]) await p.connect(make.wrapper, 'out', t.wrapper, 'in');
  const r = await p.evaluate([start]);
  assert.deepEqual(r.errors, {});
  assert.equal(r.displays[human.id], 'Ann');
  assert.equal(r.displays[free.id], 'Ann');
  // A node that puts something else into a typed output is not stopped: types decide only what can be wired.
  const odd = await fn(app, p.id, {}, {code: 'node.output.who = 5', outputs: [{name: 'who', type: T(1)}]});
  const seen = await p.evaluate([odd.id]);
  assert.deepEqual(seen.errors ?? {}, {});
  assert.equal(seen.outputs[odd.id].who, 5);
  // An output of type any goes into a typed input.
  const loose = await p.node({outputs: [{id: 'o', name: 'o'}]});
  await p.connect(loose.id, 'o', named.wrapper, 'who');
});

test('a type in use cannot be removed; a changed type drops the wires that no longer fit', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([...base(), person(), person(hex(2), 'Same')]);
  const a = await p.node({outputs: [{id: 'o', name: 'o', type: T(1)}]}),
    b = await p.node({inputs: [{id: 'i', name: 'i', type: T(2)}]});
  await p.connect(a.id, 'o', b.id, 'i');
  await rejects(p.types([...base(), person()]), /in use/);
  // The consumer now needs a field the producer lacks: the wire cannot stay.
  await p.types([
    ...base(),
    person(),
    {...person(hex(2), 'Same'), fields: [...person().fields, {name: 'mail', type: T(11)}]},
  ]);
  assert.equal((await p.snapshot()).edges.length, 0);
});

test('a Reroute takes the type of the wire that enters it', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types(base());
  const a = await p.node({outputs: [{id: 'o', name: 'o', type: T(11)}]}),
    b = await p.node({inputs: [{id: 'i', name: 'i', type: T(12)}]}),
    c = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]});
  const rr = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'reroute',
    config: {},
    position: {x: 0, y: 0},
  });
  await p.connect(a.id, 'o', rr.id, 'in');
  await p.connect(rr.id, 'out', c.id, 'i');
  await rejects(p.connect(rr.id, 'out', b.id, 'i'), /incompatible/);
});

test('copied nodes bring their types; pasting merges them by name and shape', async () => {
  const app = createApp(),
    from = await project(app),
    to = await project(app);
  await from.types([...base(), person()]);
  const n = await from.node({outputs: [{id: 'o', name: 'o', type: T(1)}]});
  const bundle = await app.api('POST', `projects/${from.id}/copy`, {node_ids: [n.id]});
  assert.deepEqual(bundle.types.map(t => t.name).sort(), ['Number', 'Person', 'Text']);
  const paste = () => app.api('POST', `projects/${to.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  await paste();
  await paste();
  assert.equal((await to.snapshot()).types.length, 3, 'the same type is not added twice');
  // Another project already has a different “Person” under the same ID: the pasted one gets its own ID and name.
  const other = await project(app);
  await other.types([...base(), {...person(), fields: [{name: 'name', type: T(11)}]}]);
  await app.api('POST', `projects/${other.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  const types = (await other.snapshot()).types;
  assert.deepEqual(
    types.map(t => t.name),
    ['Text', 'Number', 'Person', 'Person (2)']
  );
  const pasted = (await other.snapshot()).nodes.find(x => x.outputs.some(o => o.type));
  assert.equal(pasted.outputs[0].type, 't:' + types[3].id);
  await rejects(
    app.api('POST', `projects/${to.id}/paste`, {
      clipboard: {...bundle, types: [{...person(), fields: [{name: 'x', type: T(77)}]}]},
      point: {x: 0, y: 0},
    }),
    /unknown type/
  );
});

test('exported workflows keep their types; a document without types still loads', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([...base(), person()]);
  await p.node({outputs: [{id: 'o', name: 'o', type: T(1)}]});
  const wf = (await p.snapshot()).workflow_id;
  const TextGraph = require('../js/storage/format');
  const packet = await app.api('GET', `projects/${p.id}/workflows/${wf}/export`);
  const exported = TextGraph.decode(packet);
  assert.equal(exported.document.types.length, 3);
  const q = await project(app);
  await app.api('POST', `projects/${q.id}/workflows/import`, packet);
  const {types, ...without} = exported.document;
  const broken = await app.api('POST', `projects/${q.id}/workflows/import`, TextGraph.encode({document: without}));
  assert.ok(
    broken.diagnostics.some(m => /Unknown type/.test(m)),
    'ports of a type the document lacks are reported'
  );
  await app.api('POST', `projects/${q.id}/workflows/import`, TextGraph.encode({document: {nodes: [], layout: {}}}));
});

test('a Library node carries its types: placing it brings them, and its slots are typed', async () => {
  const app = createApp(),
    opened = await app.api('POST', 'library/node-editor', {}),
    wf = {workflow_id: opened.workflow_id},
    lib = await app.api('GET', `projects/${opened.project_id}/workflow`, {}, wf);
  await app.api('PUT', `projects/${opened.project_id}/types`, {...wf, types: base()});
  await app.api('PUT', `projects/${opened.project_id}/complex/${lib.root}`, {
    ...wf,
    interface: {inputs: [], outputs: [{id: 'text', name: 'text', type: T(11)}]},
  });
  const p = await project(app);
  const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {point: {x: 0, y: 0}});
  const snap = await p.snapshot();
  assert.deepEqual(
    snap.types.map(t => t.name),
    ['Text']
  ); // only the types its ports use
  const cx = snap.complex.find(c => c.id === placed.roots[0]);
  assert.equal(cx.outputs[0].type, T(11));
  await p.types([...snap.types, NUMBER]);
  const sink = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]}),
    wrong = await p.node({inputs: [{id: 'i', name: 'i', type: T(12)}]});
  await p.connect('complex:' + cx.id, 'text', sink.id, 'i');
  await rejects(p.connect('complex:' + cx.id, 'text', wrong.id, 'i'), /incompatible/);
});

// ----- aliases -----
const SCRIPT = {id: hex(21), name: 'Script', fields: [], alias: T(11), control: 'code'};

test('an alias type means what its target means: the two are interchangeable on wires, the alias keeps its name and control', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([...base(), SCRIPT]);
  const text = await p.node({
      outputs: [{id: 'o', name: 'o', type: T(11)}],
      inputs: [{id: 'i', name: 'i', type: T(11)}],
    }),
    script = await p.node({outputs: [{id: 'o', name: 'o', type: T(21)}], inputs: [{id: 'i', name: 'i', type: T(21)}]}),
    number = await p.node({outputs: [{id: 'o', name: 'o', type: T(12)}], inputs: [{id: 'i', name: 'i', type: T(12)}]});
  await p.connect(text.id, 'o', script.id, 'i'); // Text into Script
  const text2 = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]});
  await p.connect(script.id, 'o', text2.id, 'i'); // Script into Text
  await rejects(p.connect(number.id, 'o', script.id, 'i'), /incompatible/);
  await rejects(p.connect(script.id, 'o', number.id, 'i'), /incompatible/);
  // Its own label and control; with no control of its own it is typed in like its target.
  const result = app.context.eval
    ? app.context.eval('0')
    : require('node:vm').runInContext(
        `(() => { const t = new TypeTable([${JSON.stringify({...TEXT, control: 'textarea'})}, ${JSON.stringify({...SCRIPT, control: undefined})}, ${JSON.stringify({id: hex(22), name: 'Code', fields: [], alias: T(21), control: 'code'})}]);
          return JSON.stringify([t.label('${T(21)}'), t.control('${T(21)}'), t.control('${T(22)}'), compatible('${T(22)}', '${T(11)}', t)]) })()`,
        app.context
      );
  assert.deepEqual(JSON.parse(result), ['Script', {control: 'textarea'}, {control: 'code'}, true]);
  // The default of an input typed as code is text; a number is not.
  await p.node({inputs: [{id: 'i', name: 'i', type: T(21), default: 'return 1;'}]});
  await rejects(p.node({inputs: [{id: 'i', name: 'i', type: T(21), default: 5}]}), /value its type can hold/);
});

test('an alias is checked: it has no fields, stands for a type of the document and never for itself', async () => {
  const app = createApp(),
    p = await project(app);
  await rejects(p.types([...base(), {...SCRIPT, fields: [{name: 'x', type: T(11)}]}]), /alias/);
  await rejects(p.types([...base(), {...SCRIPT, alias: 'text'}]), /alias/);
  await rejects(p.types([...base(), {...SCRIPT, alias: T(77)}]), /unknown type/);
  await rejects(p.types([{...SCRIPT, alias: T(21)}]), /contains itself/);
  await rejects(
    p.types([
      {...SCRIPT, alias: T(22)},
      {...SCRIPT, id: hex(22), name: 'Other', alias: T(21)},
    ]),
    /contains itself/
  );
  await p.types([...base(), SCRIPT]);
  await rejects(p.types([SCRIPT]), /unknown type/); // the target cannot go while an alias stands for it
  // A copied node brings the target of its alias.
  const n = await p.node({outputs: [{id: 'o', name: 'o', type: T(21)}]});
  const bundle = await app.api('POST', `projects/${p.id}/copy`, {node_ids: [n.id]});
  assert.deepEqual(bundle.types.map(t => t.name).sort(), ['Script', 'Text']);
  const other = await project(app);
  await app.api('POST', `projects/${other.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  const pasted = (await other.snapshot()).types;
  assert.deepEqual(pasted.map(t => t.name).sort(), ['Script', 'Text']);
  assert.equal(pasted.find(t => t.name === 'Script').alias, 't:' + pasted.find(t => t.name === 'Text').id);
});

// ----- one type, once -----

// ----- the Library's types -----
// A Custom Node of the Library is made in an editor; the types its ports use are the Library's from the moment it is saved.
async function openNode(app) {
  const opened = await app.api('POST', 'library/node-editor', {}),
    wf = {workflow_id: opened.workflow_id};
  return {...opened, wf, root: (await app.api('GET', `projects/${opened.project_id}/workflow`, {}, wf)).root};
}
async function defineNode(app, node, types, outputs) {
  const lib = await app.api('GET', `projects/${node.project_id}/workflow`, {}, node.wf);
  await app.api('PUT', `projects/${node.project_id}/types`, {...node.wf, types: [...lib.types, ...types]});
  await app.api('PUT', `projects/${node.project_id}/complex/${lib.root}`, {
    ...node.wf,
    interface: {inputs: [], outputs},
  });
  return node;
}
const libNode = async (app, types, outputs) => defineNode(app, await openNode(app), types, outputs);
const libraryOf = app => app.eval(`DB.get('library_types')`).then(list => JSON.parse(JSON.stringify(list ?? [])));
const out = (name, type) => ({id: name, name, type});

test("the types of Library nodes are every workflow's: nothing is imported, and a workflow stores none of them", async () => {
  const app = createApp(),
    node = await libNode(app, [TEXT, NUMBER, person()], [out('a', T(1))]);
  const a = await project(app),
    b = await project(app);
  for (const p of [a, b]) {
    const types = (await p.snapshot()).types;
    assert.deepEqual(types.map(t => [t.name, t.library]).sort(), [
      ['Number', true],
      ['Person', true],
      ['Text', true],
    ]);
  }
  assert.deepEqual((await app.eval(`DB.get('wf:${a.id}')`))?.types ?? [], []);
  // A type of the workflow's own sits next to them.
  await a.types([...(await a.snapshot()).types, kind(hex(4), 'Mine')]);
  assert.equal(JSON.stringify((await app.eval(`DB.get('wf:${a.id}')`)).types.map(t => t.name)), '["Mine"]');
  assert.ok(node.resource_id);
});

test('a Library type is changed in the node that defines it, for everybody; a workflow cannot change it', async () => {
  const app = createApp(),
    first = await libNode(app, [TEXT], [out('a', T(11))]),
    second = await libNode(app, [], [out('b', T(11))]);
  const p = await project(app);
  await rejects(p.types((await p.snapshot()).types.map(t => ({...t, name: 'Renamed'}))), /Library/);
  const q = `projects/${first.project_id}`;
  const open = (await app.api('GET', `${q}/workflow`, {}, first.wf)).types;
  await app.api('PUT', `${q}/types`, {...first.wf, types: open.map(t => ({...t, name: 'Words', color: '#123456'}))});
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Words']
  );
  assert.equal((await p.snapshot()).types[0].name, 'Words');
  // The other node carries the new definition too.
  const bundle = (await app.api('GET', `resources/${second.resource_id}`)).payload.bundle;
  assert.deepEqual(
    bundle.types.map(t => [t.name, t.color]),
    [['Words', '#123456']]
  );
  // A Library type does not go from a workflow, even by leaving it out of the list.
  await rejects(p.types([]), /Library/);
});

test('a type nobody defines and nobody uses goes by itself; one a workflow uses stays', async () => {
  const app = createApp(),
    node = await libNode(app, [TEXT, NUMBER], [out('a', T(11)), out('n', T(12))]);
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Number', 'Text']
  );
  const p = await project(app);
  const user = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]});
  await app.api('DELETE', `resources/${node.resource_id}`);
  // Number was only the node's; Text is in use.
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Text']
  );
  assert.deepEqual(
    (await p.snapshot()).types.map(t => t.name),
    ['Text']
  );
  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: [user.id]});
  // Text stays until the Library changes next time: nothing else is looking.
  const again = await libNode(app, [kind(hex(30), 'Fresh')], [out('f', T(30))]);
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Fresh']
  );
  assert.ok(again.resource_id);
});

test('two nodes defining the same type share it; the same name with another shape is told apart', async () => {
  const app = createApp(),
    first = await libNode(app, [TEXT, NUMBER], [out('a', T(11)), out('n', T(12))]);
  // A node from elsewhere (an import) defines its own Text, the same, and a Number that is something else.
  const bundle = (await app.api('GET', `resources/${first.resource_id}`)).payload.bundle,
    foreign = JSON.parse(JSON.stringify(bundle).split(hex(11)).join(hex(40)).split(hex(12)).join(hex(41)));
  foreign.types.find(t => t.id === hex(41)).fields = [{name: 'x', type: 'any'}];
  foreign.types.find(t => t.id === hex(41)).control = undefined;
  const imported = await app.api('POST', 'resources', {name: 'Imported', payload: {bundle: foreign, description: ''}});
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Number', 'Number (2)', 'Text']
  );
  const kept = (await app.api('GET', `resources/${imported.id}`)).payload.bundle;
  assert.ok(
    kept.types.some(t => t.id === hex(11)),
    'the twin Text is the first Text'
  );
  assert.ok(kept.types.every(t => t.id !== hex(40)));
  assert.deepEqual(kept.types.map(t => t.name).sort(), ['Number (2)', 'Text']);
});

test('a type of the workflow that means the same as a Library type is that type', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([
    {id: hex(7), name: 'Flag', fields: [], control: 'checkbox'},
    {id: hex(8), name: 'Other', fields: []},
  ]);
  const node = await p.node({outputs: [{id: 'o', name: 'o', type: T(7), editable: true, default: true}]});
  // A node of the Library gets a Flag of its own (another ID): the workflow's becomes it, and the node follows.
  await libNode(app, [{id: hex(50), name: 'Flag', fields: [], control: 'checkbox'}], [out('f', T(50))]);
  const snap = await p.snapshot();
  assert.deepEqual(
    snap.types.map(t => [t.name, !!t.library]),
    [
      ['Flag', true],
      ['Other', false],
    ]
  );
  assert.equal(snap.nodes.find(n => n.id === node.id).config.outputs[0].type, T(50));
  assert.equal(JSON.stringify((await app.eval(`DB.get('wf:${p.id}')`)).types.map(t => t.name)), '["Other"]');
});

test("a Library node carries the definitions of its types: where the Library has a type it is the Library's, else it comes along as the workflow's own", async () => {
  const app = createApp(),
    node = await libNode(app, [TEXT, kind(hex(6), 'Mood')], [out('a', T(11)), out('b', T(6))]);
  const bundle = (await app.api('GET', `resources/${node.resource_id}`)).payload.bundle;
  assert.deepEqual(bundle.types.map(t => t.name).sort(), ['Mood', 'Text'], 'the node stands alone');
  assert.ok(bundle.types.every(t => !('library' in t)));
  const p = await project(app);
  await app.api('POST', `projects/${p.id}/custom-nodes/${node.resource_id}`, {point: {x: 0, y: 0}});
  assert.deepEqual((await p.snapshot()).types.map(t => [t.name, !!t.library]).sort(), [
    ['Mood', true],
    ['Text', true],
  ]);
  // Another installation has no such types: the node brings them along as the workflow's own.
  const other = createApp(),
    q = await project(other),
    pasted = await other.api('POST', `projects/${q.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  assert.ok(pasted);
  assert.deepEqual((await q.snapshot()).types.map(t => [t.name, !!t.library]).sort(), [
    ['Mood', false],
    ['Text', false],
  ]);
});
