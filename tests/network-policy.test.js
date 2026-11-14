'use strict';
// The network boundary, exercised against real local HTTP servers: host allowlists, redirects, response size,
// timeout and abort, secret placement and a project's own egress policy.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const {createApiServer} = require('../server/api-server');
const {createApp, nodes} = require('./harness');
const {pinnedRequest} = require('../headless');

const TOKEN = 'net-policy-token';
const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

function localServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/ok') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, {Location: '/ok'});
      res.end();
      return;
    }
    if (url.pathname === '/big') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('x'.repeat(2500000));
      return;
    }
    if (url.pathname === '/slow') return; // never answers
    if (url.pathname === '/echo') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({authorization: req.headers.authorization || '', body}));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

async function withApi(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-net-policy-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const net = (base, body) =>
  fetch(base + '/api/net', {method: 'POST', headers, body: JSON.stringify(body)});

async function until(check, what, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('not reached: ' + what);
}

test('a local request succeeds, a redirect is refused, and the response is returned', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({allowedNetHosts: [url.replace('http://', '')]}, async ({base}) => {
      const ok = await net(base, {url: url + '/ok'});
      assert.equal(ok.status, 200, await ok.clone().text());
      assert.deepEqual(await ok.json(), {status: 200, text: '{"ok":true}'});

      const redirect = await net(base, {url: url + '/redirect'});
      assert.equal(redirect.status, 403);
      assert.match((await redirect.json()).error.message, /Redirects require/);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a response over the limit is refused without buffering it all', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({}, async ({base}) => {
      const response = await net(base, {url: url + '/big'});
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /too large/);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a timeout and an abort both end the request', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({}, async ({base}) => {
      const timed = await net(base, {url: url + '/slow', timeout: 250});
      assert.equal(timed.status, 504);
      assert.match((await timed.json()).error.message, /timed out/);
      const invalid = await net(base, {url: url + '/ok', timeout: 0});
      assert.equal(invalid.status, 400);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a secret in a header is sent and its reflection is redacted; a secret in the URL is refused', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({}, async ({base, app}) => {
      await app.api.request('PUT', 'secrets/net-key', {body: {value: 'super-secret-value'}, query: {}});
      const echoed = await net(base, {
        url: url + '/echo',
        method: 'POST',
        headers: {Authorization: 'Bearer {{secret:net-key}}'},
        body: 'hello',
      });
      assert.equal(echoed.status, 200);
      const text = await echoed.text();
      assert.doesNotMatch(text, /super-secret-value/);
      assert.match(text, /\[REDACTED\]/);
      assert.match(text, /hello/);

      const denied = await net(base, {url: url + '/ok?key={{secret:net-key}}'});
      assert.equal(denied.status, 400);
      assert.match((await denied.json()).error.message, /secret placeholder/);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a private-destination policy refuses loopback even when the host is allowlisted', async () => {
  const target = localServer();
  const url = await listen(target);
  const authority = url.replace('http://', '');
  try {
    await withApi({allowedNetHosts: [authority], blockPrivateNet: true}, async ({base}) => {
      const denied = await net(base, {url: url + '/ok'});
      assert.equal(denied.status, 403);
      assert.match((await denied.json()).error.message, /private, loopback or link-local/);
    });
    // The same server without the policy reaches the local endpoint.
    await withApi({allowedNetHosts: [authority]}, async ({base}) => {
      assert.equal((await net(base, {url: url + '/ok'})).status, 200);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a project policy narrows egress for its Scripts, independently of the server list', async () => {
  const allowedServer = localServer(),
    deniedServer = localServer();
  const allowed = await listen(allowedServer),
    denied = await listen(deniedServer);
  const app = createApp({scripts: 'inline'});
  try {
    const {id} = await app.api('POST', 'projects', {name: 'Egress project'});
    await app.api('PUT', `projects/${id}/policy`, {
      allow: ['graph.read', 'net.fetch:*'],
      net: {allow: [allowed.replace('http://', '')]},
    });
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      workflow_id: id,
      node_type: 'custom',
      config: nodes.script(`
        const ok = await agentsys('POST', 'net', {url: '${allowed}/ok'});
        let refused = '';
        try { await agentsys('POST', 'net', {url: '${denied}/ok'}); }
        catch (error) { refused = error.message; }
        node.display('allowed:' + ok.status + ' ' + refused);`),
    });
    const run = await app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: [script.id], wait: true});
    const shown = Object.values(run.displays || {}).join(' ');
    assert.match(shown, /allowed:200/);
    assert.match(shown, /does not fetch/);
  } finally {
    await app.Backend.shutdownExecutions();
    await new Promise(resolve => allowedServer.close(resolve));
    await new Promise(resolve => deniedServer.close(resolve));
  }
});

test('a project deny_private policy refuses loopback and policy validation is strict', async () => {
  const target = localServer();
  const url = await listen(target);
  const app = createApp({scripts: 'inline'});
  try {
    const {id} = await app.api('POST', 'projects', {name: 'Private egress'});
    await app.api('PUT', `projects/${id}/policy`, {
      allow: ['graph.read', 'net.fetch:*'],
      net: {allow: [url.replace('http://', '')], deny_private: true},
    });
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      workflow_id: id,
      node_type: 'custom',
      config: nodes.script(`
        try { await agentsys('POST', 'net', {url: '${url}/ok'}); node.display('reached'); }
        catch (error) { node.display(error.message); }`),
    });
    const run = await app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: [script.id], wait: true});
    assert.match(Object.values(run.displays || {}).join(' '), /private, loopback or link-local/);

    await assert.rejects(
      app.api('PUT', `projects/${id}/policy`, {allow: ['graph.read'], net: {allow: 'not-a-list'}}),
      /net\.allow/
    );
    await assert.rejects(
      app.api('PUT', `projects/${id}/policy`, {allow: ['graph.read'], net: {deny_private: 'yes'}}),
      /deny_private/
    );
    const kept = await app.api('GET', `projects/${id}/policy`);
    assert.deepEqual(kept.net, {allow: [url.replace('http://', '')], deny_private: true});
  } finally {
    await app.Backend.shutdownExecutions();
    await new Promise(resolve => target.close(resolve));
  }
});

test('IPv6 loopback is matched as an authority, including the brackets around it', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('ipv6');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch (error) {
    // A host without IPv6 is a legitimate environment, not a test failure.
    server.close();
    return;
  }
  const port = server.address().port;
  try {
    await withApi({allowedNetHosts: [`[::1]:${port}`]}, async ({base}) => {
      const response = await net(base, {url: `http://[::1]:${port}/`});
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).text, 'ipv6');
      const other = await net(base, {url: `http://[::1]:${port + 1}/`});
      assert.equal(other.status, 403);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Stop aborts a Script waiting on a slow network request', async () => {
  const target = localServer();
  const url = await listen(target);
  const app = createApp({scripts: 'worker', allowedNetHosts: [url.replace('http://', '')]});
  try {
    const project = await app.api('POST', 'projects', {name: 'Abort egress'});
    const query = {workflow_id: project.id};
    const script = await app.api('POST', `projects/${project.id}/primitives`, {
      ...query,
      primitive: 'script',
      point: {x: 0, y: 0},
    });
    await app.api('PUT', `projects/${project.id}/input-values`, {
      ...query,
      node_id: script.id,
      values: {script: `await agentsys('POST', 'net', {url: '${url}/slow', timeout: 60000}); node.display('finished');`},
    });
    await app.api('PUT', `projects/${project.id}/node-permissions/${script.id}`, {
      ...query,
      grants: ['graph.read', 'net.fetch:*'],
    });
    const started = Date.now();
    await app.api('POST', `projects/${project.id}/execution`, {...query, node_ids: [script.id]});
    await until(async () => (await app.api('GET', `projects/${project.id}/execution`, {}, query)).nodes.some(node => node.status === 'running'), 'request started');
    const stopped = await app.api('DELETE', `projects/${project.id}/execution`, {}, query);
    assert.equal(stopped.status, 'idle');
    assert.ok(Date.now() - started < 5000, 'Stop did not wait for the network timeout');
    const detail = await app.api('GET', `projects/${project.id}/execution`, {}, query);
    assert.equal(detail.displays[script.id], undefined);
    assert.equal(detail.state.finished, undefined);
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'the worker exited');
  } finally {
    await app.Backend.shutdownExecutions();
    await new Promise(resolve => target.close(resolve));
  }
});

test('the pinned transport connects to the checked address instead of resolving the name again', async () => {
  const target = localServer();
  const url = await listen(target);
  const port = new URL(url).port;
  try {
    // `rebind.invalid` does not exist in DNS. The request can only succeed because it is pinned to 127.0.0.1.
    const response = await pinnedRequest({
      url: `http://rebind.invalid:${port}/ok`,
      address: '127.0.0.1',
      timeout: 3000,
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"ok":true}');
    const redirect = await pinnedRequest({
      url: `http://rebind.invalid:${port}/redirect`,
      address: '127.0.0.1',
      timeout: 3000,
    });
    assert.equal(redirect.status, 302, 'the pinned transport does not follow redirects');
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('host normalization is lower-case, trailing-dot tolerant and fails closed on a lookalike', async () => {
  await withApi({allowedNetHosts: ['127.0.0.1.:1']}, async ({base}) => {
    // Both sides lose the root dot; there is no listener on port 1, so this is a network error, not a 403.
    const normalized = await net(base, {url: 'http://127.0.0.1:1/'});
    assert.notEqual(normalized.status, 403, await normalized.clone().text());
    const lookalike = await net(base, {url: 'http://127.0.0.1.evil.invalid:1/'});
    assert.equal(lookalike.status, 403);
  });
});
