'use strict';
// The static Client: only public files, never server code, and no path trick
// (traversal, encoding, Windows drive/stream suffixes) reaches something else.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {spawn} = require('node:child_process');
const {withClient} = require('./client-harness');

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

test('the client serves public files and none of its own code', async () => {
  await withClient(async ({base}) => {
    for (const [pathname, type] of [
      ['/', 'text/html'],
      ['/index.html', 'text/html'],
      ['/js/app/helpers.js', 'text/javascript'],
      ['/shared/core.js', 'text/javascript'],
      ['/js/model/graph.js', 'text/javascript'],
      ['/client-plugins/index.json', 'application/json'],
      ['/docs/ARCHITECTURE.md', 'text/markdown'],
    ]) {
      const response = await raw(base, pathname);
      assert.equal(response.status, 200, pathname);
      assert.match(response.type, new RegExp(type.replace('/', '\\/')), pathname);
    }
    // Static root and SPA fallback stay in the client.
    const root = await raw(base, '/');
    assert.equal(root.status, 200);
  });
});

test('server-only and non-public files are never served, whatever the path spelling', async () => {
  await withClient(async ({base}) => {
    const forbidden = [
      '/server.js',
      '/headless.js',
      '/package.json',
      '/bin/agentsys-server.js',
      '/js/backend/routes-app.js',
      '/js/storage/db.js',
      '/js/model/executor.js',
      ...['editor', 'snapshot', 'evaluate', 'schema', 'documents'].map(name => '/js/model/' + name + '.js'),
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
      '/js/BACKEND/scripts.js',
      '/js/storage/DB.js',
      '/js/model/EXECUTOR.js',
      '/js/backend./scripts.js',
      '/js/backend%20/scripts.js',
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

test('a public-looking symlink cannot publish server files or files outside the client root', async () => {
  const {resolveAsset} = require('../server/static-assets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-static-links-'));
  try {
    fs.mkdirSync(path.join(dir, 'js'));
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'private.js'), 'private');
    fs.symlinkSync(path.join(dir, 'server'), path.join(dir, 'js', 'alias'), 'junction');
    assert.equal(await resolveAsset(dir, '/js/alias/private.js'), null);
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'js', 'outside'), 'junction');
    assert.equal(await resolveAsset(dir, '/js/outside/' + path.basename(dir) + '/server/private.js'), null);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
