#!/usr/bin/env node
'use strict';
// AgentSys Server: the headless graph execution server.
//
//   agentsys-server start --port 8080 --data ./data
//   agentsys-server status
//   agentsys-server version
//
// The server never serves the client and never loads plugins. See docs/server.md.
const fs = require('node:fs');
const path = require('node:path');
const {createApiServer} = require('../server/api-server');
const Protocol = require('../shared/protocol');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const HELP = `AgentSys Server ${Protocol.VERSION} (protocol ${Protocol.PROTOCOL})

Usage:
  agentsys-server start [options]
  agentsys-server status [options]
  agentsys-server migrate --data <folder> [--dry-run] [--json]
  agentsys-server version
  agentsys-server help

Start options:
  -p, --port <number>        TCP port (default ${Protocol.DEFAULT_PORT}, 0 picks a free one)
  -H, --host <address>       Bind address (default 127.0.0.1)
  -d, --data <folder>        Data folder (default ./data)
      --name <text>          Name shown to clients
      --token <token>        API token (or AGENTSYS_TOKEN)
      --allowed-origin <url> Exact browser origin allowed by CORS (repeatable)
      --allowed-host <name>  Extra Host header accepted on loopback (repeatable)
      --allow-net <host>     Restrict POST /api/net and Script net.fetch to these hosts (repeatable, * allowed)
      --tls-cert <file>      TLS certificate (PEM) — enables HTTPS
      --tls-key <file>       TLS private key (PEM)
      --session-hours <n>    Session lifetime in hours (default 12)
      --trust-proxy          Trust X-Forwarded-Proto from a local reverse proxy (Secure cookies)
  -q, --quiet                Only print errors

Status options:
      --url <url>            Server base URL (default http://127.0.0.1:${Protocol.DEFAULT_PORT})
      --json                 Print the answer as JSON

Environment:
  AGENTSYS_TOKEN, AGENTSYS_ALLOWED_ORIGINS, ALLOWED_HOSTS, DATA_DIR, HOST, PORT

The server is safe to expose only behind HTTPS (directly with --tls-cert/--tls-key, or a reverse
proxy) and with a token. It has no server plugin mechanism; user programs run in the graph runtime.
`;

function usageError(message) {
  console.error(message);
  console.error('Run "agentsys-server help" for usage.');
  process.exit(2);
}

function parse(argv) {
  const result = {
    command: 'start',
    port: process.env.PORT === undefined ? Protocol.DEFAULT_PORT : Number(process.env.PORT),
    host: process.env.HOST || '127.0.0.1',
    data: process.env.DATA_DIR || path.resolve('data'),
    token: process.env.AGENTSYS_TOKEN || '',
    allowedOrigins: String(process.env.AGENTSYS_ALLOWED_ORIGINS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    allowedHosts: String(process.env.ALLOWED_HOSTS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    allowedNet: String(process.env.AGENTSYS_ALLOW_NET || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    name: process.env.AGENTSYS_NAME || '',
    quiet: false,
    json: false,
    dryRun: false,
    url: '',
    tlsCert: '',
    tlsKey: '',
    sessionHours: 12,
    trustProxy: process.env.AGENTSYS_TRUST_PROXY === '1',
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    result.command = args.shift();
    if (!['start', 'status', 'migrate', 'version', 'help', '--help', '-h', '--version'].includes(result.command))
      usageError(`Unknown command: ${result.command}`);
    if (['--help', '-h'].includes(result.command)) result.command = 'help';
    if (result.command === '--version') result.command = 'version';
  }
  const value = (name, i) => {
    if (args[i] === undefined) usageError(`${name} needs a value`);
    return args[i];
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const read = () => (inline !== undefined ? inline : value(flag, ++i));
    if (flag === '--port' || flag === '-p') result.port = Number(read());
    else if (flag === '--host' || flag === '-H') result.host = read();
    else if (flag === '--data' || flag === '-d') result.data = read();
    else if (flag === '--token') result.token = read();
    else if (flag === '--allowed-origin') result.allowedOrigins.push(read());
    else if (flag === '--allowed-host') result.allowedHosts.push(read());
    else if (flag === '--allow-net') result.allowedNet.push(read());
    else if (flag === '--name') result.name = read();
    else if (flag === '--tls-cert') result.tlsCert = read();
    else if (flag === '--tls-key') result.tlsKey = read();
    else if (flag === '--session-hours') result.sessionHours = Number(read());
    else if (flag === '--url') result.url = read();
    else if (flag === '--json') result.json = true;
    else if (flag === '--dry-run') result.dryRun = true;
    else if (flag === '--trust-proxy') result.trustProxy = true;
    else if (flag === '--quiet' || flag === '-q') result.quiet = true;
    else if (flag === '--help' || flag === '-h') result.command = 'help';
    else if (flag === '--version') result.command = 'version';
    else usageError(`Unknown option: ${arg}`);
  }
  return result;
}

function baseURL(options) {
  const shown = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  return `${options.tlsCert ? 'https' : 'http'}://${shown}:${options.port}`;
}

async function status(options) {
  const url = (options.url || baseURL(options)).replace(/\/+$/, '') + Protocol.META_PATH;
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(5000), headers: {Accept: 'application/json'}});
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message || `HTTP ${response.status}`);
    if (options.json) console.log(JSON.stringify(value, null, 2));
    else {
      console.log(`AgentSys Server: ${value.server_name || url}`);
      console.log(`  Version:  ${value.version} (protocol ${value.protocol})`);
      console.log(`  Status:   online, up ${value.uptime_seconds ?? '?'} s`);
      console.log(`  Auth:     ${value.auth}`);
      console.log(`  Address:  ${url.replace(/\/api\/meta$/, '')}`);
    }
    return 0;
  } catch (error) {
    if (options.json) console.log(JSON.stringify({online: false, error: error.message}));
    else console.error(`AgentSys Server at ${url}: ${error.message}`);
    return 1;
  }
}

async function start(options) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    usageError(`Invalid port: ${options.port}`);
  if (!Number.isFinite(options.sessionHours) || options.sessionHours <= 0 || options.sessionHours > 24 * 30)
    usageError('--session-hours must be between 0 and 720');
  const loopback = LOOPBACK.has(options.host) || /^127\./.test(options.host);
  if (!loopback && !options.token)
    usageError('Refusing to expose the API without a token. Set AGENTSYS_TOKEN or --token.');
  if (!!options.tlsCert !== !!options.tlsKey || (options.tlsCert && !fs.existsSync(options.tlsCert)))
    usageError('TLS needs both --tls-cert and --tls-key pointing to readable files.');
  if (options.tlsKey && !fs.existsSync(options.tlsKey)) usageError(`TLS key not found: ${options.tlsKey}`);
  fs.mkdirSync(path.resolve(options.data), {recursive: true});
  const app = createApiServer({
    dataDir: options.data,
    host: options.host,
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    allowedHosts: options.allowedHosts,
    allowedNetHosts: options.allowedNet,
    name: options.name,
    serverVersion: Protocol.VERSION,
    sessionTtlMs: Math.round(options.sessionHours * 60 * 60 * 1000),
    trustProxy: options.trustProxy,
    ...(options.tlsCert ? {tls: {cert: fs.readFileSync(options.tlsCert), key: fs.readFileSync(options.tlsKey)}} : {}),
  });
  const url = await app.listen(options.port);
  if (!options.quiet) {
    console.log(`AgentSys Server ${Protocol.VERSION} (protocol ${Protocol.PROTOCOL})`);
    console.log(`Listening on ${url}`);
    console.log(`Data folder: ${app.dataDir}`);
    console.log(`API: ${url}/api (meta: ${url}${Protocol.META_PATH})`);
    console.log(options.token ? 'Auth: bearer token or an HttpOnly session' : 'Auth: loopback only (no token)');
    console.log('Server plugins: disabled by design.');
    console.log('Press Ctrl+C to stop.');
  }
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    if (!options.quiet) console.log(`\nStopping (${signal})…`);
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error('Could not stop cleanly:', error.message);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Keep the process alive while the server listens.
  await new Promise(() => {});
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help') return console.log(HELP);
  if (options.command === 'version') return console.log(`${Protocol.VERSION} (protocol ${Protocol.PROTOCOL})`);
  if (options.command === 'status') process.exitCode = await status(options);
  else if (options.command === 'start') await start(options);
  else if (options.command === 'migrate') {
    const {migrateData} = require('../server/migrate');
    const report = await migrateData({
      dataDir: options.data,
      dryRun: options.dryRun,
      log: message => (options.quiet ? undefined : console.log(message)),
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Migration ${report.dry_run ? 'preview' : 'complete'} for ${report.data_dir}`);
      console.log(`  Plugins preserved: ${report.plugins.length}`);
      console.log(`  Provider records migrated: ${report.migrated.records}`);
      console.log(`  Secrets created: ${report.migrated.secrets.length}`);
      if (report.backup) console.log(`  Backup: ${report.backup}`);
      for (const warning of report.warnings) console.log(`  ! ${warning}`);
    }
  }
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
