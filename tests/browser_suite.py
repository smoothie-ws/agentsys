"""Run the browser scenarios with isolated server/browser data.

Requires Playwright and Chromium; optional script names select a subset.
Logs go to a temporary directory printed at startup. No project data is used.
"""
import functools
import http.server
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SELF_HOSTED = {'platform', 'execution_ui', 'plugins', 'design', 'shell'}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def main():
    # `browser_platform` is the split client/server end-to-end test. The other selected scripts exercise the
    # combined local server's editor UI (still supported for `node server.js`).
    # browser_smoke.py targeted the removed browser-only mode; browser_plugins.py targeted server plugins.
    selected = sys.argv[1:] or ['platform', 'execution_ui', 'shell', 'design']
    logs = Path(tempfile.mkdtemp(prefix='agentsys-browser-suite-'))
    print(f'Logs: {logs}', flush=True)
    failures = []
    for name in selected:
        script = ROOT / 'tests' / f'browser_{name}.py'
        if not script.is_file() or name in {'server', 'suite'}:
            raise ValueError(f'Unknown suite: {name}')
        server = None
        args = [sys.executable, str(script)]
        if name not in SELF_HOSTED:
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            args.append(str(server.server_port))
        started = time.monotonic()
        try:
            with (logs / f'{name}.log').open('w', encoding='utf-8') as log:
                result = subprocess.run(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8'}, timeout=240)
            passed = result.returncode == 0
        except subprocess.TimeoutExpired:
            passed = False
        finally:
            if server:
                server.shutdown()
                server.server_close()
        print(f'{"PASS" if passed else "FAIL"} {name} ({time.monotonic()-started:.1f}s)', flush=True)
        if not passed:
            failures.append(name)
    print(f'{len(selected)-len(failures)}/{len(selected)} passed; failures: {failures}', flush=True)
    return bool(failures)


if __name__ == '__main__':
    sys.exit(main())
