// Custom node execution: a run (a plan, see compilePlan) is carried out by executePlan in one Web Worker; the code of its nodes can
// call the site's API and show text or an image on its node with display().
'use strict';

// ----- Pieces the Web Worker and the in-process runner (headless.js, for tests) share: displayText, and executePlan (model/executor.js) -----
/** What display(a, b, ...) leaves on a node: the parts one after another, told apart by the separator (U+001E). */
function displayText(values) {
  if (values.length > 50) throw new Error('display() shows at most 50 values.');
  return values.map(displayPart).join('\u001e');
}
/** One part: a string as it is, an image ({mime_type, data}) as a data URL, anything else as indented JSON. */
function displayPart(value) {
  if (
    value &&
    typeof value === 'object' &&
    /^image\/(png|jpeg|gif|webp)$/.test(value.mime_type) &&
    typeof value.data === 'string'
  ) {
    if (value.data.length > 3000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
      throw new Error('This image cannot be displayed: it is too large or not base64.');
    return 'data:' + value.mime_type + ';base64,' + value.data;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return String(text === undefined ? value : text)
    .replaceAll('\u001e', ' ')
    .slice(0, MAX_DISPLAY);
}

// Pieces of the isolation every Worker source starts and ends with: the shared intrinsics are frozen first, and the
// host APIs are hidden last (after the source has taken what it needs from them). Plugin endpoints (plugins.js) use the same.
const WORKER_FREEZE = `// Freeze the intrinsics the executor shares with node code: replacing Map.get, Promise
// or JSON must not let a Script impersonate a different invocation at the host bridge.
for (const name of ['Object','Array','Map','Set','Promise','Date','RegExp','String','Number','Boolean','Function','Error','TypeError','Uint8Array','ArrayBuffer','JSON','Math']) {
  const value=globalThis[name]; if(value?.prototype)Object.freeze(value.prototype);Object.freeze(value);
  if(!['Date','Math'].includes(name))Object.defineProperty(globalThis,name,{value,writable:false,configurable:false});
}
`;
const WORKER_BLOCKED = ['fetch','importScripts','Worker','SharedWorker','WebSocket','WebSocketStream','WebTransport','RTCPeerConnection','XMLHttpRequest','EventSource','navigator','indexedDB','caches','Cache','BroadcastChannel','MessageChannel','postMessage','close','process','require','onmessage','addEventListener','removeEventListener','dispatchEvent','MessageEvent','crypto','performance','Date','Math'];
const workerBlock = names => `const blocked = ${JSON.stringify(names)};
for (let object=globalThis; object && object!==Object.prototype; object=Object.getPrototypeOf(object)) {
  for(const name of blocked){
    const descriptor=Object.getOwnPropertyDescriptor(object,name);
    if(object===globalThis||descriptor?.configurable)Object.defineProperty(object,name,{value:undefined,writable:false,configurable:false});
    else if(descriptor&&descriptor.value!==undefined)throw new Error('Cannot isolate Worker API: '+name);
  }
}
`;

// ----- Plans in a Web Worker -----
// The Worker is told the plan, carries it out with executePlan and reports each event; the code of a node reaches the site's API
// through the page (`call`). Nothing is left in the global scope for the code to use: `node`, `agentsys` and `context` are
// variables of the node's own function (see executePlan), and the global names answer with an explanation.
const WORKER_SOURCE = `
(() => {
const send = globalThis.postMessage.bind(globalThis);
const Date = globalThis.Date, Math = globalThis.Math;
${WORKER_FREEZE}
const MAX_DISPLAY = ${MAX_DISPLAY};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
${displayPart}
${displayText}
${executePlan}
const pending = new Map();
const gate = {paused: false, waiters: []};
let sequence = 0;
const call = (node, method, path, body, query, invocation) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, {resolve, reject}); send({type: 'call', id, node, invocation, args: [method, path, body, query]}); });
// A script that fails after its node is done must not stop the run.
self.onerror = () => true;
self.addEventListener?.('unhandledrejection', event => event.preventDefault());
for (const name of ['agentsys', 'context'])
  Object.defineProperty(self, name, {configurable: true, get() { throw new Error(name + ' is a variable of the node code, not a global: pass it on to the functions that need it.'); }});
for (const name of ['display', 'emit', 'read', 'output', 'widgets'])
  Object.defineProperty(self, name, {configurable: true, get() { throw new Error(name + ' is not a variable of the node code: it is part of node (node.' + (name === 'read' ? 'input.<name> or node.reread(name)' : name === 'output' ? 'output.<name>' : name) + ').'); }});
const receive = async ({data}) => {
  if (data.type === 'pause') return void (gate.paused = true);
  if (data.type === 'resume') {
    gate.paused = false;
    return gate.waiters.splice(0).forEach(wake => wake());
  }
  if (data.type === 'reply') {
    const entry = pending.get(data.id); pending.delete(data.id);
    return data.error ? entry.reject(Object.assign(new Error(data.error),{code:data.code})) : entry.resolve(data.result);
  }
  try {
    gate.paused = data.plan.start_paused === true;
    const result = await executePlan(data.plan, {AsyncFunction, displayText, call, limits: data.plan.limits, gate, emit: event => send({type: 'event', event})});
    send({type: 'finished', result});
  } catch (error) {
    send({type: 'crash', error: String(error && error.message || error).slice(0, 2000)});
  }
};
globalThis.addEventListener?.('message',receive);
${workerBlock(WORKER_BLOCKED)}
return text => receive({data:JSON.parse(text)});
})();`;
const workerURLs = new Map();
/** API calls from a script. Calls on the script's own project default to its own workflow. */
const liveBridgeFor = context => ({
  request: async ([method, path, body, query]) => {
    method = String(method).toUpperCase();
    path = String(path)
      .replace(/^\/?(api\/)?/, '')
      .replace(/\/+$/, '');
    body = {...(body ?? {})};
    query = {...(query ?? {})};
    if (context.workflow_id && path.startsWith(`projects/${context.project_id}/`)) {
      if (method === 'GET' || method === 'DELETE') query.workflow_id ??= context.workflow_id;
      else body.workflow_id ??= context.workflow_id;
    }
    await assertScriptPermission(context, method, path, body);
    if (method !== 'GET') {
      body = quarantineWrite(body);
      if (path === 'resources') body.payload = {...body.payload, grants: ['graph.read']};
      if (body.config) body.config = {...body.config, grants: ['graph.read']};
      if (path.startsWith('resources/') && body.payload) body.payload = {...body.payload, grants: ['graph.read']};
    }
    if (context.signal?.aborted) throw new Error('Execution stopped');
    return stripSecrets(await Backend.request(method, path, {body, query, scriptContext: context}));
  },
});
const bridgeFor = liveBridgeFor;
function planHost(plan, onEvent, control, signal) {
  const steps = new Map(plan.nodes.map(step=>[step.id,step]));
  return {
    attach: send=>control?.attach(send),
    call: (id,method,path,body,query)=>bridgeFor({...plan.context,node_id:id,step:steps.get(id),signal}).request([method,path,body,query]),
    emit:onEvent,
  };
}
/** A new Worker running `source`. The headless server (headless.js) supplies its own, with the same interface. */
function startSourceWorker(source) {
  if (typeof AGENTSYS_SPAWN_WORKER === 'function') return AGENTSYS_SPAWN_WORKER(source);
  if (!workerURLs.has(source)) workerURLs.set(source, URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
  return new Worker(workerURLs.get(source));
}
const startWorker = () => startSourceWorker(WORKER_SOURCE);
const spawnWorker = startWorker;
/** How long the page waits, beyond a node's own time limit, for a Worker whose code never lets go (an endless loop) before it ends the run. */
const WATCHDOG_GRACE = 2000;
/**
 * Carries out a plan in a Worker of its own, so nothing one run leaves behind (globals, timers) reaches the next.
 * `onEvent` is told each event (see executePlan); `signal` (optional AbortSignal) ends the run at once; `control` (optional, see
 * the execution control in execution.js) pauses and resumes it: no node starts while it is paused. Resolves when the run is
 * over; rejects when it was cut short: cancelled, a script that never returned control, or a Worker that died.
 */
async function runPlan(plan, onEvent, signal = null, control = null) {
  preparePlanPermissions(plan);
  plan = clone(plan);
  plan.start_paused = control?.paused === true;
  const host = planHost(plan, onEvent, control, signal);
  if (signal?.aborted) return Promise.reject(new Error('Run cancelled'));
  // Nothing in the plan has code to run (no Script: value nodes, Reroutes, event nodes, roots with a problem): no Worker is needed.
  if (!plan.roots.length || (!control && !plan.nodes.some(n => n.op === 'script')))
    return executePlan(plan, {
      AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
      displayText,
      call: () => {},
      emit: host.emit,
      limits: plan.limits,
    });
  return new Promise((resolve, reject) => {
    const worker = spawnWorker(),
      started = new Map(); // node id -> when its code began (only nodes that are running now)
    let over = false,
      watchdog;
    const finish = (action, value) => {
      if (over) return;
      over = true;
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      action(value);
    };
    const onAbort = () => finish(reject, new Error('Run cancelled'));
    signal?.addEventListener('abort', onAbort, {once: true});
    // The Worker watches its nodes itself, but not while a script keeps it busy: then this side ends the run.
    const watch = () => {
      clearTimeout(watchdog);
      if (!started.size) return;
      const [, {id, at, prefix}] = [...started].reduce((a, b) => (b[1].at < a[1].at ? b : a));
      watchdog = setTimeout(
        () => {
          const node = plan.nodes.find(n => n.id === id);
          finish(reject, new Error(`${prefix || node?.prefix || 'Script'} execution timed out`));
        },
        Math.max(0, at + plan.limits.timeout + (plan.limits.grace ?? WATCHDOG_GRACE) - Date.now())
      );
    };
    worker.onmessage = async ({data}) => {
      if (over) return;
      if (data.type === 'call') {
        let reply;
        try {
          reply = {
            type: 'reply',
            id: data.id,
            result: await host.call(data.node, ...data.args, data.invocation),
          };
        } catch (error) {
          reply = {type: 'reply', id: data.id, error: error.message || String(error), code: error.code};
        }
        if (!over) worker.postMessage(reply);
      } else if (data.type === 'event') {
        const {event} = data;
        // A node that waits in emit() is not running its code: its time starts again when it goes on.
        if (event.ev === 'start' || event.ev === 'resume')
          started.set(event.invocation ?? event.id, {id: event.id, at: Date.now(), prefix: event.prefix});
        else if (['done', 'fail', 'skip', 'pause'].includes(event.ev))
          started.delete(event.invocation ?? event.id);
        if (event.ev !== 'root') watch();
        host.emit(event);
      } else if (data.type === 'finished') finish(resolve, data.result);
      else finish(reject, new Error(data.error || 'The run failed'));
    };
    worker.onerror = event => finish(reject, new Error(event.message || 'The script stopped without an answer'));
    worker.postMessage({type: 'plan', plan});
    host.attach(message => !over && worker.postMessage(message));
  });
}
