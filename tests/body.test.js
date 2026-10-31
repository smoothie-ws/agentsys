'use strict';
// A Library node is a group of visible nodes. A slot of the group is bound to a port of a node inside, or it is free: then a Script of
// the group reads it by name (`node.input`). A placed node can get free slots of its own. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, bundleOf, place, ref, fn, TYPES} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

/** The code of a Script that collects the values of the inputs of its Library node into a list (the free output `name`). */
const collectTo = name =>
  `const list = []; for (const v of Object.values(node.input)) if (v !== undefined) list.push(v); node.output[${JSON.stringify(name)}] = list;`;

async function library(app) {
  const opened = await app.api('POST', 'library/node-editor', {});
  const q = {workflow_id: opened.workflow_id},
    id = opened.project_id;
  const snapshot = () => app.api('GET', `projects/${id}/workflow`, {}, q);
  const root = (await snapshot()).root;
  return {
    resource: opened.resource_id,
    id,
    root,
    snapshot,
    save: body => app.api('PUT', `projects/${id}/complex/${root}`, {...q, ...body}),
    /** Puts a Script that collects the inputs of the node into a list, started by an on_read, and makes it the output `out`. */
    collect: async () => {
      const have = (await app.api('GET', `projects/${id}/types`, {}, q)).types;
      await app.api('PUT', `projects/${id}/types`, {
        ...q,
        types: [...have, ...[TYPES.code].filter(t => !have.some(h => h.id === t.id))],
      });
      const reader = await app.api('POST', `projects/${id}/typed-nodes`, {
          ...q,
          node_type: 'custom',
          config: nodes.event('on_read'),
          position: {x: 0, y: 0},
        }),
        script = await app.api('POST', `projects/${id}/typed-nodes`, {
          ...q,
          node_type: 'custom',
          config: nodes.script(collectTo('result')),
          position: {x: 300, y: 0},
        });
      await app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: reader.id, source_port: 'out', target: script.id, target_port: 'in'}],
      });
      const cx = (await snapshot()).complex.find(c => c.id === root);
      await app.api('PUT', `projects/${id}/complex/${root}`, {
        ...q,
        interface: {inputs: cx.interface.inputs, outputs: [{id: 'out', name: 'result'}]},
      });
    },
  };
}
async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'P'});
  const q = {workflow_id: id};
  return {
    id,
    snapshot: () => app.api('GET', `projects/${id}/workflow`, {}, q),
    place: async resource =>
      (await app.api('POST', `projects/${id}/custom-nodes/${resource}`, {...q, point: {x: 0, y: 0}})).roots[0],
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    extra: (group, extra) => app.api('PUT', `projects/${id}/complex/${group}`, {...q, extra}),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: ids, collect: true}),
  };
}

test('a new Library node is an empty group; its slots are free until they are bound to a node inside', async () => {
  const app = createApp(),
    lib = await library(app);
  assert.deepEqual((await lib.snapshot()).nodes, [], 'there is nothing hidden in it');
  await lib.save({
    interface: {
      inputs: [
        {id: 'a', name: 'a'},
        {id: 'b', name: 'b'},
      ],
      outputs: [{id: 'sum', name: 'sum'}],
    },
  });
  let cx = (await lib.snapshot()).complex.find(c => c.id === lib.root);
  assert.deepEqual(
    cx.interface.inputs.map(p => [p.name, 'bound' in p]),
    [
      ['a', false],
      ['b', false],
    ]
  );
  assert.deepEqual((await lib.snapshot()).nodes, []);
  // A slot is bound to a port of a node inside; removing a slot leaves the others alone.
  const inner = await app.api('POST', `projects/${lib.id}/typed-nodes`, {
    workflow_id: lib.id,
    node_type: 'custom',
    config: {title: 'Inner', inputs: [{id: 'v', name: 'v'}], outputs: [{id: 'result', name: 'result'}]},
    position: {x: 40, y: 80},
  });
  await lib.save({
    interface: {
      inputs: [{id: 'a', name: 'a', bound: [{node_id: inner.id, port_id: 'v'}]}],
      outputs: cx.interface.outputs,
    },
  });
  cx = (await lib.snapshot()).complex.find(c => c.id === lib.root);
  assert.deepEqual(
    cx.interface.inputs.map(p => [p.name, p.bound?.[0].node_id === inner.id]),
    [['a', true]]
  );
  assert.deepEqual(
    cx.interface.outputs.map(p => p.name),
    ['sum']
  );
});

test('a placed Custom Node can get slots of its own, which a Script of the node (here: one that lists its inputs) reads by name', async () => {
  const app = createApp(),
    lib = await library(app);
  await lib.save({
    interface: {inputs: [{id: 'a', name: 'a'}], outputs: [{id: 'out', name: 'result'}]},
    arbitrary: {inputs: true, outputs: false},
  });
  await lib.collect();
  const p = await project(app),
    gid = await p.place(lib.resource);
  const five = await p.node(nodes.value('number', 5)),
    show = await fn(
      app,
      p.id,
      {workflow_id: p.id},
      {code: 'node.display(JSON.stringify(input, null, 2))', inputs: ['input']}
    );
  await p.connect(five.id, 'value', 'complex:' + gid, 'a');
  await p.connect('complex:' + gid, 'out', show.wrapper, 'input');
  assert.equal((await p.evaluate([show.id])).displays[show.id], JSON.stringify([5], null, 2));
  // Its own slots: new ones can be added and removed, the ones of the definition cannot be touched.
  await p.extra(gid, {inputs: [{id: 'x1', name: 'extra'}]});
  let cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(
    cx.interface.inputs.map(p => [p.name, !!p.extra]),
    [
      ['a', false],
      ['extra', true],
    ]
  );
  const ten = await p.node(nodes.value('number', 10));
  await p.connect(ten.id, 'value', 'complex:' + gid, 'x1');
  assert.equal((await p.evaluate([show.id])).displays[show.id], JSON.stringify([5, 10], null, 2));
  await rejects(p.extra(gid, {inputs: [{id: 'a', name: 'other'}]}), /another ID/);
  await rejects(p.extra(gid, {inputs: [{id: 'y', name: 'a'}]}), /unique/);
  await rejects(
    app.api('PUT', `projects/${p.id}/complex/${gid}`, {workflow_id: p.id, interface: {inputs: [], outputs: []}}),
    /Library/
  );
  // Editing the definition in the Library keeps the wires and the slots of the copy.
  await lib.save({arbitrary: {inputs: true, outputs: true}});
  cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(
    cx.interface.inputs.map(p => p.name),
    ['a', 'extra']
  );
  assert.equal((await p.evaluate([show.id])).displays[show.id], JSON.stringify([5, 10], null, 2));
  // Removing the slot again.
  await p.extra(gid, {inputs: []});
  cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(
    cx.interface.inputs.map(p => p.name),
    ['a']
  );
});

test('Slots of its own are set by a Script or the API whatever Arbitrary says; Arbitrary only records what the panel offers', async () => {
  const app = createApp(),
    lib = await library(app);
  await lib.save({
    interface: {inputs: [{id: 'a', name: 'a'}], outputs: [{id: 'out', name: 'result'}]},
    arbitrary: {inputs: true, outputs: false},
  });
  const p = await project(app),
    gid = await p.place(lib.resource);
  await p.extra(gid, {inputs: [{id: 'x1', name: 'more'}]});
  await p.extra(gid, {outputs: [{id: 'o2', name: 'other'}]});
  const cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(cx.arbitrary, {inputs: true, outputs: false});
});

/** The List node as the Library has it: on_read → a Script that collects its inputs, and on_input_connected → a Script that keeps one free input at the end. */
const listNode = () =>
  bundleOf(
    'List',
    {
      Body: nodes.script(collectTo('list')),
      on_read: nodes.event('on_read'),
      on_input_connected: nodes.event('on_input_connected', ['wired']),
      Slots: nodes.script(
        `await agentsys('PUT', 'projects/' + context.project_id + '/node-slots/' + context.instance_id, {inputs: Array.from({length: context.event.connected.length}, (_, i) => ({id: 'input' + (i + 2), name: 'input' + (i + 2)}))})`
      ),
    },
    {
      wires: [
        ['on_read', 'out', 'Body', 'in'],
        ['on_input_connected', 'out', 'Slots', 'in'],
      ],
      inputs: [{id: 'input1', name: 'input1', node: false}],
      outputs: [{id: 'list', name: 'list', node: false}],
    }
  );

test('on_input_connected fires for a placed node when its wires change: a Script keeps one free input at the end', async () => {
  const app = createApp(),
    p = await project(app);
  const list = await place(app, p.id, {workflow_id: p.id}, listNode()),
    target = list.id,
    gid = list.group;
  const names = async () => (await p.snapshot()).complex.find(c => c.id === gid).interface.inputs.map(s => s.name);
  const wire = async (n, port, add = true) => {
    await app.api('POST', `projects/${p.id}/port-connections`, {
      workflow_id: p.id,
      [add ? 'add' : 'remove']: [{source: n.id, source_port: 'value', target, target_port: port}],
    });
    await app.Backend.hooksIdle();
  };
  assert.deepEqual(await names(), ['input1']);
  const a = await p.node(nodes.value('text', 'one')),
    b = await p.node(nodes.value('text', 'two'));
  await wire(a, 'input1');
  assert.deepEqual(await names(), ['input1', 'input2']);
  await wire(b, 'input2');
  assert.deepEqual(await names(), ['input1', 'input2', 'input3']);
  await wire(b, 'input2', false);
  assert.deepEqual(await names(), ['input1', 'input2']);
  await wire(b, 'input2');
  const show = await fn(
    app,
    p.id,
    {workflow_id: p.id},
    {code: 'node.display(JSON.stringify(input, null, 2))', inputs: ['input']}
  );
  await app.api('POST', `projects/${p.id}/port-connections`, {
    workflow_id: p.id,
    add: [{source: target, source_port: 'list', target: show.wrapper, target_port: 'input'}],
  });
  const r = await p.evaluate([show.id]);
  assert.equal(r.displays[show.id], JSON.stringify(['one', 'two'], null, 2));
});

test('any node on a workflow can be renamed, and a placed Library node keeps its name when its definition changes', async () => {
  const app = createApp(),
    lib = await library(app);
  await lib.save({interface: {inputs: [], outputs: []}});
  const p = await project(app),
    gid = await p.place(lib.resource);
  const rename = (node_id, title) => app.api('PUT', `projects/${p.id}/node-title`, {workflow_id: p.id, node_id, title});
  const custom = await p.node({title: 'Before', inputs: [], outputs: []});
  await rename(custom.id, '  After ');
  assert.equal((await p.snapshot()).nodes.find(n => n.id === custom.id).config.title, 'After');
  await rejects(rename(custom.id, ''), /1 to 100/);
  await rejects(rename('record:' + '0'.repeat(32), 'x'), /not found/);
  const groups = (await p.snapshot()).groups.map(g => ({
    id: g.id,
    name: g.id === gid ? 'Mine' : g.name,
    members: g.members,
    parent: g.parent,
    position: g.position,
  }));
  await app.api('PUT', `projects/${p.id}/groups`, {workflow_id: p.id, groups});
  assert.equal((await p.snapshot()).groups.find(g => g.id === gid).name, 'Mine');
  await lib.save({arbitrary: {inputs: true, outputs: false}});
  assert.equal((await p.snapshot()).groups.find(g => g.id === gid).name, 'Mine');
});
