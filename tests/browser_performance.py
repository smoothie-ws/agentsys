"""Reproducible local measurements, not a pass/fail performance budget.
Uses a disposable file-backed server. Reports milliseconds and actual API requests.
"""
import asyncio
import json
import os
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def measure(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard')
        print('cold', json.dumps(await page.evaluate('''()=>({
            domContentLoaded:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
            resources:performance.getEntriesByType('resource').length,
            transferBytes:performance.getEntriesByType('resource').reduce((s,r)=>s+r.transferSize,0)
        })''')), flush=True)
        await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(v=>app.preferences=v)")
        pid = await page.evaluate("api('projects',{method:'POST',body:{name:'Benchmark'}}).then(p=>p.id)")
        await page.evaluate("id=>go(`/p/${id}/w/${id}`)", pid)
        for target, previous in [(100, 0), (500, 100), (1000, 500)]:
            await page.evaluate('''async ({pid,previous,target})=>{
                for(let i=previous;i<target;i+=200) await api(`projects/${pid}/batch`,{method:'POST',body:{
                    operations:Array.from({length:Math.min(200,target-i)},(_,j)=>({path:'typed-nodes',method:'POST',body:{
                        node_type:'custom',config:{title:'Node '+(i+j),inputs:[],outputs:[{id:'value',name:'value'}]},
                        position:{x:((i+j)%20)*260,y:Math.floor((i+j)/20)*160}
                    }}))
                }});
                await reload();
            }''', {'pid': pid, 'previous': previous, 'target': target})
            await page.wait_for_timeout(600)
            result = await page.evaluate('''async()=>{
                const reloads=[],draws=[];
                for(let i=0;i<5;i++){
                    let t=performance.now();await reload();reloads.push(performance.now()-t);
                    t=performance.now();draw();document.querySelector('#nodes').getBoundingClientRect();draws.push(performance.now()-t);
                }
                return {reloads,draws,domNodes:document.querySelectorAll('#nodes *').length,
                    heapBytes:performance.memory?.usedJSHeapSize};
            }''')
            print('graph', target, json.dumps(result), flush=True)
        await page.evaluate('''async()=>{for(let i=1;i<100;i++)await api('projects',{method:'POST',body:{name:'Project '+i}})}''')
        await page.evaluate("go('/projects')")
        await page.wait_for_timeout(600)
        requests = []
        listener = lambda request: requests.append(request.url) if '/api/' in request.url else None
        page.on('request', listener)
        elapsed = await page.evaluate("async()=>{const t=performance.now();await go('/');return performance.now()-t}")
        page.remove_listener('request', listener)
        print('dashboard100', json.dumps({'ms': elapsed, 'requests': len(requests)}), flush=True)
        assert not errors, errors
        await browser.close()


if __name__ == '__main__':
    with isolated_server() as (base, _):
        asyncio.run(measure(base))
