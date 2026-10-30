'use strict';
// Synthetic unrelated JSON files expose the cost of scanning the entire store on a small commit.
// Only a newly created OS temporary directory is touched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {createServer} = require('../server');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-storage-bench-'));
  const app = createServer({dataDir});
  try {
    await app.listen(0);
    const folder = path.join(dataDir, 'other');
    fs.mkdirSync(folder, {recursive: true});
    let seeded = 0;
    for (const count of [100, 1000, 5000]) {
      for (; seeded < count; seeded++) fs.writeFileSync(path.join(folder, `bench-${seeded}.json`), '{}');
      const durations = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await app.api.request('PUT', 'settings', {body: {undo_steps: i + 10}});
        durations.push(Math.round((performance.now() - start) * 100) / 100);
      }
      console.log(JSON.stringify({files: count, settingsCommitMs: durations}));
    }
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
