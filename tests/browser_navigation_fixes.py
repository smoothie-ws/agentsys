"""Navigation and icon upload regressions. Run with a static server port."""
import asyncio
import base64
import os
import sys
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(f'http://127.0.0.1:{sys.argv[1]}/index.html#/settings')
        await page.wait_for_selector('#settings-form')
        assert await page.locator('#sidebar [data-section]').evaluate_all('(els)=>els.map(el=>el.dataset.section)') == ['home', 'library', 'projects', 'settings']
        assert await page.locator('.sidebar-top > a:first-child + hr').count() == 1
        await page.get_by_role('tab', name='Keyboard shortcuts').click()
        assert await page.get_by_role('button', name='Restore', exact=False).count() == 1
        assert await page.locator('#settings-form .muted.small').count() == 0
        print('PASS navigation order, separator and single Settings restore action')

        await page.evaluate("""async () => {
          app.preferences=await api('settings',{method:'PUT',body:{developer_mode:true}});
          const project=await api('projects',{method:'POST',body:{name:'Panels'}});
          window.testProject=project.id;
          store.set('agentsys-side-hidden',true);
          await go(`/p/${project.id}/w/${project.id}`);
        }""")
        project_id = await page.evaluate('testProject')
        await page.wait_for_timeout(400)
        assert await page.locator('#side').get_attribute('data-collapsed') == 'true'
        await page.evaluate("""() => {
          window.panelWidths=[];
          const until=performance.now()+900;
          const tick=()=>{const side=document.querySelector('#side');if(side)panelWidths.push(side.getBoundingClientRect().width);if(performance.now()<until)requestAnimationFrame(tick)};
          requestAnimationFrame(tick);
        }""")
        await page.evaluate("go('/settings')")
        await page.evaluate("go(`/p/${testProject}/w/${testProject}`)")
        await page.wait_for_timeout(1000)
        assert await page.evaluate('panelWidths.length>5 && panelWidths.every(w=>Math.abs(w-56)<1)')
        await page.locator('[data-side-tab=properties]').click()
        await page.wait_for_timeout(450)
        assert await page.locator('#side').get_attribute('data-collapsed') == 'false'
        before = await page.locator('[data-side-tab=properties]').evaluate('(el)=>getComputedStyle(el).backgroundColor')
        await page.locator('[data-side-tab=properties]').hover()
        await page.wait_for_timeout(250)
        after = await page.locator('[data-side-tab=properties]').evaluate('(el)=>getComputedStyle(el).backgroundColor')
        assert before == after
        assert await page.locator('#side .hints').count() == 0
        print('PASS closed inspector opens without collapse animation and active section has stable hover fill')

        await page.evaluate('openNodeEditor()')
        await page.wait_for_selector('[data-icon-grid]')
        address = await page.evaluate('location.hash.slice(1)')
        resource_id = await page.evaluate('W.library')
        await page.locator('[data-icon-choice=branch]').click()
        await page.wait_for_function("app.resources.find(r=>r.id===W.library)?.payload.icon==='branch'")
        await page.wait_for_timeout(400)
        assert await page.locator('[data-icon-grid] .active').count() == 1
        assert await page.locator('[data-icon-choice=branch]').get_attribute('class') == 'icon active'
        assert 'active' not in await page.locator('[data-icon-choice=complex]').get_attribute('class')
        png = await page.evaluate("""() => {
          const c=document.createElement('canvas');c.width=300;c.height=150;
          const ctx=c.getContext('2d');ctx.fillStyle='#ff3300';ctx.fillRect(0,0,300,150);return c.toDataURL().split(',')[1];
        }""")
        await page.locator('[data-icon-file]').set_input_files({'name': 'my-icon.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(png)})
        await page.wait_for_function("app.resources.find(r=>r.id===W.library)?.payload.icon?.startsWith('data:image/png;base64,')")
        await page.wait_for_timeout(400)
        assert await page.locator('[data-icon-grid] .active').count() == 1
        assert await page.locator('[data-upload-icon].active img').count() == 1
        assert await page.evaluate("""async () => {
          const image=new Image();image.src=app.resources.find(r=>r.id===W.library).payload.icon;await image.decode();return image.width===128&&image.height===64;
        }""")
        await page.reload()
        await page.wait_for_selector('[data-upload-icon].active img')
        assert await page.locator('.tab.active .custom-icon').count() == 1
        await page.evaluate("go('/resources')")
        await page.wait_for_selector('.card .custom-icon')
        print('PASS icon selection is exclusive; uploaded icon is resized, saved and restored in cards and tabs')

        # Folder icons use the same upload control and backend validation.
        await page.evaluate("folderCall({action:'create',path:'',name:'Images'}).then(refreshLibrary)")
        await page.evaluate("""() => {
          const change=folderActions('Images').find(item=>item&&item[0]==='Change icon');change[1]();
        }""")
        await page.locator('#modal [data-icon-file]').set_input_files({'name': 'folder.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(png)})
        await page.wait_for_selector('#modal [data-upload-icon].active img')
        await page.locator('#modal-actions button[value=ok]').click()
        await page.wait_for_function("app.nodeFolderIcons.Images?.startsWith('data:image/png;base64,')")
        print('PASS Library folders accept uploaded icons too')

        await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:false}})")
        await page.evaluate('(path)=>go(path)', address)
        await page.wait_for_selector('#view h1')
        assert await page.locator('#canvas').count() == 0
        assert await page.evaluate('location.hash') == '#/resources'
        await page.reload()
        await page.wait_for_selector('#view h1')
        assert await page.locator('#canvas').count() == 0
        await page.evaluate('(id)=>go(`/resources/nodes/${id}`)', resource_id)
        await page.wait_for_selector('#view h1')
        assert await page.locator('#canvas').count() == 0
        await page.evaluate('(id)=>go(`/p/${id}/w/${id}`)', project_id)
        await page.wait_for_selector('#canvas')
        print('PASS Developer mode gates direct and saved Library graph URLs; project workflows still open')

        await page.evaluate("go('/')")
        await page.wait_for_selector('.tile')
        assert await page.locator('.api-call').count() == 0
        await page.locator('#home-api a.card-main').click()
        await page.wait_for_selector('.api-call')
        assert await page.evaluate('location.hash') == '#/api'
        await page.locator('.api-call').nth(3).click()
        assert await page.locator('.api-method-heading').inner_text()
        assert await page.locator('#sidebar [data-section]:not([data-section=home]).active').count() == 0
        assert await page.locator('#subnav .subnav-row.active').count() == 1
        print('PASS the API is a page of its own, reached from the dashboard')
        assert not errors, errors
        await browser.close()


asyncio.run(main())
