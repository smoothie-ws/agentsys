"""MVP integration: plugin-owned Providers and a single controllable graph execution."""
import asyncio
import os
import http.server
import json
import threading
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def audit(base, models_url):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width':1500, 'height':1000})
        page.set_default_timeout(10000)
        errors=[]
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base+'/editor/')
        await page.wait_for_selector('.dashboard')
        assert await page.locator('a[data-link]').filter(has_text='Runs').count() == 0
        await page.evaluate("go('/library/ai.ai')")
        assert await page.locator('#view .card h3').all_text_contents() == ['Providers']
        await page.locator('.card-main').filter(has_text='Providers').click()
        await page.locator('.page-head [data-menu]').click()
        await page.get_by_role('menuitem',name='New Provider',exact=True).click()
        for name,value in [('item_name','Local'),('value_providerId','local'),('value_baseURL','http://localhost:11434/v1'),('value_apiKey','private-key')]:
            await page.locator('#modal [name='+name+']').fill(value)
        await page.locator('#modal-actions button[type=submit]').click()
        await page.evaluate("api('plugins/ai',{method:'PUT',body:{grants:['net.fetch:*']}})")
        await page.locator('.card-main').filter(has_text='Local').click()
        await page.wait_for_selector('#catalog-item-form')
        assert await page.locator('#catalog-item-form [name=value_models]').count()==0
        await page.locator('#catalog-item-form [name=value_baseURL]').fill(models_url)
        await page.wait_for_function("document.querySelector('[data-catalog-list=models]')?.textContent.includes('test-model')")
        await page.locator('#catalog-item-form [data-list-refresh=models]').click()
        await page.wait_for_function("document.querySelector('[data-catalog-list=models]')?.textContent.includes('test-model')")
        assert 'private-key' not in str(await page.evaluate("api('library/sections/ai.providers/items')"))
        print('PASS AI plugin exposes only Providers and keeps credentials separate',flush=True)
        empty_project=await page.evaluate("async()=>{const p=await api('projects',{method:'POST',body:{name:'Empty graph'}});await go(`/p/${p.id}/w/${p.id}`);return p.id;}")
        await page.wait_for_selector('#canvas')
        await page.locator('#start').click()
        await page.wait_for_function('W.executionReady && !W.executionCommand && !W.running')
        empty=await page.evaluate("id=>api(`projects/${id}/execution`)",empty_project)
        assert empty['status']=='idle' and empty['evaluated_nodes']==0
        print('PASS Run without on_run leaves the graph idle',flush=True)
        ids=await page.evaluate("""async()=>{
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const p=await api('projects',{method:'POST',body:{name:'MVP flow'}});
          const types=(await api(`projects/${p.id}/types`)).types;
          const numberType=types.find(t=>t.control==='number').id,codeType=types.find(t=>t.control==='code').id;
          const make=config=>api(`projects/${p.id}/typed-nodes`,{method:'POST',body:{node_type:'custom',config,position:{x:0,y:0}}});
          const start=await make({title:'Start',op:'on_run',inputs:[],outputs:[{id:'out',name:'out',type:'signal'}]});
          const duration=await make({title:'Duration',inputs:[],outputs:[{id:'value',name:'value',type:'t:'+numberType,editable:true,default:450}]});
          const script=await make({title:'Finished',op:'script',inputs:[{id:'in',name:'in',type:'signal'},{id:'script',name:'script',type:'t:'+codeType,default:'node.display("MVP finished");'}],outputs:[{id:'out',name:'out',type:'signal'}]});
          const resources=await api('resources');
          if(resources.some(r=>r.payload.folder==='Streams'||r.name==='Wait for event'))throw Error('Removed catalog nodes still exist');
          const resource=resources.find(r=>r.name==='Delay');
          const delayOutput=resource.payload.bundle.complex[0].interface.outputs.find(p=>p.name==='out').id;
          const delay=await api(`projects/${p.id}/custom-nodes/${resource.id}`,{method:'POST',body:{point:{x:300,y:0}}});
          const wrapper='complex:'+delay.roots[0];
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[
            {source:start.id,source_port:'out',target:wrapper,target_port:'in'},
            {source:duration.id,source_port:'value',target:wrapper,target_port:'ms'},
            {source:wrapper,source_port:delayOutput,target:script.id,target_port:'in'}]}});
          return {project:p.id,script:script.id};
        }""")
        await page.evaluate("id=>go(`/p/${id}/w/${id}`)",ids['project'])
        await page.wait_for_selector('#canvas')
        assert await page.locator('[data-side-tab]').evaluate_all('els=>els.map(e=>e.dataset.sideTab)') == ['workflow','properties']
        await page.locator('#start').click()
        await page.wait_for_function('W.running')
        await page.locator('#pause').click()
        await page.wait_for_function('W.runPaused')
        await page.wait_for_timeout(600)
        assert await page.locator('#start').inner_text() == 'Run'
        assert await page.evaluate('W.running')
        statuses=await page.evaluate("""async id=>{
          await api(`projects/${W.project}/node-title`,{method:'PUT',body:wf({node_id:id,title:'Renamed during execution'})});
          await reload();
          return W.runStatus.size;
        }""",ids['script'])
        assert statuses>0, 'Editing the live graph must not clear active execution statuses'
        await page.locator('#pause').click()
        await page.wait_for_function('!W.running')
        assert await page.evaluate('id=>W.results.get(id)?.text',ids['script']) == 'MVP finished'
        print('PASS Delay remains active, manual pause/resume and downstream signals complete',flush=True)
        await page.locator('#start').click()
        await page.locator('#stop').click()
        await page.wait_for_function('!W.running')
        await page.wait_for_timeout(550)
        assert await page.evaluate('id=>W.results.get(id)?.text',ids['script']) == 'MVP finished'
        current=await page.evaluate("id=>api(`projects/${id}/execution`)",ids['project'])
        assert current['status']=='idle'
        print('PASS immediate Stop cancels the execution and pending Delay',flush=True)
        await page.reload()
        await page.wait_for_selector('#canvas')
        await page.wait_for_function('W.executionReady')
        assert await page.evaluate('id=>W.results.get(id)?.text',ids['script']) == 'MVP finished'
        await page.set_viewport_size({'width':390,'height':844})
        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await page.evaluate("go('/api')")
        await page.wait_for_selector('#api-method-search')
        assert not errors,errors
        print('PASS persisted graph previews, mobile canvas and API; no page errors',flush=True)
        await browser.close()


if __name__=='__main__':
    class Models(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path=='/v1/models'
            assert self.headers.get('Authorization')=='Bearer private-key'
            body=json.dumps({'data':[{'id':'test-model'}]}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
        def log_message(self,*args):pass
    model_server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Models)
    threading.Thread(target=model_server.serve_forever,daemon=True).start()
    try:
        with isolated_server() as (base,_):
            asyncio.run(audit(base,f'http://127.0.0.1:{model_server.server_port}/v1'))
    finally:
        model_server.shutdown();model_server.server_close()
