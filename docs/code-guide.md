# Code guide

- `shared/core.js`, `shared/protocol.js`: pure helpers and the server/client contract.
- `js/storage/format.js`: the canonical text graph format (used by both sides).
- `js/storage/db.js`: server-only key-value store and request `Context`.
- `js/model/graph.js`: shared read-only snapshot lookup, binding resolution, event names and import defaults.
- `js/model/types.js`: type definitions and compatibility, shared with client presentation.
- The remaining `js/model` files are server-only: graph documents, validation, editing, snapshot construction,
  execution views and the interpreter. The client submits edits through the API.
- `js/model/executor.js`: the interpreter; server-only.
- `js/backend/runtime.js`: request contexts, route registration, writer serialization, undo history and Library hooks.
- `js/backend/execution.js`: workflow runtimes, durable JSON data and Run, Pause, Resume and Stop.
- `js/backend/scripts.js`: Worker isolation and the checked Script bridge.
- `js/backend/routes-collections.js`: generic JSON collections with schema validation.
- `js/backend/builtin-nodes.js`, `graph-nodes.js`, `routes-builtin.js`: the built-in Library (flow, values, Graph nodes).
- `js/app`, `js/pages`, `js/canvas`, `js/inspector`: client shell, pages and graph editor.
- `js/app/environments.js`: the only API transport, environments and SSE.
- `js/app/plugin-store.js`, `js/app/extensions.js`, `js/pages/plugins.js`: sandboxed client plugins and their host.
- `js/app/plugin-frame.js`: isolated plugin SDK/module program; receives serialized configuration only.
- `js/app/plugin-views.js`: one rendered-contribution registry; derives pages, navigation and section lists.
- `js/canvas/geometry.js`: pure wire paths and hit-test samples, with appearance passed explicitly; also used
  by page previews. Rendering and interaction no longer own separate preview curve calculations.
- `server/manifest.js`: the fixed server script list. `index.html` is not a server manifest.
- `server/api-server.js`, `bin/agentsys-server.js`: API-only server and CLI.
- `bin/agentsys-client.js`, `bin/agentsys-local.js`: static client server and local two-process launcher.
- `server/file-store.js`: canonical file mapping, sidecars, redo recovery and external-change detection.
- `server/credentials.js`: per-server session/plugin credential ownership and expiry.
- `server/static-assets.js`: public-file boundary and header policy for the static Client.
- `js/app/plugin-content.js`: passive HTML, command attributes and resource-free CSS validation.
- `headless.js`: the Node backend loader. `server/api-server.js` contains the sole HTTP API implementation.

Client scripts are plain globals listed in `index.html`. Server scripts are plain globals listed in
`server/manifest.js` and loaded by `headless.js`. A file belongs to one side; adding it to a browser page never
adds it to the server.

Each workflow keeps its live runtime. Its Worker is reused between signals; state, values and previews are saved independently of running JavaScript. Graph edits update the interpreter's view only when they change something it can observe (moving or recolouring a node does not).

Canvas performance rules:

- Keep CSS selectors cheap: avoid `:has()` on ancestors of the canvas. It makes the browser re-evaluate styles for the whole page on every DOM change; use an explicit class or attribute set from JavaScript instead.
- Never query layout (`getBoundingClientRect`, `getTotalLength`, `getPointAtLength`, `offsetWidth`) per node or per wire inside pointer-move handlers. Use the geometry the renderer already computed.
- The interpreter needs a new snapshot only when something it can observe changed (`semanticKey` in `js/model/documents.js`): not for layout, colour, pinned or folded changes.
- The renderer keeps node, frame and wire elements between draws and measures only what changed.
