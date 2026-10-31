# Concepts

A project contains workflows. Each workflow is a graph document with nodes, typed ports, wires, layout, groups, Custom Node interfaces and widgets. Project policy constrains checked API access.

A workflow is a live graph with persistent values, previews and a shared JSON context. Run signals its enabled on_run Events without clearing state. Pause gates continuations, Resume releases them, and Stop cancels active work while keeping JSON values. State survives application restart; active JavaScript tasks do not.

Script runs JavaScript when signalled. Event starts a signal chain on a Run signal, on a data read or for a Library copy's placement, deletion, wiring or widget interaction. Values are read through data wires; signals carry control without a payload. Reroutes and visual groups organize the graph; a group with an interface becomes a reusable Custom Node.

Library / Nodes contains reusable graphs, edited in private Library workflows. The built-in catalog supplies values, branches, loops, flow control, Delay and previews. More examples live in examples/. Developer mode enables editing primitive definitions; ordinary users can place and configure Library nodes.

Plugins add their own typed JSON collections and behavior through the application API. The bundled Provider collection belongs to its plugin. The core supplies shared presentation, CRUD and credential storage.

The canonical file format is agentsys.text/1. Graph data, layout and script files are separated so a position change touches layout and a code edit touches its script file. The Node server stores these files under data/; static deployments use browser storage.

Optional execution infrastructure adds causal run/dispatch/invocation identities, versioned JSON areas, metadata history, operation checkpoints and controlled-run budgets. These do not change shared state or wire semantics. Explicit checkpoint policies determine what can retry after interruption; no JavaScript stack or external effect is replayed automatically. See [Durable execution](durable-execution.md).
