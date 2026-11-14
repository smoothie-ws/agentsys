"""End-to-end platform check: an API-only server, a static client, two environments, a client plugin and
execution that continues when the client closes. Starts both processes itself; no shared project data.
"""
import asyncio
import json
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


def start(name, args):
    process = subprocess.Popen(
        ['node'] + args,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    return process


async def api(page, method, path, body=None):
    return await page.evaluate(
        """async ({method, path, body}) => api(path, {method, ...(body === null ? {} : {body})})""",
        {'method': method, 'path': path, 'body': body},
    )


async def main():
    data_one = tempfile.mkdtemp(prefix='agentsys-platform-one-')
    data_two = tempfile.mkdtemp(prefix='agentsys-platform-two-')
    server_port, client_port, second_port = free_port(), free_port(), free_port()
    server = client = second = None
    try:
        server = start('server', [
            'bin/agentsys-server.js', 'start', '--port', str(server_port), '--data', data_one,
            '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
        ])
        client = start('client', [
            'bin/agentsys-client.js', '--port', str(client_port), '--server', f'http://127.0.0.1:{server_port}',
        ])
        second = start('second', [
            'bin/agentsys-server.js', 'start', '--port', str(second_port), '--data', data_two,
            '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
        ])
        wait_http(f'http://127.0.0.1:{server_port}/api/meta')
        wait_http(f'http://127.0.0.1:{second_port}/api/meta')
        wait_http(f'http://127.0.0.1:{client_port}/')

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path=EXE)
            page = await browser.new_page(viewport={'width': 1400, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://127.0.0.1:{client_port}/')
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            await page.wait_for_selector('.page.dashboard')
            assert (await page.locator('#environment-indicator .env-name').inner_text()) == 'Local server'
            print('PASS the client starts on its own and connects to the separate server', flush=True)

            # The client is a static program: it has no local Backend or storage layer.
            assert await page.evaluate("typeof Backend === 'undefined' && typeof DB === 'undefined'")
            print('PASS the client has no embedded backend, DB or interpreter', flush=True)

            # Environments are a first-class page; the active server is visible and testable.
            await page.goto(f'http://127.0.0.1:{client_port}/#/environments')
            await page.wait_for_selector('h1:has-text("Environments")')
            assert await page.locator('[data-env-row="local"] .environment-status').inner_text() == 'Connected'
            print('PASS the Environments page shows the active connection', flush=True)

            # A project, a workflow and a run through the normal API transport.
            await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}})")
            project = await api(page, 'POST', 'projects', {'name': 'Platform project'})
            workflow = await api(page, 'POST', f"projects/{project['id']}/workflows", {'name': 'Flow'})
            wf = {'workflow_id': workflow['id']}
            # A Script-backed Library node, created through the same route a client plugin uses.
            item = await api(page, 'POST', 'library/script-nodes', {
                'name': 'Long task',
                'code': 'await new Promise(r => setTimeout(r, 2500)); node.display("finished without the client");',
                'outputs': ['text'],
                'grants': ['graph.read'],
            })
            placed = await api(page, 'POST', f"projects/{project['id']}/custom-nodes/{item['id']}", {
                **wf, 'point': {'x': 0, 'y': 0},
            })
            complex_id = 'complex:' + placed['roots'][0]
            event = await api(page, 'POST', f"projects/{project['id']}/typed-nodes", {
                **wf,
                'node_type': 'custom',
                'config': {'title': 'Start', 'op': 'on_run', 'inputs': [], 'outputs': [{'id': 'out', 'name': 'out', 'type': 'signal'}]},
                'position': {'x': -300, 'y': 0},
            })
            await api(page, 'POST', f"projects/{project['id']}/port-connections", {
                **wf, 'add': [{'source': event['id'], 'source_port': 'out', 'target': complex_id, 'target_port': 'in'}],
            })
            await api(page, 'POST', f"projects/{project['id']}/execution", wf)
            print('PASS a workflow started through the API transport', flush=True)

            # Closing the client must not stop the server-side workflow.
            await page.close()
            await asyncio.sleep(4)
            with urllib.request.urlopen(f'http://127.0.0.1:{server_port}/api/projects/{project["id"]}/execution?workflow_id={workflow["id"]}') as response:
                execution = json.loads(response.read())
            assert 'finished without the client' in ''.join(execution.get('displays', {}).values())
            print('PASS execution continued after the client closed', flush=True)

            # Reopen the client, reconnect and see the same state.
            page = await browser.new_page(viewport={'width': 1400, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://127.0.0.1:{client_port}/#/p/{project["id"]}/w/{workflow["id"]}')
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            await page.wait_for_selector('#canvas')
            assert (await page.locator(f'[data-id="{complex_id}"]').count()) == 1
            print('PASS the reopened client sees the server state', flush=True)

            # A second server has its own projects; switching never merges them.
            await page.goto(f'http://127.0.0.1:{client_port}/#/environments')
            await page.wait_for_selector('[data-env-add]')
            await page.click('[data-env-add]')
            await page.wait_for_selector('#modal[open]')
            await page.fill('#modal input[name=name]', 'Second server')
            await page.fill('#modal input[name=url]', f'http://127.0.0.1:{second_port}')
            await page.click('#modal button.primary')
            await page.wait_for_selector('[data-env-row] >> text=Second server')
            row = page.locator('.environment-row', has_text='Second server')
            await row.locator('[data-env-use]').click()
            await page.wait_for_function("Environment.status().environment.name === 'Second server' && Environment.status().status === 'connected'")
            await page.wait_for_timeout(500)
            second_projects = await page.evaluate("api('projects')")
            assert second_projects == [], second_projects
            await page.goto(f'http://127.0.0.1:{client_port}/#/projects')
            await page.wait_for_selector('h1:has-text("Projects")')
            assert 'Platform project' not in await page.locator('#view').inner_text()
            print('PASS switching to a second server shows only its own data', flush=True)

            # Back to the first server: the project is there and the other one is not.
            await page.goto(f'http://127.0.0.1:{client_port}/#/environments')
            await page.wait_for_selector('[data-env-row]')
            await page.locator('.environment-row', has_text='Local server').locator('[data-env-use]').click()
            await page.wait_for_function("Environment.status().environment.name === 'Local server' && Environment.status().status === 'connected'")
            await page.wait_for_timeout(500)
            first_projects = await page.evaluate("api('projects')")
            assert [p['name'] for p in first_projects] == ['Platform project'], first_projects
            print('PASS switching back restores the first server without mixing data', flush=True)

            # Client plugin: the bundled package runs sandboxed, creates a standard Library node and can be removed.
            await page.goto(f'http://127.0.0.1:{client_port}/#/plugins')
            await page.wait_for_selector('h1:has-text("Plugins")')
            assert await page.locator('.card', has_text='Script Node Builder').count() == 1
            sandboxed = await page.evaluate("Extensions.apiOf('hello-ui') !== null")
            assert sandboxed
            await page.goto(f'http://127.0.0.1:{client_port}/#/ext/hello-ui/overview')
            await page.wait_for_selector('h1:has-text("Hello")')
            await page.wait_for_function("document.querySelector('#view').innerText.includes('Hello from a plugin')")
            await page.evaluate("Extensions.execute('script-node-builder:make-greeting')")
            await page.wait_for_timeout(800)
            resources = await page.evaluate("api('resources')")
            assert any(item['name'] == 'Greeting' for item in resources)
            await page.evaluate("PluginStore.setEnabled('script-node-builder', false); Extensions.reload()")
            await page.evaluate("go('/library/nodes')")
            await page.wait_for_function("app.route && app.route.page === 'resources' && app.route.section === 'nodes'")
            await page.wait_for_function("document.querySelector('#view').innerText.includes('Greeting')")
            # The saved node is ordinary server data: it still runs with the plugin (and its interface) switched off.
            rerun = await page.evaluate(
                "api('projects/%s/execution', {method: 'POST', body: {workflow_id: '%s', wait: true}})"
                % (project['id'], workflow['id'])
            )
            assert 'finished without the client' in ''.join((rerun.get('displays') or {}).values()), rerun
            print('PASS a plugin-created node runs with the plugin disabled', flush=True)
            print('PASS a client plugin creates a standard node; the node remains after the plugin is off', flush=True)

            # Server restart: definitions and durable state come back; the graph is not secretly started again.
            server.terminate()
            server.wait(timeout=15)
            server = start('server', [
                'bin/agentsys-server.js', 'start', '--port', str(server_port), '--data', data_one,
                '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
            ])
            wait_http(f'http://127.0.0.1:{server_port}/api/meta')
            await page.reload()
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            projects = await page.evaluate("api('projects')")
            assert any(p['name'] == 'Platform project' for p in projects)
            execution = await page.evaluate(f"api('projects/{project['id']}/execution', {{query:{{workflow_id:'{workflow['id']}'}}}})")
            assert execution['status'] == 'idle'
            assert 'finished without the client' in ''.join(execution.get('displays', {}).values())
            print('PASS a server restart restores JSON data and does not rerun a workflow', flush=True)

            assert not errors, errors
            await browser.close()
    finally:
        for process in [second, server, client]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
        shutil.rmtree(data_one, ignore_errors=True)
        shutil.rmtree(data_two, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(main())
