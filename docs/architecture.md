# Architecture

AgentSys is a **static site**: `index.html` loads an ordered list of plain `<script defer>` files — no build step, no framework; the YAML parser is bundled locally. The whole API runs inside the browser. `server.js` is optional: it serves the files, keeps the data as readable JSON and Markdown files, and runs **the same backend** (`headless.js` loads the shared scripts into a Node `vm` context) as an HTTP API with a scheduler, so runs, triggers and outside programs work with no page open ([headless-api.md](headless-api.md)). Without the server the same site runs from any static server and keeps its data in IndexedDB.

```
browser
  pages, canvas, inspector        the interface      js/app, js/pages, js/canvas, js/inspector
        │  api(method, path, {body, query, edit})
  Backend.request()               the API            js/backend/runtime.js, routes-*.js
        │  Call → Editor → workflow document
  model                           graph rules        js/model/*.js   (pure, no DOM)
        │
  DB                              key-value store    js/storage/db.js
        │  /__data  (fetch for reads and writes, Server-Sent Events for changes)
node server.js                    files and data/*.json              (optional)
        │  /api/*, /hooks/*          the same Backend in Node: HTTP API, runs, triggers (headless.js)
```

| Layer | Responsibility |
|---|---|
| `js/storage/db.js` | One key-value store for everything persistent, with an in-memory cache, plus the small shared helpers (`ApiError`, `uid`, `clone`). `Context` is one request's view of the data: values are copied on first read and written back only where they changed. |
| `js/model/` | All the rules of a graph, as pure functions: node definitions, limits and the ops (`schema`), the user-defined types (`types`), the stored shape of a document (`documents`), the read-only view the canvas draws (`snapshot`), every change to a document (`editor`), and evaluation (`evaluate`). |
| `js/backend/` | The API: a route table, one `Call` per request, undo history, the script worker and the provider client. Routes read and write through `ctx`, never through the DOM. |
| `js/app/`, `js/pages/`, `js/canvas/`, `js/inspector/` | The interface. It never touches the store: it calls `api()` and redraws from the snapshot it gets back. |

Skills use the [Agent Skills format](https://agentskills.io/specification): YAML frontmatter with name and description, followed by a Markdown instruction. The shared formatter in `js/storage/skills.js` uses the bundled js-yaml parser and preserves optional metadata.

The logical resource payload is `{markdown, folder}`. IndexedDB stores the Markdown document directly. The Node file store writes it to `library/skills/<name>/SKILL.md`; resources.json retains catalog metadata. Reads hydrate the document from disk, and file changes invalidate browser and API caches. Renaming a skill updates its directory and frontmatter together.

Skill groups use `library/skill-folders` and `library/skills/{resource_id}/move`. Their folders and icons are separate from node groups and remain editable without Developer mode.

## One request

`api()` hands the call to `Backend.request()`, which matches the path against the route table and runs the handler with a fresh `Call`. Requests are serialised (one at a time), so a handler sees a settled document; the two read-only calls that may run while something else is in flight (`llm`, `evaluate-node`) are marked `unlocked`.

A handler that edits a workflow builds an `Editor` over a private copy of the document, so every rule about the graph lives in one place. When the handler returns, `Call.finish` bumps the document's change counter, records an undo step for the routes named in `EDITS`, saves a Custom Node being edited back to the Library, and `ctx.commit()` writes the keys that actually changed. A handler that throws leaves nothing behind: the half-edited copy is simply dropped.

After an edit the canvas calls `reload()`, fetches a fresh snapshot and redraws.

## Document and snapshot

A workflow document is plain JSON: `{nodes, layout, style, groups, complex, port_edges, widgets, types, cursor, root?, folder?}`. Nothing in it is derived.

`buildSnapshot` turns it into what the canvas draws: nodes with their ports and widgets, the wire list, the group tree with depth and members, Complex Nodes, and `diagnostics` — the list of problems (unnamed or duplicate slot names, an unknown type, an input with two wires, incompatible types, a cycle, a binding that points outside its group). The snapshot is read-only and is never stored. Where only what exists, where it sits or how it is styled matters (moving, styling, selecting, saving groups), `buildSnapshot(…, structure = true)` skips ports, wires and diagnostics, which is several times cheaper on a large graph.

- A **group** is a visual frame around nodes and other groups.
- A **Complex Node** is a group that also has an interface: typed ports bound to ports inside it. On an ordinary canvas it is locked and behaves as one node; it can be changed only in its Library editor.
- A **Custom Node** is a Library resource holding the exported bundle of such a group. Its editor is a private workflow whose project and workflow id is `lib-<resource id>`; every change there is copied back into the resource. It can be read like a project, but the project routes refuse to rename, delete or duplicate it or to add workflows to it. Placed copies carry `source.stamp` and are rebuilt when the resource was saved again (`refreshInstance`).

## Evaluation and runs

Running a workflow fires signals along the wires, in three steps (full account and measurements in [engine-design.md](engine-design.md)):

1. **Compile.** `compilePlan(snapshot, roots, {context, events})` turns the part of the graph the roots need into a *plan*, plain data: every wire is resolved through Complex Nodes to the node and port it comes from (`wireGraph` settles that once, by an index of the ports each wrapper publishes), defaults and widget values are in place, signal outputs list the nodes they start (`targets`), and a node with a diagnostic is left out (whatever reads it gets its message). A root is an event node to fire, a Script to run once, or a pure node to read.
2. **Carry out.** `runPlan(plan, onEvent, signal)` (`backend/scripts.js`) starts one Web Worker (a worker thread on the server) for the whole run and sends it the plan; the Worker runs `executePlan` (`model/executor.js`) and reports events. Pure nodes (value nodes, Reroute) are computed when read; running nodes (`script` and the event nodes) run when a signal reaches them and keep their latest outputs. A signal output starts all its receivers at once; a Script may `emit` an output from the middle of its code and wait for what it started. Values that cross from node to node are kept as JSON and read back for each reader. The code of Scripts runs `limits.parallel` (16) at a time (a Script waiting in `emit` takes no place), each execution has a time limit (120 s of its own code), a chain of more than 1000 signals is refused, and the sizes of a result (20 MB) and of a run (100 MB) are limited. The page also watches the Worker: a script that never returns control cannot stop its own timer, so the page ends the run after the node's limit plus a short grace period.
3. **Collect.** `evaluateGraph` turns the events (`start`, `done`, `fail`, `root`) into the node hooks (`onNodeStart/Done/Fail`), the outputs and errors of the roots, the state of every node and the `node.display()` texts: `{outputs, errors, status, evaluated_nodes, displays}`. When the run itself stops (cancelled, or the Worker died) the nodes that were working fail and every root without a result takes the error.

Nothing else is checked: an output a node did not set is `undefined` for whoever reads it. A node that failed reports its error and the signal does not go on past it. The code of a Script is an `AsyncFunction` whose parameters are `display`, `agentsys`, `context`, `output`, `emit`, `read` and the data inputs that can be variables; nothing is added to the Worker's global scope (the global names answer with an explanation), and the code reaches the site's API through `agentsys()`, which asks the page.

**Starting the code.** A Worker takes about 15 ms to start. A run pays that once, not once per node; and while runs follow each other within a second (`spawnWorker` in `backend/scripts.js`), up to two fresh Workers are started ahead. An idle one does not keep the server process alive and is dropped after 10 seconds. A new Worker for every run means nothing a run leaves behind (globals, timers) reaches the next; the nodes of one run share their Worker. `displayText` and `executePlan` are written once and shared by the Worker (`WORKER_SOURCE` embeds their source text) and the in-process runner of the tests (`headless.js`, `scripts: 'inline'`).

**Library nodes.** A Library node is a Complex Node whose inside is made of Custom nodes. A copy placed in a workflow carries `source` (the Library resource) and is refreshed from it when the workflow is loaded and the resource changed. Nothing is hidden in it: a slot is bound to a port of a node inside, or it is free and is read by name (`scope_inputs` of the plan, `node.input.<name>`). Widgets belong to the nodes (`config.widgets`; `Editor.declareWidgets` keeps the values of the widgets that stay). The scope of a Script is the closest copy around it: `context.instance_id` and `widgets` come from it. There is no per-node code outside the Script: `op` (`script`, `on_run`, `on_read`, `on_placed`, `on_deleted`, `on_wired`, `on_widget`) says what a node does.

**Lifecycle hooks.** on_placed, on_deleted, on_wired and on_widget are event nodes, not stored events: `Call.finish` compares the Library node copies (nodes with `source`) of each modified document before and after the request (`collectHooks`; on_widget is the exception: only the user route `PUT widget-values` fires it), so every way of adding or removing a node (menu, paste, import, API, a script, Undo/Redo) is covered and moving or editing a node is not; on_wired fires for a copy whose set of wired inputs changed. The hooks run after the change is committed and the request lock is released (`runHooks`), one after another, so they may call the API. Each is a plan from `hookPlan`: the event node inside the copy and everything its signal reaches. Each firing is logged in `HOOKS.log` (`GET /api/node-hooks`, `Backend.hooksIdle()` waits for the queue). Edits made by a hook are announced with `DB.announce`. They run for anything that enters a canvas, pasted or imported nodes included, which is why the security model below counts them as code the user chose to open.

Diagnostics are checked first: a node with a problem fails with that message instead of running.

`evaluateGraph` takes an `AbortSignal` (cancelling ends the run at once: the Worker is terminated) and optional hooks told when a node starts, completes or fails. The runs API (`backend/routes-runs.js`) is built on them: a run is started in the background, keeps a per-node trace and an event log, can be cancelled, and is stored in the workflow's history. The canvas "Run" button uses the simpler `evaluate-node`.

## Storage and change notification

Every key is one JSON file under `data/` (`settings.json`, `projects.json`, `workflows/<id>.json`, `library/…`, `runs/<id>.json`, `meta.json`, and `other/<key>.json` for the remaining small keys; the mapping is `fileOf`/`keyOf` in `server.js`). Reads and writes go through `/__data`; writes are atomic (a temporary file is renamed). While a page is open the server compares file stamps once a second and reports what changed over `/__data/events`, so a file edited on disk — or by another tab — reaches the open page within a second. With no page open nothing is scanned.

Without the server the same keys live in IndexedDB and tabs tell each other through a `BroadcastChannel`. On the first start with the server, data from a browser-only session is moved into `data/` once.

## Security model

One trusted local user, everything in their own browser. The HTTP API (`/api`) can run code (Custom nodes run with the server's privileges there), so it is closed by default: Host-header check on loopback, `X-AgentSys` on changes, an optional bearer token, off on non-loopback addresses without one — see [headless-api.md](headless-api.md).

- The server listens on `127.0.0.1` unless `HOST` says otherwise, and serves only files inside the project folder (never `data/`, dotfiles or `node_modules`).
- A write to `/__data` requires the `X-AgentSys` header. A cross-site page cannot send it without a CORS preflight, which this server never grants.
- Script nodes are the user's own code, and the event nodes of a Library node (on_placed, on_deleted, on_wired, on_widget) run without a Run: importing or pasting a workflow, or placing a Library item, fires on_placed in it and runs whatever its signal reaches. Only import what you trust. They run in a Web Worker with a 120 s limit and no DOM, but they reach the whole API through `agentsys()`, so they can read and change everything in the data folder.
- Provider requests go straight from the browser to the provider, so an API key is stored in this browser (or data folder) only, and never passes through a server of ours. The provider must allow cross-origin requests.

## Limits

| | |
|---|---|
| Nodes per workflow | 1000 |
| Ports per direction, per node | 64 |
| Node configuration | 20 000 characters of ports, 16 000 per hook, 8000 for a multi-line default |
| Group nesting | 20 levels |
| Node code run | 120 s, result up to 1 MB |
| One run | 256 chained nodes; 8 MB of results, or 32 MB of images |
| Undo steps per workflow | 0 to 500 (Settings) |
| A Custom Node bundle | 4 MB |

## Extending

Add an API route with `route('GET', 'path/{id}', 'Summary', handler)` in the matching `routes-*.js`; it appears on the API page by itself. Add a node type in `model/schema.js`, then draw it (`canvas/render.js`), inspect it (`inspector/inspector.js`) and evaluate it (`model/evaluate.js`). Add a diagnostic in `model/snapshot.js`. See [code-guide.md](code-guide.md) for the file map and the conventions.
