"""Browser checks for durable runs against a Node server with a disposable data directory."""
import asyncio, json, os, sys, subprocess, tempfile
from pathlib import Path
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else None

async def wait_api(page, expression, arg):
    # wait_for_function polls synchronously: a Promise itself is already truthy.
    deadline = asyncio.get_running_loop().time() + 30
    while asyncio.get_running_loop().time() < deadline:
        if await page.evaluate(expression, arg):
            return
        await page.wait_for_timeout(25)
    raise AssertionError('API condition did not become true: ' + expression)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE + '/editor/')
        await page.wait_for_function("typeof app!=='undefined' && app.route && document.querySelector('#view').children.length")
        await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(s=>{app.preferences=s})")
        # The Worker of a real browser leaks no network or messaging API to node code.
        probe = await page.evaluate("""async()=>{
          const code='const names=["fetch","indexedDB","BroadcastChannel","WebTransport","importScripts","postMessage"];const leaked=[];for(let p=globalThis;p;p=Object.getPrototypeOf(p))for(const name of names)if(typeof p[name]!=="undefined")leaked.push(name);node.display(JSON.stringify(leaked));';
          const plan={nodes:[{id:'probe',label:'Browser Worker',kind:'custom',op:'script',running:true,prefix:'Script',inputs:[{id:'script',name:'script',code:true,has:true,fallback:code}],outputs:[],preset:{},targets:{},context:{}}],roots:[{id:'probe',node:true}],context:{},limits:planLimits()};
          const result=await runPlanned(plan,runPlan);return {display:result.displays.probe,errors:result.errors};
        }""")
        assert probe.get('display') == '[]', probe
        packet = json.loads(Path('examples/wait-nodes.json').read_text(encoding='utf-8'))
        await page.evaluate("packet=>addEntries(TextGraph.decode(packet),'Browser fixture')", packet)
        ids = await page.evaluate("""async()=>{
          const p=await api('projects',{method:'POST',body:{name:'Browser durable run'}});
          const wait=(await api('resources')).filter(r=>r.name==='Wait for event').sort((a,b)=>b.updated-a.updated)[0];
          const placed=await api(`projects/${p.id}/custom-nodes/${wait.id}`,{method:'POST',body:{point:{x:0,y:0}}});
          const node='complex:'+placed.roots[0];
          await api(`projects/${p.id}/input-values`,{method:'PUT',body:{node_id:node,values:{event:'browser-go'}}});
          const e=await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'event',point:{x:-300,y:0}}});
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[{source:e.id,source_port:'out',target:node,target_port:'in'}]}});
          const run=await api(`projects/${p.id}/runs`,{method:'POST',body:{wait:2}});
          return {p:p.id,run:run.id,status:run.status};
        }""")
        assert ids['status'] == 'waiting', ids
        # A new page sees the server-owned wait after the original page closes.
        await page.close()
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE + '/editor/p/' + ids['p'] + '/w/' + ids['p'])
        await page.wait_for_selector('#canvas .s-waiting .run-state.waiting')
        assert await page.locator('#wait-resume').is_visible()
        await page.locator('#wait-resume').click()
        await page.wait_for_selector('.run-intervention [data-wait-key] textarea')
        await page.locator('.run-intervention [data-close]').click()
        await page.evaluate("go('/runs')")
        await page.wait_for_selector('[data-run="' + ids['run'] + '"]')
        assert 'browser-go' in await page.locator('[data-run="' + ids['run'] + '"]').inner_text()
        # Answering the event wait from outside continues the run.
        await page.locator('[data-run="' + ids['run'] + '"] [data-run-action="trace"]').click()
        payload_form = page.locator('#runs-intervention [data-wait-key]').first
        await payload_form.locator('textarea').fill('{')
        await payload_form.locator('button').click()
        await page.wait_for_selector('#runs-intervention [data-intervention-error]:not([hidden])')
        assert (await page.evaluate("id=>api('runs/'+id)", ids['run']))['status'] == 'waiting'
        await payload_form.locator('textarea').fill('{"value":1}')
        await payload_form.locator('button').click()
        await wait_api(page, "async id => (await api('runs/'+id)).status==='completed'", ids['run'])
        await page.locator('#runs-refresh').click()
        try:
            await page.wait_for_function("id => document.querySelector('[data-run=\"'+id+'\"]')?.textContent.includes('completed')", arg=ids['run'])
        except Exception:
            print('Runs refresh diagnostic:', await page.locator('#view').inner_text(), 'Page errors:', errors)
            raise
        # A delayed previous load cannot overwrite a newer activation snapshot.
        await page.evaluate("""async id=>{
          const original=api;let release,ready,delayed=false;
          const gate=new Promise(resolve=>release=resolve),captured=new Promise(resolve=>ready=resolve);
          api=async(path,options)=>{
            const result=await original(path,options);
            if(path==='runs'&&!delayed){delayed=true;ready();await gate;return result.map(r=>r.id===id?{...r,status:'stale'}:r);}
            return result;
          };
          try{const older=render();await captured;await render();release();await older;}
          finally{release();api=original;}
        }""",ids['run'])
        assert 'completed' in await page.locator('[data-run="' + ids['run'] + '"]').inner_text()
        # Autonomous workflow policy is durable and independent of a single activation.
        form = page.locator('[data-workflow-control="' + ids['p'] + '"]')
        await form.locator('[data-workflow-status-action="paused"]').click()
        await page.wait_for_function("id => document.querySelector('[data-workflow-control=\"'+id+'\"] [data-workflow-status]')?.textContent.includes('paused')", arg=ids['p'])
        await page.locator('[data-workflow-control="' + ids['p'] + '"] [data-workflow-status-action="enabled"]').click()
        await page.wait_for_function("id => document.querySelector('[data-workflow-control=\"'+id+'\"] [data-workflow-status]')?.textContent.includes('enabled')", arg=ids['p'])
        form = page.locator('[data-workflow-control="' + ids['p'] + '"]')
        await form.locator('[name="max_attempts"]').fill('2')
        await form.locator('button[type="submit"], button:not([type])').first.click()
        await wait_api(page, "async id => (await api('workflows/'+id+'/control')).max_attempts===2", ids['p'])
        await page.locator('[data-workflow-control="' + ids['p'] + '"] [data-workflow-inspect]').click()
        await page.wait_for_function("id => document.querySelector('[data-workflow-control=\"'+id+'\"] [data-workflow-data]')?.textContent.includes('usage')", arg=ids['p'])
        await page.select_option('#version-workflow', ids['p'])
        await page.wait_for_selector('[data-diff]')
        await page.locator('[data-diff]').first.click()
        await page.wait_for_function("document.querySelector('#runs-diff').textContent.length>0")
        await page.locator('[data-run="' + ids['run'] + '"] [data-run-action="trace"]').click()
        await page.wait_for_selector('#runs-nodes code[title]')
        assert await page.locator('#runs-nodes').inner_text() and 'Version at start' in await page.locator('#runs-nodes').inner_text()
        assert await page.locator('#runs-nodes code').first.get_attribute('title')
        await page.locator('[data-run="' + ids['run'] + '"] [data-run-action="replay"]').click()
        await page.wait_for_timeout(300)
        # The real canvas client permits graph edits while following a server-owned activation.
        live = await page.evaluate("""async()=>{
          const p=await api('projects',{method:'POST',body:{name:'Browser live graph'}});
          const event=await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'event',point:{x:0,y:0}}});
          const script=await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'script',point:{x:300,y:0}}});
          const snapshot=await api(`projects/${p.id}/workflow`);
          const config=snapshot.nodes.find(n=>n.id===script.id).config;
          config.inputs.find(p=>p.id==='script').default='await new Promise(r=>setTimeout(r,1200));node.display("old");';
          await api(`projects/${p.id}/typed-nodes/${script.id}`,{method:'PUT',body:{node_type:'custom',config}});
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[{source:event.id,source_port:'out',target:script.id,target_port:'in'}]}});
          return {p:p.id,script:script.id};
        }""")
        await page.evaluate("id=>go('/p/'+id+'/w/'+id)", live['p'])
        await page.wait_for_selector('#canvas [data-id="' + live['script'] + '"]')
        await page.locator('#start').click()
        await page.wait_for_function("typeof W!=='undefined' && W.running && W.runId")
        live_run = await page.evaluate('W.runId')
        await wait_api(page,"async ids=>(await api('runs/'+ids.run+'/events')).events.some(e=>e.type==='node_started'&&e.node_id===ids.script)",{'run':live_run,'script':live['script']})
        await page.evaluate("""async ids=>{
          if(!W.running)throw Error('Canvas stopped before edit');
          const snapshot=await api(`projects/${ids.p}/workflow`),config=snapshot.nodes.find(n=>n.id===ids.script).config;
          config.inputs.find(p=>p.id==='script').default='node.display("new");';
          await api(`projects/${ids.p}/typed-nodes/${ids.script}`,{method:'PUT',body:{node_type:'custom',config}});
          const fields=[...document.querySelectorAll('.editor .side input,.editor .side textarea')];
          if(fields.some(el=>getComputedStyle(el).pointerEvents==='none'))throw Error('Inspector was disabled while running');
        }""",live)
        await wait_api(page,"async id=>(await api('runs/'+id)).status==='completed'",live_run)
        first = await page.evaluate("id=>api('runs/'+id)",live_run)
        assert first['displays'][live['script']] == 'old', first
        second = await page.evaluate("id=>api('projects/'+id+'/runs',{method:'POST',body:{wait:2}})",live['p'])
        assert second['displays'][live['script']] == 'new', second
        old_version = next(n['node_version'] for n in first['nodes'] if n['node_id']==live['script'])
        new_version = next(n['node_version'] for n in second['nodes'] if n['node_id']==live['script'])
        assert len(old_version)==64 and old_version!=new_version
        await page.wait_for_function('!W.running')
        await page.evaluate("""async ids=>{
          const snapshot=await api(`projects/${ids.p}/workflow`),config=snapshot.nodes.find(n=>n.id===ids.script).config;
          config.capabilities=['graph.write'];config.grants=[];
          await api(`projects/${ids.p}/typed-nodes/${ids.script}`,{method:'PUT',body:{node_type:'custom',config}});
          await reload();
        }""",live)
        await page.locator('#start').click()
        await page.wait_for_selector('#canvas .s-blocked .run-state.blocked')
        assert 'Blocked' in await page.locator('#canvas .s-blocked .run-state.blocked').first.get_attribute('aria-label')
        # Replace a failed invocation through the form, explicitly choosing its previously unfired signal.
        definition = json.loads(subprocess.check_output(['node','-e',r'''const {bundleOf,nodes}=require('./tests/harness');const make=(name,code,inputs,outputs)=>bundleOf(name,{Script:{...nodes.script(code),capabilities:[],grants:[]}},{inputs:[{id:'in',name:'In',type:'signal',node:'Script',port:'in'},...inputs.map(n=>({id:n,name:n,node:false}))],outputs:outputs.map(n=>({id:n,name:n,node:false,...(n==='Out'?{type:'signal'}:{})}))});console.log(JSON.stringify([make('Browser replace source','throw Error("replace me");',[],['value','Out']),make('Browser replace consumer','node.display(node.input.value*2);',['value'],[])]));'''],text=True))
        intervention = await page.evaluate("""async defs=>{
          const p=await api('projects',{method:'POST',body:{name:'Browser intervention'}}),placed=[];
          for(const def of defs){const r=await api('resources',{method:'POST',body:{name:def.name,payload:{bundle:def.bundle,capabilities:[],grants:[]}}});const copy=await api(`projects/${p.id}/custom-nodes/${r.id}`,{method:'POST',body:{point:{x:placed.length*300,y:0}}});placed.push('complex:'+copy.roots[0]);}
          const event=await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'event',point:{x:-300,y:0}}});
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[{source:event.id,source_port:'out',target:placed[0],target_port:'in'},{source:placed[0],source_port:'Out',target:placed[1],target_port:'in'},{source:placed[0],source_port:'value',target:placed[1],target_port:'value'}]}});
          const source=await api(`projects/${p.id}/runs`,{method:'POST',body:{wait:2}});
          const invocation=source.invocations.find(i=>i.label==='Script'&&i.status==='failed'&&i.signals.includes('Out')).invocation;
          return {p:p.id,source:source.id,invocation};
        }""",definition)
        await page.evaluate("go('/runs')")
        await page.wait_for_selector('[data-run="'+intervention['source']+'"]')
        await page.locator('[data-run="'+intervention['source']+'"] [data-run-action="trace"]').click()
        output_form=page.locator('#runs-intervention [data-output-replacement]')
        await output_form.locator('select[name=invocation]').select_option(intervention['invocation'])
        await output_form.locator('textarea[name=output]').fill('{"value":21}')
        signal=output_form.locator('input[name=signal][value=Out]')
        assert not await signal.is_checked()
        await signal.check()
        await output_form.locator('button[type=submit]').click()
        await wait_api(page,"async id=>(await api('runs')).some(r=>r.restarted_from===id&&r.status==='completed')",intervention['source'])
        restarted=await page.evaluate("async id=>{const r=(await api('runs')).find(r=>r.restarted_from===id);return api('runs/'+r.id)}",intervention['source'])
        assert '42' in restarted['displays'].values(),restarted
        # Cancel a durable waiting wave through the same management panel.
        wave_run=await page.evaluate("id=>api('projects/'+id+'/runs',{method:'POST',body:{wait:2}})",ids['p'])
        assert wave_run['status']=='waiting'
        await page.locator('#runs-refresh').click()
        await page.wait_for_selector('[data-run="'+wave_run['id']+'"]')
        await page.locator('[data-run="'+wave_run['id']+'"] [data-run-action="trace"]').click()
        await page.locator('#runs-intervention [data-cancel-wave="run"]').click()
        await wait_api(page,"async id=>(await api('runs/'+id)).status==='completed'",wave_run['id'])
        assert not errors, errors
        await browser.close()
        print('PASS: Worker isolation, page-close durability, event answer, stale refresh protection, workflow pause/resume and policy, state/queues/usage, Runs version table, editing an active canvas, per-start versions, history, diff, replay, event payload validation, output replacement with explicit signals, wave cancellation; no page errors')
if BASE:
    asyncio.run(main())
else:
    with tempfile.TemporaryDirectory(prefix='agentsys-runs-ui-') as directory:
        target = Path(directory).resolve()
        env = {**os.environ, 'AGENTSYS_BROWSER_DATA': str(target)}
        source = "const app=require('./server').createServer({dataDir:process.env.AGENTSYS_BROWSER_DATA});app.listen(0).then(url=>console.log(JSON.stringify({url}))).catch(e=>{console.error(e);process.exit(1)});"
        process = subprocess.Popen(['node', '-e', source], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            line = process.stdout.readline()
            if not line: raise RuntimeError(process.stderr.read())
            BASE = json.loads(line)['url']
            asyncio.run(main())
        finally:
            process.terminate()
            process.wait(timeout=10)
