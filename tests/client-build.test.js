'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {build} = require('../client/build');
const {resolveAsset} = require('../client/static-assets');
test('static artifact runs from an isolated directory and contains only reviewed public files', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-client-build-'));
  try {
    const output = build(path.join(temporary, 'public'));
    const files = require('../client/public-files.json');
    for (const name of files) assert.ok(await resolveAsset(output, '/' + name), name);
    for (const name of ['server/api-server.js', 'js/backend/runtime.js', 'js/model/executor.js', 'data/projects.json', 'package.json']) {
      assert.equal(fs.existsSync(path.join(output, name)), false, name);
      assert.equal(await resolveAsset(output, '/' + name, {fallback: true}), null, name);
    }
    fs.writeFileSync(path.join(output, 'js', 'accidental-secret.js'), 'secret');
    assert.equal(await resolveAsset(output, '/js/accidental-secret.js'), null);
    assert.ok(await resolveAsset(output, '/p/example', {fallback: true}));
    assert.throws(() => build(output), /must not exist/);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
