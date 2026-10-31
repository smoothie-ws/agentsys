"""Permission radio clicks must survive an earlier save finishing mid-click."""
import asyncio
import json
import os
import subprocess
import tempfile
from playwright.async_api import async_playwright
from browser_server import expand_workflow_section


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
        await expand_workflow_section(page, 'permissions')
        await workflow_policy.wait_for()
        assert 'every workflow in this project' in await page.locator('[data-workflow-section=permissions] > summary').inner_text()
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
        await page.evaluate("go('/projects')")
        policy = await page.evaluate('id=>api(`projects/${id}/policy`)',project)
        assert set(policy['allow']) == {'graph.write','notifications.write','net.fetch:example.com'}
        await page.evaluate('id=>go(`/p/${id}/w/${id}`)',project)
        await page.locator('[data-side-tab=workflow]').click()
        await expand_workflow_section(page, 'permissions')
        await workflow_policy.wait_for()
        assert await workflow_policy.get_by_role('radio',name='Allow graph.write',exact=True).is_checked()
        assert await workflow_policy.get_by_role('radio',name='Disallow graph.read',exact=True).is_checked()
        assert 'net.fetch:example.com' in await workflow_policy.locator('[name=extra_grants]').input_value()
        await page.reload()
        await page.wait_for_selector('#canvas')
        await page.locator('[data-side-tab=workflow]').click()
        await expand_workflow_section(page, 'permissions')
        assert await workflow_policy.get_by_role('radio',name='Allow graph.write',exact=True).is_checked()
        node_state=await page.evaluate("""async()=>{
          await api('settings',{method:'PUT',body:{developer_mode:true}});await loadLibrary();
          const resource=app.resources.find(r=>r.name==='Delay');
          const copies=W.snapshot.complex.filter(c=>c.source?.resource_id===resource.id).map(c=>({id:c.id,grants:c.grants}));
          await editInLibrary(resource.id);
          return {id:resource.id,bundle:resource.payload.bundle,copies};
        }""")
        await page.locator('[data-side-tab=workflow]').click()
        library_permissions=page.locator('#library-permissions')
        await expand_workflow_section(page, 'permissions')
        await library_permissions.wait_for()
        assert await page.locator('#workflow-policy').count()==0
        assert await library_permissions.locator('.permission-table').count()==1
        assert 'Declared permissions' not in await library_permissions.inner_text()
        assert 'Default permissions' in await page.locator('[data-workflow-section=permissions] > summary').inner_text()
        defaults=library_permissions
        await defaults.get_by_role('radio',name='Allow net.fetch:*',exact=True).click()
        await defaults.get_by_role('radio',name='Allow library.read',exact=True).click()
        await defaults.locator('[name=extra_grants]').fill('net.fetch:127.0.0.1:8080')
        await page.evaluate("go('/projects')")
        saved=await page.evaluate('id=>api(`resources/${id}`)',node_state['id'])
        assert set(saved['payload']['grants'])=={'library.read','net.fetch:*','net.fetch:127.0.0.1:8080'}
        assert saved['payload']['bundle']==node_state['bundle']
        existing=await page.evaluate("async id=>(await api(`projects/${id}/workflow`,{query:{workflow_id:id}})).complex",project)
        for old in node_state['copies']:
            assert next(c for c in existing if c['id']==old['id'])['grants']==old['grants']
        await page.evaluate('id=>editInLibrary(id)',node_state['id'])
        await page.locator('[data-side-tab=workflow]').click()
        await expand_workflow_section(page, 'permissions')
        await library_permissions.wait_for()
        assert await defaults.get_by_role('radio',name='Allow net.fetch:*',exact=True).is_checked()
        assert await defaults.get_by_role('radio',name='Allow library.read',exact=True).is_checked()
        await page.reload();await page.wait_for_selector('#canvas')
        await page.locator('[data-side-tab=workflow]').click()
        await expand_workflow_section(page, 'permissions')
        assert await defaults.get_by_role('radio',name='Allow net.fetch:*',exact=True).is_checked()
        new_copy=await page.evaluate("""async args=>{
          const placed=await api(`projects/${args.project}/custom-nodes/${args.resource}`,{method:'POST',body:{workflow_id:args.project,point:{x:300,y:0}}});
          return (await api(`projects/${args.project}/workflow`,{query:{workflow_id:args.project}})).complex.find(c=>c.id===placed.roots[0]);
        }""",{'project':project,'resource':node_state['id']})
        assert set(new_copy['grants'])=={'library.read','net.fetch:*','net.fetch:127.0.0.1:8080'}
        assert not errors, errors
        await browser.close()
        print('PASS one Library defaults form autosaves and seeds only new copies; existing copy/project settings remain independent')


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
