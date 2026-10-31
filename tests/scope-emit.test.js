'use strict';
// A Script works through the Library node it is in: it fires the signal outputs of that node with node.output.name.emit() and sets its data outputs
// with output.<name>. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Scope'}),
    q = {workflow_id: id};
  return {
    id,
    q,
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (from, port, to, target = 'in') =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: from, source_port: port, target: to, target_port: target}],
      }),
    run: () => app.api('POST', `projects/${id}/execution`, {...q, wait: true}),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: ids, collect: true}),
  };
}

test('node.output.name.emit() fires a free signal output of the Library node the Script is in; an unknown name is an error', async () => {
  const app = createApp(),
    p = await project(app);
  const branch = await fn(app, p.id, p.q, {
    code: 'await node.output.if_true.emit(); try { await node.output.nope.emit() } catch (e) { node.display(e.message) }',
    signals: ['if_true', 'if_false'],
  });
  const yes = await p.node(nodes.script('node.display("yes")')),
    no = await p.node(nodes.script('node.display("no")'));
  const start = await p.node(nodes.run());
  await p.connect(start.id, 'out', branch.wrapper);
  await p.connect(branch.wrapper, 'if_true', yes.id);
  await p.connect(branch.wrapper, 'if_false', no.id);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.equal(run.displays[yes.id], 'yes');
  assert.equal(run.displays[no.id], undefined);
  assert.match(run.displays[branch.id], /Unknown output nope/);
});

test('a Script reads every data input of its Library node and sets its free outputs; what it does not set stays; Script emits its completion signal', async () => {
  const app = createApp(),
    p = await project(app);
  const add = await fn(app, p.id, p.q, {
    code: 'node.output.sum = a + b',
    inputs: ['a', 'b'],
    outputs: ['sum', 'other'],
    signals: ['out'],
  });
  const one = await p.node(nodes.value('number', 1)),
    two = await p.node(nodes.value('number', 2)),
    after = await p.node(nodes.script('node.display("after")'));
  await p.connect(one.id, 'value', add.wrapper, 'a');
  await p.connect(two.id, 'value', add.wrapper, 'b');
  await p.connect(add.wrapper, 'out', after.id);
  const r = await p.evaluate([add.id]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.outputs[add.id], {sum: 3}, 'the outputs of its Library node: what is not set is not there');
  assert.equal(r.displays?.[after.id], 'after', 'successful completion emits out');
});

test('a standalone Script has its completion signal and no free data outputs', async () => {
  const app = createApp(),
    p = await project(app);
  const bare = await p.node(nodes.script('node.output.x = 1')),
    firing = await p.node(nodes.script(''));
  const r = await p.evaluate([bare.id, firing.id]);
  assert.match(r.errors[bare.id], /no free output/);
  assert.equal(r.errors[firing.id], undefined);
});

test('an output a node inside feeds, or a signal output, cannot be set with output; a function is not data', async () => {
  const app = createApp(),
    p = await project(app);
  const signalled = await fn(app, p.id, p.q, {code: 'node.output.fire = 1', signals: ['fire']}),
    typo = await fn(app, p.id, p.q, {code: 'node.output.reslt = 1', outputs: ['result']}),
    fun = await fn(app, p.id, p.q, {code: 'node.output.f = () => 1', outputs: ['f']});
  const r = await p.evaluate([signalled.id, typo.id, fun.id]);
  assert.match(r.errors[signalled.id], /node.output.fire.emit/);
  assert.match(r.errors[typo.id], /no free output “reslt”/);
  assert.match(r.errors[fun.id], /output\.f cannot be sent/);
});
