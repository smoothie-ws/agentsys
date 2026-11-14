"""Client plugin isolation, end to end: a plugin that tries to write, reach the network, spend a secret,
run another plugin's command or inject a javascript: link is refused by the host, while a plugin that declares
the capability it needs works. Runs its own server and client on free ports; no project data is touched.
"""
import asyncio
import os
import shutil
import socket
import subprocess
import tempfile
import time
import functools
import http.server
import threading
from pathlib import Path
import urllib.request

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
EXE = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')

ATTACKER = r"""
exports.activate = async api => {
  const results = {};
  const attempt = async (name, work) => {
    try {
      const value = await work();
      results[name] = {ok: true, value: value === undefined ? null : value};
    } catch (error) {
      results[name] = {ok: false, error: String((error && error.message) || error)};
    }
  };
  await attempt('write', () => api.request('POST', 'projects', {name: 'injected'}));
  await attempt('net', () => api.request('POST', 'net', {url: 'https://example.test/'}));
  await attempt('secret', () => api.request('GET', 'secrets/anything'));
  await attempt('auth', () => api.request('GET', 'auth/session'));
  await attempt('foreign-command', () => api.commands.execute('victim:mark'));
  await attempt('notification', () => api.ui.notify({title: 'injected by a read-only plugin'}));
  await attempt('direct-fetch', async () => {
    const response = await fetch('__LEAK__/fetch?plugin=attacker');
    return response.status;
  });
  await attempt('direct-image', async () => {
    return await new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve('loaded');
      image.onerror = () => resolve('image blocked');
      image.src = '__LEAK__/image?plugin=attacker';
      setTimeout(() => resolve('timeout'), 500);
    });
  });
  await attempt('javascript-link', () =>
    api.ui.addSidebarItem({id: 'evil', title: 'Help', href: 'javascript:document.title="pwned"'}));
  await attempt('external-link', () =>
    api.ui.addSidebarItem({id: 'evil2', title: 'Docs', href: 'https://example.test/'}));
  await attempt('read', () => api.request('GET', 'projects'));
  await api.storage.set('attempts', results);
};
"""

VICTIM = r"""
exports.activate = async api => {
  api.commands.register('mark', async () => {
    await api.storage.set('marked', true);
    return 'marked';
  }, {title: 'Mark'});
};
"""

GRANTED = r"""
exports.activate = async api => {
  const results = {};
  try {
    const project = await api.request('POST', 'projects', {name: 'made by a granted plugin'});
    results.write = {ok: true, value: project.name};
  } catch (error) {
    results.write = {ok: false, error: String((error && error.message) || error)};
  }
  try {
    await api.request('GET', 'secrets/anything');
    results.secret = {ok: true};
  } catch (error) {
    results.secret = {ok: false, error: String((error && error.message) || error)};
  }
  api.ui.addPage({
    id: 'report',
    title: 'Report',
    render: () => '<h2>Report</h2><svg><script>document.title="pwned"<\/script></svg><p id="report-body">ok</p><a id="obfuscated" href="java&#10;script:document.title=\'pwned\'">click</a><style>body{background:url(https://example.test/x)}</style>',
  });
  await api.storage.set('attempts', results);
};
"""

NOTIFIER = r"""
exports.activate = async api => {
  const results = {};
  try {
    results.notification = await api.ui.notify({title: 'from a granted plugin'});
  } catch (error) {
    results.notification = {error: String((error && error.message) || error)};
  }
  await api.storage.set('attempts', results);
};
"""

BROKEN = r"""
exports.activate = async () => {
  throw new Error('this plugin cannot start');
};
"""


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Recorder(http.server.BaseHTTPRequestHandler):
    hits = []

    def do_GET(self):
        Recorder.hits.append(self.path)
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *_):
        pass


def wait_http(url, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return response.status
        except Exception:
            time.sleep(0.2)
    raise RuntimeError('not ready: ' + url)


def start(args):
    return subprocess.Popen(
        ['node'] + args,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )


async def main():
    data = tempfile.mkdtemp(prefix='agentsys-plugin-security-')
    server_port, client_port = free_port(), free_port()
    recorder = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Recorder)
    threading.Thread(target=recorder.serve_forever, daemon=True).start()
    leak_url = f'http://127.0.0.1:{recorder.server_port}'
    server = client = None
    try:
        server = start([
            'bin/agentsys-server.js', 'start', '--port', str(server_port), '--data', data,
            '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
        ])
        client = start([
            'bin/agentsys-client.js', '--port', str(client_port), '--server', f'http://127.0.0.1:{server_port}',
        ])
        wait_http(f'http://127.0.0.1:{server_port}/api/meta')
        wait_http(f'http://127.0.0.1:{client_port}/')

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path=EXE)
            page = await browser.new_page(viewport={'width': 1280, 'height': 860})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://127.0.0.1:{client_port}/')
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")

            install = """async pkg => {
              PluginStore.install(pkg);
              await Extensions.reload();
            }"""
            victim = await page.evaluate(install, {'id': 'victim', 'title': 'Victim', 'api': 1, 'source': VICTIM})
            assert victim is None
            await page.evaluate(install, {'id': 'attacker', 'title': 'Innocent helper', 'api': 1, 'source': ATTACKER.replace('__LEAK__', leak_url)})
            await page.wait_for_timeout(300)

            results = await page.evaluate("PluginStore.storage('attacker').get('attempts')")
            assert results is not None, 'the plugin ran'
            assert results['read']['ok'] is True, results
            for name in ['write', 'net', 'secret', 'auth', 'foreign-command', 'notification', 'direct-fetch', 'javascript-link', 'external-link']:
                assert results[name]['ok'] is False, f'{name} must be refused: {results.get(name)}'
            assert results['direct-image']['value'] == 'image blocked', results['direct-image']
            assert 'capabilit' in results['write']['error'] or 'allowed' in results['write']['error'], results['write']
            assert 'net.fetch' in results['net']['error'], results['net']
            assert 'secrets.use' in results['secret']['error'], results['secret']
            assert 'own command' in results['foreign-command']['error'] or 'command of its own' in results['foreign-command']['error'], results['foreign-command']
            assert 'notifications.write' in results['notification']['error'], results['notification']
            # The sandbox document's CSP blocks direct fetch and image loads: no request reached the recorder.
            assert Recorder.hits == [], Recorder.hits
            notifications = await page.evaluate("api('notifications')")
            assert notifications['total'] == 0, notifications
            # The victim command never ran.
            assert await page.evaluate("PluginStore.storage('victim').get('marked')") is None
            # The refused links are not in the interface, and the page title is untouched.
            assert await page.evaluate("document.querySelectorAll('[data-ext^=\"attacker:\"]').length") == 0
            assert await page.title() != 'pwned'
            # Nothing reached the server.
            projects = await page.evaluate("api('projects')")
            assert [p['name'] for p in projects] == [], projects
            print('PASS a read-only plugin cannot write, fetch, read secrets, run another command or add a link', flush=True)

            # The sandbox itself: scripts only, no same-origin access.
            sandbox = await page.evaluate("document.querySelector('iframe[title=\"Plugin victim\"]')?.getAttribute('sandbox')")
            assert sandbox == 'allow-scripts', sandbox
            print('PASS the plugin iframe is sandboxed to scripts only', flush=True)

            # A package that declares the write capability is allowed exactly that write, and nothing more.
            await page.evaluate(install, {
                'id': 'granted', 'title': 'Granted', 'api': 1,
                'capabilities': ['graph.read', 'graph.write'], 'source': GRANTED,
            })
            await page.wait_for_timeout(300)
            granted = await page.evaluate("PluginStore.storage('granted').get('attempts')")
            assert granted['write']['ok'] is True, granted
            assert granted['write']['value'] == 'made by a granted plugin'
            assert granted['secret']['ok'] is False, granted
            projects = await page.evaluate("api('projects')")
            assert [p['name'] for p in projects] == ['made by a granted plugin'], projects
            print('PASS a plugin with graph.write creates a project; its secret capability is still absent', flush=True)

            # A plugin that names notifications.write can post through the same checked path; the result is a real
            # notification and the host did not silently grant more.
            await page.evaluate(install, {
                'id': 'notifier', 'title': 'Notifier', 'api': 1,
                'capabilities': ['notifications.write'], 'source': NOTIFIER,
            })
            await page.wait_for_timeout(300)
            posted = await page.evaluate("PluginStore.storage('notifier').get('attempts')")
            assert posted['notification'].get('title') == 'from a granted plugin', posted
            notices = await page.evaluate("api('notifications')")
            assert notices['total'] == 1, notices
            print('PASS notifications.write is granted explicitly and posts a real notification', flush=True)

            # Disabling the plugin stops its sandbox and revokes the scoped token it held, not just the UI.
            held = await page.evaluate("Environment.pluginToken(['notifications.write'])")
            assert held, 'the host had issued a token to the plugin'
            await page.evaluate("PluginStore.setEnabled('notifier', false); Extensions.reload()")
            await page.wait_for_timeout(400)
            stopped = await page.evaluate(
                """async token => {
                  const response = await fetch(Environment.apiURL('projects'), {
                    headers: {Authorization: 'Bearer ' + token, 'X-AgentSys': '1'},
                  });
                  return response.status;
                }""",
                held,
            )
            assert stopped == 401, stopped
            print('PASS disabling a plugin revokes its scoped token', flush=True)

            # A plugin that throws on activate is reported, and the rest of the client keeps working.
            await page.evaluate(install, {'id': 'broken', 'title': 'Broken', 'api': 1, 'source': BROKEN})
            await page.wait_for_timeout(400)
            failure = await page.evaluate("Extensions.errorOf('broken')")
            assert 'this plugin cannot start' in failure, failure
            assert await page.evaluate("Environment.status().status === 'connected'")
            print('PASS a failing plugin is isolated and reported', flush=True)

            # Revocation is immediate: a token the host handed back no longer reads the API.
            revoked = await page.evaluate(
                """async () => {
                  const token = await Environment.pluginToken(['graph.read']);
                  const headers = {Authorization: 'Bearer ' + token, 'X-AgentSys': '1'};
                  const before = (await fetch(Environment.apiURL('projects'), {headers})).status;
                  Environment.revokePluginToken(token);
                  await new Promise(resolve => setTimeout(resolve, 300));
                  const after = (await fetch(Environment.apiURL('projects'), {headers})).status;
                  return {before, after};
                }"""
            )
            assert revoked['before'] == 200, revoked
            assert revoked['after'] == 401, revoked
            print('PASS revoking a plugin token takes effect immediately', flush=True)

            # The server enforces the capability even when the host layer is bypassed: a scoped token minted
            # for graph.read reads projects and is refused a write by the server itself.
            server_side = await page.evaluate(
                """async () => {
                  const token = await Environment.pluginToken(['graph.read']);
                  if (!token) return {supported: false};
                  const headers = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
                  const read = await fetch(Environment.apiURL('projects'), {headers, credentials: 'include'});
                  const write = await fetch(Environment.apiURL('projects'), {
                    method: 'POST', headers, credentials: 'include', body: JSON.stringify({name: 'server bypass'}),
                  });
                  return {supported: true, read: read.status, write: write.status, body: await write.text()};
                }"""
            )
            assert server_side['supported'], 'the server issues scoped tokens'
            assert server_side['read'] == 200, server_side
            assert server_side['write'] == 403, server_side
            assert 'graph.write' in server_side['body'], server_side
            print('PASS the server enforces a scoped plugin token even when the host layer is bypassed', flush=True)

            # Plugin HTML is sanitized, including namespaced SVG script elements.
            await page.goto(f'http://127.0.0.1:{client_port}/#/ext/granted/report')
            await page.wait_for_selector('#report-body')
            assert await page.evaluate("document.querySelectorAll('#view script, #view style').length") == 0
            assert await page.title() != 'pwned'
            # A URL parser ignores the newline in java&#10;script:, so the attribute must be gone before the click.
            assert await page.evaluate("document.querySelector('#obfuscated')?.getAttribute('href')") in (None, ''), (
                await page.evaluate("document.querySelector('#obfuscated')?.outerHTML")
            )
            await page.click('#obfuscated')
            await page.wait_for_timeout(200)
            assert await page.title() != 'pwned'
            print('PASS plugin page HTML is sanitized (no script, style, or obfuscated javascript: link)', flush=True)

            assert not errors, errors
            await browser.close()
    finally:
        for process in [server, client]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
        shutil.rmtree(data, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(main())
