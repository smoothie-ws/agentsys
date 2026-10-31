'use strict';
// The one node that runs code: a Script. Its inputs are variables, what it sets in `output` is its result, an on_run node starts the chain.
// Run with:  node --test
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

async function setup(app) {
  const {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const make = config =>
    app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}});
  const wire = (from, fromPort, to, toPort) =>
    app.api('POST', `projects/${id}/port-connections`, {
      ...q,
      add: [{source: from, source_port: fromPort, target: to, target_port: toPort}],
    });
  return {id, q, make, wire};
}

test('Script: the inputs of its Library node are variables next to display, what it sets in output.<name> is the result (inline and worker)', async () => {
  for (const mode of ['inline', 'worker']) {
    const app = createApp({scripts: mode}),
      s = await setup(app);
    const script = await fn(app, s.id, s.q, {
        code: 'node.display("hi"); node.output.result = n * 2',
        inputs: ['n'],
        outputs: ['result'],
        signals: ['out'],
      }),
      twentyOne = await s.make(nodes.value('number', 21)),
      shown = await fn(app, s.id, s.q, {code: 'node.display(String(v))', inputs: ['v']});
    await s.wire(twentyOne.id, 'value', script.wrapper, 'n');
    await s.wire(script.wrapper, 'result', shown.wrapper, 'v');
    const start = await flow(app, s.id, s.q, [script.step, shown.step]);
    const r = await app.api('POST', `projects/${s.id}/evaluate-node`, {...s.q, node_ids: [start], collect: true});
    assert.deepEqual(r.errors, {}, mode);
    assert.equal(r.displays[shown.id], '42', mode);
    assert.equal(r.displays[script.id], 'hi', mode);
  }
});

test('on_run: Run fires it, and a Script after it sees the payload of the trigger', async () => {
  const app = createApp(),
    s = await setup(app);
  const script = await fn(app, s.id, s.q, {code: 'node.display(context.event.payload.n * 2)'});
  await flow(app, s.id, s.q, [script.step]);
  const r = await app.api('POST', `projects/${s.id}/execution`, {...s.q, wait: true, payload: {n: 21}});
  assert.equal(r.status, 'idle', JSON.stringify(r.errors));
  assert.equal(r.displays[script.id], '42');
});

test('Script and Event are added as they are (no Library): an Event has no inputs, its event is chosen on it', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const script = await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'script', point: {x: 0, y: 0}}),
    again = await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'script', point: {x: 0, y: 80}}),
    event = await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'event', point: {x: 0, y: 160}});
  const get = () => app.api('GET', `projects/${id}/workflow`, {}, q);
  const snap = await get();
  const find = nid => snap.nodes.find(n => n.id === nid);
  assert.equal(find(script.id).config.op, 'script');
  assert.deepEqual(
    find(script.id).config.outputs,
    [{id: 'out', name: 'out', type: 'signal'}],
    'Script always has a completion signal'
  );
  assert.equal(snap.types.filter(t => t.name === 'script').length, 1, 'the code type is made once');
  assert.deepEqual(find(event.id).config.inputs, []);
  assert.deepEqual(
    find(event.id).config.outputs.map(p => p.type),
    ['signal']
  );
  assert.equal(find(event.id).config.op, 'on_run');
  await app.api('PUT', `projects/${id}/primitives/${event.id}/event`, {...q, event: 'on_read'});
  const after = await get();
  assert.equal(after.nodes.find(n => n.id === event.id).config.op, 'on_read');
  await assert.rejects(app.api('PUT', `projects/${id}/primitives/${event.id}/event`, {...q, event: 'script'}));
  await assert.rejects(app.api('PUT', `projects/${id}/primitives/${script.id}/event`, {...q, event: 'on_run'}));
  assert.ok(again.id);
});

test('an editable output of a Complex Node (a Library node that is only a frame, like Bool) is read as what is typed there', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const bundle = (outputs, types) => ({
    version: 3,
    source_project: 'lib-x',
    types,
    records: [],
    positions: {},
    port_edges: [],
    widgets: {},
    styles: {},
    groups: [
      {
        id: 'g1',
        name: 'V',
        parent: null,
        members: [],
        color: null,
        pinned: false,
        folded: false,
        disabled: false,
        position: {x: 0, y: 0},
      },
    ],
    complex: [
      {
        id: 'g1',
        interface: {inputs: [], outputs},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
        arbitrary: {inputs: false, outputs: false},
      },
    ],
  });
  const T = 'd1714f2eec0f4bcfa0edc8602f7f67c2';
  const types = [{id: T, name: 'bool', color: '#d666c2', fields: [], control: 'checkbox'}];
  const read = async (output, expected) => {
    const lib = await app.api('POST', 'resources', {
      name: 'V' + Math.random(),
      payload: {bundle: bundle([output], types), description: ''},
    });
    const placed = await app.api('POST', `projects/${id}/custom-nodes/${lib.id}`, {...q, point: {x: 0, y: 0}});
    const snap = await app.api('GET', `projects/${id}/workflow`, {}, q);
    const complexId = 'complex:' + placed.roots[0],
      port = snap.complex.find(c => c.id === placed.roots[0]).interface.outputs[0].id;
    const script = await fn(app, id, q, {code: 'node.display(String(input))', inputs: ['input']});
    await app.api('POST', `projects/${id}/port-connections`, {
      ...q,
      add: [{source: complexId, source_port: port, target: script.wrapper, target_port: 'input'}],
    });
    const start = await flow(app, id, q, [script.step]);
    const r = await app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: [start], collect: true});
    assert.deepEqual(r.errors, {});
    assert.equal(r.displays[script.id], String(expected));
  };
  await read({id: 'p1', name: 'bool', type: 't:' + T, editable: true, default: true}, true);
  await read({id: 'p2', name: 'bool', type: 't:' + T, editable: true}, false);
});

test('a placed Library node that was saved again is brought up to date once: reading does not give its nodes new IDs every time', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const bundle = code => ({
    version: 3,
    source_project: 'lib-x',
    types: [],
    port_edges: [],
    widgets: {},
    positions: {r1: {x: 0, y: 0}},
    styles: {},
    records: [
      {
        id: 'r1',
        payload: {
          kind: 'function',
          node_type: 'custom',
          config: {title: 'S' + code, inputs: [], outputs: [{id: 'result', name: 'result'}]},
          label: 'Custom',
          status: 'ready',
        },
      },
    ],
    groups: [
      {id: 'g1', name: 'V', parent: null, members: ['r1'], color: null, pinned: false, folded: false, disabled: false},
    ],
    complex: [
      {
        id: 'g1',
        interface: {inputs: [], outputs: []},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
        arbitrary: {inputs: false, outputs: false},
      },
    ],
  });
  const lib = await app.api('POST', 'resources', {name: 'V', payload: {bundle: bundle(1), description: ''}});
  await app.api('POST', `projects/${id}/custom-nodes/${lib.id}`, {...q, point: {x: 0, y: 0}});
  await app.api('PUT', `resources/${lib.id}`, {name: 'V', payload: {bundle: bundle(2), description: ''}});
  const ids = async () =>
    (await app.api('GET', `projects/${id}/workflow`, {}, q)).nodes
      .map(n => n.id)
      .sort()
      .join();
  const first = await ids();
  assert.equal(await ids(), first);
});

test('a Script keeps a signal input: it is what starts it', async () => {
  const app = createApp(),
    s = await setup(app);
  await assert.rejects(
    s.make({title: 'S', op: 'script', inputs: [], outputs: [{id: 'result', name: 'result'}]}),
    /signal input/
  );
});

test('the types of a Script are the same in every workflow, so a Library node made from a Script brings no second copy', async () => {
  const app = createApp(),
    typesOf = async () => {
      const {id} = await app.api('POST', 'projects', {name: 'P'}),
        q = {workflow_id: id};
      await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'script', point: {x: 0, y: 0}});
      return (await app.api('GET', `projects/${id}/workflow`, {}, q)).types.map(t => t.id).sort();
    };
  assert.deepEqual(await typesOf(), await typesOf());
});

test('two Library nodes that each define the same type (Text and Preview both have "text") share one type in a workflow', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const make = async (name, T, port) => {
    const bundle = {
      version: 3,
      source_project: 'lib-' + name,
      types: [{id: T, name: 'text', fields: [], control: 'textarea'}],
      port_edges: [],
      widgets: {},
      positions: {},
      styles: {},
      records: [],
      groups: [
        {
          id: 'g1',
          name,
          parent: null,
          members: [],
          color: null,
          pinned: false,
          folded: false,
          disabled: false,
          position: {x: 0, y: 0},
        },
      ],
      complex: [
        {
          id: 'g1',
          interface: {inputs: [], outputs: [{id: 'p', name: port, type: 't:' + T, editable: true}]},
          collapsed: false,
          compact_width: 240,
          compact_height: 90,
          arbitrary: {inputs: false, outputs: false},
        },
      ],
    };
    const lib = await app.api('POST', 'resources', {name, payload: {bundle, description: ''}});
    return app.api('POST', `projects/${id}/custom-nodes/${lib.id}`, {...q, point: {x: 0, y: 0}});
  };
  await make('A', '1'.repeat(32), 'a');
  await make('B', '2'.repeat(32), 'b');
  const snap = await app.api('GET', `projects/${id}/workflow`, {}, q);
  assert.deepEqual(
    snap.types.map(t => t.name),
    ['text'],
    'one “text”, no “text (2)”'
  );
  const ports = snap.complex.flatMap(c => c.interface.outputs.map(p => p.type));
  assert.deepEqual([...new Set(ports)], ['t:' + snap.types[0].id], 'both nodes use it');
  const again = await app.api('GET', `projects/${id}/workflow`, {}, q);
  assert.deepEqual(
    again.types.map(t => t.id),
    snap.types.map(t => t.id),
    'and it stays so'
  );
});

test('what a Script returns is not used: only output.<name> of an output its Library node has, and any other name is an error', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const noOut = await fn(app, id, q, {
      code: 'node.output.result = 1; return 2;',
      outputs: ['result'],
      signals: ['out'],
    }),
    typo = await fn(app, id, q, {code: 'node.output.other = 3;', outputs: ['result']});
  const run = node => app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: [node], collect: true});
  const r = await run(noOut.id);
  assert.deepEqual(r.outputs[noOut.id], {result: 1}, 'the return value is not used');
  assert.match(
    (await run(typo.id)).errors[typo.id],
    /no free output “other”/,
    'a name the node has no output of is an error'
  );
});
