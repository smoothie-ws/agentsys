'use strict';
// Canonical graph files, sidecars, recoverable commits and external-change fingerprints.
const fs = require('node:fs');
const path = require('node:path');
const TextGraph = require('../js/storage/format');

// ----- storage layout: a key of the application <-> a file below data/ -----
//   prefs -> settings.json        projects -> projects.json        meta -> meta.json
//   resources -> library/resources.json        node_folders -> library/node_folders.json
//   library_types -> library/types.json
//   wf:<id> -> workflows/<id>.json             wf:lib-<id> -> library/editors/<id>.json
//   anything else -> other/<key>.json
const FIXED = {
  prefs: 'settings.json',
  projects: 'projects.json',
  meta: 'meta.json',
  resources: 'library/resources.json',
  node_folders: 'library/node_folders.json',
  library_types: 'library/types.json',
};
/** The sidecar script files a stored graph refers to (`{$script: 'scripts/x.js'}` values anywhere inside it). */
const SCRIPT_PATH = /^scripts\/[A-Za-z0-9_-]+\.js$/;
const scriptRefs = (value, out = []) => {
  if (value && typeof value === 'object') {
    if (typeof value.$script === 'string') out.push(value.$script);
    for (const child of Object.values(value)) scriptRefs(child, out);
  }
  return out;
};
const VALID_KEY = /^(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9:._/-]{1,500}$/;
const storagePath = key => key.split('/').map(encodeURIComponent).join('/');
const fileOf = key => {
  if (key.includes('/')) return storagePath(key) + '.json';
  if (Object.hasOwn(FIXED, key)) return FIXED[key];
  let m = /^wf:lib-(.+)$/.exec(key);
  if (m) return `library/editors/${m[1]}.json`;
  m = /^wf:(.+)$/.exec(key);
  if (m) return `workflows/${m[1]}.json`;
  return `other/${key.replace(/:/g, '__')}.json`;
};
const keyOf = file => {
  let rel;
  try { rel = file.split(path.sep).map(decodeURIComponent).join('/'); }
  catch { return null; } // An unrelated malformed filename cannot stop startup or every watcher scan.
  const sidecar = /^(.*)\.files\/(?:layout\.json|scripts\/[A-Za-z0-9_-]+\.js)$/.exec(rel);
  if (sidecar) return keyOf(sidecar[1] + '.json');
  if ((/^(secrets|plugins)\//.test(rel) && rel.endsWith('.json')) || /^workflows\/[^/]+\/.+\.json$/.test(rel))
    return rel.slice(0, -5);
  for (const [key, f] of Object.entries(FIXED)) if (f === rel) return key;
  let m = /^library\/editors\/(.+)\.json$/.exec(rel);
  if (m) return `wf:lib-${m[1]}`;
  m = /^workflows\/(.+)\.json$/.exec(rel);
  if (m) return `wf:${m[1]}`;
  m = /^other\/(.+)\.json$/.exec(rel);
  return m ? m[1].replace(/__/g, ':') : null;
};

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (
      (e.name.endsWith('.json') ||
        (p.includes('.files' + path.sep + 'scripts' + path.sep) && e.name.endsWith('.js'))) &&
      !e.name.includes('.tmp-')
    )
      out.push(p);
  }
  return out;
}
// Polling must yield to HTTP edits even when the retained history has many files.
async function walkAsync(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, {withFileTypes: true});
  } catch {
    return [];
  }
  const children = await Promise.all(
    entries.map(async entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkAsync(file);
      return !entry.name.includes('.tmp-') &&
        (entry.name.endsWith('.json') ||
          (file.includes('.files' + path.sep + 'scripts' + path.sep) && entry.name.endsWith('.js')))
        ? [file]
        : [];
    })
  );
  return children.flat();
}
const stampOf = file => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null; // removed meanwhile
  }
};

function createFileStore(DATA) {
  const abs = key => path.join(DATA, ...fileOf(key).split('/'));
  const stamps = entries => {
    const grouped = new Map();
    for (const [file, stamp] of entries) {
      const relative = path.relative(DATA, file),
        key = keyOf(relative);
      if (!key || !stamp) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(relative + ':' + stamp + ';');
    }
    return new Map([...grouped].map(([key, values]) => [key, values.sort().join('')]));
  };
  const snapshot = () => {
    return stamps(walk(DATA).map(file => [file, stampOf(file)]));
  };
  const snapshotAsync = async () => {
    const files = await walkAsync(DATA),
      entries = [];
    for (let i = 0; i < files.length; i += 128) {
      entries.push(
        ...(await Promise.all(
          files.slice(i, i + 128).map(async file => {
            try {
              const stat = await fs.promises.stat(file);
              return [file, `${stat.mtimeMs}:${stat.size}`];
            } catch {
              return [file, null];
            }
          })
        ))
      );
    }
    return stamps(entries);
  };
  let storageRevision = 0;
  const changedAt = new Map();
  let known = snapshot();
  const recordCommit = ({set = {}, remove = []}) => {
    const revision = ++storageRevision;
    for (const key of Object.keys(set)) {
      const file = abs(key),
        sidecar = key === 'resources' || key.startsWith('wf:'),
        files = [file, ...(sidecar ? walk(file.replace(/\.json$/, '.files')) : [])];
      const stamp = stamps(files.map(p => [p, stampOf(p)])).get(key);
      if (stamp) known.set(key, stamp);
      else known.delete(key);
      changedAt.set(key, revision);
    }
    for (const key of remove) {
      known.delete(key);
      changedAt.set(key, revision);
    }
  };
  function readKey(key) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(abs(key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (key === 'resources' || key.startsWith('wf:')) {
      if (value.format !== TextGraph.FORMAT) throw new Error('Expected canonical graph files: ' + key);
      const folder = abs(key).replace(/\.json$/, '.files');
      const files = {
        'graph.json': JSON.stringify(value),
        'layout.json': fs.readFileSync(path.join(folder, 'layout.json'), 'utf8'),
      };
      const scripts = new Set(scriptRefs(value.value));
      for (const name of scripts) {
        if (!SCRIPT_PATH.test(name)) throw new Error('Invalid script path');
        files[name] = fs.readFileSync(path.join(folder, ...name.split('/')), 'utf8');
      }
      value = TextGraph.decode({format: TextGraph.FORMAT, files});
    }
    return value;
  }
  const madeDirs = new Set(); // directories this process created or found: no mkdir per file written
  function atomicText(file, text, mode) {
    try {
      const bytes = Buffer.byteLength(text);
      const stat = fs.statSync(file);
      // A size difference already proves a content difference; only an equal size needs the read to compare.
      if (stat.size !== bytes) throw Object.assign(new Error('different'), {code: 'ENOENT'});
      if (fs.readFileSync(file, 'utf8') === text) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const dir = path.dirname(file);
    if (!madeDirs.has(dir)) {
      fs.mkdirSync(dir, {recursive: true});
      madeDirs.add(dir);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, mode ? {mode} : undefined);
    // On Windows another program (antivirus, indexer, sync, editor) may hold the target for a moment, and rename then fails with
    // EPERM/EBUSY/EACCES. Retry briefly; if the target stays locked, fail without replacing it with a partial write.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        // A rename keeps the temporary file's mode; a pre-existing file may have another one, so set it here too.
        if (mode && process.platform !== 'win32') {
          try {
            fs.chmodSync(file, mode);
          } catch {}
        }
        return;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
          fs.rmSync(tmp, {force: true});
          throw error;
        }
        if (attempt < 5) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
          continue;
        }
        fs.rmSync(tmp, {force: true});
        throw error;
      }
    }
  }

  const scriptRefsCache = new Map(); // key -> {stamp, names}: avoid reading a large unchanged graph on every save
  function writeKey(key, value) {
    const file = abs(key);
    if (key === 'resources' || key.startsWith('wf:')) {
      const packet = TextGraph.encode(value),
        folder = file.replace(/\.json$/, '.files');
      let previous = [];
      try {
        const stamp = stampOf(file),
          cached = scriptRefsCache.get(key);
        if (cached && stamp && cached.stamp === stamp) previous = cached.names;
        else {
          previous = scriptRefs(JSON.parse(fs.readFileSync(file, 'utf8')).value);
          if (stamp) scriptRefsCache.set(key, {stamp, names: previous});
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const next = [];
      for (const [name, text] of Object.entries(packet.files))
        if (name !== 'graph.json') atomicText(path.join(folder, ...name.split('/')), text);
      atomicText(file, packet.files['graph.json']);
      for (const name of previous)
        if (!Object.hasOwn(packet.files, name) && SCRIPT_PATH.test(name)) {
          try {
            fs.unlinkSync(path.join(folder, ...name.split('/')));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      for (const name of Object.keys(packet.files)) if (name !== 'graph.json') next.push(name);
      scriptRefsCache.set(key, {stamp: stampOf(file), names: next});
      return;
    }
    atomicText(file, JSON.stringify(value, null, 2) + '\n', key.startsWith('secrets/') ? 0o600 : undefined);
  }
  function removeKey(key) {
    madeDirs.clear();
    scriptRefsCache.delete(key);
    const file = abs(key),
      folder = file.replace(/\.json$/, '.files');
    if (!path.resolve(folder).startsWith(path.resolve(DATA) + path.sep)) throw new Error('Unsafe storage path');
    if (key === 'resources' || key.startsWith('wf:')) {
      try {
        const files = [
          'layout.json',
          ...scriptRefs(JSON.parse(fs.readFileSync(file, 'utf8')).value).filter(n => SCRIPT_PATH.test(n)),
        ];
        for (const name of files) {
          try {
            fs.unlinkSync(path.join(folder, ...name.split('/')));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        for (const dir of [path.join(folder, 'scripts'), folder])
          try {
            fs.rmdirSync(dir);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
          }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  // A redo record makes a multi-key commit recoverable before the backend can read it.
  const transactionFile = path.join(DATA, '.transaction.json');
  function validateTransaction(packet) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Invalid storage transaction');
    const {set = {}, remove = []} = packet;
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(remove))
      throw new Error('Invalid storage transaction');
    if (![...Object.keys(set), ...remove].every(key => typeof key === 'string' && VALID_KEY.test(key)))
      throw new Error('Invalid storage key');
    return {set, remove};
  }
  function applyTransaction({set = {}, remove = []}) {
    for (const k of Object.keys(set)) writeKey(k, set[k]);
    for (const k of remove) removeKey(k);
    fs.unlinkSync(transactionFile);
  }
  /** Finishes a commit that was interrupted, once, without writing the record again. */
  function replayTransaction() {
    if (!fs.existsSync(transactionFile)) return;
    let packet;
    try {
      packet = validateTransaction(JSON.parse(fs.readFileSync(transactionFile, 'utf8')));
    } catch (error) {
      // A record that cannot be read is not a source of truth: the data files are. Keep it for
      // inspection and start normally instead of refusing to boot.
      try {
        fs.renameSync(transactionFile, transactionFile + '.invalid');
      } catch {}
      console.warn('[agentsys] ignored an unreadable .transaction.json: ' + error.message);
      return;
    }
    try {
      applyTransaction(packet);
    } catch (error) {
      // A key the folder cannot accept (for example a directory where a file belongs) must not stop every later
      // start: keep the record for inspection and boot on the data files that did reach the disk.
      try {
        fs.renameSync(transactionFile, transactionFile + '.invalid');
      } catch {}
      console.warn('[agentsys] a redo record could not be applied: ' + error.message);
    }
  }
  function commitKeys(packet) {
    const {set, remove} = validateTransaction(packet);
    replayTransaction();
    atomicText(transactionFile, JSON.stringify({set, remove}), 0o600);
    const transactionFd = fs.openSync(transactionFile, 'r+');
    try {
      fs.fsyncSync(transactionFd);
    } finally {
      fs.closeSync(transactionFd);
    }
    applyTransaction({set, remove});
  }
  replayTransaction();
  known = snapshot();
  async function scan() {
    const revision = storageRevision;
    const now = await snapshotAsync();
    const changed = [];
    for (const key of new Set([...known.keys(), ...now.keys()])) {
      if ((changedAt.get(key) ?? 0) > revision) continue;
      if (known.get(key) !== now.get(key)) changed.push(key);
      if (now.has(key)) known.set(key, now.get(key));
      else known.delete(key);
    }
    for (const [key, committed] of changedAt) if (committed <= revision) changedAt.delete(key);
    return changed;
  }
  return {
    dir: DATA,
    get: readKey,
    commit(packet) { commitKeys(packet); recordCommit(packet); },
    keys: () => [...snapshot().keys()],
    scan,
  };
}
module.exports = {createFileStore, VALID_KEY};
