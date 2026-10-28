"""Roadmap browser checks against a Node server with a disposable data directory."""
import asyncio, json, os, sys, shutil, subprocess, tempfile
from pathlib import Path
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/') if len(sys.argv)>1 else None
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width':1440,'height':1000})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto(BASE+'/editor/')
        await page.wait_for_function("typeof app!=='undefined' && app.route && document.querySelector('#view').children.length")
        await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(s=>{app.preferences=s})")
        probe=await page.evaluate("""async()=>{
          const code='const names=["fetch","indexedDB","BroadcastChannel","WebTransport","importScripts","postMessage"];const leaked=[];for(let p=globalThis;p;p=Object.getPrototypeOf(p))for(const name of names)if(typeof p[name]!=="undefined")leaked.push(name);node.display(JSON.stringify(leaked));';
          const plan={nodes:[{id:'probe',label:'Browser Worker',kind:'custom',op:'script',running:true,prefix:'Script',inputs:[{id:'script',name:'script',code:true,has:true,fallback:code}],outputs:[],preset:{},targets:{},context:{}}],roots:[{id:'probe',node:true}],context:{},limits:planLimits()};
          const result=await runPlanned(plan,runPlan);return {display:result.displays.probe,errors:result.errors};
        }""")
        assert probe.get('display')=='[]',probe
        initiative=await page.evaluate("api('initiatives',{method:'POST',body:{title:'Browser initiative',goal:'Verify controller'}})")
        await page.evaluate("i=>api('initiatives/'+i+'/tasks',{method:'POST',body:{title:'Browser task'}})",initiative['id'])
        await page.evaluate("i=>api('initiatives/'+i+'/decisions',{method:'POST',body:{summary:'Browser decision',rationale:'Inspect the UI',made_by:'human'}})",initiative['id'])
        packet=json.loads(Path('examples/ai-nodes.json').read_text(encoding='utf-8'))
        await page.evaluate("packet=>addEntries(TextGraph.decode(packet),'Browser fixture')",packet)
        ids=await page.evaluate("""async()=>{
          const p=await api('projects',{method:'POST',body:{name:'Browser durable run'}});
          await api('projects/'+p.id+'/policy',{method:'PUT',body:{allow:['graph.read','approval.request']}});
          const ask=(await api('resources')).filter(r=>r.name.startsWith('Ask human')).sort((a,b)=>b.updated-a.updated)[0];
          const placed=await api(`projects/${p.id}/custom-nodes/${ask.id}`,{method:'POST',body:{point:{x:0,y:0}}});
          const node='complex:'+placed.roots[0];
          await api(`projects/${p.id}/input-values`,{method:'PUT',body:{node_id:node,values:{question:'Approve browser test?'}}});
          const e=await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'event',point:{x:-300,y:0}}});
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[{source:e.id,source_port:'out',target:node,target_port:'in'}]}});
          const run=await api(`projects/${p.id}/runs`,{method:'POST',body:{wait:2}});
          return {p:p.id,run:run.id,status:run.status,resource:ask.id};
        }""")
        assert ids['status']=='waiting',ids
        # A new page sees the server-owned wait after the original page closes.
        await page.close()
        page=await browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto(BASE+'/editor/p/'+ids['p']+'/w/'+ids['p'])
        await page.wait_for_selector('#canvas .s-waiting .run-state.waiting')
        assert await page.locator('#wait-resume').is_visible()
        await page.locator('#sidebar [data-section=controller]').click()
        await page.wait_for_selector('#controller-approvals [data-approval]')
        assert await page.locator('[data-run="'+ids['run']+'"]').inner_text()
        await page.locator('[data-initiative="'+initiative['id']+'"] summary').click()
        await page.get_by_text('Browser task',exact=False).wait_for()
        await page.get_by_text('Browser decision',exact=True).wait_for()
        approval_id=await page.evaluate("id=>api('approvals').then(list=>list.find(a=>a.run_id===id).id)",ids['run'])
        await page.locator('[data-approval="'+approval_id+'"] [data-answer="approve"]').click()
        await page.wait_for_function("async id => (await api('runs/'+id)).status==='completed'",arg=ids['run'])
        await page.locator('#controller-refresh').click()
        await page.wait_for_function("id => document.querySelector('[data-run=\"'+id+'\"]')?.textContent.includes('completed')",arg=ids['run'])
        assert 'completed' in await page.locator('[data-run="'+ids['run']+'"]').inner_text()
        await page.select_option('#version-workflow',ids['p'])
        await page.wait_for_selector('[data-diff]')
        await page.locator('[data-diff]').first.click()
        await page.wait_for_function("document.querySelector('#controller-diff').textContent.length>0")
        await page.locator('[data-run="'+ids['run']+'"] [data-run-action="replay"]').click()
        await page.wait_for_timeout(300)
        assert not errors,errors
        Path('docs').mkdir(exist_ok=True)
        await page.screenshot(path='docs/controller-preview.png',full_page=True)
        await browser.close()
        print('PASS: Controller, initiative tree, approval, page-close durability, history, diff, replay; no page errors')
if BASE:
    asyncio.run(main())
else:
    with tempfile.TemporaryDirectory(prefix='agentsys-controller-ui-') as directory:
        target=Path(directory).resolve()
        assert target.parent==Path(tempfile.gettempdir()).resolve() and target.name.startswith('agentsys-controller-ui-')
        shutil.copytree('data',target,dirs_exist_ok=True)
        env={**os.environ,'AGENTSYS_BROWSER_DATA':str(target)}
        source="const app=require('./server').createServer({dataDir:process.env.AGENTSYS_BROWSER_DATA});app.listen(0).then(url=>console.log(JSON.stringify({url}))).catch(e=>{console.error(e);process.exit(1)});"
        process=subprocess.Popen(['node','-e',source],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            line=process.stdout.readline()
            if not line: raise RuntimeError(process.stderr.read())
            BASE=json.loads(line)['url']
            asyncio.run(main())
        finally:
            process.terminate()
            process.wait(timeout=10)
