"""The workflow editor through its own controls: add nodes from the Add menu, undo and redo from the toolbar,
delete a selected node from the keyboard, and find the same graph after a reload. Starts its own server and client.
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
    data = tempfile.mkdtemp(prefix='agentsys-editor-')
    server_port, client_port = free_port(), free_port()
    server = client = None
    base = f'http://127.0.0.1:{client_port}'
    try:
        server = start([
            'bin/agentsys-server.js', 'start', '--port', str(server_port), '--data', data,
            '--allowed-origin', f'http://127.0.0.1:{client_port}', '--quiet',
        ])
        client = start([
            'bin/agentsys-client.js', '--port', str(client_port), '--server', f'http://127.0.0.1:{server_port}',
        ])
        wait_http(f'http://127.0.0.1:{server_port}/api/meta')
        wait_http(base + '/')

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path=EXE)
            page = await browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(base + '/')
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            project = await page.evaluate("api('projects', {method: 'POST', body: {name: 'Editor UI'}})")
            await page.goto(f'{base}/#/p/{project["id"]}/w/{project["id"]}')
            await page.wait_for_selector('#canvas')
            await page.wait_for_selector('.canvas-tools [data-empty-add]')
            assert await page.locator('.node').count() == 0

            # Add an Event from the Add menu: the route that used to be outside the undo set.
            await page.click('.canvas-tools [data-empty-add]')
            await page.wait_for_selector('.popup [role=menuitem]:has-text("Event")')
            await page.click('.popup [role=menuitem]:has-text("Event")')
            await page.wait_for_function("document.querySelectorAll('.node').length === 1")
            print('PASS a node is added from the Add menu', flush=True)

            await page.click('#undo')
            await page.wait_for_function("document.querySelectorAll('.node').length === 0")
            print('PASS undo from the toolbar removes a node added through the menu', flush=True)
            await page.click('#redo')
            await page.wait_for_function("document.querySelectorAll('.node').length === 1")
            print('PASS redo brings it back', flush=True)

            # Add a Script, select it, delete it with the keyboard and bring it back with undo.
            await page.click('.canvas-tools [data-empty-add]')
            await page.wait_for_selector('.popup [role=menuitem]:has-text("Script")')
            await page.click('.popup [role=menuitem]:has-text("Script")')
            await page.wait_for_function("document.querySelectorAll('.node').length === 2")
            script_id = await page.evaluate(
                "W.snapshot.nodes.find(node => node.config && node.config.op === 'script').id"
            )
            await page.click(f'.node[data-id="{script_id}"]')
            await page.keyboard.press('Delete')
            await page.wait_for_function("document.querySelectorAll('.node').length === 1")
            await page.click('#undo')
            await page.wait_for_function("document.querySelectorAll('.node').length === 2")
            print('PASS a node is deleted with the keyboard and restored with undo', flush=True)

            # The graph the canvas shows is the graph the server stored.
            await page.reload()
            await page.wait_for_selector('#canvas')
            await page.wait_for_function("document.querySelectorAll('.node').length === 2")
            stored = await page.evaluate("api(`projects/${W.project}/workflow`, {query: {workflow_id: W.project}})")
            assert len(stored['nodes']) == 2, stored['nodes']
            print('PASS the edited graph is stored and comes back after a reload', flush=True)

            # Run from the toolbar: wire the two nodes and give the Script code through the API, reload the
            # canvas, then use the Run button and look at the display the Script produced.
            event_id = await page.evaluate(
                "W.snapshot.nodes.find(node => node.config && node.config.op === 'on_run').id"
            )
            await page.evaluate(
                """async ids => {
                  const {project, workflow, script, event} = ids;
                  await api(`projects/${project}/input-values`, {
                    method: 'PUT',
                    body: {workflow_id: workflow, node_id: script, values: {script: 'node.display("ran from the UI");'}},
                  });
                  await api(`projects/${project}/port-connections`, {
                    method: 'POST',
                    body: {workflow_id: workflow, add: [{source: event, source_port: 'out', target: script, target_port: 'in'}]},
                  });
                }""",
                {'project': project['id'], 'workflow': project['id'], 'script': script_id, 'event': event_id},
            )
            await page.reload()
            await page.wait_for_selector('#canvas')
            await page.wait_for_function("document.querySelectorAll('.node').length === 2")
            await page.click('#start')
            await page.wait_for_function(f"W.results.get('{script_id}')?.text === 'ran from the UI'", timeout=15000)
            print('PASS Run from the toolbar executes the edited graph and shows the display', flush=True)

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
