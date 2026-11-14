'use strict';
// The static half of the combined server and the client: only public files, never server code, and no path trick
// (traversal, encoding, Windows drive/stream suffixes) reaches something else.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {spawn} = require('node:child_process');
const {createServer} = require('../server');

const raw = (base, pathname, method = 'GET') =>
  new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({hostname: url.hostname, port: url.port, path: pathname, method}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          type: response.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    request.on('error', reject);
    request.end();
  });

async function withStaticServer(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-static-'));
  const app = createServer({dataDir: dir, token: 'static-token'});
  const base = await app.listen(0);
  try {
    await work({base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('the combined server serves public files and none of its own code', async () => {
  await withStaticServer(async ({base}) => {
    for (const [pathname, type] of [
      ['/editor/', 'text/html'],
      ['/index.html', 'text/html'],
      ['/editor/js/app/helpers.js', 'text/javascript'],
      ['/shared/core.js', 'text/javascript'],
      ['/client-plugins/index.json', 'application/json'],
      ['/docs/architecture.md', 'text/markdown'],
    ]) {
      const response = await raw(base, pathname);
      assert.equal(response.status, 200, pathname);
      assert.match(response.type, new RegExp(type.replace('/', '\\/')), pathname);
    }
    // The root goes to the editor.
    const root = await raw(base, '/');
    assert.equal(root.status, 301);
  });
});

test('server-only and non-public files are never served, whatever the path spelling', async () => {
  await withStaticServer(async ({base}) => {
    const forbidden = [
      '/server.js',
      '/headless.js',
      '/package.json',
      '/bin/agentsys-server.js',
      '/js/backend/routes-app.js',
      '/js/storage/db.js',
      '/js/model/executor.js',
      '/legacy/server-plugin-host.js',
      '/data/projects.json',
      '/editor/server.js',
      '/editor/js/backend/routes-app.js',
      '/js/backend/../backend/routes-app.js',
      '/js/../server.js',
      '/%2e%2e/server.js',
      '/js/%2e%2e/%2e%2e/server.js',
      '/js%5c..%5c..%5cserver.js',
      '/index.html%00.js',
      '/server.js.',
      '/server.js%20',
    ];
    for (const pathname of forbidden) {
      const response = await raw(base, pathname);
      assert.ok([400, 404].includes(response.status), `${pathname} -> ${response.status}`);
      assert.equal(response.body.includes('createServer('), false, pathname);
      assert.equal(response.body.includes('AGENTSYS_TOKEN'), false, pathname);
    }
    // Windows alternate data streams must not turn a server-only file into a public one.
    for (const pathname of ['/js/storage/db.js::$DATA', '/js/model/executor.js::$DATA', '/server.js::$DATA', '/index.html::$DATA']) {
      const response = await raw(base, pathname);
      assert.ok([400, 404].includes(response.status), `${pathname} -> ${response.status}`);
      assert.equal(response.body.includes('const DB ='), false, pathname);
    }
  });
});

test('the client static server has the same boundary', async () => {
  const port = await new Promise(resolve => {
    const probe = require('node:net').createServer();
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => resolve(chosen));
    });
  });
  const child = spawn(process.execPath, ['bin/agentsys-client.js', '--port', String(port), '--server', 'http://127.0.0.1:1'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await raw(base, '/')).status === 200) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await raw(base, '/js/app/helpers.js')).status, 200);
    for (const pathname of ['/js/storage/db.js', '/js/model/executor.js', '/server.js', '/js/backend/routes-app.js', '/js/storage/db.js::$DATA']) {
      const response = await raw(base, pathname);
      assert.ok([400, 404].includes(response.status), `${pathname} -> ${response.status}`);
      assert.equal(response.body.includes('const DB ='), false, pathname);
    }
  } finally {
    child.kill();
  }
});
