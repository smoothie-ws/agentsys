'use strict';
// Resource ownership over a server's life: event streams are counted and released, sessions are bounded, the
// event-stream limit is enforced, and close() releases the port even with a stream open. All temporary.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'lifecycle-token';
const bearer = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail('not reached: ' + what);
};

async function withServer(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-lifecycle-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    return await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const diagnostics = async base => (await fetch(base + '/api/diagnostics', {headers: bearer})).json();
const stream = async base => {
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', {headers: bearer, signal: controller.signal});
  const reader = response.body.getReader();
  await reader.read(); // the ready event
  return {controller, reader, response};
};

test('event streams are counted, released on disconnect, and capped', async () => {
  await withServer({eventLimit: 2}, async ({base}) => {
    const first = await stream(base);
    const second = await stream(base);
    assert.equal((await diagnostics(base)).clients, 2);
    const third = await fetch(base + '/api/events', {headers: bearer});
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error.code, 'too_many_streams');

    // A browser tab that goes away closes its request: the server must forget it, not keep a dead stream.
    first.controller.abort();
    await first.reader.cancel().catch(() => {});
    second.controller.abort();
    await second.reader.cancel().catch(() => {});
    await until(async () => (await diagnostics(base)).clients === 0, 'both streams were released');
    const again = await stream(base);
    assert.equal((await diagnostics(base)).clients, 1);
    again.controller.abort();
    await again.reader.cancel().catch(() => {});
  });
});

test('sessions are capped, and an expired session is swept by the next sign-in', async () => {
  await withServer({sessionLimit: 3, sessionTtlMs: 1000}, async ({base}) => {
    for (let i = 0; i < 8; i++) {
      const response = await fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: TOKEN}),
      });
      assert.equal(response.status, 200);
    }
    assert.ok((await diagnostics(base)).sessions <= 3, 'the session map is bounded');
    await sleep(1100);
    const response = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.equal(response.status, 200);
    const value = await diagnostics(base);
    assert.equal(value.sessions, 1, 'the expired sessions were swept');
  });
});

test('close() releases the port and open streams, and the port can be reused immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-lifecycle-port-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  const base = await app.listen(0);
  const port = new URL(base).port;
  const open = await stream(base);
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 3000, 'close does not wait for the stream timeout');
  open.controller.abort();
  await open.reader.cancel().catch(() => {});
  // A fresh server can bind the same port at once: closeAllConnections released it.
  const again = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', () => server.close(() => resolve(true)));
  });
  assert.equal(again, true);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('a rejected session keeps the failure counter bounded so a restart is not needed', async () => {
  await withServer({authAttempts: 3, authWindowMs: 1000}, async ({base}) => {
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await fetch(base + '/api/auth/session', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({token: 'wrong'}),
          })
        ).status,
        401
      );
    const limited = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'wrong'}),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    await sleep(1100);
    const accepted = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.equal(accepted.status, 200);
  });
});
