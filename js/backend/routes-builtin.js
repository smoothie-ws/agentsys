// The built-in Library: nodes that come with the app (builtin-nodes.js). They are ordinary Library nodes once added: a person can edit,
// move or delete them. A node is added only if the Library has no node of that name and the person has not deleted it before
// (`builtin` remembers which were added); "restore" adds the missing ones again. The editor asks for this at start.
'use strict';

const BUILTIN = 'builtin';
const builtinId = name => 'builtin.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

route(
  'GET POST',
  'library/builtin',
  'List the built-in nodes, or add the ones the Library lacks',
  async c => {
    const items = await c.ctx.get('resources', []),
      state = await c.ctx.get(BUILTIN, {added: []}),
      added = new Set(state.added),
      restore = c.method === 'POST' && c.body.restore === true,
      made = [];
    if (c.method === 'GET')
      return BUILTIN_NODES.map(n => ({name: n.name, folder: n.payload.folder || '', installed: items.some(r => r.name === n.name)}));
    for (const node of BUILTIN_NODES) {
      const id = builtinId(node.name);
      if (items.some(r => r.name === node.name)) {
        added.add(id);
        continue;
      }
      if (added.has(id) && !restore) continue; // the person deleted it
      saveResource(c, items, null, node.name, clone(node.payload), id);
      added.add(id);
      made.push(node.name);
    }
    state.added = [...added].sort();
    c.ctx.set(BUILTIN, state);
    return {added: made, total: BUILTIN_NODES.length};
  },
  {body: {restore: false}}
);
