"""Disposable local server shared by browser integration checks."""
from contextlib import contextmanager
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
def isolated_server():
    with tempfile.TemporaryDirectory(prefix='agentsys-browser-') as directory:
        plugin_dir = Path(directory) / 'plugins' / 'ai'
        plugin_dir.mkdir(parents=True)
        for name in ['main.js', 'README.md']:
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'data' / 'plugins' / 'ai' / name, plugin_dir / name)
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
