'use strict';
// Randomized graph mutation: a deterministic sequence of ordinary editor operations through the API, with the
// document's invariants checked after every step. This is the property test the graph format has: whatever the
// editor is asked to do, the result must be a graph the API and the engine can still read, wire and run.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes} = require('./harness');

function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: list => list[Math.floor(next() * list.length)],
    chance: share => next() < share,
  };
}

/** The document as a comparable value: positions and semantic content, ordered so two reads compare. */
function stateOf(snapshot) {
  const sorted = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  return JSON.stringify({
    nodes: sorted(snapshot.nodes).map(node => ({
      id: node.id,
      config: node.config,
      position: node.position,
      disabled: !!node.disabled,
      color: node.color ?? null,
    })),
    edges: sorted(snapshot.edges),
    groups: sorted(snapshot.groups),
    complex: sorted(snapshot.complex),
  });
}

function checkInvariants(snapshot, label) {
  const ids = snapshot.nodes.map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: node ids are unique`);
  const edges = snapshot.edges.map(edge => edge.id);
  assert.equal(new Set(edges).size, edges.length, `${label}: edge ids are unique`);
  const known = new Set(ids);
  for (const edge of snapshot.edges) {
    assert.ok(known.has(edge.source), `${label}: edge source ${edge.source} exists`);
    assert.ok(known.has(edge.target), `${label}: edge target ${edge.target} exists`);
  }
  for (const node of snapshot.nodes) {
    assert.equal(Number.isFinite(node.position?.x), true, `${label}: ${node.id} has an x`);
    assert.equal(Number.isFinite(node.position?.y), true, `${label}: ${node.id} has a y`);
  }
  for (const group of snapshot.groups)
    for (const member of group.members) assert.ok(known.has(member), `${label}: group member ${member} exists`);
  assert.equal(typeof snapshot.cursor, 'number');
}

async function workspace(app, projectId) {
  const query = {workflow_id: projectId};
  const post = (route, body) => app.api('POST', `projects/${projectId}/${route}`, {...body, ...query});
  const put = (route, body) => app.api('PUT', `projects/${projectId}/${route}`, {...body, ...query});
  const snapshot = () => app.api('GET', `projects/${projectId}/workflow`, {}, query);
  return {post, put, snapshot, query};
}

test('random editing keeps a valid graph and undo/redo returns the same document', async () => {
  const app = createApp();
  const {id} = await app.api('POST', 'projects', {name: 'Random edits'});
  const w = await workspace(app, id);
  // A Script node needs the code type; the project policy already allows graph.read, which the harness set.
  const scriptConfig = () => ({
    title: 'Script',
    op: 'script',
    inputs: [
      {id: 'in', name: 'in', type: 'signal'},
      {id: 'script', name: 'script', type: 't:c0de0c0de0c0de0c0de0c0de0c0de0c0', default: 'node.display("x");'},
    ],
    outputs: [{id: 'out', name: 'out', type: 'signal'}],
  });

  let successful = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const r = generator(seed);
    // Start each run from a paired graph: two events and two scripts.
    let nodes = [];
    for (let i = 0; i < 2; i++) nodes.push((await w.post('primitives', {primitive: 'event', point: {x: i * 60, y: 0}})).id);
    for (let i = 0; i < 2; i++)
      nodes.push(
        (
          await w.post('typed-nodes', {
            node_type: 'custom',
            config: scriptConfig(),
            position: {x: 100 + i * 60, y: 80},
          })
        ).id
      );

    let lastCursor = 0;
    for (let step = 0; step < 30; step++) {
      let before = await w.snapshot();
      checkInvariants(before, `seed ${seed} step ${step} start`);
      assert.ok(before.cursor >= lastCursor, `seed ${seed}: cursor never goes back`);
      lastCursor = before.cursor;
      const alive = before.nodes.map(node => node.id);
      const choice = r.pick([
        'add-event',
        'add-script',
        'connect',
        'connect',
        'disconnect',
        'move',
        'rename',
        'delete',
        'undo',
        'redo',
        'split',
      ]);
      try {
        if (choice === 'add-event' || choice === 'add-script') {
          await w.post('primitives', {
            primitive: choice === 'add-event' ? 'event' : 'script',
            point: {x: r.int(-200, 400), y: r.int(-200, 400)},
          });
        } else if (choice === 'connect') {
          if (alive.length < 2) throw new Error('need two nodes');
          const source = r.pick(alive),
            target = r.pick(alive);
          if (source === target) throw new Error('same node');
          await w.post('port-connections', {
            add: [{source, source_port: 'out', target, target_port: 'in'}],
          });
        } else if (choice === 'disconnect') {
          if (!before.edges.length) throw new Error('no edges');
          await w.post('port-connections', {remove: [r.pick(before.edges)]});
        } else if (choice === 'move') {
          if (!alive.length) throw new Error('no nodes');
          await w.put('layout', {positions: {[r.pick(alive)]: {x: r.int(-400, 400), y: r.int(-400, 400)}}});
        } else if (choice === 'rename') {
          if (!alive.length) throw new Error('no nodes');
          await w.put('node-title', {node_id: r.pick(alive), title: 'Renamed ' + r.int(1, 9)});
        } else if (choice === 'delete') {
          if (!alive.length) throw new Error('no nodes');
          await w.post('delete-nodes', {node_ids: [r.pick(alive)]});
        } else if (choice === 'split') {
          if (!before.edges.length) throw new Error('no edges');
          await w.post('split-connections', {
            splits: [{edge_id: r.pick(before.edges).id, position: {x: r.int(0, 300), y: r.int(0, 300)}}],
          });
        } else if (choice === 'undo') {
          const undone = await w.post('undo', {});
          const after = await w.snapshot();
          if (undone.undo < before.history.undo) {
            // Undo moved: the document changed, and redo must bring back exactly what was there.
            await w.post('redo', {});
            const restored = await w.snapshot();
            assert.equal(stateOf(restored), stateOf(before), `seed ${seed} step ${step}: redo after undo restores`);
          }
        } else {
          const redone = await w.post('redo', {});
          assert.ok(typeof redone.redo === 'number');
        }
        successful++;
      } catch (error) {
        // An operation the graph cannot accept (e.g. no edge to split) is a skipped step, not a failure.
        assert.ok(
          /need|no (edge|nodes)|same node|already|not found|missing|invalid|cannot|unknown|signal|port/i.test(error.message),
          `seed ${seed} step ${step} (${choice}): unexpected error ${error.message}`
        );
      }
      const snapshot = await w.snapshot();
      checkInvariants(snapshot, `seed ${seed} step ${step} after ${choice}`);
      await app.Backend.hooksIdle();
    }
    // A random sequence never leaves a document the API cannot read back: this is a fresh read.
    assert.ok((await w.snapshot()).nodes.length >= 0);
    // And it never grows without bound in this run.
    assert.ok((await w.snapshot()).nodes.length <= 40);
  }
  assert.ok(successful >= 60, `enough operations were accepted (${successful})`);
});

test('a random graph can still be run after mutations', async () => {
  const app = createApp({scripts: 'worker'});
  const {id} = await app.api('POST', 'projects', {name: 'Random run'});
  const w = await workspace(app, id);
  const r = generator(99);
  const event = (await w.post('primitives', {primitive: 'event', point: {x: 0, y: 0}})).id;
  const script = (await w.post('primitives', {primitive: 'script', point: {x: 100, y: 0}})).id;
  await w.put('input-values', {node_id: script, values: {script: 'node.display("random ok");'}});
  await w.post('port-connections', {add: [{source: event, source_port: 'out', target: script, target_port: 'in'}]});
  // Mutate around the pair, then run the untouched pair.
  for (let step = 0; step < 10; step++) {
    try {
      if (r.chance(0.5)) await w.post('primitives', {primitive: 'event', point: {x: r.int(0, 300), y: r.int(0, 300)}});
      else await w.put('layout', {positions: {[event]: {x: r.int(0, 300), y: r.int(0, 300)}}});
    } catch {}
  }
  const run = await w.post('execution', {node_ids: [event], wait: true});
  assert.deepEqual(run.errors, {});
  const displays = Object.values(run.displays || {}).join(' ');
  assert.match(displays, /random ok/);
  await app.Backend.shutdownExecutions();
});

test('every editing route is undoable: primitives, splits, output values, types and grants', async () => {
  const app = createApp();
  const {id} = await app.api('POST', 'projects', {name: 'Undo coverage'});
  const w = await workspace(app, id);
  const count = async () => (await w.snapshot()).nodes.length;
  const nodeOf = async nodeId => (await w.snapshot()).nodes.find(node => node.id === nodeId);

  // Adding a Script or an Event is an edit.
  const start = await count();
  const event = (await w.post('primitives', {primitive: 'event', point: {x: 0, y: 0}})).id;
  assert.equal(await count(), start + 1, 'the Event was added');
  await w.post('undo', {});
  assert.equal(await count(), start, 'adding an Event is undoable');
  await w.post('redo', {});
  assert.equal(await count(), start + 1);

  // Splitting a wire (a reroute point) is an edit.
  const script = (await w.post('primitives', {primitive: 'script', point: {x: 100, y: 0}})).id;
  await w.post('port-connections', {add: [{source: event, source_port: 'out', target: script, target_port: 'in'}]});
  const connected = await w.snapshot();
  assert.equal(connected.edges.length, 1);
  const nodesBeforeSplit = connected.nodes.length;
  await w.post('split-connections', {splits: [{edge_id: connected.edges[0].id, position: {x: 50, y: 50}}]});
  const split = await w.snapshot();
  assert.equal(split.edges.length, 2, 'the wire is split in two');
  await w.post('undo', {});
  const unsplit = await w.snapshot();
  assert.equal(unsplit.edges.length, 1, 'splitting a wire is undoable');
  assert.equal(unsplit.nodes.length, nodesBeforeSplit, 'the reroute point is removed by undo');
  await w.post('redo', {});
  assert.equal((await w.snapshot()).edges.length, 2);

  // Typing a value into an editable output is an edit.
  const value = (await w.post('typed-nodes', {
    node_type: 'custom',
    config: nodes.value('text', 'one'),
    position: {x: 200, y: 0},
  })).id;
  const outputOf = async () =>
    (await nodeOf(value)).config.outputs.find(output => output.id === 'value').default;
  assert.equal(await outputOf(), 'one');
  await w.put('output-values', {node_id: value, values: {value: 'two'}});
  assert.equal(await outputOf(), 'two');
  await w.post('undo', {});
  assert.equal(await outputOf(), 'one', 'an output value is undoable');
  await w.post('redo', {});
  assert.equal(await outputOf(), 'two');

  // The types of a workflow are part of its document.
  const beforeTypes = await app.api('GET', `projects/${id}/types`, {}, w.query);
  await w.put('types', {
    types: [...beforeTypes.types, {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'extra', fields: [], color: '#123456'}],
  });
  assert.equal((await app.api('GET', `projects/${id}/types`, {}, w.query)).types.length, beforeTypes.types.length + 1);
  await w.post('undo', {});
  assert.equal(
    (await app.api('GET', `projects/${id}/types`, {}, w.query)).types.length,
    beforeTypes.types.length,
    'a type change is undoable'
  );

  // Changing a Script's grants changes its configuration, so undo covers it.
  const beforeGrant = (await nodeOf(script)).config.grants;
  await w.put('node-permissions/' + script, {grants: ['graph.read', 'graph.write']});
  assert.deepEqual((await nodeOf(script)).config.grants, ['graph.read', 'graph.write']);
  await w.post('undo', {});
  assert.deepEqual((await nodeOf(script)).config.grants, beforeGrant, 'a grant change is undoable');
});
