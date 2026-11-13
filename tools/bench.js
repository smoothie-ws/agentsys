#!/usr/bin/env node
'use strict';
// Reproducible measurements for the hardening work: graph reads, runtime reads, a 5 000-assignment
// Script loop, database commits, idle runtimes and the size of data/. No dependencies.
//
//   node tools/bench.js           read the numbers in a table
//   node tools/bench.js --json    the same numbers as JSON (for before/after files)
//
// The graph shapes match docs/baseline.md: a chain of Scripts, 10 workflow reads per size,
// 50 runtime reads at 800 nodes, 2 500 context.state + 2 500 node.output assignments.

const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {createApp, nodes, fn, TYPES} = require('../tests/harness');

const root = path.resolve(__dirname, '..');
const SIZES = [100, 200, 400, 800];
const READS = 10;
const RUNTIME_READS = 50;
const IDLE_VISITS = 20;

function memoryStore() {
  const data = new Map(),
    stats = {commits: 0, writes: 0};
  return {
    stats,
    get: key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    commit: ({set, remove}) => {
      stats.commits++;
      for (const [key, value] of Object.entries(set)) {
        data.set(key, structuredClone(value));
        stats.writes++;
      }
      for (const key of remove) data.delete(key);
    },
  };
}

function directorySize(dir) {
  let bytes = 0,
    files = 0;
  if (!fs.existsSync(dir)) return {bytes, files};
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.openchamber') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = directorySize(full);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      bytes += fs.statSync(full).size;
      files++;
    }
  }
  return {bytes, files};
}

// The bench measures the backend call itself: unlike tests/harness.js's api(), it does not copy the
// result out of the vm realm (the editor calls Backend.request in-process, with no JSON round trip).
const backendGet = (app, path, query = {}) => app.Backend.request('GET', path, {body: {}, query});

async function addTypes(app, project) {
  await app.api('PUT', `projects/${project.id}/types`, {types: Object.values(TYPES)});
}

/** A project whose workflow is a chain of `size` Scripts, wired output to input. */
async function makeGraph(app, size, name) {
  const project = await app.api('POST', 'projects', {name});
  await addTypes(app, project);
  const ids = [];
  for (let start = 0; start < size; start += 200) {
    const operations = [];
    for (let i = start; i < Math.min(size, start + 200); i++)
      operations.push({
        path: 'typed-nodes',
        method: 'POST',
        body: {
          node_type: 'custom',
          config: {...nodes.script(''), title: 'Step ' + i},
          position: {x: (i % 40) * 220, y: Math.floor(i / 40) * 120},
        },
      });
    const result = await app.api('POST', `projects/${project.id}/batch`, {operations});
    ids.push(...result.results.map(node => node.id));
  }
  for (let start = 0; start < ids.length - 1; start += 200) {
    const add = [];
    for (let i = start; i < Math.min(ids.length - 1, start + 200); i++)
      add.push({source: ids[i], source_port: 'out', target: ids[i + 1], target_port: 'in'});
    await app.api('POST', `projects/${project.id}/port-connections`, {add});
  }
  return {project, ids};
}

async function timed(times, work, warmup = true) {
  if (warmup) await work(0);
  const samples = [];
  const started = performance.now();
  for (let i = 0; i < times; i++) {
    const at = performance.now();
    await work(i);
    samples.push(performance.now() - at);
  }
  const ms = performance.now() - started;
  samples.sort((a, b) => a - b);
  return {times, ms: round(ms), per: round(ms / times), median: round(samples[Math.floor(samples.length / 2)])};
}

const round = value => Math.round(value * 1000) / 1000;

function lineCount(pattern) {
  let total = 0;
  for (const file of pattern) total += fs.readFileSync(file, 'utf8').split('\n').length;
  return total;
}

function filesUnder(dir, extension) {
  const found = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, extension));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

async function groupedGraph(app, size = 800, groupSize = 4) {
  const {project, ids} = await makeGraph(app, size, 'Bench grouped');
  const groups = [];
  for (let i = 0; i < ids.length; i += groupSize)
    groups.push({id: 'g' + i, name: 'Group ' + i, members: ids.slice(i, i + groupSize)});
  await app.api('PUT', `projects/${project.id}/groups`, {groups});
  return {project, path: `projects/${project.id}/workflow`};
}

async function main() {
  const json = process.argv.includes('--json');
  const store = memoryStore();
  const app = createApp({store});
  const report = {node: process.version, measured_at: new Date().toISOString(), workflow_get: {}, execution_get: {}, loop: {}, runtimes: {}, data: {}};
  try {
    for (const size of SIZES) {
      const {project} = await makeGraph(app, size, `Bench ${size}`);
      report.workflow_get[size] = await timed(
        READS,
        () => backendGet(app, `projects/${project.id}/workflow`)
      );
    }

    const {project: large, ids} = await makeGraph(app, 800, 'Bench runtime');
    const path800 = `projects/${large.id}/execution`;
    await backendGet(app, path800);
    report.execution_get[800] = await timed(RUNTIME_READS, () => backendGet(app, path800));

    const grouped = await groupedGraph(app);
    report.grouped_get = await timed(5, () => backendGet(app, grouped.path));

    // 2 500 assignments to context.state and 2 500 to a Script output: five wait:true dispatches,
    // the median is the measurement.
    const loopProject = await app.api('POST', 'projects', {name: 'Bench loop'});
    const writer = await fn(app, loopProject.id, {}, {
      code: 'for(let i=0;i<2500;i++){context.state.count=i;node.output.value=i;}',
      outputs: ['value'],
    });
    const loopTimes = [];
    for (let i = 0; i < 5; i++) {
      store.stats.commits = 0;
      const loopStarted = performance.now();
      const loopResult = await app.api('POST', `projects/${loopProject.id}/execution`, {
        node_ids: [writer.id],
        wait: true,
      });
      loopTimes.push(round(performance.now() - loopStarted));
      if (loopResult.dispatch_status !== 'completed') throw Error('loop dispatch ' + loopResult.dispatch_status);
    }
    const sorted = [...loopTimes].sort((a, b) => a - b);
    report.loop = {
      assignments: 5000,
      ms: sorted[Math.floor(sorted.length / 2)],
      runs: loopTimes,
      commits: store.stats.commits,
    };

    // Idle runtimes: visit 20 workflows (one per project) and count what the server kept.
    const before = app.eval('GRAPH_RUNTIMES.size');
    for (let i = 0; i < IDLE_VISITS; i++) {
      const project = await app.api('POST', 'projects', {name: 'Idle visit ' + i});
      await app.api('GET', `projects/${project.id}/execution`);
    }
    report.runtimes = {
      visited: IDLE_VISITS,
      before,
      live: app.eval('GRAPH_RUNTIMES.size'),
      non_idle: app.eval(
        `[...GRAPH_RUNTIMES.values()].filter(e=>e.pending.size||e.paused||e.detached.size||e.stopping||e.saving||e.dirty||e.deleted)
          .map(e=>({workflow:e.workflow,pending:e.pending.size,paused:e.paused,saving:!!e.saving,dirty:e.dirty,stopping:!!e.stopping}))`
      ),
    };

    // Library type cleanup checks many unused ids against every workflow. It should read the
    // workflows once, not once per id (V12).
    const typeIds = Array.from({length: 20}, (_, i) => 'f'.repeat(31) + i.toString(16)),
      unusedIds = Array.from({length: 20}, (_, i) => 'e'.repeat(31) + i.toString(16));
    for (let i = 0; i < 6; i++) {
      const project = await app.api('POST', 'projects', {name: 'Typed ' + i});
      await app.api('POST', `projects/${project.id}/typed-nodes`, {
        node_type: 'custom',
        config: {
          ...nodes.script(typeIds.map((id, j) => `const ref${i}_${j} = "${'t:' + id}";`).join('\n')),
          title: 'Typed ' + i,
        },
        position: {x: 0, y: 0},
      });
    }
    report.type_in_use = {
      ids: unusedIds.length,
      workflows: 6,
      ms: round(
        await app.eval(
          `(async()=>{const ids=${JSON.stringify(unusedIds)};const call=new Call('GET',{},{workflow_id:null},null);
            const started=Date.now();for(const id of ids)await call.typeInUse(id);return Date.now()-started;})()`
        )
      ),
    };

    const data = directorySize(path.join(root, 'data'));
    report.data = {bytes: data.bytes, files: data.files, human: (data.bytes / 1024 / 1024).toFixed(1) + ' MB'};
    report.lines = {
      handwritten_js: lineCount(filesUnder(path.join(root, 'js'), '.js').filter(f => !f.endsWith('builtin-nodes.js'))),
      generated_js: lineCount([path.join(root, 'js/backend/builtin-nodes.js')]),
      css: lineCount(filesUnder(path.join(root, 'css'), '.css')),
      server: lineCount([path.join(root, 'server.js'), path.join(root, 'headless.js'), path.join(root, 'plugin-host.js')]),
    };
    report.workers = {...app.workerStats};
  } finally {
    await app.Backend.shutdownExecutions();
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const pad = (value, width) => String(value).padStart(width);
  console.log(`AgentSys bench (Node ${report.node})`);
  console.log('\nGET workflow (10 reads, one warm-up; median read):');
  for (const size of SIZES) {
    const item = report.workflow_get[size];
    console.log(`  ${pad(size + ' nodes', 10)} ${pad(item.median + ' ms', 10)}  ${pad(item.per + ' ms/read', 14)}`);
  }
  console.log(`\nGET execution (${RUNTIME_READS} reads, 800 nodes): ${report.execution_get[800].ms} ms (${report.execution_get[800].per} ms/read)`);
  console.log(`\nGET workflow (800 nodes, 200 groups): ${report.grouped_get.median} ms/read`);
  console.log(
    `\nScript loop (${report.loop.assignments} assignments, median of ${report.loop.runs.length}): ${report.loop.ms} ms, ${report.loop.commits} DB commits`
  );
  console.log(
    `Library type lookup (${report.type_in_use.ids} ids over ${report.type_in_use.workflows} workflows): ${report.type_in_use.ms} ms`
  );
  console.log(`Idle runtimes after ${report.runtimes.visited} workflow visits: ${report.runtimes.live} (was ${report.runtimes.before})`);
  console.log(`data/: ${report.data.human} in ${report.data.files} files`);
  console.log(
    `lines: ${report.lines.handwritten_js} hand-written JS, ${report.lines.generated_js} generated, ${report.lines.css} CSS, ${report.lines.server} server`
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
