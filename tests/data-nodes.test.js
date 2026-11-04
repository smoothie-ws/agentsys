'use strict';
// The generic Library nodes an LLM (or any other) controller is assembled from: Template, Parse JSON, Stringify JSON,
// Get/Set State, Set Input and Find Library Node. Each is one Script run by the real runtime.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, flow} = require('./harness');
const text = 't:64428b9c654c2c2cfcb55742ea899ed8';

async function setup(t) {
  const app = createApp({scripts: 'worker'});
  t.after(async () => {
    await app.Backend.shutdownExecutions();
  });
  await app.api('POST', 'library/builtin');
  const p = await app.api('POST', 'projects', {name: 'Data nodes'}),
    path = `projects/${p.id}`;
  const put = async (name, values = {}) => {
    const r = (await app.api('GET', 'resources')).find(r => r.name === name);
    const made = await app.api('POST', path + '/custom-nodes/' + r.id, {point: {x: 0, y: 0}}),
      id = 'complex:' + made.roots[0];
    if (Object.keys(values).length) await app.api('PUT', path + '/input-values', {node_id: id, values});
    return id;
  };
  const run = async id => {
    const result = await app.api('POST', path + '/execution', {node_ids: [id], input_port: 'in', wait: true});
    return {...result, value: result.dispatch_outputs[id]};
  };
  const feed = async (id, values) => {
    const source = await fn(
      app,
      p.id,
      {},
      {
        outputs: Object.keys(values),
        code: Object.entries(values)
          .map(([k, v]) => `node.output.${k}=${JSON.stringify(v)};`)
          .join('\n'),
      }
    );
    for (const key of Object.keys(values))
      await app.api('POST', path + '/port-connections', {
        add: [{source: source.wrapper, source_port: key, target: id, target_port: key}],
      });
    const result = await app.api('POST', path + '/execution', {node_ids: [source.id], wait: true});
    assert.deepEqual(result.errors, {});
  };
  return {app, p, path, put, run, feed};
}

test('built-in Data nodes are in the Library, grouped and without needless permissions', async t => {
  const f = await setup(t);
  const items = await f.app.api('GET', 'resources');
  const grants = name => items.find(r => r.name === name).payload.grants;
  for (const name of ['Template', 'Parse JSON', 'Stringify JSON', 'Get State', 'Set State'])
    assert.equal(items.find(r => r.name === name).payload.folder, 'Data', name);
  assert.deepEqual(grants('Template'), []);
  assert.deepEqual(grants('Set Input'), ['graph.write']);
  assert.deepEqual(grants('Find Library Node'), ['library.read']);
});

test('Template fills placeholders, keeps structure for a lone placeholder and names a missing value', async t => {
  const f = await setup(t);
  const id = await f.put('Template', {template: 'Solve {{data.goal}} with {{data.context}} for {{data.n}}'});
  await f.feed(id, {data: {goal: 'sum', context: [1, 2], n: 3}});
  assert.equal((await f.run(id)).value.value, 'Solve sum with [1,2] for 3');
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {template: '{{data.context}}'}});
  assert.deepEqual((await f.run(id)).value.value, [1, 2]);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {template: '{{data.nothing}}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /Missing template value: data\.nothing/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {template: '{{data.__proto__}}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /Missing template value/);
});

test('Parse JSON reads fenced JSON, rejects prose around it and checks a schema', async t => {
  const f = await setup(t);
  const id = await f.put('Parse JSON', {
    schema: JSON.stringify({
      type: 'object',
      required: ['answer'],
      properties: {answer: {type: 'integer'}},
      additionalProperties: false,
    }),
  });
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: '```json\n{"answer":42}\n```'}});
  assert.deepEqual((await f.run(id)).value.value, {answer: 42});
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: 'Sure! ```json\n{"answer":42}\n```'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /JSON/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: '{"answer":"x"}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /\$\.answer: expected integer/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: '{"answer":1,"extra":2}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /unexpected extra/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {schema: '{"$ref":"x"}', text: '{}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /Unsupported schema/);
});

test('Stringify JSON writes a value as text', async t => {
  const f = await setup(t);
  const id = await f.put('Stringify JSON', {indent: '2'});
  await f.feed(id, {value: {a: [1]}});
  assert.equal((await f.run(id)).value.text, '{\n  "a": [\n    1\n  ]\n}');
});

test('Set State and Get State share one keyed store of the workflow, kept in context.state', async t => {
  const f = await setup(t);
  const set = await f.put('Set State', {key: 'memory'});
  await f.feed(set, {value: {notes: ['a']}});
  const result = await f.run(set);
  assert.deepEqual(result.errors, {});
  const get = await f.put('Get State', {key: 'memory'});
  assert.deepEqual((await f.run(get)).value.value, {notes: ['a']});
  assert.deepEqual((await f.app.api('GET', f.path + '/execution')).state.memory, {notes: ['a']});
  await f.app.api('PUT', f.path + '/input-values', {node_id: get, values: {key: 'unknown'}});
  assert.equal((await f.run(get)).value.value, null);
  await f.app.api('PUT', f.path + '/input-values', {node_id: set, values: {key: '__proto__'}});
  assert.match(JSON.stringify((await f.run(set)).errors), /state key/);
});

test('Find Library Node and Set Input work with Add Node and Invoke Node on a placed copy', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'task', type: text}],
      outputs: ['result'],
      signals: ['out'],
      code: 'node.output.result={task:node.input.task};',
    }
  );
  const find = await f.put('Find Library Node', {name: 'Add Node'});
  assert.ok((await f.run(find)).value.resource_id);
  await f.app.api('PUT', f.path + '/input-values', {node_id: find, values: {name: 'No such node'}});
  assert.match(JSON.stringify((await f.run(find)).errors), /No Library node is named/);
  await f.app.api('PUT', f.path + '/input-values', {
    node_id: find,
    values: {name: (await f.app.api('GET', 'resources')).find(r => r.id === child.resource).name},
  });
  const resource_id = (await f.run(find)).value.resource_id;
  assert.equal(resource_id, child.resource);
  const add = await f.put('Add Node', {resource_id});
  const made = (await f.run(add)).value.node_id;
  // Placement alone is inert; Set Input changes what the next invocation reads.
  const set = await f.put('Set Input', {node_id: made});
  await f.feed(set, {values: {task: 'first'}});
  assert.ok((await f.run(set)).value.result.ok);
  const invoke = await f.put('Invoke Node', {node_id: made});
  assert.deepEqual((await f.run(invoke)).value.outputs.result, {task: 'first'});
  await f.feed(set, {values: {task: 'second'}});
  await f.run(set);
  assert.deepEqual((await f.run(invoke)).value.outputs.result, {task: 'second'});
  await f.feed(set, {values: 'not an object'});
  assert.match(JSON.stringify((await f.run(set)).errors), /object of input values/);
});

test('one controller step built only from nodes: Template, a model call, Parse JSON, Set State, driven by Run', async t => {
  const f = await setup(t);
  // The model stands in for any plugin route: a call with the prompt answers a fenced JSON reply.
  f.app.eval(
    "route('POST','test-model','A stand-in for a plugin route that calls a model',async c=>({text:'```json\\n'+JSON.stringify({kind:'direct',answer:c.body.prompt.length})+'\\n```'}),{needs:{POST:['graph.read']}})"
  );
  const ask = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'prompt', type: text}],
      outputs: ['response'],
      signals: ['out'],
      code: "node.output.response = (await agentsys('POST', 'test-model', {prompt: node.input.prompt})).text;",
    }
  );
  const template = await f.put('Template', {template: 'Solve {{data.goal}}'});
  await f.feed(template, {data: {goal: 'abcd'}});
  const parse = await f.put('Parse JSON', {
    schema: JSON.stringify({type: 'object', required: ['kind'], properties: {kind: {enum: ['direct', 'decompose']}}}),
  });
  const set = await f.put('Set State', {key: 'plan'});
  const wire = (source, source_port, target, target_port) =>
    f.app.api('POST', f.path + '/port-connections', {add: [{source, source_port, target, target_port}]});
  await wire(template, 'value', ask.wrapper, 'prompt');
  await wire(ask.wrapper, 'response', parse, 'text');
  await wire(parse, 'value', set, 'value');
  const start = await flow(f.app, f.p.id, {}, [template, ask.wrapper, parse, set]);
  const result = await f.app.api('POST', f.path + '/execution', {node_ids: [start], wait: true});
  assert.deepEqual(result.errors, {});
  // 'Solve abcd' is ten characters: the answer travelled through every node.
  assert.deepEqual((await f.app.api('GET', f.path + '/execution')).state.plan, {kind: 'direct', answer: 10});
  // A reply that is not valid for the schema stops the chain at Parse JSON, before Set State.
  f.app.eval("route('POST','test-model2','x',async()=>({text:'{\"kind\":\"other\"}'}),{needs:{POST:['graph.read']}})");
  await f.app.api('PUT', f.path + '/input-values', {node_id: set, values: {key: 'second'}});
  const bad = await fn(
    f.app,
    f.p.id,
    {},
    {
      outputs: ['response'],
      signals: ['out'],
      code: "node.output.response = (await agentsys('POST', 'test-model2', {})).text;",
    }
  );
  const only = await f.put('Parse JSON', {
    schema: JSON.stringify({type: 'object', properties: {kind: {enum: ['direct']}}}),
  });
  await wire(bad.wrapper, 'response', only, 'text');
  const failing = await flow(f.app, f.p.id, {}, [bad.wrapper, only]);
  const failed = await f.app.api('POST', f.path + '/execution', {node_ids: [failing], wait: true});
  assert.match(JSON.stringify(failed.errors), /outside enum/);
});
