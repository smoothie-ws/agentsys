"""Appearance regressions. Run against a static server with its port as argument."""
import asyncio
import os
import sys
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(f'http://127.0.0.1:{sys.argv[1]}/index.html')
        await page.wait_for_selector('.page')
        await page.evaluate("""async () => {
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const project = await api('projects',{method:'POST',body:{name:'Appearance'}});
          await go(`/p/${project.id}/w/${project.id}`);
          const node = await api(`projects/${W.project}/typed-nodes`,{method:'POST',body:{
            node_type:'custom',config:{title:'Script',inputs:[],outputs:[]},position:{x:60,y:100}
          }});
          window.appearanceNode = node.id;
          await reload();
          applyStyle({...THEMES.Dark,animations:false});
          select([node.id]);
        }""")
        # Default fills come from the rendered node, never an unrelated blue fallback.
        await page.evaluate('openColorPicker({left:600,bottom:180})')
        assert await page.locator('.hex').input_value() == await page.evaluate('selectionColor()')
        assert await page.locator('.hex').input_value() != '#3b6ea8'
        await page.evaluate('closePopup(true)')
        for color in ('#ff3300', '#3b6ea8', '#8060c080'):
            await page.evaluate('(color) => setSelectionStyle({color})', color)
            await page.evaluate('openColorPicker({left:600,bottom:180})')
            assert await page.locator('.hex').input_value() == color
            await page.evaluate('closePopup(true)')
        print('PASS picker opens with default, explicit and translucent node colours')
        await page.evaluate("""async () => {
          const group = await api(`projects/${W.project}/groups`,{method:'PUT',body:{groups:[{id:'colour',name:'Colour',members:[appearanceNode]}]}});
          await reload(); select(['frame:colour']);
        }""")
        for color in ('#ff3300', '#ff330080'):
            await page.evaluate('(color) => setSelectionStyle({color})', color)
            assert await page.evaluate("""color => {
              const frame=document.querySelector('.frame.colored');
              const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');
              const pixel=fill=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=fill;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].join()};
              return pixel(getComputedStyle(frame).backgroundColor)===pixel(color);
            }""", color)
            await page.evaluate('openColorPicker({left:600,bottom:180})')
            assert await page.locator('.hex').input_value() == color
            await page.evaluate('closePopup(true)')
        print('PASS group fill and picker preserve chosen RGB and alpha')
        assert await page.evaluate("""() => {
          const probe=document.createElement('span');probe.style.color='var(--accent)';document.body.append(probe);
          const same=getComputedStyle(probe).color===getComputedStyle(document.querySelector('#start')).backgroundColor;probe.remove();return same;
        }""")
        await page.locator('#start').hover()
        assert await page.evaluate("getComputedStyle(document.querySelector('#start')).transform") == 'none'
        assert await page.evaluate("""() => ['#subnav','main','.side-content'].every(s=>{
          const c=getComputedStyle(document.querySelector(s));return ['TopLeft','TopRight','BottomLeft','BottomRight'].every(k=>parseFloat(c['border'+k+'Radius'])>0);
        })""")
        assert await page.evaluate("""() => [...document.querySelectorAll('.nav-seam')].every(el=>{
          const c=getComputedStyle(el);return c.backgroundImage.includes('linear-gradient')&&c.maskImage==='none'&&c.zIndex==='-1';
        })""")
        print('PASS accent Run, stable hover geometry, four rounded corners and background linear glow')
        await page.evaluate('placePills(true, true)')
        assert await page.evaluate("""() => {
          const row=shownRow(document.querySelector('#subnav .subnav-row.active'));
          const pill=document.querySelector('#subnav-body > .nav-pill');
          return Math.abs(row.getBoundingClientRect().left-pill.getBoundingClientRect().left)<1;
        }""")
        print('PASS nested workflow selection respects the row indentation')
        await page.evaluate("go('/settings')")
        await page.wait_for_selector('#settings-form')
        assert await page.locator('[name=node_hooks]').count() == 0
        await page.get_by_role('tab', name='Keyboard shortcuts').click()
        assert await page.evaluate("""() => {
          const section=document.querySelector('#section-panel-2'),s=section.getBoundingClientRect(),r=section.querySelector('.shortcuts').getBoundingClientRect();
          return Math.abs(s.left-r.left)<1&&Math.abs(s.right-r.right)<1;
        }""")
        assert await page.evaluate("""() => {
          const row=document.querySelector('#subnav .subnav-row.active'),pill=document.querySelector('#subnav-body > .nav-pill');
          return Math.abs(row.getBoundingClientRect().left-pill.getBoundingClientRect().left)<1;
        }""")
        print('PASS settings layout and aligned selection edge; retired hook toggle absent')
        assert not errors, errors
        await browser.close()


asyncio.run(main())
