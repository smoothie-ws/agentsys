'use strict';
// Loads the server half of the app (shared helpers, storage, model, backend) into a Node vm context. The script
// list is the fixed manifest in server/manifest.js: the client's index.html cannot add code to the server.
// Used by the server (HTTP API, worker threads, data folder) and by the tests (in memory, Scripts inline).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const {Worker} = require('node:worker_threads');
const {FILES} = require('./server/manifest');

/**
 * An HTTP(S) request that connects to `address` instead of resolving the hostname a second time. This is the
 * pinned transport used when a policy refuses private destinations: a DNS reply cannot change between the check
 * and the connection (DNS rebinding). It keeps the fetch-like surface the net route uses: no redirect following,
 * a hard response limit and abort support.
 */
function pinnedRequest({url, method = 'GET', headers = {}, body, address, limit = 2000000, timeout = 30000, signal}) {
  return new Promise((resolve, reject) => {
    const target = new URL(String(url));
    const secure = target.protocol === 'https:';
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const options = {
      method: String(method || 'GET').toUpperCase(),
      host: hostname,
      port: target.port || (secure ? 443 : 80),
      path: target.pathname + target.search,
      headers,
      ...(secure ? {servername: hostname} : {}),
    };
    if (address) {
      options.lookup = (name, opts, callback) => {
        const done = typeof opts === 'function' ? opts : callback;
        const family = address.includes(':') ? 6 : 4;
        if (typeof opts === 'object' && opts?.all) done(null, [{address, family}]);
        else done(null, address, family);
      };
    }
    const request = (secure ? https : http).request(options, response => {
      const stream = response;
      const decoder =
        /^gzip$/i.test(response.headers['content-encoding'] || '')
          ? zlib.createGunzip()
          : /^deflate$/i.test(response.headers['content-encoding'] || '')
            ? zlib.createInflate()
            : /^br$/i.test(response.headers['content-encoding'] || '')
              ? zlib.createBrotliDecompress()
              : null;
      const chunks = [];
      let size = 0;
      const fail = error => {
        stream.destroy();
        reject(error);
      };
      const source = decoder ? stream.pipe(decoder) : stream;
      source.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          const error = new Error('Network response is too large');
          error.code = 'too_large';
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      source.on('end', () =>
        resolve({status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')})
      );
      source.on('error', fail);
      stream.on('error', fail);
    });
    request.on('error', reject);
    request.setTimeout(timeout, () => {
      const error = new Error('The network request timed out');
      error.code = 'timeout';
      request.destroy(error);
    });
    const abort = () => {
      const error = new Error('The request was aborted');
      error.code = 'aborted';
      request.destroy(error);
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, {once: true});
    }
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.end(body === undefined || ['GET', 'HEAD'].includes(options.method) ? undefined : body);
  });
}

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
function loadBackend({root, store = null, scripts = 'worker', allowedNetHosts = null, blockPrivateNet = false} = {}) {
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
  if (allowedNetHosts && allowedNetHosts.length) sandbox.AGENTSYS_NET_ALLOW = allowedNetHosts.slice();
  if (blockPrivateNet) sandbox.AGENTSYS_NET_BLOCK_PRIVATE = true;
  // The pinned transport is only used for a deny-private policy; ordinary calls keep the fetch semantics.
  sandbox.AGENTSYS_HTTP_REQUEST = pinnedRequest;
  // Only the trusted backend sees this: a Script runs in a worker (or in the legacy inline sandbox) and has no API
  // to reach it. The net route uses it to refuse private destinations before a connection is made.
  try {
    const dns = require('node:dns');
    sandbox.AGENTSYS_RESOLVE = hostname => dns.promises.lookup(String(hostname), {all: true, verbatim: true});
  } catch {
    /* a runtime without DNS: the net route then refuses a deny-private policy with a clear error */
  }
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

module.exports = {loadBackend, pinnedRequest};
