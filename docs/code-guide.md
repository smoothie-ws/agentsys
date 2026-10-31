# Code guide

- `js/storage`: database access and the canonical text graph format.
- `js/model`: graph documents, validation, editing, live graph lookup and signal interpretation.
- `js/backend/runtime.js`: request contexts, route registration, writer serialization, undo history and Library hooks.
- `js/backend/execution.js`: workflow runtimes, durable JSON data and signal controls.
- `js/backend/execution-store.js`: CAS-versioned execution journal, retention, independent areas and operation transition routes.
- `js/backend/scripts.js`: Worker isolation and the checked Script bridge.
- `js/backend/plugin-*`, `plugins.js`, `routes-plugins.js`: imperative plugin hosts, packages and lifecycle.
- `js/backend/library-catalog.js`: generic plugin-owned JSON resource collections.
- `plugins/ai`: the bundled Provider configuration plugin.
- `js/app`, `js/pages`, `js/canvas`, `js/inspector`: application shell, pages and graph editor.
- `server.js` and `headless.js`: local storage/HTTP hosting and the same backend in Node.
- `sdk/operations.js`: universal explicit checkpoint/callback orchestration; no interpreter or domain scheduling policy.
- `examples/durable-process.cjs`: parallel non-LLM process using a real server, Workers, restart and explicit retry.

Each workflow retains its live runtime. Its Worker is reused between signals; state, values and previews are saved independently of active JavaScript tasks. Graph edits update the interpreter view. General flow semantics are documented in [Engine](engine.md).

The storage layer supplies `compareAndSet`; IndexedDB uses one transaction and server file writes check versions before their existing redo commit. `execution-store.js` reuses shared JSON/key/version validation with plugin storage. An execution journal is a supplement to workflow JSON, not a replacement state system. See [Audit](execution-audit.md) and [Durable execution](durable-execution.md).
