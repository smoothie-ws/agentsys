"""UI audit regressions. Run against a static server: python tests/browser_ui.py <port>."""
import base64
import asyncio
import os
import sys
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(f'http://127.0.0.1:{sys.argv[1]}/index.html#/settings')
        await page.wait_for_selector('#subnav .subnav-row.active')
        await page.evaluate("""() => {
          applyStyle({...THEMES.Dark, animations:false});
          document.querySelector('#view').replaceChildren();
          document.body.style.setProperty('--noise', 'none');
          document.body.style.setProperty('--glow', 'none');
        }""")
        # Actual painted receiving fields stay identical, measured relative to the seam.
        for variable, receiver in [('--sidebar-width', '#subnav'), ('--subnav-width', 'main')]:
            cover = await page.add_style_tag(content=f'{receiver} > :not(.nav-seam) {{ visibility:hidden }}')
            images = []
            for width in (180, 300, 420):
                await page.evaluate('([v,w]) => document.body.style.setProperty(v,w+"px")', [variable, width])
                await page.wait_for_timeout(100)
                box = await page.locator(receiver).bounding_box()
                images.append(await page.screenshot(clip={'x': box['x'] + 2, 'y': 180, 'width': 150, 'height': 250}))
            delta = await page.evaluate("""async images => {
              const pixels = await Promise.all(images.map(async data => {
                const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
                const canvas = document.createElement('canvas'); canvas.width=img.width; canvas.height=img.height;
                const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
                return ctx.getImageData(0,0,img.width,img.height).data;
              }));
              return pixels.slice(1).reduce((max, data) => data.reduce((m,v,i) => Math.max(m,Math.abs(v-pixels[0][i])),max),0);
            }""", [base64.b64encode(image).decode() for image in images])
            assert delta <= 2, f'Glow stretches with {variable}: {delta}'
            await cover.evaluate('(el) => el.remove()')
        print('PASS painted glow stays identical at three panel widths')

        handle = page.locator('#subnav > .panel-resize')
        await handle.focus()
        await page.keyboard.press('Home')
        assert await page.evaluate("document.body.classList.contains('subnav-collapsed')")
        await page.keyboard.press('End')
        assert not await page.evaluate("document.body.classList.contains('subnav-collapsed')")
        await page.keyboard.press('Home')
        await page.keyboard.press('ArrowRight')
        assert not await page.evaluate("document.body.classList.contains('subnav-collapsed')")
        print('PASS keyboard can reopen a collapsed panel')

        await page.evaluate("popup(300,200,[['Group',null,{search:true,children:[['First',()=>{}],['Last',()=>{}]]}]])")
        await page.keyboard.press('ArrowRight')
        field = page.locator('.submenu input')
        await field.focus()
        await page.keyboard.press('ArrowUp')
        assert await page.evaluate("document.activeElement.textContent === 'Last'")
        await page.keyboard.press('ArrowLeft')
        assert await page.locator('.submenu').count() == 0
        assert await page.evaluate("document.activeElement.textContent === 'Group'")
        await page.evaluate("popup(300,200,[['Disabled',null,{disabled:true,children:[['Child',()=>{}]]}]])")
        await page.locator('.popup button').hover()
        assert await page.locator('.submenu').count() == 0
        await page.evaluate('closePopup(true)')
        print('PASS searchable submenu keyboard navigation and disabled groups')

        # Hold the old search response until the next query has entered its debounce period.
        await page.evaluate("""() => {
          window.originalApi = api;
          api = (path, options) => path === 'search/nodes'
            ? new Promise(resolve => { window.releaseSearch = () => resolve({nodes:[{
                project_id:'old', workflow_id:'old', id:'old', label:'STALE RESULT',
                project_name:'Old', workflow_name:'Old'}]}); })
            : originalApi(path, options);
          openSearch();
        }""")
        await page.fill('#search-input', 'old')
        await page.wait_for_function('typeof releaseSearch === "function"')
        await page.evaluate("""async () => {
          const input = document.querySelector('#search-input');
          input.value = 'new'; input.dispatchEvent(new Event('input'));
          releaseSearch(); await new Promise(resolve => setTimeout(resolve, 0));
        }""")
        assert 'STALE RESULT' not in await page.locator('#search-results').inner_text()
        await page.evaluate('() => { api = originalApi; }')
        await page.keyboard.press('Escape')
        print('PASS old search response is discarded during debounce')

        await page.evaluate("dialog('Submit', '<input name=title value=test>', () => true); document.querySelector('#modal-form').requestSubmit()")
        await page.wait_for_selector('#modal', state='hidden')
        print('PASS form submission without a submitter')

        await page.evaluate("""async () => {
          const project = await api('projects', {method:'POST',body:{name:'Reload regression'}});
          await go(`/p/${project.id}/w/${project.id}`);
          window.originalDraw = draw; window.lateDraws = 0;
          draw = () => { lateDraws++; originalDraw(); };
          scheduleReload(150);
          await go('/settings');
        }""")
        await page.wait_for_timeout(400)
        assert await page.evaluate('lateDraws') == 0
        await page.evaluate('() => { draw = originalDraw; }')
        print('PASS leaving a workflow cancels its scheduled redraw')
        # A paused run shows its running nodes as paused (with the pause icon), and as running again after Resume.
        await page.evaluate("""async () => {
          const project = await api('projects', {method: 'POST', body: {name: 'Paused status'}});
          await go(`/p/${project.id}/w/${project.id}`);
        }""")
        await page.wait_for_selector('#canvas')
        await page.evaluate("""async () => {
          const node = await api(`projects/${W.project}/primitives`, {method: 'POST', body: {workflow_id: W.workflow, primitive: 'script', point: {x: 0, y: 0}}});
          await reload();
          W.nodes.get(node.id).status = 'running';
          W.runPaused = true;
          window.pausedNode = node.id;
          draw();
        }""")
        assert await page.evaluate("document.querySelector(`[data-id=\"${pausedNode}\"] .run-state.paused svg`) !== null")
        assert await page.evaluate("document.querySelector(`[data-id=\"${pausedNode}\"]`).classList.contains('s-paused')")
        await page.evaluate("() => { W.runPaused = false; draw(); }")
        assert await page.evaluate("document.querySelector(`[data-id=\"${pausedNode}\"] .run-state.running`) !== null")
        await page.evaluate("() => { W.nodes.get(pausedNode).status = 'ready'; }")
        print('PASS a paused run shows its running nodes as paused')
        assert not errors, errors
        await browser.close()


asyncio.run(main())
