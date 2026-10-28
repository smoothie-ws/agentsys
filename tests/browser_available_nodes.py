"""Workflow-local node menus. Starts a server with disposable data when no URL is given."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else None


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE + '/editor/')
        await page.wait_for_selector('.page')
        ids = await page.evaluate("""async () => {
          const make = (name, folder) => {
            const id = 'record:' + uuid(), group = uuid();
            const bundle = {version:3, types:[], records:[{id, payload:{kind:'function',node_type:'custom',label:name,config:{title:name,inputs:[],outputs:[]}}}],
              groups:[{id:group,name,members:[id],parent:null}], complex:[{id:group,interface:{inputs:[],outputs:[]}}],
              positions:{[id]:{x:0,y:0}},port_edges:[],widgets:{}};
            return api('resources',{method:'POST',body:{name,payload:{folder,bundle}}});
          };
          const alpha=await make('Availability Alpha','Checks'), beta=await make('Availability Beta','Checks/Sub');
          const project=await api('projects',{method:'POST',body:{name:'Available nodes browser'}});
          const second=await api(`projects/${project.id}/workflows`,{method:'POST',body:{name:'Second'}});
          await go(`/p/${project.id}/w/${project.id}`);
          return {project:project.id,second:second.id,alpha:alpha.id,beta:beta.id};
        }""")
        assert await page.locator('#sidebar [data-section=runs]').count() == 0
        assert await page.evaluate('W.snapshot.library_nodes.length') == 0
        await page.locator('[data-empty-add]:visible').click()
        menu = page.locator('.popup:not(.closing)')
        assert 'Availability Alpha' not in await menu.inner_text()
        search = menu.get_by_role('searchbox')
        await search.fill('Availability')
        assert await menu.get_by_role('menuitem', name='Checks / Availability Alpha', exact=True).count() == 1
        assert await menu.get_by_role('menuitem', name='Checks / Sub / Availability Beta', exact=True).count() == 1
        await search.fill('')
        assert 'Availability Alpha' not in await menu.inner_text()
        await search.fill('Availability Alpha')
        await menu.get_by_role('menuitem', name='Checks / Availability Alpha', exact=True).click()
        await page.wait_for_function('id => W.snapshot.library_nodes.includes(id) && W.snapshot.complex.length === 1', arg=ids['alpha'])
        await page.locator('[data-side-tab=nodes]').click()
        alpha = page.locator(f'[data-library-node="{ids["alpha"]}"]')
        beta = page.locator(f'[data-library-node="{ids["beta"]}"]')
        group = page.locator('[data-library-group="Checks"]')
        assert await alpha.is_checked()
        assert not await beta.is_checked()
        assert await group.evaluate('(el) => el.indeterminate')
        assert await group.evaluate("el => getComputedStyle(el, '::after').maskImage") == 'none'
        await group.check()
        await page.wait_for_function('id => W.snapshot.library_nodes.includes(id)', arg=ids['beta'])
        assert await beta.is_checked()
        assert not await group.evaluate('(el) => el.indeterminate')
        await alpha.uncheck()
        await page.wait_for_function('id => !W.snapshot.library_nodes.includes(id)', arg=ids['alpha'])
        assert await page.evaluate('W.snapshot.complex.length') == 1
        await group.check()
        await page.wait_for_function('W.snapshot.library_nodes.length === 2')
        await group.uncheck()
        await page.wait_for_function('W.snapshot.library_nodes.length === 0')
        # Right-click Add has its own search with the complete Library, too.
        await page.locator('#canvas').click(button='right', position={'x': 80, 'y': 350})
        await page.locator('.popup:not(.closing)').get_by_role('menuitem', name='Add', exact=True).click()
        submenu = page.locator('.submenu')
        assert 'Availability Alpha' not in await submenu.inner_text()
        await submenu.get_by_role('searchbox').fill('Availability Alpha')
        await submenu.get_by_role('menuitem', name='Checks / Availability Alpha', exact=True).click()
        await page.wait_for_function('id => W.snapshot.library_nodes.includes(id) && W.snapshot.complex.length === 2', arg=ids['alpha'])
        # The next normal Add menu offers Alpha without entering a query.
        await page.evaluate('addMenu(600, 250)')
        await page.locator('.popup:not(.closing)').get_by_role('menuitem', name='Checks', exact=True).click()
        assert await page.locator('.submenu').get_by_role('menuitem', name='Availability Alpha', exact=True).count() == 1
        await page.keyboard.press('Escape')
        await page.evaluate('ids => go(`/p/${ids.project}/w/${ids.second}`)', ids)
        await page.wait_for_function('W.snapshot.library_nodes.length === 0')
        await page.goto(BASE + '/editor/p/' + ids['project'] + '/w/' + ids['project'])
        await page.wait_for_function('id => W.snapshot?.library_nodes.includes(id)', arg=ids['alpha'])
        await page.locator('[data-side-tab=nodes]').click()
        assert await page.locator(f'[data-library-node="{ids["alpha"]}"]').is_checked()
        assert await page.locator('[data-side-tab=nodes]').get_attribute('aria-pressed') == 'true'
        assert await page.locator('.available-group-items').evaluate_all("""groups => groups.every(group => {
          const rows = [...group.children].filter(el => el.matches('.available-node'));
          return rows.every((row, i) => !i || row.getBoundingClientRect().top >= rows[i-1].getBoundingClientRect().bottom);
        })""")
        if os.environ.get('AGENTSYS_UI_SCREENSHOT'):
            await page.wait_for_timeout(400)
            await page.screenshot(path=os.environ['AGENTSYS_UI_SCREENSHOT'])
        # A narrow layout still exposes and opens the section.
        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.locator('[data-side-tab=nodes]').click()
        assert await page.locator(f'[data-library-node="{ids["alpha"]}"]').is_visible()
        await page.set_viewport_size({'width': 1500, 'height': 1000})
        await page.evaluate("go('/resources/nodes?folder=Checks')")
        await page.wait_for_selector('.cards .card')
        assert await page.locator('[data-enable]').count() == 0
        await page.locator(f'.cards [data-menu="resource:{ids["alpha"]}"]').click()
        actions = await page.locator('.popup:not(.closing)').inner_text()
        assert 'Enable' not in actions and 'Disable' not in actions
        await page.keyboard.press('Escape')
        await page.locator('.page-head [data-menu="folder:Checks"]').click()
        actions = await page.locator('.popup:not(.closing)').inner_text()
        assert 'Enable' not in actions and 'Disable' not in actions
        assert not errors, errors
        await browser.close()
        print('PASS: per-workflow defaults, both Add searches, automatic inclusion, groups, reload, mobile, catalog-only Library; no page errors')


if BASE:
    asyncio.run(main())
else:
    with tempfile.TemporaryDirectory(prefix='agentsys-available-nodes-ui-') as directory:
        env = {**os.environ, 'AGENTSYS_BROWSER_DATA': str(Path(directory).resolve())}
        source = "const app=require('./server').createServer({dataDir:process.env.AGENTSYS_BROWSER_DATA});app.listen(0).then(url=>console.log(JSON.stringify({url}))).catch(e=>{console.error(e);process.exit(1)});"
        process = subprocess.Popen(['node', '-e', source], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError(process.stderr.read())
            BASE = json.loads(line)['url']
            asyncio.run(main())
        finally:
            process.terminate()
            process.wait(timeout=10)
