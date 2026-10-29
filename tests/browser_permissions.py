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
        await page.unroute('**/api/**', hold_save)
        await page.locator('[data-side-tab=workflow]').click()
        workflow_policy = page.locator('#workflow-policy')
        await workflow_policy.wait_for()
        assert 'every workflow in this project' in await workflow_policy.inner_text()
        assert await workflow_policy.locator('.permission-table').count() == 1
        assert await workflow_policy.get_by_role('radio',name='Allow graph.read',exact=True).is_checked()
        policy_waiting, policy_release = asyncio.Event(), asyncio.Event()

        async def hold_policy(route):
            if route.request.method == 'PUT' and route.request.url.endswith('/policy') and not policy_waiting.is_set():
                policy_waiting.set()
                await policy_release.wait()
            await route.continue_()

        await page.route('**/api/**', hold_policy)
        await workflow_policy.get_by_role('radio',name='Allow graph.write',exact=True).click()
        await asyncio.wait_for(policy_waiting.wait(),timeout=10)
        read_radio = workflow_policy.get_by_role('radio',name='Disallow graph.read',exact=True)
        box = await read_radio.bounding_box()
        await page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
        await page.mouse.down()
        policy_release.set()
        await page.wait_for_timeout(300)
        await page.mouse.up()
        await page.wait_for_function("async()=>JSON.stringify((await api(`projects/${W.project}/policy`)).allow)==='[\"graph.write\"]'")
        assert await read_radio.is_checked()
        await workflow_policy.locator('[name=extra_grants]').fill('notifications.write, net.fetch:example.com')
        project = await page.evaluate('W.project')
        await page.evaluate("go('/runs?section=permissions')")
        await page.wait_for_selector('.runs-page')
        assert await page.locator('#runs-policy, #runs-permissions').count() == 0
        assert await page.locator('#subnav a').filter(has_text='Permissions').count() == 0
        assert await page.locator('#subnav [data-key=\"dashboard:runs\"]').count() == 1
        policy = await page.evaluate('id=>api(`projects/${id}/policy`)',project)
        assert set(policy['allow']) == {'graph.write','notifications.write','net.fetch:example.com'}
        await page.evaluate('id=>go(`/p/${id}/w/${id}`)',project)
        await page.locator('[data-side-tab=workflow]').click()
        await workflow_policy.wait_for()
        assert await workflow_policy.get_by_role('radio',name='Allow graph.write',exact=True).is_checked()
        assert await workflow_policy.get_by_role('radio',name='Disallow graph.read',exact=True).is_checked()
        assert 'net.fetch:example.com' in await workflow_policy.locator('[name=extra_grants]').input_value()
        await page.reload()
        await page.wait_for_selector('#canvas')
        await page.locator('[data-side-tab=workflow]').click()
        assert await workflow_policy.get_by_role('radio',name='Allow graph.write',exact=True).is_checked()
        assert not errors, errors
        await browser.close()
        print('PASS node and workflow permission clicks survive mid-click saves; project policy autosaves, survives navigation/reload and is absent from Runs')


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
