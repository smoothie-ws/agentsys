#!/usr/bin/env node
'use strict';
// Headless interface smoke: opens the main pages in a local Chrome/Edge through the DevTools
// protocol and reports render errors and screenshots. No npm dependencies and no build step.
//
//   node tools/smoke.js
//   node tools/smoke.js --mobile --url http://127.0.0.1:8765 --chrome "C:\...\chrome.exe" --out shots
//
// Without --url it starts server.js on a free port with a temporary copy of data/, so the
// smoke never writes to the real data folder. Requires a Chrome or Edge executable.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    args[name] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file)) ?? '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

function copyData(target) {
  const source = path.join(root, 'data');
  if (fs.existsSync(source)) fs.cpSync(source, target, {recursive: true});
  else fs.mkdirSync(target, {recursive: true});
}

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-smoke-data-'));
  copyData(dataDir);
  const child = spawn(process.execPath, [path.join(root, 'server.js'), '--port', '0'], {
    cwd: root,
    env: {...process.env, DATA_DIR: dataDir},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('The server did not start: ' + output)), 15000);
    const read = chunk => {
      output += String(chunk);
      const match = /AgentSys: (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve({child, dataDir, url: match[1]});
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(Error(`The server exited (${code}): ` + output));
    });
  });
}

function connectWebSocket(url) {
  const target = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect({host: target.hostname, port: Number(target.port)});
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0),
      open = false,
      onmessage = () => {};
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    const sendFrame = (op, payload) => {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const mask = crypto.randomBytes(4);
      const header = Buffer.alloc(data.length < 126 ? 2 : data.length < 65536 ? 4 : 10);
      header[0] = 0x80 | op;
      if (data.length < 126) header[1] = 0x80 | data.length;
      else if (data.length < 65536) {
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      } else {
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
      }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.slice(0, end).toString();
        buffer = buffer.slice(end + 4);
        if (!head.startsWith('HTTP/1.1 101')) return reject(Error(head.slice(0, 200)));
        open = true;
        resolve({
          send: text => sendFrame(1, text),
          close: () => {
            sendFrame(8, Buffer.alloc(0));
            socket.end();
          },
          set onmessage(fn) {
            onmessage = fn;
          },
        });
      }
      while (buffer.length >= 2) {
        const op = buffer[0] & 0xf,
          masked = buffer[1] & 0x80;
        let length = buffer[1] & 0x7f,
          offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = buffer.slice(offset, offset + length);
        buffer = buffer.slice(offset + length);
        if (op === 1) onmessage(payload.toString());
        else if (op === 8) socket.end();
        else if (op === 9) sendFrame(0xa, payload);
      }
    });
  });
}

async function launchChrome(executable, profile) {
  const port = await freePort();
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1440,900',
    'about:blank',
  ]);
  let target;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
        method: 'PUT',
      });
      if (response.ok) {
        target = await response.json();
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!target) throw Error('The browser did not expose its debugger');
  const ws = await connectWebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map(),
    exceptions = [];
  ws.onmessage = text => {
    const message = JSON.parse(text);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, {resolve, reject});
      ws.send(JSON.stringify({id, method, params}));
    });
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source:
      'globalThis.__smokeErrors=[];addEventListener("error",e=>__smokeErrors.push(String(e.message)));' +
      'addEventListener("unhandledrejection",e=>__smokeErrors.push(String(e.reason)));',
  });
  return {child, ws, call, exceptions};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = String(args.chrome || findChrome());
  if (!chrome) throw Error('Chrome or Edge was not found; pass --chrome <path>');
  const out = path.resolve(String(args.out || path.join(root, 'node_modules', '.cache', 'agentsys', 'smoke')));
  fs.mkdirSync(out, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-smoke-profile-'));
  let server = null,
    browser = null;
  const failures = [];
  try {
    const url = args.url ? String(args.url) : (server = await startServer()).url;
    const api = async route => {
      const response = await fetch(`${url}/api/${route}`, {headers: {'X-AgentSys': '1'}});
      if (!response.ok) throw Error(`${route}: ${response.status}`);
      return response.json();
    };
    const projects = await api('projects');
    const project = projects[0];
    const detail = project ? await api(`projects/${project.id}`) : null;
    const workflow = detail?.workflows?.[0]?.id;
    const pages = [
      ['dashboard', '/editor/', 'home'],
      ['projects', '/editor/projects', 'projects'],
      ['library', '/editor/library', 'resources'],
      ['settings', '/editor/settings', 'settings'],
      ['plugins', '/editor/plugins', 'plugins'],
    ];
    if (project) pages.push(['project', `/editor/p/${project.id}`, 'project']);
    if (workflow) pages.push(['workflow', `/editor/p/${project.id}/w/${workflow}`, 'workflow']);

    browser = await launchChrome(chrome, profile);
    const {call, exceptions} = browser;
    const check = async (name, route, page, suffix = '') => {
      exceptions.length = 0;
      await call('Page.navigate', {url: 'about:blank'});
      await sleep(250);
      await call('Page.navigate', {url: url + route});
      await sleep(3500);
      const result = await call('Runtime.evaluate', {
        expression: `JSON.stringify({
          page: document.body.dataset.page || '',
          viewNodes: document.querySelector('#view')?.querySelectorAll('*').length || 0,
          canvasNodes: document.querySelectorAll('#nodes .node').length,
          errors: globalThis.__smokeErrors || []
        })`,
        returnByValue: true,
      });
      const info = JSON.parse(result.result.value);
      const shot = await call('Page.captureScreenshot', {format: 'png'});
      const label = name + suffix;
      const file = path.join(out, label + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const errors = [...info.errors, ...exceptions];
      const ok = info.page === page && (info.viewNodes > 0 || info.canvasNodes > 0) && errors.length === 0;
      if (!ok) failures.push({name: label, expected: page, ...info, errors});
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(16)} page=${info.page || '-'} view=${info.viewNodes} canvas=${info.canvasNodes} -> ${file}`
      );
    };
    for (const [name, route, page] of pages) await check(name, route, page);
    if (args.mobile) {
      await call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      for (const [name, route, page] of pages)
        if (['dashboard', 'projects', 'workflow'].includes(name)) await check(name, route, page, '-mobile');
      await call('Emulation.clearDeviceMetricsOverride');
    }
  } finally {
    try {
      await browser?.call('Browser.close');
    } catch {}
    browser?.ws.close();
    browser?.child.kill();
    server?.child.kill();
    await sleep(200);
    if (server) fs.rmSync(server.dataDir, {recursive: true, force: true});
    fs.rmSync(profile, {recursive: true, force: true});
  }
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
