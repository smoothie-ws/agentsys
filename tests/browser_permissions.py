"""Permission radio clicks must survive an earlier save finishing mid-click."""
import asyncio
import json
import os
import subprocess
import tempfile
from playwright.async_api import async_playwright


async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.page')
        await page.evaluate("""async () => {
          const resource = app.resources.find(r => r.name === 'Delay');
          const project = await api('projects', {method:'POST', body:{name:'Permission clicks'}});
          await go(`/p/${project.id}/w/${project.id}`);
          await api(`projects/${project.id}/custom-nodes/${resource.id}`, {
            method:'POST', body:{workflow_id:project.id, point:{x:0,y:0}}
          });
          await reload();
          select(['complex:' + W.snapshot.complex.find(c => c.source).id]);
        }""")
        await page.wait_for_selector('.permission-table')
        release = asyncio.Event()
        waiting = asyncio.Event()

        async def hold_save(route):
            if route.request.method == 'PUT' and '/complex/' in route.request.url and not waiting.is_set():
                waiting.set()
                await release.wait()
            await route.continue_()

        await page.route('**/api/**', hold_save)
        await page.get_by_role('radio', name='Allow graph.read', exact=True).click()
        await asyncio.wait_for(waiting.wait(), timeout=10)
        next_radio = page.get_by_role('radio', name='Allow graph.write', exact=True)
        box = await next_radio.bounding_box()
        await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        await page.mouse.down()
        release.set()
        await page.wait_for_function("W.snapshot.complex.find(c => c.source).grants.includes('graph.read')")
        # Let the reload finish while the next radio is pressed but not yet clicked.
        await page.wait_for_timeout(150)
        await page.mouse.up()
        await page.wait_for_function("W.snapshot.complex.find(c => c.source).grants.includes('graph.write')")
        assert await next_radio.is_checked()
        await page.get_by_role('radio', name='Disallow graph.read', exact=True).click()
        await page.wait_for_function("!W.snapshot.complex.find(c => c.source).grants.includes('graph.read')")
        await page.evaluate('async () => { await reload(); await Inspector.show(); }')
        assert await page.get_by_role('radio', name='Disallow graph.read', exact=True).is_checked()
        assert await next_radio.is_checked()
        assert not errors, errors
        await browser.close()
        print('PASS permission clicks survive a save completing mid-click; Allow/Disallow persist')


with tempfile.TemporaryDirectory(prefix='agentsys-permission-clicks-') as directory:
    source = "const a=require('./server').createServer({dataDir:process.env.AGENTSYS_BROWSER_DATA});a.listen(0).then(url=>console.log(JSON.stringify({url}))).catch(e=>{console.error(e);process.exit(1)});"
    process = subprocess.Popen(
        ['node', '-e', source], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, 'AGENTSYS_BROWSER_DATA': directory},
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    try:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        asyncio.run(check(json.loads(line)['url']))
    finally:
        process.terminate()
        process.wait(timeout=10)
