#!/usr/bin/env node
'use strict';
// Additional architecture indicators. Uses Node's bundled parser only in this development tool:
// node --expose-internals tools/architecture-metrics.js [--ref REV]
// Application code has no parser dependency. Token clones are exact, not semantic duplication claims.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const ref = args[args.indexOf('--ref') + 1];
const revision = args.includes('--ref') ? ref : null;
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
const read = file => (revision ? git(['show', `${revision}:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const inventory = JSON.parse(execFileSync(process.execPath, ['tools/source-metrics.js', ...args], {cwd: root, encoding: 'utf8'}));
const html = read('index.html');
const browser = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
const forbidden = file => /^(js\/backend\/|js\/storage\/db\.js$|js\/model\/(executor|editor|snapshot|evaluate|schema|documents)\.js$)/.test(file);
const source = new Map(inventory.inventory.filter(row => row.file.endsWith('.js')).map(row => [row.file, read(row.file)]));
const blocks = new Map();
const modules = [];
let routeDeclarations = 0;
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};
for (const [file, text] of source) {
  const tokens = [];
  const tree = acorn.parse(text, {ecmaVersion: 'latest', onToken: tokens});
  const functions = [];
  let branches = 0;
  walk(tree, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'route') routeDeclarations++;
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type))
      functions.push({name: node.id?.name || '(anonymous)', lines: text.slice(node.start, node.end).split('\n').length});
    if (/^(IfStatement|ConditionalExpression|SwitchCase|CatchClause|ForStatement|ForOfStatement|ForInStatement|WhileStatement|DoWhileStatement|LogicalExpression)$/.test(node.type)) branches++;
  });
  // At least 40 exact tokens, covering >= 5 physical lines and >= 160 characters. Include literal values.
  for (let i = 0; i + 40 <= tokens.length; i++) {
    const first = tokens[i], last = tokens[i + 39];
    const slice = text.slice(first.start, last.end);
    if (slice.length < 160 || slice.split('\n').length < 5) continue;
    const key = tokens.slice(i, i + 40).map(token => text.slice(token.start, token.end)).join('\0');
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push({file, start: first.start, end: last.end});
  }
  modules.push({file, functions: functions.length, branch_points: branches,
    largest_function_lines: Math.max(0, ...functions.map(fn => fn.lines)),
    top_level_bindings: tree.body.flatMap(node => node.declarations || node.id || []).length});
}
const duplicateRanges = new Map();
for (const matches of blocks.values()) {
  if (matches.length < 2) continue;
  for (const match of matches) {
    if (!duplicateRanges.has(match.file)) duplicateRanges.set(match.file, []);
    duplicateRanges.get(match.file).push(match);
  }
}
let duplicateBytes = 0;
for (const [file, ranges] of duplicateRanges) {
  let end = -1;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const start = Math.max(range.start, end);
    if (range.end > start) duplicateBytes += Buffer.byteLength(source.get(file).slice(start, range.end));
    end = Math.max(end, range.end);
  }
}
const requireEdges = inventory.inventory.flatMap(row => row.imports.map(request => ({
  from: row.file, to: path.posix.normalize(path.posix.join(path.posix.dirname(row.file), request)) + (request.endsWith('.js') ? '' : '.js'),
})));
const states = new Map(), cycles = [];
function visit(file, trail = []) {
  if (states.get(file) === 'open') { cycles.push([...trail, file]); return; }
  if (states.has(file)) return;
  states.set(file, 'open');
  requireEdges.filter(edge => edge.from === file).forEach(edge => visit(edge.to, [...trail, file]));
  states.set(file, 'done');
}
requireEdges.forEach(edge => visit(edge.from));
process.stdout.write(JSON.stringify({
  revision: revision || 'working-tree', parser: acorn.version,
  definitions: {
    duplicate_bytes: 'Union of source ranges in repeated exact 40-token windows (>=5 lines, >=160 chars), including both copies',
    branches: 'AST conditional, loop, catch, switch case and logical expression nodes; not cyclomatic complexity',
    dependency_scope: 'CommonJS requires and ordered browser manifest; global call cycles are not inferred',
  },
  browser: {scripts: browser.length, bytes: browser.reduce((sum, file) => sum + Buffer.byteLength(read(file).replace(/\r\n/g, '\n')), 0),
    forbidden_implementation_files: browser.filter(forbidden)},
  duplicate_bytes: duplicateBytes,
  public_interfaces: {route_declaration_sites: routeDeclarations,
    plugin_sdk_sha256: createHash('sha256').update(read('sdk/agentsys-plugin.d.ts')).digest('hex')},
  functions: modules.reduce((sum, row) => sum + row.functions, 0),
  branch_points: modules.reduce((sum, row) => sum + row.branch_points, 0),
  commonjs_edges: requireEdges, commonjs_cycles: cycles,
  modules,
}, null, 2) + '\n');
