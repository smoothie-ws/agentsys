'use strict';
// One-time migration: capture actual routes, then enrich the independently maintained contract.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const serverRoot = path.resolve(__dirname, '../../agentsys-server');
const {createApiServer} = require(path.join(serverRoot, 'server/api-server'));
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-spec-'));
  const app = createApiServer({dataDir, token: 'contract-capture'});
  try {
    const base = await app.listen(0);
    const response = await fetch(base + '/api/openapi.json', {headers: {Authorization: 'Bearer contract-capture'}});
    if (!response.ok) throw new Error('Contract capture failed: ' + response.status);
    const spec = await response.json();
    spec.openapi = '3.1.0';
    spec.info = {title: 'AgentSys Public Web API', version: '2.0', description: 'API-major compatibility is independent of client and server application versions. See README.md for event, concurrency and authentication semantics.'};
    spec.servers = [{url: '/'}];
    spec.security = [{bearerAuth: []}, {sessionCookie: []}];
    spec.components = {securitySchemes: {bearerAuth: {type: 'http', scheme: 'bearer'}, sessionCookie: {type: 'apiKey', in: 'cookie', name: 'agentsys_session'}}, schemas: {
      Error: {type: 'object', required: ['error'], properties: {error: {type: 'object', required: ['code', 'message'], properties: {code: {type: 'string'}, message: {type: 'string'}}}}},
      Event: {type: 'object', required: ['type'], properties: {type: {enum: ['ready', 'change', 'hook']}, keys: {type: 'array', items: {type: 'string'}}, by: {type: ['string', 'null']}, protocol: {type: 'integer'}, server_time: {type: 'string', format: 'date-time'}}},
      GraphDocument: {type: 'object', required: ['nodes', 'groups', 'complex', 'port_edges', 'types'], properties: {cursor: {type: 'integer', minimum: 0}, nodes: {type: 'array', items: {type: 'object'}}, groups: {type: 'array', items: {type: 'object'}}, complex: {type: 'array', items: {type: 'object'}}, port_edges: {type: 'array', items: {type: 'object'}}, types: {type: 'array', items: {type: 'object'}}, layout: {type: 'object'}, widgets: {type: 'object'}}}
    }};
    for (const [route, item] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(item)) {
      operation.operationId = method + '_' + route.replace(/[^a-zA-Z0-9]/g, '_');
      for (const code of ['400', '401', '403', '404', '409', '413', '429', '500']) operation.responses[code] = {description: 'Structured API error', content: {'application/json': {schema: {$ref: '#/components/schemas/Error'}}}};
      if (route === '/api/meta') operation.security = [];
    }
    spec.paths['/api/events'].get.responses['200'] = {description: 'Ordered live events; no replay guarantee', content: {'text/event-stream': {schema: {type: 'string'}}}};
    const folder = path.join(serverRoot, 'api');
    fs.mkdirSync(folder, {recursive: true});
    fs.writeFileSync(path.join(folder, 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
    fs.mkdirSync(path.join(folder, 'schemas'), {recursive: true});
    for (const [name, schema] of Object.entries(spec.components.schemas)) fs.writeFileSync(path.join(folder, 'schemas', name + '.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', ...schema}, null, 2) + '\n');
    console.log(Object.keys(spec.paths).length + ' public API paths captured');
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
