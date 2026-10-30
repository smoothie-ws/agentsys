# Code guide

- `js/storage`: database access and the canonical text graph format.
- `js/model`: graph documents, validation, editing, plan construction and signal execution.
- `js/backend/runtime.js`: request contexts, route registration, writer serialization, undo history and Library hooks.
- `js/backend/execution.js`: the current workflow execution and its explicit controls.
- `js/backend/scripts.js`: Worker isolation and the checked Script bridge.
- `js/backend/plugin-*`, `plugins.js`, `routes-plugins.js`: imperative plugin hosts, packages and lifecycle.
- `js/backend/library-catalog.js`: generic plugin-owned JSON resource collections.
- `plugins/ai`: the bundled Provider configuration plugin.
- `js/app`, `js/pages`, `js/canvas`, `js/inspector`: application shell, pages and graph editor.
- `server.js` and `headless.js`: local storage/HTTP hosting and the same backend in Node.

Execution has no durable lifecycle or history subsystem. Start captures the graph; its Worker runs until work completes, fails or is stopped. General flow semantics are documented in [Engine](engine.md).
