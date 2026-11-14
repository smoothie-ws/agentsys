'use strict';
// Loads the server half of the app (shared helpers, storage, model, backend) into a Node vm context. The script
// list is the fixed manifest in server/manifest.js: the client's index.html cannot add code to the server.
// Used by the server (HTTP API, worker threads, data folder) and by the tests (in memory, Scripts inline).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {Worker} = require('node:worker_threads');
const {FILES} = require('./server/manifest');

// A worker thread that looks like the browser's Web Worker to the Script runner (backend/scripts.js).
const WORKER_PRELUDE = `const {parentPort} = require('node:worker_threads');
const vm = require('node:vm');
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
const timers = new Map(); let serial = 0;
const sandbox = {__host:{
  send: text => parentPort.postMessage(JSON.parse(text)),
  schedule: (fn,ms) => {const id=++serial;timers.set(id,setTimeout(()=>{timers.delete(id);fn();},ms));return id;},
  clear: id => {clearTimeout(timers.get(id));timers.delete(id);}
}};
const context = vm.createContext(sandbox);
vm.runInContext(\`(() => {
  const host = globalThis.__host; delete globalThis.__host;
  const encode=JSON.stringify;
  globalThis.self = globalThis;
  globalThis.postMessage = value => host.send(encode(value));
  globalThis.setTimeout = (fn,ms,...args) => host.schedule(()=>fn(...args),ms);
  globalThis.clearTimeout = id => host.clear(id);
})();\`,context);
let receiver;
parentPort.on('message',data=>receiver(JSON.stringify(data)));
`;
class NodeWorker {
  exited = false;
  constructor(source, stats) {
    this.stats = stats;
    stats.started++;
    this.worker = new Worker(WORKER_PRELUDE + '\nreceiver = vm.runInContext(' + JSON.stringify(source) + ',context);', {
      eval: true,
    });
    this.worker.on('message', data => this.onmessage?.({data}));
    this.worker.on('error', error => this.onerror?.({message: error.message}));
    this.worker.on('exit', () => {
      stats.exited++;
      this.exited = true;
      this.onerror?.({message: 'the script stopped without an answer'});
    });
  }
  postMessage(message) {
    this.worker.postMessage(message);
  }
  terminate() {
    if (!this.terminating) {
      this.terminating = true;
      this.stats.terminated++;
    }
    this.worker.terminate();
  }
  // A worker waiting for its script must not keep the process alive.
  ref() {
    this.worker.ref();
  }
  unref() {
    this.worker.unref();
  }
}

/**
 * A fresh application backend.
 * `store` ({dir, get(key), commit({set, remove})}) keeps the data somewhere durable; without it the data is in memory.
 * `scripts` is 'worker' (worker threads) or 'inline'.
 */
function loadBackend({root, store = null, scripts = 'worker'} = {}) {
  const workerStats = {started: 0, terminated: 0, exited: 0};
  root = path.resolve(root || __dirname);
  const files = FILES;
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    AbortController,
    AbortSignal,
    fetch: globalThis.fetch,
  };
  if (store) sandbox.AGENTSYS_STORE = store;
  if (scripts === 'worker') sandbox.AGENTSYS_SPAWN_WORKER = source => new NodeWorker(source, workerStats);
  const context = vm.createContext(sandbox);
  context.self = context;
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});

  return {
    workerStats,
    context,
    Backend: vm.runInContext('Backend', context),
    DB: vm.runInContext('DB', context),
    eval: code => vm.runInContext(code, context),
  };
}

module.exports = {loadBackend};
