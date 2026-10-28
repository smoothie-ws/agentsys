"""Skill groups, standard file exchange, pinned node actions and light mobile joins."""
import asyncio
import io
import os
from pathlib import Path
import sys
from PIL import Image
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page=await browser.new_page(viewport={'width':1440,'height':900})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        url=f'http://127.0.0.1:{sys.argv[1]}/index.html'
        await page.goto(url+'#/resources')
        await page.wait_for_selector('.cards')
        assert await page.evaluate('Object.keys(KINDS)')==['provider','skill','custom_node']
        assert 'Instructions' not in '\n'.join(await page.locator('#subnav,#view').all_inner_texts())
        await page.evaluate("go('/resources/skill')")
        await page.wait_for_selector('#view .page-head [data-menu]')
        await page.locator('#view .page-head [data-menu]').click()
        await page.get_by_role('menuitem',name='New group',exact=True).click()
        await page.locator('#modal input[name=name]').fill('Writing')
        await page.locator('#modal-actions button[value=ok]').click()
        await page.wait_for_selector('.card[data-drop-folder="Writing"]')
        await page.locator('.card [href$="/resources/skill?folder=Writing"]').click()
        await page.locator('#view .page-head [data-menu]').click()
        await page.get_by_role('menuitem',name='New group',exact=True).click()
        await page.locator('#modal input[name=name]').fill('Reviews')
        await page.locator('#modal-actions button[value=ok]').click()
        await page.wait_for_selector('.card[data-drop-folder="Writing/Reviews"]')
        await page.locator('.card [href$="folder=Writing%2FReviews"]').click()
        await page.locator('#view .page-head [data-menu]').click()
        await page.get_by_role('menuitem',name='Add…',exact=True).click()
        await page.wait_for_selector('#resource-form')
        assert await page.get_by_text('Instruction',exact=True).count()==1
        await page.locator('#resource-form [name=name]').fill('proofread')
        await page.locator('[name=description]').fill('Review text for spelling and clarity. Use for proofreading.')
        await page.locator('[name=instruction]').fill('# Review\n\n- Read the text.\n- Suggest edits.')
        await page.locator('#resource-form button.primary').click()
        await page.wait_for_function("app.route.id && app.route.id!=='new'")
        resource=await page.evaluate('app.route.id')
        assert await page.evaluate('(id)=>app.resources.find(r=>r.id===id).payload.folder',resource)=='Writing/Reviews' # a skill made inside a group belongs to it
        await page.wait_for_selector('#export-resource')
        async with page.expect_download() as pending:
            await page.locator('#export-resource').click()
        download=await pending.value
        assert download.suggested_filename=='SKILL.md'
        markdown=Path(await download.path()).read_text()
        assert markdown.startswith('---\nname: proofread\n') and '# Review' in markdown
        assert await page.evaluate('(md)=>SkillFile.read(md).meta.description',markdown)=='Review text for spelling and clarity. Use for proofreading.'
        await page.reload();await page.wait_for_selector('[name=instruction]')
        assert '- Suggest edits.' in await page.locator('[name=instruction]').input_value()
        assert await page.evaluate('developerMode()') is False
        await page.evaluate("go('/resources/skill')")
        await page.wait_for_selector('#view .page-head [data-menu]')
        rich='---\nname: explain-code\ndescription: >-\n  Explain code clearly.\n  Use when reading unfamiliar code.\nlicense: MIT\nmetadata:\n  author: Someone\n---\n\n# Explain\n\nRead the code.\n'
        async with page.expect_file_chooser() as chooser:
            await page.locator('#view .page-head [data-menu]').click()
            await page.get_by_role('menuitem',name='Import…',exact=True).click()
        await (await chooser.value).set_files({'name':'SKILL.md','mimeType':'text/markdown','buffer':rich.encode()})
        await page.wait_for_selector('#resource-form [name=description]')
        assert await page.locator('[name=description]').input_value()=='Explain code clearly. Use when reading unfamiliar code.'
        await page.locator('[name=description]').fill('Updated description.')
        await page.locator('#resource-form button.primary').click()
        await page.wait_for_function("SkillFile.read(app.resources.find(r=>r.id===app.route.id).payload.markdown).meta.description==='Updated description.'")
        assert await page.evaluate('SkillFile.read(app.resources.find(r=>r.id===app.route.id).payload.markdown).meta.license')=='MIT'
        await page.evaluate("go('/resources/skill?folder=Writing%2FReviews')")
        await page.wait_for_selector(f'.card[data-drag="{resource}"]')
        await page.locator(f'.card[data-drag="{resource}"]').click(button='right')
        await page.get_by_role('menuitem',name='Move to',exact=True).hover()
        await page.get_by_role('menuitem',name='No group',exact=True).click()
        await page.wait_for_function('(id)=>app.resources.find(r=>r.id===id).payload.folder===""',arg=resource)
        await page.evaluate("go('/resources/skill')")
        await page.wait_for_selector(f'.card[data-drag="{resource}"]')
        await page.locator(f'.card[data-drag="{resource}"]').drag_to(page.locator('.card[data-drop-folder="Writing"]'))
        await page.wait_for_function('(id)=>app.resources.find(r=>r.id===id).payload.folder==="Writing"',arg=resource)
        await page.locator('.card[data-drop-folder="Writing"]').click(button='right')
        await page.get_by_role('menuitem',name='Rename',exact=True).click()
        await page.locator('.inline-rename').fill('Communication')
        await page.keyboard.press('Enter')
        await page.wait_for_function("app.skillFolders.includes('Communication/Reviews')")
        assert await page.evaluate('(id)=>app.resources.find(r=>r.id===id).payload.folder',resource)=='Communication'
        await page.locator('.card[data-drop-folder="Communication"]').click(button='right')
        await page.get_by_role('menuitem',name='Delete group',exact=True).click()
        await page.locator('#modal-actions button[value=ok]').click()
        await page.wait_for_function('(id)=>!app.resources.some(r=>r.id===id)',arg=resource)
        assert await page.evaluate('app.skillFolders')==[]
        assert not errors,errors
        print('PASS skill descriptions, Instruction, native Markdown exchange, optional metadata, nested groups, menu moves, drag, rename and deletion without Developer mode')
        await page.close()

        # The full-width Browse button must also match the primary icon, including in a light theme.
        phone=await browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        await phone.goto(url);await phone.wait_for_selector('.page')
        for theme in ['Light','Graphite','Midnight']:
            await phone.evaluate('''async theme=>{
              await go('/');applyStyle({...STYLE_DEFAULTS,...THEMES[theme],animations:false});
              document.body.style.setProperty('--noise','none');document.body.style.setProperty('--glow','none');placePills(true,true);
            }''',theme)
            await phone.wait_for_timeout(150)
            image=Image.open(io.BytesIO(await phone.screenshot())).convert('RGB')
            pill=await phone.locator('#sidebar > .nav-pill').bounding_box()
            y=round(pill['y'])
            for x in [int(pill['x']-3),round(pill['x']+pill['width']/2),round(pill['x']+pill['width']+3)]:
                a=image.getpixel((x,y-1));b=image.getpixel((x,y))
                assert max(abs(a[i]-b[i]) for i in range(3))<=3,(theme,x,a,b)
            assert await phone.locator('#sidebar,#mobile-secondary').evaluate_all('(els)=>els.every(el=>getComputedStyle(el).backgroundColor==="rgba(0, 0, 0, 0)")')
        print('PASS matching button/section join pixels in Light, Graphite and Midnight; navigation rails have no fill')
        await browser.close()


asyncio.run(main())
