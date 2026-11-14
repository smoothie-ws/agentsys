#!/usr/bin/env node
'use strict';
// Copies an AgentSys data folder into a timestamped backup and checks that every JSON file it copied parses.
//
//   node tools/backup.js --data ./data [--out ./backups] [--force] [--json]
//
// A stopped server gives an exact copy. A running server is refused unless --force is given: a copy of a live
// folder is usually consistent because a commit writes a .transaction.json first, and the next server replays it,
// but only a stopped copy is guaranteed to be a single point in time.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const DATA = path.resolve(value('data', 'data'));
const OUT = path.resolve(value('out', 'backups'));
const FORCE = args.includes('--force');
const JSON_OUT = args.includes('--json');

const fail = (message, code = 2) => {
  if (JSON_OUT) console.log(JSON.stringify({ok: false, error: message}));
  else console.error(message);
  process.exit(code);
};

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function copyTree(from, to, files = []) {
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target, files);
      continue;
    }
    // A temporary file is a write that never finished: the data file it belongs to is the truth.
    if (entry.name.includes('.tmp-')) continue;
    fs.copyFileSync(source, target);
    files.push(path.relative(DATA, source).split(path.sep).join('/'));
  }
  return files;
}

function main() {
  if (!fs.existsSync(DATA)) fail(`Data folder not found: ${DATA}`);
  const lockFile = path.join(DATA, '.server.lock');
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {}
  if (holder && pidAlive(Number(holder.pid)) && !FORCE)
    fail(
      `The server is running (pid ${holder.pid}); stop it for an exact copy, or pass --force to copy a live folder.`,
      3
    );

  const destination = path.join(OUT, 'agentsys-' + stamp());
  const files = copyTree(DATA, destination);
  const broken = [];
  let bytes = 0;
  for (const file of files) {
    const absolute = path.join(destination, ...file.split('/'));
    bytes += fs.statSync(absolute).size;
    if (!file.endsWith('.json') || file.endsWith('.invalid')) continue;
    try {
      JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch (error) {
      broken.push({file, error: error.message});
    }
  }
  const manifest = {
    at: new Date().toISOString(),
    source: DATA,
    destination,
    files: files.length,
    bytes,
    live: !!(holder && pidAlive(Number(holder.pid))),
    unreadable: broken,
    note: 'Restore by copying this folder to a server --data folder while no server uses it. A .transaction.json inside is replayed on start.',
  };
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (JSON_OUT) console.log(JSON.stringify({ok: broken.length === 0, ...manifest}, null, 2));
  else {
    console.log(`Backup: ${destination}`);
    console.log(`  ${files.length} files, ${(bytes / 1024).toFixed(1)} KiB`);
    if (manifest.live) console.log('  taken from a running server (--force): consistent unless a commit was in flight');
    if (broken.length) {
      console.error(`  ${broken.length} JSON file(s) do not parse:`);
      for (const item of broken) console.error(`    ${item.file}: ${item.error}`);
    } else console.log('  every JSON file parses');
  }
  if (broken.length) process.exitCode = 1;
}

main();
