# AgentSys integration

Two independent products communicate through Web API 1.0:

- [Server](https://github.com/smoothie-ws/agentsys-server): headless graph execution, persistence, REST and SSE.
- [Client](https://github.com/smoothie-ws/agentsys-client): static graph editor and sandboxed plugins.

This repository contains only the launcher and cross-product tests. Each product owns its source, builds and releases.

## Local start

Build each product with `npm pack`, then run:

```sh
python tools/local.py --server-artifact ../agentsys-server/agentsys-server-0.1.0.tgz --client-artifact ../agentsys-client/agentsys-client-0.1.0.tgz
```

Node.js 22+ and Python are required. The launcher uses `.local/mvp-data`. Start with an empty store; the server initializes its `agentsys.store/1` marker. Browser state uses `agentsys.client.v1`.

## Tests

```sh
pip install playwright==1.57.0
python -m playwright install chromium firefox webkit
node --test tests/integration-boundary.test.js
python tools/artifact-smoke.py
```

Set `AGENTSYS_FULL_UI=1` for editor, UX, plugin security, lifecycle and resource certification scenarios. `AGENTSYS_BROWSER` selects `chromium`, `firefox` or `webkit`. Tarball paths can be overridden with `AGENTSYS_SERVER_ARTIFACT` and `AGENTSYS_CLIENT_ARTIFACT`.

Tests install independent tarballs, use disposable stores and browser contexts, and verify HTTP authentication/CORS/SSE, concurrent writes, environment isolation, plugin permissions, resource deployment and execution after the browser closes. Demo plugin packages in `tests/fixtures/plugins` are test inputs; they are not shipped with the Client.

Logs and screenshots are generated under ignored `.local/test-results/` and uploaded by CI. Build outputs, local data, caches and reports are not committed. Each product's CI tests Node.js 22/24 on Linux/Windows; integration CI runs all three browser engines.
