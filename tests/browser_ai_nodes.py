"""Real canvas Provider/Model selectors and Ask with an isolated HTTP model service."""
import asyncio
import http.server
import json
import os
import threading
from playwright.async_api import async_playwright
from browser_server import isolated_server

async def check(base,model_base):
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page=await browser.new_page(viewport={'width':1800,'height':1100})
        page.set_default_timeout(15000)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto(base+'/editor/');await page.wait_for_selector('.dashboard')
        ids=await page.evaluate("""async modelBase=>{
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const plugin=await api('plugins/ai');await api('plugins/ai',{method:'PUT',body:{grants:plugin.manifest.permissions}});
          const records=[];for(const name of ['one','two'])records.push(await api('library/sections/ai.providers/items',{method:'POST',body:{name,values:{providerId:name,baseURL:modelBase+'/'+name+'/v1',apiKey:'test-key'}}}));
          const p=await api('projects',{method:'POST',body:{name:'AI canvas'}});
          await api(`projects/${p.id}/policy`,{method:'PUT',body:{allow:plugin.manifest.permissions}});
          const put=async(name,point)=>{const resource=(await api('resources')).find(r=>r.name===name);const placed=await api(`projects/${p.id}/custom-nodes/${resource.id}`,{method:'POST',body:{point}});return {id:'complex:'+placed.roots[0],resource};};
          const provider=await put('Provider',{x:0,y:0}),model=await put('Model',{x:350,y:0}),ask=await put('Ask',{x:700,y:0}),preview=await put('Preview',{x:1100,y:0});
          const start=await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'event',point:{x:350,y:500}}});
          const port=(r,side,name)=>r.payload.bundle.complex.find(c=>!r.payload.bundle.groups.find(g=>g.id===c.id).parent).interface[side].find(p=>p.name===name).id;
          await api(`projects/${p.id}/port-connections`,{method:'POST',body:{add:[
            {source:provider.id,source_port:'id',target:model.id,target_port:'provider'},
            {source:provider.id,source_port:'id',target:ask.id,target_port:'provider'},
            {source:provider.id,source_port:'url',target:ask.id,target_port:'url'},
            {source:model.id,source_port:'model',target:ask.id,target_port:'model'},
            {source:start.id,source_port:'out',target:ask.id,target_port:'in'},
            {source:ask.id,source_port:'out',target:preview.id,target_port:port(preview.resource,'inputs','in')},
            {source:ask.id,source_port:'response',target:preview.id,target_port:port(preview.resource,'inputs','input')}
          ]}});
          await api(`projects/${p.id}/input-values`,{method:'PUT',body:{node_id:ask.id,values:{prompt:'Hello canvas'}}});
          await go(`/p/${p.id}/w/${p.id}`);
          return {project:p.id,provider:provider.id,model:model.id,ask:ask.id,preview:preview.id,second:records[1].id};
        }""",model_base)
        await page.wait_for_selector('#canvas')
        provider_select=page.locator(f'[data-id="{ids["provider"]}"] select[data-literal=provider]')
        model_select=page.locator(f'[data-id="{ids["model"]}"] select[data-literal=model]')
        try:
            await page.wait_for_function("() => [...document.querySelectorAll('select[data-literal=model] option')].some(o=>o.textContent==='one-model')")
        except Exception:
            print(await page.evaluate("async()=>({hooks:await api('node-hooks'),stored:(await api(`projects/${W.project}/workflow`)).widgets,visible:W.snapshot.widgets})"),flush=True)
            raise
        await provider_select.select_option(label='two')
        await page.wait_for_function("() => [...document.querySelectorAll('select[data-literal=model] option')].some(o=>o.textContent==='two-model')")
        assert await model_select.locator('option').all_text_contents()==['two-model']
        await page.locator('#start').click();await page.wait_for_function('W.executionId && !W.running')
        current=await page.evaluate('api(`projects/${W.project}/execution`)')
        assert current['status']=='completed',current['errors']
        assert 'Reply from two-model' in await page.locator(f'[data-id="{ids["preview"]}"]').inner_text()
        await page.reload();await page.wait_for_selector('#canvas')
        assert await provider_select.locator('option:checked').inner_text()=='two'
        assert await model_select.locator('option:checked').inner_text()=='two-model'
        # Plugin graph nodes use the ordinary Library menus and editor.
        await page.evaluate("go(folderHref('AI'))")
        provider_card=page.locator('#view article.card').filter(has=page.locator('h3',has_text='Provider'))
        assert await provider_card.get_attribute('draggable')=='true'
        assert await provider_card.locator('a.card-main').count()==1
        await provider_card.locator('[data-menu]').click()
        assert await page.get_by_role('menuitem',name='Rename',exact=True).count()==1
        assert await page.get_by_role('menuitem',name='Delete',exact=True).count()==1
        await page.get_by_role('menuitem',name='Edit graph',exact=True).click()
        await page.wait_for_function("W.library && W.project==='lib-plugin.ai.provider'")
        await page.locator('[data-side-tab=workflow]').click()
        permissions=page.locator('#library-permissions')
        await permissions.wait_for()
        await permissions.get_by_role('radio',name='Allow run.read',exact=True).click()
        await page.evaluate("go('/projects')")
        changed=await page.evaluate("api('resources/plugin.ai.provider')")
        assert 'run.read' in changed['payload']['grants']
        assert 'plugin' not in changed['payload']
        await page.evaluate("""async()=>{
          await api('plugins/ai',{method:'PUT',body:{enabled:false}});
          await api('plugins/ai',{method:'PUT',body:{enabled:true}});
        }""")
        assert await page.evaluate("api('resources/plugin.ai.provider')")==changed
        await page.evaluate("go(resourceHref({id:'plugin.ai.provider'}))")
        await page.wait_for_selector('#canvas')
        graph_edit=await page.evaluate("""async()=>{
          const script=W.snapshot.nodes.find(n=>n.kind==='function');
          await api(`projects/${W.project}/node-title`,{method:'PUT',body:wf({node_id:script.id,title:'My Provider script'})});
          return api('resources/plugin.ai.provider');
        }""")
        assert any(r['payload'].get('config',{}).get('title')=='My Provider script' for r in graph_edit['payload']['bundle']['records'])
        await page.reload();await page.wait_for_selector('#canvas')
        assert await page.evaluate("W.snapshot.nodes.some(n=>n.config?.title==='My Provider script')")
        print('PASS plugin nodes have editable cards, menus, default permissions and persistent graph edits')
        assert not errors,errors
        await browser.close()
        print('PASS AI selectors initialize, follow provider changes, Ask returns model text and selections persist')

if __name__=='__main__':
    class ModelAPI(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.headers.get('Authorization')=='Bearer test-key'
            name=self.path.split('/')[1]
            self.send({'data':[{'id':name+'-model'}]})
        def do_POST(self):
            assert self.headers.get('Authorization')=='Bearer test-key'
            data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert data['messages']==[{'role':'user','content':'Hello canvas'}]
            self.send({'choices':[{'message':{'content':'Reply from '+data['model']}}]})
        def send(self,data):
            body=json.dumps(data).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
        def log_message(self,*args):pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),ModelAPI)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with isolated_server() as (base,_):asyncio.run(check(base,f'http://127.0.0.1:{server.server_port}'))
    finally:server.shutdown();server.server_close()
