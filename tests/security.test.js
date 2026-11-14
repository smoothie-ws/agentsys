'use strict';
// The HTTP security surface of an AgentSys server: authentication, sessions, CSRF, Origin and Host checks,
// CORS, the event stream, body limits and redaction. Each test starts a server on a free loopback port with a
// temporary data folder. No external system is contacted.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createServer} = require('../server');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'test-token-0123456789';

async function withServer(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-security-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({base, app, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const request = async (base, route, {method = 'GET', body, headers = {}, redirect} = {}) =>
  fetch(base + '/api/' + route, {
    method,
    headers,
    redirect,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const bearer = {Authorization: 'Bearer ' + TOKEN};
const json = {...bearer, 'Content-Type': 'application/json'};

/** A raw HTTP request: fetch refuses to set Host or to send TRACE, and a Host check must be tested for real. */
const raw = (base, pathname, {method = 'GET', headers = {}, body} = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(base + pathname);
    const request = require('node:http').request(
      {hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers},
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')})
        );
      }
    );
    request.on('error', reject);
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });

const session = async base => {
  const response = await fetch(base + '/api/auth/session', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: TOKEN}),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return {cookie: cookie.split(';')[0], raw: cookie};
};

test('every protected family refuses an unauthenticated caller and an invalid session', async () => {
  await withServer({}, async ({base}) => {
    for (const [method, route] of [
      ['GET', 'projects'],
      ['POST', 'projects'],
      ['GET', 'diagnostics'],
      ['GET', 'events'],
      ['GET', 'settings'],
      ['PUT', 'settings'],
      ['GET', 'openapi.json'],
    ]) {
      const response = await request(base, route, {method, body: method === 'GET' ? undefined : {}});
      assert.equal(response.status, 401, `${method} ${route}`);
      const body = await response.json();
      assert.equal(body.error.code, 'unauthorized');
    }
    // A made-up cookie is not a session, and neither is a plausible but unknown value.
    for (const value of ['agentsys_session=deadbeef', 'agentsys_session=' + 'a'.repeat(43)]) {
      const response = await request(base, 'projects', {headers: {Cookie: value}});
      assert.equal(response.status, 401, value.slice(0, 40));
    }
    // Discovery is public; it carries no data and no secrets.
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.product, 'agentsys');
    assert.equal(JSON.stringify(meta).includes(TOKEN), false);
  });
});

test('a session ends at logout and cannot be replayed afterwards', async () => {
  await withServer({}, async ({base}) => {
    const {cookie} = await session(base);
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 200);
    const diagnostics = await request(base, 'diagnostics', {headers: bearer});
    const before = (await diagnostics.json()).sessions;
    assert.equal(before, 1);
    const logout = await request(base, 'auth/logout', {method: 'POST', headers: {Cookie: cookie}});
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 401);
    const after = (await (await request(base, 'diagnostics', {headers: bearer})).json()).sessions;
    assert.equal(after, 0, 'the session was removed, not only forgotten by the browser');
  });
});

test('a cookie write needs the CSRF header and an allowed origin; a bearer token does not', async () => {
  await withServer({allowedOrigins: ['http://client.example']}, async ({base}) => {
    const {cookie} = await session(base);
    const write = (headers, body = {name: 'x'}) =>
      request(base, 'projects', {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body});

    assert.equal((await write({Cookie: cookie})).status, 403, 'no CSRF header');
    assert.equal((await write({Cookie: cookie, 'X-AgentSys': '1'})).status, 200, 'same-origin cookie write');
    assert.equal(
      (await write({Cookie: cookie, 'X-AgentSys': '1', Origin: 'http://evil.example'})).status,
      403,
      'a foreign origin cannot write with a cookie'
    );
    assert.equal(
      (await write({Cookie: cookie, 'X-AgentSys': '1', Origin: 'http://client.example'})).status,
      200,
      'a configured origin can'
    );
    // A bearer token is not attached automatically by a browser, so an Origin is not required with it.
    assert.equal((await write({...bearer})).status, 200, 'a bearer write needs no CSRF header');
    // A GET with a cookie needs no CSRF header: it changes nothing.
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 200);
  });
});

test('an unexpected Host is refused on a loopback server, including a rebinding name', async () => {
  await withServer({allowedHosts: ['trusted.example']}, async ({base}) => {
    const get = host => raw(base, '/api/projects', {headers: {...bearer, Host: host}});
    assert.equal((await get('127.0.0.1')).status, 200);
    assert.equal((await get('localhost')).status, 200);
    assert.equal((await get('evil.example')).status, 403);
    assert.equal((await get('trusted.example')).status, 200, 'a configured name is accepted');
    // The Host check also applies to the session endpoint, which is otherwise public.
    const login = await raw(base, '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Host: 'evil.example'},
      body: {token: TOKEN},
    });
    assert.equal(login.status, 403);
  });
});

test('CORS answers only configured origins, never with a wildcard and never with a foreign one', async () => {
  await withServer({allowedOrigins: ['http://client.example']}, async ({base}) => {
    const preflight = await fetch(base + '/api/projects', {
      method: 'OPTIONS',
      headers: {'Access-Control-Request-Method': 'POST', Origin: 'http://client.example'},
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-AgentSys/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /If-Match/);
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');

    for (const origin of ['http://evil.example', 'null', 'https://client.example.evil.test']) {
      const denied = await fetch(base + '/api/projects', {
        method: 'OPTIONS',
        headers: {'Access-Control-Request-Method': 'POST', Origin: origin},
      });
      assert.equal(denied.headers.get('access-control-allow-origin'), null, origin);
      const read = await request(base, 'projects', {headers: {...bearer, Origin: origin}});
      assert.equal(read.headers.get('access-control-allow-origin'), null, origin);
    }
    // The allowed origin is echoed back, not reflected from a prefix.
    const read = await request(base, 'projects', {headers: {...bearer, Origin: 'http://client.example'}});
    assert.equal(read.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.match(read.headers.get('vary') || '', /Origin/);
  });
});

test('the event stream refuses an anonymous caller and reports changes to an authenticated one', async () => {
  await withServer({}, async ({base}) => {
    assert.equal((await fetch(base + '/api/events')).status, 401);
    assert.equal((await fetch(base + '/api/events', {headers: {Cookie: 'agentsys_session=nope'}})).status, 401);
    const controller = new AbortController();
    const response = await fetch(base + '/api/events', {headers: bearer, signal: controller.signal});
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 20 && !text.includes('"type":"ready"'); i++) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
    }
    assert.match(text, /"type":"ready"/);
    assert.match(text, /"protocol":1/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test('a wrong or conflicting credential never unlocks a write', async () => {
  await withServer({}, async ({base}) => {
    const response = await request(base, 'projects', {
      method: 'POST',
      headers: {Authorization: 'Bearer wrong', 'Content-Type': 'application/json'},
      body: {name: 'x'},
    });
    assert.equal(response.status, 401);
    // A valid session with a wrong bearer header is still the same authenticated user: the session counts.
    const {cookie} = await session(base);
    const mixed = await request(base, 'projects', {
      method: 'POST',
      headers: {Cookie: cookie, Authorization: 'Bearer wrong', 'X-AgentSys': '1', 'Content-Type': 'application/json'},
      body: {name: 'session still works'},
    });
    assert.equal(mixed.status, 200);
    // A wrong token in the login body is refused even when a valid cookie is present.
    const login = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Cookie: cookie},
      body: JSON.stringify({token: 'wrong'}),
    });
    assert.equal(login.status, 401);
  });
});

test('a body over the limit gets a 413 instead of a dead connection', async () => {
  await withServer({}, async ({base}) => {
    // The API accepts 20 MB; the session endpoint 64 KB.
    const big = 'x'.repeat(21 * 1024 * 1024);
    const response = await request(base, 'projects', {
      method: 'POST',
      headers: {...json},
      body: JSON.stringify({name: big}),
    }).catch(error => ({status: 0, failure: error.message}));
    assert.equal(response.status, 413, JSON.stringify(response));
    const body = await response.json();
    assert.equal(body.error.code, 'too_large');
    assert.match(body.error.message, /larger than the limit/);

    const login = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'x'.repeat(70000)}),
    });
    assert.equal(login.status, 413);
  });
});

test('an unknown route, an unknown method and a malformed escape answer in JSON and leak nothing', async () => {
  await withServer({}, async ({base}) => {
    const unknown = await request(base, 'nope/at/all', {headers: bearer});
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'not_found');
    const method = await raw(base, '/api/projects', {method: 'TRACE', headers: bearer});
    assert.equal(method.status, 405);
    const malformed = await raw(base, '/api/collections/%E0%A4%A/records', {headers: bearer});
    assert.equal(malformed.status, 400);
    const body = JSON.parse(malformed.text);
    assert.equal(JSON.stringify(body).includes('at Object.'), false, 'no stack in the answer');
    assert.equal(JSON.stringify(body).includes(path.sep + 'server.js'), false, 'no file path in the answer');
  });
});

test('diagnostics report state and counts, never workflow data, tokens or secrets', async () => {
  await withServer({}, async ({base}) => {
    await request(base, 'secrets/provider-key', {method: 'PUT', headers: json, body: {value: 'sk-live-super-secret'}});
    await request(base, 'collections/notes', {
      method: 'PUT',
      headers: json,
      body: {title: 'Notes', schema: {type: 'object', properties: {text: {type: 'string'}}}},
    });
    await request(base, 'collections/notes/records', {
      method: 'POST',
      headers: json,
      body: {data: {text: 'private note body'}},
    });
    const diagnostics = await request(base, 'diagnostics', {headers: bearer});
    assert.equal(diagnostics.status, 200);
    const text = await diagnostics.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('sk-live-super-secret'), false);
    assert.equal(text.includes('private note body'), false);
    const value = JSON.parse(text);
    assert.equal(typeof value.sessions, 'number');
    assert.equal(typeof value.storage.mode, 'string');
    assert.equal(Array.isArray(value.recent_errors), true);
  });
});

test('error messages are redacted before they are returned and logged', async () => {
  await withServer({}, async ({app}) => {
    const redacted = app.redact('Authorization: Bearer abc.def.ghi api_key=sk-live-123 token: "zzz" password=hunter2');
    assert.match(redacted, /Bearer \[REDACTED\]/);
    assert.equal(redacted.includes('abc.def.ghi'), false);
    assert.equal(redacted.includes('sk-live-123'), false);
    assert.equal(redacted.includes('zzz'), false);
    assert.equal(redacted.includes('hunter2'), false);
  });
});

test('one server refuses to expose the API on a non-loopback address without a token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-exposed-'));
  const app = createServer({dataDir: dir, host: '0.0.0.0', token: '', serveClient: false});
  const base = await app.listen(0);
  try {
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.auth, 'loopback');
    const response = await fetch(base + '/api/projects', {headers: {Host: '127.0.0.1'}});
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error.message, /AGENTSYS_TOKEN/);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('the generated contract matches the routes and reports the running version', async () => {
  await withServer({}, async ({base}) => {
    const spec = await (await request(base, 'openapi.json', {headers: bearer})).json();
    assert.equal(spec.info.version, require('../shared/protocol').VERSION);
    assert.equal(spec.info['x-protocol'], 1);
    for (const route of ['/api/projects', '/api/projects/{project_id}/workflow', '/api/collections/{name}/records', '/api/events', '/api/meta'])
      assert.ok(spec.paths[route], `the contract documents ${route}`);
    // Every documented operation has a summary and responses; no operation is a client-only route.
    for (const [route, item] of Object.entries(spec.paths)) {
      assert.ok(route.startsWith('/api/'), route);
      for (const [method, operation] of Object.entries(item)) {
        assert.ok(['get', 'post', 'put', 'patch', 'delete'].includes(method), `${route} ${method}`);
        assert.equal(typeof operation.summary, 'string');
        assert.ok(operation.responses);
      }
    }
  });
});

test('the combined local server sends the same framing and content policy as the client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-local-csp-'));
  const app = createServer({dataDir: dir, token: ''});
  const base = await app.listen(0);
  try {
    const page = await fetch(base + '/editor/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-src 'self' blob:/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('sign-in attempts are limited per address, and a success clears the count', async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await withServer({authAttempts: 3, authWindowMs: 1000}, async ({base}) => {
    const login = token =>
      fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token}),
      });
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await login('wrong')).status, 401);
    const limited = await login('wrong');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'the answer says how long to wait');
    // The right token waits out the window too: the limit is not an oracle for which guess was right.
    assert.equal((await login(TOKEN)).status, 429);
    await sleep(1100);
    const good = await login(TOKEN);
    assert.equal(good.status, 200);
    assert.match(good.headers.get('set-cookie'), /HttpOnly/);
    // A successful sign-in cleared the count, so one wrong attempt is a 401 again, not a 429.
    assert.equal((await login('wrong')).status, 401);
  });
});
