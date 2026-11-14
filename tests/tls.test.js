'use strict';
// Local TLS integration: a real HTTPS server with a generated self-signed certificate, plus the reverse-proxy
// Secure-cookie path. Skipped, with the reason, when openssl is not installed on this machine.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  https = require('node:https'),
  {execFileSync} = require('node:child_process');
const {createApiServer} = require('../server/api-server');

const OPENSSL = [
  process.env.OPENSSL,
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
].find(candidate => candidate && fs.existsSync(candidate));
const TOKEN = 'tls-token-0123456789';

function request(base, route, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + '/api/' + route);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: false, // the certificate is self-signed and made for this test
        servername: 'localhost',
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')})
        );
      }
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('a generated certificate serves HTTPS with the protocol header and a Secure session cookie', {skip: !OPENSSL && 'openssl is not available'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-tls-'));
  const key = path.join(dir, 'key.pem'),
    cert = path.join(dir, 'cert.pem');
  try {
    execFileSync(
      OPENSSL,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      {stdio: 'ignore'}
    );
    const app = createApiServer({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      tls: {key: fs.readFileSync(key), cert: fs.readFileSync(cert)},
    });
    const base = await app.listen(0);
    try {
      assert.match(base, /^https:\/\//);
      const meta = await request(base, 'meta');
      assert.equal(meta.status, 200);
      assert.equal(JSON.parse(meta.text).product, 'agentsys');
      assert.equal(meta.headers['x-agentsys-protocol'], '1');
      const session = await request(base, 'auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: {token: TOKEN},
      });
      assert.equal(session.status, 200);
      assert.match(session.headers['set-cookie'][0], /HttpOnly/);
      assert.match(session.headers['set-cookie'][0], /Secure/, 'TLS makes the session cookie Secure');
      const cookie = session.headers['set-cookie'][0].split(';')[0];
      const projects = await request(base, 'projects', {headers: {Cookie: cookie}});
      assert.equal(projects.status, 200);
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('behind a trusted proxy, X-Forwarded-Proto marks the session cookie Secure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-proxy-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, trustProxy: true});
  const base = await app.listen(0);
  try {
    const response = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Secure/);
    const insecure = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.doesNotMatch(insecure.headers.get('set-cookie'), /Secure/);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
