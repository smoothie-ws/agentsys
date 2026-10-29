"""Navigation audit on a disposable server: desktop, phone, links, history and async races."""
import asyncio
import os
from pathlib import Path
import tempfile
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def audit(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width':1500,'height':1000})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(base + '/editor/')
        await page.wait_for_selector('.dashboard')
        ids = await page.evaluate("""async () => {
          app.preferences = await api('settings',{method:'PUT',body:{developer_mode:true}});
          const a = await api('projects',{method:'POST',body:{name:'Navigation A'}});
          const b = await api('projects',{method:'POST',body:{name:'Navigation B'}});
          const second = await api(`projects/${a.id}/workflows`,{method:'POST',body:{name:'Second'}});
          await api('library/node-folders',{method:'POST',body:{action:'create',path:'',name:'Audit'}});
          await api('library/node-folders',{method:'POST',body:{action:'create',path:'Audit',name:'Nested'}});
          const text = app.resources.find(r => r.name === 'Text');
          const node = await api('resources',{method:'POST',body:{name:'Audit text',payload:{...text.payload,folder:'Audit/Nested'}}});
          await loadLibrary(); await loadProjects();
          return {a:a.id,b:b.id,second:second.id,node:node.id};
        }""")
        routes = [('/', '.dashboard'),('/projects','.cards'),(f'/p/{ids["a"]}','.page-head h1'),
            (f'/p/{ids["a"]}/settings','#project-form'),('/library','.cards'),('/library/nodes','.cards'),
            ('/library/nodes?folder=Audit%2FNested','.cards'),('/plugins','.cards'),('/plugins/ai','.plugin-page'),
            ('/library/ai.ai','.cards'),('/library/ai.providers','.page-head'),
            ('/library/ai.skills','.page-head'),('/api','.api-method-heading'),('/settings','#settings-form'),
            ('/runs','.runs-page'),(f'/p/{ids["a"]}/w/{ids["second"]}','#canvas')]
        for path, selector in routes:
            await page.evaluate('path=>go(path)',path)
            await page.wait_for_selector(selector)
            assert 'Could not open' not in await page.locator('#view').inner_text(), path
            assert await page.locator('.crumbs, nav[aria-label=Path]').count() == 0
            if await page.evaluate("sectionOf(app.route) !== 'home'"):
                assert await page.locator('#subnav a').filter(has_text='Overview').count() == 0
            assert await page.evaluate('''async () => {
              const menus = new Set([...document.querySelectorAll('[data-menu]')].map(el=>el.dataset.menu));
              for (const menu of menus) if ((await menuItems(menu) || []).some(item=>item?.[0]==='Refresh')) return false;
              return true;
            }''')
            links = await page.locator('#view a[data-link], #subnav a[data-link]').evaluate_all("""els => els.map(e => {
              e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); return e.getAttribute('href');
            })""")
            assert all(href.startswith('/editor/') and '/editor/editor/' not in href for href in links), (path,links)
        print('PASS main routes, project settings, Library groups, plugin pages, API and native link addresses',flush=True)
        node_id = await page.evaluate("""async () => {
          const result = await api(`projects/${W.project}/primitives`, {method:'POST', body:wf({primitive:'script',point:{x:100,y:100}})});
          await reload();
          W.nodes.get(result.id).status = 'completed';
          draw();
          return result.id;
        }""")
        mark = page.locator(f'.node[data-id="{node_id}"] .run-state.completed')
        await mark.wait_for()
        assert await mark.evaluate("""el => {
          const mark=el.getBoundingClientRect(), node=el.closest('.node').getBoundingClientRect();
          return mark.bottom < node.top && mark.right <= node.right && mark.left > node.left + node.width/2;
        }""")
        await page.evaluate("""id => {W.nodes.get(id).folded=true;draw();}""",node_id)
        assert await mark.evaluate("el=>el.getBoundingClientRect().bottom < el.closest('.node').getBoundingClientRect().top")
        print('PASS node status icons sit above the right edge on expanded and folded nodes',flush=True)
        assert await page.locator('.editor-parent').count() == 0
        await page.evaluate('go(parentPage(app.route)[1])')
        await page.wait_for_selector('.page-head h1')
        await page.evaluate('id=>openNodeEditor(id)',ids['node'])
        await page.wait_for_selector('#canvas')
        await page.locator('[data-side-tab=workflow]').click()
        headings = await page.locator('#side-workflow h3').all_text_contents()
        assert headings.index('Types') < headings.index('Available nodes'), headings
        assert await page.locator('[data-available-nodes] > p').count() == 0
        assert await page.locator('.editor-parent').count() == 0
        await page.evaluate('go(parentPage(app.route)[1])')
        await page.wait_for_selector('#view h1')
        assert await page.locator('#view h1').inner_text() == 'Nested'
        await page.locator('#subnav [data-key="f:Audit"] a').click()
        await page.wait_for_function("app.route.folder==='Audit'")
        assert await page.locator('#subnav [data-group="f:Audit"] [data-key="f:Audit"]').is_visible()
        print('PASS navigation without canvas Back or breadcrumbs; availability follows Types',flush=True)
        # The URL, Back/Forward and native new tabs must agree on the page and section.
        await page.evaluate("go('/runs?section=activations')")
        await page.get_by_role('link',name='Versions',exact=True).click()
        assert 'section=versions' in page.url
        await page.go_back()
        await page.wait_for_selector('#runs-runs:not([hidden])')
        await page.go_forward()
        await page.wait_for_selector('#runs-versions:not([hidden])')
        await page.evaluate("go('/api')")
        await page.wait_for_function("document.querySelector('#subnav-title').textContent === 'Dashboard'")
        assert await page.locator('#sidebar [data-section=api], #sidebar [data-section=runs]').count() == 0
        assert await page.locator('#view .api-list, #view .api-calls, #view .api-group').count() == 0
        assert await page.locator('#subnav [data-key^="api-path:"]').count() > 10
        await page.get_by_role('searchbox',name='Find an API call').fill('no-such-endpoint-for-this-test')
        assert await page.locator('#subnav [data-key^="api-call:"]').count() == 0
        await page.get_by_role('searchbox',name='Find an API call').fill('projects/{project_id}/workflows')
        call = page.locator('#subnav [data-key^="api-call:"] a:visible').first
        label = await call.evaluate('e=>new URL(e.href).searchParams.get("call")')
        await call.click()
        await page.wait_for_function('key=>routeQuery().get("call")===key',arg=label)
        assert await page.locator('#subnav .subnav-row.active').is_visible()
        await page.get_by_role('searchbox',name='Find an API call').fill('')
        assert await page.locator('.api-method-heading').inner_text()
        await page.locator('.page-head [data-menu]').click()
        async with page.expect_download() as download:
            await page.get_by_role('menuitem',name='Download OpenAPI').click()
        assert (await download.value).suggested_filename == 'agentsys-openapi.json'
        async with page.context.expect_page() as popup:
            await page.locator('#brand').click(button='middle')
        other = await popup.value
        await other.wait_for_selector('.dashboard')
        await other.close()
        for path in ('api/', 'settings/', 'runs/', 'projects/', 'resources/ai.providers/', 'p/lib-builtin.delay/w/lib-builtin.delay/'):
            response = await page.goto(base + '/editor/' + path)
            assert response.status == 200, path
            await page.wait_for_function("typeof app!=='undefined' && app.route && document.querySelector('#view').children.length")
            assert 'Could not open' not in await page.locator('#view').inner_text(), path
            assert await page.locator('.crumbs, nav[aria-label=Path]').count() == 0
            if await page.evaluate("sectionOf(app.route) !== 'home'"):
                assert await page.locator('#subnav a').filter(has_text='Overview').count() == 0
            assert await page.evaluate('''async () => {
              const menus = new Set([...document.querySelectorAll('[data-menu]')].map(el=>el.dataset.menu));
              for (const menu of menus) if ((await menuItems(menu) || []).some(item=>item?.[0]==='Refresh')) return false;
              return true;
            }''')
        print('PASS Back/Forward between sections, API download, middle-click, trailing slashes and dotted IDs',flush=True)
        # An older load must never replace a newer page, including another page of the same kind.
        await page.evaluate("""async ids => {
          const original = api; let release, ready;
          const gate = new Promise(resolve => release=resolve), started = new Promise(resolve => ready=resolve);
          api = async (path, options) => {
            const result = await original(path,options);
            if (path === 'projects/'+ids.a) { ready(); await gate; }
            return result;
          };
          try { const older=go('/p/'+ids.a); await started; await go('/p/'+ids.b); release(); await older; }
          finally { release(); api=original; }
        }""",ids)
        assert await page.locator('#view h1').inner_text() == 'Navigation B'
        assert ids['b'] in page.url
        await page.evaluate("""async ids => {
          const original=api;let release,ready;
          const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>ready=resolve);
          api=async(path,options)=>{const result=await original(path,options);if(path==='projects/'+ids.a){ready();await gate;}return result;};
          try{const older=go(`/p/${ids.a}/w/${ids.a}`);await started;await go('/api');release();await older;}
          finally{release();api=original;}
        }""",ids)
        assert await page.locator('.api-method-heading').count() == 1
        await page.evaluate("""async () => {
          const original=api;let release,ready;
          const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>ready=resolve);
          api=async(path,options)=>{const result=await original(path,options);if(path==='library/sections'){ready();await gate;}return result;};
          try{const older=go('/library/ai.providers');await started;await go('/api');release();await older;}
          finally{release();api=original;}
        }""")
        assert await page.locator('.api-method-heading').count() == 1
        assert await page.locator('#view iframe').count() == 0
        # Search results, notification links and editor tabs all use the same route handling.
        await page.locator('#open-search').click()
        await page.locator('#search-input').fill('Navigation B')
        await page.locator('#search-results a').filter(has_text='Project').first.click()
        await page.wait_for_function('id=>app.route.project===id',arg=ids['b'])
        await page.evaluate("id=>api('notifications',{method:'POST',body:{title:'Open Navigation A',href:'/p/'+id}})",ids['a'])
        await page.locator('#open-notifications').click()
        await page.get_by_role('button',name='Close notifications',exact=True).click()
        await page.locator('#notifications-panel').wait_for(state='hidden')
        assert await page.locator('#open-notifications').get_attribute('aria-expanded') == 'false'
        await page.locator('#open-notifications').click()
        await page.locator('#notifications-panel a').filter(has_text='Open Navigation A').click()
        await page.wait_for_function('id=>app.route.project===id',arg=ids['a'])
        await page.locator('#notifications-panel').wait_for(state='hidden')
        await page.evaluate('id=>go(`/p/${id}/w/${id}`)',ids['a'])
        await page.evaluate('id=>go(`/p/${id}/w/${id}`)',ids['b'])
        active = page.locator('#tabs .tab.active')
        expected = await active.evaluate("e=>{const tabs=[...e.parentElement.querySelectorAll('.tab:not(.closing)')];return tabs[(tabs.indexOf(e)+1)%tabs.length].dataset.path}")
        await active.focus()
        await page.keyboard.press('ArrowRight')
        await page.wait_for_function('path=>routePath()===path',arg=expected)
        await page.evaluate('()=>Tabs.closeMany(Tabs.items.map(Tabs.key))')
        await page.wait_for_selector('#view h1')
        assert await page.locator('#canvas').count() == 0
        assert (await page.locator('#view h1').inner_text()) in ('Navigation A','Navigation B','Nested')
        await page.evaluate("go('/not-a-page')")
        assert await page.locator('#view h1').inner_text() == 'Page not found'
        await page.locator('#brand').click()
        await page.wait_for_selector('.dashboard')
        await page.evaluate("go('/p/absent')")
        await page.locator('#view .empty a').click()
        await page.wait_for_selector('.page-head [data-menu]')
        print('PASS delayed navigation, search, notifications, keyboard tabs, closing editors, unknown routes and contextual error exits',flush=True)
        await page.set_viewport_size({'width':390,'height':900})
        await page.evaluate("go('/runs?section=activations')")
        await page.locator('#mobile-browse').click()
        await page.locator('#subnav-list a').filter(has_text='Workflows').click()
        await page.wait_for_selector('#runs-workflows:not([hidden])')
        await page.locator('#brand').click()
        await page.wait_for_selector('.dashboard')
        for path in ('/api','/library/ai.providers','/library/nodes?folder=Audit%2FNested',f'/p/{ids["a"]}/w/{ids["a"]}'):
            await page.evaluate('path=>go(path)',path)
            await page.locator('#mobile-browse').click()
            assert await page.locator('#subnav').get_attribute('aria-modal') == 'true'
            await page.keyboard.press('Escape')
            assert not await page.locator('main').evaluate('e=>e.inert')
            if path == '/api':
                await page.locator('#brand').click()
                await page.wait_for_selector('.dashboard')
        assert await page.locator('.editor-parent').count() == 0
        await page.evaluate('go(parentPage(app.route)[1])')
        await page.wait_for_selector('.page-head h1')
        # Leaving phone mode while the navigation sheet is open must clear its modal state.
        await page.locator('#mobile-browse').click()
        await page.set_viewport_size({'width':1500,'height':1000})
        await page.wait_for_timeout(100)
        assert await page.locator('#subnav').get_attribute('aria-modal') is None
        assert not await page.locator('main').evaluate('e=>e.inert')
        assert not errors, errors
        print('PASS phone Dashboard navigation, API exit, navigation sheets and viewport changes',flush=True)
        # Legacy URLs become canonical, including a hash change after boot.
        await page.goto(base + '/editor/resources/nodes?folder=Audit%2FNested')
        await page.wait_for_selector('#view h1')
        assert '/editor/library/nodes?folder=' in page.url
        await page.goto(base + '/index.html#/resources/nodes')
        await page.wait_for_selector('#view h1')
        assert page.url.endswith('#/library/nodes')
        await page.evaluate("location.hash = '/resources'")
        await page.wait_for_url('**#/library')
        # The same routing/link handling works with hash URLs when served without /editor/ paths.
        await page.goto(base + '/index.html#/api')
        await page.wait_for_selector('.api-method-heading')
        await page.locator('#brand').click()
        await page.wait_for_selector('.dashboard')
        assert page.url.endswith('#/')
        assert not errors, errors
        # Denied server storage must never silently become a separate browser database.
        for status in [401, 403, 503]:
            denied = await browser.new_page()
            async def reject_storage(route):
                await route.fulfill(status=status, content_type='application/json', body='{"error":"denied"}')
            await denied.route('**/__data', reject_storage)
            await denied.goto(base + '/editor/')
            await denied.wait_for_selector('#view .empty')
            assert 'Server storage is unavailable' in await denied.locator('#view').inner_text()
            assert await denied.locator('.dashboard').count() == 0
            await denied.close()
        await browser.close()
        print('PASS hash routing and Dashboard return; no page errors',flush=True)


if __name__=='__main__':
    with isolated_server() as (base, directory):
        asyncio.run(audit(base))
