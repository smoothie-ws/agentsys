"""Workspace layout, stable field sizes, case-sensitive port labels and built-in AI pages."""
import asyncio
import os
from pathlib import Path
import tempfile
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard-metrics')
        assert await page.locator('.dashboard-metrics .tile').count() == 2
        await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(s=>app.preferences=s)")
        ids = await page.evaluate("""async () => {
          const project = await api('projects',{method:'POST',body:{name:'Layout checks'}});
          const delay = app.resources.find(r => r.name === 'Delay');
          await go(`/p/${project.id}/w/${project.id}`);
          await api(`projects/${project.id}/custom-nodes/${delay.id}`,{method:'POST',body:{point:{x:0,y:0}}});
          await reload(); select(['complex:'+W.snapshot.complex.find(c=>c.source).id]);
          return {project:project.id, delay:delay.id};
        }""")
        await page.wait_for_selector('.permission-table')
        assert 'Permissions are limited by the parent node.' in await page.locator('[data-grants]').inner_text()
        await page.locator('[data-side-tab=workflow]').click()
        assert await page.locator('[data-side-tab=nodes]').count() == 0
        assert await page.locator('#side-workflow [data-available-nodes]').is_visible()
        assert await page.locator('.available-group summary small').count() == 0
        group = page.locator('.available-group').first
        before = await group.locator('summary').evaluate('e=>getComputedStyle(e).color')
        await group.evaluate('e=>e.open=false')
        assert await group.locator('summary').evaluate('e=>getComputedStyle(e).color') == before
        await page.evaluate('id=>openNodeEditor(id)', ids['delay'])
        await page.wait_for_selector('#canvas .node textarea[data-literal]')
        assert await page.locator('#group-form [data-capability], #group-form [name=extra_capabilities]').count() == 0
        node_id = await page.locator('#canvas .node textarea[data-literal]').first.evaluate('e=>e.closest(".node").dataset.id')
        await page.locator('#canvas .node textarea[data-literal]').first.evaluate('e=>e.style.height="280px"')
        await page.wait_for_function("Object.values(store.get('fieldHeights:'+W.workflow,{})).includes(280)")
        await page.evaluate('id=>go(`/p/${id}/w/${id}`)', ids['project'])
        await page.evaluate('id=>openNodeEditor(id)', ids['delay'])
        area = page.locator('#canvas .node textarea[data-literal]').first
        await area.wait_for()
        assert await area.evaluate('e=>e.closest(".node").dataset.id') == node_id
        assert await area.evaluate('e=>e.offsetHeight') >= 280
        await page.reload()
        await page.wait_for_function("typeof app!=='undefined' && app.route && document.querySelector('#view').children.length")
        await page.wait_for_selector('#canvas .node textarea[data-literal]')
        assert await area.evaluate('e=>e.offsetHeight') >= 280
        # Saving a capitalized name preserves both its data and the actual canvas label.
        await page.evaluate("""async () => {
          const cx = W.complex.get(W.snapshot.root);
          const iface = structuredClone(cx.interface); iface.inputs[0].name = 'InputSignal';
          await api(`projects/${W.project}/complex/${cx.id}`,{method:'PUT',body:wf({interface:iface})});
          await reload();
        }""")
        assert await page.locator('.frame .port-name').filter(has_text='InputSignal').count() == 1
        print('PASS workflow subsection, group styling, permission hint, hidden capabilities, height after reopen/reload and port spelling')
        await page.evaluate("go('/library')")
        assert await page.locator('#view .card').filter(has_text='AI').count() == 1
        for width in (1500, 390):
            await page.set_viewport_size({'width':width,'height':1000})
            for path, target in [('/', '.dashboard')]:
                await page.evaluate('path=>go(path)', path)
                await page.wait_for_selector(target)
                assert await page.locator(target).evaluate('e=>e.scrollWidth<=e.clientWidth'), (width,path)
                await page.screenshot(path=str(Path(tempfile.gettempdir()) / f'agentsys-{width}-{target[1:]}.png'))
        assert not errors, errors
        print('PASS compact Dashboard, mobile overflow and no page errors')
        await browser.close()


if __name__=='__main__':
    with isolated_server() as (base, directory):
        asyncio.run(check(base))
