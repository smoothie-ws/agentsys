#!/usr/bin/env node
'use strict';
// Reproducible source inventory, excluding dependencies, tests, tooling, user data and generated catalogs.
// node tools/source-metrics.js [--ref HEAD] > metrics.json
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const at = process.argv.indexOf('--ref');
const ref = at < 0 ? null : process.argv[at + 1];
if (at >= 0 && !ref) throw new Error('--ref needs a git revision');
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
const list = directory => fs.readdirSync(path.join(root, directory), {withFileTypes: true}).flatMap(entry => {
  const file = directory + '/' + entry.name;
  return entry.isDirectory() ? list(file) : [file];
});
const names = ref ? git(['ls-tree', '-r', '--name-only', ref]).trim().split('\n') : [
  ...['js', 'shared', 'server', 'bin', 'css', 'legacy'].flatMap(list), 'server.js', 'headless.js', 'index.html',
];
const source = file => /^(?:(?:js|shared|server|bin|css|legacy)\/.*\.(?:js|css)|server\.js|headless\.js|index\.html)$/.test(file);
const generated = file => file === 'js/backend/builtin-nodes.js';
const rows = names.filter(source).map(file => {
  const text = ref ? git(['show', `${ref}:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n').length - Number(text.endsWith('\n'));
  const imports = [...text.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map(match => match[1]);
  return {file, lines, imports};
});
const active = rows.filter(row => !generated(row.file) && !row.file.startsWith('legacy/'));
const sum = rows => rows.reduce((total, row) => total + row.lines, 0);
process.stdout.write(JSON.stringify({
  revision: ref || 'working-tree',
  scope: 'js/shared/server/bin/css plus root server.js/headless.js/index.html; generated builtins and retired legacy separate',
  source_lines: sum(active),
  modules: active.length,
  local_require_edges: active.reduce((count, row) => count + row.imports.length, 0),
  retired_source_lines: sum(rows.filter(row => row.file.startsWith('legacy/'))),
  generated_source_lines: sum(rows.filter(row => generated(row.file))),
  largest: [...active].sort((a, b) => b.lines - a.lines).slice(0, 12),
  inventory: active.sort((a, b) => a.file.localeCompare(b.file)),
}, null, 2) + '\n');
