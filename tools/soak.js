#!/usr/bin/env node
'use strict';
// A bounded soak: create, edit, run and delete a small workflow over and over, with a collection record per
// cycle, sampling the heap. It stops on its own after --seconds and reports what grew. Designed to finish:
// no loop without a deadline, no unbounded data.
//
//   node --expose-gc tools/soak.js --seconds 60
//   node tools/soak.js --seconds 10 --json
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (samples, share) => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] * 100) / 100;
};
const heap = () => {
  if (typeof global.gc === 'function') global.gc();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
};
const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const resources = () => {
  const names = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  return {
    handles: (typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : []).length,
    requests: (typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : []).length,
    resources: names.length,
    listeners: typeof process.eventNames === 'function' ? process.eventNames().length : 0,
  };
};
const descriptors = () => {
  if (process.platform !== 'linux') return null;
  try {
    return require('node:fs').readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
};

/**
 * Runs the loop and returns a report. The caller owns `dataDir` when it passes one; otherwise a temporary folder
 * is created and removed. `onSample` sees every sample (used by tests to watch progress).
 */
async function runSoak({seconds = 60, dataDir = null, onSample = null} = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-soak-'));
  const app = createApiServer({dataDir: dir, token: 'soak-token'});
  const base = await app.listen(0);
  const headers = {Authorization: 'Bearer soak-token', 'Content-Type': 'application/json', 'X-AgentSys': '1'};
  const call = async (method, route, body) => {
    const startedAt = performance.now();
    const response = await fetch(base + '/api/' + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    report.request_ms.push(performance.now() - startedAt);
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const report = {
    seconds,
    cycles: 0,
    errors: 0,
    error_messages: [],
    run_ms: [],
    request_ms: [],
    heap_start_mb: heap(),
    heap_end_mb: 0,
    heap_max_mb: 0,
    rss_start_mb: rss(),
    rss_end_mb: 0,
    rss_max_mb: 0,
    handles_start: resources(),
    handles_end: null,
    handles_max: {handles: 0, requests: 0, resources: 0, listeners: 0},
    fds_start: descriptors(),
    fds_end: null,
    fds_max: 0,
    sessions: null,
    plugin_sessions: null,
    runtimes: null,
    client_streams: null,
    worker_start: null,
    running_runtimes: null,
    data_dir: dir,
  };
  const sampleHandles = () => {
    const now = resources();
    for (const key of Object.keys(report.handles_max)) report.handles_max[key] = Math.max(report.handles_max[key], now[key]);
    const fds = descriptors();
    if (fds !== null) report.fds_max = Math.max(report.fds_max, fds);
  };
  const deadline = Date.now() + seconds * 1000;
  try {
    await call('PUT', 'settings', {developer_mode: true});
    await call('PUT', 'collections/soak', {
      title: 'Soak',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    while (Date.now() < deadline) {
      const cycle = report.cycles;
      try {
        const project = await call('POST', 'projects', {name: 'Soak ' + cycle});
        const query = {workflow_id: project.id};
        const event = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
        const script = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 80, y: 0}});
        await call('PUT', `projects/${project.id}/input-values`, {
          ...query,
          node_id: script.id,
          values: {script: `node.display("cycle ${cycle}");`},
        });
        await call('POST', `projects/${project.id}/port-connections`, {
          ...query,
          add: [{source: event.id, source_port: 'out', target: script.id, target_port: 'in'}],
        });
        const started = performance.now();
        const run = await call('POST', `projects/${project.id}/execution`, {...query, wait: true});
        report.run_ms.push(performance.now() - started);
        if (Object.keys(run.errors || {}).length) throw new Error('run errors: ' + JSON.stringify(run.errors));
        const graph = await call('GET', `projects/${project.id}/workflow?workflow_id=${project.id}`);
        if (graph.nodes.length !== 2) throw new Error('graph read back with ' + graph.nodes.length + ' nodes');
        await call('POST', 'collections/soak/records', {data: {n: cycle}});
        await call('DELETE', `projects/${project.id}`);
        report.cycles++;
      } catch (error) {
        report.errors++;
        if (report.error_messages.length < 10) report.error_messages.push(String(error.message || error));
      }
      if (report.cycles % 10 === 0) heap(); // let the runtime collect between samples when --expose-gc is used
      const sample = heap();
      report.heap_max_mb = Math.max(report.heap_max_mb, sample);
      report.rss_max_mb = Math.max(report.rss_max_mb, rss());
      sampleHandles();
      if (onSample)
        onSample({cycle: report.cycles, heap_mb: sample, rss_mb: rss(), handles: resources(), report});
      await sleep(1);
    }
    const diagnostics = await call('GET', 'diagnostics');
    report.worker_start = diagnostics.workers;
    report.running_runtimes = diagnostics.runtime.running;
    report.plugin_sessions = diagnostics.plugin_sessions;
    report.sessions = diagnostics.sessions;
    report.client_streams = diagnostics.clients;
    report.runtimes = diagnostics.runtime.runtimes?.length ?? null;
  } finally {
    report.heap_end_mb = heap();
    report.heap_growth_mb = report.heap_end_mb - report.heap_start_mb;
    report.rss_end_mb = rss();
    report.rss_growth_mb = report.rss_end_mb - report.rss_start_mb;
    report.run_median_ms = percentile(report.run_ms, 0.5);
    report.run_p95_ms = percentile(report.run_ms, 0.95);
    report.request_median_ms = percentile(report.request_ms, 0.5);
    report.request_p95_ms = percentile(report.request_ms, 0.95);
    await app.close();
    // Give the HTTP client its idle sockets a moment to close before counting; a real leak stays above this.
    await sleep(250);
    report.handles_end = resources();
    report.fds_end = descriptors();
    if (!dataDir) fs.rmSync(dir, {recursive: true, force: true});
  }
  return report;
}

async function main() {
  const report = await runSoak({seconds: option('seconds', 60)});
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Soak: ${report.cycles} cycles in ${report.seconds}s, ${report.errors} error(s)`);
    console.log(`  Runs: median ${report.run_median_ms} ms, p95 ${report.run_p95_ms} ms`);
    console.log(`  Heap: ${report.heap_start_mb} -> ${report.heap_end_mb} MB (max ${report.heap_max_mb} MB)`);
    console.log(`  RSS: ${report.rss_start_mb} -> ${report.rss_end_mb} MB (max ${report.rss_max_mb} MB)`);
    console.log(
      `  Requests: median ${report.request_median_ms} ms, p95 ${report.request_p95_ms} ms; ` +
        `handles max ${JSON.stringify(report.handles_max)}`
    );
    if (report.fds_start !== null) console.log(`  File descriptors: ${report.fds_start} -> ${report.fds_end} (max ${report.fds_max})`);
    console.log(`  Workers: ${JSON.stringify(report.worker_start)}`);
    console.log(
      `  After the loop: ${report.running_runtimes} running runtime(s), ${report.runtimes} live runtime(s), ` +
        `${report.sessions} session(s), ${report.client_streams} stream(s)`
    );
    if (report.error_messages.length) console.log('  Errors: ' + report.error_messages.join(' | '));
  }
  // Bounded thresholds: a leak or a stuck runtime fails the run rather than being printed and ignored.
  const failed =
    report.errors > 0 ||
    report.heap_growth_mb > 100 ||
    report.rss_growth_mb > 200 ||
    report.running_runtimes !== 0 ||
    (report.fds_start !== null && report.fds_end > report.fds_start + 5);
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {runSoak};
