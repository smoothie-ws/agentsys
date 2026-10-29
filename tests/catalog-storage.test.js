'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createServer} = require('../server');

test('SKILL.md and separate provider credentials survive a server restart and disk edits', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-library-'));
  let server = createServer({dataDir, scheduler: false}),
    base = await server.listen(0);
  const call = async (method, route, body) => {
    const response = await fetch(base + '/api/' + route, {
      method,
      headers: {'Content-Type': 'application/json', 'X-AgentSys': '1'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  try {
    const skill = await call('POST', 'library/sections/ai.skills/items', {
      name: 'test-skill',
      description: 'A persisted skill.',
      values: {instructions: 'Original instructions.'},
    });
    const provider = await call('POST', 'library/sections/ai.providers/items', {
      name: 'Local',
      values: {providerId: 'local', baseURL: 'http://localhost:11434/v1', apiKey: 'private-key'},
    });
    const filename = path.join(dataDir, 'library/skills/ai.skills/test-skill/SKILL.md');
    assert.match(fs.readFileSync(filename, 'utf8'), /^---\nname: test-skill/);
    assert.ok(!fs.existsSync(filename + '.json'));
    assert.ok(
      !fs.readFileSync(path.join(dataDir, 'library/sections/ai.providers.json'), 'utf8').includes('private-key')
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dataDir, `library/credentials/ai.providers/${provider.id}.json`), 'utf8'))
        .apiKey,
      'private-key'
    );
    await server.close();
    fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace('Original instructions.', 'Edited on disk.'));
    server = createServer({dataDir, scheduler: false});
    base = await server.listen(0);
    assert.equal(
      (await call('GET', 'library/sections/ai.skills/items/' + skill.id)).values.instructions.trim(),
      'Edited on disk.'
    );
    // Editing while the process is alive must invalidate the cached Markdown too.
    fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace('Edited on disk.', 'Edited while running.'));
    const deadline = Date.now() + 8000;
    let instructions;
    do {
      instructions = (await call('GET', 'library/sections/ai.skills/items/' + skill.id)).values.instructions.trim();
      if (instructions === 'Edited while running.') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(instructions, 'Edited while running.');
    assert.deepEqual((await call('GET', 'library/sections/ai.providers/items/' + provider.id)).secrets, {apiKey: true});
    assert.equal((await fetch(base + '/data/library/skills/ai.skills/test-skill/SKILL.md')).status, 404);
    await call('DELETE', 'plugins/ai');
    assert.ok(!fs.existsSync(filename));
    assert.ok(!fs.existsSync(path.join(dataDir, `library/credentials/ai.providers/${provider.id}.json`)));
  } finally {
    await server.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});
