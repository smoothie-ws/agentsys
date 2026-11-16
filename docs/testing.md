# Testing

Architectural measurements and regression results are recorded in
[the finalization report](architecture-finalization/VERIFICATION.md). Reproduce with:

```sh
node tools/source-metrics.js --ref 6d9d623
node tools/source-metrics.js
node --expose-internals tools/architecture-metrics.js --ref 6d9d623
node --expose-internals tools/architecture-metrics.js
python tools/client-bench.py --samples 5 --nodes 200 --output client-performance.json
node --expose-gc tools/stress.js --json
node tools/platform-bench.js --samples 5
```

`architecture-metrics.js` uses Node's bundled Acorn parser via `--expose-internals`, for development analysis
only. It reports exact token duplication, function/branch counts, browser payload and CommonJS cycles. It does
not infer classic-script global call cycles, semantic clone equivalence or formal cyclomatic complexity. Its
parser version is included in the output; use the same Node executable for comparisons.

For browser comparisons, create a detached baseline worktree and pass its absolute path to
`client-bench.py --root PATH`. Every server gets a disposable data directory and every browser context is new.
The workload measures cold dashboard loading, 200-node graph loading/color edits/layout saves, a full plugin
install/disable/enable/remove cycle and switching to a second server and back. Colors and positions change on
each sample. The harness requires the same Playwright setup as the browser tests.

Additional architecture regressions cover owner-wide view cleanup and page collisions
(`plugin-views.test.js`), DOM-independent wire geometry (`canvas-geometry.test.js`), plugin dialog cancellation
(`plugin-sandbox.test.js`) and refusal to serve mutation/validation/execution implementations
(`architecture.test.js`, `static-serving.test.js`).

## Node suite

```sh
npm test
```

Uses only Node built-in modules. Each test builds an independent in-memory backend or a temporary data folder.
Coverage includes graph editing, types, wires, nested nodes, signals, reads, loops, execution controls,
permissions, Data and Graph nodes, durable JSON, the HTTP server, collections, the client transport,
architectural boundaries, the plugin capability layer, concurrency and resource bounds. Recent result:
**446 tests, 445 pass, 0 fail, 1 skipped** on local Windows Node 20 compatibility. The skip is the POSIX file-mode check on Windows. Supported Node 22/24 and browser results are recorded separately in Verification.

Useful focused runs:

```sh
node --test tests/platform.test.js       # the split: API-only server, sessions, CORS, SSE, collections
node --test tests/execution.test.js      # the graph engine and its controls
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
runnable Library node. Storage-integrity and backup suites cover current-data preservation and recovery.

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
  screenshots to `node_modules/.cache/ui-review/` (override with `AGENTSYS_UI_ARTIFACTS`).
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

This tool opens pages through the Chrome DevTools protocol and saves screenshots. It starts independent API
and static Client processes with empty disposable data. For an existing Client, pass `--url` and its API's `--server`.

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

## Finalization regressions and measurements

- `tests/plugin-sandbox.test.js`: disposal during credential issuance, fail-closed issuance, scoped renewal,
  concurrent expiry replies and environment switching.
- `tests/environments.test.js`: scoped 401 never becomes an owner request; per-owner issuance/revocation,
  logout, save-vetoed switches and credentials revoked at the original URL.
- `tests/permissions.test.js`: real Worker timer errors cannot expose the host realm.
- `tests/static-serving.test.js`: Windows case/dot/space spellings and symlinks cannot publish server files.
- `tests/lifecycle.test.js`: backpressure disconnects slow SSE clients; proxy-appended addresses own sign-in counters.
- `tests/network-policy.test.js`: refused headers close unfinished upstream bodies.
- `tests/storage-integrity.test.js`: whole-transaction validation and malformed external filenames.
- `tests/plugin-packages.test.js`: LF/CRLF package reproducibility.

```sh
node tools/source-metrics.js --ref HEAD
node tools/source-metrics.js
python tests/browser_plugin_platform.py
```

The source metrics exclude generated `builtin-nodes.js`, dependencies, tests, tooling and user data; retired
legacy code is reported separately. Comparison artifacts and measured workload timings are in
[audits/mvp-finalization](audits/mvp-finalization/REPORT.md). CI covers Node 22/24 on Linux and Windows; the
browser job uses Node 24. No new runtime npm dependencies were added.

`browser_ux.py` tests delayed navigation and a dirty form whose save request stays held until the user-close
check finishes. It asserts that the real application `beforeunload` handler cancels unloading and that the native
prompt appears. Explicit browser contexts keep context disposal separate from the user-close path: the
Browser.new_page convenience API otherwise closes its owned context before an asynchronous prompt handler
necessarily answers. Native confirmation passes in the installed Chromium, Firefox and WebKit builds. The
independent Firefox capability probe remains for builds that actually suppress prompts; it uses an explicit
context too and never skips application cancellation assertions.
