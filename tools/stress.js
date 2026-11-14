#!/usr/bin/env node
'use strict';
// A reproducible load measurement for an AgentSys Server. It starts the API server on a temporary folder, runs
// fixed scenarios, and prints JSON: latencies, throughput, worker counts and heap before/after. No dependencies.
//
//   node --expose-gc tools/stress.js [--runs 40] [--reads 300] [--records 500] [--nodes 600] [--json]
//
// The numbers are for one machine and one Node version; compare them with a previous run on the same machine,
// not with another one. The test suite asserts loose bounds; this tool is for seeing the trend.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {createApiServer} = require('../server/api-server');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? Number(args[at + 1]) : fallback;
};
const RUNS = option('runs', 40);
const READS = option('reads', 300);
const RECORDS = option('records', 500);
const NODES = option('nodes', 600);
const JSON_ONLY = args.includes('--json');
const TOKEN = 'stress-token';
const HEADERS = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const percentile = (samples, share) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
};
const round = value => Math.round(value * 100) / 100;
const heap = () => {
  if (typeof global.gc === 'function') global.gc();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-stress-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  const base = await app.listen(0);
  const call = async (method, route, body) => {
    const response = await fetch(base + '/api/' + route, {
      method,
      headers: HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const report = {started_at: new Date().toISOString(), node: process.version, platform: process.platform, runs: RUNS, reads: READS, records: RECORDS, nodes: NODES};
  const before = heap();
  try {
    await call('PUT', 'settings', {developer_mode: true});

    // 1. Reads: a protected GET on an empty project list.
    const readSamples = [];
    for (let i = 0; i < READS; i++) {
      const started = performance.now();
      await call('GET', 'projects');
      readSamples.push(performance.now() - started);
    }
    report.read_latency_ms = {median: round(percentile(readSamples, 0.5)), p95: round(percentile(readSamples, 0.95)), max: round(Math.max(...readSamples))};
    report.read_throughput_per_s = Math.round(READS / (readSamples.reduce((sum, value) => sum + value, 0) / 1000));

    // 2. Runs: one small workflow run repeatedly (the Script host is reused).
    const project = await call('POST', 'projects', {name: 'Stress runs'});
    const query = {workflow_id: project.id};
    const start = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
    const script = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 100, y: 0}});
    await call('PUT', `projects/${project.id}/input-values`, {...query, node_id: script.id, values: {script: 'node.display("ok");'}});
    await call('POST', `projects/${project.id}/port-connections`, {
      ...query,
      add: [{source: start.id, source_port: 'out', target: script.id, target_port: 'in'}],
    });
    const runSamples = [];
    let failures = 0;
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      const result = await call('POST', `projects/${project.id}/execution`, {...query, wait: true});
      runSamples.push(performance.now() - started);
      if (Object.keys(result.errors || {}).length) failures++;
    }
    report.run_latency_ms = {median: round(percentile(runSamples, 0.5)), p95: round(percentile(runSamples, 0.95)), max: round(Math.max(...runSamples))};
    report.run_failures = failures;

    // 3. Writes: records into a generic collection (one document rewritten per write).
    await call('PUT', 'collections/stress', {
      title: 'Stress',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    const writeSamples = [];
    for (let i = 0; i < RECORDS; i++) {
      const started = performance.now();
      await call('POST', 'collections/stress/records', {data: {n: i}});
      writeSamples.push(performance.now() - started);
    }
    report.record_write_latency_ms = {median: round(percentile(writeSamples, 0.5)), p95: round(percentile(writeSamples, 0.95))};
    report.record_write_throughput_per_s = Math.round(RECORDS / (writeSamples.reduce((sum, value) => sum + value, 0) / 1000));
    const listed = performance.now();
    const page = await call('GET', 'collections/stress/records?limit=100&offset=250');
    report.record_page_latency_ms = round(performance.now() - listed);
    report.records_stored = page.total;

    // 4. A large workflow: saved in batches, then read whole.
    const large = await call('POST', 'projects', {name: 'Stress graph'});
    const largeQuery = {workflow_id: large.id};
    const saveStarted = performance.now();
    for (let batch = 0; batch < Math.ceil(NODES / 100); batch++) {
      const operations = [];
      for (let i = 0; i < 100 && batch * 100 + i < NODES; i++) {
        const n = batch * 100 + i;
        operations.push({
          method: 'POST',
          path: 'typed-nodes',
          body: {
            node_type: 'custom',
            config: {title: 'Node ' + n, op: 'on_run', inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}]},
            position: {x: (n % 40) * 40, y: Math.floor(n / 40) * 40},
          },
        });
      }
      await call('POST', `projects/${large.id}/batch`, {...largeQuery, operations});
    }
    report.graph_save_ms = round(performance.now() - saveStarted);
    const graphReads = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const graph = await call('GET', `projects/${large.id}/workflow?workflow_id=${large.id}`);
      graphReads.push(performance.now() - started);
      report.graph_nodes = graph.nodes.length;
    }
    report.graph_read_ms = {median: round(percentile(graphReads, 0.5)), p95: round(percentile(graphReads, 0.95))};

    // 5. Stop under load: start twelve runs and stop them; nothing may stay running.
    const parallel = await call('POST', 'projects', {name: 'Stress stop'});
    const parallelQuery = {workflow_id: parallel.id};
    const roots = [];
    for (let i = 0; i < 12; i++) {
      const trigger = await call('POST', `projects/${parallel.id}/primitives`, {...parallelQuery, primitive: 'event', point: {x: i * 40, y: 0}});
      const worker = await call('POST', `projects/${parallel.id}/primitives`, {...parallelQuery, primitive: 'script', point: {x: i * 40, y: 80}});
      await call('PUT', `projects/${parallel.id}/input-values`, {...parallelQuery, node_id: worker.id, values: {script: 'await node.sleep(2000); node.display("late");'}});
      await call('POST', `projects/${parallel.id}/port-connections`, {
        ...parallelQuery,
        add: [{source: trigger.id, source_port: 'out', target: worker.id, target_port: 'in'}],
      });
      roots.push(trigger.id);
    }
    await Promise.all(roots.map(id => call('POST', `projects/${parallel.id}/execution`, {...parallelQuery, node_ids: [id]})));
    await sleep(50);
    const stopStarted = performance.now();
    await call('DELETE', `projects/${parallel.id}/execution?workflow_id=${parallel.id}`);
    report.stop_ms = round(performance.now() - stopStarted);
    let status = '';
    for (let i = 0; i < 200; i++) {
      status = (await call('GET', `projects/${parallel.id}/execution?workflow_id=${parallel.id}`)).status;
      if (status === 'idle') break;
      await sleep(25);
    }
    report.stop_final_status = status;
    const diagnostics = await call('GET', 'diagnostics');
    report.running_runtimes_after_stop = diagnostics.runtime.running;
    report.workers = diagnostics.workers;
    report.sessions = diagnostics.sessions;
    report.storage = diagnostics.storage.mode;
    report.heap_mb_before = before;
    report.heap_mb_after = heap();
    report.open_handles = process._getActiveHandles().length;
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
  if (JSON_ONLY) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('AgentSys stress report (' + report.started_at + ')');
    for (const [key, value] of Object.entries(report))
      if (!['started_at', 'node', 'platform'].includes(key)) console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
