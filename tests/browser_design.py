"""Shared page geometry and readable execution feedback, using disposable server data."""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard')
        project = await page.evaluate("api('projects',{method:'POST',body:{name:'Layout review'}})")
        routes = ['/', '/projects', '/p/' + project['id'], '/p/' + project['id'] + '/settings',
                  '/library', '/library/nodes', '/settings', '/plugins', '/plugins/ai', '/api', '/missing']
        artifacts = Path(os.environ.get('AGENTSYS_UI_ARTIFACTS', 'node_modules/.cache/ui-review'))
        artifacts.mkdir(parents=True, exist_ok=True)
        for width in [1600, 1000, 390]:
            await page.set_viewport_size({'width': width, 'height': 1000})
            measurements = []
            for route in routes:
                await page.evaluate('route => go(route)', route)
                await page.wait_for_selector('.page-head')
                measured = await page.evaluate("""() => {
                  const page=document.querySelector('#view > .page'),head=page.querySelector('.page-head');
                  const r=page.getBoundingClientRect(),h=head.getBoundingClientRect(),style=getComputedStyle(page);
                    return {x:r.x,width:r.width,top:h.y-r.y,padding:style.paddingLeft,
                    paddingTop:style.paddingTop,paddingRight:style.paddingRight,paddingBottom:style.paddingBottom,
                    overflow:page.scrollWidth-page.clientWidth,headX:h.x-r.x};
                }""")
                assert measured['overflow'] <= 1, (width, route, measured)
                assert len({measured['padding'], measured['paddingTop'], measured['paddingRight']}) == 1, (width, route, measured)
                extra = 48 if width > 760 else 0
                assert float(measured['paddingBottom'].removesuffix('px')) == float(measured['paddingTop'].removesuffix('px')) + extra, (width, route, measured)
                measurements.append(measured)
                if route in ['/plugins/ai', '/settings', '/api', '/'] and width in [1600, 390]:
                    name = {'/': 'dashboard', '/settings': 'settings', '/api': 'api', '/plugins/ai': 'plugin'}[route]
                    await page.screenshot(path=str(artifacts / f'{name}-{width}.png'), animations='disabled')
            reference = measurements[0]
            for route, measured in zip(routes, measurements):
                for key in ['x', 'width', 'top', 'padding', 'headX']:
                    assert measured[key] == reference[key], (width, route, key, measured, reference)
            print(f'PASS common page frame on {len(routes)} routes at {width}px', flush=True)

        await page.set_viewport_size({'width': 1600, 'height': 1000})
        await page.evaluate("go('/settings?section=keyboard-shortcuts')")
        await page.wait_for_selector('.shortcuts')
        margins = await page.evaluate("""() => {
          const view=document.querySelector('#view'), page=document.querySelector('#view > .page');
          const top=page.querySelector('.page-head').getBoundingClientRect().top;
          view.scrollTop=view.scrollHeight;
          return {top, bottom:innerHeight-page.lastElementChild.getBoundingClientRect().bottom,
            scrollable:view.scrollHeight>view.clientHeight};
        }""")
        assert margins['scrollable'] and abs(margins['top']-margins['bottom']) < 1, margins
        ids = await page.evaluate("""async () => {
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const project=await api('projects',{method:'POST',body:{name:'Glow review'}});
          const types=(await api(`projects/${project.id}/types`)).types;
          const codeType='t:'+types.find(type=>type.control==='code').id;
          const make=(title,op,code)=>api(`projects/${project.id}/typed-nodes`,{method:'POST',body:{
            node_type:'custom',position:{x:title==='Start'?0:title==='First'?330:660,y:140},
            config:{title,op,inputs:[...(op==='script'?[{id:'in',name:'in',type:'signal'}]:[]),
              ...(code?[{id:'script',name:'script',type:codeType,default:code}]:[])],outputs:[{id:'out',name:'out',type:'signal'}]}}});
          const start=await make('Start','on_run');
          const first=await make('First','script','node.display("working");await node.sleep(350);node.display("done");');
          const second=await make('Second','script','node.display("done");');
          await api(`projects/${project.id}/port-connections`,{method:'POST',body:{add:[
            {source:start.id,source_port:'out',target:first.id,target_port:'in'},
            {source:first.id,source_port:'out',target:second.id,target_port:'in'}]}});
          await go(`/p/${project.id}/w/${project.id}`);
          window.glowFixture={project:project.id,start:start.id,first:first.id,second:second.id};
          return glowFixture;
        }""")
        await page.wait_for_function('W.executionReady')
        await page.evaluate('window.originalGlowNode=W.elements.get(glowFixture.first)')
        await page.locator('#start').click()
        await page.wait_for_function('W.runStatus.get(glowFixture.first)==="sleeping"')
        assert await page.evaluate('originalGlowNode===W.elements.get(glowFixture.first)')
        assert await page.evaluate('originalGlowNode.classList.contains("glow")')
        assert await page.locator('.wire.signal.flowing').count() > 0
        await page.wait_for_function('!W.running && W.runStatus.get(glowFixture.second)==="completed"')
        assert await page.evaluate('originalGlowNode===W.elements.get(glowFixture.first)')
        await page.wait_for_function('W.elements.get(glowFixture.second).classList.contains("glow")')
        assert await page.locator('.run-state.completed,.run-state.running,.run-state.failed').count() == 0
        await page.wait_for_function('!W.elements.get(glowFixture.second).classList.contains("glow")')
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(artifacts / 'canvas-completed.png'))
        runtime = await page.evaluate('api(`projects/${glowFixture.project}/execution`)')
        assert [event['node_id'] for event in runtime['activity']] == [ids['start'], ids['first'], ids['second']]
        # One coalesced snapshot still presents short starts in their recorded order.
        sequence = await page.evaluate("""async () => {
          const ids=[glowFixture.start,glowFixture.first,glowFixture.second];
          W.glowUntil.clear();for(const id of ids) W.elements.get(id).classList.remove('glow');
          const seen=[];
          const observer=new MutationObserver(records=>{for(const record of records) {
            const el=record.target;if(el.classList.contains('glow')&&!seen.includes(el.dataset.id)) seen.push(el.dataset.id);
          }});
          for(const id of ids) observer.observe(W.elements.get(id),{attributes:true,attributeFilter:['class']});
          queuePassGlows(ids.map((node_id,index)=>({node_id,sequence:1000+index})));
          await new Promise(resolve=>setTimeout(resolve,300));observer.disconnect();return seen;
        }""")
        assert sequence == [ids['start'], ids['first'], ids['second']], sequence
        await page.wait_for_function('W.glowTimers.size===0')
        await page.emulate_media(reduced_motion='reduce')
        await page.evaluate('queuePassGlows([{node_id:glowFixture.second,sequence:2000}])')
        assert await page.evaluate('W.glowTimers.size===0 && W.glowPending.size===0')
        await page.emulate_media(reduced_motion='no-preference')
        await page.evaluate("""async () => {
          const graph=await api(`projects/${glowFixture.project}/workflow`);
          const config=graph.nodes.find(node=>node.id===glowFixture.second).config;
          config.inputs.find(port=>port.id==='script').default='throw Error("visual failure");';
          await api(`projects/${glowFixture.project}/typed-nodes/${glowFixture.second}`,{method:'PUT',body:{node_type:'custom',config}});
          await reload();
          W.elements.get(glowFixture.second).querySelector('textarea').focus();
          await api(`projects/${glowFixture.project}/execution`,{method:'POST',body:{node_ids:[glowFixture.second],wait:true}});
        }""")
        await page.wait_for_function('W.elements.get(glowFixture.second).classList.contains("s-failed")')
        assert not await page.evaluate('W.elements.get(glowFixture.second).classList.contains("glow")')
        await page.evaluate('go("/projects")')
        await page.wait_for_timeout(600)
        assert not errors, errors
        print('PASS stable node shell, visible short passes, ordered pulses, animated signal wires and navigation cleanup', flush=True)
        await browser.close()


if __name__ == '__main__':
    with isolated_server() as (base, _):
        asyncio.run(check(base))
