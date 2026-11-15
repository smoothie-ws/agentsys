"""Interface checks on real pages: empty states, an unreachable server, keyboard access, narrow screens and
screenshots for comparison. Starts its own server and client on free ports; no project data is reused.
"""
import asyncio
import os
import sys
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
import urllib.request

from playwright.async_api import async_playwright, Error as PlaywrightError

ROOT = Path(__file__).resolve().parents[1]
EXE = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
BROWSER = sys.argv[1] if len(sys.argv) > 1 else 'chromium'
SHOT_SUFFIX = '' if BROWSER == 'chromium' else '-' + BROWSER
SHOTS = Path(os.environ.get('AGENTSYS_UI_ARTIFACTS', str(ROOT / 'node_modules' / '.cache' / 'ui-review')))


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
            browser = await getattr(playwright, BROWSER).launch(
                **({'executable_path': EXE} if BROWSER == 'chromium' and EXE else {})
            )
            native_beforeunload = True
            if BROWSER == 'firefox':
                # Probe the browser independently of AgentSys. Some Windows headless Firefox builds suppress
                # native unload dialogs even with user activation and a cancelling handler on an empty page.
                probe_context = await browser.new_context()
                probe = await probe_context.new_page()
                await probe.route('http://unload.test/', lambda route: route.fulfill(
                    body='<button>Activate</button>', content_type='text/html'))
                await probe.goto('http://unload.test/')
                await probe.click('button')
                await probe.evaluate("addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = 'Unsaved'; })")
                probe_dialogs = []

                async def probe_dialog(dialog):
                    probe_dialogs.append(dialog.type)
                    await dialog.accept()

                probe.on('dialog', probe_dialog)
                async with probe.expect_event('close'):
                    await probe.close(run_before_unload=True)
                native_beforeunload = 'beforeunload' in probe_dialogs
                await probe_context.close()
                if not native_beforeunload:
                    print('SKIP native unload prompt: this Firefox build also suppresses it on an independent empty page; app handler remains asserted', flush=True)
            # Browser.new_page owns a private context and Page.close closes that context immediately after
            # requesting beforeunload. That can dispose the dialog before its async handler answers it.
            # Keep context disposal separate from the user-close path we are testing.
            context = await browser.new_context(viewport={'width': 1440, 'height': 900})
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://127.0.0.1:{client_port}/')
            await page.wait_for_function("Environment && Environment.status().status === 'connected'")
            await page.wait_for_selector('.page.dashboard')
            await page.screenshot(path=str(SHOTS / f'dashboard-desktop{SHOT_SUFFIX}.jpg'), type='jpeg', quality=72)
            print(f'PASS the dashboard renders at 1440x900 ({BROWSER})', flush=True)

            # Empty states are explicit, not a blank page.
            await page.goto(f'http://127.0.0.1:{client_port}/#/projects')
            await page.wait_for_selector('h1:has-text("Projects")')
            empty = await page.locator('.empty').first.inner_text()
            assert 'project' in empty.lower(), empty
            await page.screenshot(path=str(SHOTS / f'projects-empty{SHOT_SUFFIX}.jpg'), type='jpeg', quality=72)
            await page.goto(f'http://127.0.0.1:{client_port}/#/plugins')
            await page.wait_for_selector('h1:has-text("Plugins")')
            assert 'No client plugins' in await page.locator('#view').inner_text()
            print('PASS empty states name what is missing (projects, plugins)', flush=True)

            # Every main page loads without a page error and without a horizontal scrollbar.
            for route, heading in [
                ('library', 'Library'),
                ('environments', 'Server'),
                ('settings', 'Settings'),
                ('api', 'API'),
            ]:
                await check_page(page, route, heading)
            print('PASS the main pages render at 1440x900 without horizontal overflow', flush=True)

            # Accessibility basics on every main page: one h1, and no interactive control without a name.
            unnamed = []
            for route, heading in [
                ('', 'Dashboard'),
                ('projects', 'Projects'),
                ('library', 'Library'),
                ('environments', 'Server'),
                ('plugins', 'Plugins'),
                ('settings', 'Settings'),
                ('api', 'API'),
            ]:
                await page.goto(f'http://127.0.0.1:{client_port}/#/{route}' if route else f'http://127.0.0.1:{client_port}/#/')
                await page.wait_for_selector(f'h1:has-text("{heading}")')
                found = await page.evaluate(
                    """() => ({
                      h1: document.querySelectorAll('#view .page h1').length,
                      empty: [...document.querySelectorAll('#view button, #view a[href]')]
                        .filter(el => !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.disabled)
                        .map(el => el.outerHTML.slice(0, 140)),
                    })"""
                )
                assert found['h1'] == 1, f'{route or "dashboard"} has {found["h1"]} h1 elements'
                unnamed.extend(f'{route}: {item}' for item in found['empty'])
            assert not unnamed, unnamed
            print('PASS every main page has one heading and no interactive control without a name', flush=True)

            async def slow_projects(route):
                await asyncio.sleep(0.3)
                await route.continue_()

            await page.route('**/api/projects', slow_projects)
            await page.evaluate("void go('/projects')")
            await page.wait_for_function("document.querySelector('#view').getAttribute('aria-busy') === 'true'")
            assert await page.evaluate("document.querySelector('#view').inert")
            await page.evaluate("go('/environments')")
            await page.wait_for_timeout(450)
            assert 'Servers' in await page.locator('#view h1').inner_text()
            assert await page.evaluate("!document.querySelector('#view').inert && !document.querySelector('#view').hasAttribute('aria-busy')")
            await page.unroute('**/api/projects', slow_projects)
            print('PASS slow navigation exposes a busy state and cannot overwrite a newer page', flush=True)

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
            await page.wait_for_selector('h1:has-text("Server")')
            status = await page.locator('[data-env-row]', has_text='Closed port').locator('.environment-status').inner_text()
            assert status in {'Disconnected', 'Connection error'}, status
            closed_card = page.locator('[data-env-row]', has_text='Closed port')
            await closed_card.locator('[data-menu]').click()
            labels = await page.locator('.popup [role=menuitem]').all_text_contents()
            assert any(label.startswith('Reconnect') or label.startswith('Use this server') for label in labels), labels
            assert any(label.startswith('Remove server') for label in labels), labels
            await page.keyboard.press('Escape')
            await page.screenshot(path=str(SHOTS / f'environments-disconnected{SHOT_SUFFIX}.jpg'), type='jpeg', quality=72)
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

            # Servers: remove the saved unreachable server through its row, leaving the real one.
            await page.goto(f'http://127.0.0.1:{client_port}/#/environments')
            await page.wait_for_selector('h1:has-text("Server")')
            closed = page.locator('[data-env-row]', has_text='Closed port')
            await closed.locator('[data-menu]').click()
            await page.get_by_role('menuitem', name='Remove server…', exact=True).click()
            await page.wait_for_selector('#modal[open]')
            await page.click('#modal button[value=ok]')
            await page.wait_for_function(
                "[...document.querySelectorAll('[data-env-row]')].every(row => !row.innerText.includes('Closed port'))"
            )
            names = await page.evaluate("Environment.list().map(env => env.name)")
            assert names == ['Local Server'], names
            print('PASS a server is removed through its row and only the real one remains', flush=True)

            # Keyboard: Ctrl+K opens search, typing filters, Escape closes it, focus is not left behind.
            await page.goto(f'http://127.0.0.1:{client_port}/#/')
            await page.wait_for_selector('.page.dashboard')
            await page.keyboard.press('Control+k')
            await page.wait_for_selector('#modal[open] #search-input')
            await page.keyboard.type('Serv')
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
            await page.screenshot(path=str(SHOTS / f'dashboard-mobile{SHOT_SUFFIX}.jpg'), type='jpeg', quality=72)
            print('PASS the phone layout uses its own navigation and closes it with Escape', flush=True)

            # A browser navigation with an unsaved autosave form asks before dropping the text. A clean page
            # leaves without a dialog (tested by every other navigation above).
            await page.goto(f'http://127.0.0.1:{client_port}/#/settings')
            await page.wait_for_selector('#settings-form input[name=undo_steps]')
            save_started = asyncio.Event()
            release_save = asyncio.Event()
            async def delayed_save(route):
                if route.request.method == 'PUT':
                    save_started.set()
                    await release_save.wait()
                try:
                    await route.continue_()
                except PlaywrightError:
                    # A confirmed reload cancels the pending request, which is the condition under test.
                    pass

            await page.route('**/api/settings', delayed_save)
            # Firefox requires sticky user activation before showing beforeunload. fill() alone may only
            # synthesize input; a real click models the user editing the form without weakening the assertion.
            await page.click('#settings-form input[name=undo_steps]')
            await page.fill('#settings-form input[name=undo_steps]', '41')
            await asyncio.wait_for(save_started.wait(), timeout=10)
            dialogs = []

            async def on_dialog(dialog):
                dialogs.append(dialog.type)
                await dialog.accept()

            page.on('dialog', on_dialog)
            dirty = await page.evaluate("() => !!(app.pageSave && app.pageSave.element.isConnected && app.pageSave.isDirty())")
            assert dirty, 'the edited form reports unsaved changes'
            assert await page.evaluate("""() => {
                const event = new Event('beforeunload', {cancelable: true});
                window.dispatchEvent(event);
                return event.defaultPrevented;
            }"""), 'the real application handler must cancel unloading a dirty form'
            # Explicitly request the user-close path with beforeunload processing.
            try:
                async with page.expect_event('close'):
                    await page.close(run_before_unload=True)
            finally:
                release_save.set()
            if native_beforeunload:
                assert 'beforeunload' in dialogs, dialogs
            page = await context.new_page()
            await page.set_viewport_size({'width': 390, 'height': 844})
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://127.0.0.1:{client_port}/#/settings')
            await page.wait_for_selector('#settings-form input[name=undo_steps]')
            print('PASS an unsaved settings change cancels unload' + (' and shows native confirmation' if native_beforeunload else ' (native prompt unsupported by this Firefox build)'), flush=True)

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

            # WebKit reports a cross-origin fetch to an unreachable server as "due to access control
            # checks"; that is the expected state of the deliberately closed environment, not a page error.
            real_errors = [error for error in errors if 'due to access control checks' not in error]
            assert not real_errors, real_errors
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
