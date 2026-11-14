'use strict';
// The text-graph format with generated documents: whatever the editor stores must survive encode -> files ->
// decode unchanged, and a damaged or hostile packet must be refused with an error rather than half-read.
const test = require('node:test'),
  assert = require('node:assert/strict');
const TextGraph = require('../js/storage/format');

/** A small deterministic generator: the same seed always builds the same documents. */
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = list => list[int(0, list.length - 1)];
  const text = () =>
    pick(['', 'plain', 'with space', 'quote " and \' apostrophe', 'tab\tnewline\n', '<script>', 'émoji 😀', '\\backslash', '{"json": "inside"}', 'a'.repeat(int(0, 40))]);
  const value = depth => {
    const kind = depth > 3 ? pick(['string', 'number', 'bool', 'null']) : pick(['string', 'number', 'bool', 'null', 'array', 'object']);
    if (kind === 'string') return text();
    if (kind === 'number') return pick([0, -1, 42, 3.5, 1e6, -0.25]);
    if (kind === 'bool') return next() < 0.5;
    if (kind === 'null') return null;
    if (kind === 'array') return Array.from({length: int(0, 4)}, () => value(depth + 1));
    const object = {};
    for (let i = 0; i < int(0, 4); i++) object[pick(['a', 'b', 'c', 'id', 'name', 'x y', 'x.y'])] = value(depth + 1);
    return object;
  };
  return {next, int, pick, text, value};
}

function document(seed) {
  const r = random(seed);
  const id = () => (r.next() < 0.5 ? 'record:' + r.int(100000, 999999).toString(16) : 'complex:' + r.int(100000, 999999).toString(16));
  const node = () => ({
    id: id(),
    kind: r.pick(['function', 'value']),
    node_type: r.pick(['custom', undefined]),
    config: r.next() < 0.15 ? {op: 'script', title: 'Script', default: r.text()} : r.value(1),
    label: r.text(),
    status: r.pick(['ready', 'completed', 'failed']),
    position: {x: r.int(-500, 500), y: r.int(-500, 500)},
    ...(r.next() < 0.1 ? {disabled: true} : {}),
    ...(r.next() < 0.1 ? {color: '#aabbcc'} : {}),
  });
  const group = () => ({
    id: id(),
    name: r.text(),
    members: Array.from({length: r.int(0, 3)}, id),
    parent: r.next() < 0.5 ? null : id(),
    layout: {x: r.int(0, 400), y: r.int(0, 400), width: r.int(50, 400), height: r.int(50, 400)},
  });
  const doc = {
    nodes: Array.from({length: r.int(0, 6)}, node),
    port_edges: Array.from({length: r.int(0, 6)}, () => ({
      id: 'port:' + r.int(1, 999).toString(16),
      source: id(),
      source_port: r.pick(['out', 'value', 'in']),
      target: id(),
      target_port: r.pick(['in', 'value', 'out']),
    })),
    groups: Array.from({length: r.int(0, 3)}, group),
    complex: Array.from({length: r.int(0, 2)}, () => ({
      id: id(),
      interface: {inputs: r.value(2), outputs: r.value(2)},
      source: {resource_id: r.int(1, 99).toString(16), stamp: r.int(1, 1e6)},
      members: [id(), id()],
    })),
    types: Array.from({length: r.int(0, 3)}, () => ({id: r.int(1, 99).toString(16), name: r.text(), fields: r.value(2), color: '#123456'})),
    widgets: {[id()]: r.value(2)},
    layout: {[id()]: {x: r.int(0, 500), y: r.int(0, 500)}},
    cursor: r.int(0, 50),
    runtime: {some: 'opaque value', nested: r.value(1)},
    note: r.text(),
  };
  return doc;
}

const plain = value => JSON.parse(JSON.stringify(value));

// The format canonicalises the order of these collections and the keys of every object; equality is modulo that.
const SORTED = new Set(['nodes', 'records', 'groups', 'complex', 'port_edges', 'types']);
function canonical(value, key = '') {
  if (key === 'runtime') return value;
  if (Array.isArray(value)) {
    const items = value.map(item => canonical(item, ''));
    return SORTED.has(key) ? items.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en')) : items;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name], name)]));
  return value;
}

test('generated documents survive encode and decode unchanged', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const source = plain(document(seed));
    const packet = TextGraph.encode(source);
    assert.equal(packet.format, TextGraph.FORMAT);
    for (const [name, text] of Object.entries(packet.files)) {
      assert.match(name, /^(graph\.json|layout\.json|scripts\/[A-Za-z0-9_-]+\.js)$/, `seed ${seed}: ${name}`);
      assert.equal(typeof text, 'string');
    }
    // Every packet the encoder makes is one the decoder accepts: no unreferenced file, no missing script.
    const decoded = plain(TextGraph.decode(packet));
    assert.deepEqual(canonical(decoded), canonical(source), `seed ${seed}`);
    assert.deepEqual(TextGraph.encode(decoded), packet, `seed ${seed} is already canonical`);
    assert.deepEqual(TextGraph.encode(decoded), packet, `seed ${seed} is canonical`);
  }
});

test('a script default becomes a real file and comes back as the same code', () => {
  const source = {
    nodes: [
      {id: 'n1', config: {op: 'script', title: 'Script', inputs: [{id: 'script', name: 'script', default: 'node.output.text = "x";'}]}},
    ],
    port_edges: [],
    groups: [],
    complex: [],
    types: [],
    layout: {},
  };
  const packet = TextGraph.encode(source);
  const scripts = Object.keys(packet.files).filter(name => name.startsWith('scripts/'));
  assert.equal(scripts.length, 1);
  assert.equal(packet.files[scripts[0]], 'node.output.text = "x";');
  assert.match(packet.files['graph.json'], /\$script/);
  assert.deepEqual(plain(TextGraph.decode(packet)), source);
});

test('a damaged packet is refused, including hostile layout paths', () => {
  const source = {nodes: [], port_edges: [], groups: [], complex: [], types: [], layout: {}};
  const packet = () => TextGraph.encode(source);
  const broken = [
    ['not a packet', null],
    ['wrong format', {format: 'other/1', files: {}}],
    ['missing files', {format: TextGraph.FORMAT}],
    ['files is a list', {format: TextGraph.FORMAT, files: []}],
  ];
  for (const [label, value] of broken) assert.throws(() => TextGraph.decode(value), Error, label);

  const extra = packet();
  extra.files['scripts/orphan.js'] = 'unused';
  assert.throws(() => TextGraph.decode(extra), /Unreferenced|Missing/);

  const missing = packet();
  missing.files['graph.json'] = JSON.stringify({format: TextGraph.FORMAT, value: {nodes: [{config: {$script: 'scripts/none.js'}}]}});
  assert.throws(() => TextGraph.decode(missing), /script/i);

  const wrongFile = packet();
  wrongFile.files['../escape.json'] = '{}';
  assert.throws(() => TextGraph.decode(wrongFile), /Invalid text file/);

  const proto = packet();
  proto.files['layout.json'] = JSON.stringify({[JSON.stringify(['value', '__proto__', 'layout'])]: {polluted: true}});
  assert.throws(() => TextGraph.decode(proto), /Invalid layout path/);
  assert.equal({}.polluted, undefined, 'nothing was polluted');

  const badParent = packet();
  badParent.files['layout.json'] = JSON.stringify({[JSON.stringify(['value', 'missing', 'layout'])]: {}});
  assert.throws(() => TextGraph.decode(badParent), /Invalid layout parent/);

  const badKey = packet();
  badKey.files['layout.json'] = JSON.stringify({[JSON.stringify(['value', 'note'])]: {}});
  assert.throws(() => TextGraph.decode(badKey), /Invalid layout key/);
});

test('runtime state is opaque: it is stored inline and never mined for scripts or layout', () => {
  const source = {
    nodes: [{id: 'n1', config: {op: 'script', inputs: [{id: 'script', name: 'script', default: 'first'}]}}],
    runtime: {config: {op: 'script', default: 'must not be a file'}, layout: {x: 1, y: 2}},
    port_edges: [],
    groups: [],
    complex: [],
    types: [],
    layout: {},
  };
  const packet = TextGraph.encode(source);
  const scripts = Object.keys(packet.files).filter(name => name.startsWith('scripts/'));
  assert.equal(scripts.length, 1, 'only the real Script default is extracted');
  assert.deepEqual(plain(TextGraph.decode(packet)), plain(source));
});
