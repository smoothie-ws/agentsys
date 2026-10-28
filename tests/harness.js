'use strict';
// Loads the browser-free half of the app (storage, model, backend) into a Node vm context so the API can be
// tested without a browser. The loader lives in headless.js (it is also what the server runs); the script list is
// read from index.html, so new files only need to be added there.
const path = require('node:path');
const {loadBackend} = require('../headless');

const root = path.resolve(process.env.AGENTSYS_ROOT || path.join(__dirname, '..'));

// The types the nodes below use: a workflow needs them to hold a typed-in value (the code of a Script, the value of a Value node).
// createApp links them to a workflow when a node that uses one is made there.
const TYPES = {
  code: {id: 'c0de0c0de0c0de0c0de0c0de0c0de0c0', name: 'test code', color: '#8a6fd6', fields: [], control: 'code'},
  text: {id: '7e87000000000000000000000000007e', name: 'test text', color: '#669ed6', fields: [], control: 'textarea'},
  number: {
    id: '40000000000000000000000000000040',
    name: 'test number',
    color: '#dd8136',
    fields: [],
    control: 'number',
  },
  bool: {id: 'b001000000000000000000000000b001', name: 'test bool', color: '#2de18a', fields: [], control: 'checkbox'},
};
const ref = type => 't:' + TYPES[type].id;
const TEST_PERMISSIONS = [
  'graph.read',
  'graph.write',
  'library.read',
  'library.write',
  'initiative.read',
  'initiative.write:*',
  'llm.call:*',
  'net.fetch:*',
  'run.read',
  'run.start',
  'approval.request',
];

/** A fresh, empty application (new in-memory database) with a Backend and a way to run the code of Scripts in Node. */
function createApp({scripts = 'inline', developer = true, store = null} = {}) {
  const {Backend, context, eval: evaluate, workerStats} = loadBackend({root, scripts, store});
  // Results are copied out of the vm context so assert.deepEqual compares plain objects of this realm.
  // Developer mode is on unless a test asks otherwise: most tests build Custom nodes.
  const ready = developer ? Backend.request('PUT', 'settings', {body: {developer_mode: true}, query: {}}) : null;
  const request = async (method, url, body, query) => {
    await ready;
    const result = await Backend.request(method, url, {body: body ?? {}, query: query ?? {}});
    if (method === 'POST' && ['projects', 'projects/import'].includes(url))
      await Backend.request('PUT', `projects/${result.id}/policy`, {body: {allow: TEST_PERMISSIONS}});
    return result === undefined ? result : JSON.parse(JSON.stringify(result));
  };
  const api = async (method, url, body, query) => {
    const made = /^projects\/([^/]+)\/typed-nodes(\/|$)/.exec(url);
    if (made && body && method !== 'GET') {
      const text = JSON.stringify(body),
        used = Object.values(TYPES).filter(t => text.includes(t.id)),
        q = {workflow_id: body.workflow_id};
      if (used.length) {
        const have = (await request('GET', `projects/${made[1]}/types`, {}, q)).types;
        const missing = used.filter(t => !have.some(h => h.id === t.id));
        if (missing.length) await request('PUT', `projects/${made[1]}/types`, {...q, types: [...have, ...missing]});
      }
    }
    return request(method, url, body, query);
  };
  return {api, context, Backend, eval: evaluate, workerStats};
}

/**
 * Configurations of Custom nodes for building graphs in tests. `nodes.value('text', 'hi')` holds a value on its `value` output
 * (strings, numbers and booleans); `nodes.script(code)` is a Script (In and its code, nothing else; give it data with `fn`);
 * `nodes.run()` is an on_run with `Out` and `payload`.
 */
const signal = (id, name) => ({id, name, type: 'signal'});
const nodes = {
  value: (_type, value) => {
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'text';
    return {
      title: 'Value',
      inputs: [],
      outputs: [{id: 'value', name: 'value', type: ref(type), editable: true, default: value ?? ''}],
    };
  },
  // A Script: the signal input In and its code (the default of an untyped `script` input, so it does not bring a type that clashes with the built-in ones). Nothing else.
  script: code => ({
    capabilities: TEST_PERMISSIONS,
    grants: TEST_PERMISSIONS,
    origin: 'human',
    title: 'Script',
    op: 'script',
    inputs: [signal('in', 'In'), {id: 'script', name: 'script', type: ref('code'), default: code}],
    outputs: [],
  }),
  /** An event node: `nodes.event('on_run')`, with the data outputs it carries. */
  event: (op, data = []) => ({
    title: op,
    op,
    inputs: [],
    outputs: [signal('out', 'Out'), ...data.map(name => ({id: name, name}))],
  }),
  run: () => nodes.event('on_run', ['payload']),
};

/**
 * Makes an on_run node on a workflow and wires its signal through `steps` one after another (a node ID, or [node ID, input port, output port]
 * for a node whose signal ports are not called `in` and `out`). Answers the ID of the on_run node: evaluating it runs the chain.
 */
async function flow(app, project, workflow, steps) {
  const start = await app.api('POST', `projects/${project}/typed-nodes`, {
    ...workflow,
    node_type: 'custom',
    config: nodes.run(),
    position: {x: 0, y: 0},
  });
  let from = [start.id, 'out'];
  for (const step of steps) {
    const [id, input = 'in', output = 'out'] = Array.isArray(step) ? step : [step];
    await app.api('POST', `projects/${project}/port-connections`, {
      ...workflow,
      add: [{source: from[0], source_port: from[1], target: id, target_port: input}],
    });
    from = [id, output];
  }
  return start.id;
}

const hex = text => require('node:crypto').createHash('md5').update(text).digest('hex');
/**
 * A Library node bundle made of the Custom nodes `members` ({key: config}; the first is the body that holds the slots that no inner node
 * uses), the signal and data `wires` ([from key, port, to key, port]) and the ports of the node: `inputs` / `outputs` are
 * [{id, name, type?, node: key, port}] bound to inner ports. Use it with `place`.
 */
function bundleOf(
  name,
  members,
  {
    wires = [],
    inputs = [],
    outputs = [],
    arbitrary = {inputs: false, outputs: false},
    types = [],
    widgets = {},
    folder,
    icon,
  } = {}
) {
  // Widgets are declared on the node that holds them (config.widgets), which creates them in every copy.
  members = Object.fromEntries(
    Object.entries(members).map(([key, config]) => [key, widgets[key] ? {...config, widgets: widgets[key]} : config])
  );
  const used = Object.values(TYPES).filter(t => JSON.stringify(members).includes(t.id));
  types = [...types, ...used.filter(t => !types.some(h => h.id === t.id))];
  const keys = Object.keys(members),
    id = key => 'record:' + hex(name + ':' + key),
    gid = hex('group:' + name);
  // A slot is bound to a port of one of the nodes (the first by default); `node: false` leaves it free (a Script of the group reads it by name).
  // `to: [[key, port], ...]` binds an input to several ports (it feeds them all).
  const bound = list =>
    list.map(({node, port, to, ...p}) =>
      to
        ? {...p, bound: to.map(([key, portId]) => ({node_id: id(key), port_id: portId}))}
        : node === false
          ? p
          : {...p, bound: [{node_id: id(node ?? keys[0]), port_id: port ?? p.id}]}
    );
  const bundle = {
    version: 3,
    source_project: 'lib-' + hex(name),
    types,
    records: keys.map((key, i) => ({
      id: id(key),
      payload: {
        kind: 'function',
        node_type: 'custom',
        config: {title: key, ...members[key]},
        label: 'Custom',
        status: 'ready',
      },
    })),
    positions: Object.fromEntries(keys.map((key, i) => [id(key), {x: i * 300, y: 24}])),
    port_edges: wires.map(([from, source_port, to, target_port], i) => ({
      id: 'w' + i,
      source: id(from),
      source_port,
      target: id(to),
      target_port,
    })),
    widgets: {},
    styles: Object.fromEntries(keys.map(key => [id(key), {pinned: false, color: null, folded: false}])),
    groups: [{id: gid, name, parent: null, members: keys.map(id), color: null, pinned: false, folded: false}],
    complex: [
      {
        id: gid,
        interface: {inputs: bound(inputs), outputs: bound(outputs)},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
        arbitrary,
      },
    ],
  };
  return {name, bundle, icon, folder};
}
/** Saves a bundle (see bundleOf) in the Library and places it on a workflow; answers {resource, group, node(key or title): the placed node}. */
async function place(
  app,
  project,
  workflow,
  {name, bundle, capabilities = TEST_PERMISSIONS, grants = capabilities, origin = 'human'}
) {
  const item = await app.api('POST', 'resources', {
    kind: 'custom_node',
    name,
    payload: {bundle, capabilities, grants, origin, description: '', frame: {dx: 0, dy: 0, width: 300, height: 200}},
  });
  const placed = await app.api('POST', `projects/${project}/custom-nodes/${item.id}`, {
    ...workflow,
    point: {x: 0, y: 0},
  });
  const group = placed.roots[0];
  return {
    resource: item.id,
    group,
    id: 'complex:' + group,
    node: async title =>
      (await app.api('GET', `projects/${project}/workflow`, {}, workflow)).nodes.find(n => n.config?.title === title),
  };
}

let counter = 0;
/** The code that turns the inputs of a fn() whose names can be variables into constants: `const {a, b} = node.input;`. */
const unpack = inputs => {
  const names = inputs
    .map(n => (typeof n === 'string' ? n : n.name))
    .filter(n => /^[A-Za-z_$][\w$]*$/.test(n) && !['in', 'class'].includes(n));
  return names.length ? `const {${names.join(', ')}} = node.input;\n` : '';
};
/** A free slot of a fn(): a name, or {name, type, ...}. */
const slot = n => (typeof n === 'string' ? {id: n, name: n, node: false} : {id: n.name, node: false, ...n});
/**
 * A Library node around one Script, placed on a workflow: the way to give a Script data in tests. `inputs` are the names of its data inputs
 * (free: the Script reads them as variables), `outputs` the free data outputs it sets, `signals` the free signal outputs it fires with emit;
 * the signal input `In` of the node is bound to the Script. Wire to the node by those names (port IDs are the names).
 * Answers {id: the Script's node ID (evaluate it to run it: its outputs are those of the Library node), wrapper: the Library node's ID,
 * group, step: [wrapper, 'in', first signal] for `flow`, node(title)}.
 */
async function fn(
  app,
  project,
  workflow,
  {
    code = '',
    inputs = [],
    outputs = [],
    signals = [],
    members = {},
    widgets = {},
    capabilities = TEST_PERMISSIONS,
    grants = capabilities,
    origin = 'human',
    name = 'Fn' + ++counter + Math.random().toString(36).slice(2, 6),
  } = {}
) {
  const def = bundleOf(
    name,
    {Body: {inputs: [], outputs: []}, Script: {...nodes.script(unpack(inputs) + code), title: 'Script'}, ...members},
    {
      widgets,
      inputs: [{id: 'in', name: 'In', type: 'signal', node: 'Script', port: 'in'}, ...inputs.map(slot)],
      outputs: [...outputs.map(slot), ...signals.map(n => ({id: n, name: n, type: 'signal', node: false}))],
    }
  );
  const placed = await place(app, project, workflow, {...def, capabilities, grants, origin});
  const snapshot = await app.api('GET', `projects/${project}/workflow`, {}, workflow),
    inside = snapshot.complex.find(c => c.id === placed.group).members;
  const script = snapshot.nodes.find(n => inside.includes(n.id) && n.config?.title === 'Script');
  return {
    id: script.id,
    wrapper: placed.id,
    group: placed.group,
    resource: placed.resource,
    step: [placed.id, 'in', signals[0] ?? 'out'],
    node: placed.node,
  };
}

module.exports = {createApp, nodes, flow, bundleOf, place, fn, TYPES, ref};
