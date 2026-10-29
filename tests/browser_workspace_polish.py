"""First workflow and live monitoring, including preserved form input."""
import asyncio
import os
import time
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(error.stack))
        await page.goto(base + '/editor/')
        await page.locator('[data-example]').click()
        await page.wait_for_selector('#canvas .node')
        ids = await page.evaluate('({project:W.project,workflow:W.workflow})')
        await page.locator('#start').click()
        await page.wait_for_selector('.preview-text:has-text("Hello!")')
        await page.evaluate("go('/')")
        await page.wait_for_selector('.dashboard .data-table')
        await page.evaluate("go('/runs')")
        await page.wait_for_selector('[data-run]')
        # A run started outside the page appears without navigation or a manual refresh.
        run = await page.evaluate("id=>api(`projects/${id}/runs`,{method:'POST',body:{wait:2}})", ids['project'])
        await page.wait_for_selector(f'[data-run="{run["id"]}"][data-status=completed]')
        await page.locator('#runs-filter').select_option('failed')
        await page.wait_for_selector('.runs-empty:has-text("No matching runs")')
        await page.locator('#runs-clear').click()
        await page.wait_for_selector('[data-run]')
        await page.get_by_role('link', name='Workflows', exact=True).click()
        await page.locator('.workflow-policy-details summary').click()
        field = page.locator('[name=max_attempts]')
        await field.fill('7')
        await page.evaluate("id=>api(`projects/${id}/runs`,{method:'POST',body:{wait:2}})", ids['project'])
        await page.wait_for_timeout(3500)
        assert await field.input_value() == '7'
        await page.get_by_role('button', name='Save policy', exact=True).click()
        await page.wait_for_timeout(200)
        assert await page.evaluate("id=>api(`workflows/${id}/control`).then(c=>c.max_attempts)", ids['workflow']) == 7
        await page.locator('[name=quotas]').fill('{')
        await page.evaluate("void go('/')")
        await page.wait_for_selector('#modal[open]')
        assert await page.evaluate('app.route.page') == 'runs'
        await page.locator('#modal').get_by_role('button', name='Cancel', exact=True).click()
        await page.locator('[name=quotas]').fill('[]')
        await page.evaluate("go('/')")
        await page.wait_for_selector('.dashboard')
        # Server-side errors are visible, then the same mounted page recovers.
        await page.route('**/api/runs/overview*', lambda route: route.fulfill(status=503, content_type='application/json', body='{"error":{"message":"Offline"}}'))
        await page.wait_for_selector('[data-live-status]:has-text("retrying")', timeout=10000)
        await page.unroute('**/api/runs/overview*')
        await page.wait_for_function("document.querySelector('[data-live-status]')?.textContent==='Live'", timeout=10000)
        # History and filters must reach records beyond the first page.
        rows = [{'id': f'old-{i:04}', 'project_id': ids['project'], 'workflow_id': ids['workflow'],
                 'started': time.time()-100-i, 'finished': time.time()-90-i,
                 'status': 'failed' if i == 79 else 'completed', 'details_available': False}
                for i in range(80)]
        response = await page.request.post(base + '/__data', headers={'X-AgentSys':'1'}, data={'set':{'run_summaries':rows}})
        assert response.ok
        await page.evaluate("go('/runs')")
        await page.wait_for_selector('[data-run]')
        assert await page.locator('[data-run]').count() == 50
        first = set(await page.locator('[data-run]').evaluate_all('rows=>rows.map(r=>r.dataset.run)'))
        await page.locator('#runs-next').click()
        await page.wait_for_function("document.querySelectorAll('[data-run]').length<50")
        second = set(await page.locator('[data-run]').evaluate_all('rows=>rows.map(r=>r.dataset.run)'))
        assert not first.intersection(second)
        await page.locator('#runs-filter').select_option('failed')
        await page.wait_for_selector('[data-run="old-0079"]')
        assert await page.locator('[data-run]').count() == 1
        assert 'status=failed' in page.url
        await page.reload()
        await page.wait_for_selector('[data-run="old-0079"]')
        assert await page.locator('#runs-filter').input_value() == 'failed'
        assert await page.locator('[data-run]').count() == 1
        await page.locator('#runs-clear').click()
        for width in (390, 320):
            await page.set_viewport_size({'width': width, 'height': 844})
            for path in ('/', '/runs'):
                await page.evaluate('path=>go(path)', path)
                assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors, errors
        await browser.close()
        print('PASS starter workflow, live run list, filters, preserved forms, reconnection and mobile layouts')


if __name__ == '__main__':
    with isolated_server() as (base, _):
        asyncio.run(check(base))
