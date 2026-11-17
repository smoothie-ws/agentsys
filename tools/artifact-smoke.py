"""Install released tarballs into isolated directories; exercise CLI, HTTP and browser.

No product source imports. Output artifacts and logs are retained for review.
"""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tempfile, threading, queue, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get('AGENTSYS_NODE') or shutil.which('node')
from integration_common import npm_cli, cli_path
NPM = npm_cli(NODE)
WORK = Path(tempfile.mkdtemp(prefix='agentsys-artifacts-'))
TOKEN = 'artifact-test-token'
processes = []
results = {'work': str(WORK), 'checks': []}
endpoint_entered=threading.Event()
client_disconnected=threading.Event()
class IntegrationEndpoint(BaseHTTPRequestHandler):
    def do_GET(self):
        endpoint_entered.set()
        client_disconnected.wait(10)  # Response cannot complete until the browser is closed.
        body=json.dumps({'ok':True,'path':'/artifact-integration'}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass
endpoint=ThreadingHTTPServer(('127.0.0.1',0),IntegrationEndpoint)
threading.Thread(target=endpoint.serve_forever,daemon=True).start()

def check(name, condition):
    assert condition, name
    results['checks'].append(name)
    print('PASS ' + name, flush=True)

def install(product, version):
    destination = WORK / product
    destination.mkdir()
    archive = Path(os.environ.get('AGENTSYS_' + product.upper() + '_ARTIFACT') or ROOT.parent / ('agentsys-' + product) / f'agentsys-{product}-{version}.tgz')
    results.setdefault('artifacts',{})[product]={'path':str(archive.resolve()),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}
    subprocess.run([NODE, str(NPM), 'install', '--prefix', str(destination), '--ignore-scripts', '--no-audit', '--no-fund', str(archive)], check=True, capture_output=True, text=True)
    package = destination / 'node_modules' / ('agentsys-' + product)
    check(product + ' installed independently', package.is_dir())
    return package

def start(package, product, args):
    proc = subprocess.Popen([NODE, str(cli_path(package, product)), *args], cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
    processes.append(proc)
    lines = queue.Queue()
    log = WORK / f'{product}-{len(processes)}.log'
    def read():
        with log.open('w', encoding='utf-8') as output:
            for line in proc.stdout:
                output.write(line); output.flush(); lines.put(line)
    threading.Thread(target=read, daemon=True).start()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try: line = lines.get(timeout=.2)
        except queue.Empty:
            if proc.poll() is not None: raise RuntimeError(log.read_text())
            continue
        match = re.search(r'Listening on (http://\S+)', line)
        if match: return proc, match[1]
    raise RuntimeError('Startup timeout: ' + str(log))

def call(base, method, route, body=None, extra=None):
    headers = {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json', **(extra or {})}
    request = urllib.request.Request(base + '/api/' + route, data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
    try: response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error: response = error
    data = response.read()
    return response.status, json.loads(data) if data else None, response.headers

try:
    server = install('server', '0.1.0')
    client = install('client', '0.1.0')
    check('server package contains no browser application', not (server / 'index.html').exists() and not (server / 'js/app').exists())
    check('client package contains no backend or interpreter', not (client / 'server').exists() and not (client / 'runtime').exists())
    client_process, origin = start(client, 'client', ['serve', '--port', '0'])
    server_process, base = start(server, 'server', ['start', '--port', '0', '--data', str(WORK / 'data'), '--token', TOKEN, '--allowed-origin', origin])
    status, meta, _ = call(base, 'GET', 'meta')
    expected_version=json.loads((server/'package.json').read_text())['version']
    check('discovery reports independent API and application versions', status == 200 and meta['version'] == expected_version and meta['api_version'] == '1.0')
    status, project, _ = call(base, 'POST', 'projects', {'name': 'Artifact-only project'})
    check('project created through public HTTP', status == 200 and bool(project['id']))
    status, workflow, _ = call(base, 'GET', 'projects/' + project['id'] + '/workflow')
    check('workflow readable without client code', status == 200 and isinstance(workflow['nodes'], list))
    _, _, headers = call(base, 'OPTIONS', 'projects', extra={'Origin': origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization,Content-Type'})
    check('exact-origin authenticated CORS preflight', headers.get('Access-Control-Allow-Origin') == origin and 'Authorization' in headers.get('Access-Control-Allow-Headers', ''))
    status, _, headers = call(base, 'OPTIONS', 'projects', extra={'Origin': 'https://untrusted.invalid', 'Access-Control-Request-Method': 'POST'})
    check('unlisted origins are not granted CORS access', headers.get('Access-Control-Allow-Origin') is None)
    call(base, 'PUT', 'collections/races', {'schema': {'type': 'object', 'properties': {'value': {'type': 'integer'}}}})
    status, record, _ = call(base, 'POST', 'collections/races/records', {'data': {'value': 0}})
    check('collection created for concurrent writers', status == 200)
    def write(value):
        return call(base, 'PUT', 'collections/races/records/' + record['id'], {'data': {'value': value}}, {'If-Match': str(record['version'])})[0]
    with ThreadPoolExecutor(max_workers=2) as writers:
        outcomes = list(writers.map(write, [1, 2]))
    check('simultaneous conditional writes produce one success and one conflict', sorted(outcomes) == [200, 409])
    second_process, second_base = start(server, 'server', ['start', '--port', '0', '--data', str(WORK / 'second-data'), '--token', 'second-artifact-token', '--allowed-origin', origin])
    with sync_playwright() as pw:
        engine = os.environ.get('AGENTSYS_BROWSER', 'chromium')
        results['browser'] = engine
        browser = getattr(pw, engine).launch()
        context = browser.new_context()
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin)
        page.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status === 'disconnected'")
        check('static client loads disconnected without default server', page.evaluate('Environment.list().length') == 0)
        check('disconnected interface renders', page.locator('#view').inner_text().strip() != '')
        connected = page.evaluate('''async ({url, token}) => {
          const env = Environment.save({name: 'Artifact server', url, token});
          return await Environment.setActive(env.id);
        }''', {'url': base, 'token': TOKEN})
        check('cross-origin browser connection with bearer credentials', connected is True)
        check('first connection initializes the application UI', page.evaluate('app.booted') is True)
        projects = page.evaluate("async () => await Environment.request('GET', 'projects')")
        check('browser reads server-owned project over API', project['id'] in json.dumps(projects))
        observer = browser.new_page()
        observer.goto(origin)
        observer.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status === 'disconnected'")
        observer.evaluate('''async ({url, token}) => {
          const env = Environment.save({name: 'Second client', url, token});
          await Environment.setActive(env.id);
          globalThis.observedChanges = [];
          Environment.subscribe(keys => observedChanges.push(...keys));
        }''', {'url': base, 'token': TOKEN})
        # Wait until the authenticated stream is open before producing a change.
        observer.wait_for_timeout(300)
        status, changed, _ = call(base, 'POST', 'projects', {'name': 'SSE broadcast'})
        observer.wait_for_function("observedChanges.includes('projects')")
        check('second client receives cross-origin authenticated SSE changes', status == 200)
        check('tabs have independent transport identities', page.evaluate("sessionStorage.getItem('agentsys.client.v1.client-id')") != observer.evaluate("sessionStorage.getItem('agentsys.client.v1.client-id')"))
        tab=page.context.new_page()
        tab.goto(origin)
        tab.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status === 'connected'")
        check('tabs sharing one browser profile keep distinct transport identities',page.evaluate("sessionStorage.getItem('agentsys.client.v1.client-id')") != tab.evaluate("sessionStorage.getItem('agentsys.client.v1.client-id')"))
        check('bearer tokens are not copied into another tab session',tab.evaluate('Environment.tokenOf(Environment.active().id)') == '')
        tab.close()
        page.bring_to_front()
        for slug, source, plugin_id in [
            ('library-pack', ROOT / 'tests/fixtures/plugins/reference-library-pack.agentsys-plugin.json', 'reference-library-pack'),
            ('integration-studio', client / 'dist/client/client-plugins/integration-studio/integration-studio.agentsys-plugin.json', 'integration-studio'),
        ]:
            packet = json.loads(source.read_text(encoding='utf-8'))
            page.evaluate('''async pkg => {
              let timer;
              try {
                return await Promise.race([
                  Extensions.install(pkg),
                  new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Plugin installation did not settle: ' + JSON.stringify(Extensions.diagnostics()))), 15000); })
                ]);
              } finally { clearTimeout(timer); }
            }''', packet)
            page.wait_for_function("id => Extensions.apiOf(id) !== null", arg=plugin_id)
            deployed = page.evaluate('id => Extensions.deploy(id)', plugin_id)
            if not deployed['ok']: print(json.dumps(deployed), flush=True)
            check(slug + ' installs in sandbox and deploys Library resources through scoped API', deployed['ok'] and deployed['summary']['library'] > 0)
        graph_ids = page.evaluate('''async () => {
          const project = (await api('projects')).find(p => p.name === 'Reference pack');
          const detail = await api('projects/' + project.id);
          return {project: project.id, workflow: detail.workflows.find(w => w.name === 'Library Pack demo').id};
        }''')
        page.evaluate('''async endpoint => {
          await Extensions.execute('integration-studio:save', {name:'Artifact endpoint',endpoint,parameters:'{}',auth:'none',secretName:''});
        }''', 'http://127.0.0.1:' + str(endpoint.server_port))
        studio_graph = page.evaluate("Extensions.execute('integration-studio:build')")
        check('Integration Studio creates a persistent six-stage workflow through Host API', bool(studio_graph['project']) and bool(studio_graph['workflow']))
        page.evaluate('''async () => {
          const packet=await (await fetch('/client-plugins/graph-developer-tools/graph-developer-tools.agentsys-plugin.json')).json();
          await Extensions.install(packet);
        }''')
        page.wait_for_function("Extensions.apiOf('graph-developer-tools') !== null")
        page.evaluate("go('/ext/graph-developer-tools/graphs')")
        page.wait_for_function("document.querySelector('#ext-page-body')?.innerText.includes('Fetch and store')")
        check('Graph Developer Tools visualizes the published server graph', True)
        status, _, _ = call(base,'PUT','projects/'+studio_graph['project']+'/policy',{'allow':['graph.read','collections.read','collections.write','net.fetch:127.0.0.1:*','secrets.use:integration-demo']})
        check('owner explicitly grants workflow execution policy',status==200)
        first_id = page.evaluate('Environment.active().id')
        second_id = page.evaluate('''async url => {
          const env = Environment.save({name: 'Independent second server', url, token: 'second-artifact-token'});
          await Environment.setActive(env.id);
          return env.id;
        }''', second_base)
        second_projects = page.evaluate("async () => await Environment.request('GET', 'projects')")
        check('switching environments does not mix server projects', project['id'] not in json.dumps(second_projects))
        check('each environment keeps its own bearer credential', page.evaluate('id => Environment.tokenOf(id)', first_id) == TOKEN and page.evaluate('id => Environment.tokenOf(id)', second_id) == 'second-artifact-token')
        check('switching back reconnects to original server', page.evaluate('id => Environment.setActive(id)', first_id) is True)
        page.screenshot(path=str(WORK / 'connected.png'), full_page=True)
        check('browser has no uncaught JavaScript errors', not errors)
        started=page.evaluate("ids => api('projects/'+ids.project+'/execution', {method:'POST',body:{wait:false},query:{workflow_id:ids.workflow}})",studio_graph)
        check('client dispatches a workflow before disconnecting',started['dispatch_status']=='running')
        check('server execution is waiting on remote I/O before the client closes',endpoint_entered.wait(5))
        browser.close()
        client_disconnected.set()
    # Published resources are ordinary server data. No browser or plugin host remains.
    status, execution, _ = call(base, 'POST', 'projects/' + graph_ids['project'] + '/execution?workflow_id=' + graph_ids['workflow'], {'wait': True})
    check('published Library workflow executes after all clients disconnect', status == 200 and execution['dispatch_status'] == 'completed')
    check('headless execution produces saved Library-node output', 'Hello, world!' in ''.join((execution.get('displays') or {}).values()))
    for _ in range(100):
        status, studio_run, _ = call(base, 'GET', 'projects/' + studio_graph['project'] + '/execution?workflow_id=' + studio_graph['workflow'])
        if studio_run.get('status')=='idle' and '/artifact-integration' in ''.join((studio_run.get('displays') or {}).values()):break
        time.sleep(.1)
    check('Integration Studio workflow executes without a client or plugin host',status==200 and studio_run['status']=='idle' and not studio_run.get('errors') and '/artifact-integration' in ''.join((studio_run.get('displays') or {}).values()))
    status, records, _ = call(base,'GET','collections/integration-results/records')
    check('autonomous workflow stores the expected HTTP transformation',status==200 and any(r['data']['result'].get('path')=='/artifact-integration' and r['data']['result'].get('ok') for r in records['records']))
    with sync_playwright() as pw:
        browser=getattr(pw,os.environ.get('AGENTSYS_BROWSER','chromium')).launch()
        page=browser.new_page();page.goto(origin)
        page.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status === 'disconnected'")
        saved=page.evaluate('''async ({url,token}) => {
          const env=Environment.save({name:'Reconnected client',url,token});
          await Environment.setActive(env.id);
          return await api('collections/integration-results/records');
        }''',{'url':base,'token':TOKEN})
        check('a newly connected browser can retrieve the autonomous execution result',any(r['data']['result'].get('path')=='/artifact-integration' for r in saved['records']))
        browser.close()
    # Persisted data must survive a process restart with no client connected.
    server_process.terminate(); server_process.wait(timeout=10)
    server_process, restarted = start(server, 'server', ['start', '--port', '0', '--data', str(WORK / 'data'), '--token', TOKEN, '--allowed-origin', origin])
    status, projects, _ = call(restarted, 'GET', 'projects')
    check('data survives independent server restart', status == 200 and project['id'] in json.dumps(projects))
    if os.environ.get('AGENTSYS_FULL_UI') == '1':
        test_env=dict(os.environ,AGENTSYS_SERVER_CLI=str(cli_path(server,'server')),AGENTSYS_CLIENT_CLI=str(cli_path(client,'client')),AGENTSYS_UI_ARTIFACTS=str(WORK/'ui-review'))
        for scenario in ['browser_editor.py','browser_ux.py','browser_plugin_security.py','browser_plugin_platform.py','browser_plugin_certification.py']:
            command=[shutil.which('python'),str(ROOT/'tests'/scenario)]
            if scenario=='browser_ux.py':command.append(os.environ.get('AGENTSYS_BROWSER','chromium'))
            run=subprocess.run(command,env=test_env,cwd=ROOT,capture_output=True,text=True,timeout=300)
            (WORK/(scenario+'.log')).write_text(run.stdout+run.stderr,encoding='utf-8')
            check(scenario+' passes against independently installed artifacts',run.returncode==0)
    results['status'] = 'passed'
except Exception as error:
    results['status'] = 'failed'; results['error'] = str(error)
    raise
finally:
    endpoint.shutdown(); endpoint.server_close()
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    (WORK / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    evidence=ROOT/'.local/test-results'/('artifact-'+os.environ.get('AGENTSYS_BROWSER','chromium'))
    evidence.mkdir(parents=True,exist_ok=True)
    for artifact in WORK.iterdir():
        if artifact.is_file() and artifact.suffix in ['.json','.png','.log']:
            shutil.copy2(artifact,evidence/artifact.name)
    if (WORK/'ui-review').is_dir():
        shutil.copytree(WORK/'ui-review',evidence/'ui-review',dirs_exist_ok=True)
    print('Evidence: ' + str(WORK), flush=True)
