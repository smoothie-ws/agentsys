// Ordinary Library graphs. Every operation goes through the same checked API as the canvas.
'use strict';
// The payload of a Library node that is one Script: `{name, inputs, outputs, grants, code, description, folder, icon}`.
// `inputs`/`outputs` are port names or {id, name, type?}. Used by the built-in Graph nodes and by plugins.
function scriptNodePayload({
  name,
  inputs = [],
  outputs = [],
  grants = [],
  code,
  description = '',
  folder = '',
  icon = 'code',
}) {
  const text = 't:64428b9c654c2c2cfcb55742ea899ed8',
    script = 't:a42dbde0c1e1090d6adf1640c2dda533',
    signal = id => ({id, name: id, type: 'signal'}),
    key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    group = 'script-' + key,
    id = 'record:' + group;
  return {
    folder,
    icon,
    description,
    grants,
    bundle: {
      version: 3,
      source_project: 'lib-builtin.' + key,
      types: [
        {id: text.slice(2), name: 'text', color: '#669ed6', fields: [], control: 'textarea'},
        {id: script.slice(2), name: 'script', color: '#8a6fd6', fields: [], control: 'code'},
      ],
      records: [
        {
          id,
          payload: {
            kind: 'function',
            node_type: 'custom',
            label: 'Custom',
            status: 'ready',
            config: {
              title: name,
              op: 'script',
              inputs: [signal('in'), {id: 'script', name: 'script', type: script, default: code}],
              outputs: [signal('out')],
            },
          },
        },
      ],
      groups: [{id: group, name, parent: null, members: [id]}],
      complex: [
        {
          id: group,
          collapsed: true,
          compact_width: 280,
          compact_height: 200,
          arbitrary: {inputs: false, outputs: false},
          interface: {
            inputs: [
              {...signal('in'), bound: [{node_id: id, port_id: 'in'}]},
              ...inputs.map(p => (typeof p === 'string' ? {id: p, name: p, type: text} : p)),
            ],
            outputs: [
              {...signal('out'), bound: [{node_id: id, port_id: 'out'}]},
              ...outputs.map(p => (typeof p === 'string' ? {id: p, name: p} : p)),
            ],
          },
        },
      ],
      port_edges: [],
      positions: {[id]: {x: 0, y: 0}},
      styles: {},
      widgets: {},
    },
  };
}
(() => {
  const text = 't:64428b9c654c2c2cfcb55742ea899ed8';
  function add(name, inputs, outputs, grants, body, description, folder = 'Graph') {
    BUILTIN_NODES.push({
      name,
      payload: scriptNodePayload({
        name,
        inputs,
        outputs,
        grants,
        description,
        folder,
        code: body.toString().slice(body.toString().indexOf('{') + 1, -1),
      }),
    });
  }
  add(
    'Add Node',
    ['resource_id', 'primitive', {id: 'point', name: 'point'}, {id: 'values', name: 'values'}, 'group_id'],
    ['node_id', 'result'],
    ['graph.read', 'graph.write'],
    async function () {
      node.output.node_id = undefined;
      node.output.result = undefined;
      if (Boolean(node.input.resource_id) === Boolean(node.input.primitive))
        throw Error('Choose a Library resource or a native primitive');
      const path = `projects/${context.project_id}`;
      const graph = await agentsys('GET', path + '/workflow');
      const group = node.input.group_id;
      // Without a point the node goes below everything placed so far, so generated nodes do not pile up on one spot.
      const taken = [...graph.nodes, ...graph.complex].map(n => n.position).filter(Boolean);
      const point = node.input.point ?? {x: 0, y: taken.length ? Math.max(...taken.map(q => q.y)) + 240 : 0};
      if (group && !graph.groups.some(g => g.id === group)) throw Error('Group not found');
      const made = node.input.resource_id
        ? await agentsys('POST', path + '/custom-nodes/' + encodeURIComponent(node.input.resource_id), {point})
        : await agentsys('POST', path + '/primitives', {primitive: node.input.primitive, point});
      const id =
        made.id ??
        (made.roots?.length === 1 ? 'complex:' + made.roots[0] : made.ids?.length === 1 ? made.ids[0] : null);
      if (!id) throw Error('Placement must create one node');
      node.output.node_id = id;
      node.output.result = {ok: false, node_id: id};
      // Each new instance has its own checked input defaults. Structured values use ordinary data wires.
      if (node.input.values) await agentsys('PUT', path + '/input-values', {node_id: id, values: node.input.values});
      if (group) {
        const current = await agentsys('GET', path + '/workflow');
        const groups = current.groups.map(({id, name, parent, members, position}) => ({
          id,
          name,
          parent,
          members,
          position,
        }));
        if (id.startsWith('complex:')) groups.find(g => g.id === id.slice(8)).parent = group;
        else groups.find(g => g.id === group).members.push(id);
        await agentsys('PUT', path + '/groups', {groups, if_cursor: current.cursor});
      }
      node.output.node_id = id;
      node.output.result = {ok: true, node_id: id};
    },
    'Place one existing Library node or native primitive; return its actual ID. Without a point it goes below everything placed so far. Inputs retain normal type checks.'
  );
  add(
    'Remove Node',
    ['node_id'],
    ['result'],
    ['graph.write'],
    async function () {
      const id = node.input.node_id;
      if (typeof id !== 'string' || !id) throw Error('Give a node ID');
      const result = id.startsWith('complex:')
        ? await agentsys('DELETE', `projects/${context.project_id}/groups/${encodeURIComponent(id.slice(8))}`)
        : await agentsys('POST', `projects/${context.project_id}/delete-nodes`, {node_ids: [id]});
      node.output.result = {ok: true, ...result};
    },
    'Delete a node through the checked canvas API.'
  );
  add(
    'Connect',
    ['source', 'source_port', 'target', 'target_port', {id: 'connections', name: 'connections'}],
    ['result'],
    ['graph.write'],
    async function () {
      try {
        const add = node.input.connections ?? [
          {
            source: node.input.source,
            source_port: node.input.source_port,
            target: node.input.target,
            target_port: node.input.target_port,
          },
        ];
        const result = await agentsys('POST', `projects/${context.project_id}/port-connections`, {add});
        node.output.result = {ok: true, ...result};
      } catch (error) {
        if (error.control || error.code === 'permission_denied' || error.code === 'execution_cancelled') throw error;
        node.output.result = {ok: false, error: {code: error.code ?? 'invalid_connection', message: error.message}};
      }
    },
    'Connect compatible ports; return {ok, error?}. Permissions and graph validation are unchanged.'
  );
  add(
    'Get Nodes',
    [],
    ['nodes', 'groups'],
    ['graph.read'],
    async function () {
      const graph = await agentsys('GET', `projects/${context.project_id}/workflow`);
      node.output.nodes = [...graph.nodes, ...graph.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'}))];
      node.output.groups = graph.groups;
    },
    'Inspect current nodes, ports, groups and metadata through the canvas snapshot API.'
  );
  add(
    'Invoke Node',
    ['node_id', {id: 'input_port', name: 'input_port', type: text, default: 'in'}],
    ['outputs'],
    ['run.start'],
    async function () {
      const result = await agentsys('POST', `projects/${context.project_id}/execution`, {
        node_ids: [node.input.node_id],
        input_port: node.input.input_port,
        wait: true,
      });
      if (result.dispatch_status !== 'completed')
        throw Error(Object.values(result.errors ?? {})[0] ?? 'Invocation ' + result.dispatch_status);
      node.output.outputs = result.dispatch_outputs[node.input.node_id] ?? {};
    },
    'Signal one native input, await its signal wave and return this dispatch’s outputs. Use separate instances for concurrent calls.'
  );
  add(
    'Set Input',
    ['node_id', {id: 'values', name: 'values'}],
    ['result'],
    ['graph.write'],
    async function () {
      node.output.result = undefined;
      const values = node.input.values;
      if (typeof node.input.node_id !== 'string' || !node.input.node_id) throw Error('Give a node ID');
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw Error('values is an object of input values');
      await agentsys('PUT', `projects/${context.project_id}/input-values`, {node_id: node.input.node_id, values});
      node.output.result = {ok: true, node_id: node.input.node_id};
    },
    'Set the values of inputs of a placed node, by input name. Takes effect for the next invocation.'
  );
  add(
    'Find Library Node',
    ['name'],
    ['resource_id'],
    ['library.read'],
    async function () {
      node.output.resource_id = undefined;
      const items = await agentsys('GET', 'resources');
      const found = items.find(item => item.name === node.input.name);
      if (!found) throw Error('No Library node is named ' + node.input.name);
      node.output.resource_id = found.id;
    },
    'The ID of the Library node with this name, for Add Node.'
  );
  add(
    'Template',
    ['template', {id: 'data', name: 'data'}],
    [{id: 'value', name: 'value'}],
    [],
    async function () {
      const lookup = path =>
        path
          .trim()
          .split('.')
          .reduce(
            (value, key) => {
              if (
                ['__proto__', 'prototype', 'constructor'].includes(key) ||
                value == null ||
                !Object.hasOwn(Object(value), key)
              )
                throw Error('Missing template value: ' + path);
              return value[key];
            },
            {data: node.input.data}
          );
      const template = String(node.input.template ?? '{{data}}');
      const whole = template.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      node.output.value = whole
        ? lookup(whole[1])
        : template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
            const value = lookup(path);
            return typeof value === 'string' ? value : JSON.stringify(value);
          });
    },
    'Fill {{data.path}} placeholders of a text with values of data. A text that is one placeholder gives the value itself.',
    'Data'
  );
  add(
    'Parse JSON',
    ['text', 'schema'],
    [{id: 'value', name: 'value'}],
    [],
    async function () {
      node.output.value = undefined;
      // Models often wrap JSON in one markdown code fence; accept exactly that and nothing else.
      const text = String(node.input.text ?? '')
        .trim()
        .replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i, '$1');
      const value = JSON.parse(text);
      if (node.input.schema) {
        const schema = JSON.parse(node.input.schema);
        const check = (value, rule, path) => {
          const supported = ['type', 'required', 'properties', 'items', 'enum', 'additionalProperties'];
          if (
            !rule ||
            typeof rule !== 'object' ||
            Array.isArray(rule) ||
            Object.keys(rule).some(k => !supported.includes(k))
          )
            throw Error('Unsupported schema at ' + path);
          const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          if (rule.type && !(rule.type === 'integer' ? Number.isInteger(value) : rule.type === kind))
            throw Error(path + ': expected ' + rule.type);
          if (rule.enum && !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
            throw Error(path + ': value is outside enum');
          if (kind === 'object') {
            for (const key of rule.required ?? [])
              if (!Object.hasOwn(value, key)) throw Error(path + ': missing ' + key);
            for (const [key, item] of Object.entries(value)) {
              if (rule.properties?.[key]) check(item, rule.properties[key], path + '.' + key);
              else if (rule.additionalProperties === false) throw Error(path + ': unexpected ' + key);
            }
          }
          if (kind === 'array' && rule.items) value.forEach((item, i) => check(item, rule.items, path + '[' + i + ']'));
        };
        check(value, schema, '$');
      }
      node.output.value = value;
    },
    'Read JSON from text, also when it is wrapped in a markdown code fence. With a schema (type, required, properties, items, enum, additionalProperties) it checks the shape and fails with the path of the mismatch.',
    'Data'
  );
  add(
    'Stringify JSON',
    [{id: 'value', name: 'value'}, 'indent'],
    ['text'],
    [],
    async function () {
      const indent = Number(node.input.indent) || 0;
      node.output.text = JSON.stringify(node.input.value ?? null, null, Math.min(Math.max(indent, 0), 8));
    },
    'Write a value as JSON text.',
    'Data'
  );
  add(
    'Get State',
    ['key'],
    [{id: 'value', name: 'value'}],
    [],
    async function () {
      const key = String(node.input.key ?? '');
      node.output.value = Object.hasOwn(context.state, key) ? context.state[key] : null;
    },
    'Read a key of the workflow\u2019s shared state (context.state). The state is kept across runs and restarts.',
    'Data'
  );
  add(
    'Set State',
    ['key', {id: 'value', name: 'value'}],
    [],
    [],
    async function () {
      const key = String(node.input.key ?? '');
      if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Give a state key');
      context.state[key] = node.input.value;
    },
    'Write a key of the workflow\u2019s shared state (context.state).',
    'Data'
  );
})();
