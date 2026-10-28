'''Browser test: the slots of a Custom Node are edited on its main group, a placed node gets slots of its own, and wires reach them.
Run: python3 tests/browser_custom_node.py PORT (a static server on the project folder)'''
import asyncio, os, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')); page=await b.new_page(viewport={'width':1500,'height':1000})
        errs=[]; page.on('pageerror',lambda e:errs.append(str(e)))
        await page.goto(f'http://127.0.0.1:{sys.argv[1]}/index.html'); await page.wait_for_selector('.page')
        await page.evaluate("""async()=>{await api('settings',{method:'PUT',body:{developer_mode:true}});app.preferences=await api('settings');}""")
        await page.evaluate("openNodeEditor(null,'')"); await page.wait_for_timeout(2500)
        await page.evaluate("select(['frame:'+W.snapshot.root]);Inspector.toggle(true);Inspector.show()"); await page.wait_for_timeout(700)
        # name the slots through the real controls
        await page.wait_for_selector('[data-add=inputs]')
        await page.get_by_role('button', name='Add input').click()
        await page.get_by_role('button', name='Add output').click()
        await page.locator('[data-direction=inputs] [data-field=name]').fill('a')
        await page.locator('[data-direction=outputs] [data-field=name]').fill('out')
        await page.locator('input[name=arbitrary_inputs]').check()
        await page.wait_for_timeout(1500)
        pr=await page.evaluate("(async()=>{const pr=await api('projects',{method:'POST',body:{name:'T'}});return pr.id})()")
        await page.evaluate(f"go('/p/{pr}/w/{pr}')"); await page.wait_for_timeout(900)
        await page.evaluate("loadLibrary()"); await page.wait_for_timeout(300)
        await page.evaluate("(async()=>{const item=(app.resources||[]).find(()=>true); const r=await api(`projects/${W.project}/custom-nodes/${item.id}`,{method:'POST',body:wf({point:{x:100,y:100}}),edit:editToken()}); await reload(); select(pastedSelection(r));})()")
        await page.wait_for_timeout(800)
        await page.get_by_role('button', name='Add input').click()
        await page.locator('#own-inputs [data-field=name]').fill('extra')
        await page.wait_for_timeout(1500)
        assert await page.evaluate("JSON.stringify(W.snapshot.complex[0].interface.inputs.map(p=>[p.name,!!p.extra]))")=='[["a",false],["extra",true]]'
        assert await page.locator('.node').count()==1
        # the values reach the slots through wires from two nodes that give 4 and 10
        await page.evaluate("""(async()=>{
          const make=(value,x)=>api(`projects/${W.project}/typed-nodes`,{method:'POST',body:wf({node_type:'custom',config:{title:'Value '+value,inputs:[],outputs:[{id:'v',name:'v'}]},position:{x,y:0}})});
          const first=await make(4,-300), second=await make(10,-300), cx=W.snapshot.complex[0], [a,extra]=cx.interface.inputs.map(p=>p.id);
          await api(`projects/${W.project}/port-connections`,{method:'POST',body:wf({add:[{source:first.id,source_port:'v',target:'complex:'+cx.id,target_port:a},{source:second.id,source_port:'v',target:'complex:'+cx.id,target_port:extra}]})});
          await reload();
        })()"""); await page.wait_for_timeout(800)
        assert await page.evaluate("W.snapshot.edges.length")==2
        assert not errs, errs
        print('PASS slots of a Custom Node: group editor, own slots on a placed node, wires'); await b.close()
asyncio.run(main())
