"""Canvas edit latency with a minimal execution engine, using disposable file-backed data."""
import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def check(base, directory):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(15000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard')
        await page.evaluate("""async () => {
          app.preferences = await api('settings',{method:'PUT',body:{developer_mode:true}});
          const p = await api('projects',{method:'POST',body:{name:'Latency'}});
          const node = await api(`projects/${p.id}/primitives`,{method:'POST',body:{primitive:'script',point:{x:0,y:0}}});
          await go(`/p/${p.id}/w/${p.id}`);
          window.targetNode = node.id;
          select([node.id]);
        }""")
        await page.wait_for_timeout(500)
        await page.evaluate("""() => {
          const original = api;
          window.editCalls = [];
          api = async (path, options) => {
            const start=performance.now();
            try {return await original(path, options);}
            finally {editCalls.push({path,method:options?.method??'GET',ms:performance.now()-start});}
          };
          window.deletedAt = 0;
          window.deleteObserver = new MutationObserver(() => {
            if (!document.querySelector(`[data-id="${targetNode}"]`)) deletedAt ||= performance.now();
          });
          deleteObserver.observe(document.querySelector('#nodes'),{childList:true,subtree:true});
        }""")
        await page.locator('#canvas').focus()
        await page.evaluate('window.deleteStarted = performance.now()')
        await page.keyboard.press('Delete')
        try:
            await page.wait_for_function('deletedAt > 0', timeout=4000)
        except Exception:
            print('Delete diagnostic:',await page.evaluate('({selected:[...W.selected],calls:editCalls,active:document.activeElement?.outerHTML,nodes:W.snapshot.nodes.map(n=>n.id)})'),errors,flush=True)
            raise
        await page.wait_for_timeout(400)
        result = await page.evaluate('({deleteMs:deletedAt-deleteStarted,calls:editCalls})')
        print('canvas deletion', json.dumps(result), flush=True)
        assert result['calls'][0]['path'].endswith('/batch'), result
        assert len([c for c in result['calls'] if c['method'] != 'GET']) == 1, result
        assert not any(c['path'].endswith('/policy') for c in result['calls']), result
        assert len([c for c in result['calls'] if c['path'].endswith('/workflow')]) <= 2, result
        await page.evaluate('undo(false)')
        await page.wait_for_function('W.nodes.has(targetNode)')
        await page.evaluate("""async () => {
          const added = await api(`projects/${W.project}/batch`, {method:'POST',body:wf({operations:
            Array.from({length:5},(_,i)=>({path:'typed-nodes',method:'POST',body:{node_type:'custom',
              config:{title:'Node '+i,inputs:[],outputs:[]},position:{x:i*160,y:150}}}))
          })});
          window.groupNodes = added.results.map(n=>n.id);
          window.parentGroup = uid(); window.childGroup = uid();
          await api(`projects/${W.project}/groups`,{method:'PUT',body:wf({groups:[
            {id:parentGroup,name:'Outer',parent:null,members:[groupNodes[0]]},
            {id:childGroup,name:'Inner',parent:parentGroup,members:[groupNodes[1]]}
          ]})});
          await reload();
          select(['frame:'+parentGroup,'frame:'+childGroup,groupNodes[1],groupNodes[2]]);
          editCalls.length=0;
          await deleteSelection();
          if(groupNodes.slice(0,3).some(id=>W.nodes.has(id)))throw Error('Mixed deletion missed nodes');
          if(!groupNodes.slice(3).every(id=>W.nodes.has(id)))throw Error('Mixed deletion removed unrelated nodes');
          if(editCalls.filter(c=>c.method!=='GET').length!==1)throw Error('Mixed deletion was not one commit');
          await undo(false);
          if(!groupNodes.every(id=>W.nodes.has(id))||!W.groups.has(parentGroup)||!W.groups.has(childGroup))
            throw Error('A single Undo did not restore the full deletion');
          select(groupNodes); editCalls.length=0;
          await setDisabled(switchableItems(),true);
          if(editCalls.filter(c=>c.method!=='GET').length!==1)throw Error('Bulk disable was not one commit');
          await undo(false);
          if(groupNodes.some(id=>W.nodes.get(id).disabled))throw Error('Bulk disable did not undo together');
          const previousApi=api;
          let release, captured, held=false, reads=0;
          const gate=new Promise(resolve=>release=resolve), ready=new Promise(resolve=>captured=resolve);
          api=async(path,options)=>{
            if(path.endsWith('/workflow'))reads++;
            const result=await previousApi(path,options);
            if(path.endsWith('/workflow')&&!held){held=true;captured();await gate;}
            return result;
          };
          try {
            const older=reload(); await ready;
            await api(`projects/${W.project}/node-title`,{method:'PUT',body:wf({node_id:groupNodes[3],title:'Fresh title'})});
            const newer=reload();
            await new Promise(resolve=>setTimeout(resolve,20));
            if(reads!==1)throw Error('Concurrent reloads started duplicate graph requests');
            release(); await Promise.all([older,newer]);
            if(W.nodes.get(groupNodes[3]).config.title!=='Fresh title')throw Error('An old response replaced the newer edit');
          } finally {release();api=previousApi;}
        }""")
        assert not errors, errors
        await browser.close()
        print('PASS bounded requests, mixed deletion, single-step Undo, bulk styles and coalesced reloads without stale state', flush=True)


if __name__ == '__main__':
    with isolated_server() as (base, directory):
        asyncio.run(check(base, directory))
