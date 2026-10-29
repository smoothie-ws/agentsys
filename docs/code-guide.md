# Code guide

Plain static files: no build step, no framework. Scripts are classic `<script defer>` files that share top-level names, so **the order in `index.html` matters** (`headless.js` and the tests read the `storage/`, `model/` and `backend/` scripts from `index.html`, so a new backend file only needs a tag there). Every file starts with a comment saying what it holds.

## Map

| Where | What |
|---|---|
| `js/storage/db.js` | key-value store with an in-memory cache (IndexedDB in the browser, files with the server); `uid`, `clone`, `hashText` |
| `js/storage/format.js` | `TextGraph`: the canonical text format |
| `js/model/schema.js` | ops, node definitions, widget rules, limits |
| `js/model/types.js` | user types, structural compatibility |
| `js/model/documents.js`, `snapshot.js` | shape of a stored workflow; what the canvas draws |
| `js/model/editor.js` | `Editor`: **every** change to a workflow document |
| `js/model/evaluate.js`, `executor.js` | from a workflow to a plan to a run; `executePlan` is self-contained (its source is what the Worker runs) |
| `js/backend/runtime.js` | route table, `Call`, undo history, `Backend.request()` |
| `js/backend/routes-*.js` | the API by area: `app` (session, settings, search, Library nodes), `projects`, `workflow`, `library`, `runs` (+triggers), `state`, `exchange`, `permissions` (policy, secrets, net), `intervention` |
| `js/backend/plugins.js`, `routes-plugins.js` | plugin packages, registry, bridge, endpoint Worker; the `plugins/…` routes |
| `js/backend/builtin-nodes.js`, `routes-builtin.js` | the built-in Library catalog (generated) and `library/builtin` that adds it |
| `tools/export-builtin.js` | regenerates `builtin-nodes.js` from a running server's Library |
| `js/backend/routes-notifications.js` | the notification list behind the bell |
| `js/backend/scripts.js` | runs a plan in a Web Worker; spare Workers, watchdog, cancel |
| `js/backend/workflows.js`, `queues.js`, `accounting.js` | supervision, queues, bridge quotas and usage |
| `js/backend/live-plan.js`, `versions.js`, `replay.js`, `permissions.js` | live plan deltas, versions, replay, capabilities |
| `js/backend/resources.js`, `settings.js` | Custom Node validation; shortcuts, appearance, **`LIMITS`** |
| `headless.js`, `server.js` | load the backend into a Node `vm`; HTTP, webhooks, scheduler, data folder |
| `js/app/*` | shell: DOM helpers and `api()`, dialogs, popups, router, tabs, sidebar and second panel (`nav.js`), the notification bell (`notifications.js`), boot (`shell.js`) |
| `js/pages/*` | one file per page, registered in `PAGES`: `home` (dashboard), `projects`, `library`, `plugins` (list, one plugin, the sandbox of plugin pages), `runs`, `settings`, `api` (reached from the dashboard) |
| `js/canvas/*`, `js/inspector/` | the workflow page and the Properties panel |
| `css/*` | `tokens` → `controls` → `shell` → `nav-joined` → `pages` → `overlays` → `canvas` → `inspector`; one file per area |

## Request flow

UI code never touches the database. It calls `api(method, path, {body, query, edit})`, which calls `Backend.request()`. A route in `routes-*.js` gets a `Call` and reads/writes through `ctx.get / set / remove / commit`. Workflow changes go through an `Editor`, so all rules live in one place. The canvas then calls `reload()`.

## Routing and navigation

`parseRoute` (`js/app/router.js`): `/` dashboard, `/projects`, `/p/{project}[/settings]`, `/p/{project}/w/{workflow}`, `/resources` (Library sections), `/resources/nodes[?folder=]`, `/resources/nodes/{id}`, `/runs`, `/api`, `/settings`, `/plugins`, `/plugins/{id}`, `/plugins/{id}/{page}` (a page a plugin adds, in Plugins or in the Library section). Served by `server.js` these are real paths under `/editor/`; opened any other way (static server, file) they live in the URL hash. `sectionOf(route)` (`nav.js`) selects the primary section. `NAV_TREES` and `SECTION_PANELS` define every second-panel tree; pages never mount their own navigation. Plugin pages may declare an explicit manifest `navigation` override. The URL selects the subsection; Tabs remembers scroll/filters and graph editors. `pageHead`, `card`, `actionButton`, `permissionChoices` and `pageAutosave` are shared page primitives. Native Library declarations, validation and resource routes live in `backend/library-catalog.js`; `pages/catalog.js` renders the shared collection UI. Routes are `/resources/{section}[/{item}][?folder=...]`.

## How to…

- **Add an API route:** `route('GET', 'path/{id}', 'Summary', handler)` in the right `routes-*.js`; it shows on the API page automatically. Names in `EDITS` (`runtime.js`) take part in undo.
- **Add a limit:** an entry in `LIMITS` (`settings.js`), read with `limitOf(prefs, key)`; it is validated, returned by `GET settings` and drawn on Runs → Run limits. Do not write a literal default in the code that reads it.
- **Add an op:** `OPS` in `schema.js`; draw it in `canvas/render.js`, inspect in `inspector.js`, evaluate in `compilePlan` and `executePlan`.
- **Add a page:** `pages/<name>.js`, `PAGES.<name>`, a `<script>` after `pages/shared.js`, a case in `parseRoute`, `sectionOf` and `Tabs.pageKey`.
- **Add a plugin extension point:** validate it in `validatePluginPackage` (`plugins.js`), expose it through the registry (`GET plugins`), draw it in `pages/plugins.js` or the place it extends, bump nothing unless the contract breaks (`PLUGIN_API`), and document it in [Plugins](plugins.md).
- **Persist a UI preference:** `store.get/set` (`helpers.js`), never `localStorage` directly.
- **Style something:** in the CSS file of its area, with variables from `tokens.css`. Surfaces differ by tone (`--panel`, `--card`, `--field`), not by borders. Menus must not get `transform`/`filter` on the element itself; nodes must not transition `transform`. Classes `s-*`, `t-*`, `k-*`, `m-*`, `syntax-*` are generated in JS: do not remove them as unused.

## Rules of the project

No legacy and no compatibility layers: remove the old way fully (code, tests, docs, data) and keep one uniform way to do a thing. Do not commit without an explicit request. `node --test` must pass; a UI change needs a browser smoke check. Format with `npx prettier --write` (`npm run format`). Keep functions small, comment *why*, and keep graph rules in `model/`, not in UI code.
