"""User-facing project/workflow/theme exchange, and read-only Library."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
from playwright.async_api import async_playwright


async def upload(page, selector, value, name):
    async with page.expect_file_chooser() as chooser:
        await page.locator(selector).click()
    await (await chooser.value).set_files({'name':name,'mimeType':'application/json','buffer':json.dumps(value).encode()})


async def download(page, action):
    async with page.expect_download() as pending:
        await action()
    return json.loads(Path(await (await pending.value).path()).read_text(encoding='utf-8'))


async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page=await browser.new_page(viewport={'width':1600,'height':1000})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto(f'http://127.0.0.1:{sys.argv[1]}/index.html#/library/nodes')
        await page.wait_for_function("typeof Backend!=='undefined' && document.querySelector('#view').children.length")
        await page.evaluate("async()=>{await addEntries(TextGraph.decode(await fetch('examples/basic-nodes.json').then(r=>r.json())),'Fixture');await go('/library/nodes',true)}")
        await page.wait_for_selector('.card.k-complex')
        assert await page.locator('.card.k-complex a.card-main').count()==0
        assert await page.locator('#new-item,#new-group').count()==0
        assert await page.locator('#subnav .subnav-row[data-key^="r:"] a').count()==0
        assert await page.evaluate("libraryActions().filter(Boolean).every(item=>!['New node','New group'].includes(item[0]))")
        assert await page.evaluate("destinations().then(items=>!items.some(i=>/^\\/library\\/nodes\\/[^?]+/.test(i.href)))")
        await page.locator('.card.k-complex').first.click(button='right')
        await page.wait_for_selector('.popup:not(.closing)')
        assert 'Edit graph' not in await page.locator('.popup:not(.closing)').inner_text()
        await page.evaluate('closePopup(true)')
        assert await page.evaluate("""() => {
          const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.body.dispatchEvent(event);return event.defaultPrevented;
        }""")
        print('PASS Developer mode off removes Library authoring links and controls; browser context menu is suppressed')

        await page.evaluate("""async () => {
          app.preferences=await api('settings',{method:'PUT',body:{developer_mode:true}});
          const project=await api('projects',{method:'POST',body:{name:'Portable project',description:'Round-trip fixture'}});
          window.exchangeProject=project.id;
          const node=await api(`projects/${project.id}/typed-nodes`,{method:'POST',body:{node_type:'custom',config:{title:'Answer',outputs:[{id:'result',name:'result'}]},position:{x:10,y:20}}});
          await go('/projects');
        }""")
        project_id=await page.evaluate('exchangeProject')
        card=page.locator(f'.card:has([data-project-title="{project_id}"])')
        await card.click(button='right')
        await page.wait_for_selector('.popup:not(.closing)')
        right_menu=await page.locator('.popup:not(.closing)').inner_text()
        assert 'Export project' in right_menu
        await page.evaluate('closePopup(true)')
        await card.locator('[data-menu]').click()
        assert right_menu==await page.locator('.popup:not(.closing)').inner_text()
        project_file=await download(page,lambda:page.get_by_role('menuitem',name='Export project',exact=True).click())
        assert await page.evaluate('f=>TextGraph.decode(f).kind',project_file)=='project' and 'Answer' in json.dumps(project_file)
        await page.locator('#view .page-head [data-menu]').click()
        await upload(page,'.popup:not(.closing) [role=menuitem]:has-text("Import project")',project_file,'project.json')
        await page.wait_for_function('app.route.page === "project"')
        await page.wait_for_selector('.card [data-menu^="workflow:"]')
        imported_project=await page.evaluate('app.route.project')
        assert imported_project!=project_id
        assert await page.evaluate('api("projects").then(p=>p.length)')==2
        assert 'Portable project 2' in await page.locator('.page-head h1').inner_text()
        await page.locator('.card [data-menu^="workflow:"]').first.click()
        workflow_file=await download(page,lambda:page.get_by_role('menuitem',name='Export workflow',exact=True).click())
        assert await page.evaluate('f=>TextGraph.decode(f).kind',workflow_file)=='workflow'
        await page.locator('#view .page-head [data-menu]').click()
        await upload(page,'.popup:not(.closing) [role=menuitem]:has-text("Import workflow")',workflow_file,'workflow.json')
        await page.wait_for_selector('#canvas')
        assert await page.evaluate("W.snapshot.nodes.some(n=>n.config?.title==='Answer')")
        await page.locator('.toolbar [data-menu]').click(button='right')
        await page.wait_for_selector('.popup:not(.closing)')
        assert 'Export workflow' in await page.locator('.popup:not(.closing)').inner_text()
        await page.evaluate('closePopup(true)')
        await page.evaluate("""() => {
          applyStyle({...THEMES.Dark,animations:false});Inspector.toggle(true);placeRailPill(true);
          document.body.style.setProperty('--noise','none');document.body.style.setProperty('--glow','none');
          document.body.style.setProperty('--dither','none');
        }""")
        await page.wait_for_timeout(100)
        paint_ok = await page.evaluate("""async png => {
          const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
          const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
          const pill=document.querySelector('.side-tabs .nav-pill').getBoundingClientRect(),x=Math.round(pill.left);
          // Skip the antialiased tip; the rest of the upper join must have continuous paint.
          for(let y=Math.ceil(pill.top-10);y<Math.floor(pill.top);y++){
            const a=ctx.getImageData(x-1,y,1,1).data,b=ctx.getImageData(x,y,1,1).data;
            if([0,1,2].some(i=>Math.abs(a[i]-b[i])>2)){window.curvePaintFailure={y,a:[...a],b:[...b],left:pill.left,top:pill.top};return false;}
          }return true;
        }""",base64.b64encode(await page.screenshot()).decode())
        if not paint_ok:
            await page.screenshot(path=os.path.join(os.environ['TEMP'],'agentsys-curve-debug.png'))
        assert paint_ok, await page.evaluate('curvePaintFailure')
        print('PASS upper inspector curve paints continuously across its shared edge')
        print('PASS right-click reuses action menus; project and workflow JSON round trips retain executable graph data')

        await page.evaluate("go('/settings?section=appearance')")
        await page.wait_for_selector('#save-theme')
        await page.locator('[name=theme]').select_option('Dark')
        assert await page.locator('[name=background]').input_value()=='#080808'
        assert await page.locator('[name=surface]').input_value()=='#101010'
        assert await page.locator('[name=text]').input_value()=='#ededed'
        assert await page.locator('[name=accent]').input_value()=='#d9d9d9'
        radius=await page.locator('[name=font_size]').evaluate('(el)=>getComputedStyle(el).borderRadius')
        await page.locator('[name=font_size]').focus()
        assert await page.locator('[name=font_size]').evaluate('(el)=>getComputedStyle(el).borderRadius')==radius
        await page.locator('[name=accent]').fill('#82aaff')
        await page.locator('[name=font_size]').fill('16')
        await page.locator('#save-theme').click()
        await page.locator('#modal input[name=name]').fill('Night studio')
        await page.locator('#modal-actions button[value=ok]').click()
        await page.wait_for_selector('#modal',state='hidden')
        await page.wait_for_function("app.preferences.themes?.length===1")
        saved=await page.locator('[name=theme]').input_value()
        theme_file=await download(page,lambda:page.locator('#export-theme').click())
        assert theme_file['kind']=='theme' and theme_file['name']=='Night studio'
        assert theme_file['style']['font_size']==16 and theme_file['style']['accent']=='#82aaff'
        await page.reload()
        await page.wait_for_selector('#save-theme')
        assert await page.locator('[name=theme]').input_value()==saved
        assert await page.locator('[name=font_size]').input_value()=='16'
        await upload(page,'#import-themes',theme_file,'theme.json')
        await page.wait_for_function("app.preferences.themes?.length===2")
        assert await page.locator('[name=theme] option:checked').inner_text()=='Night studio (2)'
        await page.locator('#theme-actions-more').click(button='right')
        all_themes=await download(page,lambda:page.get_by_role('menuitem',name='Export saved themes',exact=True).click())
        assert all_themes['kind']=='themes' and len(all_themes['themes'])==2
        await upload(page,'#import-themes',all_themes,'themes.json')
        await page.wait_for_function("app.preferences.themes?.length===4")
        invalid={'agentsys':1,'kind':'themes','themes':[theme_file,{'name':'Broken','style':{'background':'red'}}]}
        await upload(page,'#import-themes',invalid,'invalid.json')
        await page.wait_for_selector('.toast.error')
        assert await page.evaluate("api('settings').then(s=>s.preferences.themes.length)")==4
        print('PASS Dark palette, stable focus radius, named theme persistence, single/collection exchange and atomic invalid import')
        assert not errors,errors
        await browser.close()


asyncio.run(main())
