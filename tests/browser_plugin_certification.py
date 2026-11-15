"""Real standalone SDK products, ordered workflow execution with the browser closed, and client recovery.

Uses isolated temporary data and a synthetic HTTP service. AGENTSYS_BROWSER selects the browser engine.
"""
import asyncio
import http.server
import json
import os
import shutil
import tempfile
import threading

from playwright.async_api import async_playwright
from browser_plugin_platform import ROOT, Endpoint, free_port, start, wait_http, http_json


async def install(page, name):
    package = next((ROOT / 'client-plugins' / name).glob('*.agentsys-plugin.json'))
    await page.evaluate('pkg => Extensions.install(pkg)', json.loads(package.read_text()))


async def main():
    directory = tempfile.mkdtemp(prefix='agentsys-certification-')
    second_directory = tempfile.mkdtemp(prefix='agentsys-certification-second-')
    server_port, second_port, client_port = free_port(), free_port(), free_port()
    endpoint = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
    threading.Thread(target=endpoint.serve_forever, daemon=True).start()
    server = second_server = client = None
    try:
        server = start(['bin/agentsys-server.js', 'start', '--port', str(server_port), '--data', directory,
                        '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet'])
        client = start(['bin/agentsys-client.js', '--port', str(client_port), '--server', f'http://127.0.0.1:{server_port}'])
        second_server = start(['bin/agentsys-server.js', 'start', '--port', str(second_port), '--data', second_directory,
                               '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet'])
        base = f'http://127.0.0.1:{server_port}'
        client_url = f'http://127.0.0.1:{client_port}'
        wait_http(base + '/api/meta')
        wait_http(f'http://127.0.0.1:{second_port}/api/meta')
        wait_http(client_url)
        async with async_playwright() as p:
            engine = os.environ.get('AGENTSYS_BROWSER', 'chromium')
            browser = await getattr(p, engine).launch(headless=True)
            context = await browser.new_context(viewport={'width': 1100, 'height': 800})
            await context.add_init_script("""(() => {
              const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window), listeners = new Set();
              window.addEventListener = (type, callback, options) => { if (type === 'message') listeners.add(callback); return add(type, callback, options); };
              window.removeEventListener = (type, callback, options) => { if (type === 'message') listeners.delete(callback); return remove(type, callback, options); };
              window.messageListenerCount = () => listeners.size;
            })();""")
            page = await context.new_page()
            errors = []
            def page_error(error):
                errors.append(str(error))
                print('PAGE ERROR:', str(error), getattr(error, 'stack', ''), flush=True)
            page.on('pageerror', page_error)
            page.on('requestfailed', lambda request: print('REQUEST FAILED:', request.method, request.url, request.failure, flush=True))
            await page.goto(client_url)
            await page.wait_for_function("Environment.status().status === 'connected'")
            package = json.loads(next((ROOT / 'client-plugins' / 'integration-studio').glob('*.agentsys-plugin.json')).read_text())
            await page.evaluate("pkg => reviewPluginPackage(pkg, 'integration-studio.json', () => Extensions.install(pkg, {approveCapabilities: true}))", package)
            assert 'secrets.use:integration-demo' in await page.locator('#modal-body').inner_text()
            await page.click('#modal button[value=cancel]')
            assert await page.evaluate("PluginStore.get('integration-studio')") is None
            await page.evaluate("pkg => reviewPluginPackage(pkg, 'integration-studio.json', () => Extensions.install(pkg, {approveCapabilities: true}))", package)
            await page.click('#modal button[value=ok]')
            await page.wait_for_function("Extensions.apiOf('integration-studio') !== null")
            # Simulate an older server: not even an authenticated owner cookie authorizes a plugin downgrade.
            await page.route('**/api/auth/plugin-session', lambda route: route.fulfill(
                status=404, content_type='application/json', body='{"error":{"code":"not_found"}}',
                headers={'Access-Control-Allow-Origin': client_url, 'Access-Control-Allow-Credentials': 'true'}))
            denied = await page.evaluate("Extensions.deploy('integration-studio')")
            assert not denied['ok'], denied
            assert all(error['code'] == 'plugin_tokens_unsupported' for error in denied['errors']), denied
            assert not any(resource.get('payload', {}).get('plugin', {}).get('id') == 'integration-studio'
                           for resource in http_json(base, 'GET', 'resources'))
            assert http_json(base, 'GET', 'collections') == []
            await page.unroute('**/api/auth/plugin-session')
            deployment = await page.evaluate("Extensions.deploy('integration-studio')")
            assert deployment['ok'], deployment
            assert deployment['summary']['library'] == 6
            again = await page.evaluate("Extensions.deploy('integration-studio')")
            assert again['ok'] and again['summary']['created'] == 0, again
            edit = asyncio.create_task(page.evaluate("Extensions.execute('integration-studio:edit')"))
            await page.wait_for_selector('#modal[open] input[name=endpoint]')
            await page.fill('#modal input[name=name]', 'Synthetic status')
            await page.fill('#modal input[name=endpoint]', f'http://127.0.0.1:{endpoint.server_port}/status')
            http_json(base, 'PUT', 'secrets/integration-demo', {'value': 'synthetic-integration-secret-42'})
            await page.select_option('#modal select[name=auth]', 'bearer')
            await page.fill('#modal input[name=secretName]', 'integration-demo')
            await page.click('#modal button[data-plugin-dialog-action="0"]')
            answer = await edit
            assert not answer.get('error'), answer
            record = answer['result']
            assert await page.evaluate("id => Extensions.execute('integration-studio:check', id)", record['id']) == 'HTTP 200'
            assert Endpoint.hits[-1]['authorization'] == 'Bearer synthetic-integration-secret-42'
            assert 'synthetic-integration-secret-42' not in await page.evaluate('JSON.stringify(PluginStore.records())')
            graph = await page.evaluate("Extensions.execute('integration-studio:build')")
            assert await page.evaluate("Extensions.execute('integration-studio:build')") == graph
            print('PASS Integration Studio: independent package, six Library stages, connection CRUD, check and idempotent build', flush=True)
            # Owner explicitly approves execution grants. Plugin capabilities never replace the project policy.
            http_json(base, 'PUT', f"projects/{graph['project']}/policy", {'allow': [
                'graph.read', 'collections.read', 'collections.write', 'net.fetch:127.0.0.1:*', 'secrets.use:integration-demo']})
            await install(page, 'graph-developer-tools')
            await page.evaluate("go('/ext/graph-developer-tools/graphs')")
            await page.wait_for_selector('#ext-page-body article')
            text = await page.locator('#ext-page-body').inner_text()
            assert 'Fetch and store' in text and 'customNodes' in text, text
            report = await page.evaluate("id => PluginStore.storage('graph-developer-tools').get('report:' + id)", 'local')
            assert report['report']['edges'] >= 11, report
            assert len(report['report']['customNodes']) == 6, report
            assert report['report']['disconnected'] == [], report
            selection = await page.evaluate("Extensions.execute('graph-developer-tools:selection', {selected: ['chosen']})")
            assert selection['selection'] == ['chosen'], selection
            await page.evaluate("ids => { const host = document.createElement('div'); host.id = 'cert-inspector'; document.body.append(host); Extensions.renderInspector(host, {node: {id: 'chosen', kind: 'function'}, project: ids.project, workflow: ids.workflow, selection: ['chosen']}); }", graph)
            await page.wait_for_function("document.querySelector('#cert-inspector').innerText.includes('connections')")
            assert 'chosen' in await page.locator('#cert-inspector').inner_text()
            await page.locator('#cert-inspector').evaluate('(host) => host.remove()')
            # Exported packages install in a fresh client. A client without either plugin reads the ordinary graph.
            exported = await page.evaluate("PluginStore.export('graph-developer-tools')")
            other = await browser.new_context()
            other_page = await other.new_page()
            await other_page.goto(client_url)
            await other_page.wait_for_function("Environment.status().status === 'connected'")
            assert await other_page.evaluate('PluginStore.list()') == []
            readable = await other_page.evaluate("ids => api(`projects/${ids.project}/workflow`, {query: {workflow_id: ids.workflow}})", graph)
            assert len(readable['complex']) == 6
            await other_page.evaluate('pkg => Extensions.install(pkg)', exported)
            assert await other_page.evaluate("PluginStore.get('graph-developer-tools').version") == '1.0.0'
            update = dict(exported)
            update['manifest'] = {**exported['manifest'], 'version': '2.0.0', 'capabilities': ['graph.read', 'graph.write']}
            await other_page.evaluate("pkg => reviewPluginPackage(pkg, 'tools-update.json', () => Extensions.update('graph-developer-tools', pkg, {approveCapabilities: true}))", update)
            await other_page.click('#modal button[value=cancel]')
            assert await other_page.evaluate("PluginStore.get('graph-developer-tools').version") == '1.0.0'
            await other.close()
            await page.evaluate("url => Environment.save({id: 'second', name: 'Second', url})", f'http://127.0.0.1:{second_port}')
            await page.evaluate("Environment.setActive('second')")
            await page.wait_for_function("Environment.status().status === 'connected' && Extensions.apiOf('integration-studio') !== null")
            assert await page.evaluate("PluginStore.storage('graph-developer-tools').get('report:local')") is None
            second_deploy = await page.evaluate("Extensions.deploy('integration-studio')")
            assert second_deploy['ok'], second_deploy
            assert http_json(f'http://127.0.0.1:{second_port}', 'GET', 'collections/integration-connections/records')['total'] == 0
            first_ids = {r['id'] for r in http_json(base, 'GET', 'resources') if r['payload'].get('plugin', {}).get('id') == 'integration-studio'}
            second_ids = {r['id'] for r in http_json(f'http://127.0.0.1:{second_port}', 'GET', 'resources') if r['payload'].get('plugin', {}).get('id') == 'integration-studio'}
            assert len(first_ids) == len(second_ids) == 6 and not first_ids.intersection(second_ids)
            await page.evaluate("go('/ext/graph-developer-tools/graphs')")
            await page.wait_for_function("document.querySelector('#ext-page-body')?.innerText.includes('No workflows')")
            await page.evaluate("Environment.setActive('local')")
            await page.wait_for_function("Environment.status().status === 'connected' && Extensions.apiOf('integration-studio') !== null")
            await page.evaluate("go('/ext/graph-developer-tools/graphs')")
            await page.wait_for_function("document.querySelector('#ext-page-body')?.innerText.includes('Fetch and store')")
            await page.wait_for_function("Extensions.diagnostics().pendingRequests === 0 && Extensions.diagnostics().pendingCallbacks === 0")
            print('PASS environments: both products switch servers without leaking reports or connections; deployments use independent IDs', flush=True)
            await page.reload()
            await page.wait_for_function("Extensions.apiOf('graph-developer-tools') !== null && Environment.status().status === 'connected'")
            await page.evaluate("go('/ext/integration-studio/connections')")
            await page.wait_for_selector('#ext-page-body article')
            assert 'Synthetic status' in await page.locator('#ext-page-body').inner_text()
            print('PASS Graph Developer Tools: graph structure, Custom Nodes and report persistence after reload', flush=True)
            session = await context.new_cdp_session(page) if engine == 'chromium' else None
            heap_before = None
            if session:
                await session.send('HeapProfiler.collectGarbage')
                heap_before = (await session.send('Runtime.getHeapUsage'))['usedSize']
            for _ in range(10):
                await page.evaluate("async () => { await Extensions.disable('integration-studio'); await Extensions.disable('graph-developer-tools'); }")
                await page.wait_for_function("async () => (await api('diagnostics')).plugin_sessions === 0")
                assert await page.evaluate("document.querySelectorAll('iframe').length") == 0
                assert await page.evaluate("Extensions.commands().length") == 0
                assert await page.evaluate('messageListenerCount()') == 0
                assert await page.evaluate('Extensions.diagnostics()') == {
                    'sandboxes': 0, 'pendingCallbacks': 0, 'pendingRequests': 0, 'commands': 0, 'contributions': 0}
                await page.evaluate("async () => { await Extensions.enable('integration-studio'); await Extensions.enable('graph-developer-tools'); }")
                assert await page.evaluate("document.querySelectorAll('iframe').length") == 2
                assert await page.evaluate('messageListenerCount()') == 2
            if session:
                await session.send('HeapProfiler.collectGarbage')
                heap_after = (await session.send('Runtime.getHeapUsage'))['usedSize']
                assert heap_after - heap_before < 5_000_000, (heap_before, heap_after)
                print(f'PASS stress heap: before={heap_before}, after={heap_after} bytes after GC', flush=True)
            print('PASS stress: ten cycles return iframe, listener, pending, UI, command and token counts to zero on disable', flush=True)
            starter = json.loads(next((ROOT / 'examples' / 'hello-plugin').glob('*.agentsys-plugin.json')).read_text())
            await page.evaluate('pkg => Extensions.install(pkg)', starter)
            await page.evaluate("go('/ext/hello-agent/home')")
            await page.wait_for_selector('#ext-page-body button[data-command=count]')
            assert 'Hello Agent' in await page.locator('#ext-page-body').inner_text()
            await page.locator('#ext-page-body button[data-command=count]').click()
            await page.wait_for_function("PluginStore.storage('hello-agent').get('count') === 1")
            await page.evaluate("Extensions.uninstall('hello-agent')")
            print('PASS developer quickstart: packaged starter renders and its command persists data', flush=True)
            await context.storage_state(path=str(os.path.join(directory, 'client-state.json')))
            # Closing the context removes every iframe, plugin listener and client event stream.
            await context.close()
            run = http_json(base, 'POST', f"projects/{graph['project']}/execution?workflow_id={graph['workflow']}", {'wait': True})
            assert run['dispatch_status'] == 'completed', run
            assert not run.get('errors'), run
            records = http_json(base, 'GET', 'collections/integration-results/records')
            assert records['total'] == 1, (run, records)
            assert records['records'][0]['data']['result']['ok'] is True, records
            print('PASS headless: configuration -> HTTP -> JSON -> transform -> persist -> display, no client plugin running', flush=True)
            restored = await browser.new_context(storage_state=os.path.join(directory, 'client-state.json'), viewport={'width': 390, 'height': 844})
            page = await restored.new_page()
            await page.goto(client_url)
            await page.wait_for_function("Environment.status().status === 'connected' && Extensions.apiOf('integration-studio') !== null")
            await page.evaluate("go('/ext/integration-studio/connections')")
            await page.wait_for_selector('#ext-page-body pre')
            assert 'received' in await page.locator('#ext-page-body').inner_text()
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile horizontal overflow'
            assert not errors, errors
            print('PASS reconnect: current server result displayed by restored client at mobile width', flush=True)
            await browser.close()
    finally:
        for process in [client, server, second_server]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except Exception:
                    process.kill()
                    process.wait(timeout=5)
        endpoint.shutdown()
        endpoint.server_close()
        shutil.rmtree(directory, ignore_errors=True)
        shutil.rmtree(second_directory, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(main(), timeout=180))
