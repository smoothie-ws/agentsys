"""Execution controls, paused memory and the surrounding editor UI, with disposable data."""
import asyncio
import os
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def audit(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1500, 'height': 950})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard')
        ids = await page.evaluate("""async () => {
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const p=await api('projects',{method:'POST',body:{name:'Execution UI'}});
          const other=await api(`projects/${p.id}/workflows`,{method:'POST',body:{name:'Other tab'}});
          const types=(await api(`projects/${p.id}/types`)).types;
          const make=config=>api(`projects/${p.id}/typed-nodes`,{method:'POST',body:{node_type:'custom',config}});
          const start=await make({title:'Start',op:'on_run',inputs:[],outputs:[{id:'out',name:'out',type:'signal'}]});
          const script=await make({title:'Paused memory',op:'script',inputs:[{id:'in',name:'in',type:'signal'},
            {id:'script',name:'script',type:'t:'+types.find(t=>t.control==='code').id,
              default:'context.state.value=42;globalThis.hostCalls=(globalThis.hostCalls??0)+1;node.display("before pause");await node.sleep(600);context.state.value++;node.display(context.state.value);'}],outputs:[{id:'out',name:'out',type:'signal'}]});
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[{source:start.id,source_port:'out',target:script.id,target_port:'in'}]}});
          window.executionFixture={project:p.id,workflow:p.id,other:other.id,script:script.id};
          await go(`/p/${p.id}/w/${p.id}`);
          return executionFixture;
        }""")
        await page.wait_for_function('W.executionReady')
        await page.locator('#start').click()
        await page.wait_for_function('W.runStatus.get(executionFixture.script)==="sleeping"')
        assert await page.evaluate('W.results.get(executionFixture.script)?.text') == 'before pause'
        assert await page.evaluate('W.runtimeState.value') == 42
        # Polling between pointerdown and pointerup must not replace the pressed icon.
        pause_icon = page.locator('#pause svg')
        original_icon = await pause_icon.element_handle()
        await pause_icon.hover()
        await page.mouse.down()
        await page.wait_for_timeout(250)
        assert await original_icon.evaluate('el=>el.isConnected')
        await page.mouse.up()
        await page.wait_for_function('W.runPaused && !W.executionCommand')
        await page.evaluate("async () => {await go(`/p/${executionFixture.project}/w/${executionFixture.other}`);}")
        await page.wait_for_function('W.executionReady')
        await page.locator(f'#tabs [data-tab="{ids["project"]}/{ids["workflow"]}"]').click()
        await page.wait_for_function('W.executionReady && W.runPaused')
        assert await page.evaluate('W.runtimeState.value') == 42
        assert await page.evaluate('W.results.get(executionFixture.script)?.text') == 'before pause'
        await page.wait_for_timeout(650)
        await page.locator('#pause').click()
        await page.wait_for_function('!W.running')
        assert await page.evaluate('W.results.get(executionFixture.script)?.text') == '43'
        await page.reload()
        await page.wait_for_function('W.executionReady')
        await page.evaluate('ids=>{window.executionFixture=ids}', ids)
        assert await page.evaluate('W.runtimeState.value') == 43
        assert await page.evaluate('W.results.get(executionFixture.script)?.text') == '43'
        print('PASS Resume across tabs and JSON state/previews across page reload', flush=True)

        # Hold a poll sent before Pause. Its old response must not reverse the Pause response.
        await page.locator('#start').click()
        await page.wait_for_function('W.runStatus.get(executionFixture.script)==="sleeping"')
        await page.evaluate("""() => {
          window.realExecutionApi=api;
          api=async(path,options)=>{
            if(path===`projects/${executionFixture.project}/execution` && !options?.method && !window.releaseExecutionPoll){
              const old=await realExecutionApi(path,options);
              return new Promise(resolve=>{window.releaseExecutionPoll=()=>resolve(old);});
            }
            return realExecutionApi(path,options);
          };
        }""")
        await page.wait_for_function('typeof releaseExecutionPoll==="function"')
        await page.locator('#pause').click()
        await page.wait_for_function('W.runPaused && !W.executionCommand')
        await page.evaluate('releaseExecutionPoll()')
        await page.wait_for_timeout(50)
        assert await page.evaluate('W.runPaused')
        await page.evaluate('() => {api=realExecutionApi;}')
        await page.locator('#stop').click()
        await page.wait_for_function('!W.running && !W.executionCommand')
        assert await page.evaluate('W.executionStatus') == 'idle'
        assert await page.locator('.run-state.running,.run-state.sleeping,.run-state.waiting').count() == 0
        print('PASS stale polling cannot undo Pause; first-click Stop ends the paused execution', flush=True)

        # A pending poll from a departed canvas must not apply to the next tab.
        await page.locator('#start').click()
        await page.wait_for_function('W.runStatus.get(executionFixture.script)==="sleeping"')
        await page.evaluate("""() => {
          window.releaseExecutionPoll=null;
          api=async(path,options)=>{
            if(path===`projects/${executionFixture.project}/execution` && options?.query?.workflow_id===executionFixture.workflow && !options?.method && !window.releaseExecutionPoll){
              const old=await realExecutionApi(path,options);
              return new Promise(resolve=>{window.releaseExecutionPoll=()=>resolve(old);});
            }
            return realExecutionApi(path,options);
          };
        }""")
        await page.wait_for_function('typeof releaseExecutionPoll==="function"')
        await page.evaluate('async () => {await go(`/p/${executionFixture.project}/w/${executionFixture.other}`);}')
        await page.wait_for_function('W.executionReady')
        await page.evaluate('() => {releaseExecutionPoll();api=realExecutionApi;}')
        await page.wait_for_timeout(50)
        assert not await page.evaluate('W.running')
        await page.locator('#start').click()
        await page.wait_for_function('W.executionReady && !W.executionCommand && !W.running')
        assert await page.evaluate('W.executionStatus') == 'idle'
        print('PASS old-tab responses do not replace the current tab or consume its first Run click', flush=True)
        await page.evaluate('async () => {await api(`projects/${executionFixture.project}/execution`,{method:"DELETE",query:{workflow_id:executionFixture.workflow}});await go(`/p/${executionFixture.project}/w/${executionFixture.workflow}`);}')
        await page.wait_for_function('W.executionReady')

        # Stop also accepts a click while the Run request is still being prepared.
        await page.evaluate("""() => {
          api=(path,options)=>{
            if(path===`projects/${executionFixture.project}/execution` && options?.method==='POST')
              return new Promise(resolve=>{window.releaseRunRequest=async()=>resolve(await realExecutionApi(path,options));});
            return realExecutionApi(path,options);
          };
        }""")
        await page.locator('#start').click()
        await page.wait_for_function('typeof releaseRunRequest==="function"')
        await page.locator('#stop').click()
        assert await page.evaluate('W.executionCommand') == 'stop'
        await page.evaluate('releaseRunRequest()')
        await page.wait_for_function('!W.executionCommand && !W.running')
        await page.evaluate('() => {api=realExecutionApi;}')
        print('PASS Stop accepts its first click even while Run is pending', flush=True)

        # Assigning a color changes only paint, not header geometry.
        geometry = """id=>{const el=document.querySelector(`[data-id="${id}"] > header`),r=el.getBoundingClientRect(),s=getComputedStyle(el);return {width:r.width,height:r.height,padding:s.padding,margin:s.margin,radius:s.borderRadius,background:s.backgroundColor};}"""
        before = await page.evaluate(geometry, ids['script'])
        assert before['background'] != 'rgba(0, 0, 0, 0)'
        await page.evaluate('async id=>{await api(`projects/${W.project}/node-style`,{method:"PUT",body:wf({node_id:id,color:"#3b6ea8"})});await reload();}', ids['script'])
        after = await page.evaluate(geometry, ids['script'])
        assert {k: v for k, v in before.items() if k != 'background'} == {k: v for k, v in after.items() if k != 'background'}
        await page.locator('[data-side-tab=workflow]').click()
        assert await page.locator('.workflow-section').count() >= 4
        assert await page.locator('.workflow-section[open]').count() == 0
        await page.locator('[data-workflow-section=permissions] > summary').click()
        await page.evaluate('Inspector.refresh()')
        assert await page.locator('[data-workflow-section=permissions]').get_attribute('open') is not None
        await page.locator('[data-workflow-section=permissions] > summary').click()
        if os.environ.get('AGENTSYS_UI_SCREENSHOT'):
            await page.screenshot(path=os.environ['AGENTSYS_UI_SCREENSHOT'])
        print('PASS colored and plain headers have identical geometry; workflow settings have stable collapsible sections', flush=True)

        await page.evaluate("go('/library')")
        assert await page.locator('#subnav .subnav-group.open').count() == 0
        await page.evaluate("go('/library/ai.providers')")
        assert await page.locator('#subnav .subnav-group.open').count() == 0
        await page.evaluate("go('/library/nodes')")
        assert await page.locator('#subnav .subnav-group.open').count() == 0
        await page.locator('#subnav [data-group="s:nodes"] > .subnav-row > .subnav-toggle').click()
        assert await page.locator('#subnav [data-group="s:nodes"]').evaluate('el=>el.classList.contains("open")')
        await page.evaluate('renderSidebar()')
        assert await page.locator('#subnav [data-group="s:nodes"]').evaluate('el=>el.classList.contains("open")')
        await page.locator('#subnav [data-group="s:nodes"] > .subnav-row > .subnav-toggle').click()
        await page.evaluate("go('/library/nodes')")
        assert await page.locator('#subnav .subnav-group.open').count() == 0
        print('PASS Library branches open only on an explicit toggle and stay closed during navigation', flush=True)

        await page.evaluate("go('/plugins/ai')")
        await page.locator('.page-head [data-menu]').click()
        assert await page.get_by_role('menuitem', name='Open', exact=True).count() == 0
        assert await page.locator('.popup [role=menuitem]').evaluate_all('els=>els.every(el=>el.querySelector(".menu-label > svg,.menu-label > img"))')
        await page.evaluate('closePopup(true)')
        provider = await page.evaluate('api("library/sections/ai.providers/items",{method:"POST",body:{name:"Local",values:{providerId:"local",baseURL:"http://localhost:11434/v1"}}})')
        await page.evaluate('id=>go(`/library/ai.providers/${id}`)', provider['id'])
        await page.locator('.page-head [data-menu]').click()
        assert await page.get_by_role('menuitem', name='Settings', exact=True).count() == 0
        assert await page.locator('.popup [role=menuitem]').evaluate_all('els=>els.every(el=>el.querySelector(".menu-label > svg,.menu-label > img"))')
        await page.evaluate('closePopup(true)')
        await page.evaluate("go('/api')")
        await page.locator('[data-script-api]').click()
        assert 'context.state' in await page.locator('#modal').inner_text()
        await page.locator('#modal button[aria-label=Close]').click()
        assert await page.locator('.api-call-tree .api-call').count() > 0
        assert await page.locator('.api-call-tree small').count() == 0
        assert await page.locator('.api-method h3').first.inner_text()
        print('PASS API tree omits descriptions; menus omit self-navigation and have action icons', flush=True)
        await page.set_viewport_size({'width': 390, 'height': 844})
        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors, errors
        await browser.close()


if __name__ == '__main__':
    with isolated_server() as (base, _):
        asyncio.run(audit(base))
