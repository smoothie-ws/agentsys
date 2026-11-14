# Testing

## Node suite

```sh
npm test
```

Uses only Node built-in modules. Each test builds an independent in-memory backend or a temporary data folder.
Coverage includes graph editing, types, wires, nested nodes, signals, reads, loops, execution controls,
permissions, Data and Graph nodes, durable JSON, the HTTP server, collections and migration. Recent result:
**242 pass, 0 fail** (~10 s).

Useful focused runs:

```sh
node --test tests/platform.test.js
node --test tests/execution.test.js
node --test tests/migration.test.js
node --test tests/server.test.js
```

`tests/platform.test.js` checks the platform split itself: no server plugin route, no client/server script
cross-loading, `/api/meta`, sessions, CSRF/CORS, SSE, generic collections and a client plugin creating a
runnable Library node. `tests/migration.test.js` checks the backup, preserved data and provider/secret move.

## Browser suite

Requires Python Playwright and Chromium:

```sh
python tests/browser_suite.py
# or one scenario
python tests/browser_suite.py platform
```

If Chromium is not in Playwright's cache, point at it:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python tests/browser_suite.py
```

Selected scenarios:

- `platform` — **the split end-to-end test**: starts an API-only server and a static client as separate
  processes; checks no local Backend/DB, the Environments page, a workflow run, continuation after the client
  page closes, reconnect, a second server with isolated data, a sandboxed plugin creating a Library node, and a
  server restart that restores JSON without rerunning the graph.
- `execution_ui` — Run/Pause/Resume/Stop and previews across tabs and reloads on the combined local server.
- `shell` — navigation, tabs, toolbar and responsive shell.
- `design` — page geometry at desktop, tablet and phone widths; node/signal appearance.

`tests/browser_smoke.py` and `tests/browser_plugins.py` belong to the removed browser-only and server-plugin
architectures. They are kept for reference but are not in the default suite; their coverage is replaced by
`platform` plus the Node suite.

## Manual smoke alternatives

```sh
node tools/smoke.js --mobile
```

This older tool opens pages through the Chrome DevTools protocol and saves screenshots. It targets the combined
`server.js` editor and is not part of the split architecture test.

`node tools/bench.js` measures graph reads, runtime reads, a Script loop, commits, idle runtimes and Library type
lookups against a fresh in-memory backend. Use `--json` for before/after numbers. The historical baseline and
method are in [baseline](baseline.md).

## What the tests do not cover

- TLS termination and a real reverse proxy.
- Every mobile browser and every private-network permission prompt.
- A malicious user-installed client plugin (the sandbox is tested as a boundary for code, not as an
  authorization system).
- Durable resumption of JavaScript (not implemented).
