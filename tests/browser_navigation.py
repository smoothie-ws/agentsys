"""Navigation regressions. Serve the app, then: python tests/browser_navigation.py <port>."""
import asyncio
import base64
import os
import sys
from playwright.async_api import async_playwright

URL = f'http://127.0.0.1:{sys.argv[1]}/index.html'


async def joined_colours(page):
    """Compare actual pixels on either side of the two left panel boundaries."""
    png = base64.b64encode(await page.screenshot()).decode()
    return await page.evaluate("""async png => {
      const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return ['#sidebar > .nav-pill', '#subnav-body > .nav-pill'].every(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        const x = Math.round(r.right), y = Math.round(r.top + r.height / 2);
        const a = ctx.getImageData(x - 1, y, 1, 1).data, b = ctx.getImageData(x, y, 1, 1).data;
        return [0, 1, 2].every(c => Math.abs(a[c] - b[c]) <= 2);
      });
    }""", png)


async def resizing(page, pill, target, double=False, animated=True):
    await page.evaluate("""selector => {
      window.resizeSamples = [];
      const pill = document.querySelector(selector), until = performance.now() + 550;
      const sample = () => {
        resizeSamples.push([pill.getBoundingClientRect().width, getComputedStyle(pill).backgroundImage]);
        if (performance.now() < until) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }""", pill)
    if double:
        await page.dblclick(target)
    else:
        await page.click(target)
    await page.wait_for_timeout(650)
    samples = await page.evaluate('resizeSamples')
    assert all('linear-gradient' in s[1] for s in samples), 'Selection gradient must stay linear during resize'
    if animated:
        assert len({round(s[0], 1) for s in samples}) > 4, samples
    assert await joined_colours(page), f'Visible colour break after resizing {pill}'
    assert await page.evaluate("""() => {
      const r = document.querySelector('#open-search').getBoundingClientRect();
      return Math.abs(innerWidth - r.right - 9.6) < 1 && r.left > innerWidth / 2;
    }"""), 'Search moved away from the upper right'


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        # The removed browser-only setting must not override Effects, including after a reload.
        await page.add_init_script("localStorage.setItem('agentsys-nav-joined', 'false')")
        await page.goto(URL + '#/settings')
        await page.wait_for_selector('#settings-form')
        await page.click('#subnav [role=tab]:nth-child(2)')
        assert await page.locator('[name=nav_joined]').count() == 0
        assert await page.evaluate("document.body.classList.contains('nav-joined')")
        for enabled in (False, True):
            await page.locator('[name=effects]').set_checked(enabled)
            await page.wait_for_function(f"app.preferences.style?.effects === {str(enabled).lower()}")
            await page.reload()
            await page.wait_for_selector('#settings-form')
            assert await page.evaluate("document.body.classList.contains('nav-joined')") == enabled
            assert await page.locator('[name=effects]').is_checked() == enabled
        print('PASS Effects controls connected navigation and persists after reload; separate checkbox removed')
        await page.click('#open-search')
        await page.wait_for_selector('#search-input')
        await page.keyboard.press('Escape')
        await page.wait_for_selector('#modal', state='hidden')
        print('PASS right-aligned search opens from its button')

        await page.goto(URL + '#/settings')
        await page.wait_for_selector('#subnav .subnav-row.active')
        await page.evaluate('applyStyle(THEMES.Dark)')
        for _ in range(2):
            await resizing(page, '#sidebar > .nav-pill', '#sidebar > .panel-resize', double=True)
        print('PASS sidebar gradient updates throughout collapse and expansion')
        for _ in range(2):
            await resizing(page, '#subnav-body > .nav-pill', '#subnav > .panel-resize', double=True)
        print('PASS second-panel gradient updates throughout collapse and expansion')
        await page.evaluate('applyStyle({...THEMES.Dark, animations:false})')
        for _ in range(2):
            await resizing(page, '#sidebar > .nav-pill', '#sidebar > .panel-resize', double=True, animated=False)
        print('PASS gradient updates with animations disabled; search stays at the right')

        # Isolate the page background from cards and text while keeping the real shell and CSS.
        await page.evaluate("document.querySelector('#view').replaceChildren(); applyStyle(THEMES.Graphite)")
        await page.mouse.move(1000, 500)
        await page.wait_for_timeout(400)
        before = await page.screenshot(clip={'x': 1200, 'y': 300, 'width': 150, 'height': 400})
        await page.evaluate('applyNavJoined(false)')
        await page.wait_for_timeout(400)
        after = await page.screenshot(clip={'x': 1200, 'y': 300, 'width': 150, 'height': 400})
        assert before == after, 'Connected navigation repaints the content background'
        await page.evaluate('applyNavJoined(true)')
        await page.wait_for_timeout(100)
        assert await page.evaluate("""() => {
          const seam = document.querySelector('main > .nav-seam');
          const row = document.querySelector('#subnav-body > .nav-pill').getBoundingClientRect();
          const field = seam.getBoundingClientRect();
          const host=seam.parentElement.getBoundingClientRect();
          return Math.abs(field.top-host.top)<1 && Math.abs(field.height-host.height)<1 && getComputedStyle(seam).maskImage==='none';
        }"""), 'Linear content gradient must cover the panel height'
        print('PASS content background unchanged; linear gradient covers the panel height')
        assert not errors, errors
        print('PASS no browser errors')
        await browser.close()


asyncio.run(main())
