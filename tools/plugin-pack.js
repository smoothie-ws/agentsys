#!/usr/bin/env node
// Builds and checks AgentSys plugin packages without a bundler or a network.
//
//   node tools/plugin-pack.js <plugin-directory> [--out <file>]
//   node tools/plugin-pack.js --validate <package.json>
//   node tools/plugin-pack.js --check <plugin-directory>
//   node tools/plugin-pack.js --all <directory-of-plugin-directories>
//
// A source directory has a plugin.json with the manifest fields, main.js or the main named there, optional modules
// and a contributes object. The output is one .agentsys-plugin.json file that the Plugins page installs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Manifest = require('../js/app/plugin-manifest');

const MAX_TOTAL = 900000;
const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const text = (file, limit = 400000) => {
  const value = fs.readFileSync(file, 'utf8');
  if (value.length > limit) throw new Error(`${file} is larger than ${limit} characters`);
  return value;
};
const walk = (directory, base = '') => {
  const out = [];
  for (const entry of fs.readdirSync(path.join(directory, base), {withFileTypes: true})) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.name === 'plugin.json') continue;
    if (entry.name.endsWith('.agentsys-plugin.json')) continue;
    if (entry.isDirectory()) out.push(...walk(directory, relative));
    else out.push(relative);
  }
  return out;
};

function readSource(directory) {
  const manifestFile = path.join(directory, 'plugin.json');
  if (!fs.existsSync(manifestFile)) throw new Error('plugin.json is missing in ' + directory);
  const meta = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const main = meta.main || 'main.js';
  const files = {};
  let total = 0;
  for (const relative of walk(directory).sort()) {
    if (relative.startsWith('assets/')) continue;
    if (!/\.(?:js|json)$/i.test(relative)) continue;
    const value = text(path.join(directory, relative));
    total += value.length;
    if (total > MAX_TOTAL) throw new Error('The package is larger than 900 KB');
    files[relative] = value;
  }
  if (!Object.prototype.hasOwnProperty.call(files, main))
    throw new Error(`main file "${main}" is not in the package`);
  const assets = {};
  const assetDir = path.join(directory, 'assets');
  if (fs.existsSync(assetDir))
    for (const relative of walk(directory).filter(file => file.startsWith('assets/')).sort()) {
      const ext = path.extname(relative).toLowerCase();
      if (!ASSET_TYPES[ext]) continue;
      const buffer = fs.readFileSync(path.join(directory, relative));
      if (buffer.length > 200000) throw new Error(`${relative} is larger than 200 KB`);
      const name = relative.slice('assets/'.length).replace(/\.[^.]+$/, '');
      assets[name] = `data:${ASSET_TYPES[ext]};base64,${buffer.toString('base64')}`;
    }
  const manifest = {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    description: meta.description || '',
    icon: meta.icon || 'plug',
    api: meta.api || Manifest.API_VERSION,
    engines: meta.engines || {agentsys: '>=0.3.0'},
    capabilities: meta.capabilities || [],
    dependencies: meta.dependencies || {},
    author: meta.author || '',
    license: meta.license || '',
    homepage: meta.homepage || '',
  };
  return {
    format: 2,
    manifest,
    main,
    files,
    assets,
    contributes: meta.contributes || {collections: [], library: [], workflows: []},
  };
}

function build(directory, out) {
  const source = readSource(directory);
  // The same validation the client runs, including file paths, engines and contributions.
  const record = Manifest.normalizePackage(source);
  const packet = Manifest.exportPackage(record);
  packet.checksum = Manifest.fingerprint(record);
  const target = out || path.join(directory, `${record.id}-${record.version}.agentsys-plugin.json`);
  fs.writeFileSync(target, JSON.stringify(packet, null, 2) + '\n');
  const summary = [
    `built ${record.id} ${record.version}`,
    `${Object.keys(packet.files).length} file(s)`,
    `${Object.keys(packet.assets || {}).length} asset(s)`,
    `${(packet.contributes?.library || []).length} Library node(s)`,
    `${(packet.contributes?.collections || []).length} collection(s)`,
    `${(packet.contributes?.workflows || []).length} workflow template(s)`,
    `capabilities: ${(record.capabilities || []).join(', ') || 'read-only'}`,
    `checksum: ${packet.checksum}`,
    `-> ${target}`,
  ];
  console.log(summary.join('\n'));
  return {record, packet, target};
}

function validate(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = Manifest.normalizePackage(value);
  const packet = Manifest.exportPackage(record);
  const missing = (record.files ? Object.keys(record.files) : []).filter(name => !(name in packet.files));
  if (missing.length) throw new Error('modules missing from the package: ' + missing.join(', '));
  console.log(
    [
      `valid ${record.id} ${record.version} (API ${record.api}, format ${record.formatVersion})`,
      `capabilities: ${(record.capabilities || []).join(', ') || 'read-only'}`,
      `checksum: ${packet.checksum}`,
      packet.checksum === value.checksum ? 'checksum matches' : 'checksum is missing or differs (a local edit)',
    ].join('\n')
  );
  return record;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage:\n  node tools/plugin-pack.js <plugin-directory> [--out file]\n  node tools/plugin-pack.js --validate <package.json>\n  node tools/plugin-pack.js --check <plugin-directory>\n  node tools/plugin-pack.js --all <directory>'
    );
    return 0;
  }
  try {
    if (args[0] === '--validate') {
      if (!args[1]) throw new Error('--validate needs a package file');
      validate(args[1]);
      return 0;
    }
    if (args[0] === '--check') {
      if (!args[1]) throw new Error('--check needs a plugin directory');
      const source = readSource(args[1]);
      const record = Manifest.normalizePackage(source);
      console.log(`valid source ${record.id} ${record.version} (${Object.keys(record.files).length} module(s))`);
      return 0;
    }
    if (args[0] === '--all') {
      const root = args[1] || 'client-plugins/reference';
      const directories = fs
        .readdirSync(root, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'plugin.json')))
        .map(entry => path.join(root, entry.name));
      if (!directories.length) throw new Error('No plugin directories in ' + root);
      for (const directory of directories) build(directory);
      return 0;
    }
    const outAt = args.indexOf('--out');
    build(args[0], outAt >= 0 ? args[outAt + 1] : undefined);
    return 0;
  } catch (error) {
    console.error('plugin package error: ' + (error.message || error));
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = {readSource, build, validate};
