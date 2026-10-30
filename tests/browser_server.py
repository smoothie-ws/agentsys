"""Disposable local server shared by browser integration checks."""
from contextlib import contextmanager
import json
import os
import subprocess
import tempfile


@contextmanager
def isolated_server():
    with tempfile.TemporaryDirectory(prefix='agentsys-browser-') as directory:
        source = "const a=require('./server').createServer({dataDir:process.env.AGENTSYS_BROWSER_DATA});a.listen(0).then(url=>console.log(JSON.stringify({url}))).catch(e=>{console.error(e);process.exit(1)});"
        process = subprocess.Popen(['node', '-e', source], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, 'AGENTSYS_BROWSER_DATA': directory},
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError(process.stderr.read())
            yield json.loads(line)['url'], directory
        finally:
            process.terminate()
            process.wait(timeout=10)
