"""The Plugins page: the bundled plugin is listed and can be turned off and on; the Library gets its node."""
import asyncio
import os
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1300, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(base + '/editor/plugins')
        await page.wait_for_selector('.cards .card')
        card = page.locator('.card').filter(has=page.locator('[data-plugin="hello"]'))
        assert await card.count() == 1
        assert 'Running' in await card.inner_text()
        # The plugin added its node to the Library and its route answers.
        assert await page.evaluate("api('resources').then(items=>items.some(r=>r.name==='Hello'))")
        assert await page.evaluate("api('plugins/hello/greet',{query:{name:'Ann'}}).then(r=>r.text==='Hello, Ann!')")
        # The card opens the plugin's page: state, routes, README.
        await card.locator('a.card-main').click()
        await page.wait_for_selector('h1:has-text("AI")')
        assert await page.locator('h1 use').get_attribute('href') == '#i-sparkles'
        assert await page.locator('.markdown').count() == 1
        text = await page.locator('#view').inner_text()
        assert 'GET' in text and '/api/plugins/hello/greet' in text and 'Running' in text, text
        # Its settings form saves by itself and the plugin reads the value.
        await page.locator('#plugin-settings input[name=greeting]').fill('Hi')
        await page.wait_for_function("api('plugins/hello/greet',{query:{name:'Ann'}}).then(r=>r.text==='Hi, Ann!')")
        await page.evaluate("go('/plugins')")
        await page.wait_for_selector('.cards .card')
        # Off, then on again, from the card's menu.
        card = page.locator('.card').filter(has=page.locator('[data-plugin="hello"]'))
        await card.locator('[data-menu]').click()
        await page.get_by_role('menuitem', name='Turn off', exact=True).click()
        await page.wait_for_function("document.querySelector('.card .card-facts')?.textContent==='Off'")
        assert await page.evaluate("api('plugins').then(l=>!l[0].enabled&&!l[0].running)")
        await page.locator('.card [data-menu]').click()
        await page.get_by_role('menuitem', name='Turn on', exact=True).click()
        await page.wait_for_function("document.querySelector('.card .card-facts')?.textContent==='Running'")
        # Reload from the page menu.
        await page.locator('.page-head [data-menu]').click()
        await page.get_by_role('menuitem', name='Reload plugins', exact=True).click()
        await page.wait_for_selector('.cards .card')
        assert not errors, errors
        await browser.close()
        print('PASS Plugins page lists, turns off and on, and reloads plugins', flush=True)


if __name__ == '__main__':
    with isolated_server() as (base, _):
        asyncio.run(check(base))
