'use strict';
// The optional server-wide egress allowlist: on top of a Script's net.fetch grant, a deployment can restrict which
// hosts this server will contact. It applies to the HTTP route and to a Script's call, which share the same route.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {createApp, nodes} = require('./harness');

const TOKEN = 'net-token';
const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

async function withApi(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-net-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const net = (base, url) => fetch(base + '/api/net', {method: 'POST', headers, body: JSON.stringify({url})});

test('without an allowlist the server tries the host and reports the network failure', async () => {
  await withApi({}, async ({base}) => {
    const response = await net(base, 'http://127.0.0.1:2/');
    assert.notEqual(response.status, 403, 'no allowlist refusal');
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.features.net_allowlist, false);
  });
});

test('with an allowlist only the named hosts are contacted, and the refusal names them', async () => {
  await withApi({allowedNetHosts: ['127.0.0.1:1', '*.example.test']}, async ({base}) => {
    const allowed = await net(base, 'http://127.0.0.1:1/');
    assert.notEqual(allowed.status, 403, 'an allowed host reaches the network layer (and fails to connect)');
    const denied = await net(base, 'http://127.0.0.1:2/');
    assert.equal(denied.status, 403);
    const body = await denied.json();
    assert.equal(body.error.code, 'permission_denied');
    assert.match(body.error.message, /127\.0\.0\.1:1/);
    // A wildcard matches subdomains only, not a lookalike suffix.
    const allowedWildcard = await net(base, 'https://api.example.test/');
    assert.notEqual(allowedWildcard.status, 403);
    const lookalike = await net(base, 'https://example.test.evil.invalid/');
    assert.equal(lookalike.status, 403);
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.features.net_allowlist, true);
  });
});

test('a Script obeys the same allowlist even with a net.fetch grant', async () => {
  const app = createApp({scripts: 'inline', allowedNetHosts: ['127.0.0.1:1']});
  try {
    const {id} = await app.api('POST', 'projects', {name: 'Egress'});
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      workflow_id: id,
      node_type: 'custom',
      config: nodes.script(`try { await agentsys("POST", "net", {url: "http://127.0.0.1:2/"}); }
        catch (error) { node.display(error.message); }`),
    });
    const run = await app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: [script.id], wait: true});
    const shown = Object.values(run.displays || {}).join(' ');
    assert.match(shown, /does not fetch 127\.0\.0\.1:2/);
  } finally {
    await app.Backend.shutdownExecutions();
  }
});
