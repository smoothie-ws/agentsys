"""Detailed theme controls and real touch layouts at phone, tablet and desktop sizes."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
from playwright.async_api import async_playwright

URL=f'http://127.0.0.1:{sys.argv[1]}/index.html'


async def set_part(page,group,key,value):
    await page.locator(f'[data-theme-group="{group}"]').evaluate('(el)=>el.open=true')
    await page.locator(f'[data-theme-value][data-part="{group}"][data-key="{key}"]').fill(value)


async def desktop_theme(browser):
    page=await browser.new_page(viewport={'width':1920,'height':1080})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(URL+'#/settings?section=appearance')
    await page.wait_for_selector('.theme-component-editor')
    wide=(await page.locator('#settings-form').bounding_box())['width']
    await page.goto(URL+'#/settings?section=general')
    await page.wait_for_selector('#settings-form')
    assert wide==(await page.locator('#settings-form').bounding_box())['width']
    await page.goto(URL+'#/settings?section=appearance')
    await page.wait_for_selector('.theme-component-editor')
    assert await page.locator('[data-theme-value]').count()>50
    assert await page.locator('.theme-component-editor').get_by_role('button',name='Reset',exact=True).count()==1
    assert await page.locator('[data-theme-auto],[data-theme-reset-group]').count()==0
    assert await page.locator('.theme-component').first.evaluate('(el)=>getComputedStyle(el).boxShadow')=='none'
    assert await page.locator('.theme-component').first.evaluate('(el)=>getComputedStyle(el).backgroundColor')=='rgba(0, 0, 0, 0)'
    await set_part(page,'buttons','background','#203040')
    await set_part(page,'buttons','hover','#405060')
    await set_part(page,'buttons','pressed','#607080')
    await page.wait_for_timeout(250)
    preview=page.locator('.theme-live-preview > button').first
    await page.wait_for_function("getComputedStyle(document.querySelector('.theme-live-preview > button')).backgroundColor==='rgb(32, 48, 64)'")
    await preview.hover()
    await page.wait_for_function("getComputedStyle(document.querySelector('.theme-live-preview > button')).backgroundColor==='rgb(64, 80, 96)'")
    await page.mouse.down()
    await page.wait_for_function("getComputedStyle(document.querySelector('.theme-live-preview > button')).backgroundColor==='rgb(96, 112, 128)'")
    await page.mouse.up()
    await set_part(page,'fields','background','#142536cc')
    await set_part(page,'fields','radius','0')
    await set_part(page,'panels','sidebar','#1b1535')
    await set_part(page,'status','success','#76ffcc')
    await set_part(page,'nodes','text','#ff99cc')
    await page.locator('[name=node_radius]').fill('0')
    await page.locator('[name=group_radius]').fill('0')
    await page.wait_for_function("getComputedStyle(document.querySelector('.theme-live-preview > input')).borderRadius==='0px'")
    assert await page.locator('.theme-live-preview > input').evaluate('(el)=>getComputedStyle(el).borderRadius')=='0px'
    assert await page.evaluate("getComputedStyle(document.querySelector('#sidebar')).backgroundColor")=='rgba(0, 0, 0, 0)'
    await page.wait_for_function("app.preferences.style?.components?.fields?.background==='#142536cc'")
    assert await page.evaluate('app.preferences.style.node_radius')==0
    assert await page.evaluate('app.preferences.style.group_radius')==0
    await page.locator('#save-theme').click()
    await page.locator('#modal input[name=name]').fill('Component studio')
    await page.locator('#modal-actions button[value=ok]').click()
    await page.wait_for_selector('#modal',state='hidden')
    selected=await page.locator('[name=theme]').input_value()
    async with page.expect_download() as pending:
        await page.locator('#export-theme').click()
    saved=json.loads(Path(await (await pending.value).path()).read_text())
    assert saved['style']['components']['fields']=={'background':'#142536cc','radius':0}
    await page.reload();await page.wait_for_selector('.theme-component-editor')
    assert await page.locator('[name=theme]').input_value()==selected
    assert await page.evaluate("document.documentElement.style.getPropertyValue('--theme-fields-background')")=='#142536cc'
    await page.locator('[name=theme]').select_option('Dark')
    await page.wait_for_function("document.documentElement.style.getPropertyValue('--theme-fields-background')===''")
    async with page.expect_file_chooser() as pending:
        await page.locator('#import-themes').click()
    await (await pending.value).set_files({'name':'component-theme.json','mimeType':'application/json','buffer':json.dumps(saved).encode()})
    await page.wait_for_function("app.preferences.themes?.length===2")
    assert await page.evaluate("document.documentElement.style.getPropertyValue('--theme-fields-background')")=='#142536cc'
    await page.locator('#theme-filter').fill('wire')
    assert await page.locator('[data-theme-group]:visible').count()==1
    assert await page.locator('[data-theme-group="canvas"]').is_visible()
    await page.locator('#theme-filter').fill('')
    await page.locator('#theme-reset-parts').click()
    await page.wait_for_function("Object.keys(app.preferences.style?.components||{}).length===0")
    assert await page.evaluate("document.documentElement.style.getPropertyValue('--c-text')")==''
    await page.evaluate('''async()=>{
      app.preferences=await api('settings',{method:'PUT',body:{developer_mode:true}});
      const project=await api('projects',{method:'POST',body:{name:'Inspector actions'}});
      window.polishProject=project.id;
      await go(`/p/${project.id}/w/${project.id}`);
      await addEntries(TextGraph.decode(await fetch('examples/basic-nodes.json').then(r=>r.json())),'Fixture');await loadLibrary();
      const resource=app.resources.find(r=>r.name==='Text');
      const placed=await api(`projects/${W.project}/custom-nodes/${resource.id}`,{method:'POST',body:wf({point:{x:100,y:100}})});
      window.polishSelection=pastedSelection(placed);
      await reload();select(polishSelection);Inspector.toggle(true);await Inspector.show();
    }''')
    await page.wait_for_selector('[data-node-actions] [data-act=edit]')
    assert await page.locator('#node-connections').evaluate('(el)=>!!(el.compareDocumentPosition(document.querySelector("[data-node-actions]")) & Node.DOCUMENT_POSITION_FOLLOWING)')
    assert await page.locator('#side-actions').evaluate('(el)=>{const a=el.getBoundingClientRect(),p=el.closest(".side-content").getBoundingClientRect();return Math.abs(a.bottom-p.bottom)<1}')
    for tab in ['activity','properties']:
        await page.locator(f'[data-side-tab={tab}]').click()
        await page.wait_for_timeout(400)
        assert await page.locator('.side-content').evaluate('(el)=>{const s=getComputedStyle(el);return parseFloat(s.borderTopRightRadius)>0 && parseFloat(s.borderBottomRightRadius)>0}')
        assert await page.locator('#side').evaluate('(el)=>getComputedStyle(el).borderRadius')=='0px'
        assert await page.locator('.side-tabs').evaluate('(el)=>getComputedStyle(el).backgroundColor')=='rgba(0, 0, 0, 0)'
        assert await page.locator('.side-tabs .nav-pill').is_visible()
        assert await page.locator('.side-tabs .nav-pill').evaluate('(el)=>el.getBoundingClientRect().top-el.closest(".side").getBoundingClientRect().top>=2*parseFloat(getComputedStyle(el.closest(".side")).getPropertyValue("--join-r"))')
    await page.locator('[data-node-actions] [data-act=edit]').click()
    await page.wait_for_function('!!W.library')
    await page.evaluate('''async()=>{await go(`/p/${polishProject}/w/${polishProject}`);select(polishSelection);Inspector.toggle(true);await Inspector.show();}''')
    await page.locator('[data-node-actions] [data-act=delete]').click()
    await page.wait_for_function('W.snapshot.complex.length===0')
    assert not errors,errors
    await page.close()
    print('PASS flat component settings with one Reset, theme persistence, rounded inspector joins and actions after ports')


async def phone(browser,width,height):
    context=await browser.new_context(viewport={'width':width,'height':height},is_mobile=True,has_touch=True)
    page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.add_init_script("localStorage.setItem('agentsys-subnav-collapsed','true')")
    await page.goto(URL+'#/settings?section=appearance')
    await page.wait_for_selector('.theme-component-editor')
    assert (await page.locator('#sidebar').bounding_box())['width']==width
    assert await page.locator('#sidebar [data-section]:visible').count()==5
    assert await page.locator('#sidebar [data-section] > span:not(.brand-mark):visible').count()==0
    await page.wait_for_timeout(400)
    assert await page.locator('#sidebar').evaluate('(el)=>{const rows=[...el.querySelectorAll("[data-section]")],r=parseFloat(getComputedStyle(el).getPropertyValue("--join-r"));return rows[0].getBoundingClientRect().left>=r && rows.at(-1).getBoundingClientRect().right<=innerWidth-r}')
    for selector in ['#sidebar > .nav-pill','#mobile-secondary > .nav-pill','main > .nav-seam']:
        assert await page.locator(selector).is_visible()
        assert '0deg' in await page.locator(selector).evaluate('(el)=>getComputedStyle(el).backgroundImage')
    if width==390:
        clean=await page.add_style_tag(content='#view,#topstrip{visibility:hidden}body{--noise:none;--glow:none;--dither:none}')
        png=base64.b64encode(await page.screenshot()).decode()
        assert await page.evaluate('''async png=>{
          const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
          const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
          for(const selector of ['#sidebar > .nav-pill','#mobile-secondary > .nav-pill']){
            const r=document.querySelector(selector).getBoundingClientRect(),y=Math.round(r.top);
            for(const x of [Math.round(r.left-3),Math.round((r.left+r.right)/2),Math.round(r.right+3)]){
              const a=ctx.getImageData(x,y-1,1,1).data,b=ctx.getImageData(x,y,1,1).data;
              if([0,1,2].some(i=>Math.abs(a[i]-b[i])>3))return false;
            }
          }return true;
        }''',png)
        await clean.evaluate('(el)=>el.remove()')
    assert await page.evaluate('document.documentElement.scrollWidth===innerWidth')
    await page.locator('#mobile-browse').tap()
    await page.locator('#subnav-list a').filter(has_text='Editing').tap()
    await page.wait_for_selector('#section-panel-0:not([hidden])')
    assert await page.locator('#section-panel-0').is_visible()
    await page.locator('#mobile-browse').tap()
    await page.locator('#subnav-list a').filter(has_text='Appearance').tap()
    await page.wait_for_selector('.appearance-section:not([hidden])')
    assert await page.locator('.appearance-section').is_visible()
    await page.locator('#theme-filter').fill('fields')
    await set_part(page,'fields','radius','12')
    await page.wait_for_function('app.preferences.style?.components?.fields?.radius===12')
    assert await page.evaluate('document.documentElement.scrollWidth===innerWidth')
    await page.locator('#sidebar [data-section=home]').tap()
    await page.wait_for_selector('.tile')
    await page.locator('#mobile-browse').tap()
    await page.locator('#subnav [data-key="dashboard:api"] a').tap()
    await page.wait_for_selector('.api-method-heading')
    await page.locator('#mobile-browse').tap()
    await page.locator('#api-nav-search').fill('project-defaults')
    await page.locator('#subnav [data-key^="api-call:"] a:visible').first.tap()
    assert '/api/project-defaults' in await page.locator('.api-method-heading').inner_text()
    assert await page.evaluate('document.documentElement.scrollWidth===innerWidth')
    await page.locator('#sidebar [data-section=projects]').tap()
    await page.locator('.page-head [data-menu]').tap()
    await page.get_by_role('menuitem',name='New project',exact=True).tap()
    await page.locator('#modal input[name=name]').fill('Phone graph')
    await page.locator('#modal-actions button[value=ok]').tap()
    await page.wait_for_selector('.page-head h1')
    await page.locator('.card-main').first.tap()
    await page.wait_for_selector('#canvas')
    canvas=await page.locator('#canvas').bounding_box()
    assert canvas['width']==width-56 and canvas['height']>250
    assert await page.locator('#side').get_attribute('data-collapsed')=='true'
    await page.locator('.toolbar [data-empty-add]').tap()
    await page.wait_for_selector('.popup:not(.closing)')
    branch=page.locator('.popup:not(.closing) > .menu-items .menu-row > button[aria-haspopup=menu]').first
    if await branch.count():
        await branch.tap()
        await page.wait_for_selector('.submenu-back')
        await page.locator('.submenu-back').tap()
        assert await page.locator('.submenu').count()==0
    await page.evaluate('closePopup(true)')
    await page.locator('[data-side-tab=properties]').tap()
    expanded=await page.locator('#side').bounding_box()
    rail=await page.locator('.side-tabs').bounding_box()
    assert rail['width']==56 and abs(rail['x']+rail['width']-width)<1
    assert expanded['width']==min(380,width-70) and expanded['height']>500
    assert expanded['y']>=50 and expanded['y']+expanded['height']<=height-106+1
    assert await page.locator('.side-tabs').evaluate('(el)=>getComputedStyle(el).flexDirection')=='column'
    assert await page.locator('.side-tabs .nav-pill').is_visible()
    assert '270deg' in await page.locator('.side-content > .nav-seam').evaluate('(el)=>getComputedStyle(el).backgroundImage')
    await page.locator('[data-side-close]').tap()
    assert await page.locator('#side').get_attribute('data-collapsed')=='true'
    if width==390:
        await page.evaluate('setCamera(0,0,1)')
        client=await context.new_cdp_session(page)
        y=canvas['y']+canvas['height']*0.65
        x1=width*0.2;x2=width*0.65
        await client.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x1,'y':y,'id':0}]})
        await client.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x1,'y':y,'id':0},{'x':x2,'y':y,'id':1}]})
        await client.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x1-25,'y':y,'id':0},{'x':x2+25,'y':y,'id':1}]})
        await client.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        assert await page.evaluate('W.camera.zoom')>1.2
        await client.detach()
        await page.set_viewport_size({'width':1100,'height':800})
        await page.wait_for_timeout(200)
        assert not await page.locator('#mobile-secondary').is_visible()
        assert await page.evaluate("document.body.classList.contains('subnav-collapsed')")
        await page.set_viewport_size({'width':390,'height':844})
        await page.wait_for_timeout(200)
        assert await page.locator('#mobile-secondary').is_visible()
        assert not await page.evaluate("document.body.classList.contains('subnav-collapsed')")
    assert await page.evaluate('document.documentElement.scrollWidth===innerWidth')
    assert not errors,errors
    await context.close()
    print(f'PASS {width}px phone navigation, Settings, API tree, dialogs, graph add menu and inspector'+(' with real pinch zoom and desktop restoration' if width==390 else ''))


async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        await desktop_theme(browser)
        for width,height in [(320,710),(390,844),(430,932)]:await phone(browser,width,height)
        page=await browser.new_page(viewport={'width':820,'height':1000})
        await page.goto(URL+'#/settings?section=appearance');await page.wait_for_selector('.theme-component-editor')
        assert await page.evaluate('document.documentElement.scrollWidth===innerWidth')
        await page.close();await browser.close()
        print('PASS tablet layout without horizontal page overflow')


asyncio.run(main())
