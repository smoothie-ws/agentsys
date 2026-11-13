# Design decisions

1. A workflow is a live graph with one runtime and persistent JSON values. Run sends ordinary signals to enabled `on_run` Events.
2. Nodes are interpreted as reached. Graph edits update subsequent invocations, input rereads and emissions. An invocation already executing keeps its current function.
3. Script and Event are the behavior primitives. Library graphs compose them into Custom Nodes, branches, loops, delays and previews.
4. Signals control work; data wires provide JSON values. Fan-out is concurrent, an awaited emission joins its branches, and a signal call owns the work it started.
5. Script has signal input `in`, code input `script` and completion output `out`. Success emits `out`. Named signal outputs use `node.output.name.emit(options?)`; names are exact.
6. `context.state` is shared durable JSON. Run, Pause, Stop, navigation and restart preserve it, and so do port values and previews. JavaScript globals are host-local memory.
7. Pause gates code starts and continuations. Stop interrupts host work and keeps data. A restart restores data without resuming JavaScript stacks or external effects.
8. Execution has no depth, concurrency, time or result-size quotas. Valid structure, JSON data and permission checks always apply. Stop ends runaway code.
9. Each workflow's JavaScript host is isolated. Script calls are checked against the enclosing instances' grants and the project policy. Library defaults only initialize new instances. Code written through the API is quarantined.
10. Import/export and duplication carry graph JSON state and values. Undo covers definitions, not runtime state or external effects.
11. Inline Custom Node compositions without a Library source belong to their workflow and can be expanded, collapsed and edited through the checked graph API. Linked Library instances are edited in the Library.
12. Graph self-modification is a general capability (the checked API and the Graph nodes), not a feature of any one algorithm. The core contains no domain schemas, schedulers or controllers.
13. Extensions are plugins in the manner of Substance Painter: a folder with `main.js`, `start(api)` and `stop()`, trusted and unsandboxed, loaded by the server. The core has no domain features; a plugin adds them through the same API the editor uses.
14. A plugin can extend the interface through an optional `client.js` in the manner of a VS Code extension: it runs in the page and registers pages, commands, toolbar and sidebar entries, menu items, dashboard cards and styles through `api.ui`. Registrations are declarative from the page's point of view and are removed with the plugin; the interface host, not the plugin, owns the shell and its lifecycle.
