#!/usr/bin/env node
'use strict';
// Convenience launcher for a local desktop session: one AgentSys Server and one AgentSys Client, still
// separate processes. Closing the browser leaves the server and its workflows running.
const {spawn} = require('node:child_process');
const path = require('node:path');
const Protocol = require('../shared/protocol');

const serverPort = Number(process.env.AGENTSYS_PORT || Protocol.DEFAULT_PORT);
const clientPort = Number(process.env.AGENTSYS_CLIENT_PORT || Protocol.CLIENT_PORT);
const children = [];
const start = (name, args) => {
  const child = spawn(process.execPath, args, {stdio: 'inherit', cwd: path.resolve(__dirname, '..')});
  child.on('exit', code => {
    if (code && code !== 0) console.error(`${name} stopped with code ${code}`);
  });
  children.push(child);
  return child;
};
const server = start('AgentSys Server', [
  path.join(__dirname, 'agentsys-server.js'),
  'start',
  '--port',
  String(serverPort),
  '--data',
  process.env.DATA_DIR || path.resolve('data'),
  // The client is a separate origin, so its two loopback spellings are allowed explicitly.
  '--allowed-origin',
  `http://127.0.0.1:${clientPort}`,
  '--allowed-origin',
  `http://localhost:${clientPort}`,
  ...(process.env.AGENTSYS_TOKEN ? ['--token', process.env.AGENTSYS_TOKEN] : []),
]);
const client = start('AgentSys Client', [
  path.join(__dirname, 'agentsys-client.js'),
  '--port',
  String(clientPort),
  '--server',
  `http://127.0.0.1:${serverPort}`,
]);
const url = `http://127.0.0.1:${clientPort}`;
setTimeout(() => {
  console.log(`\nAgentSys local session: ${url}`);
  console.log(`Server API: http://127.0.0.1:${serverPort}/api\n`);
  if (!process.argv.includes('--no-open')) {
    const {spawn: open} = require('node:child_process');
    const command =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    try {
      open(command[0], command[1], {detached: true, stdio: 'ignore'}).unref();
    } catch {}
  }
}, 1200);
const stop = () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of [server, client]) child.on('exit', () => setTimeout(stop, 100));
