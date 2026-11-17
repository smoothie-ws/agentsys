# Integration tests

Build `agentsys-server-0.1.0.tgz` and `agentsys-client-0.1.0.tgz` with `npm pack` in their repositories. Install Python Playwright and the browser engines:

```sh
pip install playwright==1.57.0
python -m playwright install chromium firefox webkit
node --test tests/integration-boundary.test.js
python tools/artifact-smoke.py
```

Set `AGENTSYS_BROWSER` to `chromium`, `firefox` or `webkit`. Set `AGENTSYS_FULL_UI=1` to run editor, UX, plugin sandbox, lifecycle and resource certification scenarios against installed artifacts. Override tarball paths with `AGENTSYS_SERVER_ARTIFACT` and `AGENTSYS_CLIENT_ARTIFACT`.

The suite checks authentication and CORS, independent installs/restarts, concurrent conditional writes, environment isolation, plugin permissions and lifecycle, collections, Library deployment, and workflow execution after the browser closes. Each run starts with empty temporary server and browser storage. Logs, screenshots and results are written to `integration-results/artifact-<browser>/`.

Each product CI runs unit tests on Node.js 22 and 24, Linux and Windows. Client CI tests static hosting in all three browser engines. Integration CI builds each pinned product independently and uses public HTTP and installed browser assets.

`python tools/verify-releases.py` validates published initial artifacts. `python tools/static-release-smoke.py` checks the static ZIP; `python tools/ci-status.py` records current CI results.
