# Code guide

AgentSys is plain static files: no build step, no framework. Scripts are classic `<script defer>` files that share top-level `const`/`function`/`class` names, so **the order in `index.html` matters**. Every file starts with a comment saying what it holds.

## File map

| Folder | What lives there |
|---|---|
| `js/storage/db.js` | IndexedDB key-value store with an in-memory cache. Everything persistent goes through it. |
| `js/model/schema.js` | Node definitions, limits, widget rules, the ops, the Script's variables and scripts. Pure functions. |
| `js/model/types.js` | User-defined types (only `any` is built in): `TypeTable` (what a type expression means in a document), structural `compatible`, `checkTypes`, `libraryType`/`plainType`/`ownTypes` and `unifyTypes` (a workflow's list = Library types + its own; the Library's are kept by `Call.reconcileLibraryTypes` in `backend/runtime.js`). Types only decide what may be wired to what. Pure functions. |
| `js/app/type-ui.js` | Type colours (`typeClass`, `paintTypes`), the type selector and the type editor. |
| `js/model/documents.js` | Shape of a stored workflow document, copying with fresh ids. |
| `js/model/snapshot.js` | Turns a document into what the canvas draws (nodes with ports, wires, groups, Complex Nodes, problems). |
| `js/model/editor.js` | `Editor` class: **every** change to a workflow document (nodes, wires, groups, Complex Nodes, clipboard, Library placement). |
| `js/model/evaluate.js` | From a workflow to a run: `wireGraph` (where each input comes from), `compilePlan` (the part of the graph the roots need, as plain data) and `hookPlan` (the event node of a Library node copy and what its signal reaches), `runPlanned` and `evaluateGraph` (events → hooks, outputs, errors, status). |
| `js/model/executor.js` | `executePlan`: carries a plan out (demand-driven, each node once, independent inputs at the same time, cycle and chain checks, time and size limits). Self-contained: its source text is what the Worker runs. |
| `js/backend/runtime.js` | Route table, `Call` (one request), undo history, `Backend.request()`. |
| `js/backend/routes-*.js` | The API, grouped by area (`app`, `projects`, `workflow`, `library`, `runs` with triggers, `state`, `exchange`). The API page is generated from the route table. |
| `js/backend/scripts.js` | Runs a plan in a Web Worker (`runPlan`, `display`): one Worker per run, a watchdog for a script that never returns, cancel; fresh Workers are started ahead while runs follow each other (`spawnWorker`; the server supplies worker threads). |
| `headless.js`, `server.js` | `headless.js` loads storage/model/backend into a Node `vm` context (with a file store and worker threads for the server, in memory and inline for tests). `server.js` serves the site, `/__data`, `/api`, `/hooks` and ticks the scheduler. |
| `js/backend/resources.js`, `settings.js` | Library resources and providers; shortcuts. |
| `js/app/*` | Shell: DOM helpers and `api()`, dialogs, popup menus, preferences, router, tabs (graph editors only; other pages remember their place in `Tabs.pages`), sidebar of sections and the second panel (`nav.js`: `sectionOf`, `Subnav`, `navRow`, the trees `NAV_TREES`, menus of the rows; `placePills` puts the sliding highlights and the `.nav-seam` glow of the next panel at the open row), sidebar toggles, panel resizing, Ctrl+K and boot (`shell.js`). |
| `js/pages/*` | One file per page. Pages register in `PAGES` (`pages/shared.js`). |
| `js/canvas/*` | The workflow page: `data` (load), `render`, `camera`, `selection`, `interaction`, `wires`, `menus`, `commands`, `run`. State lives in the object `W` (`canvas/page.js`). Anything a drag redraws goes through `onNextFrame(key, work)` (`canvas/render.js`), so the screen is redrawn once per frame instead of once per pointer event. |
| `js/inspector/inspector.js` | The Properties panel (`Inspector` object). |
| `css/*.css` | `tokens` (variables, reset, keyframes) → `controls` → `shell` (sidebar, second panel, tabs) → `nav-joined` (folder-tab effect controlled by Effects, everything under `body.nav-joined`) → `pages` → `overlays` (dialogs, menus, toasts) → `canvas` → `inspector` (right panel). One file per area, no override files. |

## Request flow

UI code never touches the database. It calls `api(method, path, {body, query, edit})` (`app/helpers.js`) which calls `Backend.request()`. A route in `backend/routes-*.js` receives a `Call` (`ctx`) and reads/writes through `ctx.get / set / remove / commit`. Workflow changes create an `Editor` over the document, so all rules live in one place. After the change, the canvas calls `reload()` to fetch a fresh snapshot and redraw.

## Data model

A workflow document: `{nodes, layout, style, groups, complex, port_edges, widgets, types, root?, folder?}`.

- A **group** is a visual frame (`groups[]`, selection id `frame:<gid>`).
- A **Complex Node** is a group that also has an interface (`complex[]`, node id `complex:<gid>`).
- **Library Custom Nodes** are resources of kind `custom_node` (`{bundle, description, folder}`); folders are the list `node_folders`.
- Outside the Library every Complex Node is locked and collapsed: it behaves like an ordinary node. It can only be changed in the Library editor.
- The **Library editor** is a private workflow with project/workflow id `lib-<resourceId>`. Its `doc.root` is the main group: nodes can only exist inside it (`adoptIntoRoot`). Placed copies follow the Library through `source.version` (`refreshInstance`).

## How to…

- **Add a backend file:** list it in `index.html` (storage, model and backend files are loaded from there by the server and the tests). Top-level names are shared with every other script, in the browser too: pick names no other file uses.
- **Add an API route:** call `route('GET', 'path/{id}', 'Summary', handler)` in the matching `routes-*.js`. It shows up on the API page automatically. Workflow-editing routes whose name is in `EDITS` (`runtime.js`) take part in undo/redo.
- **Add an `op`:** define it in `model/schema.js` (`OPS`); draw/inspect it in `canvas/render.js` and `inspector/inspector.js`; evaluate it in `compilePlan` (`model/evaluate.js`) and `executePlan` (`model/executor.js`).
- **Add a context-menu item:** `canvas/menus.js` (Add menu / selection menu); implement the action in `canvas/commands.js`.
- **Add a page:** create `pages/<name>.js`, register it in `PAGES`, add the `<script>` to `index.html` after `pages/shared.js`, route it in `app/router.js`.
- **Add a section or sub-sections:** a route belongs to a sidebar section through `sectionOf(route)` (`app/nav.js`). Give the section a tree in `NAV_TREES` (`{title, actions, active, empty, rows()}`; a row is `{key, label, icon, href, count, menu, children, drop, drag}`, `children` makes it a group) and its pages the same shape: `pageHead({crumbs, title, sub, actions})` on top, `card({...})` for every child of the open row (`pages/shared.js`), with the same "⋯" menu (`menuItems` in `nav.js`). A page that owns its sub-sections (Settings: `sectionTabs`, API: the call tree) fills the panel itself with `Subnav.mount({title, body})` while it opens, using `navTab()` / `.subnav-row` so every section looks the same. Keep the order `nav.js` before `shell.js` in `index.html`.
- **Add a script file:** add it to `index.html` *and* keep dependencies earlier in the list. The test harness (`tests/harness.js`) loads `storage/`, `model/` and `backend/` scripts from `index.html` automatically.
- **Persist a UI preference:** use `store.get(key, fallback)` / `store.set(key, value)` (`app/helpers.js`); never call `localStorage` directly.
- **Style something:** put the rule in the CSS file of its area; use variables from `tokens.css`. Surfaces are told apart by tone (`--panel`, `--card`, `--field`, `--well`), not by borders; hover is `--field` → `--hover`, press is `--press`. Menus and submenus must not get `transform`/`filter` on the element itself (fixed-position submenus), and nodes must not transition `transform`. Several class families (`s-*`, `t-*`, `k-*`, `m-*`, `syntax-*`) are generated in JS, so do not remove them as unused.

## Conventions

Format with `npx prettier --write` (config in `.prettierrc.json`, or `npm run format`). Keep functions small, prefer a comment on *why* over *what*, and put rules about the graph in `model/` rather than in UI code.

## Storage and Custom Nodes (current)

- `js/storage/db.js`: key-value store with a cache. With `server.js` every key is a JSON file under `data/` (mapping in `server.js`: `fileOf`/`keyOf`; `/__data` API, change events over `/__data/events`); without it, IndexedDB.
- A Custom Node is a Library resource that exists as soon as its editor opens. `Call.finish` calls `syncLibraryNode` after each change in a `lib-*` document, which rewrites the resource bundle and name (the main group's name). Immutable content versions are recorded at commit; placed copies refresh when `resource.updated` differs from `source.stamp`.
- Slots exposed on a group interface count as `connected`. Widgets live in `doc.widgets[customNodeId]` and are written only by code (`setWidgets`, the `widgets` routes).
