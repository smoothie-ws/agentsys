# Browser smoke test. Usage: python3 tests/browser_smoke.py <port>  (serve the site first: python3 -m http.server <port>)
# Needs: pip install playwright && playwright install chromium. Covers the main canvas and Library flows.
import asyncio, base64, os, sys
from playwright.async_api import async_playwright
U=f'http://127.0.0.1:{sys.argv[1]}/index.html'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')); pg=await b.new_page(viewport={'width':1732,'height':900})
        # Served without node server.js, the one probe for /__data answers 404: that is how the browser-only mode is found.
        probe=lambda m: '__data' in (m.location or {}).get('url','')
        logs=[]; pg.on('pageerror',lambda e: logs.append('PAGEERROR '+str(e))); pg.on('console',lambda m: logs.append(m.text) if m.type=='error' and not probe(m) else None)
        failures=[]
        def ok(name, cond):
            print(('PASS ' if cond else 'FAIL ')+name)
            if not cond: failures.append(name)
        await pg.goto(U); await pg.wait_for_function("typeof Backend!=='undefined' && document.querySelector('#view').children.length")
        ok('sidebar holds five sections and no lists',await pg.evaluate("[...document.querySelectorAll('#sidebar > *')].map(e=>e.className||e.id).slice(0,3).join()")=='brand,sidebar-top,sidebar-footer' and await pg.evaluate("[...document.querySelectorAll('#sidebar [data-section]')].map(a=>a.dataset.section).join()")=='library,projects,settings,api' and await pg.evaluate("!document.querySelector('#sidebar details, #crumbs')"))
        ok('Projects: the second panel is the tree of projects, with no "All projects" row',await pg.evaluate("document.querySelector('#subnav-title').textContent==='Projects'&&!document.querySelector('#subnav').textContent.includes('All projects')&&!!document.querySelector('#subnav #new-project')&&document.querySelector('#sidebar [data-section=projects]').classList.contains('active')"))
        ok('developer mode is off by default',await pg.evaluate("app.preferences.developer_mode!==true"))
        await pg.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(s=>{app.preferences=s})")
        pid=await pg.evaluate("api('projects',{method:'POST',body:{name:'T'}}).then(p=>p.id)")
        await pg.goto(f'{U}#/p/{pid}/w/{pid}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        ok('workflow controls float at canvas top left',await pg.evaluate("(()=>{const c=document.querySelector('#canvas'),t=c.querySelector('.toolbar'),e=document.querySelector('.editor'),r=c.getBoundingClientRect(),b=t.getBoundingClientRect();return !!t.querySelector('#start')&&!!t.querySelector('#undo')&&!!t.querySelector('#redo')&&Math.abs(r.top-e.getBoundingClientRect().top)<1&&Math.abs(b.top-r.top-12)<1&&Math.abs(b.left-r.left-12)<1})()"))
        ids=await pg.evaluate('''async()=>{const P=W.project,w={workflow_id:W.workflow};
          const a=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Value',inputs:[],outputs:[{id:'value',name:'value'}],init:'node.OnStarted=()=>{node.output.value="hi"};'},position:{x:0,y:0}}});
          const s=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Script',inputs:[{id:'v',name:'v'}],outputs:[{id:'result',name:'result'}],init:'node.OnStarted=()=>{node.output.result=1};'},position:{x:400,y:0}}});
          await api(`projects/${P}/port-connections`,{method:'POST',body:{...w,add:[{source:a.id,source_port:'value',target:s.id,target_port:'v'}]}}); await reload(); return [a.id,s.id]}''')
        await pg.mouse.dblclick(650,790); await pg.wait_for_timeout(150); ok('dblclick opens nothing',await pg.locator('.popup:not(.closing)').count()==0)
        await pg.mouse.click(650,790,button="right"); await pg.wait_for_selector('.popup')
        ok('empty-canvas menu',(await pg.locator('.popup:not(.closing)').inner_text()).replace('\n','')[:5]=='Paste')
        await pg.hover('.popup .menu-row:has-text("Add") button'); await pg.wait_for_timeout(250)
        ok('the Add menu offers the Library Custom Nodes and no built-in nodes',await pg.locator('.submenu button:has-text("Preview")').count()>=1 and await pg.locator('.submenu button:has-text("Custom"), .submenu button:has-text("Sticky")').count()==0); await pg.keyboard.press('Escape')
        await pg.keyboard.press('Escape')
        await pg.evaluate("api('settings',{method:'PUT',body:{developer_mode:false}}).then(s=>{app.preferences=s})")
        await pg.mouse.click(650,790,button="right"); await pg.wait_for_selector('.popup'); await pg.hover('.popup .menu-row:has-text("Add") button'); await pg.wait_for_timeout(250)
        ok('developer mode off: placing a Library Custom Node still works',await pg.locator('.submenu button:has-text("Preview")').count()>=1)
        await pg.keyboard.press('Escape')
        await pg.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(s=>{app.preferences=s})")
        await pg.mouse.click(650,790,button="right"); await pg.wait_for_selector('.popup'); await pg.hover('.popup .menu-row:has-text("Add") button'); await pg.wait_for_timeout(250)
        ok('developer mode on: the Library Custom Nodes are offered too',await pg.locator('.submenu button:has-text("Preview")').count()>=1)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        ok('no Add node / Node buttons in the toolbar',await pg.evaluate("!document.querySelector('#add-node, #node-menu')"))
        await pg.mouse.click(900,750); await pg.keyboard.press('Shift+A'); ok('Shift+A inert',await pg.locator('.popup:not(.closing)').count()==0)
        # wire right-click + drag-off (Home fits both nodes into the view first: their code fields make them tall)
        await pg.mouse.click(650,790); await pg.keyboard.press('Home'); await pg.wait_for_timeout(500)
        pt=await pg.evaluate("""()=>{const p=document.querySelector('[data-edge]'),l=p.getTotalLength(),q=p.getPointAtLength(l/2),m=p.getScreenCTM();return [q.x*m.a+m.e,q.y*m.d+m.f]}""")
        await pg.mouse.click(pt[0],pt[1],button='right'); ok('wire menu = Add reroute + Disconnect',(await pg.locator('.popup:not(.closing)').inner_text()).split()==['Add','reroute','Disconnect']); await pg.keyboard.press('Escape')
        bb=await pg.locator(f'[data-id="{ids[1]}"] .sock[data-port=v]').bounding_box()
        await pg.mouse.move(bb['x']+6,bb['y']+6); await pg.mouse.down(); await pg.mouse.move(bb['x']-30,bb['y']-110,steps=8); await pg.mouse.up(); await pg.wait_for_timeout(400)
        ok('drag-off unlinks',await pg.evaluate("W.snapshot.edges.length")==0)
        # script edit through inspector
        await pg.click(f'[data-id="{ids[1]}"] header'); await pg.wait_for_timeout(300)
        ok('a Custom node on a workflow has no code fields (the Constructor is edited in the Library)',await pg.evaluate("!document.querySelector('.node textarea[data-config], .side textarea[name=init]')"))
        ok('a Custom node placed directly shows only its name in the panel',(await pg.locator('#side-selection h2').inner_text())=='Script')
        ok('the panel has separate sections: Workflow, Properties and Activity',await pg.evaluate("[...document.querySelectorAll('[data-side-tab]')].map(b=>b.dataset.sideTab).join()==='workflow,properties,activity'"))
        ok('the Properties section shows the node and not the settings of the workflow',await pg.evaluate("document.querySelector('#side-workflow').hidden&&!document.querySelector('#side-selection').hidden"))
        await pg.click('[data-side-tab=workflow]'); await pg.wait_for_timeout(300)
        ok('the Workflow section shows the workflow and not the node',await pg.evaluate("document.querySelector('#side-workflow h2')?.textContent===W.snapshot.workflow_name&&!document.querySelector('#side-workflow').hidden&&document.querySelector('#side-selection').hidden"))
        await pg.click('[data-side-tab=properties]'); await pg.wait_for_timeout(300)
        ok('node headers show their icons',await pg.evaluate("[...document.querySelectorAll('.node:not(.reroute) header')].every(h=>h.querySelector('.head-icon svg')&&h.querySelector('.head-icon').nextElementSibling.classList.contains('title'))"))
        await pg.evaluate("api(`projects/${W.project}/port-connections`,{method:'POST',body:{workflow_id:W.workflow,add:[{source:W.snapshot.nodes.find(n=>n.config?.title==='Value').id,source_port:'value',target:W.snapshot.nodes.find(n=>n.config?.title==='Script').id,target_port:'v'}]}}).then(()=>reload())")
        await pg.hover(f'[data-id="{ids[1]}"] header'); await pg.click(f'[data-id="{ids[1]}"] .fold'); await pg.wait_for_timeout(500)
        ok('fold keeps only the connected input',await pg.evaluate(f"(()=>{{const n=document.querySelector('[data-id=\"{ids[1]}\"]'),s=n.querySelector('.sock');return n.querySelectorAll('.sock').length===1&&s.dataset.port==='v'&&s.dataset.dir==='in'&&n.offsetHeight===56}})()"))
        ok('folded wire meets its socket',await pg.evaluate("(()=>{const e=visibleEdges()[0],s=socketPoint(e.target,'in',e.target_port),p=document.querySelector('[data-edge]'),q=p.getPointAtLength(p.getTotalLength());return Math.hypot(q.x-s.x,q.y-s.y)<.1})()"))
        await pg.evaluate("api(`projects/${W.project}/port-connections`,{method:'POST',body:{workflow_id:W.workflow,remove:W.snapshot.edges}}).then(()=>reload())")
        ok('fold hides unused slots and keeps the header',await pg.evaluate(f"(()=>{{const n=document.querySelector('[data-id=\"{ids[1]}\"]');return n.classList.contains('folded')&&!n.querySelector('.code-editor, .port, .sock')&&!!n.querySelector('header .title')}})()"))
        ok('fold is saved',await pg.evaluate("W.snapshot.nodes.find(n=>n.config?.title==='Script').folded"))
        await pg.click(f'[data-id="{ids[1]}"] .fold'); await pg.wait_for_timeout(500)
        ok('the same button opens it again',not await pg.evaluate("W.snapshot.nodes.find(n=>n.config?.title==='Script').folded"))
        await pg.evaluate("api(`projects/${W.project}/node-style`,{method:'PUT',body:{workflow_id:W.workflow,node_id:W.snapshot.nodes.find(n=>n.config?.title==='Script').id,color:'#3b6ea8',pinned:false}}).then(()=>reload())"); await pg.wait_for_timeout(500)
        ok('a coloured node is filled with exactly that colour',await pg.evaluate("(()=>{const c=getComputedStyle(document.querySelector('.node.colored')).backgroundColor,n=c.match(/[\\d.]+/g).map(Number),f=c.startsWith('color(')?255:1;return [59,110,168].every((v,i)=>Math.abs(n[i]*f-v)<1)})()"))
        await pg.click('[data-selection-color]'); await pg.fill('.color-picker .alpha-number','40'); await pg.press('.color-picker .alpha-number','Tab'); await pg.wait_for_timeout(500)
        ok('opacity saves RGBA without dimming node content',await pg.evaluate("W.snapshot.nodes.find(n=>n.config?.title==='Script').color==='#3b6ea866'&&getComputedStyle(document.querySelector('.node.colored')).opacity==='1'"))
        await pg.keyboard.press('Escape'); await pg.click('[data-selection-color]')
        ok('picker reopens with saved opacity',await pg.input_value('.color-picker .alpha-number')=='40' and await pg.input_value('.color-picker .hex')=='#3b6ea866')
        await pg.keyboard.press('Escape'); await pg.click('#undo'); await pg.wait_for_timeout(500)
        undone=await pg.evaluate("W.snapshot.nodes.find(n=>n.config?.title==='Script').color==='#3b6ea8'")
        await pg.click('#redo'); await pg.wait_for_timeout(500)
        ok('opacity changes support Undo and Redo',undone and await pg.evaluate("W.snapshot.nodes.find(n=>n.config?.title==='Script').color==='#3b6ea866'"))
        # constant stroke
        await pg.evaluate("setCamera(W.camera.x,W.camera.y,2)"); ok('stroke var scales',await pg.evaluate("getComputedStyle(W.world).getPropertyValue('--sw')")=='0.625px')
        # library editor flow
        await pg.goto(U+'#/resources/custom_node'); await pg.wait_for_selector('#view .page-head [data-menu]'); await pg.click('#view .page-head [data-menu]'); await pg.get_by_role('menuitem',name='Add…',exact=True).click(); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(500)
        # a tab dragged far past either end stays inside the row: the bar does not stretch and the other tabs stay put
        box=await pg.locator('#tabs .tab').first.bounding_box(); before=await pg.evaluate("[document.querySelector('#tabs').scrollWidth,[...document.querySelectorAll('#tabs .tab')].map(t=>Math.round(t.getBoundingClientRect().left)).join()]")
        await pg.mouse.move(box['x']+20,box['y']+box['height']/2); await pg.mouse.down(); await pg.mouse.move(box['x']+60,box['y']+box['height']/2,steps=3)
        await pg.mouse.move(1290,box['y']+box['height']/2,steps=5); await pg.wait_for_timeout(700)
        far=await pg.evaluate("[document.querySelector('#tabs').scrollWidth,document.querySelector('#tabs').scrollLeft,document.querySelector('#tabs .tab.sorting').getBoundingClientRect().right<=document.querySelector('#tabs').getBoundingClientRect().right+1]")
        await pg.mouse.move(2,box['y']+box['height']/2,steps=5); await pg.wait_for_timeout(500)
        near=await pg.evaluate("[document.querySelector('#tabs').scrollWidth,document.querySelector('#tabs .tab.sorting').getBoundingClientRect().left>=document.querySelector('#tabs').getBoundingClientRect().left-1]")
        await pg.mouse.up(); await pg.wait_for_timeout(400)
        ok('a dragged tab cannot leave the row',far[0]==before[0] and far[1]==0 and far[2] and near[0]==before[0] and near[1])
        ok('main group selected',await pg.evaluate("W.selected.has('frame:'+W.snapshot.root)"))
        await pg.click('[data-selection-color]'); await pg.fill('.color-picker .hex','#3b6ea880'); await pg.press('.color-picker .hex','Tab'); await pg.wait_for_timeout(500); await pg.keyboard.press('Escape')
        ok('group colour keeps its alpha channel',await pg.evaluate("W.groups.get(W.snapshot.root).color==='#3b6ea880'&&document.querySelector('.frame').style.getPropertyValue('--node-color')==='#3b6ea880'"))
        await pg.mouse.click(600,500,button='right'); await pg.hover('.popup .menu-row:has-text("Add") button'); await pg.click('.submenu button:has-text("Preview")'); await pg.wait_for_timeout(700)
        inside=await pg.evaluate("(()=>{const f=W.pos.get('frame:'+W.snapshot.root),n=[...W.nodes.values()].find(n=>n.kind==='complex'&&n.source),p=n&&W.pos.get(n.id);return !!p&&W.groups.get(W.snapshot.root).children.includes(n.group_id)&&p.x>=f.x&&p.y>=f.y&&p.x+p.w<=f.x+f.w&&p.y+p.h<=f.y+f.h})()")
        ok('new node lands inside main group',inside)
        fr=await pg.locator('.frame').first.bounding_box(); ex,ey=fr['x']+fr['width']-2,fr['y']+fr['height']/2
        ok('group edge is grabbable',await pg.evaluate(f"!!document.elementFromPoint({ex},{ey})?.classList.contains('resize-handle')"))
        await pg.mouse.move(ex,ey); await pg.mouse.down(); await pg.mouse.move(ex+40,ey,steps=4); await pg.mouse.move(ex+90,ey,steps=4); await pg.mouse.up(); await pg.wait_for_timeout(600)
        ok('group stretches by its edge',(await pg.locator('.frame').first.bounding_box())['width']>fr['width']+40)
        await pg.evaluate("""async()=>{const g=W.snapshot.root,n=W.snapshot.nodes.find(n=>n.node_type==='custom'); await api(`projects/${W.project}/complex/${g}`,{method:'PUT',body:{workflow_id:W.workflow,interface:{inputs:[],outputs:[{id:'out',name:'out',bound:[{node_id:n.id,port_id:'result'}]}]}}}); await reload();}""")
        await pg.evaluate("""async()=>{const g=W.snapshot.root; await api(`projects/${W.project}/groups`,{method:'PUT',body:{workflow_id:W.workflow,groups:W.snapshot.groups.map(x=>({id:x.id,name:x.id===g?'Gen':x.name,members:x.members,parent:x.parent||null}))}}); const r=await api('resources/'+W.library); await api(`resources/${r.id}`,{method:'PUT',body:{name:'Gen',payload:{...r.payload,description:'Makes a value'}}}); await reload();}"""); await pg.wait_for_timeout(700); await pg.evaluate('loadLibrary()'); ok('no Save/Start buttons in Library editor',await pg.evaluate("!document.querySelector('#save-node')&&!document.querySelector('#start')"))
        ok('saved to Library',await pg.evaluate("app.resources.some(r=>r.kind==='custom_node'&&r.name==='Gen')"))
        # tree
        await pg.goto(U+'#/resources/custom_node'); await pg.wait_for_selector('#view .page-head [data-menu]')
        await pg.click('#view .page-head [data-menu]'); await pg.get_by_role('menuitem',name='New group',exact=True).click(); await pg.fill('#modal input[name=name]','Flow'); await pg.click('#modal button.primary'); await pg.wait_for_selector('#view .page-head [data-menu]'); await pg.click('#subnav [data-group="k:custom_node"] > .subnav-row .subnav-toggle'); await pg.wait_for_selector('#subnav [data-group="f:Flow"]'); await pg.wait_for_timeout(600)
        ok('a new group is a row of the tree and a card of the page',await pg.evaluate("!!document.querySelector('#view .card-main[href$=\"folder=Flow\"]')"))
        rid=await pg.evaluate("app.resources.find(r=>r.name==='Gen').id")
        await pg.drag_and_drop(f'#subnav [data-drag="{rid}"]','#subnav [data-group="f:Flow"] > .subnav-row'); await pg.wait_for_timeout(500)
        ok('drag into group',await pg.evaluate("app.resources.find(r=>r.name==='Gen').payload.folder")=='Flow')
        await pg.goto(U+'#/resources/custom_node?folder=Flow'); await pg.wait_for_selector('#view .card-main'); await pg.click('#view .card-main'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(500)
        ok('a Custom Node opens straight in its graph editor',await pg.evaluate("!!W.library&&!document.querySelector('#resource-form')"))
        await pg.evaluate("W.selected=new Set(['frame:'+W.snapshot.root]);Inspector.refresh()"); await pg.wait_for_timeout(300)
        await pg.fill('#group-form textarea[name=description]','From the panel'); await pg.click('#group-form [data-icon-choice=bolt]'); await pg.wait_for_timeout(1500)
        ok('description and icon are set in the Properties of the node',await pg.evaluate("app.resources.some(r=>r.id===W.library&&r.payload.description==='From the panel'&&r.payload.icon==='bolt')"))
        # place from Add menu in the project
        await pg.goto(f'{U}#/p/{pid}/w/{pid}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        empty=await pg.evaluate('''() => {const r=W.canvas.getBoundingClientRect();for(let y=r.bottom-80;y>r.top+80;y-=40)for(let x=r.left+30;x<r.right-30;x+=40){const el=document.elementFromPoint(x,y);if(el?.closest('#canvas')&&!el.closest('.node,.frame,.toolbar,.map,.selection-tools,[data-edge]'))return [x,y]}throw Error('No empty canvas point')}''')
        await pg.mouse.click(*empty,button='right'); await pg.hover('.popup .menu-row:has-text("Add") button'); await pg.hover('.submenu .menu-row:has-text("Flow") button'); await pg.wait_for_timeout(250)
        await pg.click('.submenu >> nth=-1 >> button:has-text("Gen")'); await pg.wait_for_timeout(600)
        ok('placed as locked node',await pg.evaluate(f"W.snapshot.complex.some(c=>c.source?.resource_id==='{rid}'&&c.locked) && !document.querySelector('.node.k-complex .expand')"))
        ok('inspector shows name + description',(await pg.locator('#side-selection').inner_text()).startswith('Gen') and 'From the panel' in await pg.locator('#side-selection').inner_text())
        await pg.screenshot(path='ui_check.png')
        # tabs: context menu with Pin, Close, Close All, Close to the right
        await pg.click('.tab >> nth=0', button='right'); await pg.wait_for_selector('.popup')
        ok('tab menu items',(await pg.locator('.popup:not(.closing)').inner_text()).split()[:2]==['Pin','Close'])
        await pg.click('.popup button:has-text("Pin")'); await pg.wait_for_timeout(200)
        ok('pinned tab has no close button',await pg.evaluate("document.querySelector('.tab.is-pinned')&&!document.querySelector('.tab.is-pinned .tab-close')"))
        await pg.click('.tab >> nth=0', button='right'); await pg.click('.popup button:has-text("Close All")'); await pg.wait_for_timeout(500)
        ok('Close All keeps pinned',await pg.evaluate("document.querySelectorAll('.tab').length===1"))
        ok('every wire style draws a valid path',await pg.evaluate("WIRE_STYLES.every(([id])=>{graphStyle={...graphStyle,wire_style:id};const d=wirePath({x:0,y:0},{x:-200,y:90})+wirePath({x:0,y:0},{x:300,y:-40});return /^M/.test(d)&&!/NaN/.test(d)})"))
        ok('switching Library sections: the highlight glides to the new row, the second panel is not rebuilt',await pg.evaluate("""(async()=>{await go('/resources/skill');await new Promise(r=>setTimeout(r,500));const pill=document.querySelector('#subnav-body .nav-pill'),list=document.querySelector('#subnav-list'),tops=new Set(),t0=performance.now();const sample=()=>{tops.add(Math.round(pill.getBoundingClientRect().top));if(performance.now()-t0<500)requestAnimationFrame(sample)};sample();await go('/resources/custom_node');await new Promise(r=>setTimeout(r,600));return tops.size>3&&list===document.querySelector('#subnav-list')})()"""))
        ok('the sidebar highlight glides between sections too',await pg.evaluate("""(async()=>{const pill=document.querySelector('#sidebar .nav-pill'),tops=new Set(),t0=performance.now();const sample=()=>{tops.add(Math.round(pill.getBoundingClientRect().top));if(performance.now()-t0<500)requestAnimationFrame(sample)};sample();await go('/');await new Promise(r=>setTimeout(r,600));return tops.size>3})()"""))
        await pg.goto(U+'#/settings'); await pg.wait_for_timeout(300); await pg.goto(U+'#/resources/skill'); await pg.wait_for_timeout(300)
        ok('pages have no tabs: only graph editors do',await pg.evaluate("![...document.querySelectorAll('.tab-title')].some(e=>['Settings','Library','API','Projects'].includes(e.textContent))&&document.querySelectorAll('.tab.active').length===0"))
        ok('no breadcrumb: the open section and item are shown on the left',await pg.evaluate("!document.querySelector('#crumbs')&&document.querySelector('#subnav-title').textContent==='Library'&&document.querySelector('#sidebar [data-section=library]').classList.contains('active')"))
        ok('Library is a tree: the kinds, the open one highlighted, its items below it',await pg.evaluate("document.querySelectorAll('#subnav-list > .subnav-tree > .subnav-group').length===3&&document.querySelector('#subnav .subnav-row.active')?.dataset.key==='k:skill'&&document.querySelectorAll('#subnav [data-group=\"k:skill\"] .subnav-branch .subnav-row').length>=1&&!document.querySelector('.sidebar-sub')"))
        ok('and the page shows the same things as cards: one card for every skill',await pg.evaluate("document.querySelectorAll('#view .card').length===resourcesOf('skill').length&&resourcesOf('skill').length>=1&&!!document.querySelector('#view .card .card-preview')&&!!document.querySelector('#view .crumbs a[href=\"/resources\"]')"))
        await pg.goto(U+'#/resources'); await pg.wait_for_selector('#view .card'); ok('Library itself shows its three kinds as cards',await pg.evaluate("document.querySelectorAll('#view .card').length===3&&document.querySelector('#subnav .subnav-row.active')===null"))
        await pg.goto(U+'#/resources/skill'); await pg.wait_for_selector('#view .card-main'); await pg.click('#view .card-main'); await pg.wait_for_selector('#resource-form')
        ok('a card opens the item; its row in the tree is the open one',await pg.evaluate("location.hash.startsWith('#/resources/skill/')&&document.querySelector('#subnav .subnav-row.active')?.dataset.key==='r:'+location.hash.split('/').pop()&&!!document.querySelector('#view .crumbs')"))
        await pg.goto(U+'#/settings'); await pg.wait_for_selector('#settings-form'); await pg.click('#subnav [role=tab]:nth-child(2)'); await pg.click('#sidebar a[data-section=library]'); await pg.wait_for_timeout(300); await pg.click('#sidebar a[data-section=settings]'); await pg.wait_for_timeout(400)
        ok('a page keeps its state: Settings reopens on Appearance',await pg.evaluate("document.querySelector('#subnav [aria-selected=true]').textContent.trim()")=='Appearance' and await pg.evaluate("!document.querySelector('#section-panel-1').hidden"))
        await pg.goto(U+'#/api-docs'); await pg.wait_for_timeout(400)
        ok('API: the call tree is in the second panel, and a page leaves no tab open',await pg.evaluate("document.querySelectorAll('.tab.active').length===0&&document.querySelector('#subnav-title').textContent==='API'&&document.querySelectorAll('#subnav [data-method]').length>20&&!!document.querySelector('#subnav [data-method].active')&&!document.querySelector('.api-layout')"))
        pid2=await pg.evaluate("api('projects',{method:'POST',body:{name:'T2'}}).then(p=>p.id)"); pid3=await pg.evaluate("api('projects',{method:'POST',body:{name:'T3'}}).then(p=>p.id)")
        for q in (pid2,pid3): await pg.goto(f'{U}#/p/{q}/w/{q}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        ok('the second panel stays in an editor, the project and its workflow shown',await pg.evaluate("!document.querySelector('#subnav').hidden&&document.querySelector('#subnav').getBoundingClientRect().width>100&&!!document.querySelector('#subnav .subnav-branch .subnav-row.active')"))
        ok('open sections have four rounded corners, connected tabs reach the section edge, and the glow stays outside the icon rail',await pg.evaluate("""(()=>{
          const corners=['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'];
          const rounded=[...document.querySelectorAll('#subnav, main, .side-content')].every(e=>corners.every(k=>parseFloat(getComputedStyle(e)[k])>0));
          const connected=[['#sidebar','#sidebar > .nav-pill'],['#subnav-body','#subnav-body > .nav-pill'],['.side-tabs','.side-tabs > .nav-pill']].every(([host,tab],i)=>{
            const h=document.querySelector(host).getBoundingClientRect(),t=document.querySelector(tab),r=t.getBoundingClientRect();
            return Math.abs(i===2?r.left-h.left:r.right-h.right)<1&&['::before','::after'].every(p=>{const c=getComputedStyle(t,p);return c.content!=='none'&&c.width==='14px'&&c.backgroundImage.includes('radial-gradient')});
          });
          const a=document.querySelector('#subnav .subnav-row.active'),closed=a.closest('.subnav-group:not(.open)'),row=closed?closed.querySelector(':scope > .subnav-row'):a;
          const s=document.querySelector('main > .nav-seam'),m=document.querySelector('main').getBoundingClientRect();
          const pairs=[['#sidebar','#subnav > .nav-seam'],['#subnav','main > .nav-seam'],['.side-tabs','.side-content > .nav-seam']];
          const separate=pairs.every(([buttonPanel,glow])=>{const p=document.querySelector(buttonPanel).getBoundingClientRect(),g=document.querySelector(glow).getBoundingClientRect();return g.right<=p.left+1||g.left>=p.right-1});
          return rounded&&connected&&separate&&!document.querySelector('.nav-halo')&&!!s&&!s.classList.contains('off')&&Math.abs(parseFloat(s.style.getPropertyValue('--y'))-(row.getBoundingClientRect().top-m.top))<2;
        })()"""))
        ok('the gradient is continuous across all three panel joins',await pg.evaluate("""async png=>{
          const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
          const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
          const pixel=(x,y)=>ctx.getImageData(x,y,1,1).data;
          return ['#sidebar > .nav-pill','#subnav-body > .nav-pill','.side-tabs > .nav-pill'].every((selector,i)=>{
            const r=document.querySelector(selector).getBoundingClientRect(),x=Math.round(i===2?r.left:r.right),y=Math.round(r.top+r.height/2);
            const a=pixel(x-1,y),b=pixel(x,y);
            return [0,1,2].every(c=>Math.abs(a[c]-b[c])<=4);
          });
        }""",base64.b64encode(await pg.screenshot()).decode()))
        await pg.click('[data-side-close]'); await pg.wait_for_timeout(600)
        ok('folded to its icons the Properties panel is just the rail wide: no strip beside the canvas',await pg.evaluate("(()=>{const e=document.querySelector('.editor').getBoundingClientRect(),c=document.querySelector('#canvas').getBoundingClientRect(),s=document.querySelector('#side').getBoundingClientRect();return Math.abs(s.width-56)<1&&Math.abs(c.right-s.left)<1&&Math.abs(s.right-e.right)<1})()"))
        ok('the folded Properties rail has no fill or corner clipping',await pg.evaluate("(()=>{const s=getComputedStyle(document.querySelector('#side'));return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.borderRadius==='0px'})()"))
        await pg.click('[data-side-tab=properties]'); await pg.wait_for_timeout(500)
        await pg.click('#map-toggle'); await pg.wait_for_timeout(450)
        ok('the minimap button folds the map away and the choice is remembered',await pg.evaluate("(()=>{const m=document.querySelector('.map');return m.classList.contains('collapsed')&&m.getBoundingClientRect().height<60&&document.querySelector('#map-toggle').getAttribute('aria-expanded')==='false'&&store.get('agentsys-minimap-hidden')===true})()"))
        await pg.reload(); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(500)
        ok('and it stays folded after a reload, zoom buttons still there',await pg.evaluate("document.querySelector('.map').classList.contains('collapsed')&&!!document.querySelector('#zoom-in')&&document.querySelector('.map').getBoundingClientRect().height<60"))
        await pg.click('#map-toggle'); await pg.wait_for_timeout(450)
        ok('the button brings the minimap back',await pg.evaluate("!document.querySelector('.map').classList.contains('collapsed')&&document.querySelector('.map').getBoundingClientRect().height>120&&store.get('agentsys-minimap-hidden')===false"))
        await pg.goto(U+'#/'); await pg.wait_for_selector('#subnav .subnav-row'); ok('project rows with a menu and no count',await pg.evaluate("document.querySelectorAll('#subnav .subnav-row').length>=3&&!document.querySelector('#subnav .nav-count')&&!!document.querySelector('#subnav .subnav-menu')&&document.querySelectorAll('#view .card').length===document.querySelectorAll('#subnav-list > .subnav-tree > .subnav-group').length"))
        await pg.click(f'#subnav .subnav-row a[href="/p/{pid2}"]'); await pg.wait_for_selector('.page-head h1'); ok('a project row opens the project and is highlighted',(await pg.evaluate("location.hash")).endswith(f'/p/{pid2}') and await pg.evaluate("document.querySelector('#subnav .subnav-row.active a').getAttribute('href').endsWith('/p/'+location.hash.split('/p/')[1])"))
        await pg.hover('#subnav .subnav-row.active'); await pg.click('#subnav .subnav-row.active .subnav-menu'); await pg.wait_for_selector('.popup'); ok('the row menu is the project menu',(await pg.locator('.popup:not(.closing)').inner_text()).split()[0]=='Rename'); await pg.keyboard.press('Escape')
        ok('trees start folded', await pg.evaluate("!document.querySelector('#subnav .subnav-group.open')")); await pg.click('#subnav .subnav-row.active .subnav-toggle'); await pg.wait_for_selector('#subnav .subnav-group.open[data-group^="p:"] .subnav-branch .subnav-row'); ok('projects are a tree: the open project lists its workflows',await pg.evaluate("document.querySelectorAll('#subnav [data-group^=\"p:\"]').length>=3&&document.querySelectorAll('#subnav .subnav-group.open .subnav-branch .subnav-row a[href*=\"/w/\"]').length>=1&&document.querySelectorAll('#view .card').length===document.querySelector('#subnav .subnav-row.active').parentElement.querySelectorAll('.subnav-branch .subnav-row').length"))
        await pg.dblclick('#sidebar > .panel-resize'); await pg.wait_for_timeout(500); ok('a double click on the sidebar edge folds the sidebar',await pg.evaluate("document.body.classList.contains('sidebar-hidden')&&!document.querySelector('#toggle-sidebar')")); await pg.dblclick('#sidebar > .panel-resize'); await pg.wait_for_timeout(500); ok('and unfolds it',await pg.evaluate("!document.body.classList.contains('sidebar-hidden')"))
        ok('the logo is a link to the front page of the site',await pg.evaluate("document.querySelector('#brand').getAttribute('href')")=='/')
        hb=await pg.locator('#subnav > .panel-resize').bounding_box(); hx,hy=hb['x']+hb['width']/2,300
        await pg.mouse.move(hx,hy); await pg.mouse.down(); await pg.mouse.move(hx-120,hy,steps=5); await pg.mouse.move(hx-220,hy,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(600)
        ok('dragging the second panel edge far left folds it to icons',await pg.evaluate("document.body.classList.contains('subnav-collapsed')&&document.querySelector('#subnav').getBoundingClientRect().width<70&&getComputedStyle(document.querySelector('#subnav .subnav-row a span')).display==='none'"))
        hb=await pg.locator('#subnav > .panel-resize').bounding_box(); hx=hb['x']+hb['width']/2
        await pg.mouse.move(hx,hy); await pg.mouse.down(); await pg.mouse.move(hx+100,hy,steps=5); await pg.mouse.move(hx+180,hy,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(600)
        ok('and dragging it back opens it',await pg.evaluate("!document.body.classList.contains('subnav-collapsed')&&document.querySelector('#subnav').getBoundingClientRect().width>150"))
        await pg.goto(f'{U}#/p/{pid3}/w/{pid3}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        await pg.click('.tab:not(.active) >> nth=-1'); await pg.wait_for_timeout(300); ok('clicking a tab opens its editor',(await pg.evaluate("location.hash")).endswith(f'/w/{pid2}')); await pg.goto(f'{U}#/p/{pid3}/w/{pid3}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        tabs=await pg.locator('.tab').count(); other=pg.locator('.tab:not(.active):not(.is-pinned)').first
        await other.hover(); await pg.wait_for_timeout(450)
        ok('active tab has a rounded fill without an underline',await pg.evaluate("(()=>{const t=document.querySelector('.tab.active'),s=getComputedStyle(t);return (s.backgroundColor!=='rgba(0, 0, 0, 0)'||s.backgroundImage!=='none')&&parseFloat(s.borderRadius)>0&&getComputedStyle(t,'::after').content==='none'})()"))
        await other.locator('.tab-close').click(); await pg.wait_for_timeout(120)
        ok('a closed tab shrinks away before it is removed',await pg.locator('.tab.closing').count()==1 and await pg.locator('.tab').count()==tabs)
        await pg.wait_for_timeout(900)
        ok('then it is gone',await pg.locator('.tab').count()==tabs-1)
        await pg.evaluate("toast('See the [Library](/resources/skill) and [a node](node:none).')"); ok('toast text holds links',await pg.locator('.toast a[data-link]').count()==1 and await pg.locator('.toast button.link').count()==1)
        await pg.click('.toast a[data-link]'); await pg.wait_for_timeout(400)
        ok('toast link opens the page and dismisses the toast',(await pg.evaluate("location.hash"))=='#/resources/skill' and await pg.locator('.toast').count()==0)
        await pg.keyboard.press('Control+k'); await pg.wait_for_selector('#search-input'); await pg.wait_for_timeout(400)
        ok('Ctrl+K lists places to go to',await pg.evaluate("[...document.querySelectorAll('#search-results h3')].map(h=>h.textContent)[0]==='Go to'&&['Settings','Library','API'].every(t=>[...document.querySelectorAll('#search-results strong')].some(e=>e.textContent===t))"))
        await pg.fill('#search-input','summarize'); await pg.wait_for_timeout(600)
        ok('and the items of the Library',await pg.evaluate("[...document.querySelectorAll('#search-results a')].some(a=>a.getAttribute('href').startsWith('/resources/skill/')&&a.textContent.includes('Library · Skills'))"))
        await pg.fill('#search-input','T2'); await pg.wait_for_timeout(600); await pg.press('#search-input','Enter'); await pg.wait_for_timeout(500)
        ok('typing a project name and Enter opens it',(await pg.evaluate("location.hash")).startswith(f'#/p/{pid2}') and not await pg.evaluate("document.querySelector('#modal').open"))
        await pg.goto(U+'#/resources/skill'); await pg.wait_for_selector('#export-resources')
        ok('built-in items were imported on the first run',await pg.evaluate("api('resources').then(r=>['Text','Preview','summarize','answer-briefly'].every(n=>r.some(x=>x.name===n)))"))
        ok('Export is a button of the page head, not a menu entry',await pg.evaluate("!!document.querySelector('.page-head #export-resources')"))
        await pg.click('#library-add'); menu=await pg.locator('.popup:not(.closing)').inner_text(); ok('the + menu of the panel imports and restores; groups are made from the context menu of a section','Import' in menu and 'Restore built-in items' in menu and 'group' not in menu); await pg.keyboard.press('Escape')
        await pg.evaluate("api('resources').then(r=>api('resources/'+r.find(x=>x.name==='summarize').id,{method:'DELETE'}))")
        await pg.evaluate("api('resources').then(r=>{const t=r.find(x=>x.name==='Text');return api('resources/'+t.id,{method:'PUT',body:{name:'Text',payload:{...t.payload,description:'edited'}}})})")
        await pg.evaluate("restoreBuiltins()"); await pg.wait_for_selector('#modal button:has-text("Restore")'); await pg.click('#modal button:has-text("Restore")'); await pg.wait_for_timeout(1500)
        ok('Restore built-in items brings back what was deleted, once',await pg.evaluate("api('resources').then(r=>r.filter(x=>x.name==='summarize').length)")==1)
        ok('and overwrites an item that was changed',await pg.evaluate("api('resources').then(r=>r.find(x=>x.name==='Text').payload.description)")!='edited')
        ok('import keeps the group of a Custom Node',await pg.evaluate("(async()=>{const r=(await api('resources')).find(x=>x.name==='Text');const [m]=await addEntries([{kind:'custom_node',name:'Moved',payload:{...r.payload,folder:'Tools/Text'}}],'test');return m.payload.folder==='Tools/Text'&&app.nodeFolders!==undefined&&(await api('library/node-folders')).includes('Tools/Text')})()"))
        # editing: a number still being typed, the panel shortcut, and wires caught by the selection rectangle
        await pg.goto(f'{U}#/p/{pid}/w/{pid}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(400)
        num=await pg.evaluate("async()=>{const P=W.project,w={workflow_id:W.workflow};const n=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Value',inputs:[],outputs:[],init:'node.OnPlaced=()=>node.setWidgets([{id:\\'n\\',kind:\\'number\\',label:\\'n\\',value:7}])'},position:{x:0,y:900}}});await Backend.hooksIdle();await reload();return n.id}")
        await pg.click(f'[data-id="{num}"] input[data-literal=n]'); await pg.keyboard.press('Control+a'); await pg.keyboard.type('-'); await pg.wait_for_timeout(700)
        ok('a number being typed is not saved and raises no error',await pg.evaluate(f"W.snapshot.widgets['{num}'][0].value")==7 and await pg.locator('.toast.error').count()==0)
        await pg.keyboard.type('5'); await pg.wait_for_timeout(700)
        ok('the finished number is saved',await pg.evaluate(f"W.snapshot.widgets['{num}'][0].value")==-5)
        await pg.evaluate('W.canvas.focus()'); side=await pg.evaluate("document.querySelector('#side').dataset.collapsed")
        await pg.keyboard.press('n'); await pg.wait_for_timeout(300)
        ok('the panel shortcut works while the canvas has the focus',await pg.evaluate("document.querySelector('#side').dataset.collapsed")!=side)
        ok('the selection rectangle finds a wire in every wire style',await pg.evaluate("async()=>{const P=W.project,w={workflow_id:W.workflow};const a=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Value',inputs:[],outputs:[{id:'value',name:'value'}],init:'node.OnStarted=()=>{node.output.value=1};'},position:{x:0,y:1200}}});const b=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Preview',inputs:[{id:'input',name:'input'}],outputs:[],init:'node.OnStarted=()=>display(input);'},position:{x:520,y:1240}}});await api(`projects/${P}/port-connections`,{method:'POST',body:{...w,add:[{source:a.id,source_port:'value',target:b.id,target_port:'input'}]}});await reload();const e=W.snapshot.edges.find(x=>x.source===a.id);const p1=socketPoint(e.source,'out',e.source_port),p2=socketPoint(e.target,'in',e.target_port);const box=[{x:Math.min(p1.x,p2.x)+20,y:Math.min(p1.y,p2.y)-60},{x:Math.max(p1.x,p2.x)-20,y:Math.max(p1.y,p2.y)+60}];const kept=graphStyle;const okAll=WIRE_STYLES.every(([id])=>{graphStyle={...graphStyle,wire_style:id};return crossedEdges(...box).includes(e.id)});graphStyle=kept;return okAll}"))
        # a run leaves a log that is stored with the workflow; a bad provider form is reported, not thrown
        await pg.evaluate("runAction()"); await pg.wait_for_timeout(900)
        ok('Run keeps a log of the last run',await pg.evaluate("W.runLog.length>1&&W.lastRun.ran>0"))
        ok('and stores it with the workflow',await pg.evaluate("api(`projects/${W.project}/last-run`,{query:{workflow_id:W.workflow}}).then(r=>!!r.last&&r.log.length===W.runLog.length)"))
        # OnPlaced runs when the node is added, display() shows text on the node after a run
        hook=await pg.evaluate("""async()=>{const P=W.project,w={workflow_id:W.workflow};const n=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Hooked',inputs:[],outputs:[],init:'node.OnPlaced=async()=>{await agentsys("PUT","projects/"+context.project_id+"/state/placed",{value:1})};node.OnStarted=()=>display("shown on the node")'},position:{x:0,y:1500}}});await Backend.hooksIdle();await reload();return n.id}""")
        ok('OnPlaced ran when the node was added',await pg.evaluate("api(`projects/${W.project}/state/placed`).then(e=>e.value===1)"))
        await pg.evaluate("runAction()"); await pg.wait_for_timeout(900)
        ok('display() shows its text on the node after a run',await pg.evaluate(f"document.querySelector('[data-id=\"{hook}\"] .preview-text')?.textContent.includes('shown on the node')"))
        # a Custom Node placed from the Library shows what its code display()s
        shown=await pg.evaluate("""async()=>{const ed=await api('library/node-editor',{method:'POST',body:{}});const snap=await api(`projects/${ed.project_id}/workflow`,{query:{workflow_id:ed.workflow_id}});
          await api(`projects/${ed.project_id}/complex/${snap.root}`,{method:'PUT',body:{workflow_id:ed.workflow_id,interface:{inputs:[],outputs:[]},init:'node.OnStarted = () => display("shown by the placed node");'}});
          await api(`projects/${W.project}/custom-nodes/${ed.resource_id}`,{method:'POST',body:{workflow_id:W.workflow,point:{x:600,y:1500}}});await reload();return ed.resource_id}""")
        await pg.evaluate("runAction()"); await pg.wait_for_timeout(900)
        ok('a placed Custom Node shows its display() text after a run',await pg.evaluate("[...document.querySelectorAll('.node.k-complex .preview-text')].some(e=>e.textContent.includes('shown by the placed node'))"))
        # widgets: every kind is drawn on the node, a person's edits reach the node and call OnWidget; there are no types
        wid=await pg.evaluate("""async()=>{const P=W.project,w={workflow_id:W.workflow};
          const n=await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Widgets',inputs:[],outputs:[{id:'o',name:'o'}],init:'node.OnPlaced=()=>node.setWidgets([{id:"t",kind:"text",label:"Text",value:"a"},{id:"ta",kind:"textarea",label:"Area"},{id:"n",kind:"number",label:"Num",value:1},{id:"c",kind:"checkbox",label:"Check"},{id:"s",kind:"select",label:"Pick",options:["x","y"]},{id:"r",kind:"range",label:"Range",min:0,max:10,value:3},{id:"b",kind:"button",label:"Push"},{id:"l",kind:"label",text:"A label"},{id:"h",kind:"html",html:"<b>hi</b>",height:40}]);node.OnWidget=async w=>{await agentsys("PUT","projects/"+context.project_id+"/state/widget",{value:w.id})};node.OnStarted=()=>{node.output.o=JSON.stringify(node.widgets)}'},position:{x:900,y:1700}}});
          await Backend.hooksIdle(); await reload(); return n.id}""")
        ok('every widget kind is drawn on the node',await pg.evaluate(f"document.querySelectorAll('[data-id=\"{wid}\"] .widget').length")==9 and await pg.locator(f'[data-id="{wid}"] iframe[sandbox="allow-scripts"]').count()==1)
        await pg.click(f'[data-id="{wid}"] [data-widget-button=b]'); await pg.click(f'[data-id="{wid}"] [data-widget-button=b]'); await pg.wait_for_timeout(500)
        ok('a button counts its clicks',await pg.evaluate(f"W.snapshot.widgets['{wid}'].find(w=>w.id==='b').value")==2)
        await pg.locator(f'[data-id="{wid}"] select[data-literal=s]').select_option('1'); await pg.wait_for_timeout(500)
        await pg.locator(f'[data-id="{wid}"] input[data-literal=c]').check(); await pg.wait_for_timeout(500)
        ok('a select and a checkbox are saved',await pg.evaluate(f"(()=>{{const l=W.snapshot.widgets['{wid}'];return l.find(w=>w.id==='s').value==='y'&&l.find(w=>w.id==='c').value===true}})()"))
        await pg.locator(f'[data-id="{wid}"] input[data-literal=t]').fill('typed'); await pg.wait_for_timeout(900)
        ok('a text widget is saved and calls OnWidget',await pg.evaluate(f"W.snapshot.widgets['{wid}'].find(w=>w.id==='t').value")=='typed' and await pg.evaluate("Backend.hooksIdle().then(()=>api(`projects/${W.project}/state/widget`)).then(e=>e.value)")=='t')
        read=await pg.evaluate("id=>api(`projects/${W.project}/evaluate-node`,{method:'POST',body:{workflow_id:W.workflow,node_ids:[id]}}).then(r=>JSON.parse(r.outputs[id].o))",wid)
        ok('the node reads its widgets when it runs',read.get('t')=='typed' and read.get('b')==2 and read.get('s')=='y' and read.get('c') is True)
        await pg.evaluate("Inspector.toggle(true,false);Inspector.workflow()")
        # types: only any is built in; a type the workflow defines colours its sockets, is listed in the overview, and is made in a dialog
        ok('no type exists until one is defined (any is built in)',await pg.evaluate("W.snapshot.types.length===0&&!document.querySelector('.port[class*=\"t-r\"]')"))
        await pg.click('[data-side-tab=workflow]'); await pg.wait_for_timeout(300)
        ok('the overview offers New type but lists none',await pg.locator('#side-workflow h3:has-text("Types")').count()==1 and await pg.locator('.type-item').count()==0)
        tid='a'*32; kid='b'*32
        await pg.evaluate("""async ([tid,kid])=>{const P=W.project,w={workflow_id:W.workflow};
          await api(`projects/${P}/types`,{method:'PUT',body:{...w,types:[{id:kid,name:'Signal',color:'#33cc99',fields:[]},{id:tid,name:'Person',color:'#ff8800',fields:[{name:'ping',type:'t:'+kid}]}]}});
          await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Maker',inputs:[],outputs:[{id:'who',name:'who',type:'t:'+tid}],init:'node.OnStarted=()=>{node.output.who={ping:1}};'},position:{x:900,y:1700}}});
          await api(`projects/${P}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Wants Signal',inputs:[{id:'s',name:'s',type:'t:'+kid}],outputs:[],init:''},position:{x:1300,y:1700}}});
          await reload()}""",[tid,kid])
        ok('a type colours its socket',await pg.evaluate("tid=>{const s=[...document.querySelectorAll('.port.out')].find(e=>e.classList.contains('t-r'+tid));return !!s&&getComputedStyle(s).getPropertyValue('--tc').trim()==='#ff8800'}",tid))
        ok('the socket is drawn in the type colour',await pg.evaluate("tid=>{const s=[...document.querySelectorAll('.port.out')].find(e=>e.classList.contains('t-r'+tid)).querySelector('.sock');return getComputedStyle(s).boxShadow.includes('255, 136, 0')}",tid))
        await pg.evaluate("Inspector.toggle(true,false);Inspector.workflow()")
        ok('the overview lists the types of the workflow',await pg.locator('.type-item:has(strong:text-is("Person"))').count()==1 and await pg.locator('.type-item:has(strong:text-is("Signal"))').count()==1)
        await pg.click('[data-type-new]'); await pg.wait_for_selector('#modal[open]')
        await pg.fill('#modal input[name=name]','Pet'); await pg.click('#add-type-field'); await pg.locator('#modal [data-name]').last.fill('legs')
        ok('the type selector offers only the types of the workflow',await pg.evaluate("[...document.querySelectorAll('#modal [data-type] option')].map(o=>o.textContent).sort().join('|')")=='Person|Signal|any')
        await pg.locator('#modal [data-type]').last.select_option('t:'+kid); await pg.click('#modal button[value=ok]'); await pg.wait_for_timeout(500)
        ok('the type dialog saves a new type',await pg.evaluate("kid=>W.snapshot.types.some(t=>t.name==='Pet'&&t.fields.length===1&&t.fields[0].type==='t:'+kid)",kid))
        ok('a type that ports use cannot be deleted from the list',await pg.locator('.type-item:has(strong:text-is("Person")) [data-type-delete][disabled]').count()==1 and await pg.locator('.type-item:has(strong:text-is("Pet")) [data-type-delete]:not([disabled])').count()==1)
        # wiring is checked by type
        res=await pg.evaluate("""async tid=>{const n=[...W.snapshot.nodes];const maker=n.find(x=>x.label==='Maker'||x.config?.title==='Maker'),want=n.find(x=>x.config?.title==='Wants Signal');
          try{await api(`projects/${W.project}/port-connections`,{method:'POST',body:{workflow_id:W.workflow,add:[{source:maker.id,source_port:'who',target:want.id,target_port:'s'}]}});return 'connected'}catch(e){return e.message}}""",tid)
        ok('an output of another type cannot be wired to the input',res=='Port types are incompatible')
        ok('a typed output can be dragged to an untyped input (and the other way round)',await pg.evaluate("""async()=>{const w={workflow_id:W.workflow};
          const sink=await api(`projects/${W.project}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Sink',inputs:[{id:'i',name:'i'}],outputs:[{id:'o',name:'o'}],init:''},position:{x:1500,y:1700}}});await reload();
          const maker=[...W.snapshot.nodes].find(x=>x.config?.title==='Maker');
          const a={id:maker.id,port:'who',dir:'out',face:''},i={id:sink.id,port:'i',dir:'in',face:''},o={id:sink.id,port:'o',dir:'out',face:''},want=[...W.snapshot.nodes].find(x=>x.config?.title==='Wants Signal');
          return endpointsFit(a,i)&&endpointsFit(i,a)&&endpointsFit(o,{id:want.id,port:'s',dir:'in',face:''})&&!endpointsFit(a,{id:want.id,port:'s',dir:'in',face:''})}"""))
        # the control of a type: a free slot shows it on the node, typing sets the default of the slot, a wire hides it
        await pg.evaluate("""async()=>{const w={workflow_id:W.workflow},cid='c'.repeat(32),mid='d'.repeat(32);
          await api(`projects/${W.project}/types`,{method:'PUT',body:{...w,types:[...W.snapshot.types,{id:cid,name:'Count',fields:[],control:'number'},{id:mid,name:'Mode',fields:[],control:'select',options:['fast','slow']}]}});
          await api(`projects/${W.project}/typed-nodes`,{method:'POST',body:{...w,node_type:'custom',config:{title:'Job',inputs:[{id:'n',name:'count',type:'t:'+cid},{id:'m',name:'mode',type:'t:'+mid}],outputs:[],init:''},position:{x:1700,y:1700}}});await reload()}""")
        await pg.evaluate("reveal(W.snapshot.nodes.find(n=>n.config?.title==='Job').id)"); await pg.wait_for_timeout(600)
        ok('a free slot whose type has a control shows it on the node',await pg.locator('input.slot-field[data-literal="in:n"]').count()==1 and await pg.locator('select.slot-field[data-literal="in:m"] option').count()==3)
        await pg.fill('input.slot-field[data-literal="in:n"]','7'); await pg.wait_for_timeout(900); await pg.select_option('select.slot-field[data-literal="in:m"]',label='slow'); await pg.wait_for_timeout(900)
        ok('what is typed on the node is the default of the slot',await pg.evaluate("JSON.stringify(W.snapshot.nodes.find(n=>n.config?.title==='Job').config.inputs.map(p=>p.default))")=='[7,"slow"]')
        ok('an enum offers only its options',await pg.evaluate("api(`projects/${W.project}/input-values`,{method:'PUT',body:{workflow_id:W.workflow,node_id:W.snapshot.nodes.find(n=>n.config?.title==='Job').id,values:{m:'medium'}}}).then(()=>false,e=>/not a value/.test(e.message))"))
        ok('a free slot keeps its name next to its control',await pg.evaluate("[...document.querySelectorAll('.node .port.in.has-field .port-name')].map(e=>e.textContent).join()")=='count,mode')
        await pg.evaluate("document.activeElement.blur()")
        await pg.evaluate("api(`projects/${W.project}/widgets/${W.snapshot.nodes.find(n=>n.config?.title==='Job').id}`,{method:'PUT',body:{workflow_id:W.workflow,widgets:[{id:'bare',kind:'text'},{id:'named',kind:'text',label:'Named'}]}}).then(()=>reload())"); await pg.wait_for_timeout(500); await pg.evaluate("reveal(W.snapshot.nodes.find(n=>n.config?.title==='Job').id)"); await pg.wait_for_timeout(600)
        ok('a widget without a label shows no caption',await pg.evaluate("(n=>n.querySelectorAll('.widget').length===2&&n.querySelectorAll('.widget-label').length===1)(document.querySelector('.node[data-id=\"'+W.snapshot.nodes.find(n=>n.config?.title==='Job').id+'\"]'))"))
        # any node can be renamed on the canvas (F2 or the menu), like it can be recolored
        await pg.evaluate("document.activeElement.blur();select([W.snapshot.nodes.find(n=>n.config?.title==='Job').id])"); await pg.keyboard.press('F2'); await pg.wait_for_timeout(200)
        await pg.keyboard.type('Renamed job'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(700)
        ok('a Custom node is renamed on the canvas',await pg.evaluate("W.snapshot.nodes.find(n=>n.config?.title==='Renamed job')!==undefined&&[...document.querySelectorAll('.node .title')].some(e=>e.textContent==='Renamed job')"))
        await pg.evaluate("document.activeElement.blur();select([selectionIdOf(W.snapshot.complex.find(c=>c.locked&&c.source)?.id)])"); await pg.keyboard.press('F2'); await pg.wait_for_timeout(200)
        await pg.keyboard.type('Mine'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(700)
        ok('so is a node placed from the Library',await pg.evaluate("W.snapshot.complex.some(c=>c.source&&c.name==='Mine')"))
        # ... and in its Properties
        await pg.evaluate("Inspector.tab='properties';Inspector.toggle(true,false);document.activeElement.blur();select([selectionIdOf(W.snapshot.complex.find(c=>c.locked&&c.source)?.id)])"); await pg.wait_for_timeout(500)
        await pg.click('[data-rename]'); await pg.fill('#node-name','Mine too'); await pg.press('#node-name','Enter'); await pg.wait_for_timeout(800)
        ok('a node placed from the Library is renamed in its Properties',await pg.evaluate("W.snapshot.complex.some(c=>c.source&&c.name==='Mine too')"))
        await pg.evaluate("document.activeElement.blur();select([W.snapshot.nodes.find(n=>n.config?.title==='Renamed job').id])"); await pg.wait_for_timeout(500)
        await pg.click('[data-rename]'); await pg.fill('#node-name','Job again'); await pg.press('#node-name','Enter'); await pg.wait_for_timeout(800)
        ok('and so is a Custom node',await pg.evaluate("W.snapshot.nodes.some(n=>n.config?.title==='Job again')"))
        # adding or removing a slot of its own on a placed node leaves the slots of the definition in the panel
        await pg.evaluate("""async()=>{const ed=await api('library/node-editor',{method:'POST',body:{}});const snap=await api(`projects/${ed.project_id}/workflow`,{query:{workflow_id:ed.workflow_id}});
          await api(`projects/${ed.project_id}/complex/${snap.root}`,{method:'PUT',body:{workflow_id:ed.workflow_id,interface:{inputs:[{id:'a',name:'alpha'},{id:'b',name:'beta'}],outputs:[{id:'o',name:'out'}]},arbitrary:{inputs:true,outputs:true},init:'node.OnStarted=()=>{}'}});
          const g=await api(`projects/${W.project}/custom-nodes/${ed.resource_id}`,{method:'POST',body:{workflow_id:W.workflow,point:{x:2200,y:1700}}});await reload();window.__arb=g.roots[0]}""")
        await pg.evaluate("Inspector.tab='properties'; select(['complex:'+window.__arb])"); await pg.wait_for_timeout(700)
        names="[...document.querySelectorAll('#side-selection .connection-port')].map(r=>(r.querySelector('[data-field=name]')?.value??r.querySelector('strong')?.textContent)).join()"
        await pg.click('[data-add=inputs]'); await pg.wait_for_timeout(1200); await pg.click('[data-add=inputs]'); await pg.wait_for_timeout(1500)
        ok('adding slots keeps the slots of the definition in the panel',await pg.evaluate(names)=='alpha,beta,input,input2,out')
        await pg.click('#own-inputs .port-row:first-child [data-remove-port]'); await pg.wait_for_timeout(1500)
        ok('and so does removing one',await pg.evaluate(names)=='alpha,beta,input2,out')
        # Enabled: a Custom Node that is off is dimmed in the Library and missing from the Add menu
        await pg.goto(U+'#/resources/custom_node'); await pg.wait_for_selector('.cards .card')
        await pg.locator('.card:has(h3 span:text-is("Preview")) [data-enable]').uncheck(); await pg.wait_for_timeout(500)
        ok('a disabled Custom Node is dimmed',await pg.locator('.card.off:has(h3 span:text-is("Preview"))').count()==1)
        ok('and is not offered in the Add menu',await pg.evaluate("nodeOn(app.resources.find(r=>r.name==='Preview'))===false&&!(addItems()||[]).some(i=>i[0]==='Preview')"))
        await pg.locator('.card:has(h3 span:text-is("Preview")) [data-enable]').check(); await pg.wait_for_timeout(500)
        ok('enabling it brings it back',await pg.evaluate("nodeOn(app.resources.find(r=>r.name==='Preview'))===true"))
        await pg.goto(f'{U}#/p/{pid}/w/{pid}'); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(500)
        # a Custom Node placed from the Library shows the widgets its code made on its body; the editor has no types or Controls
        await pg.evaluate("""async()=>{const ed=await api('library/node-editor',{method:'POST',body:{}});const snap=await api(`projects/${ed.project_id}/workflow`,{query:{workflow_id:ed.workflow_id}});
          await api(`projects/${ed.project_id}/complex/${snap.root}`,{method:'PUT',body:{workflow_id:ed.workflow_id,interface:{inputs:[],outputs:[{id:'text',name:'text'}]},init:'node.OnPlaced = () => node.setWidgets([{id:"t",kind:"textarea",label:"Text",value:"ctl"}]); node.OnStarted = () => { node.output.text = node.widgets.t; };'}});
          const g=await api(`projects/${W.project}/custom-nodes/${ed.resource_id}`,{method:'POST',body:{workflow_id:W.workflow,point:{x:1200,y:1500}}});await Backend.hooksIdle();await reload();window.__ctl=g.roots[0];window.__ctlRes=ed.resource_id}""")
        await pg.evaluate("reveal('complex:'+window.__ctl)"); await pg.wait_for_timeout(500)
        ok('a placed Custom Node shows its widgets and has no socket for them',await pg.evaluate("(()=>{const n=document.querySelector(`[data-id=\"complex:${window.__ctl}\"]`);return !!n?.querySelector('.widgets textarea[data-literal=t]')&&n.querySelectorAll('.sock').length===1})()"))
        await pg.evaluate("openNodeEditor(window.__ctlRes)"); await pg.wait_for_selector('#canvas'); await pg.wait_for_timeout(800)
        await pg.evaluate("Inspector.tab='properties';Inspector.toggle(true,false);select(['frame:'+W.snapshot.root])"); await pg.wait_for_timeout(500)
        ok('the Library editor has type selectors for its slots and no Controls section',await pg.evaluate("!document.querySelector('#side-selection [data-direction=controls]')&&!!document.querySelector('#side-selection select[data-field=type]')&&![...document.querySelectorAll('#side-selection h3')].some(h=>h.textContent.includes('Controls'))"))
        # the widgets of a Library node are declared, not made by code: a field in the editor, and every copy has them from the start
        ok('the Library editor lists the widgets as cards with an Add widget button, not as JSON',await pg.evaluate("!!document.querySelector('#side-selection [data-add-widget]')&&!document.querySelector('#side-selection textarea[name=widgets]')"))
        await pg.click('#side-selection [data-add-widget]')
        await pg.fill('#side-selection [data-widget-row] [data-wfield=id]','decl')
        await pg.fill('#side-selection [data-widget-row] [data-wfield=label]','Declared')
        await pg.fill('#side-selection [data-widget-row] [data-wfield=value]','d1'); await pg.wait_for_timeout(1500)
        ok('widgets typed there are saved on the node',await pg.evaluate("api(`projects/${W.project}/workflow`,{query:{workflow_id:W.workflow}}).then(s=>JSON.stringify(s.nodes.find(n=>n.config?.body)?.config.widgets))")=='[{"id":"decl","kind":"text","label":"Declared","value":"d1"}]')
        ok('a copy of the node has its widgets at once, with no OnPlaced',await pg.evaluate("""async(pid)=>{const g=await api(`projects/${pid}/custom-nodes/${W.library}`,{method:'POST',body:{workflow_id:pid,point:{x:0,y:0}}});const snap=await api(`projects/${pid}/workflow`,{query:{workflow_id:pid}});const body=snap.complex.find(c=>c.id===g.roots[0]).body;return JSON.stringify((snap.widgets[body]||[]).map(w=>[w.id,w.value]))}""",pid)=='[["decl","d1"]]')
        await pg.goto(U+'#/resources/provider/new'); await pg.wait_for_selector('#resource-form')
        await pg.click('#resource-form details summary'); await pg.fill('textarea[name=headers]','{oops'); await pg.click('#provider-models-button'); await pg.wait_for_timeout(400)
        ok('bad JSON in the provider form is reported in a toast',await pg.locator('.toast.error').count()>=1)
        ok('no console errors',not logs); 
        if logs: print(logs[:5])
        await b.close()
        assert not failures, failures
asyncio.run(main())
