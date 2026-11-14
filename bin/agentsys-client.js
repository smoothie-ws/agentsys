#!/usr/bin/env node
'use strict';
// AgentSys Client: a static browser client. It contains no backend, no interpreter and no storage access;
// every server call goes through the environment transport in js/app/environments.js.
//
//   agentsys-client --port 8081 --server http://127.0.0.1:8080
//
// The address is only the default for a new environment: the user can add and switch servers in the interface.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Protocol = require('../shared/protocol');
const {SERVER_ONLY} = require('../server/manifest');

const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};
const PUBLIC = /^(?:index\.html$|(?:js|css|docs|shared|client-plugins)\/)/;
const HELP = `AgentSys Client ${Protocol.VERSION}

Usage: agentsys-client [options]
  -p, --port <number>     Port (default ${Protocol.CLIENT_PORT})
  -H, --host <address>    Bind address (default 127.0.0.1)
  -s, --server <url>      Default server URL for a new environment
      --help, --version`;

function fail(message) {
  console.error(message);
  process.exit(2);
}
function parse(argv) {
  const options = {
    port: Number(process.env.CLIENT_PORT || Protocol.CLIENT_PORT),
    host: process.env.CLIENT_HOST || '127.0.0.1',
    server: process.env.AGENTSYS_DEFAULT_SERVER || 'http://127.0.0.1:' + Protocol.DEFAULT_PORT,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    const read = () => {
      if (inline !== undefined) return inline;
      if (argv[i + 1] === undefined) fail(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--port' || flag === '-p') options.port = Number(read());
    else if (flag === '--host' || flag === '-H') options.host = read();
    else if (flag === '--server' || flag === '-s') options.server = read();
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--version') options.version = true;
    else fail(`Unknown option: ${flag}`);
  }
  return options;
}

function inject(html, options) {
  return String(html).replace(
    '<head>',
    () =>
      '<head><script>globalThis.AGENTSYS_CLIENT=true;globalThis.AGENTSYS_DEFAULT_SERVER=' +
      JSON.stringify(options.server).replace(/</g, '\\u003c') +
      ';globalThis.AGENTSYS_UI_STORE={};</script>'
  );
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) return console.log(HELP);
  if (options.version) return console.log(Protocol.VERSION);
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) fail(`Invalid port: ${options.port}`);
  try {
    const url = new URL(options.server);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('not http(s)');
  } catch {
    fail('--server must be an http:// or https:// URL');
  }
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      return res.end('Bad request');
    }
    if (pathname === '/') pathname = '/index.html';
    if (!path.extname(pathname) || /^\/(?:p|library|ext|plugins|environments|settings)\//.test(pathname))
      pathname = '/index.html';
    const file = path.join(ROOT, pathname);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (!file.startsWith(ROOT + path.sep) || !PUBLIC.test(relative) || SERVER_ONLY.test(relative)) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      return res.end('Not found');
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        return res.end('Not found');
      }
      if (file === path.join(ROOT, 'index.html')) data = Buffer.from(inject(data, options));
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'",
      });
      res.end(data);
    });
  });
  server.listen(options.port, options.host, () => {
    const shown = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
    console.log(`AgentSys Client ${Protocol.VERSION}`);
    console.log(`Listening on http://${shown}:${server.address().port}`);
    console.log(`Default server: ${options.server}`);
    console.log('This client serves only static files; it has no backend and no graph runtime.');
  });
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

main();
