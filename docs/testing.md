# Testing

`npm test` runs the Node suite. Each test uses an independent backend and temporary server data. Coverage: graph editing, types, wires, nested nodes, signals, reads, loops, controls, permissions, the Data and Graph nodes, the plugin host, durable JSON state and the server.

`python tests/browser_suite.py` runs the browser scenarios with Playwright and Chromium (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if needed). Name scenarios to run a subset, e.g. `python tests/browser_suite.py smoke`.

- `browser_smoke.py`: navigation, Library, Custom Nodes, tabs, wire styles and the main editor flows.
- `browser_execution_ui.py`: Run/Pause/Stop, state and previews across tabs and reloads, action menus.
- `browser_plugins.py`: the Plugins page.
- `browser_design.py`: common page geometry at desktop, tablet and phone widths; stable node shells, ordered short-pass feedback and signal wires. Review screenshots are written to `node_modules/.cache/ui-review` (override with `AGENTSYS_UI_ARTIFACTS`).

Interpreter tests cover concurrent Run signals, live edits while paused, Stop of synchronous code, restart persistence, JSON export/import and chains deeper than a thousand nodes. `graph-primitives.test.js` covers the Graph nodes through the real runtime, including concurrent child instances and permission checks. A focused run: `node --test tests/execution.test.js`.

Test behavior, not appearance: no pixel, gradient or timing assertions.
