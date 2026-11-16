"""Install released tarballs into isolated directories; exercise CLI, HTTP and browser.

No product source imports. Output artifacts and logs are retained for review.
"""
from pathlib import Path
import json, os, re, shutil, subprocess, tempfile, threading, queue, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
NPM = Path(NODE).parent / 'node_modules/npm/bin/npm-cli.js'
WORK = Path(tempfile.mkdtemp(prefix='agentsys-artifacts-'))
TOKEN = 'artifact-test-token'
processes = []
results = {'work': str(WORK), 'checks': []}

def check(name, condition):
    assert condition, name
    results['checks'].append(name)
    print('PASS ' + name, flush=True)

def install(product, version):
    destination = WORK / product
    destination.mkdir()
    archive = ROOT.parent / ('agentsys-' + product) / f'agentsys-{product}-{version}.tgz'
    subprocess.run([NODE, str(NPM), 'install', '--prefix', str(destination), '--ignore-scripts', '--no-audit', '--no-fund', str(archive)], check=True, capture_output=True, text=True)
    package = destination / 'node_modules' / ('agentsys-' + product)
    check(product + ' installed independently', package.is_dir())
    return package

def start(package, product, args):
    proc = subprocess.Popen([NODE, str(package / 'bin' / f'agentsys-{product}.js'), *args], cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
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
    server = install('server', '0.4.0')
    client = install('client', '0.7.0')
    check('server package contains no browser application', not (server / 'index.html').exists() and not (server / 'js/app').exists())
    check('client package contains no backend or interpreter', not (client / 'server').exists() and not (client / 'runtime').exists())
    client_process, origin = start(client, 'client', ['serve', '--port', '0'])
    server_process, base = start(server, 'server', ['start', '--port', '0', '--data', str(WORK / 'data'), '--token', TOKEN, '--allowed-origin', origin])
    status, meta, _ = call(base, 'GET', 'meta')
    check('discovery reports independent API and application versions', status == 200 and meta['version'] == '0.4.0' and meta['api_version'] == '2.0')
    status, project, _ = call(base, 'POST', 'projects', {'name': 'Artifact-only project'})
    check('project created through public HTTP', status == 200 and bool(project['id']))
    status, workflow, _ = call(base, 'GET', 'projects/' + project['id'] + '/workflow')
    check('workflow readable without client code', status == 200 and isinstance(workflow['nodes'], list))
    _, _, headers = call(base, 'OPTIONS', 'projects', extra={'Origin': origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization,Content-Type'})
    check('exact-origin authenticated CORS preflight', headers.get('Access-Control-Allow-Origin') == origin and 'Authorization' in headers.get('Access-Control-Allow-Headers', ''))
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
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
        page.screenshot(path=str(WORK / 'connected.png'), full_page=True)
        check('browser has no uncaught JavaScript errors', not errors)
        browser.close()
    # Persisted data must survive a process restart with no client connected.
    server_process.terminate(); server_process.wait(timeout=10)
    server_process, restarted = start(server, 'server', ['start', '--port', '0', '--data', str(WORK / 'data'), '--token', TOKEN, '--allowed-origin', origin])
    status, projects, _ = call(restarted, 'GET', 'projects')
    check('data survives independent server restart', status == 200 and project['id'] in json.dumps(projects))
    results['status'] = 'passed'
except Exception as error:
    results['status'] = 'failed'; results['error'] = str(error)
    raise
finally:
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    (WORK / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print('Evidence: ' + str(WORK), flush=True)
