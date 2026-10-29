"""Native Library and uniform navigation, with real storage and browser interaction."""
import asyncio
import os
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_server import isolated_server


async def audit(base, directory):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width':1500,'height':1000})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(base+'/editor/')
        await page.wait_for_selector('.dashboard')
        assert not errors, errors
        for path, section in [('/','home'),('/projects','projects'),('/plugins','plugins'),('/resources','library'),('/settings','settings'),('/runs','runs'),('/api','api')]:
            await page.evaluate('path=>go(path)',path)
            assert await page.locator('#sidebar a.active').get_attribute('data-section') == section
            assert await page.locator('#subnav .subnav-tree').count() == 1
            assert await page.locator('#subnav-actions [data-menu]').count() == 1
            assert await page.locator('.page-head > .actions > button').count() == 1
            assert await page.locator('#subnav [role=tab]').count() == 0
        print('PASS seven primary sections use one navigation and header format',flush=True)
        await page.evaluate("go('/settings?section=appearance')")
        settings_rows = await page.locator('#subnav-list a').evaluate_all('els=>els.map(e=>[e.textContent,linkPath(e)])')
        await page.locator('#subnav-list a').filter(has_text='Keyboard shortcuts').click()
        assert 'section=keyboard-shortcuts' in page.url
        assert await page.locator('#subnav-list a').evaluate_all('els=>els.map(e=>[e.textContent,linkPath(e)])') == settings_rows
        await page.go_back()
        await page.wait_for_selector('.appearance-section:not([hidden])')
        await page.evaluate("go('/projects')")
        await page.evaluate("go('/settings')")
        assert 'section=' not in page.url
        assert await page.locator('#settings-form > section:not([hidden]) h2').inner_text() == 'Editing'
        print('PASS URL selection, Back and direct section links without hidden redirects',flush=True)
        await page.evaluate("go('/resources')")
        assert await page.locator('.card').count() == 2
        assert await page.locator('.card [data-menu]').count() == 2
        await page.locator('.page-head [data-menu]').click()
        menu = await page.locator('.popup').inner_text()
        assert 'New node' not in menu and 'New group' not in menu
        await page.keyboard.press('Escape')
        await page.evaluate("go('/resources/ai.skills')")
        library_rows=await page.locator('#subnav-list a').all_text_contents()
        await page.locator('.page-head [data-menu]').click()
        await page.get_by_role('menuitem',name='New Skill',exact=True).click()
        await page.locator('#modal [name=item_name]').fill('review-code')
        await page.locator('#modal [name=item_description]').fill('Review a change clearly.')
        await page.locator('#modal [name=value_instructions]').fill('# Review\n\nCheck assumptions and explain findings.')
        await page.locator('#modal-actions button[type=submit]').click()
        await page.wait_for_selector('.card h3:has-text("review-code")')
        await page.locator('.card-main').filter(has_text='review-code').click()
        await page.wait_for_selector('#catalog-item-form')
        await page.locator('#view [name=value_instructions]').fill('Updated instructions before navigating.')
        await page.locator('#subnav-list a').filter(has_text='Providers').click()
        await page.wait_for_selector('.page-head h1:has-text("Providers")')
        skill_file=Path(directory)/'library/skills/ai.skills/review-code/SKILL.md'
        assert skill_file.exists()
        assert 'Updated instructions before navigating.' in skill_file.read_text(encoding='utf-8')
        assert 'name: review-code' in skill_file.read_text(encoding='utf-8')
        assert await page.locator('#subnav-title').text_content() == 'Library', await page.evaluate('({route:app.route,title:document.querySelector("#subnav-title").textContent,section:sectionOf(app.route)})')
        current_rows=await page.locator('#subnav-list a').all_text_contents()
        assert all(name in current_rows for name in library_rows)
        print('PASS native skill creation, Markdown storage and navigation flush',flush=True)
        await page.locator('.page-head [data-menu]').click()
        await page.get_by_role('menuitem',name='New Provider',exact=True).click()
        for name,value in [('item_name','Local Ollama'),('value_providerId','local'),('value_baseURL','http://localhost:11434/v1'),('value_apiKey','super-secret')]:
            await page.locator('#modal [name='+name+']').fill(value)
        await page.locator('#modal-actions button[type=submit]').click()
        await page.wait_for_selector('.card h3:has-text("Local Ollama")')
        await page.locator('.card-main').filter(has_text='Local Ollama').click()
        await page.wait_for_selector('#catalog-item-form')
        assert await page.locator('#view [name=value_apiKey]').input_value() == ''
        assert 'Saved key' in await page.locator('#view [name=value_apiKey]').get_attribute('placeholder')
        result=await page.evaluate("api('library/sections/ai.providers/items')")
        assert 'super-secret' not in str(result)
        await page.evaluate("go('/plugins/ai')")
        await page.wait_for_selector('.plugin-readme')
        assert await page.locator('.plugin-title img').count() == 1
        assert await page.locator('#subnav-title').text_content() == 'Plugins'
        plugin_rows=await page.locator('#subnav-list a').all_text_contents()
        await page.locator('.page-head [data-menu]').click()
        assert 'Export' not in await page.locator('.popup').inner_text()
        await page.keyboard.press('Escape')
        await page.locator('.content-tabs a').filter(has_text='Permissions').click()
        assert await page.locator('#subnav-list a').all_text_contents() == plugin_rows
        await page.get_by_text('This plugin requests no permissions.').wait_for()
        await page.evaluate("go('/plugins/ai')")
        await page.screenshot(path=str(Path(tempfile.gettempdir())/'agentsys-plugin-desktop.png'))
        print('PASS provider credentials, custom icon and readable plugin detail with stable navigation',flush=True)
        # A custom plugin page keeps the standard panel unless it declares an override.
        package={'format':'agentsys.plugin/1','manifest':{'id':'demo','name':'Demo','version':'1.0.0','contributes':{'pages':[{'id':'main','title':'Demo page','entry':'ui/main.html'}]}},'files':{'ui/main.html':'<p id="ready">Ready</p>'}}
        await page.evaluate("pkg=>api('plugins',{method:'POST',body:{package:pkg,enable:true}})",package)
        await page.evaluate("loadPlugins().then(()=>go('/plugins/demo'))")
        rows=await page.locator('#subnav-list a').all_text_contents()
        await page.evaluate("go('/plugins/demo/main')")
        await page.frame_locator('.plugin-frame').locator('#ready').wait_for()
        assert await page.locator('#subnav-list a').all_text_contents() == rows
        package['manifest']['version']='1.1.0'
        package['manifest']['contributes']['pages'][0]['navigation']={'title':'Demo navigation','items':[{'page':'main','title':'Main'}]}
        await page.evaluate("pkg=>api('plugins',{method:'POST',body:{package:pkg,replace:true}}).then(loadPlugins).then(()=>render())",package)
        assert await page.locator('#subnav-title').text_content() == 'Demo navigation'
        await page.evaluate("go('/plugins')")
        assert await page.locator('#subnav-title').text_content() == 'Plugins'
        print('PASS default plugin navigation and explicit overrides',flush=True)
        await page.evaluate("go('/api')")
        await page.locator('.api-call').nth(2).click()
        assert await page.locator('.api-method-heading').inner_text()
        await page.locator('.page-head [data-menu]').click()
        async with page.expect_download() as download:
            await page.get_by_role('menuitem',name='Download OpenAPI',exact=True).click()
        assert (await download.value).suggested_filename == 'agentsys-openapi.json'
        await page.set_viewport_size({'width':390,'height':844})
        for section in ['home','projects','library','plugins','runs','api','settings']:
            link=page.locator('#sidebar [data-section='+section+']')
            box=await link.bounding_box()
            assert box and box['x']>=0 and box['x']+box['width']<=391,(section,box)
            await link.click()
            await page.wait_for_function('(s)=>app.route && sectionOf(app.route)===s',arg=section)
            await page.locator('#mobile-browse').click()
            assert await page.locator('#subnav').get_attribute('aria-modal') == 'true'
            await page.locator('#mobile-subnav-close').click()
        await page.evaluate("go('/resources/ai.skills')")
        await page.screenshot(path=str(Path(tempfile.gettempdir())/'agentsys-library-mobile.png'))
        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await page.reload()
        await page.wait_for_selector('.card h3:has-text("review-code")')
        assert not errors,errors
        print('PASS API download, seven mobile sections, persistent Library resources; no page errors',flush=True)
        await browser.close()


if __name__=='__main__':
    with isolated_server() as (base,directory):
        asyncio.run(audit(base,directory))
