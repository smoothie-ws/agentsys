# AgentSys MVP

A local visual workflow editor. Start a graph, execute the work reached by its signals, then finish or stop it. Pause/resume is available on the canvas. There is one current execution per workflow, with no persisted execution history or background scheduler.

## Start

```sh
npm start
npm start -- --port 3000
```

On Windows, `start.bat 3000` selects a port. `PORT`, `HOST` and `DATA_DIR` are also supported. The editor is served at `/editor/`; the HTTP API is under `/api/`.

## Scope

- Projects and workflows, a canvas, typed data ports, signal wires and nested Custom Nodes.
- Script and Event primitives; reusable Library graphs provide loops, branches, values, Delay and previews.
- Explicit Start, Pause, Resume and Stop. The graph is captured at start; edits apply to the next execution.
- Undo/redo, copy/paste, imports/exports, project permissions, checked network calls and secret storage.
- Imperative plugins with activate/deactivate, registration APIs, owned handlers and sandboxed views.
- The bundled AI plugin supplies only Provider configuration. AI domain schemas and behavior belong to plugins.

The core has no AI resources or model client. The MVP has no execution-history page, event waits, streams, durable queues, automatic retries, checkpoints or replay. Time delays are ordinary waits within the current execution and do not survive a server restart.

Data lives in `data/` as JSON and canonical graph files. Without the Node server, a static deployment uses browser storage and executes while its tab is open.

## Verification

```sh
npm test
```

Browser checks use Playwright and Chromium: `python tests/browser_suite.py`. Each scenario uses isolated data.

See [Engine](docs/engine.md), [Execution](docs/runtime.md), [API](docs/api.md), [Plugins](docs/plugins.md) and [Decisions](docs/decisions.md).
