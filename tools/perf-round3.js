#!/usr/bin/env node
'use strict';
// Targeted microbenchmarks for the round-3 changes. Each pair measures the same work with the old and the new
// code path, on the same process and data, so the difference is not machine noise between two separate runs.
//
//   node tools/perf-round3.js
//   node tools/perf-round3.js --json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {createApp} = require('../tests/harness');

const args = process.argv.slice(2);
const json = args.includes('--json');
const round = value => Math.round(value * 1000) / 1000;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.floor(sorted.length / 2)]);
};
const time = (times, work) => {
  const samples = [];
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    work(i);
    samples.push(performance.now() - started);
  }
  return median(samples);
};

async function graphSnapshot(size) {
  const app = createApp();
  try {
    const project = await app.api('POST', 'projects', {name: 'Perf ' + size});
    const query = {workflow_id: project.id};
    const operations = [];
    for (let start = 0; start < size; start += 200) {
      operations.length = 0;
      for (let i = start; i < Math.min(size, start + 200); i++)
        operations.push({
          method: 'POST',
          path: 'typed-nodes',
          body: {
            node_type: 'custom',
            config: {title: 'Node ' + i, op: 'on_run', inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}]},
            position: {x: (i % 40) * 40, y: Math.floor(i / 40) * 40},
          },
        });
      await app.api('POST', `projects/${project.id}/batch`, {...query, operations});
    }
    const snapshot = await app.api('GET', `projects/${project.id}/workflow`, {}, query);
    return snapshot;
  } finally {
    await app.Backend.shutdownExecutions();
  }
}

function storagePair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-perf-storage-'));
  const file = path.join(dir, 'document.json');
  const before = 'x'.repeat(900000);
  const after = before + 'y'.repeat(120000); // a changed size: a stat is enough to know it cannot be identical
  fs.writeFileSync(file, before);
  const atomic = (text, compare) => {
    if (compare) {
      try {
        if (fs.readFileSync(file, 'utf8') === text) return;
      } catch {}
    } else {
      try {
        if (fs.statSync(file).size === Buffer.byteLength(text)) {
          if (fs.readFileSync(file, 'utf8') === text) return;
        }
      } catch {}
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  try {
    const old = time(12, i => atomic(after + 'z'.repeat(i * 1000), true));
    const next = time(12, i => atomic(after + 'z'.repeat(i * 1000), false));
    return {old_ms: old, new_ms: next, bytes: after.length};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

async function main() {
  const snapshot = await graphSnapshot(800);
  const size = JSON.stringify(snapshot).length;
  // The HTTP layer used to JSON.parse(JSON.stringify(result)) and then serialize it again.
  const twice = time(25, () => JSON.stringify(JSON.parse(JSON.stringify(snapshot))));
  const once = time(25, () => JSON.stringify(snapshot));
  const storage = storagePair();
  const report = {
    measured_at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    workflow_response_bytes: size,
    http_serialization: {old_ms: twice, new_ms: once, saved_ms: round(twice - once)},
    storage_write: storage,
    note:
      'Medians of repeated runs in one process. The HTTP pair serializes the same 800-node snapshot; the storage ' +
      'pair writes a 1 MB changed document with and without the size shortcut.',
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`AgentSys round-3 microbenchmarks (Node ${report.node}, ${report.platform})`);
    console.log(`  Workflow response: ${size.toLocaleString('en-US')} bytes`);
    console.log(`  HTTP serialization: ${twice} ms -> ${once} ms (saves ${report.http_serialization.saved_ms} ms)`);
    console.log(`  Storage write of ${storage.bytes.toLocaleString('en-US')} bytes: ${storage.old_ms} ms -> ${storage.new_ms} ms`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
