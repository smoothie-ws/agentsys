'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const {runGraphFixture} = require('./graph-runner');
(async () => {
  if (process.argv[2] !== '--update')
    throw Error('Explicit update required: node tests/update-goldens.cjs --update [fixture.graph-test.json]');
  const root = path.resolve(__dirname, 'fixtures');
  const files = process.argv[3]
    ? [process.argv[3]]
    : fs
        .readdirSync(root)
        .filter(f => f.endsWith('.graph-test.json'))
        .sort();
  for (const name of files) {
    if (path.basename(name) !== name || !name.endsWith('.graph-test.json'))
      throw Error('Choose a file in tests/fixtures');
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw Error('Invalid fixture path');
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8')),
      run = await runGraphFixture(fixture, {verify: false});
    fixture.expected = {
      status: run.status,
      displays: Object.values(run.displays).sort(),
      ...(fixture.expected.outputs ? {outputs: run.outputs} : {}),
    };
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Updated ' + name);
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
