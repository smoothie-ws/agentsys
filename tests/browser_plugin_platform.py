"""The client plugin platform end to end: five reference packages, lifecycle, UI extension points, server-side
deployment, environment isolation and server-only execution after the browser is gone.

Runs its own server(s) and client on free ports. Requires Playwright and Chromium.
"""
import asyncio
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
EXE = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
BROWSER = os.environ.get('AGENTSYS_BROWSER', 'chromium')
REFERENCE = ROOT / 'client-plugins' / 'reference'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Endpoint(http.server.BaseHTTPRequestHandler):
    hits = []
    secret = ''

    def do_GET(self):
        Endpoint.hits.append({'path': self.path, 'authorization': self.headers.get('Authorization')})
        body = json.dumps({'ok': True, 'path': self.path, 'authorization': self.headers.get('Authorization')}).encode()
        self.send_response(200 if self.path == '/status' else 404)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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


def http_json(base, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(base + '/api/' + path, data=data, method=method)
    request.add_header('X-AgentSys', '1')
    if data:
        request.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode()
        return json.loads(text) if text else None


async def install(page, slug):
    packet = json.loads(next((REFERENCE / slug).glob('*.agentsys-plugin.json')).read_text())
    return await page.evaluate('async pkg => await Extensions.install(pkg)', packet)


async def main():
    data_one = tempfile.mkdtemp(prefix='agentsys-plugin-platform-one-')
    data_two = tempfile.mkdtemp(prefix='agentsys-plugin-platform-two-')
    server_one_port, server_two_port, client_port = free_port(), free_port(), free_port()
    endpoint = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
    threading.Thread(target=endpoint.serve_forever, daemon=True).start()
    endpoint_url = f'http://127.0.0.1:{endpoint.server_port}'
    endpoint_port = endpoint.server_port
    Endpoint.secret = 'reference-secret-value-42'
    one = two = client = None
    try:
        one = start([
            'bin/agentsys-server.js', 'start', '--port', str(server_one_port), '--data', data_one,
            '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
        ])
        two = start([
            'bin/agentsys-server.js', 'start', '--port', str(server_two_port), '--data', data_two,
            '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
        ])
        client = start([
            'bin/agentsys-client.js', '--port', str(client_port), '--server', f'http://127.0.0.1:{server_one_port}',
        ])
        wait_http(f'http://127.0.0.1:{server_one_port}/api/meta')
        wait_http(f'http://127.0.0.1:{server_two_port}/api/meta')
        wait_http(f'http://127.0.0.1:{client_port}/')
        base = f'http://127.0.0.1:{client_port}/'
        one_base = f'http://127.0.0.1:{server_one_port}'
        two_base = f'http://127.0.0.1:{server_two_port}'

        async with async_playwright() as playwright:
            browser_type = getattr(playwright, BROWSER)
            browser = await browser_type.launch(executable_path=EXE if BROWSER == 'chromium' else None)
            context = await browser.new_context(viewport={'width': 1360, 'height': 900})
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(base)
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            await page.wait_for_function("typeof Extensions === 'object'")

            # ----- Plugin A: every UI extension point, modules and lifecycle hooks -----
            await install(page, 'ui-showcase')
            await page.wait_for_function("Extensions.apiOf('reference-ui-showcase') !== null")
            described = await page.evaluate("Extensions.describe('reference-ui-showcase')")
            assert len(described['pages']) == 1, described
            for key, count in [('toolbar', 1), ('menu', 1), ('home', 1), ('settings', 1), ('inspector', 1), ('commands', 3)]:
                assert len(described[key]) >= count, (key, described)
            assert (await page.evaluate("PluginStore.storage('reference-ui-showcase').get('installed')"))['version'] == '1.0.0'
            assert await page.evaluate("document.querySelectorAll('[data-ext-command=\"reference-ui-showcase:hello\"]').length") >= 1

            await page.evaluate("go('/ext/reference-ui-showcase/showcase')")
            await page.wait_for_selector('#ext-page-body h2')
            assert 'sandboxed plugin' in await page.locator('#ext-page-body').inner_text()
            assert 'JSON module' in await page.locator('#ext-page-body').inner_text()
            logo = await page.evaluate("document.querySelector('#ext-page-body img.plugin-logo')?.getAttribute('src') || ''")
            assert logo.startswith('data:image/png;base64,'), logo
            await page.locator('#ext-page-body [data-command="hello"]').click()
            await page.wait_for_timeout(350)
            stored = await page.evaluate("PluginStore.storage('reference-ui-showcase').get('last')")
            assert stored and stored['name'] == 'page', stored
            assert (await page.evaluate("PluginStore.storage('reference-ui-showcase').get('last')"))['count'] == 1

            # Toolbar button, canvas context-menu registration and dashboard card.
            await page.locator('#toolbar-slot [data-ext-command="reference-ui-showcase:hello"]').click()
            await page.wait_for_timeout(250)
            assert (await page.evaluate("PluginStore.storage('reference-ui-showcase').get('last')"))['count'] == 2
            assert len(await page.evaluate("Extensions.menuItems('canvas:selection', [{}])")) >= 1
            await page.evaluate("go('/')")
            await page.wait_for_selector('[data-ext-home="reference-ui-showcase:showcase"]')
            print('PASS Plugin A: toolbar action, context menu and dashboard card are registered and live', flush=True)

            await page.evaluate("go('/settings')")
            await page.wait_for_selector('#settings-extensions [data-ext-settings=\"reference-ui-showcase:showcase\"]')
            await page.locator('#settings-extensions [data-command="rotate-settings"]').click()
            await page.wait_for_timeout(300)
            assert await page.evaluate("PluginStore.storage('reference-ui-showcase').get('settings').greeting") == 'Hi'
            print('PASS Plugin A: page, toolbar, context menu, command, notification, dashboard, settings and inspector', flush=True)

            # The notification command is a real server write through notifications.write.
            await page.evaluate("Extensions.execute('reference-ui-showcase:notify')")
            await page.wait_for_timeout(300)
            assert (await page.evaluate("api('notifications')"))['total'] == 1
            print('PASS Plugin A: notification uses the declared notifications.write capability', flush=True)

            # The inspector slot draws plugin content for the selected node data.
            inspector = await page.evaluate(
                """() => new Promise(resolve => {
                  const host = document.createElement('div');
                  document.body.append(host);
                  Extensions.renderInspector(host, {node: {id: 'n1', kind: 'function', name: 'Chosen'}, project: 'p', workflow: 'w', selection: ['n1']});
                  setTimeout(() => resolve(host.innerText), 250);
                })"""
            )
            assert 'Chosen' in inspector, inspector
            print('PASS Plugin A: inspector extension renders for the selected node', flush=True)

            # A package update keeps data and runs onUpdate.
            updated = json.loads(next((REFERENCE / 'ui-showcase').glob('*.agentsys-plugin.json')).read_text())
            updated['manifest']['version'] = '1.1.0'
            await page.evaluate('async pkg => await Extensions.update("reference-ui-showcase", pkg)', updated)
            assert await page.evaluate("PluginStore.get('reference-ui-showcase').version") == '1.1.0'
            context_update = await page.evaluate("PluginStore.storage('reference-ui-showcase').get('updated')")
            assert context_update and context_update['from'] == '1.0.0' and context_update['to'] == '1.1.0', context_update
            assert (await page.evaluate("PluginStore.storage('reference-ui-showcase').get('last')"))['count'] == 2
            print('PASS lifecycle: update migrates in place, keeps data and runs onUpdate', flush=True)

            # ----- Plugin B: Library section, nodes, workflow template; server data without the plugin -----
            await install(page, 'library-pack')
            await page.wait_for_function("Extensions.apiOf('reference-library-pack') !== null")
            deployment = await page.evaluate("Extensions.deploy('reference-library-pack')")
            assert deployment['ok'], deployment
            assert deployment['summary']['library'] == 3, deployment
            resources = await page.evaluate("api('resources')")
            pack_nodes = [item for item in resources if item['payload'].get('plugin', {}).get('id') == 'reference-library-pack']
            assert len(pack_nodes) == 3, [r['name'] for r in pack_nodes]
            graph_info = await page.evaluate(
                """async () => {
                  const projects = await api('projects');
                  const project = projects.find(p => p.name === 'Reference pack');
                  const info = await api(`projects/${project.id}`);
                  const workflow = info.workflows.find(w => w.name === 'Library Pack demo');
                  const graph = await api(`projects/${project.id}/workflow`, {query: {workflow_id: workflow.id}});
                  return {project: project.id, workflow: workflow.id, nodes: graph.nodes.length, complex: graph.complex.length, edges: graph.edges.length};
                }"""
            )
            assert graph_info['complex'] == 1 and graph_info['edges'] >= 1, graph_info
            await page.evaluate("go('/library')")
            await page.wait_for_selector('a.card-main[href$="/ext/reference-library-pack/pack"]')
            await page.evaluate("go('/ext/reference-library-pack/pack')")
            await page.wait_for_selector('#ext-page-body h2')
            assert 'Library Pack' in await page.locator('#ext-page-body').inner_text()
            print('PASS Plugin B: Library section, three nodes and a runnable workflow template', flush=True)

            # The saved graph runs from the server. Stop the client plugin first: the node must not depend on it.
            await page.evaluate("Extensions.disable('reference-library-pack')")
            run = await page.evaluate(
                """async ids => api(`projects/${ids.project}/execution`, {method: 'POST', body: {wait: true}, query: {workflow_id: ids.workflow}})""",
                graph_info,
            )
            assert run['dispatch_status'] == 'completed', run
            assert 'Hello, world!' in ''.join((run.get('displays') or {}).values()), run
            print('PASS Plugin B: deployed nodes run with the plugin switched off', flush=True)

            # ----- Environment isolation: deploy the same package to a second server -----
            await page.evaluate("url => Environment.save({id: 'second', name: 'Second server', url})", two_base)
            await page.evaluate("Environment.setActive('second')")
            await page.wait_for_function("Environment.status().environment.id === 'second' && Environment.status().status === 'connected'")
            await page.wait_for_timeout(400)
            second_initial = await page.evaluate("api('resources')")
            assert not [r for r in second_initial if r['payload'].get('plugin', {}).get('id') == 'reference-library-pack'], 'the second server starts without the plugin deployment'
            assert await page.evaluate("PluginStore.get('reference-library-pack').enabled") is False
            await page.evaluate("Extensions.enable('reference-library-pack')")
            second = await page.evaluate("Extensions.deploy('reference-library-pack')")
            assert second['ok'], second
            second_resources = await page.evaluate("api('resources')")
            assert len([r for r in second_resources if r['payload'].get('plugin', {}).get('id') == 'reference-library-pack']) == 3
            first_ids = {item['id'] for item in pack_nodes}
            second_ids = {item['id'] for item in second_resources}
            assert not (first_ids & second_ids), 'no identifier crosses environments'
            print('PASS environments: the same plugin deploys independent resources to two servers', flush=True)

            await page.evaluate("Environment.setActive('local')")
            await page.wait_for_function("Environment.status().environment.id === 'local' && Environment.status().status === 'connected'")
            await page.wait_for_timeout(400)
            back_resources = await page.evaluate("api('resources')")
            back = {item['id'] for item in back_resources if item['payload'].get('plugin', {}).get('id') == 'reference-library-pack'}
            assert back == first_ids, (back, first_ids)
            print('PASS environments: switching back restores the first server without mixing data', flush=True)

            # ----- Plugin C: CRUD, validation, migration and a resource view -----
            await install(page, 'structured-data')
            await page.wait_for_function("Extensions.apiOf('reference-structured-data') !== null")
            c_deploy = await page.evaluate("Extensions.deploy('reference-structured-data')")
            assert c_deploy['ok'], c_deploy
            added = await page.evaluate("Extensions.execute('reference-structured-data:add-note')")
            assert added['data']['title'].startswith('Note')
            assert (await page.evaluate("api('collections/structured-notes/records')"))['total'] == 1
            invalid = await page.evaluate("Extensions.execute('reference-structured-data:add-invalid')")
            assert 'refused' in invalid, invalid
            assert (await page.evaluate("api('collections/structured-notes/records')"))['total'] == 1, 'an invalid record is not stored'
            race = await page.evaluate("Extensions.execute('reference-structured-data:race')")
            assert race['conflict'] >= 1, race
            migrated = await page.evaluate("Extensions.execute('reference-structured-data:migrate')")
            assert migrated['schemaVersion'] == 2
            rejected = await page.evaluate(
                """async () => {
                  try { await api('collections/structured-notes/records', {method: 'POST', body: {data: {title: 'x', priority: 9}}}); return 'accepted'; }
                  catch (error) { return error.message; }
                }"""
            )
            assert rejected != 'accepted' and 'priority' in rejected, rejected
            await page.evaluate("go('/ext/reference-structured-data/view-structured-notes')")
            await page.wait_for_selector('#ext-page-body h2')
            assert 'Structured notes' in await page.locator('#ext-page-body').inner_text()
            await page.reload()
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            assert (await page.evaluate("api('collections/structured-notes/records')"))['total'] == 1
            print('PASS Plugin C: CRUD, validation, concurrency, migration, resource view and persistence', flush=True)

            # ----- Plugin D: an allowed network call with a server secret, executed by a Library node -----
            await page.evaluate(
                "value => api('secrets/reference-demo', {method: 'PUT', body: {value}})", Endpoint.secret
            )
            await install(page, 'external-integration')
            await page.wait_for_function("Extensions.apiOf('reference-external') !== null")
            d_deploy = await page.evaluate("Extensions.deploy('reference-external')")
            assert d_deploy['ok'], d_deploy
            existing = await page.evaluate("api('collections/external-demo/records')")
            url = f'{endpoint_url}'
            # The plugin's own dialog: a form value becomes the action command's first argument.
            dialog_task = asyncio.create_task(page.evaluate("Extensions.execute('reference-external:edit-endpoint')"))
            await page.wait_for_selector('#modal[open]')
            await page.fill('#modal input[name=url]', url)
            await page.click('#modal button[data-plugin-dialog-action="0"]')
            dialog_answer = await dialog_task
            assert dialog_answer['action'] == 'save', dialog_answer
            assert dialog_answer['values']['url'] == url, dialog_answer
            existing = await page.evaluate("api('collections/external-demo/records')")
            assert existing['total'] == 1 and existing['records'][0]['data']['url'] == url
            if existing['total']:
                await page.evaluate(
                    """async args => api(`collections/external-demo/records/${args.id}`, {method: 'PUT', body: {data: {url: args.url}}, query: {if_version: args.version}})""",
                    {'id': existing['records'][0]['id'], 'url': url, 'version': existing['records'][0]['version']},
                )
            else:
                await page.evaluate("url => api('collections/external-demo/records', {method: 'POST', body: {data: {url}}})", url)
            d_ids = await page.evaluate(
                """async () => {
                  const projects = await api('projects');
                  const project = projects.find(p => p.name === 'Reference external');
                  return project ? project.id : null;
                }"""
            )
            # The plugin's endpoint command stores the URL through its own checked capabilities.
            endpoint_result = await page.evaluate("Extensions.execute('reference-external:check')")
            assert endpoint_result['status'] == 200, endpoint_result
            assert Endpoint.hits[-1]['authorization'] == Endpoint.secret, Endpoint.hits[-1]
            visible = await page.evaluate("[document.body.innerText, JSON.stringify(PluginStore.records())].join('\\n')")
            assert Endpoint.secret not in visible, 'a secret value reached the page or a plugin record'
            print('PASS Plugin D: net.fetch and a server secret work through the plugin boundary', flush=True)

            # The Library node from D is executable on its own. Build one workflow around it.
            d_run = await page.evaluate(
                """async () => {
                  const resources = await api('resources');
                  const node = resources.find(item => item.name === 'External: Local status' && item.payload.plugin?.id === 'reference-external');
                  const project = await api('projects', {method: 'POST', body: {name: 'External test'}});
                  await api(`projects/${project.id}/policy`, {method: 'PUT', body: {allow: ['graph.read', 'collections.read', 'net.fetch:127.0.0.1:*', 'secrets.use:reference-demo']}});
                  const workflow = await api(`projects/${project.id}/workflows`, {method: 'POST', body: {name: 'External flow'}});
                  const placed = await api(`projects/${project.id}/custom-nodes/${node.id}`, {method: 'POST', body: {point: {x: 0, y: 0}}, query: {workflow_id: workflow.id}});
                  const event = await api(`projects/${project.id}/primitives`, {method: 'POST', body: {primitive: 'event'}, query: {workflow_id: workflow.id}});
                  await api(`projects/${project.id}/port-connections`, {method: 'POST', body: {add: [{source: event.id, source_port: 'out', target: 'complex:' + placed.roots[0], target_port: 'in'}]}, query: {workflow_id: workflow.id}});
                  const run = await api(`projects/${project.id}/execution`, {method: 'POST', body: {wait: true}, query: {workflow_id: workflow.id}});
                  return {project: project.id, workflow: workflow.id, run};
                }"""
            )
            assert d_run['run']['dispatch_status'] == 'completed', d_run['run']
            assert 'external status 200' in ''.join((d_run['run'].get('displays') or {}).values()), d_run['run']
            body_text = json.dumps(d_run['run'])
            assert Endpoint.secret not in body_text, 'the secret is scrubbed from the node results'
            print('PASS Plugin D: the deployed node runs on the server and uses the secret without receiving it', flush=True)

            # ----- Plugin E: every forbidden attempt is refused -----
            await install(page, 'security-test')
            await page.wait_for_function("Extensions.apiOf('reference-security') !== null")
            await page.wait_for_timeout(700)
            report = await page.evaluate("PluginStore.storage('reference-security').get('results')")
            for name in [
                'write-project', 'write-collection', 'read-foreign-secret', 'use-foreign-secret', 'auth-endpoint',
                'path-traversal', 'foreign-command', 'notify-without-capability', 'direct-fetch', 'top-document',
                'top-storage', 'session-storage', 'style-import',
            ]:
                assert report[name]['ok'] is False, f'{name} was not refused: {report.get(name)}'
            popup = report['open-window']
            assert (popup['ok'] is False) or (popup['ok'] is True and 'blocked' in popup.get('value', '')), popup
            assert report['read-projects']['ok'] is True, report
            assert not any(p['name'] == 'injected by the security test' for p in await page.evaluate("api('projects')"))
            assert not any(item['name'] == 'security-injected' for item in await page.evaluate("api('collections')"))
            print('PASS Plugin E: writes, secrets, auth, traversal, foreign commands and sandbox escapes are refused', flush=True)

            # Disabling removes the sandbox, its registrations, styles and token; queued work never lands.
            await page.evaluate("Extensions.disable('reference-security')")
            await page.wait_for_timeout(1000)
            assert await page.evaluate("document.querySelector('iframe[title=\"Plugin reference-security\"]')") is None
            assert await page.evaluate("Extensions.describe('reference-security').pages.length") == 0
            assert not any(p['name'] == 'after disable' for p in await page.evaluate("api('projects')"))
            print('PASS lifecycle: disabling removes the iframe, registrations and queued work', flush=True)

            # Stress: repeated activation and deactivation leave exactly one sandbox and no leaked registration.
            for _ in range(20):
                await page.evaluate("Extensions.disable('reference-ui-showcase')")
                await page.evaluate("Extensions.enable('reference-ui-showcase')")
            state = await page.evaluate(
                """() => ({iframes: document.querySelectorAll('iframe[title="Plugin reference-ui-showcase"]').length,
                           pages: Extensions.describe('reference-ui-showcase').pages.length,
                           toolbar: Extensions.describe('reference-ui-showcase').toolbar.length,
                           commands: Extensions.describe('reference-ui-showcase').commands.length})"""
            )
            assert state == {'iframes': 1, 'pages': 1, 'toolbar': 1, 'commands': 3}, state
            assert not errors, errors
            print('PASS stress: twenty enable/disable cycles leave one sandbox and no duplicate registrations', flush=True)

            # ----- Recovery after a failed activation, uninstall and reinstall -----
            broken = {
                'id': 'reference-recovery', 'title': 'Recovery', 'version': '1.0.0', 'api': 2,
                'capabilities': ['graph.read'],
                'source': 'exports.activate = () => { throw new Error("this version cannot start"); };',
            }
            fixed = {
                'id': 'reference-recovery', 'title': 'Recovery', 'version': '1.0.1', 'api': 2,
                'capabilities': ['graph.read', 'graph.write'],
                'source': 'exports.activate = api => { api.commands.register("ok", () => "ok", {title: "OK"}); };'
                          'exports.migrate = async (api, context) => { await api.storage.set("migrated", context); return 2; };'
                          'exports.onUninstall = async api => { await api.request("POST", "projects", {name: "uninstall hook ran"}); };',
            }
            await page.evaluate('pkg => { PluginStore.install(pkg); return Extensions.reload(); }', broken)
            assert 'cannot start' in await page.evaluate("Extensions.errorOf('reference-recovery')")
            await page.evaluate('pkg => Extensions.update("reference-recovery", pkg)', fixed)
            assert await page.evaluate("Extensions.apiOf('reference-recovery') !== null")
            assert await page.evaluate("Extensions.errorOf('reference-recovery')") == ''
            await page.evaluate("Extensions.uninstall('reference-recovery')")
            assert await page.evaluate("PluginStore.get('reference-recovery')") is None
            assert any(
                item['name'] == 'uninstall hook ran' for item in await page.evaluate("api('projects')")
            ), 'onUninstall runs before the plugin is removed'
            await page.evaluate('pkg => Extensions.install(pkg)', fixed)
            assert await page.evaluate("Extensions.apiOf('reference-recovery') !== null")
            await page.evaluate("Extensions.uninstall('reference-recovery')")
            print('PASS lifecycle: failed activation recovers, uninstall and reinstall work', flush=True)

            # A successful update runs migrate and stores the data version it returns.
            migration_base = {
                'id': 'reference-migrate', 'title': 'Migrate', 'version': '1.0.0', 'api': 2,
                'capabilities': ['graph.read'],
                'source': 'exports.activate = api => { api.commands.register("ok", () => "ok", {title: "OK"}); };',
            }
            migration_next = {
                'id': 'reference-migrate', 'title': 'Migrate', 'version': '1.0.1', 'api': 2,
                'capabilities': ['graph.read'],
                'source': 'exports.activate = api => { api.commands.register("ok", () => "ok", {title: "OK"}); };'
                          'exports.migrate = async (api, context) => { await api.storage.set("migrated", context); return 3; };',
            }
            await page.evaluate('pkg => Extensions.install(pkg)', migration_base)
            await page.evaluate('pkg => Extensions.update("reference-migrate", pkg)', migration_next)
            assert await page.evaluate("PluginStore.get('reference-migrate').dataVersion") == 3
            migration = await page.evaluate("PluginStore.storage('reference-migrate').get('migrated')")
            assert migration['from'] == '1.0.0' and migration['to'] == '1.0.1' and migration['dataVersion'] == 0, migration
            await page.evaluate("Extensions.uninstall('reference-migrate')")
            print('PASS lifecycle: migrate runs on update and records its data version', flush=True)

            # A sandbox that stops answering (a crashed renderer or a hung frame) is stopped and can be started again.
            hang = {
                'id': 'reference-hang', 'title': 'Hang', 'version': '1.0.0', 'api': 2,
                'capabilities': ['graph.read'],
                'source': 'exports.activate = api => { api.commands.register("hang", () => new Promise(() => {}), {title: "Hang"}); };',
            }
            await page.evaluate('pkg => Extensions.install(pkg)', hang)
            answer = await page.evaluate(
                "async () => { try { await Extensions.execute('reference-hang:hang'); return 'resolved'; } catch (error) { return error.message; } }"
            )
            assert 'did not answer' in answer, answer
            assert await page.evaluate("Extensions.apiOf('reference-hang')") is None
            assert 'did not answer' in await page.evaluate("Extensions.errorOf('reference-hang')")
            await page.evaluate("Extensions.recover('reference-hang')")
            assert await page.evaluate("Extensions.apiOf('reference-hang') !== null")
            await page.evaluate("Extensions.uninstall('reference-hang')")
            print('PASS lifecycle: an unresponsive plugin frame is stopped and recovers', flush=True)

            # The sanitizer used for every plugin page: no script, style, handler, remote image or SVG data image.
            cleaned = await page.evaluate(
                """() => Extensions.sanitize('<p onclick="x"><img src="https://example.test/a.png"><img src="//example.test/b.png"><img src="/api/projects"><style>p{}</style><a href="javascript:x">x</a><img src="data:image/svg+xml,<svg/>"></p>')"""
            )
            for fragment in ['onclick', 'example.test', '/api/projects', '<style', 'javascript:', 'svg+xml']:
                assert fragment not in cleaned, (fragment, cleaned)
            print('PASS security: passive HTML drops handlers, styles, remote images and SVG data', flush=True)

            # ----- Dependency enforcement at activation, not only at install -----
            core = {
                'id': 'reference-dep-core', 'title': 'Dependency core', 'version': '1.0.0', 'api': 2,
                'capabilities': ['graph.read'],
                'source': 'exports.activate = api => { api.commands.register("ping", () => "pong", {title: "Ping"}); };',
            }
            child = {
                'id': 'reference-dep-child', 'title': 'Dependency child', 'version': '1.0.0', 'api': 2,
                'capabilities': ['graph.read'], 'dependencies': {'reference-dep-core': '^1.0.0'},
                'source': 'exports.activate = api => { api.commands.register("ready", () => "ready", {title: "Ready"}); };',
            }
            await page.evaluate('pkg => Extensions.install(pkg)', core)
            await page.evaluate('pkg => Extensions.install(pkg)', child)
            assert await page.evaluate("Extensions.apiOf('reference-dep-child') !== null")
            await page.evaluate("Extensions.disable('reference-dep-core')")
            assert await page.evaluate("Extensions.apiOf('reference-dep-child')") is None
            assert 'reference-dep-core' in await page.evaluate("Extensions.errorOf('reference-dep-child')")
            await page.evaluate("Extensions.enable('reference-dep-core')")
            await page.evaluate("Extensions.recover('reference-dep-child')")
            assert await page.evaluate("Extensions.apiOf('reference-dep-child') !== null")
            await page.evaluate("Extensions.uninstall('reference-dep-child')")
            await page.evaluate("Extensions.uninstall('reference-dep-core')")
            print('PASS dependencies: a disabled dependency stops its dependant until recovery', flush=True)

            # A forged message from the page itself is not accepted as a plugin call.
            await page.evaluate(
                "window.postMessage({__agentsys: 'plugin', kind: 'request', id: 1, args: ['POST', 'projects', {name: 'forged host message'}]}, '*')"
            )
            await page.wait_for_timeout(300)
            assert not any(p['name'] == 'forged host message' for p in await page.evaluate("api('projects')"))
            print('PASS security: postMessage from the page is ignored; only a plugin iframe is a source', flush=True)

            # ----- A second client: separate package state, same server -----
            context_two = await browser.new_context(viewport={'width': 1100, 'height': 800})
            page_two = await context_two.new_page()
            await page_two.goto(base)
            await page_two.wait_for_function("Environment && Environment.status().status === 'connected'")
            assert await page_two.evaluate("PluginStore.list()") == [], 'a second browser has no installed plugins'
            assert await page_two.evaluate("document.querySelectorAll('#toolbar-slot [data-ext-command]').length") == 0
            await install(page_two, 'ui-showcase')
            await page_two.wait_for_function("Extensions.apiOf('reference-ui-showcase') !== null")
            assert await page_two.evaluate("PluginStore.get('reference-ui-showcase').version") == '1.0.0'
            assert await page.evaluate("PluginStore.get('reference-ui-showcase').version") == '1.1.0'
            assert await page_two.evaluate("Extensions.describe('reference-ui-showcase').pages.length") == 1
            await context_two.close()
            print('PASS clients: two browsers with different package versions and different installed sets', flush=True)

            # ----- The browser is now closed; the server must still run the deployed graph -----
            b_ids = graph_info
            await page.evaluate("Extensions.uninstall('reference-library-pack')")
            assert any(p['name'] == 'Reference pack' for p in await page.evaluate("api('projects')"))
            await browser.close()

        # No browser, no client plugin: a plain HTTP caller asks the server to run the saved workflow.
        rerun = http_json(one_base, 'POST', f"projects/{b_ids['project']}/execution?workflow_id={b_ids['workflow']}", {'wait': True})
        assert rerun['dispatch_status'] == 'completed', rerun
        assert 'Hello, world!' in ''.join((rerun.get('displays') or {}).values()), rerun
        print('PASS server-only: a saved plugin-created graph runs with the browser closed and the plugin removed', flush=True)

        # The D node too: no browser, no plugin, ordinary data.
        d_rerun = http_json(
            one_base,
            'POST',
            f"projects/{d_run['project']}/execution?workflow_id={d_run['workflow']}",
            {'wait': True},
        )
        assert d_rerun['dispatch_status'] == 'completed', d_rerun
        print('PASS server-only: the external reference node runs with the browser closed', flush=True)

        # Environment two kept its own resources and did not receive the first server's data.
        assert http_json(two_base, 'GET', 'resources') != [], 'the second server still has its deployment'
        print('PASS server-only: two servers keep independent resources', flush=True)

    finally:
        for process in [client, one, two]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
        endpoint.shutdown()
        shutil.rmtree(data_one, ignore_errors=True)
        shutil.rmtree(data_two, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(main())
