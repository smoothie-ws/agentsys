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

TEST_BUILDER = r"""
exports.activate = async api => {
  api.commands.register('make-greeting', async () => {
    try {
      const item = await api.request('POST', 'library/script-nodes', {
        name: 'Greeting',
        description: 'Created by the platform test plugin.',
        code: 'node.output.text = "Hello from a Library node";',
        inputs: [],
        outputs: ['text'],
        grants: ['graph.read'],
      });
      await api.ui.toast('Library node "' + item.name + '" is on the server.');
      await api.ui.refresh();
    } catch (error) {
      await api.ui.toast('Could not create the node: ' + error.message, true);
    }
  }, {title: 'Create Greeting node', icon: 'code'});
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
            assert (await page.locator('#environment-indicator .env-name').inner_text()) == 'Local Server'
            placement = await page.evaluate(
                """() => {
                  const button = document.querySelector('#environment-indicator');
                  const row = button.closest('.sidebar-item');
                  const settings = document.querySelector('.sidebar-footer [data-section=settings]').closest('.sidebar-item');
                  return {
                    inSidebar: !!button.closest('#sidebar .sidebar-footer'),
                    inTopstrip: !!button.closest('#topstrip'),
                    aboveSettings: row.nextElementSibling === settings,
                    navRow: button.classList.contains('sidebar-link') && row.parentElement.classList.contains('sidebar-footer'),
                  };
                }"""
            )
            assert placement == {'inSidebar': True, 'inTopstrip': False, 'aboveSettings': True, 'navRow': True}, placement
            await page.set_viewport_size({'width': 390, 'height': 844})
            await page.wait_for_timeout(200)
            mobile = await page.evaluate(
                """() => {
                  const columns = getComputedStyle(document.querySelector('#sidebar')).gridTemplateColumns.split(' ').length;
                  const footer = [...document.querySelectorAll('.sidebar-footer .sidebar-item')];
                  const env = footer.findIndex(row => row.querySelector('#environment-indicator'));
                  const settings = footer.findIndex(row => row.querySelector('[data-section=settings]'));
                  return {columns, env, settings};
                }"""
            )
            assert mobile['columns'] == 6 and 0 <= mobile['env'] < mobile['settings'], mobile
            await page.set_viewport_size({'width': 1400, 'height': 900})
            await page.wait_for_timeout(200)
            print('PASS the client starts on its own and connects to the separate server', flush=True)

            # The client is a static program: it has no local Backend or storage layer.
            assert await page.evaluate("typeof Backend === 'undefined' && typeof DB === 'undefined'")
            print('PASS the client has no embedded backend, DB or interpreter', flush=True)

            # The Server row is a navigation link to the Manage servers page, not a context menu.
            await page.locator('#environment-indicator').click()
            await page.wait_for_selector('h1:has-text("Server")')
            assert '#/environments' in page.url, page.url
            assert await page.locator('.popup').count() == 0, 'the environment row must not open a context menu'
            assert await page.locator('[data-env-row="local"] .environment-status').inner_text() == 'Connected'
            assert await page.evaluate("document.querySelector('#environment-indicator').closest('.sidebar-item').classList.contains('active')")
            print('PASS the Server page shows the active connection', flush=True)

            # Every section root uses one menu spec in its page heading and in its sidebar row.
            for path, spec, heading in [
                ('/projects', 'section:projects', 'Projects'),
                ('/library', 'section:library', 'Library'),
                ('/plugins', 'section:plugins', 'Plugins'),
                ('/environments', 'section:environments', 'Server'),
                ('/settings', 'section:settings', 'Settings'),
                ('/api', 'section:api', 'API reference'),
            ]:
                await page.goto(f'http://127.0.0.1:{client_port}/#{path}')
                await page.wait_for_selector(f'h1:has-text("{heading}")')
                await page.wait_for_selector('.page-head [data-menu]')
                found = await page.evaluate(
                    """spec => ({
                      page: document.querySelector('.page-head [data-menu]')?.dataset.menu,
                      sidebar: document.querySelector(`#sidebar [data-menu="${spec}"], #subnav [data-menu="${spec}"]`)?.dataset.menu,
                      labels: null,
                    })""",
                    spec,
                )
                assert found['page'] == spec, (path, found)
                assert found['sidebar'] == spec, (path, found)
            print('PASS section page headings and sidebar rows share the same menu spec', flush=True)

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
            await page.wait_for_selector('.page-head [data-menu]')
            await page.locator('.page-head [data-menu]').click()
            await page.get_by_role('menuitem', name='Add server', exact=True).click()
            await page.wait_for_selector('#modal[open]')
            await page.fill('#modal input[name=name]', 'Second server')
            await page.fill('#modal input[name=url]', f'http://127.0.0.1:{second_port}')
            await page.click('#modal button.primary')
            await page.wait_for_selector('[data-env-row] >> text=Second server')
            row = page.locator('[data-env-row]', has_text='Second server')
            await row.locator('[data-menu]').click()
            await page.get_by_role('menuitem', name='Use this server', exact=True).click()
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
            local_row = page.locator('[data-env-row]', has_text='Local Server')
            await local_row.locator('[data-menu]').click()
            await page.get_by_role('menuitem', name='Use this server', exact=True).click()
            await page.wait_for_function("Environment.status().environment.name === 'Local Server' && Environment.status().status === 'connected'")
            await page.wait_for_timeout(500)
            first_projects = await page.evaluate("api('projects')")
            assert [p['name'] for p in first_projects] == ['Platform project'], first_projects
            print('PASS switching back restores the first server without mixing data', flush=True)

            # Client plugins are installed in this browser; the shipped catalog is empty. A test package can still
            # create a standard Library node, and that node keeps running with the plugin switched off.
            await page.goto(f'http://127.0.0.1:{client_port}/#/plugins')
            await page.wait_for_selector('h1:has-text("Plugins")')
            assert 'No client plugins' in await page.locator('#view').inner_text()
            await page.evaluate(
                """async source => {
                  PluginStore.install({
                    id: 'platform-builder', title: 'Platform Builder', api: 1,
                    capabilities: ['library.read', 'library.write'], source,
                  });
                  await Extensions.reload();
                }""",
                TEST_BUILDER,
            )
            await page.wait_for_function("Extensions.apiOf('platform-builder') !== null")
            await page.wait_for_timeout(300)
            await page.evaluate("Extensions.execute('platform-builder:make-greeting')")
            await page.wait_for_timeout(800)
            resources = await page.evaluate("api('resources')")
            assert any(item['name'] == 'Greeting' for item in resources)
            await page.evaluate("PluginStore.setEnabled('platform-builder', false); Extensions.reload()")
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
            print('PASS no bundled plugins; an installed package creates a standard node that outlives it', flush=True)

            # Server restart: definitions and durable state come back; the graph is not secretly started again.
            server.terminate()
            server.wait(timeout=15)
            server = start('server', [
                'bin/agentsys-server.js', 'start', '--port', str(server_port), '--data', data_one,
                '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
            ])
            wait_http(f'http://127.0.0.1:{server_port}/api/meta')
            # The open page reconnects by itself; a reload is not needed to learn that the server is back.
            await page.wait_for_function("Environment && Environment.status().status === 'connected'", timeout=20000)
            await page.reload()
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            projects = await page.evaluate("api('projects')")
            assert any(p['name'] == 'Platform project' for p in projects)
            execution = await page.evaluate(f"api('projects/{project['id']}/execution', {{query:{{workflow_id:'{workflow['id']}'}}}})")
            assert execution['status'] == 'idle'
            assert not any(node.get('status') in {'running', 'waiting', 'sleeping'} for node in execution.get('nodes', [])), execution
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
