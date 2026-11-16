"""Disposable independent API and static Client processes shared by browser checks."""
from contextlib import contextmanager, ExitStack
import json
import os
import subprocess
import shutil
from pathlib import Path
import tempfile


async def expand_workflow_section(page, name):
    section = page.locator(f'[data-workflow-section="{name}"]')
    if await section.get_attribute('open') is None:
        await section.locator(':scope > summary').click()


@contextmanager
def isolated_server(root=None):
    root = Path(root or Path(__file__).resolve().parents[1])
    with tempfile.TemporaryDirectory(prefix='agentsys-browser-') as directory, ExitStack() as stack:
        source = "const a=require('./server/api-server').createApiServer({dataDir:process.env.AGENTSYS_BROWSER_DATA});a.listen(0).then(url=>console.log(JSON.stringify({url}))).catch(e=>{console.error(e);process.exit(1)});"
        def start(args):
            process = subprocess.Popen(args, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env={**os.environ, 'AGENTSYS_BROWSER_DATA': directory},
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            def stop():
                process.terminate()
                process.wait(timeout=10)
            stack.callback(stop)
            return process
        api = start(['node', '-e', source])
        line = api.stdout.readline()
        if not line:
            raise RuntimeError(api.stderr.read())
        api_url = json.loads(line)['url']
        client = start(['node', 'bin/agentsys-client.js', '--port', '0', '--server', api_url])
        while True:
            line = client.stdout.readline()
            if not line:
                raise RuntimeError(client.stderr.read())
            if line.startswith('Listening on '):
                yield line.strip().removeprefix('Listening on '), directory
                break
