// Storage for the whole application: a key-value store with an in-memory cache. With the AgentSys server
// (node server.js) keys use JSON files and skills use SKILL.md documents; without it data stays in IndexedDB.
// Also defines the small helpers every layer uses: ApiError, bad(), missing(), uid(), clone(), isObject(), finite().
'use strict';

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || (code === 'not_found' ? 404 : code === 'invalid_request' ? 400 : 409);
  }
}
const bad = message => new ApiError('invalid_request', message, 400);
const missing = message => new ApiError('not_found', message, 404);

const uid = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
};
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

const DB = (() => {
  const STORE = 'kv',
    API = '/__data',
    cache = new Map(),
    listeners = new Set(),
    announced = new Set(), // the listeners that also hear about writes made here by hooks
    client = uid(),
    // The headless server (headless.js) hands in its own file store; browsers never define it.
    external = typeof AGENTSYS_STORE !== 'undefined' ? AGENTSYS_STORE : null;
  let idb = null,
    channel = null,
    files = null; // {dir, keys} while the AgentSys server keeps the data as JSON files
  const notify = keys => {
    for (const key of keys) cache.delete(key);
    for (const listener of listeners) listener(keys);
  };
  const openIdb = () =>
    new Promise(resolve => {
      try {
        const request = indexedDB.open('agentsys', 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  const transaction = (mode, work) =>
    new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, mode),
        request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('The browser database failed.'));
    });
  const probe = async () => {
    if (typeof fetch !== 'function' || typeof location === 'undefined' || !/^https?:$/.test(location.protocol))
      return null;
    try {
      const response = await fetch(API, {cache: 'no-store'}),
        info = response.ok ? await response.json() : null;
      return info?.agentsys ? info : null;
    } catch {
      return null;
    }
  };
  const post = async body => {
    const response = await fetch(API, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-AgentSys': '1', 'X-Client': client},
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('The data folder could not be written.');
  };
  const ready = (async () => {
    if (external) return;
    idb = await openIdb();
    files = await probe();
    if (!files) {
      // No server: everything stays in this browser, shared between its tabs.
      if ('BroadcastChannel' in self) {
        channel = new BroadcastChannel('agentsys');
        channel.onmessage = event => notify(event.data.keys);
      }
      return;
    }
    const events = new EventSource(API + '/events');
    events.onmessage = event => {
      const {keys, by} = JSON.parse(event.data);
      if (by !== client) notify(keys);
    };
  })();
  return {
    get persistent() {
      return !!(files || idb || external);
    },
    /** 'files' (JSON files in the data folder), 'browser' (IndexedDB) or 'memory'. */
    get mode() {
      return files || external ? 'files' : idb ? 'browser' : 'memory';
    },
    get directory() {
      return files?.dir || external?.dir || '';
    },
    async get(key) {
      await ready;
      if (cache.has(key)) return cache.get(key);
      let value;
      if (external) value = await external.get(key);
      else if (files) {
        const response = await fetch(`${API}/${encodeURIComponent(key)}`, {cache: 'no-store'});
        if (response.status === 200) value = await response.json();
        else if (response.status !== 204) throw new Error('The data folder could not be read.');
      } else if (idb) value = await transaction('readonly', store => store.get(key));
      cache.set(key, value);
      return value;
    },
    /** Writes several keys at once; an undefined value deletes the key. */
    async commit(changes) {
      await ready;
      const keys = Object.keys(changes);
      if (!keys.length) return;
      if (external)
        await external.commit({
          set: Object.fromEntries(keys.filter(k => changes[k] !== undefined).map(k => [k, changes[k]])),
          remove: keys.filter(k => changes[k] === undefined),
        });
      else if (files)
        await post({
          set: Object.fromEntries(keys.filter(k => changes[k] !== undefined).map(k => [k, changes[k]])),
          remove: keys.filter(k => changes[k] === undefined),
        });
      else if (idb)
        await transaction('readwrite', store => {
          for (const key of keys) changes[key] === undefined ? store.delete(key) : store.put(changes[key], key);
        });
      for (const key of keys) cache.set(key, changes[key]);
      if (!files) channel?.postMessage({keys});
    },
    /** Tells this store that keys were changed from outside (another process wrote the files): cached copies are dropped. */
    changed: notify,
    /** Tells the listeners that asked for it (`own`) that keys were written here by code that runs by itself (a hook). */
    announce: keys => {
      for (const listener of announced) listener(keys);
    },
    /** Called with the changed keys when another tab writes or a file is edited on disk. */
    subscribe(listener, {own = false} = {}) {
      listeners.add(listener);
      if (own) announced.add(listener);
      return () => {
        listeners.delete(listener);
        announced.delete(listener);
      };
    },
  };
})();

/** One request's view of the data: values are copied on first read and written back only if they changed. */
class Context {
  constructor() {
    this.loaded = new Map();
  }
  async get(key, fallback) {
    let entry = this.loaded.get(key);
    if (!entry) {
      const raw = await DB.get(key),
        json = raw === undefined ? undefined : JSON.stringify(raw);
      const value = json === undefined ? clone(fallback) : JSON.parse(json);
      // `base` is what the key holds as far as this request knows: a key that is not stored, read with a default, stays
      // not stored unless the request changes it.
      entry = {value, json, base: json ?? JSON.stringify(value)};
      this.loaded.set(key, entry);
    }
    return entry.deleted ? clone(fallback) : entry.value; // a removed key stays removed until `set`
  }
  set(key, value) {
    const entry = this.loaded.get(key);
    this.loaded.set(key, {value, json: entry?.json, base: entry?.base, deleted: false});
  }
  async remove(key) {
    if (!this.loaded.has(key)) await this.get(key);
    const entry = this.loaded.get(key);
    entry.deleted = true;
    entry.value = undefined;
  }
  /** Keys whose content differs from what was stored. */
  changes() {
    const changes = {};
    for (const [key, entry] of this.loaded) {
      if (entry.deleted) {
        if (entry.json !== undefined) changes[key] = undefined;
        continue;
      }
      if (JSON.stringify(entry.value) !== entry.base) changes[key] = entry.value;
    }
    return changes;
  }
  commit() {
    return versionedCommit(this.changes());
  }
}
