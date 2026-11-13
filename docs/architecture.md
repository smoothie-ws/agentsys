# Architecture

## Concepts

A project contains workflows. A workflow is a graph document: nodes, typed ports, wires, layout, groups, Custom Node interfaces and widgets. The project's policy limits which checked API calls Scripts may make.

A workflow is live: it keeps values, previews and a shared JSON context. Run signals its enabled `on_run` Events without clearing state. Pause gates continuations, Resume releases them, Stop cancels active work and keeps the JSON values. State survives a restart; running JavaScript does not.

Script runs JavaScript when signalled. Event starts a signal chain on Run, on a data read, or when a Library copy is placed, deleted, wired or used. Values travel on data wires; signals carry control and no payload. Reroutes and groups organize the graph; a group with an interface becomes a Custom Node.

The Library holds reusable graphs, edited in private Library workflows. The built-in catalog has values, branches, loops, flow control, Delay, previews, the Data nodes (Template, Parse JSON, Stringify JSON, Get State, Set State) and the Graph nodes (Add Node, Remove Node, Connect, Get Nodes, Find Library Node, Set Input, Invoke Node). Developer mode lets you edit primitive definitions; everyone can place and configure Library nodes.

Plugins extend the application without touching the core: see [plugins](plugins.md).

The canonical file format is `agentsys.text/1`: graph data, layout and script files are separate, so moving a node touches only layout and editing code touches only its script file. The server keeps them under `data/`.

## How it fits together

AgentSys is a live graph programming environment. Nodes, typed ports and connections are the program. The graph owns execution, dependencies and state; the canvas is the main workspace.

`js/model` owns graph validation, editing and interpretation. Script runs JavaScript when signalled; Event emits signals for Run, reads and editor interactions. The interpreter follows the current connections; it never compiles an execution plan. An awaited emission joins its branches; independent dispatches overlap. Live edits affect subsequent invocations. Pause gates continuations; Stop terminates the workflow Worker and cancels checked network calls.

A Custom Node wraps a group with an input/output interface; bindings connect its ports to inner nodes, and Custom Nodes nest. Library resources store reusable graph definitions; placed instances keep their own configuration. Plain groups organize the canvas and do not change execution.

Scripts read `node.input`, write `node.output`, emit named signals and use `context.state` for shared JSON. `agentsys(method, path, body, query)` calls the checked application API the editor uses, so a graph can add, connect, remove, inspect and invoke nodes (the Library's Graph nodes). Loops, branches, recursion and macros are compositions of these mechanisms.

`js/backend` serves graph, project, Library and execution operations. Each workflow has one live interpreter in an isolated Worker. The server runs the backend in Node; the editor talks to it over `/api`. Nothing is replayed after a restart: JSON data comes back, running JavaScript does not.

`js/storage` is the single persistence boundary. Definitions, layout and script sources use `agentsys.text/1`; runtime JSON (shared state, port values, previews) is stored beside them. Version checks guard concurrent writes. JavaScript stacks, globals, timers and pending external work are not persisted.

Plugins are folders in `data/plugins/` with a `main.js` (`start(api)`, `stop()`) and optionally a `client.js` that extends the interface. The server loads `main.js` into its own process: trusted code that can add Library nodes, register API routes and observe changes. The page loads `client.js` into the browser: trusted code that adds pages, commands, toolbar buttons, menu items and styles through the official `api.ui` tools. The core does not depend on any plugin; see [plugins](plugins.md).

Calls a Script makes to the API need both the enclosing instances' grants and the project policy. Workers have no direct network or storage access, generated code is quarantined, credentials stay behind checked host operations, and late writes after Stop or deletion are rejected.

Details: [engine](engine.md), [runtime](runtime.md), [permissions](permissions.md), [plugins](plugins.md), [building an LLM controller](llm-controller.md).
