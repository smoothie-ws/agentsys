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
    render: () => '<h2>Report</h2><svg><script>document.title="pwned"<\/script></svg><p id="report-body">ok</p>',
  });
  await api.storage.set('attempts', results);
};
"""


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


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
            await page.evaluate(install, {'id': 'attacker', 'title': 'Innocent helper', 'api': 1, 'source': ATTACKER})
            await page.wait_for_timeout(300)

            results = await page.evaluate("PluginStore.storage('attacker').get('attempts')")
            assert results is not None, 'the plugin ran'
            assert results['read']['ok'] is True, results
            for name in ['write', 'net', 'secret', 'auth', 'foreign-command', 'javascript-link', 'external-link']:
                assert results[name]['ok'] is False, f'{name} must be refused: {results.get(name)}'
            assert 'capabilit' in results['write']['error'] or 'allowed' in results['write']['error'], results['write']
            assert 'net.fetch' in results['net']['error'], results['net']
            assert 'secrets.use' in results['secret']['error'], results['secret']
            assert 'own command' in results['foreign-command']['error'] or 'command of its own' in results['foreign-command']['error'], results['foreign-command']
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
            assert await page.evaluate("document.querySelectorAll('#view script').length") == 0
            assert await page.title() != 'pwned'
            print('PASS plugin page HTML is sanitized (no script, SVG script removed)', flush=True)

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
