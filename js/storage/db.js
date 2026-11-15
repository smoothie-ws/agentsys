// Server-only cached key-value adapter. A file store is injected by headless.js; tests use memory.
'use strict';

const DB = (() => {
  const cache = new Map(), listeners = new Set(), committed = new Set(), announced = new Set();
  const external = typeof AGENTSYS_STORE !== 'undefined' ? AGENTSYS_STORE : null;
  return {
    get persistent() { return !!external; },
    get mode() { return external ? 'files' : 'memory'; },
    get directory() { return external?.dir || ''; },
    async get(key, {fresh = false} = {}) {
      if (fresh && external) cache.delete(key);
      if (!cache.has(key)) cache.set(key, external ? await external.get(key) : undefined);
      return cache.get(key);
    },
    async commit(changes) {
      const keys = Object.keys(changes);
      if (!keys.length) return;
      if (external) await external.commit({
        set: Object.fromEntries(keys.filter(k => changes[k] !== undefined).map(k => [k, changes[k]])),
        remove: keys.filter(k => changes[k] === undefined),
      });
      for (const key of keys) changes[key] === undefined ? cache.delete(key) : cache.set(key, changes[key]);
      for (const listener of committed) listener(keys);
    },
    changed(keys) {
      for (const key of keys) cache.delete(key);
      for (const listener of listeners) listener(keys);
    },
    announce(keys) { for (const listener of announced) listener(keys); },
    subscribe(listener, {own = false, commits = false} = {}) {
      listeners.add(listener);
      if (own) announced.add(listener);
      if (commits) committed.add(listener);
      return () => { listeners.delete(listener); announced.delete(listener); committed.delete(listener); };
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
    return DB.commit(this.changes());
  }
}
