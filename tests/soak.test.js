'use strict';
// A short soak in the suite: the loop is bounded by time, and the thresholds catch a leak or a runtime left
// running. The longer run is tools/soak.js (60 s by default) and is recorded in BENCHMARKS.md.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {runSoak} = require('../tools/soak');

test('a short soak finishes with no error, no running runtime and bounded memory', {timeout: 120000}, async () => {
  const samples = [];
  const report = await runSoak({seconds: 8, onSample: sample => samples.push(sample)});
  assert.deepEqual(report.error_messages, []);
  assert.equal(report.errors, 0);
  assert.ok(report.cycles >= 5, `the loop made progress (${report.cycles} cycles)`);
  assert.equal(report.running_runtimes, 0, 'no runtime is left running');
  assert.ok(report.worker_start.started >= 1, 'the work really ran');
  assert.ok(report.heap_growth_mb < 64, `heap grew by ${report.heap_growth_mb} MB`);
  assert.ok(report.heap_max_mb < 256, `heap peaked at ${report.heap_max_mb} MB`);
  assert.ok(report.rss_growth_mb < 200, `RSS grew by ${report.rss_growth_mb} MB`);
  assert.ok(report.run_p95_ms < 2000, `run p95 ${report.run_p95_ms} ms`);
  assert.ok(report.request_p95_ms < 500, `request p95 ${report.request_p95_ms} ms`);
  assert.ok(report.runtimes === 0, `${report.runtimes} runtime(s) survived their deleted workflows`);
  assert.ok(report.handles_end.handles <= 12, `active handles stayed bounded (${report.handles_end.handles})`);
  assert.ok(report.handles_end.handles <= report.handles_max.handles, 'no handle outlived the peak sample');
  assert.ok(report.handles_max.listeners <= report.handles_start.listeners + 8, 'event listeners stayed bounded');
  assert.ok(samples.length >= report.cycles, 'the loop was sampled');
  assert.ok(samples.every(sample => Number.isFinite(sample.rss_mb) && sample.handles), 'memory and handles were sampled');
});
