"""Serve only the published Client ZIP using ordinary static hosting."""
from pathlib import Path
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hashlib, json, tempfile, threading, zipfile
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
release=json.loads((root/'integration-results/releases.json').read_text())
archive=Path(release['download_directory'])/'agentsys-client-static.zip'
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
assert digest==next(a['sha256'] for a in release['products']['client']['assets'] if a['name']==archive.name)
directory=Path(tempfile.mkdtemp(prefix='agentsys-static-only-'))
with zipfile.ZipFile(archive) as bundle:bundle.extractall(directory)
requests=[]
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):requests.append(self.path);super().do_GET()
    def log_message(self,*_):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(directory)))
threading.Thread(target=server.serve_forever,daemon=True).start()
results={'artifact_sha256':digest,'hosting':'ordinary Python static HTTP server; no AgentSys CLI/backend','browsers':{}}
try:
    with sync_playwright() as pw:
        for engine in ['chromium','firefox','webkit']:
            browser=getattr(pw,engine).launch();page=browser.new_page();errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto('http://127.0.0.1:'+str(server.server_port))
            page.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status==='disconnected'")
            assert page.evaluate('Environment.list().length')==0
            assert page.locator('#view').inner_text().strip()
            state=page.evaluate("async () => {const env=Environment.save({name:'Unavailable server',url:'http://127.0.0.1:1'});await Environment.setActive(env.id);return Environment.status();}")
            assert state['status']=='disconnected' and state['detail'] and not errors
            assert not any(path.startswith('/api/') for path in requests)
            results['browsers'][engine]='passed';browser.close()
            print('PASS published static ZIP on ordinary hosting: '+engine,flush=True)
finally:
    server.shutdown();server.server_close()
(root/'integration-results/static-only.json').write_text(json.dumps(results,indent=2)+'\n')
