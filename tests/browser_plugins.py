"""AI plugin lifecycle, Providers UI and file-backed UI state."""
import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright
from browser_server import isolated_server

async def check(base, directory):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        page = await browser.new_page(viewport={'width': 1300, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(base + '/editor/plugins')
        await page.wait_for_selector('h3:has-text("AI")')
        assert await page.locator('[data-plugin="hello"]').count() == 0
        other = await browser.new_page()
        await other.goto(base + '/editor/plugins')
        await other.wait_for_selector('h3:has-text("AI")')
        await page.evaluate("store.set('agentsys-audit-first', 'first')")
        await other.evaluate("store.set('agentsys-audit-second', 'second')")
        state = json.loads((Path(directory) / 'other' / 'ui-state.json').read_text())
        assert state['agentsys-audit-first'] == 'first'
        assert state['agentsys-audit-second'] == 'second'
        await other.close()
        writes = []
        page.on('request', lambda request: writes.append(request.url) if request.method == 'PUT' and request.url.endswith('/api/ui-state') else None)
        await page.evaluate("Promise.all(Array.from({length:20},(_,i)=>store.set('agentsys-audit-batch',i)))")
        assert len(writes) == 1, writes
        await page.evaluate("Promise.all(Array.from({length:20},()=>store.set('agentsys-audit-batch',19)))")
        assert len(writes) == 1, writes
        await page.evaluate("go('/library')")
        await page.locator('a.card-main[href$="/library/providers"]').click()
        await page.wait_for_selector('h1:has-text("Providers")')
        assert await page.locator('#subnav a[aria-current=page]').all_text_contents() == ['Providers']
        # A type dialog must release its change handler when the shared modal is reused.
        await page.evaluate('''async () => {
          const project = await api('projects', {method:'POST', body:{name:'Dialog lifecycle'}});
          await go(`/p/${project.id}/w/${project.id}`);
          typeDialog(null, () => {});
          document.querySelector('#modal').close();
          await go('/library/providers');
        }''')
        await page.locator('.page-head [data-menu]').click()
        await page.get_by_role('menuitem', name='New provider', exact=True).click()
        await page.locator('#modal input[name=providerId]').fill('local')
        await page.locator('#modal input[name=baseURL]').fill('http://localhost:11434/v1')
        await page.locator('#modal input[name=model]').fill('test-model')
        await page.locator('#modal input[name=apiKey]').fill('test-key')
        await page.locator('#modal').get_by_role('button', name='Save', exact=True).click()
        await page.wait_for_selector('h3:has-text("local")')
        saved = json.loads((Path(directory) / 'plugins' / 'ai' / 'data.json').read_text())
        assert saved['providers'][0]['model'] == 'test-model'
        aligned = await page.evaluate('''() => {
          const card=document.querySelector('.card'), label=card.querySelector('.card-head').getBoundingClientRect(), menu=card.querySelector('[data-menu]').getBoundingClientRect();
          const heading=document.querySelector('.page-head h1').getBoundingClientRect(), action=document.querySelector('.page-head .actions').getBoundingClientRect();
          return Math.abs(label.y+label.height/2-menu.y-menu.height/2)<=1 && Math.abs(heading.y+heading.height/2-action.y-action.height/2)<=1;
        }''')
        assert aligned
        await page.locator('.card [data-menu]').click()
        await page.get_by_role('menuitem', name='Edit', exact=True).click()
        assert await page.locator('#modal input[name=apiKey]').input_value() == ''
        await page.locator('#modal input[name=name]').fill('Local AI')
        await page.locator('#modal').get_by_role('button', name='Save', exact=True).click()
        await page.wait_for_selector('h3:has-text("Local AI")')
        await page.evaluate("store.set('agentsys-snap', true)")
        await page.evaluate("localStorage.setItem('agentsys-hints', 'false');localStorage.setItem('fieldHeights:test', JSON.stringify({port: 100}))")
        await page.reload()
        await page.wait_for_selector('h1:has-text("Providers")')
        assert await page.evaluate("store.get('agentsys-snap')") is True
        assert await page.evaluate("store.get('agentsys-hints')") is False
        assert await page.evaluate("localStorage.getItem('agentsys-hints')") is None
        assert await page.evaluate("localStorage.getItem('agentsys-snap')") is None
        assert (Path(directory) / 'other' / 'ui-state.json').exists()
        assert await page.evaluate("localStorage.getItem('fieldHeights:test')") is None
        await page.evaluate("const value=store.get('fieldHeights:test');value.port=200;store.set('fieldHeights:test',value)")
        heights = json.loads((Path(directory) / 'other' / 'ui-state.json').read_text())
        assert heights['fieldHeights:test']['port'] == 200
        await page.evaluate("api('plugins/ai',{method:'PUT',body:{enabled:false}}).then(()=>go('/library'))")
        await page.wait_for_selector('h1:has-text("Library")')
        assert await page.locator('#subnav a:has-text("Providers")').count() == 0
        await page.evaluate("api('plugins/ai',{method:'PUT',body:{enabled:true}}).then(()=>go('/library/providers'))")
        await page.wait_for_selector('h3:has-text("Local AI")')
        await page.locator('.card [data-menu]').click()
        await page.get_by_role('menuitem', name='Delete', exact=True).click()
        await page.locator('#modal').get_by_role('button', name='Delete', exact=True).click()
        await page.wait_for_selector('h2:has-text("No providers yet")')
        assert not errors, errors
        await browser.close()
        print('PASS AI Providers CRUD, lifecycle and file-backed UI state', flush=True)

if __name__ == '__main__':
    with isolated_server() as (base, directory):
        asyncio.run(check(base, directory))
