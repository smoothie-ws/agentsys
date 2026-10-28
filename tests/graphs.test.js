'use strict';
const test = require('node:test'),
  fs = require('node:fs'),
  path = require('node:path');
const {runGraphFixture} = require('./graph-runner');
for (const file of fs.readdirSync(path.join(__dirname, 'fixtures')).filter(f => f.endsWith('.graph-test.json'))) {
  test('golden graph: ' + file, () => runGraphFixture(require('./fixtures/' + file)));
}
