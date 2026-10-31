"""Standalone Script grants and retained execution history through the user interface."""
import asyncio
import os
from playwright.async_api import async_playwright
from browser_server import isolated_server, expand_workflow_section


async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard')
        ids = await page.evaluate("""async()=>{
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const p=await api('projects',{method:'POST',body:{name:'Durable UI'}});
          const {types}=await api(`projects/${p.id}/types`);
          const s=await api(`projects/${p.id}/typed-nodes`,{method:'POST',body:{node_type:'custom',config:{
            title:'Authorized Script',op:'script',grants:['graph.read'],
            inputs:[{id:'in',name:'in',type:'signal'},{id:'script',name:'script',type:'t:'+types.find(t=>t.control==='code').id,default:'node.display("history preview");'}],
            outputs:[{id:'out',name:'out',type:'signal'}]}}});
          await api(`projects/${p.id}/policy`,{method:'PUT',body:{allow:['graph.read','run.read','run.start']}});
          await api('settings',{method:'PUT',body:{developer_mode:false}});
          await go(`/p/${p.id}/w/${p.id}`);select([s.id]);return {project:p.id,node:s.id};
        }""")
        grants = page.locator('#script-grants')
        await grants.get_by_role('radio', name='Allow run.read', exact=True).click()
        await page.wait_for_function("id=>W.snapshot.nodes.find(n=>n.id===id).config.grants.includes('run.read')", arg=ids['node'])
        await grants.get_by_role('radio', name='Allow graph.write', exact=True).click()
        await page.wait_for_function("id=>W.snapshot.nodes.find(n=>n.id===id).config.grants.includes('graph.write')", arg=ids['node'])
        assert 'graph.write' not in await grants.locator('[data-effective-permissions]').inner_text()
        await page.reload()
        await page.wait_for_selector('#canvas')
        await page.evaluate('id=>select([id])', ids['node'])
        assert await grants.get_by_role('radio', name='Allow run.read', exact=True).is_checked()
        await page.evaluate("""async ids=>{
          await api(`projects/${ids.project}/execution`,{method:'POST',body:{node_ids:[ids.node],wait:true}});
        }""", ids)
        await page.locator('[data-side-tab=workflow]').click()
        await expand_workflow_section(page, 'execution')
        await page.get_by_role('button', name='Execution history', exact=True).click()
        await page.locator('#modal').wait_for(state='visible')
        assert 'completed' in await page.locator('#modal-body').inner_text()
        assert 'invocation.start' in await page.locator('#modal-body').inner_text()
        await page.locator('[data-trace-node]').first.click()
        assert await page.evaluate('id=>W.selected.has(id)', ids['node'])
        assert not errors, errors
        await browser.close()
        print('PASS standalone user grants, effective constraints, reload persistence and history node links')


with isolated_server() as (base, _):
    asyncio.run(check(base))
