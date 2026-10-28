# Testing

`python tests/browser_skills_sections.py <port>` checks skill editing, native Markdown exchange and metadata preservation, nested groups, menu moves, drag, rename/delete, one-line resizable node fields and joining pixels in light and dark mobile themes. `tests/skills.test.js` covers format validation and group isolation; the server suite verifies SKILL.md storage and external file edits. The browser suite uses Playwright and Pillow.

`python tests/browser_mobile_theme.py <port>` checks the flat component editor and single Reset, inspector corner joins and actions below ports, live states and alpha colours, zero radii, preset exchange, automatic reset, phone widths 320/390/430px, tablet width 820px, bottom navigation, sheet trees, keyboard viewport changes, touch menus, connected bottom tabs with vertical gradients, the vertical inspector rail, real two-touch pinch zoom and restoration of desktop layout.

`python tests/browser_exchange_themes.py <port>` checks authoring controls with Developer mode off, context menus, project/workflow JSON round trips, focus radius, named themes, theme file exchange, and atomic validation.

`python tests/browser_navigation_fixes.py <port>` checks sidebar order, the shared Settings reset, inspector mounting and hover, exclusive icon selection, image upload and persistence for nodes and folders, saved graph URLs with Developer mode off, and wrapped API rows and method selection from the folded panel.

`python tests/browser_appearance.py <port>` checks picker colours (including theme defaults and alpha), exact group fills, theme accent on Run, stable hover geometry, rounded panels, background linear navigation glow, nested row alignment and the Shortcuts layout.

## API tests (Node ≥ 20, no dependencies)

```bash
npm test        # same as: node --test
```

`tests/harness.js` loads `storage/`, `model/` and `backend/` scripts (in the order of `index.html`, through `headless.js`) into a Node `vm` context with an in-memory store, and exposes `api(method, path, opts)` and `nodes`, `flow`, `bundleOf`, `place` (configs of nodes with each `op`, signal wires and Library nodes, to build graphs in tests); `createApp({scripts: 'worker'})` runs node code in worker threads like the server does (needed to test cancelling). `tests/api.test.js` covers nodes, wires, groups, Complex Nodes (also what happens to wires, values and bindings when a Custom node's ports change) and the Library editor; `tests/custom.test.js` Script and Library nodes (the code of a Script, `emit` and `output`, developer mode, `display`, validation, the event nodes and their hooks, and code that edits the graph); `tests/engine.test.js` the engine itself (see `docs/engine-design.md`: order and caching, a failed node is not retried, the chain limit, outputs named like `toString`, values that are copies, parallel inputs and their cap, cycles in every order of the roots, timeouts, an endless loop, cancel, size limits, runs staying apart in Workers started ahead, `display`/`agentsys`/`context` as variables); flow control (waves, `node.flow`, `handles`, `failFast`) is in the same file, and `tests/flow-nodes.test.js` runs the loop nodes of `examples/flow-nodes.json`; `tests/widgets.test.js` also the declared widgets (`config.widgets`); `tests/types.test.js` types (shapes, structural compatibility, record values checked at run time, Library types (made by the Custom Nodes, global, changed in a node, removed when idle), types travelling with copied nodes); `tests/controls.test.js` the control of a type, enums and the default of a free input; `tests/runs.test.js` runs, triggers, project state, export/import and conditional edits; `tests/server.test.js` starts a real server on a free port with a temporary data folder and tests `/api`, access rules, SSE, webhooks, the scheduler and sharing the data folder with the browser's storage (and that bad requests get a 400, not a 500). Add a test whenever you change a rule in `model/` or a route.

## Browser smoke test

```bash
pip install playwright && playwright install chromium
python3 -m http.server 8000 &
python3 tests/browser_smoke.py 8000
```

It drives the real UI (Chromium) and prints PASS or FAIL per check (133 of them): menus, wires, the Add menu with the Library Custom Nodes, a Script with `display()`, the Widgets field of the Library editor, folding with only connected ports and aligned wires, floating canvas controls, widgets of every kind on a node, types (colours, the editor, wires checked by type), node and group opacity with Undo/Redo, the Library editor, its tree and its cards (kinds, items, groups, drag into a group), tabs (graph editors only), the two-panel navigation (sections in the sidebar, a tree in the second panel and the same rows as cards on the page, no "All projects" row, the highlight gliding between rows and sections, the second panel kept in an editor, rounded corners and the glow at the open row), Ctrl+K (also finding Library items), the Properties panel (also folded to its rail), the minimap button, the log of a run, a provider form with bad JSON, editing a number, the selection rectangle, and a check that there are no console errors. It also passes against `node server.js` (use that port instead). Use it after UI changes, and add a check for whatever you changed. To use an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path.

## Manual checks worth doing before a release

Create a project → add nodes → connect → Run; save a group as a Custom Node from the Library; place it and confirm it is locked; edit it in the Library and confirm the placed copy updates; reload the page and confirm state persisted.

`python tests/browser_navigation.py <port>` checks the navigation regressions: Effects and reload persistence, the removed navigation switch, gradient width updates during panel collapse/expansion (also without animations), matching colours at the joins, Search at the upper right, the unchanged content background and the taller content fade. It uses the same Playwright setup as the smoke test.

`python tests/browser_ui.py <port>` covers fixed-size glow pixels at three panel widths, keyboard reopening of panels, searchable submenu navigation, disabled submenu groups, stale search responses during debounce, dialog submission without a submitter, and cancellation of scheduled canvas redraws on navigation. All three browser scripts exit with an error if a check fails.

## Controller regression checks

`tests/durability.test.js`, `initiatives.test.js`, `ai-permissions.test.js`, `format-replay.test.js` cover persisted waits/restart, journal reconstruction and version conflicts, fake model retries/budgets/approval lifecycle, Worker isolation, canonical round trips, pinned versions and offline replay. Use the worker runner for isolation tests; inline execution deliberately shares the VM realm for fast graph tests. No paid model is used.

`tests/fixtures/*.graph-test.json` follows `{graph,inputs,mocks,expected}` and is discovered by `tests/graphs.test.js`. `graph` is a canonical workflow envelope, `inputs` the run payload, `mocks` deterministic model responses and `expected` the golden status/displays/outputs. Update goldens explicitly with `node tests/update-goldens.cjs --update [fixture.graph-test.json]`; ordinary test runs never rewrite expectations. `evals/run.cjs` is the separate manual quality-eval entry point, using `AGENTSYS_EVAL_URL`, optional provider/model/token environment variables and `evals/cases.json`. It does not block deterministic CI.

Browser controller verification: `python tests/browser_controller.py` starts the current Node server on a free port with a disposable copy of live data, checks the waiting canvas after closing/reopening a page, initiatives, approvals, history and replay, captures `docs/controller-preview.png`, and shuts the test server down. An existing disposable server URL can be passed as an argument.
