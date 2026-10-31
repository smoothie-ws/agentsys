# Testing

`npm test` runs the Node suite. Tests use independent application backends and temporary server data. Coverage includes graph editing, types, wires, nested nodes, signals, reads, loops, permissions, live graph signals and durable JSON state, plugin lifecycle and storage boundaries.

`python tests/browser_suite.py` runs browser scenarios with Playwright and Chromium. `browser_catalog.py` checks the MVP end to end: plugin-owned Providers, credential isolation, Delay, pause/resume, immediate Stop, saved previews and mobile layout. `browser_canvas_latency.py` checks canvas edit responsiveness.

`browser_execution_ui.py` covers JSON state and previews across tabs and page reload, stale polling responses versus Pause/Stop, first-click execution controls, header geometry, collapsible workflow settings, explicit-only Library expansion and action menus.

Interpreter tests cover concurrent Run signals, live code and connection edits while paused, Stop of synchronous code, restart persistence, JSON export/import, automatic completion and chains deeper than one thousand nodes. Editor events in different workflows can proceed independently. The suite also verifies that an old node error does not turn a later successful event into a failure.

`durable-execution.test.js` covers real Worker dispatch/read/plugin ancestry, concurrent CAS, deletion/recreation versions, late node callbacks, checked network cancellation, a new Run arriving during Stop, inherited budgets, trace redaction/retention, competing operation claims, write failures, explicit retry and user-only grants. `durable-server.test.js` kills a separate server process during infinite synchronous code, verifies interrupted versus completed records, races HTTP storage CAS and runs the restartable readiness example. `browser_durable_execution.py` checks standalone grants without Developer mode, effective policy restrictions, reload persistence and history links.

Focused checks: `node --test tests/durable-execution.test.js tests/durable-server.test.js` and `python tests/browser_suite.py durable_execution`. The complete browser suite discovers the new scenario automatically.
