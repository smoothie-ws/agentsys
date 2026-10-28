'use strict';
// The loop and flow-control Library nodes of examples/flow-nodes.json (For, For each, While, Break, Continue, Variable), imported the way the
// Library imports them and run on the real engine. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, fn} = require('./harness');
const entries = require('../js/storage/format').decode(require('../examples/flow-nodes.json'));

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Flow'}),
    q = {workflow_id: id};
  app.context.log = [];
  const p = {
    id,
    q,
    node: config => app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (from, port, to, target = 'in') => app.api('POST', `projects/${id}/port-connections`, {...q, add: [{source: from, source_port: port, target: to, target_port: target}]}),
    /** A node of examples/flow-nodes.json, placed: answers the ID of its Library node. */
    put: async name => {
      const entry = entries.find(e => e.name === name);
      const item = await app.api('POST', 'resources', {kind: 'custom_node', name, payload: {...entry.payload, folder: ''}});
      const placed = await app.api('POST', `projects/${id}/custom-nodes/${item.id}`, {...q, point: {x: 0, y: 0}});
      return 'complex:' + placed.roots[0];
    },
    /** A Library node around a Script that logs; `inputs` are read as variables. */
    log: (code, o = {}) => fn(app, id, q, {code, ...o}),
    run: () => app.api('POST', `projects/${id}/runs`, {...q, wait: 10}),
  };
  p.start = async (...to) => {
    const go = await p.node(nodes.run());
    for (const [target, input = 'in'] of to) await p.connect(go.id, 'out', target, input);
    return go;
  };
  return p;
}
/** A node that holds a value of a type of the Library (the loops bring their types: place one first). */
const LIBRARY_TYPES = {number: 't:fbe54fdd1dd24d55a0ec083cc057017e', bool: 't:d1714f2eec0f4bcfa0edc8602f7f67c2'};
const value = (type, v) => ({title: 'Value', inputs: [], outputs: [{id: 'value', name: 'value', type: LIBRARY_TYPES[type], editable: true, default: v}]});
const logged = app => JSON.parse(JSON.stringify(app.context.log));

test('For runs its body for each number from `from` to `to` (not included), then fires done', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    body = await p.log('globalThis.log.push(i)', {inputs: ['i']}),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(loop, 'body', body.wrapper);
  await p.connect(loop, 'index', body.wrapper, 'i');
  await p.connect(loop, 'done', done.wrapper);
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'completed', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'done'], 'from 0 to 10 by 1 are the defaults');
});

test('Break ends the loop: the rest of the pass does not start, and done fires', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    brk = await p.put('Break'),
    check = await p.log('globalThis.log.push(i); if (i === 3) await node.emit("hit")', {inputs: ['i'], signals: ['hit']}),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(loop, 'body', check.wrapper);
  await p.connect(loop, 'index', check.wrapper, 'i');
  await p.connect(check.wrapper, 'hit', brk);
  await p.connect(loop, 'done', done.wrapper);
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'completed', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app), [0, 1, 2, 3, 'done']);
});

test('Continue ends only the pass', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    next = await p.put('Continue'),
    check = await p.log('await node.emit(i % 2 ? "odd" : "even")', {inputs: ['i'], signals: ['odd', 'even']}),
    rest = await p.log('globalThis.log.push("rest " + i)', {inputs: ['i']});
  await p.connect(loop, 'body', check.wrapper);
  await p.connect(loop, 'index', check.wrapper, 'i');
  await p.connect(check.wrapper, 'odd', next);
  await p.connect(check.wrapper, 'even', rest.wrapper);
  await p.connect(loop, 'index', rest.wrapper, 'i');
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'completed', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app).slice(0, 5), ['rest 0', 'rest 2', 'rest 4', 'rest 6', 'rest 8']);
});

test('For counts down with a negative step; a step of 0 is an error', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    from = await p.node(value('number', 3)),
    to = await p.node(value('number', 0)),
    step = await p.node(value('number', -1)),
    body = await p.log('globalThis.log.push(i)', {inputs: ['i']});
  await p.connect(from.id, 'value', loop, 'from');
  await p.connect(to.id, 'value', loop, 'to');
  await p.connect(step.id, 'value', loop, 'step');
  await p.connect(loop, 'body', body.wrapper);
  await p.connect(loop, 'index', body.wrapper, 'i');
  await p.start([loop]);
  assert.equal((await p.run()).status, 'completed');
  assert.deepEqual(logged(app), [3, 2, 1]);
  const other = createApp(),
    zero = await project(other),
    again = await zero.put('For'),
    none = await zero.node(value('number', 0));
  await zero.connect(none.id, 'value', again, 'step');
  await zero.start([again]);
  const run = await zero.run();
  assert.equal(run.status, 'failed');
  assert.match(JSON.stringify(run.errors), /step cannot be 0/);
});

test('For each runs its body for every element of the list', async () => {
  const app = createApp(),
    p = await project(app);
  const each = await p.put('For each'),
    src = await p.log('node.output.list = ["a", "b", "c"]; await node.emit("out")', {outputs: ['list'], signals: ['out']}),
    body = await p.log('globalThis.log.push(index + ":" + item)', {inputs: ['item', 'index']}),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(src.wrapper, 'list', each, 'list');
  await p.connect(src.wrapper, 'out', each);
  await p.connect(each, 'body', body.wrapper);
  await p.connect(each, 'item', body.wrapper, 'item');
  await p.connect(each, 'index', body.wrapper, 'index');
  await p.connect(each, 'done', done.wrapper);
  await p.start([src.wrapper]);
  const run = await p.run();
  assert.equal(run.status, 'completed', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app), ['0:a', '1:b', '2:c', 'done']);
});

test('While reads its condition again before every pass; Variable holds what the body changes', async () => {
  const app = createApp(),
    p = await project(app);
  app.context.n = 0;
  const loop = await p.put('While'),
    variable = await p.put('Variable'),
    // `step` counts and stores whether to go on; it runs first (to start the variable) and then in every pass.
    step = await p.log('globalThis.n++; globalThis.log.push("step " + globalThis.n); node.output.go = globalThis.n <= 3; await node.emit("out")', {outputs: ['go'], signals: ['out']}),
    starter = await p.log('await node.emit("first"); await node.emit("second")', {signals: ['first', 'second']}),
    body = await p.log('globalThis.log.push("body")'),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(starter.wrapper, 'first', step.wrapper);
  await p.connect(starter.wrapper, 'second', loop);
  await p.connect(step.wrapper, 'out', variable);
  await p.connect(step.wrapper, 'go', variable, 'to');
  await p.connect(variable, 'value', loop, 'condition');
  await p.connect(loop, 'body', body.wrapper);
  await p.connect(loop, 'body', step.wrapper);
  await p.connect(loop, 'done', done.wrapper);
  await p.start([starter.wrapper]);
  const run = await p.run();
  assert.equal(run.status, 'completed', JSON.stringify([run.error, run.errors]));
  assert.equal(logged(app).filter(l => l === 'body').length, 3);
  assert.equal(logged(app).at(-1), 'done');
});

test('While stops a loop that never ends: more than `max` passes is an error', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('While'),
    yes = await p.node(value('bool', true)),
    max = await p.node(value('number', 3)),
    body = await p.log('globalThis.log.push("pass")');
  await p.connect(yes.id, 'value', loop, 'condition');
  await p.connect(max.id, 'value', loop, 'max');
  await p.connect(loop, 'body', body.wrapper);
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'failed');
  assert.match(JSON.stringify(run.errors), /While: more than 3 passes/);
  assert.equal(logged(app).length, 3);
});

test('Break and Continue outside a loop are errors', async () => {
  const app = createApp(),
    p = await project(app);
  const brk = await p.put('Break');
  await p.start([brk]);
  const run = await p.run();
  assert.equal(run.status, 'failed');
  assert.match(JSON.stringify(run.errors), /outside a loop/);
});
