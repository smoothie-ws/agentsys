# Testing

`npm test` runs the Node suite. Tests use independent application backends and temporary server data. Coverage includes graph editing, types, wires, nested nodes, signals, reads, loops, permissions, explicit execution, plugin lifecycle and storage boundaries.

`python tests/browser_suite.py` runs browser scenarios with Playwright and Chromium. `browser_catalog.py` checks the MVP end to end: plugin-owned Providers, credential isolation, Delay, pause/resume, immediate Stop, transient results and mobile layout. `browser_canvas_latency.py` checks canvas edit responsiveness.

The removed history, scheduling, stream and durable-recovery subsystems have no active tests or fixtures.
