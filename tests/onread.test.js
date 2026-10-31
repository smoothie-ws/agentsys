'use strict';
// on_read: a Library node's copy that contains an on_read computes its outputs when they are read (the first read), keeps them, and
// computes them again only when something it reads has changed. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

/** A Library node "name" with data inputs `ins` and one data output `out`: on_read → a Script that runs `code` (it logs "name" when it runs). */
const calc = (name, code, ins = ['x']) =>
  bundleOf(
    name,
    {
      Body: {inputs: [], outputs: []},
      R: nodes.event('on_read'),
      S: nodes.script(`const {${ins.join(', ')}} = node.input; globalThis.log.push(${JSON.stringify(name)}); ${code}`),
    },
    {
      wires: [['R', 'out', 'S', 'in']],
      inputs: ins.map(n => ({id: n, name: n, node: false})),
      outputs: [{id: 'out', name: 'result', node: false}],
    }
  );

test('changing shared JSON state invalidates cached on_read values', async () => {
  const p = await setup();
  const copy = await p.put(calc('Context', 'node.output.result = context.state.count ?? 0', []));
  const reader = await p.fn({code: 'node.display(node.input.v)', inputs: ['v']});
  const writer = await p.fn({code: 'context.state.count = 42'});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  const before = await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [reader.id], wait: true});
  assert.equal(before.displays[reader.id], '0');
  await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [writer.id], wait: true});
  const after = await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [reader.id], wait: true});
  assert.equal(after.displays[reader.id], '42');
});

test('a data read joins signals emitted without await by its on_read handler', async () => {
  const p = await setup();
  const copy = await p.put(
    bundleOf(
      'Async read',
      {
        E: nodes.event('on_read'),
        S: nodes.script('node.output.result=42;node.output.body.emit();'),
      },
      {
        wires: [['E', 'out', 'S', 'in']],
        outputs: [
          {id: 'result', name: 'result', node: false},
          {id: 'body', name: 'body', type: 'signal', node: false},
        ],
      }
    )
  );
  const branch = await p.fn({code: 'await node.sleep(20);context.state.finished=true;'});
  const reader = await p.fn({code: 'node.display([node.input.value,context.state.finished]);', inputs: ['value']});
  await p.wire(copy, 'body', branch.wrapper, 'in');
  await p.wire(copy, 'result', reader.wrapper, 'value');
  const result = await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [reader.id], wait: true});
  assert.equal(result.displays[reader.id], '[\n  42,\n  true\n]');
});

async function setup() {
  const app = createApp();
  app.context.log = [];
  const {id} = await app.api('POST', 'projects', {name: 'P'});
  const p = {
    app,
    id,
    fn: opts => fn(app, id, {}, opts),
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}}),
    wire: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    put: async def => (await place(app, id, {}, def)).id,
    log: () => JSON.parse(JSON.stringify(app.context.log)),
    /** Runs the signal chain `steps` from an on_run and answers the result of the run. */
    run: async (...steps) =>
      app.api('POST', `projects/${id}/evaluate-node`, {node_ids: [await flow(app, id, {}, steps)], collect: true}),
  };
  return p;
}

test('the first read computes the copy; later reads give the same value without computing again', async () => {
  const p = await setup();
  const three = await p.node(nodes.value('number', 3));
  const copy = await p.put(calc('Times ten', 'node.output.result = x * 10'));
  await p.wire(three.id, 'value', copy, 'x');
  assert.deepEqual(p.log(), [], 'nothing runs before somebody reads');
  const reader = await p.fn({
    code: 'const a = node.input.v; const b = node.input.v; node.output.result = [a, b]',
    inputs: ['v'],
    outputs: ['result'],
  });
  await p.wire(copy, 'out', reader.wrapper, 'v');
  const r = await p.run(reader.step);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(p.log(), ['Times ten'], 'computed once for the reads');
  assert.deepEqual(
    (await p.app.api('POST', `projects/${p.id}/evaluate-node`, {node_ids: [reader.id], collect: true})).outputs[
      reader.id
    ],
    {result: [30, 30]}
  );
});

test('when what the copy reads changes, it is computed again on the next read; when the new value is the same, it is not', async () => {
  const p = await setup();
  const source = await p.fn({
    code: 'node.output.result = 1; await node.output.out.emit(); node.output.result = 2; await node.output.out.emit(); node.output.result = 2',
    outputs: ['result'],
    signals: ['out'],
  });
  const copy = await p.put(calc('Double', 'node.output.result = x * 2'));
  await p.wire(source.wrapper, 'result', copy, 'x');
  const reader = await p.fn({code: 'globalThis.log.push("saw " + node.input.v)', inputs: ['v']});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  await p.wire(source.wrapper, 'out', reader.wrapper, 'in');
  const r = await p.run(source.step);
  assert.deepEqual(r.errors, {});
  // The source signals three times (1, 2, 2): the reader runs three times; the copy is computed for 1 and for 2, not for the second 2.
  assert.deepEqual(p.log(), ['Double', 'saw 2', 'Double', 'saw 4', 'saw 4']);
});

test('a copy that reads another copy brings it up to date first: the order follows the data', async () => {
  const p = await setup();
  const source = await p.fn({
    code: 'node.output.result = 5; await node.output.out.emit(); node.output.result = 6',
    outputs: ['result'],
    signals: ['out'],
  });
  const first = await p.put(calc('Plus one', 'node.output.result = x + 1'));
  const second = await p.put(calc('Times two', 'node.output.result = x * 2'));
  await p.wire(source.wrapper, 'result', first, 'x');
  await p.wire(first, 'out', second, 'x');
  const reader = await p.fn({code: 'globalThis.log.push(node.input.v)', inputs: ['v']});
  await p.wire(second, 'out', reader.wrapper, 'v');
  await p.wire(source.wrapper, 'out', reader.wrapper, 'in');
  const r = await p.run(source.step);
  assert.deepEqual(r.errors, {});
  // Computing "Times two" asks for "Plus one" while it runs, so "Times two" starts first; each is computed once per value.
  assert.equal(p.log().filter(x => x === 'Plus one').length, 2);
  assert.equal(p.log().filter(x => x === 'Times two').length, 2);
  assert.deepEqual(
    p.log().filter(x => typeof x === 'number'),
    [12, 14]
  );
});

test('an error in what the on_read starts is thrown to the reader, and stays until something changes', async () => {
  const p = await setup();
  const source = await p.fn({
    code: 'node.output.result = 0; try { await node.output.out.emit(); } catch (e) { globalThis.log.push("error " + e.message); } node.output.result = 1',
    outputs: ['result'],
    signals: ['out'],
  });
  const copy = await p.put(calc('Check', 'if (x === 0) throw new Error("zero"); node.output.result = x'));
  await p.wire(source.wrapper, 'result', copy, 'x');
  const reader = await p.fn({code: 'globalThis.log.push("ok " + node.input.v)', inputs: ['v']});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  await p.wire(source.wrapper, 'out', reader.wrapper, 'in');
  await p.run(source.step);
  assert.deepEqual(
    p.log().filter(x => typeof x === 'string' && x !== 'Check'),
    ['error Node code: zero', 'ok 1']
  );
});

test('a copy without an on_read gives what its nodes last left, as before', async () => {
  const p = await setup();
  const plain = bundleOf(
    'Holder',
    {Body: {inputs: [], outputs: []}, S: nodes.script('node.output.result = 7')},
    {outputs: [{id: 'out', name: 'result', node: false}]}
  );
  const copy = await p.put(plain);
  const reader = await p.fn({code: 'globalThis.log.push(typeof node.input.v)', inputs: ['v']});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  await p.run(reader.step);
  assert.deepEqual(p.log(), ['undefined'], 'nobody ran its Script, so there is nothing to read');
});

test('an input of a Library node is read by every Script inside: one wire feeds them all', async () => {
  const p = await setup();
  const three = await p.node(nodes.value('number', 3));
  const both = bundleOf(
    'Both',
    {
      Body: {inputs: [], outputs: []},
      R: nodes.event('on_read'),
      A: nodes.script('node.output.result = node.input.v * 10'),
      B: nodes.script('globalThis.log.push("B got " + node.input.v)'),
    },
    {
      wires: [
        ['R', 'out', 'A', 'in'],
        ['R', 'out', 'B', 'in'],
      ],
      inputs: [{id: 'v', name: 'v', node: false}],
      outputs: [{id: 'out', name: 'result', node: false}],
    }
  );
  const copy = await p.put(both);
  await p.wire(three.id, 'value', copy, 'v');
  const snap = await p.app.api('GET', `projects/${p.id}/workflow`);
  assert.deepEqual(snap.issues ?? [], []);
  const reader = await p.fn({code: 'node.output.result = node.input.w', inputs: ['w'], outputs: ['result']});
  await p.wire(copy, 'out', reader.wrapper, 'w');
  const r = await p.run(reader.step);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(p.log(), ['B got 3'], 'the second Script got the value too');
  assert.deepEqual(
    (await p.app.api('POST', `projects/${p.id}/evaluate-node`, {node_ids: [reader.id], collect: true})).outputs[
      reader.id
    ],
    {result: 30}
  );
});
