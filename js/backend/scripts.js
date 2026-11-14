// One isolated JavaScript host belongs to each live workflow.
'use strict';
function displayText(values) {
  return values.map(displayPart).join('\u001e');
}
function displayPart(value) {
  if (
    value &&
    typeof value === 'object' &&
    /^image\/(png|jpeg|gif|webp)$/.test(value.mime_type) &&
    typeof value.data === 'string'
  ) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw Error('Image data must be base64');
    return 'data:' + value.mime_type + ';base64,' + value.data;
  }
  return String(typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? value)).replaceAll(
    '\u001e',
    ' '
  );
}
const WORKER_FREEZE = `// Freeze the intrinsics the executor shares with node code: replacing Map.get, Promise
// or JSON must not let a Script impersonate a different invocation at the host bridge.
for (const name of ['Object','Array','Map','Set','WeakMap','WeakSet','Proxy','Reflect','Promise','Date','RegExp','String','Number','Boolean','Function','Error','TypeError','Uint8Array','ArrayBuffer','JSON','Math']) {
  const value=globalThis[name]; if(value?.prototype)Object.freeze(value.prototype);Object.freeze(value);
  if(!['Date','Math'].includes(name))Object.defineProperty(globalThis,name,{value,writable:false,configurable:false});
}
`;
const WORKER_BLOCKED = [
  'fetch',
  'importScripts',
  'Worker',
  'SharedWorker',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'RTCPeerConnection',
  'XMLHttpRequest',
  'EventSource',
  'navigator',
  'indexedDB',
  'caches',
  'Cache',
  'BroadcastChannel',
  'MessageChannel',
  'postMessage',
  'close',
  'process',
  'require',
  'onmessage',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'MessageEvent',
  'crypto',
  'performance',
  'Date',
  'Math',
];
const workerBlock = names => `const blocked = ${JSON.stringify(names)};
for (let object=globalThis; object && object!==Object.prototype; object=Object.getPrototypeOf(object)) {
  for(const name of blocked){
    const descriptor=Object.getOwnPropertyDescriptor(object,name);
    if(object===globalThis||descriptor?.configurable)Object.defineProperty(object,name,{value:undefined,writable:false,configurable:false});
    else if(descriptor&&descriptor.value!==undefined)throw new Error('Cannot isolate Worker API: '+name);
  }
}
`;

const GRAPH_WORKER_SOURCE = `
(() => {
const send=globalThis.postMessage.bind(globalThis),Date=globalThis.Date,Math=globalThis.Math;
${WORKER_FREEZE}
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
${displayPart}
${displayText}
${resolvePort}
${createGraphView}
${createGraphInterpreter}
const pending=new Map(),gate={paused:false,waiters:[]};let serial=0,runtime;
const call=(node,...args)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});send({type:'call',id,node,args});});
const receive=async({data})=>{
  if(data.type==='reply'){
    const item=pending.get(data.id);if(!item)return;pending.delete(data.id);
    return data.error?item.reject(Object.assign(new Error(data.error),{code:data.code})):item.resolve(data.result);
  }
  try{let result=null;
    if(data.type==='init'){
      gate.paused=data.paused===true;
      runtime=createGraphInterpreter(data.graph,data.saved,{AsyncFunction,displayText,call,gate,context:data.context,emit:event=>send({type:'event',event})});
    }else if(data.type==='update')runtime.update(data.graph);
    else if(data.type==='pause'){
      runtime?.flush?.();
      gate.paused=data.paused;
      if(!gate.paused)gate.waiters.splice(0).forEach(wake=>wake());
    }else if(data.type==='signal')result=await runtime.signal(data.nodes,data.event);
    runtime?.flush?.();
    send({type:'result',id:data.id,result});
  }catch(error){send({type:'result',id:data.id,error:String(error?.message??error),code:error?.code});}
};
globalThis.addEventListener?.('message',receive);
${workerBlock(WORKER_BLOCKED)}
return text=>receive({data:JSON.parse(text)});
})();`;
const workerURLs = new Map();
function startSourceWorker(source) {
  if (typeof AGENTSYS_SPAWN_WORKER === 'function') return AGENTSYS_SPAWN_WORKER(source);
  if (!workerURLs.has(source))
    workerURLs.set(source, URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
  return new Worker(workerURLs.get(source));
}
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
    if (method !== 'GET') body = quarantineRequest(path, body);
    if (context.signal?.aborted) throw new Error('Execution stopped');
    return stripSecrets(await Backend.request(method, path, {body, query, scriptContext: context}));
  },
});

function scriptCallContext(graph, context, id, signal) {
  const node = createGraphView(graph, {context}).get(id);
  if (!node) throw missing('Script no longer belongs to this graph');
  return {
    ...context,
    node_id: id,
    signal,
    step: {permissions: {chain: node.context?.grant_chain?.length ? node.context.grant_chain : [node.grants ?? []]}},
  };
}
function createScriptHost(graph, saved, options) {
  const {context, onEvent, signal, paused = false, onFailure} = options;
  if (!canStartGraphWorker()) return createInlineGraphHost(graph, saved, options);
  const worker = startSourceWorker(GRAPH_WORKER_SOURCE),
    pending = new Map();
  let current = graph,
    sequence = 0,
    closed = false;
  const request = (type, body = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(Error('Graph work stopped'));
      const id = ++sequence;
      pending.set(id, {resolve, reject});
      worker.ref?.();
      worker.postMessage({type, id, ...body});
    });
  const close = (error = Error('Graph work stopped')) => {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  worker.onerror = event => {
    close(Error(event.message || 'Graph host failed'));
    onFailure?.();
  };
  worker.onmessage = async ({data}) => {
    if (closed) return;
    if (data.type === 'event') {
      onEvent(data.event);
      return;
    }
    if (data.type === 'call') {
      let reply;
      try {
        const result = await liveBridgeFor(scriptCallContext(current, context, data.node, signal)).request(data.args);
        reply = {type: 'reply', id: data.id, result};
      } catch (error) {
        reply = {type: 'reply', id: data.id, error: error.message, code: error.code};
      }
      if (!closed) worker.postMessage(reply);
      return;
    }
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (!pending.size) worker.unref?.();
    data.error ? item.reject(Object.assign(Error(data.error), {code: data.code})) : item.resolve(data.result);
  };
  const ready = request('init', {graph, saved, context, paused});
  return {
    ready,
    close,
    async update(graph) {
      current = graph;
      await ready;
      return request('update', {graph});
    },
    async pause(paused) {
      await ready;
      return request('pause', {paused});
    },
    async signal(nodes, event) {
      await ready;
      return request('signal', {nodes, event});
    },
  };
}
const canStartGraphWorker = () => typeof AGENTSYS_SPAWN_WORKER === 'function' || typeof Worker === 'function';
function createInlineGraphHost(graph, saved, {context, onEvent, signal, paused = false}) {
  const gate = {paused, waiters: []};
  let current = graph,
    closed = false;
  const runtime = createGraphInterpreter(graph, saved, {
    AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
    displayText,
    gate,
    context,
    closed: () => closed,
    emit: event => {
      if (!closed) onEvent(event);
    },
    call: (id, ...args) => liveBridgeFor(scriptCallContext(current, context, id, signal)).request(args),
  });
  return {
    ready: Promise.resolve(),
    update(graph) {
      current = graph;
      runtime.update(graph);
      return Promise.resolve();
    },
    pause(paused) {
      runtime.flush();
      gate.paused = paused;
      if (!paused) gate.waiters.splice(0).forEach(wake => wake());
      return Promise.resolve();
    },
    signal: (nodes, event) => {
      const work = runtime.signal(nodes, event);
      if (!signal) return work;
      return new Promise((resolve, reject) => {
        const abort = () => reject(Error('Graph work stopped'));
        signal.addEventListener('abort', abort, {once: true});
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    },
    close() {
      runtime.flush();
      closed = true;
      gate.paused = false;
      gate.waiters.splice(0).forEach(wake => wake());
    },
  };
}
