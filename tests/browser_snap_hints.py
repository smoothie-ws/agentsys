# Browser test: snapping, Ctrl+drag moving the nodes a node feeds, and the key hints. Usage: python3 tests/browser_snap_hints.py <port>
# (serve the site first: python3 -m http.server <port>). Needs playwright with chromium.
import asyncio, os, sys
from playwright.async_api import async_playwright
U=f'http://127.0.0.1:{sys.argv[1]}/index.html'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')); pg=await b.new_page(viewport={'width':1600,'height':900})
        errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
        await pg.goto(U); await pg.wait_for_function("typeof Backend!=='undefined' && document.querySelector('#view').children.length")
        await pg.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(s=>{app.preferences=s})")
        pid=await pg.evaluate("api('projects',{method:'POST',body:{name:'T'}}).then(p=>p.id)")
        await pg.goto(f'{U}#/p/{pid}/w/{pid}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        ids=await pg.evaluate('''async()=>{const P=W.project,w={workflow_id:W.workflow};
          const mk=async(t,x,y,ins,outs)=>(await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:t,inputs:ins,outputs:outs,init:''},position:{x,y}}})).id;
          const O=[{id:'o',name:'o'}], I=[{id:'i',name:'i'}];
          const a=await mk('A',0,0,[],O), b=await mk('B',400,0,I,O), c=await mk('C',800,0,I,O), d=await mk('D',0,300,[],O), e=await mk('E',400,300,I,[]);
          const con=(s,t)=>({source:s,source_port:'o',target:t,target_port:'i'});
          await api(`projects/${P}/port-connections`,{method:'POST',body:{...w,add:[con(a,b),con(b,c),con(d,e)]}});
          await reload(); return [a,b,c,d,e]}''')
        await pg.keyboard.press('Home'); await pg.wait_for_timeout(500)
        pos=lambda i: pg.evaluate("id=>({x:W.pos.get(id).x,y:W.pos.get(id).y})",i)
        print('hints text:', await pg.inner_text('#hint-list'))
        print('snap pressed:', await pg.get_attribute('#snap-toggle','aria-pressed'))
        await pg.screenshot(path='/tmp/idle.png')
        async def dragnode(i,dx,dy,ctrl=False):
            hb=await pg.locator(f'[data-id="{i}"] header').bounding_box()
            x,y=hb['x']+hb['width']/2,hb['y']+hb['height']/2
            if ctrl: await pg.keyboard.down('Control')
            await pg.mouse.move(x,y); await pg.mouse.down(); await pg.mouse.move(x+dx/2,y+dy/2,steps=4); await pg.mouse.move(x+dx,y+dy,steps=4)
            mid=await pg.inner_text('#hint-list')
            await pg.mouse.up()
            if ctrl: await pg.keyboard.up('Control')
            await pg.wait_for_timeout(500); return mid
        z=await pg.evaluate("W.camera.zoom"); print('zoom',z)
        before=[await pos(i) for i in ids]
        await dragnode(ids[0],53,37)
        a1=await pos(ids[0]); print('snap off A:',before[0],'->',a1)
        await pg.keyboard.press('KeyG'); await pg.wait_for_timeout(100)
        print('snap pressed after G:', await pg.get_attribute('#snap-toggle','aria-pressed'))
        await dragnode(ids[0],61,29)
        a2=await pos(ids[0]); print('snap on A:',a2, 'multiples of 24:', a2['x']%24==0 and a2['y']%24==0)
        before=[await pos(i) for i in ids]
        mid=await dragnode(ids[0],-96,48,ctrl=True); print('ctrl hints:',mid)
        after=[await pos(i) for i in ids]
        for n,(x,y) in zip('ABCDE',zip(before,after)): print(n,x,'->',y)
        # resize
        await pg.click(f'[data-id="{ids[3]}"] header'); 
        rh=pg.locator(f'[data-id="{ids[3]}"] [data-resize="se"]')
        print('resize handles:', await pg.locator(f'[data-id="{ids[3]}"] [data-resize]').count())
        if await rh.count():
            await rh.hover(force=True) if False else None
            bb=await rh.bounding_box()
            await pg.mouse.move(bb['x']+bb['width']/2,bb['y']+bb['height']/2); await pg.mouse.down(); await pg.mouse.move(bb['x']+60,bb['y']+50,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(500)
            print('size D:', await pg.evaluate("(i)=>{const p=W.pos.get(i);return [p.w,p.h]}",ids[3]))
        await pg.screenshot(path='/tmp/after.png')
        assert a1=={'x':53,'y':37}, a1
        assert a2['x']%24==0 and a2['y']%24==0, a2
        d=[(y['x']-x['x'],y['y']-x['y']) for x,y in zip(before,after)]
        assert d[0]==d[1]==d[2]==(-96,48) and d[3]==d[4]==(0,0), d
        assert 'Moving 2 nodes' in mid
        print('errors:',errs); assert not errs
        print('OK')
        await b.close()
asyncio.run(main())
