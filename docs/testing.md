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
```

All browser tests pass: `navigation`, `navigation_fixes` (panels, Developer-mode URL gating, the API page reached from the Dashboard), `ui` (menus, search, redraw, a paused run showing its running nodes as paused), `smoke` (canvas, editors, Library, tabs, types, widgets, search), `custom_node`, `appearance`, `mobile_theme`, `snap_hints`, `exchange_themes` (static server, hash routes) and `available_nodes`, `runs` (real server). Run them one at a time against a fresh `DATA_DIR`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium.

## Before a release

Create a project → add nodes → connect → Run; make a Custom Node in the Library; place it and confirm it is locked; edit it in the Library and confirm the copy updates; reload and confirm state persisted; run `node examples/stream-workflow/setup.cjs http://127.0.0.1:8080` against a running server and follow its printed instructions (webhook → queue → state counter, an event wait).
