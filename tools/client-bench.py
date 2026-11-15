"""Browser measurements against any checkout, with disposable data and no user browser profile.

python tools/client-bench.py --root PATH --samples 5 --nodes 200 --output measurements.json
Requires the same Playwright/Chromium setup as tests/browser_suite.py. No application dependencies added.
"""
import argparse
import asyncio
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time
from playwright.async_api import async_playwright


@contextmanager
def server(root):
    with tempfile.TemporaryDirectory(prefix='agentsys-client-bench-') as data:
        source = "const a=require('./server').createServer({dataDir:process.env.BENCH_DATA});a.listen(0).then(url=>console.log(JSON.stringify({url})));"
        process = subprocess.Popen(['node', '-e', source], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, 'BENCH_DATA': data}, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError(process.stderr.read())
            yield json.loads(line)['url']
        finally:
            process.terminate()
            process.wait(timeout=10)


def summary(values):
    return {'median': round(statistics.median(values), 2), 'max': round(max(values), 2),
        'samples': [round(value, 2) for value in values]}


async def measure(args, first, second):
    report = {'nodes': args.nodes, 'samples': args.samples, 'viewport': [1440, 1000]}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        report['chromium'] = browser.version
        startup = []
        for _ in range(args.samples):
            context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
            page = await context.new_page()
            start = time.perf_counter()
            await page.goto(first + '/editor/')
            await page.wait_for_selector('.dashboard')
            await page.wait_for_function('Environment.status().status === "connected"')
            startup.append((time.perf_counter() - start) * 1000)
            await context.close()
        report['cold_dashboard_ms'] = summary(startup)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(first + '/editor/')
        await page.wait_for_selector('.dashboard')
        await page.evaluate("""async count => {
          const project=await api('projects',{method:'POST',body:{name:'Client benchmark'}});
          await api('settings',{method:'PUT',body:{developer_mode:true}});
          const result=await api(`projects/${project.id}/batch`,{method:'POST',body:{operations:Array.from({length:count},(_,i)=>({
            path:'typed-nodes',method:'POST',body:{node_type:'custom',config:{title:'Node '+i,inputs:[],outputs:[{id:'out',name:'out'}]},position:{x:i%20*260,y:Math.floor(i/20)*150}}
          }))}});
          window.benchProject=project.id;window.benchIds=result.results.map(node=>node.id);
          window.benchFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        }""", args.nodes)
        loads, edits, saves, plugins, switches = [], [], [], [], []
        for _ in range(args.samples):
            loads.append(await page.evaluate("""async () => {
              await go('/projects'); const start=performance.now();
              await go(`/p/${benchProject}/w/${benchProject}`);await benchFrame();return performance.now()-start;
            }"""))
            edits.append(await page.evaluate("""async () => {
              const start=performance.now();select(benchIds);
              window.benchColor=window.benchColor==='#3b6ea8'?'#3f8f6b':'#3b6ea8';
              await setSelectionStyle({color:benchColor});await benchFrame();return performance.now()-start;
            }"""))
            saves.append(await page.evaluate("""async () => {
              const start=performance.now();for(const id of benchIds) W.pos.get(id).x++;
              await savePositions(benchIds);await benchFrame();return performance.now()-start;
            }"""))
            plugins.append(await page.evaluate("""async () => {
              const start=performance.now();
              await Extensions.install({id:'bench',title:'Bench',version:'1.0.0',source:'exports.activate = api => api.ui.addPage({id:"bench",render:()=>"<p>bench</p>"});'});
              await Extensions.disable('bench');await Extensions.enable('bench');await Extensions.uninstall('bench');
              return performance.now()-start;
            }"""))
        await page.evaluate("""url => {window.benchLocal=Environment.active().id;window.benchOther=Environment.save({name:'Other',url}).id;}""", second)
        for _ in range(args.samples):
            switches.append(await page.evaluate("""async () => {
              const start=performance.now();await Environment.setActive(benchOther);await Environment.setActive(benchLocal);
              await benchFrame();return performance.now()-start;
            }"""))
        for name, values in [('graph_load_ms', loads), ('selection_color_ms', edits), ('graph_layout_save_ms', saves),
                ('plugin_install_disable_enable_remove_ms', plugins), ('environment_roundtrip_ms', switches)]:
            report[name] = summary(values)
        report['page_errors'] = errors
        await browser.close()
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--nodes', type=int, default=200)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not 1 <= args.nodes <= 200 or args.samples < 1:
        parser.error('nodes must be 1..200 and samples must be positive')
    with ExitStack() as stack:
        first, second = [stack.enter_context(server(args.root)) for _ in range(2)]
        result = json.dumps(asyncio.run(measure(args, first, second)), indent=2) + '\n'
        if args.output:
            with args.output.open('w', encoding='utf-8', newline='\n') as output:
                output.write(result)
        else:
            print(result, end='')
