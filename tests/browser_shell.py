"""API scrolling, scoped Library actions, live tabs and connected canvas panels."""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright
from browser_server import isolated_server

async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1440, 'height': 850})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(base + '/editor/api')
        await page.wait_for_selector('.api-call')
        assert await page.evaluate("document.querySelector('#topstrip').parentElement===document.body")
        assert await page.evaluate("document.querySelector('#topstrip').firstElementChild.id==='toggle-subnav' && document.querySelector('#sidebar .sidebar-top .sidebar-item:first-child > #brand') && !document.querySelector('#topstrip #brand') && !document.querySelector('#subnav-title') && !document.querySelector('#subnav-actions')")
        for width in [1920, 1440, 1000]:
            await page.set_viewport_size({'width':width,'height':850})
            await page.wait_for_timeout(350)
            assert await page.evaluate("Math.abs(document.querySelector('#subnav').getBoundingClientRect().top-document.querySelector('#topstrip').getBoundingClientRect().bottom)<1")
            assert await page.evaluate("Math.abs(document.querySelector('#topstrip').getBoundingClientRect().width-(innerWidth-16))<1")
            assert await page.evaluate("""() => { const header=document.querySelector('#topstrip').getBoundingClientRect(),
              main=document.querySelector('main').getBoundingClientRect();
              return Math.abs(header.left-8)<1 && Math.abs(header.top-8)<1 && Math.abs(innerHeight-main.bottom-8)<1; }""")
        await page.evaluate('toggleSidebar(true)')
        await page.wait_for_timeout(350)
        tabs_x = await page.locator('#tabs').evaluate('el=>el.getBoundingClientRect().x')
        subnav_folded = await page.evaluate("document.body.classList.contains('subnav-collapsed')")
        await page.locator('#toggle-subnav').click()
        await page.wait_for_timeout(350)
        assert await page.locator('#brand > span:last-child').is_hidden()
        assert await page.locator('#tabs').evaluate('el=>el.getBoundingClientRect().x') == tabs_x
        assert await page.evaluate("document.body.classList.contains('subnav-collapsed')") == subnav_folded
        assert await page.locator('#brand .brand-mark').is_visible()
        assert await page.locator('#toggle-subnav').get_attribute('aria-expanded') == 'false'
        await page.reload()
        await page.wait_for_selector('.api-call')
        assert await page.locator('#brand > span:last-child').is_hidden()
        await page.locator('#toggle-subnav').click()
        await page.wait_for_timeout(350)
        assert await page.locator('#brand > span:last-child').is_visible()
        assert await page.locator('#toggle-subnav').get_attribute('aria-expanded') == 'true'
        await page.locator('#brand').click()
        await page.wait_for_selector('.dashboard')
        await page.evaluate("go('/api')")
        await page.wait_for_selector('.api-call')
        print('PASS full-width header, Dashboard brand and persistent navigation toggle', flush=True)
        artifacts = Path('data/ui-review')
        artifacts.mkdir(parents=True, exist_ok=True)
        for width, height in [(1440, 700), (1000, 700), (390, 780)]:
            await page.set_viewport_size({'width': width, 'height': height})
            await page.evaluate("go('/api?call='+encodeURIComponent('post /api/projects/import'))")
            await page.locator('#api-method-search').fill('projects')
            await page.wait_for_timeout(150)
            metrics = await page.evaluate('''() => {
              const view=document.querySelector('#view'), tree=document.querySelector('.api-call-tree'), method=document.querySelector('.api-method');
              tree.scrollTop=200; method.scrollTop=200; view.scrollTop=200;
              return {outer:view.scrollTop,overflow:view.scrollHeight-view.clientHeight,tree:tree.scrollTop,method:method.scrollTop,
                row:document.querySelector('.api-call').getBoundingClientRect().height,
                page:document.documentElement.scrollHeight-innerHeight};
            }''')
            assert metrics['outer'] == 0 and metrics['overflow'] <= 1 and metrics['page'] <= 1, (width, metrics)
            assert metrics['tree'] > 0 and metrics['method'] > 0, (width, metrics)
            assert metrics['row'] <= 28, metrics
            await page.screenshot(path=str(artifacts / f'api-{width}.png'))
        print('PASS compact API tree and independent scrolling at desktop and phone sizes', flush=True)
        await page.set_viewport_size({'width': 1440, 'height': 850})
        await page.evaluate("api('settings',{method:'PUT',body:{developer_mode:true}}).then(()=>go('/library'))")
        assert await page.locator('#sidebar [data-menu="section:library"]').count() == 1
        assert await page.locator('#subnav-actions').count() == 0
        await page.locator('#sidebar [data-menu="section:library"]').click()
        assert await page.get_by_role('menuitem', name='New node', exact=True).count() == 0
        assert await page.get_by_role('menuitem', name='New group', exact=True).count() == 0
        await page.keyboard.press('Escape')
        await page.evaluate("go('/library/nodes')")
        await page.locator('.page-head [data-menu]').click()
        assert await page.get_by_role('menuitem', name='New node', exact=True).count() == 1
        assert await page.get_by_role('menuitem', name='New group', exact=True).count() == 1
        await page.keyboard.press('Escape')
        await page.locator('#sidebar [data-section=library]').click()
        await page.wait_for_selector('h1:has-text("Library")')
        for route, title in [('/plugins/ai', 'Plugins'), ('/projects', 'Projects')]:
            await page.evaluate('route => go(route)', route)
            await page.locator('#sidebar [data-section='+title.lower()+']').click()
            await page.wait_for_selector('h1:has-text("'+title+'")')
        print('PASS Library actions belong to their sections and primary navigation opens section pages', flush=True)
        fixture = await page.evaluate('''async () => {
          const project=await api('projects',{method:'POST',body:{name:'Live tabs'}});
          const other=await api(`projects/${project.id}/workflows`,{method:'POST',body:{name:'Other'}});
          const types=(await api(`projects/${project.id}/types`)).types;
          const script=await api(`projects/${project.id}/typed-nodes`,{method:'POST',body:{node_type:'custom',config:{title:'Waiting',op:'script',
            inputs:[{id:'in',name:'in',type:'signal'},{id:'script',name:'script',type:'t:'+types.find(t=>t.control==='code').id,default:'await node.sleep(30000);'}],outputs:[{id:'out',name:'out',type:'signal'}]}}});
          await go(`/p/${project.id}/w/${project.id}`);
          window.shellFixture={project:project.id,other:other.id,script:script.id};return shellFixture;
        }''')
        await page.wait_for_function('W.executionReady')
        await page.evaluate("api(`projects/${shellFixture.project}/execution`,{method:'POST',body:{node_ids:[shellFixture.script]}})")
        tab = page.locator('#tabs [data-tab="'+fixture['project']+'/'+fixture['project']+'"]')
        await page.wait_for_function("document.querySelector('#tabs .is-running') !== null")
        await page.evaluate("go(`/p/${shellFixture.project}/w/${shellFixture.other}`)")
        await page.wait_for_function('W.executionReady')
        assert await tab.evaluate("el=>el.classList.contains('is-running') && !el.classList.contains('active')")
        assert await tab.evaluate("el=>getComputedStyle(el).boxShadow==='none'&&getComputedStyle(el).backgroundImage.includes('linear-gradient')")
        await tab.click()
        await page.wait_for_function("document.querySelector('#tabs .active.is-running') !== null")
        await page.wait_for_function('W.executionReady')
        assert await tab.evaluate("el=>el.classList.contains('active')&&getComputedStyle(el).boxShadow==='none'&&getComputedStyle(el).backgroundImage.includes('linear-gradient')")
        await page.wait_for_timeout(350)
        await page.screenshot(path=str(artifacts / 'workflow-running.png'))
        await page.evaluate("api(`projects/${shellFixture.project}/execution`,{method:'DELETE',query:{workflow_id:shellFixture.project}})")
        await page.wait_for_function("!document.querySelector('#tabs .is-running')")
        await page.evaluate("Inspector.toggle(true,false)")
        await page.locator('[data-side-tab=workflow]').click()
        await page.wait_for_timeout(450)
        await page.locator('[data-side-tab=properties]').click()
        await page.wait_for_timeout(80)
        turning = await page.locator('.side-content').evaluate("""el=>({radius:parseFloat(getComputedStyle(el).borderTopRightRadius),
          transitions:el.getAnimations().map(a=>a.transitionProperty)})""")
        assert 0 < turning['radius'] < 21 and 'border-top-right-radius' in turning['transitions'], turning
        await page.wait_for_timeout(350)
        await page.locator('[data-side-tab=workflow]').click()
        await page.wait_for_timeout(450)
        # Joined highlights and ordinary hover rows share the same geometry, even when folded.
        panels = await page.evaluate("""() => ({sidebar: !document.body.classList.contains('sidebar-hidden'),
          subnav: !document.body.classList.contains('subnav-collapsed')})""")
        for expanded in [False, True]:
            await page.evaluate('(expanded) => { toggleSidebar(expanded, false); toggleSubnav(expanded, false); }', expanded)
            await page.wait_for_timeout(450)
            geometry = await page.evaluate("""() => {
              const rect = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el);
                return {left:r.left,right:r.right,width:r.width,height:r.height,centerX:r.x+r.width/2,centerY:r.y+r.height/2,
                  radiusLeft:s.borderTopLeftRadius,radiusRight:s.borderTopRightRadius}; };
              const side=document.querySelector('#sidebar .sidebar-item.active'),
                sub=shownRow(document.querySelector('#subnav .subnav-row.active')),
                right=document.querySelector('.side-tabs button.active');
              return {side:rect(side),sidePill:rect(document.querySelector('#sidebar .nav-pill')),
                sideIcon:rect(side.querySelector('svg,.brand-mark')),menuIcon:rect(document.querySelector('#toggle-subnav svg')),
                sub:rect(sub),subIcon:rect(sub.querySelector('a svg,.subnav-static svg')),
                subPill:rect(document.querySelector('#subnav-body .nav-pill')),
                right:rect(right),rightPill:rect(document.querySelector('.side-tabs .nav-pill')),
                rightIcon:rect(right.querySelector('svg')),notification:rect(document.querySelector('#open-notifications svg')),
                close:rect(document.querySelector('[data-side-close]')),
                toolbar:rect(document.querySelector('#start')),first:rect(document.querySelector('#sidebar .sidebar-item'))};
            }""")
            near = lambda a, b: abs(a-b) < 1
            for row, pill in [('side', 'sidePill'), ('sub', 'subPill'), ('right', 'rightPill')]:
                assert near(geometry[row]['right'], geometry[pill]['right']) and near(geometry[row]['centerY'], geometry[pill]['centerY']), geometry
                assert near(geometry[row]['height'], 42) and near(geometry[pill]['height'], 42), geometry
            assert near(geometry['right']['width'], 48) and near(geometry['right']['height'], 42), geometry
            assert near(geometry['side']['left'], geometry['sidePill']['left'])
            assert near(geometry['sub']['left'], geometry['subPill']['left'])
            assert near(geometry['right']['left'], geometry['rightPill']['left'])
            assert geometry['sidePill']['radiusLeft'] == geometry['subPill']['radiusLeft'] == '21px'
            assert geometry['rightPill']['radiusRight'] == '21px'
            assert near(geometry['sideIcon']['centerX'], geometry['menuIcon']['centerX'])
            assert near(geometry['rightIcon']['centerX'], geometry['notification']['centerX'])
            assert near(geometry['toolbar']['centerY'], geometry['first']['centerY'])
            assert near(geometry['close']['centerY'], geometry['first']['centerY'])
            await page.locator('#sidebar .sidebar-item:not(.active)').first.hover()
            hover = await page.locator('#sidebar .sidebar-item:not(.active)').first.evaluate("""el=>{
              const s=getComputedStyle(el,'::before');return {width:parseFloat(s.width),height:parseFloat(s.height),radius:s.borderRadius}; }""")
            assert hover['height'] == 32, hover
            assert hover['radius'] == ('16px' if expanded else '50%'), hover
            if not expanded:
                assert hover['width'] == 32, hover
                folded_inset = (geometry['side']['width'] - hover['width']) / 2
            else:
                assert abs((geometry['side']['width'] - hover['width']) / 2 - folded_inset) < 1, hover
            await page.locator('.side-tabs button:not(.active)').first.hover()
            hover = await page.locator('.side-tabs button:not(.active)').first.evaluate("""el=>{
              const s=getComputedStyle(el,'::before');return {width:parseFloat(s.width),height:parseFloat(s.height),radius:s.borderRadius}; }""")
            assert hover == {'width': 32, 'height': 32, 'radius': '50%'}, hover
            if expanded:
                aligned = await page.evaluate("""() => { const p=document.querySelector('#subnav .subnav-group > .subnav-row > a svg'),
                  c=document.querySelector('#subnav .subnav-branch .subnav-row a svg');
                  return p && c && Math.abs(p.getBoundingClientRect().left-c.getBoundingClientRect().left)<1; }""")
                assert aligned
        await page.evaluate('(panels) => { toggleSidebar(panels.sidebar, false); toggleSubnav(panels.subnav, false); }', panels)
        await page.wait_for_timeout(450)
        assert await page.locator('.side-tabs > .nav-pill:not(.off)').count() == 1
        assert await page.locator('.side-content > .nav-seam:not(.off)').count() == 1
        assert await page.evaluate("getComputedStyle(document.querySelector('.side-tabs > .nav-pill')).display") != 'none'
        assert await page.evaluate("getComputedStyle(document.querySelector('main > .nav-seam')).display") != 'none'
        assert await page.evaluate("getComputedStyle(document.querySelector('main')).backgroundColor") == 'rgba(0, 0, 0, 0)'
        assert await page.locator('#hint-list, #hints, .workflow-section summary small, .permission-hint').count() == 0
        assert await page.locator('#snap-toggle').evaluate("el=>!!el.closest('.toolbar')")
        assert await page.locator('#canvas-hints').is_visible()
        await page.locator('#hints-toggle').click()
        assert await page.locator('#canvas-hints').is_hidden()
        await page.locator('#hints-toggle').click()
        assert await page.locator('#canvas-hints').is_visible()
        assert await page.locator('#run-summary').count() == 0
        assert await page.locator('#hints-toggle').evaluate("el=>!!el.closest('.toolbar') && el.title.includes('Pan')")
        layout = await page.evaluate("""() => {
          const canvas=document.querySelector('#canvas').getBoundingClientRect(),
            tools=document.querySelector('.canvas-tools').getBoundingClientRect(),
            map=document.querySelector('.map').getBoundingClientRect(),
            hints=document.querySelector('#canvas-hints'), rect=hints.getBoundingClientRect(), style=getComputedStyle(hints);
          return {center:Math.abs(tools.y+tools.height/2-canvas.y-canvas.height/2),
            beside:rect.left>=map.right, aligned:Math.abs(rect.bottom-map.bottom)<1,
            background:style.backgroundColor,blur:style.backdropFilter};
        }""")
        assert layout['center'] < 1 and layout['beside'] and layout['aligned'], layout
        assert layout['background'] == 'rgba(0, 0, 0, 0)' and layout['blur'] == 'none', layout
        for width in [1440, 1280, 1000, 768, 390]:
            await page.set_viewport_size({'width': width, 'height': 850})
            await page.evaluate('Inspector.toggle(true,false)')
            await page.wait_for_timeout(350)
            await page.locator('#hints-toggle').evaluate("el=>el.scrollIntoView({block:'nearest',inline:'nearest'})")
            geometry = await page.evaluate("""() => {
              const toolbar=document.querySelector('.toolbar').getBoundingClientRect();
              const panel=document.querySelector('.side').getBoundingClientRect();
              const canvas=document.querySelector('#canvas').getBoundingClientRect();
              const view=document.querySelector('#view');
              const keyboard=document.querySelector('#hints-toggle').getBoundingClientRect();
              return {overlap:toolbar.right>panel.left&&toolbar.left<panel.right&&toolbar.bottom>panel.top&&toolbar.top<panel.bottom,
                canvasRight:canvas.right,panelLeft:panel.left,available:view.clientWidth,
                toolbarRight:toolbar.right,keyboardRight:keyboard.right,overflow:view.scrollWidth-view.clientWidth};
            }""")
            assert not geometry['overlap'] and geometry['overflow'] <= 1, (width, geometry)
            assert geometry['keyboardRight'] <= geometry['toolbarRight'] + 1, (width, geometry)
            assert geometry['canvasRight'] <= geometry['panelLeft'] + 1, (width, geometry)
            assert await page.evaluate("getComputedStyle(document.querySelector('.side-tabs')).backgroundImage==='none'&&getComputedStyle(document.querySelector('.side-tabs')).backgroundColor==='rgba(0, 0, 0, 0)'")
        await page.set_viewport_size({'width':1440,'height':850})
        await page.wait_for_timeout(350)
        await page.screenshot(path=str(artifacts / 'canvas-connected.png'))
        await page.evaluate('applyStyle({...STYLE_DEFAULTS,...THEMES.Light})')
        await page.wait_for_timeout(450)
        await page.screenshot(path=str(artifacts / 'canvas-connected-light.png'))
        for section in ['workflow', 'properties']:
            await page.locator('[data-side-tab='+section+']').click()
            await page.wait_for_timeout(350)
            corners = await page.locator('.side-content').evaluate("el=>{const s=getComputedStyle(el);return [parseFloat(s.borderTopRightRadius),parseFloat(s.borderBottomRightRadius)]}")
            assert corners[0] == (0 if section == 'workflow' else 21) and corners[1] == 21, (section, corners)
            await page.screenshot(path=str(artifacts / ('panel-'+section+'.png')))
        await page.locator('#toggle-subnav').click()
        await page.wait_for_timeout(350)
        await page.screenshot(path=str(artifacts / 'header-collapsed.png'))
        await page.set_viewport_size({'width':390,'height':850})
        await page.reload()
        await page.wait_for_selector('#canvas')
        mobile_tabs_x = await page.locator('#tabs').evaluate('el=>el.getBoundingClientRect().x')
        await page.locator('#toggle-subnav').click()
        assert await page.locator('#sidebar').is_hidden()
        assert await page.locator('#toggle-subnav').get_attribute('aria-controls') == 'sidebar'
        assert await page.locator('#toggle-subnav').get_attribute('aria-expanded') == 'false'
        assert await page.locator('#tabs').evaluate('el=>el.getBoundingClientRect().x') == mobile_tabs_x
        assert await page.locator('#subnav').is_hidden()
        await page.locator('#toggle-subnav').click()
        assert await page.locator('#sidebar').is_visible()
        await page.locator('#mobile-browse').click()
        assert await page.locator('#subnav').is_visible()
        assert await page.locator('#brand > span:last-child').is_hidden()
        assert await page.locator('#subnav-title').count() == 0
        assert await page.locator('#mobile-browse').get_attribute('aria-expanded') == 'true'
        await page.keyboard.press('Escape')
        assert await page.locator('#mobile-browse').get_attribute('aria-expanded') == 'false'
        await page.set_viewport_size({'width':1440,'height':850})
        await page.locator('#toggle-subnav').click()
        await page.evaluate("go('/settings?section=appearance')")
        assert await page.locator('.settings-group > p.muted, .toggle-row small, .page-description').count() == 0
        assert await page.locator('strong[title="Blur, glow and connected panels."]').count() == 1
        assert not errors, errors
        print('PASS live workflow tabs, connected panels, toolbar controls and hover-only help', flush=True)
        await browser.close()

if __name__ == '__main__':
    with isolated_server() as (base, _):
        asyncio.run(check(base))
