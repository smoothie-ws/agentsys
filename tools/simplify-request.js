'use strict';
// Update the stored Request graph and its copies without changing their port/instance IDs.
// node tools/simplify-request.js [--apply]  (default: preview, server at AGENTSYS_URL or localhost:8080)
const fs = require('node:fs');
const path = require('node:path');
const TextGraph = require('../js/storage/format');

const REQUEST_ID = '40e1e1d4a4b6fe7cd6dd40cf8ace14cf';
const TEXT = 't:64428b9c654c2c2cfcb55742ea899ed8';
const HTTP_CODE = `const options = node.input.request ?? {
  url: node.input.url,
  method: node.input.method || 'GET',
  headers: node.input.headers,
  body: node.input.body || undefined,
  timeout: node.input.timeout ?? 10000
};
const response = await agentsys('POST', 'net', options);
node.output.status = response.status;
node.output.response = response.text;`;
const PROVIDER_CODE = `const response = await agentsys('POST', 'plugins/ai/call/request', node.input.request);
node.output.status = response.status;
node.output.response = response.text;`;

/** Both Library bundles and editor documents use the same groups/interfaces. */
function simplifyGraph(graph) {
  let changed = false;
  for (const cx of graph.complex ?? []) {
    const endpoint = cx.interface?.inputs.find(port => port.name === 'endpoint');
    if (!endpoint) continue;
    const provider = endpoint.default === 'plugins/ai/call/request';
    if (endpoint.default && !['net', 'plugins/ai/call/request'].includes(endpoint.default))
      throw Error('Unexpected Request transport: ' + endpoint.default);
    const group = graph.groups.find(group => group.id === cx.id);
    const records = graph.records ?? graph.nodes ?? [];
    const members = records.filter(record => group.members.includes(record.id));
    const scripts = members.map(record => (record.payload ?? record).config?.inputs?.find(port => port.id === 'script'))
      .filter(port => typeof port?.default === 'string' && port.default.includes('node.input.endpoint'));
    if (scripts.length !== 1) throw Error('Expected one Request script in group ' + cx.id);
    const removed = cx.interface.inputs.filter(port => provider && !['in', 'request'].includes(port.name) || port === endpoint);
    if ((graph.port_edges ?? []).some(edge => edge.target === 'complex:' + cx.id && removed.some(port => port.id === edge.target_port)))
      throw Error('A removed Request input is connected; migrate its wire explicitly first');
    cx.interface.inputs = cx.interface.inputs.filter(port => !removed.includes(port));
    scripts[0].default = provider ? PROVIDER_CODE : HTTP_CODE;
    if (provider) {
      delete cx.source; // this is AI transport, not an instance of the generic HTTP graph
      group.name = 'Provider request';
      for (const record of members) {
        const config = (record.payload ?? record).config;
        if (config?.inputs?.includes(scripts[0])) config.title = 'Provider request';
      }
    } else {
      for (const port of [{id: 'headers', name: 'headers'}, {id: 'body', name: 'body', type: TEXT}])
        if (!cx.interface.inputs.some(input => input.name === port.name)) cx.interface.inputs.push(port);
    }
    changed = true;
  }
  return changed;
}

function simplifyPackage(original) {
  const pack = structuredClone(original);
  if (!pack?.files?.['nodes/request.json']) return pack;
  const request = JSON.parse(pack.files['nodes/request.json']);
  if (!simplifyGraph(request.payload.bundle)) return pack;
  pack.files['nodes/request.json'] = JSON.stringify(request, null, 2) + '\n';
  pack.files['nodes/ask-request.js'] = PROVIDER_CODE + '\n';
  let build = pack.files['nodes/build.cjs'];
  const oldMerge = "const a=merge(ask,prepare,root),r=merge(ask,request,root,{resource_id:request.id,stamp:request.updated}),z=merge(ask,parse,root);";
  const oldEndpoint = "const rq=r.interface.inputs.find(p=>p.name==='request'),endpoint=r.interface.inputs.find(p=>p.name==='endpoint');endpoint.default='plugins/ai/call/request';";
  if (!build.includes(oldMerge) || !build.includes(oldEndpoint)) throw Error('Unexpected AI catalog builder');
  build = build.replace(oldMerge, `const transport=JSON.parse(JSON.stringify(request));
transport.name='Provider request';
transport.payload.bundle.groups.find(g=>!g.parent).name='Provider request';
transport.payload.bundle.complex[0].interface.inputs=transport.payload.bundle.complex[0].interface.inputs.filter(p=>['in','request'].includes(p.name));
const transportConfig=transport.payload.bundle.records[0].payload.config;
transportConfig.title='Provider request';
transportConfig.inputs.find(p=>p.id==='script').default=read('ask-request');
const a=merge(ask,prepare,root),r=merge(ask,transport,root),z=merge(ask,parse,root);`)
    .replace(oldEndpoint, "const rq=r.interface.inputs.find(p=>p.name==='request');");
  pack.files['nodes/build.cjs'] = build;
  const catalog = TextGraph.decode(JSON.parse(pack.files['nodes/catalog.json']));
  for (const item of catalog) simplifyGraph(item.payload.bundle);
  pack.files['nodes/catalog.json'] = JSON.stringify(TextGraph.encode(catalog), null, 2) + '\n';
  pack.files['README.md'] = pack.files['README.md']
    .replace('Prepare request (Script), Request and Read response (Script)', 'Prepare request (Script), Provider request and Read response (Script)')
    .replace('Request delegates authenticated transport to the plugin;', 'The internal Provider request delegates authenticated transport to the plugin;')
    .replace(/^The packaged Request graph.*$/m, 'The standalone Request graph is generic HTTP: it always calls net, with url, method, headers, body and timeout (or a complete request options object). It has no internal API endpoint selector. Ask uses its own Provider request graph; it is not linked to the standalone Request definition. Update nodes/request.json and rebuild to include later HTTP graph changes.');
  if (pack.manifest.version === '2.3.0') pack.manifest.version = '2.3.1';
  return pack;
}

async function migrate({base = process.env.AGENTSYS_URL || 'http://127.0.0.1:8080', apply = false} = {}) {
  const headers = {'X-AgentSys': '1', 'Content-Type': 'application/json'};
  if (process.env.AGENTSYS_TOKEN) headers.Authorization = 'Bearer ' + process.env.AGENTSYS_TOKEN;
  const call = async (route, body) => {
    const response = await fetch(base + route, {method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined});
    if (!response.ok) throw Error(`${response.status} ${route}`);
    return response.status === 204 ? undefined : response.json();
  };
  const listing = await call('/__data');
  const keys = listing.keys.filter(key => key === 'resources' || key.startsWith('wf:') || ['plugins/index', 'plugins/ai/package'].includes(key));
  const before = Object.fromEntries(await Promise.all(keys.map(async key => [key, await call('/__data/' + encodeURIComponent(key))])));
  const set = {};
  const resources = structuredClone(before.resources);
  if (!resources?.some(item => item.id === REQUEST_ID)) throw Error('Request resource not found');
  const now = Date.now() / 1000;
  for (const resource of resources)
    if (simplifyGraph(resource.payload.bundle)) {
      resource.updated = now;
      if (resource.id === REQUEST_ID) resource.payload.description = 'Make an HTTP request and return its status and response body.';
      set.resources = resources;
    }
  for (const key of keys.filter(key => key.startsWith('wf:'))) {
    const doc = structuredClone(before[key]);
    if (!simplifyGraph(doc)) continue;
    for (const cx of doc.complex ?? []) {
      const resource = resources.find(resource => resource.id === cx.source?.resource_id);
      if (resource) cx.source.stamp = resource.updated;
    }
    doc.cursor = (doc.cursor ?? 0) + 1;
    set[key] = doc;
  }
  if (before['plugins/ai/package']) {
    const pack = simplifyPackage(before['plugins/ai/package']);
    if (JSON.stringify(pack) !== JSON.stringify(before['plugins/ai/package'])) {
      set['plugins/ai/package'] = pack;
      const index = structuredClone(before['plugins/index']);
      const entry = index?.find(plugin => plugin.id === 'ai');
      if (entry) {
        entry.manifest = pack.manifest;
        entry.updated = now;
        set['plugins/index'] = index;
      }
    }
  }
  const changed = Object.keys(set);
  if (!changed.length) return {changed, applied: false};
  if (!apply) return {changed, applied: false};
  // Compare again immediately before committing, so a concurrent editor change is never overwritten.
  for (const key of changed) {
    const current = await call('/__data/' + encodeURIComponent(key));
    if (JSON.stringify(current) !== JSON.stringify(before[key])) throw Error('Data changed while preparing: ' + key);
  }
  const backup = path.join(__dirname, '..', 'data', 'migrations', 'before-http-request-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(backup), {recursive: true});
  fs.writeFileSync(backup, JSON.stringify(Object.fromEntries(changed.map(key => [key, before[key]])), null, 2) + '\n');
  await call('/__data', {set}); // one storage commit announces the updated definitions, editors and package together
  return {changed, applied: true, backup};
}

module.exports = {HTTP_CODE, PROVIDER_CODE, simplifyGraph, simplifyPackage, migrate};
if (require.main === module)
  migrate({apply: process.argv.includes('--apply')}).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
