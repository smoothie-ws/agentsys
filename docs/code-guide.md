# Code guide

- `js/storage`: database access and the canonical text graph format.
- `js/model`: graph documents, validation, editing, snapshots, live graph lookup and signal interpretation.
- `js/backend/runtime.js`: request contexts, route registration, writer serialization, undo history and Library hooks.
- `js/backend/execution.js`: workflow runtimes, durable JSON data and Run, Pause, Resume and Stop.
- `js/backend/scripts.js`: Worker isolation and the checked Script bridge.
- `js/backend/builtin-nodes.js`, `graph-nodes.js`, `routes-builtin.js`: the built-in Library (flow, values, Graph nodes).
- `js/app`, `js/pages`, `js/canvas`, `js/inspector`: application shell, pages and the graph editor.
- `plugin-host.js`, `js/backend/routes-plugins.js`, `js/pages/plugins.js`, `plugins/`: the plugin host, its API routes, the Plugins page and the bundled example.
- `server.js`, `headless.js`: file-backed HTTP hosting and the same backend loaded in Node.

All browser scripts are plain globals loaded by `index.html`; that list is also what `headless.js` loads for tests, so a new file is registered in one place.

Each workflow keeps its live runtime. Its Worker is reused between signals; state, values and previews are saved independently of running JavaScript. Graph edits update the interpreter's view only when they change something it can observe (moving or recolouring a node does not).

Canvas performance rules:

- Keep CSS selectors cheap: avoid `:has()` on ancestors of the canvas. It makes the browser re-evaluate styles for the whole page on every DOM change; use an explicit class or attribute set from JavaScript instead.
- Never query layout (`getBoundingClientRect`, `getTotalLength`, `getPointAtLength`, `offsetWidth`) per node or per wire inside pointer-move handlers. Use the geometry the renderer already computed.
- The interpreter needs a new snapshot only when something it can observe changed (`semanticKey` in `js/model/documents.js`): not for layout, colour, pinned or folded changes.
- The renderer keeps node, frame and wire elements between draws and measures only what changed.
