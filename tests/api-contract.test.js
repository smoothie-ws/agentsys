'use strict';
// The published contract: methods, validation, error shapes, version reporting and what a client may rely on
// across versions. These are the rules a third-party client would code against, checked over HTTP.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const Protocol = require('../shared/protocol');

const TOKEN = 'contract-token';
const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

async function withApi(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-contract-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  const base = await app.listen(0);
  const call = async (method, route, body, own = {}) => {
    const response = await fetch(base + '/api/' + route, {
      method,
      headers: {...headers, ...own},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined, text};
  };
  try {
    await work({base, call, app});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('a known path answers 405 with the methods it accepts, and an unknown one 404', async () => {
  await withApi(async ({call}) => {
    const put = await call('PUT', 'projects', {});
    assert.equal(put.status, 405);
    assert.equal(put.body.error.code, 'method_not_allowed');
    assert.equal(put.headers.get('allow'), 'GET, POST');
    const deleteCollection = await call('DELETE', 'collections');
    assert.equal(deleteCollection.status, 405);
    assert.equal(deleteCollection.headers.get('allow'), 'GET');
    const nowhere = await call('GET', 'no/such/route');
    assert.equal(nowhere.status, 404);
    assert.equal(nowhere.body.error.code, 'not_found');
  });
});

test('a malformed body is a 400 with a code, and never a partial write', async () => {
  await withApi(async ({call}) => {
    const broken = await call('POST', 'projects', '{"name":');
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'invalid_request');
    assert.match(broken.body.error.message, /not valid JSON/);
    const array = await call('POST', 'projects', '[]');
    assert.equal(array.status, 400);
    assert.equal(array.body.error.code, 'invalid_request');
    const scalar = await call('POST', 'projects', '"text"');
    assert.equal(scalar.status, 400);
    assert.equal((await call('GET', 'projects')).body.length, 0, 'nothing was written');
    // An empty body is {} for routes that need nothing.
    assert.equal((await call('GET', 'session')).status, 200);
  });
});

test('every answer reports the protocol, including errors', async () => {
  await withApi(async ({call, base}) => {
    for (const response of [
      await fetch(base + '/api/meta'),
      await call('GET', 'projects'),
      await call('PUT', 'projects', {}),
      await call('GET', 'no/such/route'),
    ])
      assert.equal(response.headers.get('x-agentsys-protocol'), String(Protocol.PROTOCOL));
    // The metadata is the one place a client reads the version from.
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.protocol, Protocol.PROTOCOL);
    assert.equal(meta.version, Protocol.VERSION);
    assert.equal(meta.product, Protocol.PRODUCT);
    assert.equal(meta.agentsys, true);
    assert.equal(meta.features.client_plugins, false);
    assert.equal(meta.features.server_plugins, false);
  });
});

test('the discovery document needs no credentials and carries nothing private', async () => {
  await withApi(async ({base}) => {
    const response = await fetch(base + '/api/meta');
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('password'), false);
    // A client can use it before it has a token: that is how it learns that it needs one.
    assert.equal(JSON.parse(text).auth, 'token');
  });
});

test('pagination is bounded and stable, and invalid numbers fall back to defaults', async () => {
  await withApi(async ({call}) => {
    await call('PUT', 'collections/items', {
      title: 'Items',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    for (let i = 0; i < 5; i++) await call('POST', 'collections/items/records', {data: {n: i}});
    const page = await call('GET', 'collections/items/records?limit=2&offset=2');
    assert.equal(page.body.total, 5);
    assert.deepEqual(page.body.records.map(record => record.data.n), [2, 3]);
    assert.equal(page.body.next_offset, 4);
    const last = await call('GET', 'collections/items/records?limit=2&offset=4');
    assert.equal(last.body.next_offset, null);
    for (const query of ['limit=-5', 'limit=abc', 'offset=-2', 'limit=999999']) {
      const answer = await call('GET', 'collections/items/records?' + query);
      assert.equal(answer.status, 200, query);
      assert.ok(answer.body.records.length >= 1 && answer.body.records.length <= 500, query);
    }
  });
});

test('an older client that sends no If-Match and no CSRF header with a bearer token still works', async () => {
  await withApi(async ({call, base}) => {
    const plain = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json'};
    const created = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: plain,
      body: JSON.stringify({name: 'Old client'}),
    });
    assert.equal(created.status, 200, 'protocol 1 clients wrote without X-AgentSys before the CSRF layer existed');
    const madeId = (await created.json()).id;
    const updated = await fetch(base + '/api/projects/' + madeId, {
      method: 'PUT',
      headers: plain,
      body: JSON.stringify({name: 'Renamed'}),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).name, 'Renamed');
    // A client that reads the workflow gets the cursor it can use as If-Match.
    const id = madeId;
    const workflow = await (await fetch(`${base}/api/projects/${id}/workflow?workflow_id=${id}`, {headers: plain})).json();
    assert.equal(typeof workflow.cursor, 'number');
  });
});

test('the API does not depend on the client that calls it', async () => {
  await withApi(async ({base}) => {
    // No Origin, no client header, no user agent: a script or another interface is a first-class client.
    const response = await fetch(base + '/api/projects', {headers: {Authorization: 'Bearer ' + TOKEN}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'no CORS header without an Origin');
    // A client header is not required and does not change the answer.
    const branded = await fetch(base + '/api/projects', {
      headers: {Authorization: 'Bearer ' + TOKEN, 'X-AgentSys-Client': 'another-ui/9'},
    });
    assert.equal(branded.status, 200);
    assert.deepEqual(await branded.json(), await response.json());
  });
});

test('a request that changes the graph returns the new state and its cursor', async () => {
  await withApi(async ({call}) => {
    await call('PUT', 'settings', {developer_mode: true});
    const project = await call('POST', 'projects', {name: 'Cursor'});
    const query = {workflow_id: project.body.id};
    const before = await call('GET', `projects/${project.body.id}/workflow`, undefined, query);
    const made = await call(
      'POST',
      `projects/${project.body.id}/primitives`,
      {...query, primitive: 'event', point: {x: 0, y: 0}},
      {'If-Match': String(before.body.cursor)}
    );
    assert.equal(made.status, 200);
    const after = await call('GET', `projects/${project.body.id}/workflow`);
    assert.equal(after.body.cursor, before.body.cursor + 1);
    // The same If-Match value is now stale.
    const stale = await call(
      'POST',
      `projects/${project.body.id}/primitives`,
      {...query, primitive: 'event', point: {x: 50, y: 0}},
      {'If-Match': String(before.body.cursor)}
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
  });
});
