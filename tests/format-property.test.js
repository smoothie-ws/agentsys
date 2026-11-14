'use strict';
// Property tests for the canonical graph format: whatever a valid document contains, encoding it and decoding the
// packet returns an equivalent document, and the encoding is stable when repeated. A deterministic PRNG keeps a
// failure reproducible without a fixture.
const test = require('node:test'),
  assert = require('node:assert/strict');
const TextGraph = require('../js/storage/format');

let seed = 0x5eed1234;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(random() * list.length)];
const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
const text = () => 'v' + integer(0, 999) + ' ' + pick(['alpha', 'beta', 'a/b', '100%', 'line\nbreak']);
const id = () => 'id' + integer(0, 100000);

function value(depth = 0) {
  const kind = depth > 3 ? pick(['string', 'number', 'boolean', 'null']) : pick(['string', 'number', 'boolean', 'null', 'array', 'object']);
  if (kind === 'string') return text();
  if (kind === 'number') return integer(-1000, 1000) / 10;
  if (kind === 'boolean') return random() < 0.5;
  if (kind === 'null') return null;
  if (kind === 'array') return Array.from({length: integer(0, 4)}, () => value(depth + 1));
  return Object.fromEntries(Array.from({length: integer(0, 5)}, () => ['k' + integer(0, 20), value(depth + 1)]));
}

function document() {
  const nodes = Array.from({length: integer(0, 8)}, () => ({
    id: id(),
    config: {title: text(), ...(random() < 0.4 ? {op: 'script', inputs: [{id: 'script', default: text()}]} : {})},
    position: {x: integer(-500, 500), y: integer(-500, 500)},
    ...(random() < 0.3 ? {layout: {width: integer(1, 300), height: integer(1, 200)}} : {}),
  }));
  return {
    root: nodes[0]?.id ?? null,
    nodes,
    groups: Array.from({length: integer(0, 3)}, () => ({id: id(), name: text(), members: nodes.map(node => node.id)})),
    edges: Array.from({length: integer(0, 5)}, () => ({id: id(), source: id(), target: id()})),
    widgets: random() < 0.5 ? {[id()]: [{id: id(), kind: 'text', value: value()}]} : {},
    positions: {[id()]: {x: integer(-9, 9), y: integer(-9, 9)}},
    runtime: {state: value(), outputs: value()},
    extra: value(),
  };
}

test('encode/decode is an equivalence and the canonical form is stable', () => {
  for (let round = 0; round < 120; round++) {
    const original = document();
    const packet = TextGraph.encode(original);
    assert.equal(packet.format, TextGraph.FORMAT);
    const decoded = TextGraph.decode(packet);
    // The format sorts the collections it declares; comparing canonical forms is the real invariant.
    assert.equal(TextGraph.canonical(decoded), TextGraph.canonical(original), 'document ' + round + ' round trip');
    assert.deepEqual(TextGraph.encode(decoded), packet, 'encoding is idempotent');
  }
});

test('a script default becomes a sidecar file and comes back as text, including unusual characters', () => {
  for (let round = 0; round < 60; round++) {
    const code = `node.display(${JSON.stringify(text())});\n// ${round}`;
    const doc = {nodes: [{id: 'n1', config: {op: 'script', inputs: [{id: 'script', default: code}]}}]};
    const packet = TextGraph.encode(doc);
    assert.equal(packet.files['graph.json'].includes(JSON.stringify(code)), false, 'the code is not inline JSON');
    assert.equal(TextGraph.decode(packet).nodes[0].config.inputs[0].default, code);
  }
});

test('malformed packets fail with an error and never return a partial document', () => {
  const packet = TextGraph.encode({nodes: [{id: 'n1', config: {op: 'script', inputs: [{id: 'script', default: 'x'}]}}]});
  const clone = () => JSON.parse(JSON.stringify(packet));
  const cases = [
    p => delete p.files['graph.json'],
    p => (p.files['layout.json'] = '{"0":1}'),
    p => (p.files['layout.json'] = '{"0":["value","nodes"]}'),
    p => (p.files['extra.txt'] = 'x'),
    p => (p.files['scripts/../../etc/passwd.js'] = 'x'),
    p => (p.files['graph.json'] = p.files['graph.json'].replace('"$script"', '"other"')),
    p => (p.files['layout.json'] = JSON.stringify([['__proto__', 'x']])),
    p => (p.files['layout.json'] = JSON.stringify([['value', 'nodes', 'constructor', 'prototype']])),
  ];
  for (const mutate of cases) {
    const broken = clone();
    mutate(broken);
    assert.throws(() => TextGraph.decode(broken));
  }
});
