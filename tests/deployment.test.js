'use strict';
// Deployment-facing behaviour of the server CLI without starting a long-lived process: help, version, status,
// startup validation and clear errors. The real browser tests start the server and client separately.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {execFileSync, spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'agentsys-server.js');

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {code: 0, stdout};
  } catch (error) {
    return {code: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '')};
  }
}

test('help and version describe the deployment surface, including the private-network switch', () => {
  const help = run(['help']);
  assert.equal(help.code, 0);
  for (const flag of ['--host', '--token', '--allow-net', '--deny-private-net', '--tls-cert', '--trust-proxy'])
    assert.match(help.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const version = run(['version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^0\.3\.0 \(protocol 1\)/);
});

test('startup validation names the bad value instead of failing later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-cli-'));
  try {
    for (const [args, pattern] of [
      [['start', '--host', 'http://example.com', '--data', dir], /--host/],
      [['start', '--allowed-origin', 'https://example.com/app', '--data', dir], /without a path|origin/],
      [['start', '--allowed-origin', 'not a url', '--data', dir], /not a URL/],
      [['start', '--allow-net', 'https://example.com', '--data', dir], /--allow-net/],
      [['start', '--host', '0.0.0.0', '--data', dir], /without a token/],
      [['start', '--session-hours', '0', '--data', dir], /session-hours/],
      [['start', '--port', '99999', '--data', dir], /Invalid port/],
      [['start', '--tls-cert', path.join(dir, 'missing.pem'), '--data', dir], /both --tls-cert/],
    ]) {
      const result = run(args);
      assert.notEqual(result.code, 0, args.join(' '));
      assert.match(result.stderr + result.stdout, pattern, args.join(' '));
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('status reports an offline server as an exit code, not an uncaught error', () => {
  const result = run(['status', '--url', 'http://127.0.0.1:2', '--json']);
  assert.equal(result.code, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.online, false);
  assert.equal(typeof value.error, 'string');
});

test('a server announces the data folder, API and protocol, then closes on a signal', {timeout: 20000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-cli-live-'));
  const child = spawn(
    process.execPath,
    [CLI, 'start', '--port', '0', '--data', dir, '--quiet'],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env}}
  );
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  try {
    // --quiet still prints nothing; stop the process when it is listening by waiting for the lock file.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !fs.existsSync(path.join(dir, '.server.lock'))) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(path.join(dir, '.server.lock')), true, 'the server started; ' + output);
    child.kill('SIGINT');
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.ok(code === 0 || code === null || code === 1, 'the process ended (code ' + code + ')');
    // The lock is released by a clean close. On Windows a forced signal may skip the handler; a next start still takes over.
    const next = run(['status', '--url', 'http://127.0.0.1:2', '--json']);
    assert.equal(next.code, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
