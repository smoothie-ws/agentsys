# AgentSys

AgentSys is a node-graph workflow editor that runs in your browser. The site is static files plus a tiny Node server (`server.js`, no dependencies) that keeps everything you build as plain JSON files in the `data/` folder, so you can read and edit them without the site.

You wire nodes together on a canvas and press **Run**. Data flows along wires and is read when needed; what *happens* flows by **signals**: a node with the operation `on_run` starts a chain, and a node with the operation `script` (the only one that runs JavaScript) does something when a signal reaches it. Loops, feedback and "do A, then B" are written with signals and `emit`. Reusable nodes are graphs of such nodes, with event nodes (`on_placed`, `on_wired`, `on_widget`…) that run for each copy.

## Run it

```bash
node server.js        # or: npm start, or double-click start.bat on Windows
```

and open http://localhost:8080 (the front page of the site; click the logo in the editor to come back to it) or http://localhost:8080/editor/ (the editor itself; its pages are real paths such as `/editor/p/<project>/w/<workflow>`, `/editor/resources` and `/editor/settings`, and its files, data and API are reachable under `/editor/` as well; an old `/editor/#/…` address is turned into the path). Opened from a static server or a file, the editor keeps its pages in the URL hash (`#/p/…`) instead. `PORT` and `DATA_DIR` environment variables change the port and the data folder. Opening `index.html` directly (or any static server) still works, but then data stays in the browser (IndexedDB); the first start with the server moves such data into `data/`.

The server also runs the backend as an **HTTP API** (`/api/…`, description at `/api/openapi.json`), so workflows can be run, watched, cancelled and edited by programs, by webhooks and by timers with no page open. See [docs/headless-api.md](docs/headless-api.md) for runs, triggers, project state, export/import and the access rules (`AGENTSYS_TOKEN`, `HOST`, `ALLOWED_HOSTS`).

## Using it

1. Create a project (a project holds several workflows).
2. Open a workflow and add nodes: right-click the canvas and choose **Add** (on an empty canvas there is an **Add node** button). It lists the nodes of the Library. Right-click a node or a group for its own actions.
3. Drag from an output socket to an input socket to connect them. Select nodes and press the group shortcut to make a group with its own inputs and outputs; groups can be saved as custom nodes.
4. Press **Run** (or the play button on the workflow card of the project page). Every `on_run` node fires; its signal runs the Scripts it is wired to, and they read their data inputs through the wires. Results appear on the nodes (`display()`) and in the **Activity** tab.

See the [interface guide](docs/interface.md) for details.

## Nodes, signals and the Script

There are two kinds of flow. **Data** goes along ordinary wires and is read when something needs it; a node keeps its latest result. **Signals** (the built-in type `signal`, dashed wires, rounded triangular sockets) say *do it now*: they carry no data, an output signal goes to **every** wire at once, and the receivers work independently. A signal input takes any number of wires, and signal wires may form loops (data wires may not). The full model is in [docs/signal-engine.md](docs/signal-engine.md).

Nothing ships with the app except providers and skills: the Library of nodes starts empty. The two bricks, Script and Event, are in the Add node menu itself (they are not Library nodes). What a Custom node does is its `op`; the engine knows the ones below. Every other node is a Custom node without an `op` (it holds the values typed into its outputs) or a graph made of nodes with an `op`. A node without signal ports just holds or passes a value (a Reroute passes one on); a node with an `op` runs when a signal reaches it and keeps its latest outputs.

| `op` | what it does |
|---|---|
| `script` | runs the code of its input `script` when its signal input is signalled, then signals its signal output (or when the code calls `emit`) |
| `on_run` | fired by Run (the button, the API, a trigger); the data output it carries is the payload of the trigger |
| `on_placed`, `on_deleted` | fired for a **copy** of the Library node that contains it, when the copy is placed or removed |
| `on_wired` | fired for the copy when its wired inputs change; its data output lists their names |
| `on_widget` | fired for the copy when a person used a widget; its data output is `{id, kind, label, value}` |
| `on_read` | fired for the copy when something outside reads one of its nodes (see below) |

`on_placed`, `on_deleted`, `on_wired`, `on_widget` and `on_read` exist *relative to the Library node they are in*; in an ordinary workflow only `on_run` fires. Which ports a node with an `op` has is up to whoever makes it: the event nodes carry their data on the data outputs they declare (`payload`, `wired`, `widget`).

**The Script.** The only node that runs JavaScript. It has the signal input `In` and the code field, and nothing else: no inputs, no outputs. It works through the Library node it is in. The code gets three variables, and nothing else is named for you:

- `node` — the Library node the Script is in (every access to it is spelled out):
  - `node.input.<name>` — a data input (read once, when the signal arrives; an input nothing is wired to is `undefined`, or its default). `Object.keys(node.input)` lists them; `await node.reread('name')` reads one again: the latest result of the node it comes from (for a loop that watches a value);
  - `node.output.<name> = value` — sets a free data output (any JSON value; a name that is not a free output is an error). Reading `node.output.<name>` gives what it holds now. `return` is not used;
  - `await node.emit('name')` — fires the free signal output `name` now, from the middle of the code, and returns when everything the signal started has finished (an error of a node it started is thrown by `emit`). Nothing is fired when the code ends;
  - `await node.emit('name', {handles: ['break', 'continue'], failFast: true})` — the options are optional: `handles` makes the emit answer `'break'` or `'continue'` when a node below called `node.flow.break()` / `continue()`, `failFast` cancels the rest of what the signal started at the first failure;
  - `node.flow.break()`, `.continue()`, `.cancel()`, `.abort()` — control the flow the node is in (each ends the code of the Script; see [docs/signal-engine.md](docs/signal-engine.md)); `node.cancelled` says whether the flow was cancelled. The loop nodes of `examples/flow-nodes.json` (For, For each, While, Break, Continue, Variable) are made with them;
  - `node.display(value, …)` — shows text or an image on the node (a string as it is, `{mime_type, data}` as an image, anything else as indented JSON; the last call wins);
  - `await node.widgets(list)` / `await node.widgets.set({id: value})` — puts widgets on the node, sets their values;
- `agentsys(method, path, body, query)` — capability-checked methods of the site's own API (see the **API** page); LLM requests are one of them: `const {text} = await agentsys('POST', 'llm', {prompt: '…', provider: 'name', model: '…'})`;
- `context` — `{project_id, workflow_id, node_id, instance_id, widgets, event}`, plus `run_id`, `trigger`, `payload` in runs started through the API. `instance_id` is the Library node (copy) the Script is in, or `null`; `widgets` are the values of the widgets of the Library node (those of its nodes together), or of the Script itself; `event` is the data of the event nodes beside the Script (`payload`, `wired`, `widget`). In `agentsys` calls on its own project (`projects/<project_id>/…`) `workflow_id` is filled in for you.

```javascript
// a loop is plain code: set the free output `i` of the Library node and fire its free signal output `step` five times
for (let i = 0; i < 5; i++) {
  node.output.i = i;
  await node.emit('step');
}
```

`node`, `agentsys` and `context` are variables of the code, not globals: a function you write that needs them is given them as arguments. Everything else is standard JavaScript (waiting: `await new Promise(r => setTimeout(r, ms))`).

**How a run works.** **Run** fires every on_run node (or the nodes you name in `evaluate-node`; a Script is executed once as if signalled, a node that is only a value is read). The run is compiled into a plan (plain data: every wire already resolved through the Complex Nodes, every default in place) and carried out in one Web Worker (one worker thread on the server). The signal goes along its wires; Scripts that are reached run, up to 16 at a time (one waiting in `emit` takes no place); a value that crosses from one node to another is copied for every reader. A run lasts until nothing is running. A Script's own code may take 120 s (not counting the wait in `emit`); a chain of more than 1000 signals one after another stops with an error; a script that never lets go is ended by the page. A signal that reaches a Script that is still running starts another execution at once, so keep that from happening in the graph. Hooks (on_placed and the others) run after the change is saved, so they can call the API; if one fails, the change stays and the error is listed at `GET /api/node-hooks` and shown as a message. [docs/engine-design.md](docs/engine-design.md) has the details.

**Library nodes.** A Library node is a graph of Scripts and event nodes: a group with its own inputs and outputs, edited in the Library, and placed as one node. There is nothing hidden in it: every node is on the canvas of its editor. A slot of the group is **bound** to a port of a node inside (drag from its dot to the socket), or it is **free**: then any Script of the node reads it by name with `await read('name')`, and finds all the names in `context.inputs`. A node inside the group is part of its *unit*: Scripts and event nodes belong to the closest Library node around them. Its inside may contain event nodes (on_placed, on_wired…) that run for each copy, and Scripts that change the copy (`agentsys('PUT', 'projects/<id>/node-slots/' + context.instance_id, {inputs})` sets its slots).

**Reading.** A Library node that has an **on_read** inside computes its value when it is read: the first read fires the on_read and waits until the chain it starts has finished (so a node that has not been computed can never be read); later reads give the same result. When something the node read has changed (a node outside it that it reads gave a different result, found from the left to the right through its inputs), the next read computes it again; a result that is the same as before does not disturb anything further on. A node that gives `condition ? a : b` is an `on_read` node whose signal goes to a Script that returns it. Reading a node from inside its own computation is an error (a cycle) for now.

**Widgets.** A node **declares** its widgets (`config.widgets`: the **Widgets** list in the Properties of a node in the Library editor, or `widgets` in the config sent to `typed-nodes`). A Library node placed on a workflow shows the widgets of the nodes inside it: a list of `{id, kind, label?, value?, …}`. Every copy has them from the start (the Script itself is where they belong); when the list changes, the widgets that stay (same ID and kind) keep the value typed into them and the others come or go. The kinds: `text`, `textarea` (`rows`), `number` (`min`, `max`, `step`), `checkbox`, `select` (`options`: values or `{value, label}`), `range` (`min`, `max`, `step`), `button` (its value counts the clicks), `label` (`text`), `markdown` (`rows`: the value is Markdown text, shown rendered; a double click or Enter opens the textarea, Escape or leaving it shows the text again; headings, emphasis, code, quotes, lists, task items, tables and http(s)/mailto links, no raw HTML and no images), and `html` (`html`, `height`: shown in a sandboxed frame without access to the page; its script may call `parent.postMessage({value}, '*')` to set the widget's value; the frame is reloaded when the node is redrawn). A widget holds any JSON value. A person's edit sets the value and fires on_widget; a value set by code (the API) does not. A Script reads the values from `context.widgets`, and can put widgets on, or read and change the widgets of, any node through `PUT projects/<id>/widgets/<node>` (`{widgets: [...]}` or `{values: {id: value}}`). Widgets travel with their node (copy, paste, duplicate, export and import).

**Slots.** A data input takes one wire (a new wire replaces the old one); a signal input takes any number. To take several values, use one input for each, or wire an array. Slots are `{id, name, type?}`, an input may have a `default`, and an output of a type with a control may be `editable: true` (with a `default`): the node then shows the control on the output (Value nodes need nothing else), and what is typed there (`PUT projects/<id>/output-values`, `{node_id, values: {output ID: value}}`) is the output while nothing sets another; the Script finds it already in `output`. The Properties of a Script (or any other plain node) list its inputs and outputs: add, rename or remove them there. In the Library editor, **Arbitrary** next to Inputs or Outputs lets a node placed on a workflow add free slots of its own by hand in the side panel (a Script of the node reads them by name). A node whose inputs follow its wires leaves **Arbitrary** off, so only its code manages them. The *Enabled* switches of the Library decide which nodes the Add menu offers; placed nodes keep working when their source is switched off.

**Types.** `any` and `signal` are built in: there is no `text` or `number` until you define one. A workflow defines its own types (the **Types** section of the Workflow tab of the side panel, or `PUT projects/<id>/types`): a name, a color and named fields, each field with a type of its own (or none). A type with no fields is just a named kind, such as `Text`; it may have a `control` (`text`, `textarea`, `code` (a textarea with syntax highlighting), `number`, `checkbox`, or `select` with `options`: an enum shown as a combobox). A type may also be an `alias` (`t:<id>`) of another type instead of having fields: it keeps its own name, color and control (otherwise it inherits the target's) and is fully compatible with the target in both directions (`Script` = alias of `Text` with control `code`). A free input of such a type shows the control on the node, and the value typed there is the `default` of the input (`PUT projects/<id>/input-values`). A slot's type is optional: `t:<id>` for a type, or `any` (the same as leaving it out). Types only decide what may be wired to what: a type with fields fits another when it has all of its fields, a named kind fits only itself, `any` fits everything except a signal, a signal fits only a signal, and sockets and wires take the color of the type. The engine never reads types and checks no value. The types of a workflow are the **Library types** (read-only in a workflow, never stored in it) plus its own `types`. The Library types are the ones the Custom Nodes of the Library define: saving a node adds the types its bundle carries to the Library (`library/types.json`), a type with the name and shape of one the Library has is that type, a changed definition is the Library's for everybody, and a type no node defines and no workflow uses goes. A Library type is changed in a node's editor (`PUT projects/lib-<id>/types`); from a workflow it is read-only. A Library node's bundle carries the definitions of its types: placing or pasting it matches them by ID, then by name and shape in the Library, and otherwise adds them to the workflow as its own.

**Code changes the graph.** `agentsys()` reaches every call of the API, so code can create, edit, connect and delete nodes. The canvas and the side panel follow every change. The layout is part of the same API: `PUT projects/<id>/layout` moves and resizes nodes, and `PUT projects/<id>/node-style` sets the color, pins, folds (`folded`) or disables (`disabled`: a run skips the node; on a group, everything in it) a node or group.

**What is still limited.** Only what keeps the page and the machine safe: the 120 s time limit of a Script's code, at most 16 Scripts running their code at once, a chain of 1000 signals, the size of a node's result (20 MB) and of a run (100 MB), at most 1000 nodes per workflow, 256 types, 256 slots and 100 widgets per node, data wires may not form a cycle, and a wire has to join slots whose types fit.

Nodes of any other type found in a saved document are dropped, together with their wires.

## Data

Data is stored as readable JSON and skill Markdown files in `data/` (changed files are picked up while the site is open):

| File | Content |
| --- | --- |
| `settings.json` | preferences, theme, shortcuts |
| `projects.json` | projects and the list of their workflows |
| `workflows/<id>.json` | one workflow's graph |
| `library/resources.json` | providers, Custom Nodes and skill catalog metadata |
| `library/skills/<name>/SKILL.md` | standard YAML frontmatter and Markdown instruction |
| `library/skill_folders.json` | groups of the skill tree |
| `library/node_folders.json` | groups of the Custom Node tree |
| `last-runs/<workflow>.json` | the canvas summary of the last run of a workflow, shown again when it is opened |
| `meta.json` | counters |
| `other/<key>.json` | the small keys with no file of their own: Custom Node group icons, the built-ins flag, `triggers`, `state__<project>` (project state), capability policies and run/approval indexes |

Custom Nodes and workflows are saved automatically with immutable content versions. Controller shows history, file diffs and restoration. Tabs of the graph editors you opened are remembered in the browser.

## Layout

```
index.html        page shell and the ordered list of scripts and styles
server.js         static files, the data folder (/__data), the HTTP API (/api), webhooks, the scheduler
headless.js       loads storage/model/backend into Node (used by server.js and the tests)
css/              styles, one file per area (tokens → controls → shell → pages → overlays → canvas → inspector)
js/storage/       IndexedDB store and shared SKILL.md format
js/model/         pure graph logic: schema, snapshot, documents, Editor, evaluation
js/backend/       the API (in the browser, and in Node for the server): request plumbing, routes-*.js (runs, triggers, state, export/import among them), scripts worker, resources
js/app/           app shell: helpers, dialogs, menus, shortcuts, router, sidebar and second panel
js/pages/         home, project, settings, Library and API pages
js/canvas/        the workflow canvas, split by concern (hints.js: snapping and the key hints)
js/inspector/     the right-hand Properties panel
builtin/          providers (.json), skills (SKILL.md): Library items imported on the first run
tests/            API tests (node --test) and a browser smoke test
docs/             interface guide, code guide, architecture, headless API, testing
```

New to the code? Start with [docs/code-guide.md](docs/code-guide.md). Tests: [docs/testing.md](docs/testing.md).

## Developer mode

Settings > Editing > *Developer mode* (off by default). Off: Custom nodes cannot be made or edited by hand, neither in a workflow nor in the Library (no *New node*, *Edit graph* or *Duplicate*). The API refuses `typed-nodes` writes and `library/node-editor` with `developer_mode_required` (403). Importing, exporting, placing (the Add menu) and running Library nodes, moving, coloring and wiring nodes, and typing values keep working. `PUT settings {developer_mode: true}` turns it on.

## Autonomous controller

**Controller** in the sidebar shows Initiatives, task trees, decisions, pending human approvals, durable runs, traces, replay, graph warnings and version history. Under `node server.js`, browser requests use the server API, so closing the tab leaves a run alive.

- `await node.wait({event:'ready',match:{id:42}})`, `{delay:1000}`, `{until:'2026-11-01T00:00:00Z'}` or `{approval:{question:'Proceed?'}}` saves a checkpoint and terminates the Worker. The resumed Script starts at its beginning with `node.resumed={key,value}`. Code before the wait must be idempotent; use `node.runKey` for external idempotency keys.
- Scripts declare capabilities and grants; workspace policy limits both. Missing manifests grant nothing. AI-authored nodes require code review before elevation. [Permissions](docs/permissions.md).
- Model calls share budgets and record attempts, usage and redacted blobs. [AI primitives](docs/ai-primitives.md).
- A managed **Initiative** contains tasks, decisions, artifacts and facts, backed by an append-only journal. [Initiatives](docs/initiatives.md).
- Graphs use [canonical text files](docs/format.md), [immutable versions](docs/versioning.md) and [offline replay](docs/replay.md). [Graph versus code](docs/graph-vs-code.md) explains orchestration boundaries and advisory linting.

Examples: `wait-nodes.json`, `initiative-nodes.json`, `ai-nodes.json`, `planner-task-runner.json`, `code-step.json` in `examples/`. JSON downloads are transport envelopes containing canonical files; neighboring example directories expose the individual source files. `builtin/` still contains only providers and skills.

New data: `runs/<id>.json`, `runs/<id>/checkpoint.json`, `runs/<id>/events.json`, `initiatives/<id>/...`, `approvals/<id>.json`, `versions/...` and `blobs/<hash>.json`. Workflow/catalog JSON stores graph structure; neighboring `.files/layout.json` and `.files/scripts/*.js` store positions and code. `node --test` includes deterministic graph fixtures; quality evals run separately with `node evals/run.cjs`.
