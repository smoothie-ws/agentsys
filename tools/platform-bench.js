#!/usr/bin/env node
'use strict';
// Comparable cold API startup samples for any checkout. No user data is read or written.
// node tools/platform-bench.js [--root PATH] [--samples 5]
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const at = flag => args.indexOf(flag);
const root = at('--root') < 0 ? path.resolve(__dirname, '..') : path.resolve(args[at('--root') + 1]);
const samples = at('--samples') < 0 ? 5 : Number(args[at('--samples') + 1]);
if (!Number.isInteger(samples) || samples < 2 || samples > 100) throw new Error('samples must be 2..100');
const program = `
  const {performance} = require('node:perf_hooks');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-platform-bench-'));
  (async () => {
    let app;
    try {
      const start = performance.now();
      app = require(path.join(process.env.AGENTSYS_BENCH_ROOT, 'server/api-server')).createApiServer({dataDir: dir});
      await app.listen(0);
      const startup_ms = performance.now() - start;
      const memory = process.memoryUsage();
      console.log(JSON.stringify({startup_ms, rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed}));
    } finally {
      await app?.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;
const rows = Array.from({length: samples}, () => JSON.parse(execFileSync(process.execPath, ['-e', program], {
  encoding: 'utf8', env: {...process.env, AGENTSYS_BENCH_ROOT: root}, windowsHide: true,
})));
const summary = key => {
  const values = rows.map(row => row[key]).sort((a, b) => a - b);
  return {median: values[Math.floor(values.length / 2)], samples: rows.map(row => row[key])};
};
console.log(JSON.stringify({node: process.version, root, samples, startup_ms: summary('startup_ms'),
  rss_bytes: summary('rss_bytes'), heap_used_bytes: summary('heap_used_bytes')}, null, 2));
