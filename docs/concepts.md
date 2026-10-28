# Concepts

## Projects and workflows

A **project** holds **workflows**; a workflow is one graph. A graph document is `{nodes, layout, style, groups, complex, port_edges, widgets, types}`. Projects also hold a workspace permission policy ([Permissions](permissions.md)).

A workflow is not a process. It is *graph + durable state + queues*; the work happens in short **activations** (ordinary runs started by the Run button, the API, a timer, a webhook or a queue item). Nothing stays alive between activations; what must survive lives in `node.state` and queues ([Runtime](runtime.md)).

## Nodes

There are only two kinds of building block, and everything else is made from them:

- **Script** (`op: script`) — runs code when its `In` signal arrives. The code is the only place where logic lives.
- **Event** — an event source with one signal output: `on_run`, `on_read`, `on_placed`, `on_deleted`, `on_wired`, `on_widget`. Which one is chosen on the node.

Plus structure: a **Reroute** (a point on a wire), **groups** (visual frames) and **Complex Nodes** (a group with an interface: slots bound to ports inside).

A **value node** has no op and no signal ports; it only holds values typed on its outputs.

## Wires and types

- **Data** wires carry the *latest result* of a node, read on demand. An input takes one wire and has a typed default if unwired.
- **Signals** mean "do it now" and carry no data. An output signal goes to every wire at once; an input signal accepts any number of wires. Signal wires may form loops; data wires may not.
- **Types** only decide what may be wired to what: `any` is built in, everything else is defined by the document (shapes, enums, controls). Types never affect running.

## The Library

The Library is a set of sections (today one, **Nodes**, at `/resources/nodes`; the page `/resources` shows the sections as cards and the second panel holds the section with its groups and nodes). Nodes are **Custom Nodes**: reusable Complex Nodes made in the Library editor (a private workflow `lib-<id>`) and kept in groups (folders). A placed copy is a locked, collapsed node in a workflow that follows the Library definition; it can only be changed in the Library. Copies fire `on_placed`, `on_deleted`, `on_wired`, `on_widget`, `on_read` for themselves.

Creating and editing Custom Nodes by hand needs **Developer mode** (Settings). With it off, nodes can still be imported, exported, placed and run.

Nothing ships with the app: every node a person uses is made from Script and Event. Example catalogs are in `examples/` (`basic-nodes`, `flow-nodes`, `wait-nodes`, `stream-nodes`; import them from the Library).

## Widgets

A node can show widgets (text, textarea, number, checkbox, select, range, button, label, html, markdown). A person's change reaches the node and fires `on_widget`.

## Data on disk

With the server every key of the store is a file under `data/` (readable UTF-8): workflows as canonical text (`graph.json`, `layout.json`, `scripts/*.js`), runs under `runs/<id>/`, state under `workflows/<id>/state/`, queue journals as JSON Lines. The canonical format is `agentsys.text/1`: object keys sorted, collections ordered by id, script source in real `.js` files; moving a node changes only `layout.json`, editing code only the `.js` file (`TextGraph.encode/decode` in `js/storage/format.js`; `examples/format-example/`).
