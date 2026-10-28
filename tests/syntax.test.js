// Every browser script must parse: a syntax error in one file silently disables everything it defines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scripts = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1].split('?')[0]);

test('every script listed in index.html parses', () => {
  assert.ok(scripts.length > 10);
  for (const file of scripts) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, {filename: file}), file);
  }
});
