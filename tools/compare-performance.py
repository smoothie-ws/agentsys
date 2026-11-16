"""Descriptive before/after measurements on one host; no performance gate claims."""
from pathlib import Path
import json, os, queue, re, shutil, socket, statistics, subprocess, tarfile, tempfile, threading, time, urllib.request
import psutil
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]; node=shutil.which('node')
work=Path(tempfile.mkdtemp(prefix='agentsys-performance-'))
baseline=work/'baseline'; baseline.mkdir()
archive=work/'baseline.tar'
with archive.open('wb') as output:subprocess.run(['git','archive','5f916bf24bea3a10a0566c68992f1eacb79a999a'],cwd=root,stdout=output,check=True)
with tarfile.open(archive) as bundle:bundle.extractall(baseline,filter='data')
products={}
for product,version in [('server','0.4.1'),('client','0.7.0')]:
    target=work/product;target.mkdir()
    with tarfile.open(root.parent/('agentsys-'+product)/f'agentsys-{product}-{version}.tgz') as bundle:bundle.extractall(target,filter='data')
    products[product]=target/'package'

def size(folder):return sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())
def freeport():
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
def start(folder,product,args):
    began=time.perf_counter(); proc=subprocess.Popen([node,str(folder/'bin'/('agentsys-'+product+'.js')),*args],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8');lines=queue.Queue()
    def read():
        for line in proc.stdout:lines.put(line)
    threading.Thread(target=read,daemon=True).start()
    for _ in range(60):
        line=lines.get(timeout=5);match=re.search(r'Listening on (http://\S+)',line)
        if match:return proc,match[1],(time.perf_counter()-began)*1000
    raise RuntimeError('No startup announcement')

report={'baseline_commit':'5f916bf24bea3a10a0566c68992f1eacb79a999a','node':subprocess.check_output([node,'--version'],text=True).strip(),'method':'One cold process startup per product, 40 warm API reads, Chromium heap snapshot and one heartbeat interval. Descriptive, not statistically significant. Installation sizes exclude Node/browser runtimes. Baseline installation is the tracked monolithic source distribution, including its tests/tools.','measurements':{}}
with sync_playwright() as pw:
 for label,server,client,public in [('before',baseline,baseline,baseline),('after',products['server'],products['client'],products['client']/'dist/client')]:
    processes=[]
    try:
        port=freeport(); origin='http://127.0.0.1:'+str(port)
        proc,base,start_ms=start(server,'server',['start','--port','0','--data',str(work/(label+'-data')),'--allowed-origin',origin]);processes.append(proc)
        def get(route):return json.load(urllib.request.urlopen(base+'/api/'+route,timeout=10))
        get('projects'); latencies=[]
        for _ in range(40):
            began=time.perf_counter();get('projects');latencies.append((time.perf_counter()-began)*1000)
        client_proc,_,client_start_ms=start(client,'client',['--port',str(port),'--server',base]);processes.append(client_proc)
        browser=pw.chromium.launch(args=['--enable-precise-memory-info']);page=browser.new_page()
        began=time.perf_counter();page.goto(origin);page.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status === 'connected'");ui_ms=(time.perf_counter()-began)*1000
        page.wait_for_timeout(21000)
        heap=page.evaluate('performance.memory.usedJSHeapSize')
        stream=page.evaluate('Environment.status().status')=='connected'
        html=(public/'index.html').read_text(encoding='utf-8')
        scripts=re.findall(r'<script[^>]*src="([^"]+)"',html)
        values={'server_installation_bytes':size(server) if label=='after' else size(baseline),'client_installation_bytes':size(client) if label=='after' else size(baseline),'client_public_bytes':size(public) if label=='after' else sum((public/p).stat().st_size for p in scripts)+sum(p.stat().st_size for p in (public/'css').glob('*.css'))+(public/'index.html').stat().st_size,'browser_javascript_bytes':sum((public/p).stat().st_size for p in scripts),'server_startup_ms':round(start_ms,2),'static_cli_startup_ms':round(client_start_ms,2),'browser_connected_ms':round(ui_ms,2),'server_rss_bytes':psutil.Process(proc.pid).memory_info().rss,'static_cli_rss_bytes':psutil.Process(client_proc.pid).memory_info().rss,'browser_js_heap_bytes':heap,'api_p50_ms':round(statistics.median(latencies),3),'api_p95_ms':round(sorted(latencies)[37],3),'sse_connected_after_21_seconds':stream}
        if label=='before':
            values['initial_html_css_javascript_bytes']=values['client_public_bytes'];values['client_public_bytes']=None
        report['measurements'][label]=values
        print(label,json.dumps(values),flush=True);browser.close()
    finally:
        for process in processes:
            if process.poll() is None:process.terminate();process.wait(timeout=10)
(root/'integration-results/performance.json').write_text(json.dumps(report,indent=2)+'\n')
