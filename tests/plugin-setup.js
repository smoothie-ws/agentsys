'use strict';
// A real server with a temporary data folder and plugins folder, and a small client for its API.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createServer} = require('../server');

const write = (dir, id, source) => {
  fs.mkdirSync(path.join(dir, id), {recursive: true});
  fs.writeFileSync(path.join(dir, id, 'main.js'), source);
};
async function withServer(plugins, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-plugins-')),
    pluginsDir = path.join(root, 'data', 'plugins');
  for (const [id, source] of Object.entries(plugins)) write(pluginsDir, id, source);
  const server = createServer({dataDir: path.join(root, 'data')});
  const base = await server.listen(0);
  const call = async (method, route, payload, query = {}) => {
    const url = new URL('/api/' + route, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await fetch(url, {
      method,
      headers: {'X-AgentSys': '1', 'Content-Type': 'application/json'},
      body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    });
    const text = await response.text();
    return {status: response.status, body: text ? JSON.parse(text) : undefined};
  };
  try {
    await body({call, pluginsDir});
  } finally {
    await server.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
}

const CODE_TYPE = 'c0de0c0de0c0de0c0de0c0de0c0de0c0';
/** A project with one Script (with the given grants) and the means to run and stop it; `run` answers `context.state`. */
async function scriptRunner(call, code, grants, allow = ['graph.read', 'plugins.call']) {
  await call('PUT', 'settings', {developer_mode: true});
  const project = (await call('POST', 'projects', {name: 'P'})).body;
  // The Library may already have a code type (a plugin's node brings one); use it, else add one.
  let types = (await call('GET', `projects/${project.id}/types`)).body.types;
  if (!types.some(t => t.control === 'code')) {
    types = [...types, {id: CODE_TYPE, name: 'code', color: '#8a6fd6', fields: [], control: 'code'}];
    await call('PUT', `projects/${project.id}/types`, {types});
  }
  const codeType = types.find(t => t.control === 'code').id;
  await call('PUT', `projects/${project.id}/policy`, {allow});
  const node = (
    await call('POST', `projects/${project.id}/typed-nodes`, {
      node_type: 'custom',
      config: {
        title: 'S',
        op: 'script',
        grants,
        inputs: [
          {id: 'in', name: 'in', type: 'signal'},
          {id: 'script', name: 'script', type: 't:' + codeType, default: code},
        ],
        outputs: [{id: 'out', name: 'out', type: 'signal'}],
      },
    })
  ).body;
  const base = `projects/${project.id}/execution`;
  return {
    project,
    node,
    start: () => call('POST', base, {node_ids: [node.id]}),
    run: async () => {
      await call('POST', base, {node_ids: [node.id], wait: true});
      return (await call('GET', base)).body.state;
    },
    stop: () => call('DELETE', base),
  };
}

module.exports = {write, withServer, scriptRunner};
