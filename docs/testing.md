# Testing

## API and engine tests

```sh
npm test        # node --test, Node 20+, no dependencies
```

`tests/harness.js` loads the `storage/`, `model/` and `backend/` scripts (in the order of `index.html`, through `headless.js`) into a Node `vm` context with an in-memory store and exposes `createApp()` with `api(method, path, body)`, `nodes`, `flow`, `bundleOf`, `place`. `createApp({scripts: 'worker'})` runs Script code in worker threads like the server (needed for cancel and isolation tests); the default inline runner shares one realm and is for fast graph tests.

| File | Covers |
|---|---|
| `api`, `body`, `custom`, `controls`, `types`, `widgets`, `syntax`, `themes`, `disable`, `onread`, `output-values`, `scope-emit` | nodes, wires, groups, Complex Nodes, the Library editor, Scripts, types, widgets, event nodes |
| `engine`, `flow-nodes`, `graphs` (+ `fixtures/*.graph-test.json`) | the executor: order, caching, limits, cycles, cancel, waves and flow control, the loop nodes of `examples/flow-nodes.json`, golden graph fixtures |
| `runs`, `durability`, `streams-state`, `streams-server` | runs, triggers, waits and restart, state, queues, supervision, quotas, retention, the example stream workflow across a real server restart |
| `live-plan`, `intervention`, `format-replay`, `permissions` | live edits, human intervention, canonical format, versions, replay, capabilities and Worker isolation |
| `available-nodes`, `examples` | which Library nodes a workflow offers; the example catalogs place with valid manifests |
| `server` | a real server on a free port with a temporary data folder: access rules, SSE, webhooks, scheduler, redirects, sharing the data folder with the browser store |

Golden fixtures: `{graph, inputs, expected}`; update explicitly with `node tests/update-goldens.cjs --update [fixture]`. Add a test whenever a rule in `model/` or a route changes.

## Browser tests (Playwright, Chromium)

```sh
pip install playwright && playwright install chromium
python3 -m http.server 8101 &            # static: hash routes
python3 tests/browser_navigation.py 8101
python3 tests/browser_navigation_fixes.py 8101
python3 tests/browser_ui.py 8101
node server.js &                         # real server: path routes (set PORT/DATA_DIR)
python3 tests/browser_available_nodes.py http://127.0.0.1:8080
python3 tests/browser_runs.py http://127.0.0.1:8080
python3 tests/browser_navigation_audit.py  # starts its own server and disposable DATA_DIR
```

Browser checks include `navigation`, `navigation_fixes` (panels, Developer-mode URL gating, the API page reached from the Dashboard), `ui` (menus, search, redraw, a paused run showing its running nodes as paused), `smoke` (canvas, editors, Library, tabs, types, widgets, search), `custom_node`, `appearance`, `mobile_theme`, `snap_hints`, `exchange_themes` (static server, hash routes) and `available_nodes`, `runs` (real server). Run them one at a time against a fresh `DATA_DIR`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium.

`browser_navigation_audit.py` checks desktop and phone navigation, Dashboard subsections, canonical Library URLs, absence of breadcrumbs and canvas Back, sidebar-only API tree/search and OpenAPI download, status icons above nodes, native link URLs and middle-click, Back/Forward between settings sections, direct links with trailing slashes and dotted IDs, stale async responses, search and notification destinations, keyboard editor tabs and section links, closing all editors, contextual error exits, notification close, absence of Refresh actions, modal navigation sheets, and hash routing. `browser_workspace_layout.py` checks the compact pages, field heights through reopening/reload and case-sensitive port labels.

`tests/builtin.test.js` covers the built-in catalog (added once, edits and deletions respected, restore). `tests/plugins.test.js` covers packages, install/update/remove, Library ownership, grants and quarantine, settings, data, endpoints (inline and Worker), templates and the admin-only management routes. The plugin UI (import, enable, the sandboxed page and its bridge) is checked in a browser against a real server with a fresh `DATA_DIR`.

## Before a release

Create a project → add nodes → connect → Run; make a Custom Node in the Library; place it and confirm it is locked; edit it in the Library and confirm the copy updates; reload and confirm state persisted; run `node examples/stream-workflow/setup.cjs http://127.0.0.1:8080` against a running server and follow its printed instructions (webhook → queue → state counter, an event wait).

`browser_catalog.py` uses a disposable server to check the shared navigation/header format in all seven sections, native Library menus and forms, SKILL.md persistence, credential isolation, custom plugin icons, default and explicitly overridden plugin navigation, API download and mobile destinations. `catalog.test.js` covers resource CRUD, schemas, hierarchy, actions, grants, migration and cleanup; `catalog-storage.test.js` checks actual Markdown files, separate credentials and a server restart. Disposable browser servers share `tests/browser_server.py`.

`browser_permissions.py` checks node and project permission radio clicks during an in-flight save, workflow settings autosave, navigation/reload persistence and removal of policy editing from Runs.

## Complete browser suite and performance probes

`python tests/browser_suite.py` runs all 16 browser scenarios with isolated data. It starts loopback static servers for browser-only scenarios and lets file-backed scenarios create their disposable servers. It prints the temporary log directory and each result, and exits nonzero if any scenario fails. To select scenarios: `python tests/browser_suite.py navigation_audit permissions mobile_theme`.

`workspace_polish` checks the runnable starter, automatic run updates, preserved policy input, navigation guards, reconnecting after server errors, pagination, filters after reload, and narrow mobile layouts. `run-overview.test.js` checks retained-history metrics, server-side filters and cursor pagination.

Install Playwright and its Chromium browser before running. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects an existing Chromium executable. The runner does not install dependencies or use the project's `data/` folder.

`python tests/browser_performance.py` reports local graph reload/draw costs, Dashboard/Runs request counts with 100 projects, and whether an externally completed run appears without reopening Runs. `node tools/benchmark-storage.cjs` measures a small settings commit with 100/1000/5000 unrelated files in a temporary data directory. These are diagnostic measurements, not timing assertions. See the [audit report](full-audit-2026-10-29.md) for methodology and limitations.
