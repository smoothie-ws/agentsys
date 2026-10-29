'use strict';
// The graph engine itself: compilePlan and runPlanned/evaluateGraph (js/model/evaluate.js), executePlan (js/model/executor.js) and how a
// run is started (js/backend/scripts.js). Signals and data, pure nodes, fan-out, emit and loops, errors, cycles, the chain limit, time
// and size limits, values that are copies, runs staying apart. The model is in docs/engine.md. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

const signal = (id, name) => ({id, name, type: 'signal'});
const port = id => ({id, name: id});
/**
 * A stored document. Nodes: `{id, code, inputs, outs}` is a Script inside a Library node (a placed copy `complex:g_<id>`) that has the signal
 * input In (bound to the Script), the free data inputs `inputs`, the free data output `result` and the free signal outputs Out and `outs`;
 * the code is run by the Script and an `await node.emit("out")` is added at the end of a code that has no emit, so that a list of nodes can be a
 * chain (`bare: true` leaves the code as it is). `{id, op: 'on_run'}` is an event node, `{id, value}` a node that holds `value` on its
 * output `result`. Wires: `['a', 'b']` signal Out of a to In of b; `['a', 'b', 'x']` data result of a to input x of b;
 * `['a', 'b', 'x', 'port']` from another output; `['a', 'b', 'in', 'Done']` a signal from another output. A Script is a root by its id.
 */
const docOf = (list, wires) => {
  const scripts = new Set(list.filter(n => (n.op ?? (n.value === undefined ? 'script' : undefined)) === 'script').map(n => n.id));
  const end = id => (scripts.has(id) ? 'complex:g_' + id : id);
  const doc = {
    cursor: 0,
    nodes: list.map(({id, op, code: body, bare, value, inputs = []}) => {
      const code = body !== undefined && inputs.length ? `const {${inputs.join(', ')}} = node.input;\n${body}` : body;
      op ??= value === undefined ? 'script' : undefined;
      const config =
        op === 'script'
          ? {title: id, op, inputs: [signal('in', 'in'), {id: 'script', name: 'script', default: bare || (code ?? '').includes('node.emit(') ? (code ?? '') : (code ?? '') + '\nawait node.emit("out");'}], outputs: []}
          : op?.startsWith('on_')
            ? {title: id, op, inputs: [], outputs: [signal('out', 'out'), port('payload')]}
            : {title: id, inputs: [], outputs: [{id: 'result', name: 'result', default: value}]};
      return {id, kind: 'function', node_type: 'custom', label: 'Custom', config};
    }),
    layout: {},
    style: Object.fromEntries(list.filter(n => n.disabled).map(n => [n.id, {disabled: true}])),
    groups: list
      .filter(n => scripts.has(n.id))
      .map(({id}) => ({id: 'g_' + id, name: id, parent: null, members: [id], color: null, pinned: false, folded: false, disabled: false, position: {x: 0, y: 0}})),
    complex: list
      .filter(n => scripts.has(n.id))
      .map(({id, inputs = [], outs = []}) => ({
        id: 'g_' + id,
        interface: {
          inputs: [{...signal('in', 'in'), bound: [{node_id: id, port_id: 'in'}]}, ...inputs.map(port)],
          outputs: [port('result'), signal('out', 'out'), ...outs.map(n => signal(n, n))],
        },
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
        arbitrary: {inputs: false, outputs: false},
        source: {resource_id: 'test:' + id},
      })),
    port_edges: wires.map(([from, to, input, output], i) =>
      input === undefined || (input === 'in' && output)
        ? {id: 'e' + i, source: end(from), source_port: output ?? 'out', target: end(to), target_port: 'in'}
        : {id: 'e' + i, source: end(from), source_port: output ?? 'result', target: end(to), target_port: input}
    ),
    widgets: {},
    types: [],
  };
  return doc;
};
/**
 * Evaluates `roots` of a stored document with the real engine; answers the result, the events the hooks heard (in order), the nodes
 * that started and the most nodes whose code ran at the same time. `tweak` (source of a function of the plan) may change the plan
 * first, e.g. to lower a limit.
 */
async function evaluate(app, doc, roots, {options = '{}', tweak = '(() => {})'} = {}) {
  app.context.__doc = doc;
  app.context.__roots = roots;
  app.context.log = [];
  const text = await app.eval(`(async () => {
    const snapshot = buildSnapshot({id: 'p'}, {id: 'w', name: 'w'}, __doc, false), ran = [], events = [];
    let now = 0, most = 0;
    const hooks = {
      onNodeStart: e => { events.push('start ' + e.node_id); ran.push(e.node_id); most = Math.max(most, ++now); },
      onNodeDone: e => { events.push('done ' + e.node_id); now--; },
      onNodeFail: e => { events.push('fail ' + e.node_id + ': ' + e.error); },
      onNodeSkip: e => { events.push('skip ' + e.node_id); },
    };
    const execute = (plan, onEvent, signal) => { (${tweak})(plan); return runPlan(plan, onEvent, signal); };
    const result = await evaluateGraph(snapshot, __roots, execute, {hooks, collect: true, ...${options}});
    return JSON.stringify({result, events, ran, most});
  })()`);
  return {...JSON.parse(text), log: JSON.parse(JSON.stringify(app.context.log))};
}
const sleep = ms => `await new Promise(r => setTimeout(r, ${ms}));`;

test('a signal runs a Script, which reads the data of the nodes wired to it', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'seven', value: 7},
      {id: 'sum', code: 'node.output.result = x + 1', inputs: ['x']},
    ],
    [['go', 'sum'], ['seven', 'sum', 'x']]
  );
  const {result, ran} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(ran, ['go', 'sum']);
  assert.deepEqual(result.outputs.go, {}, 'an event node without data has no outputs');
  const sum = await evaluate(app, doc, ['sum']);
  assert.deepEqual(sum.result.outputs.sum, {result: 8}, 'a Script that is a root runs as if a signal reached it');
});

test('without a signal nothing runs: a Script nobody signals does nothing, and reading it gives undefined', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'idle', code: 'globalThis.log.push("idle"); node.output.result = 1'},
      {id: 'user', code: 'node.output.result = typeof x', inputs: ['x']},
      {id: 'go', op: 'on_run'},
    ],
    [['go', 'user'], ['idle', 'user', 'x']]
  );
  const {result, ran, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(ran, ['go', 'user']);
  assert.deepEqual(log, []);
  assert.deepEqual(result.outputs.go, {});
  const user = await evaluate(app, doc, ['user']);
  assert.deepEqual(user.result.outputs.user, {result: 'undefined'});
});

test('a signal goes to every wire at once; the receivers work independently', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      ...['a', 'b', 'c'].map(id => ({id, bare: true, code: `${sleep(300)} node.output.result = "${id}"`})),
    ],
    [['go', 'a'], ['go', 'b'], ['go', 'c']]
  );
  const began = Date.now();
  const {result, ran, most} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual([...ran].sort(), ['a', 'b', 'c', 'go']);
  assert.equal(most, 4 - 1, 'three Scripts and the event node: the Scripts overlap');
  assert.ok(Date.now() - began < 800, 'three waits of 300 ms overlap');
  const capped = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.parallel = 1; }'});
  assert.equal(capped.most, 1, 'no more nodes run their code at once than the limit says');
});

test('a node runs after what comes before it on the signal path, and reads its results', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'a', code: `${sleep(30)} node.output.result = 1`},
      {id: 'b', code: 'node.output.result = x + 10', inputs: ['x']},
      {id: 'c', code: 'globalThis.log.push([x, y])', inputs: ['x', 'y']},
    ],
    [['go', 'a'], ['a', 'b'], ['a', 'b', 'x'], ['b', 'c'], ['a', 'c', 'x'], ['b', 'c', 'y']]
  );
  const {result, ran, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(ran, ['go', 'a', 'b', 'c']);
  assert.deepEqual(log, [[1, 11]], 'c read what a and b had left');
});

test('a Script fires nothing when its code ends: only emit sends a signal, any number of times', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'quiet', bare: true, code: 'node.output.result = 1'},
      {id: 'loud', code: 'await node.emit("out"); await node.emit("out"); node.output.result = 2'},
      {id: 'next', code: 'globalThis.log.push("after quiet")'},
      {id: 'after', code: 'globalThis.log.push("after loud"); node.output.result = x', inputs: ['x']},
    ],
    [['go', 'quiet'], ['go', 'loud'], ['quiet', 'next'], ['loud', 'after'], ['loud', 'after', 'x']]
  );
  const {result, log, ran} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.equal(log.filter(x => x === 'after quiet').length, 0, 'the code ended without emit: nothing was sent');
  assert.equal(log.filter(x => x === 'after loud').length, 2, 'two emits, two signals, and none at the end');
  assert.equal(ran.filter(id => id === 'after').length, 2);
});

test('a loop: node.emit("out") sends the signal from the middle of the code, and the nodes after it see the outputs as they are then', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'loop', code: 'for (let i = 0; i < 4; i++) { node.output.result = i * 10; await node.emit("out"); } node.output.result = "end"'},
      {id: 'seen', code: 'globalThis.log.push(x)', inputs: ['x']},
    ],
    [['go', 'loop'], ['loop', 'seen'], ['loop', 'seen', 'x']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(log, [0, 10, 20, 30], 'each pass sees the value of its own turn: emit waits for the nodes it started');
  const loop = await evaluate(app, doc, ['loop']);
  assert.deepEqual(loop.result.outputs.loop, {result: 'end'}, 'the code returned at the end: that is the result');
});

test('node.emit(name) sends another signal output; an output that does not exist is an error', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'split', outs: ['Odd'], code: 'for (const n of [1, 2, 3]) { node.output.result = n; await node.emit(n % 2 ? "Odd" : "out"); }'},
      {id: 'odd', code: 'globalThis.log.push("odd " + x)', inputs: ['x']},
      {id: 'even', code: 'globalThis.log.push("even " + x)', inputs: ['x']},
      {id: 'broken', code: 'await node.emit("Nope")'},
    ],
    [['go', 'split'], ['split', 'odd', 'in', 'Odd'], ['split', 'odd', 'x'], ['split', 'even'], ['split', 'even', 'x'], ['go', 'broken']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(log, ['odd 1', 'even 2', 'odd 3']);
  assert.match(result.errors.go, /no free signal output “Nope”/);
});

test('an error in a node that was signalled is thrown by node.emit() in the code that sent the signal; the code may catch it', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'sender', code: 'try { await node.emit("out"); } catch (e) { globalThis.log.push("caught " + e.message); } node.output.result = "survived"'},
      {id: 'fails', code: 'throw new Error("boom")'},
      {id: 'sender2', code: 'await node.emit("out"); globalThis.log.push("not reached")'},
      {id: 'fails2', code: 'throw new Error("bang")'},
    ],
    [['go', 'sender'], ['sender', 'fails'], ['go', 'sender2'], ['sender2', 'fails2']]
  );
  const {result, log, events} = await evaluate(app, doc, ['go', 'sender']);
  assert.ok(log.includes('caught Node code: boom'));
  assert.ok(!log.includes('not reached'));
  assert.equal(result.status.fails, 'failed');
  assert.equal(result.status.sender, 'completed', 'sender caught the error');
  assert.equal(result.status.sender2, 'failed', 'an error nobody catches ends the code that sent the signal too');
  assert.equal(result.errors.go, 'Node code: bang', 'and the root that started it reports the first error of its run');
  assert.ok(events.includes('fail sender2: bang') || events.some(e => e.startsWith('fail sender2')));
});

test('a failing branch does not stop its siblings; the run lasts until they have finished', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'bad', code: 'throw new Error("no")'},
      {id: 'slow', code: `${sleep(200)} node.output.result = "done"`},
    ],
    [['go', 'bad'], ['go', 'slow']]
  );
  const {result} = await evaluate(app, doc, ['go']);
  assert.equal(result.errors.go, 'Node code: no');
  assert.equal(result.status.slow, 'completed', 'the other branch ran to its end');
});

test('a Script that signals itself in a loop is stopped by the chain limit', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'again', code: 'globalThis.log.push(1); node.output.result = 1'},
    ],
    [['go', 'again'], ['again', 'again']]
  );
  const {result, log} = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.chain = 25; }'});
  assert.match(result.errors.go, /Signal chain is longer than 25 nodes/);
  assert.ok(log.length >= 20 && log.length <= 26, 'it ran about as many times as the limit says: ' + log.length);
  const long = await evaluate(app, doc, ['go']);
  assert.match(long.result.errors.go, /longer than 1000 nodes/);
});

test('values are copies: a node that changes what it received changes it for nobody else', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'a', code: 'node.output.result = {list: [1, 2]}'},
      {id: 'b', code: 'x.list.push(3); globalThis.log.push("b" + x.list.length)', inputs: ['x']},
      {id: 'c', code: 'globalThis.log.push("c" + x.list.length)', inputs: ['x']},
    ],
    [['go', 'a'], ['a', 'b'], ['a', 'b', 'x'], ['a', 'c'], ['a', 'c', 'x']]
  );
  const {log} = await evaluate(app, doc, ['go']);
  assert.deepEqual([...log].sort(), ['b3', 'c2'], 'c sees what a made, not what b did to its copy');
});

test('node.reread(name) reads an input again: a loop can watch a value that another branch sets', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'stop', code: `${'await new Promise(r => setTimeout(r, 60));'} node.output.result = true`},
      {id: 'spin', inputs: ['flag'], code: 'let n = 0; while (!(await node.reread("flag"))) { n++; await new Promise(r => setTimeout(r, 10)); } node.output.result = n > 0'},
    ],
    [['go', 'stop'], ['go', 'spin'], ['stop', 'spin', 'flag']]
  );
  const {result} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.equal(result.status.spin, 'completed');
});

test('a node that takes too long fails with a timeout; the time spent in node.emit() is not counted', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'slow', code: `${sleep(5000)}`},
      {id: 'waits', code: 'await node.emit("out"); node.output.result = "ok"'},
      {id: 'long', code: `${sleep(500)}`},
    ],
    [['go', 'slow'], ['go', 'waits'], ['waits', 'long']]
  );
  const began = Date.now();
  const {result} = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.timeout = 250; }'});
  assert.ok(Date.now() - began < 3500);
  assert.equal(result.status.slow, 'failed');
  assert.equal(result.status.long, 'failed', 'its own code is over the limit');
  assert.equal(result.status.waits, 'failed', 'it got the error of the node it signalled');
  assert.equal(result.errors.go, 'Node code execution timed out');
  const ok = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'waits', code: 'await node.emit("out"); await node.emit("out"); node.output.result = "ok"'},
      {id: 'long', code: `${sleep(200)}`},
    ],
    [['go', 'waits'], ['waits', 'long']]
  );
  const waited = await evaluate(app, ok, ['go'], {tweak: 'plan => { plan.limits.timeout = 300; }'});
  assert.deepEqual(waited.result.errors, {}, 'two waits of 200 ms in a node that may run 300 ms');
});

test('a script that never lets go (an endless loop) ends the run, from outside the Worker', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf([{id: 'go', op: 'on_run'}, {id: 'spin', code: 'for (;;) {}'}], [['go', 'spin']]);
  const began = Date.now();
  const {result} = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.timeout = 150; plan.limits.grace = 150; }'});
  assert.ok(Date.now() - began < 3000, 'the run does not wait for the loop');
  assert.equal(result.errors.go, 'Node code execution timed out');
  assert.equal(result.status.spin, 'failed');
});

test('a Script that waits in node.emit() is not taken for one that never returns (Worker)', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'loop', code: 'for (let i = 0; i < 3; i++) { node.output.result = i; await node.emit("out"); }'},
      {id: 'step', code: `${sleep(250)} globalThis.x = 1`},
    ],
    [['go', 'loop'], ['loop', 'step']]
  );
  const {result} = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.timeout = 300; plan.limits.grace = 100; }'});
  assert.deepEqual(result.errors, {}, 'three waits of 250 ms: more than the limit and the grace together, but not the code of one node');
});

test('a run can be cancelled before it starts and while it works', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf([{id: 'go', op: 'on_run'}, {id: 'wait', code: sleep(60000)}], [['go', 'wait']]);
  const before = await evaluate(app, doc, ['go'], {options: '{signal: AbortSignal.abort()}'});
  assert.equal(before.result.errors.go, 'Run cancelled');
  const began = Date.now();
  const during = await evaluate(app, doc, ['go'], {options: '{signal: AbortSignal.timeout(150)}'});
  assert.ok(Date.now() - began < 3000);
  assert.equal(during.result.errors.go, 'Run cancelled');
  assert.equal(during.result.status.wait, 'failed');
});

test('the size limits: one result, and all results of a run', async () => {
  const app = createApp();
  const doc = docOf([{id: 'go', op: 'on_run'}, {id: 'big', code: 'node.output.result = "x".repeat(1000)'}], [['go', 'big']]);
  const one = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.result = 500; }'});
  assert.match(one.result.errors.go, /output size limit/);
  const many = docOf([{id: 'go', op: 'on_run'}, ...['a', 'b', 'c'].map(id => ({id, code: 'node.output.result = "x".repeat(1000)'}))], [['go', 'a'], ['go', 'b'], ['go', 'c']]);
  const all = await evaluate(app, many, ['go'], {tweak: 'plan => { plan.limits.bytes = 2500; }'});
  assert.match(all.result.errors.go, /output size limit/);
});

test('a loop that replaces its output does not use up the size limit of the run', async () => {
  const app = createApp();
  const doc = docOf([{id: 'go', op: 'on_run'}, {id: 'loop', code: 'for (let i = 0; i < 50; i++) { node.output.result = "x".repeat(1000); await node.emit("out"); }'}], [['go', 'loop']]);
  const {result} = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.bytes = 5000; }'});
  assert.deepEqual(result.errors, {}, 'only the latest result of a node counts');
});

test('nodes of different runs stay apart: what one run leaves behind is not seen by the next', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'set', code: 'globalThis.leak = (globalThis.leak ?? 0) + 1; node.output.result = globalThis.leak'},
      {id: 'peek', code: 'node.output.result = typeof x', inputs: ['x']},
    ],
    [['go', 'set'], ['set', 'peek'], ['set', 'peek', 'x']]
  );
  for (let i = 0; i < 3; i++) assert.equal((await evaluate(app, doc, ['peek'])).result.outputs.peek.result, 'undefined', 'no result of an earlier run is read');
  assert.equal((await evaluate(app, doc, ['go', 'peek'])).result.outputs.set, undefined);
});

test('node, agentsys and context are variables of the node code; the old names explain where they went', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'a', code: 'node.display("shown", 1); node.output.result = [typeof node.display, typeof agentsys, typeof context, typeof node.emit, typeof node.widgets, typeof node.output, typeof node.input, context.node_id]'},
      {id: 'b', code: 'const f = () => context; try { f(); node.output.result = "visible" } catch (e) { node.output.result = e.message }'},
      {id: 'c', code: 'try { display("x") } catch (e) { node.output.result = e.message }'},
    ],
    [['go', 'a'], ['go', 'b'], ['go', 'c']]
  );
  const {result} = await evaluate(app, doc, ['a', 'b', 'c']);
  assert.deepEqual(result.outputs.a.result, ['function', 'function', 'object', 'function', 'function', 'object', 'object', 'a']);
  assert.equal(result.displays.a, 'shown\u001e1');
  assert.equal(result.outputs.b.result, 'visible');
  assert.match(result.outputs.c.result, /display is not a variable of the node code.*node\.display/);
});

test('a stray error after a node finished does not stop the run', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'a', code: 'setTimeout(() => { throw new Error("late"); }, 20); Promise.reject(new Error("later")); node.output.result = 1'},
      {id: 'b', code: `${sleep(80)} node.output.result = 2`},
    ],
    [['go', 'a'], ['go', 'b']]
  );
  const {result} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.equal(result.status.b, 'completed');
});

test('a run with no code to run starts no Worker', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf([{id: 'one', value: 1}], []);
  const before = await app.eval('typeof AGENTSYS_SPAWN_WORKER');
  assert.equal(before, 'function');
  app.context.spawned = 0;
  await app.eval('(() => { const was = AGENTSYS_SPAWN_WORKER; AGENTSYS_SPAWN_WORKER = source => (spawned++, was(source)); })()');
  const {result} = await evaluate(app, doc, ['one']);
  assert.deepEqual(result.outputs.one, {result: 1});
  assert.equal(app.context.spawned, 0);
});

test('a node that is disabled does not run: a signal does not reach it, its data is nothing, and it cannot be a root', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'off', code: 'node.output.result = 1', disabled: true},
      {id: 'on', code: 'node.output.result = typeof x', inputs: ['x']},
      {id: 'after', code: 'globalThis.log.push("after")'},
    ],
    [['go', 'off'], ['off', 'after'], ['go', 'on'], ['off', 'on', 'x']]
  );
  const {result, ran, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(ran, ['go', 'on']);
  assert.deepEqual(log, []);
  const root = await evaluate(app, doc, ['off']);
  assert.equal(root.result.errors.off, 'The node is disabled');
  const off = docOf([{id: 'go', op: 'on_run', disabled: true}, {id: 'a', code: 'node.output.result = 1'}], [['go', 'a']]);
  assert.equal((await evaluate(app, off, ['go'])).result.errors.go, 'The node is disabled');
});

test('the data of the event reaches the run: on_run carries a payload', async () => {
  const app = createApp();
  const doc = docOf([{id: 'go', op: 'on_run'}, {id: 'use', code: 'node.output.result = p.name', inputs: ['p']}], [['go', 'use'], ['go', 'use', 'p', 'payload']]);
  const {result} = await evaluate(app, doc, ['go'], {options: "{events: {go: {payload: {name: 'Ann'}}}}"});
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.outputs.go, {payload: {name: 'Ann'}});
  const use = await evaluate(app, doc, ['use'], {options: "{events: {go: {payload: {name: 'Bo'}}}}"});
  assert.match(use.result.errors.use, /undefined/, 'an event node that did not fire has no data to read');
});

// ----- Flow control: waves, node.flow (break, continue, cancel, abort) and emit(name, {handles, failFast}) -----
const LOOP = n => `for (let i = 0; i < ${n}; i++) { node.output.result = i; const r = await node.emit("out", {handles: ["break", "continue"]}); globalThis.log.push("emit " + i + " " + r); if (r === "break") break; }`;
const wait = ms => `await new Promise(r => setTimeout(r, ${ms}));`;

test('node.flow.break() ends the loop: the emit that handles it answers "break", and the rest of that pass does not start', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'loop', code: LOOP(10)},
      {id: 'a', code: 'if (x === 3) node.flow.break(); globalThis.log.push("a " + x)', inputs: ['x']},
      {id: 'b', code: `${wait(20)} globalThis.log.push("b " + x)`, inputs: ['x']},
      {id: 'c', code: 'globalThis.log.push("c " + x)', inputs: ['x']},
    ],
    [['go', 'loop'], ['loop', 'a'], ['loop', 'a', 'x'], ['loop', 'b'], ['loop', 'b', 'x'], ['b', 'c'], ['loop', 'c', 'x']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.ok(log.includes('emit 3 break'));
  assert.ok(!log.some(l => l.startsWith('emit 4')), 'the loop ended: ' + log);
  assert.ok(!log.includes('a 3') && !log.includes('c 3'), 'what follows break() in its node, and what the pass had not started, did not run');
  for (const i of [0, 1, 2]) assert.ok(log.includes('c ' + i));
  assert.equal(result.status.a, 'completed', 'break() ends the code of its node: that is not a failure');
});

test('node.flow.continue() ends the pass: the emit answers "continue" and the loop goes on', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'loop', code: LOOP(5)},
      {id: 'odd', code: 'if (x % 2) node.flow.continue()', inputs: ['x']},
      {id: 'tail', code: 'globalThis.log.push("tail " + x)', inputs: ['x']},
    ],
    [['go', 'loop'], ['loop', 'odd'], ['loop', 'odd', 'x'], ['odd', 'tail'], ['loop', 'tail', 'x']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(log.filter(l => l.startsWith('tail')), ['tail 0', 'tail 2', 'tail 4']);
  assert.deepEqual(log.filter(l => l.startsWith('emit')), ['emit 0 undefined', 'emit 1 continue', 'emit 2 undefined', 'emit 3 continue', 'emit 4 undefined']);
});

test('break() and continue() go up through emits that do not handle them, to the loop; the node in between goes on and its next emit ends its code', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'loop', code: LOOP(5)},
      {id: 'branch', outs: ['T'], code: 'await node.emit("T"); globalThis.log.push("branch after T"); await node.emit("out");'},
      {id: 'inner', code: 'if (x === 1) node.flow.break()', inputs: ['x']},
      {id: 'rest', code: 'globalThis.log.push("rest " + x)', inputs: ['x']},
    ],
    [['go', 'loop'], ['loop', 'branch'], ['branch', 'inner', 'in', 'T'], ['loop', 'inner', 'x'], ['branch', 'rest'], ['loop', 'rest', 'x']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.ok(log.includes('emit 1 break') && !log.some(l => l.startsWith('emit 2')));
  assert.ok(log.includes('rest 0') && !log.includes('rest 1'), 'the second emit of the node in between ended its code: ' + log);
  assert.equal(result.status.branch, 'completed');
});

test('a loop inside a loop: break() takes the nearest emit that handles it, even when an emit in between does not', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'outer', code: 'const r = await node.emit("out", {handles: ["break"]}); globalThis.log.push("outer " + r)'},
      {id: 'spin', code: 'let n = 0; while (true) { node.output.result = n++; await node.emit("out"); }'},
      {id: 'body', code: 'globalThis.log.push("body " + x); if (x === 2) node.flow.break()', inputs: ['x']},
    ],
    [['go', 'outer'], ['outer', 'spin'], ['spin', 'body'], ['spin', 'body', 'x']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(log, ['body 0', 'body 1', 'body 2', 'outer break'], 'the endless loop in between stopped when its flow was cancelled');
});

test('break() with nothing above that handles it is an error of the node that called it', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'plain', code: 'await node.emit("out")'},
      {id: 'stray', code: 'node.flow.break()'},
    ],
    [['go', 'plain'], ['plain', 'stray']]
  );
  const {result} = await evaluate(app, doc, ['go']);
  assert.equal(result.status.stray, 'failed');
  assert.match(result.errors.go, /node\.flow\.break\(\) outside a loop/);
});

test('node.flow.cancel() stops the flow of the emit above without an error; what is running finishes, what had not started is skipped', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'sender', code: 'await node.emit("out"); globalThis.log.push("sender goes on")'},
      {id: 'stop', code: 'node.flow.cancel()'},
      {id: 'victim', code: 'globalThis.log.push("victim")'},
    ],
    [['go', 'sender'], ['sender', 'stop'], ['sender', 'victim']]
  );
  const {result, log, events, ran} = await evaluate(app, doc, ['go'], {tweak: 'plan => { plan.limits.parallel = 1; }'});
  assert.deepEqual(result.errors, {});
  assert.ok(log.includes('sender goes on'), 'the emit answered, and the sender is not cancelled');
  assert.ok(!ran.includes('victim') && events.includes('skip victim'), 'it was waiting for its turn when the flow was cancelled: ' + events);
});

test('node.flow.abort() ends the whole run: nothing starts, and the loops that are running end their code', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'spin', code: 'let n = 0; while (true) { node.output.result = n++; await node.emit("out"); }'},
      {id: 'body', code: 'globalThis.log.push("body " + x); if (x === 2) node.flow.abort()', inputs: ['x']},
      {id: 'never', code: 'globalThis.log.push("never")'},
    ],
    [['go', 'spin'], ['spin', 'body'], ['spin', 'body', 'x'], ['body', 'never']]
  );
  const {result, log} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(log, ['body 0', 'never', 'body 1', 'never', 'body 2']);
});

test('emit with failFast: the first failure cancels the rest of what that emit started; without it the siblings go on', async () => {
  const app = createApp();
  const make = options =>
    docOf(
      [
        {id: 'go', op: 'on_run'},
        {id: 'sender', code: `try { await node.emit("out"${options}) } catch (e) { globalThis.log.push("caught") }`},
        {id: 'bad', code: 'throw new Error("bad")'},
        {id: 'slow', code: `${wait(30)} await node.emit("out")`},
        {id: 'after', code: 'globalThis.log.push("after")'},
      ],
      [['go', 'sender'], ['sender', 'bad'], ['sender', 'slow'], ['slow', 'after']]
    );
  const fast = await evaluate(app, make(', {failFast: true}'), ['go']);
  assert.deepEqual(fast.log, ['caught'], 'slow ended its code at its emit: its flow was cancelled');
  const plain = await evaluate(app, make(''), ['go']);
  assert.deepEqual(plain.log.sort(), ['after', 'caught']);
});

test('node.cancelled tells a long code that its flow was cancelled; handles and options are checked', async () => {
  const app = createApp();
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'sender', code: 'await node.emit("out"); globalThis.log.push("sender sees " + node.cancelled)'},
      {id: 'seer', code: `${wait(10)} globalThis.log.push("seer sees " + node.cancelled)`},
      {id: 'stop', code: 'node.flow.cancel()'},
      {id: 'odd', code: 'try { await node.emit("out", {handles: ["return"]}) } catch (e) { globalThis.log.push(e.message) } try { await node.emit("out", 5) } catch (e) { globalThis.log.push(e.message) }', bare: true},
    ],
    [['go', 'sender'], ['sender', 'seer'], ['sender', 'stop'], ['go', 'odd']]
  );
  const {log} = await evaluate(app, doc, ['go']);
  assert.ok(log.includes('seer sees true'), String(log));
  assert.ok(log.includes('sender sees false'), 'the emit has finished: the sender was never cancelled');
  assert.ok(log.some(l => /handles is a list of "break" and "continue"/.test(l)) && log.some(l => /options are an object/.test(l)));
});

test('break() works in a Worker too (the executor is embedded there as source text)', async () => {
  const app = createApp({scripts: 'worker'});
  const doc = docOf(
    [
      {id: 'go', op: 'on_run'},
      {id: 'loop', code: 'for (let i = 0; i < 10; i++) { node.output.result = i; if ((await node.emit("out", {handles: ["break"]})) === "break") break; }'},
      {id: 'body', code: 'if (x === 2) node.flow.break()', inputs: ['x']},
    ],
    [['go', 'loop'], ['loop', 'body'], ['loop', 'body', 'x']]
  );
  const {result, events} = await evaluate(app, doc, ['go']);
  assert.deepEqual(result.errors, {});
  assert.equal(result.status.body, 'completed');
  assert.equal(events.filter(e => e === 'start body').length, 3, 'passes 0, 1 and 2');
});
