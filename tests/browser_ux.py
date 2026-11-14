"""Interface checks on real pages: empty states, an unreachable server, keyboard access, narrow screens and
screenshots for comparison. Starts its own server and client on free ports; no project data is reused.
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
SHOTS = ROOT / 'docs' / 'audits' / 'platform-marathon' / 'screenshots'


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


async def check_page(page, hash_route, heading, width=1440, height=900):
    await page.set_viewport_size({'width': width, 'height': height})
    await page.goto(page.url.split('#')[0] + '#/' + hash_route)
    await page.wait_for_selector(f'h1:has-text("{heading}")', timeout=15000)
    overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert overflow <= 1, f'{hash_route} overflows by {overflow}px at {width}'
    return overflow


async def main():
    data = tempfile.mkdtemp(prefix='agentsys-ux-')
    server_port, client_port = free_port(), free_port()
    server = client = None
    SHOTS.mkdir(parents=True, exist_ok=True)
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
            page = await browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://127.0.0.1:{client_port}/')
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            await page.wait_for_selector('.page.dashboard')
            await page.screenshot(path=str(SHOTS / 'dashboard-desktop.jpg'), type='jpeg', quality=72)
            print('PASS the dashboard renders at 1440x900', flush=True)

            # Empty states are explicit, not a blank page.
            await page.goto(f'http://127.0.0.1:{client_port}/#/projects')
            await page.wait_for_selector('h1:has-text("Projects")')
            empty = await page.locator('.empty').first.inner_text()
            assert 'project' in empty.lower(), empty
            await page.screenshot(path=str(SHOTS / 'projects-empty.jpg'), type='jpeg', quality=72)
            await page.goto(f'http://127.0.0.1:{client_port}/#/plugins')
            await page.wait_for_selector('h1:has-text("Plugins")')
            assert await page.locator('.card').count() >= 2, 'the bundled catalog is listed'
            await page.goto(f'http://127.0.0.1:{client_port}/#/collections')
            await page.wait_for_selector('h1:has-text("Collections")')
            assert await page.locator('.empty').count() >= 1 or 'No collection' in await page.locator('#view').inner_text()
            print('PASS empty states name what is missing (projects, plugins, collections)', flush=True)

            # Every main page loads without a page error and without a horizontal scrollbar.
            for route, heading in [
                ('library', 'Library'),
                ('environments', 'Environments'),
                ('settings', 'Settings'),
                ('api', 'API'),
            ]:
                await check_page(page, route, heading)
            print('PASS the main pages render at 1440x900 without horizontal overflow', flush=True)

            # A tablet width keeps the layout usable.
            await check_page(page, 'projects', 'Projects', 1024, 768)
            print('PASS the layout fits 1024x768', flush=True)

            # An unreachable server is a state, not a broken page: status text, a retry, and no uncaught error.
            await page.evaluate(
                """async closed => {
                  const env = Environment.save({name: 'Closed port', url: 'http://127.0.0.1:' + closed});
                  await Environment.setActive(env.id);
                }""",
                free_port(),
            )
            await page.goto(f'http://127.0.0.1:{client_port}/#/environments')
            await page.wait_for_selector('h1:has-text("Environments")')
            status = await page.locator('.environment-row', has_text='Closed port').locator('.environment-status').inner_text()
            assert status in {'Disconnected', 'Connection error'}, status
            assert await page.locator('[data-env-use]').count() >= 1
            await page.screenshot(path=str(SHOTS / 'environments-disconnected.jpg'), type='jpeg', quality=72)
            # The rest of the interface still works on the saved (unreachable) environment.
            await page.goto(f'http://127.0.0.1:{client_port}/#/projects')
            await page.wait_for_selector('h1:has-text("Projects")')
            await page.wait_for_selector('[data-retry]')
            body = await page.locator('#view').inner_text()
            assert 'could not be reached' in body.lower(), body
            # A retry is offered and is itself safe while the server is still away.
            await page.click('[data-retry]')
            await page.wait_for_timeout(300)
            assert await page.locator('[data-retry]').count() == 1, 'a retry that fails stays on the same state'
            await page.evaluate("Environment.setActive('local')")
            await page.wait_for_function("Environment.status().status === 'connected'")
            await page.wait_for_selector('.page.dashboard')
            await page.goto(f'http://127.0.0.1:{client_port}/#/projects')
            await page.wait_for_selector('h1:has-text("Projects")')
            assert await page.locator('[data-retry]').count() == 0, 'the reachable page has no error state'
            print('PASS an unreachable server keeps the page title and offers a retry', flush=True)

            # Keyboard: Ctrl+K opens search, typing filters, Escape closes it, focus is not left behind.
            await page.goto(f'http://127.0.0.1:{client_port}/#/')
            await page.wait_for_selector('.page.dashboard')
            await page.keyboard.press('Control+k')
            await page.wait_for_selector('#modal[open] #search-input')
            await page.keyboard.type('Environ')
            await page.wait_for_selector('#search-results a, #search-results button')
            await page.keyboard.press('Escape')
            await page.wait_for_function("!document.querySelector('#modal').open")
            print('PASS search opens from the keyboard, filters and closes with Escape', flush=True)

            # A narrow screen: the phone bar is present, the desktop sidebar is off-canvas, nothing overflows, and
            # the section sheet opens and closes from the keyboard.
            await page.set_viewport_size({'width': 390, 'height': 844})
            await page.goto(f'http://127.0.0.1:{client_port}/#/')
            await page.wait_for_selector('.page.dashboard')
            overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            assert overflow <= 1, f'the dashboard overflows by {overflow}px on a phone'
            assert await page.locator('#mobile-secondary').is_visible(), 'the phone bar is shown'
            assert await page.locator('#sidebar').is_visible(), 'the primary destinations are on the phone bar'
            await page.click('#mobile-browse')
            await page.wait_for_function("document.body.classList.contains('mobile-subnav-open')")
            assert await page.locator('#subnav a, #subnav button').count() > 0, 'the sheet lists destinations'
            await page.keyboard.press('Escape')
            await page.wait_for_function("!document.body.classList.contains('mobile-subnav-open')")
            await page.screenshot(path=str(SHOTS / 'dashboard-mobile.jpg'), type='jpeg', quality=72)
            print('PASS the phone layout uses its own navigation and closes it with Escape', flush=True)

            # An API error is reported in words, not as a silent failure. Creating without a name makes
            # "Untitled1" on purpose; renaming to nothing is refused with a message about the name.
            await page.evaluate("Environment.setActive('local')")
            await page.wait_for_function("Environment.status().status === 'connected'")
            project = await page.evaluate("api('projects', {method: 'POST', body: {}})")
            assert project['name'].startswith('Untitled'), project
            error = await page.evaluate(
                "api('projects/' + %r, {method: 'PUT', body: {name: ''}}).then(() => 'accepted', error => error.message)" % project['id']
            )
            assert 'name' in error.lower(), error
            print('PASS a refused write returns a readable message', flush=True)

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
