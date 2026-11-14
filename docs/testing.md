# Testing

## Node suite

```sh
npm test
```

Uses only Node built-in modules. Each test builds an independent in-memory backend or a temporary data folder.
Coverage includes graph editing, types, wires, nested nodes, signals, reads, loops, execution controls,
permissions, Data and Graph nodes, durable JSON, the HTTP server, collections, migration, the client transport,
architectural boundaries, the plugin capability layer, concurrency and resource bounds. Recent result:
**387 tests, 386 pass, 0 fail, 1 skipped (~20 s)**. The skip is the POSIX file-mode check on Windows.

Useful focused runs:

```sh
node --test tests/platform.test.js       # the split: API-only server, sessions, CORS, SSE, collections
node --test tests/execution.test.js      # the graph engine and its controls
node --test tests/migration.test.js      # backup, preserved data, provider and secret move
node --test tests/server.test.js         # the HTTP server and the data folder
node --test tests/architecture.test.js   # forbidden imports and browser APIs in the server half
node --test tests/environments.test.js   # the client transport, in a Node vm
node --test tests/security.test.js       # auth, sessions, CSRF, CORS, Host, SSE, 413, redaction
node --test tests/plugin-capabilities.test.js tests/client-plugins.test.js
node --test tests/storage-integrity.test.js tests/backup.test.js
node --test tests/concurrency.test.js tests/api-contract.test.js
node --test tests/engine-regression.test.js tests/resource.test.js
node --test tests/graph-format.test.js
node --test tests/network-policy.test.js tests/lifecycle.test.js
node --test tests/format-property.test.js tests/runtime-robustness.test.js
node --test tests/deployment.test.js tests/tls.test.js tests/soak.test.js
```

`tests/platform.test.js` checks the platform split itself: no server plugin route, no client/server script
cross-loading, `/api/meta`, sessions, CSRF/CORS, SSE, generic collections and a client plugin creating a
runnable Library node. `tests/migration.test.js` checks the backup, preserved data and provider/secret move.

Round 3 added: `network-policy.test.js` (local HTTP servers, allowlists, redirects, limits, abort, IPv6,
private DNS pinning, project egress), `lifecycle.test.js` (streams, sessions, port release), `format-property`
(random graph round-trips), `runtime-robustness` (parallel signals, paused Stop, eviction), `deployment`
(CLI validation and start/stop), `tls` (self-signed HTTPS and trusted proxy) and `backup`/`storage-integrity`
fault cases.

## Browser suite

Requires Python Playwright and Chromium:

```sh
python -m playwright install chromium
python tests/browser_suite.py
# or one scenario
python tests/browser_suite.py platform
```

If Chromium is not in Playwright's cache, point at it:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python tests/browser_suite.py
```

Selected scenarios:

- `ux` can also run on another engine: `python tests/browser_ux.py firefox` or `… webkit` (after
  `python -m playwright install firefox webkit`); screenshots get a `-firefox`/`-webkit` suffix. The other
  scenarios use Chromium.

- `platform` - **the split end-to-end test**: starts an API-only server and a static client as separate
  processes; checks no local Backend/DB, the Server page, a workflow run, continuation after the client
  page closes, reconnect, a second server with isolated data, an installed plugin creating a Library node, and a
  server restart that restores JSON without rerunning the graph.
- `plugin_security` - installs a read-only plugin that tries to write, fetch directly from its iframe, read a secret,
  run another plugin's command, post a notification and add a `javascript:` link: every attempt is refused, the
  victim command never runs and no request reaches a local recorder; then a plugin with `graph.write` performs
  exactly that write, a `notifications.write` plugin posts one, disabling it revokes its token, a failing plugin is
  isolated, and plugin page HTML is sanitized (including a newline-obfuscated `javascript:` link and `<style>`).
- `editor` - the workflow editor through its own controls on the split client: add a node from the Add menu,
  undo and redo from the toolbar, delete a selected node with the keyboard and restore it, reload and find the
  stored graph, then Run from the toolbar and read the display.
- `ux` - desktop, tablet and phone layouts; empty states; one heading and named controls on every page; an
  unreachable server that keeps its title and offers a retry; removing a server from its row; keyboard
  search; a readable API error; an unsaved settings change warning. Runs on Chromium, Firefox and WebKit. Saves
  screenshots to `docs/audits/platform-marathon/screenshots/`.
- `execution_ui` - Run/Pause/Resume/Stop and previews across tabs and reloads on the combined local server.
- `shell` - navigation, tabs, toolbar and responsive shell.
- `design` - page geometry at desktop, tablet and phone widths; node/signal appearance.

`tests/browser_smoke.py` and `tests/browser_plugins.py` belong to the removed browser-only and server-plugin
architectures. They are kept for reference but are not in the default suite; their coverage is replaced by
`platform` plus the Node suite.

## Load and backup tools

```sh
node --expose-gc tools/stress.js          # reads, runs, writes, a 600-node graph, Stop under load, heap
node tools/stress.js --json               # the same as JSON
node --expose-gc tools/soak.js --seconds 60   # create/edit/run/delete in a bounded loop, heap sampled
node tools/backup.js --data data --out backups
```

`tools/stress.js` reports medians and p95 for one machine; compare runs on the same machine over time. The Node
suite asserts loose bounds so a leak or a quadratic path fails it, not a slow machine. `tests/soak.test.js` runs
a short version of the soak (8 s) with the same thresholds; the tool is for longer runs.

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

- TLS termination and a real reverse proxy. `tests/tls.test.js` covers direct HTTPS with a generated self-signed
  certificate and the trusted-proxy cookie rule, but not a public CA, OCSP or a deployed nginx/Caddy.
- Every mobile browser and every private-network permission prompt.
- A malicious user-installed client plugin is covered as a sandbox boundary and a capability system in
  [plugin-testing.md](plugin-testing.md) and [plugin-security.md](plugin-security.md); it is still not an
  authorization system against a modified client or the owner's own token.
- Durable resumption of JavaScript (not implemented).
