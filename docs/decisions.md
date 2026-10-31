# Architecture decisions

1. A workflow is a live graph with one runtime and persistent JSON values. Run sends ordinary signals to enabled `on_run` Events.
2. Nodes are interpreted as reached. Graph edits update subsequent invocations, input rereads and emissions. An invocation already executing retains its current function.
3. Script and Event are the behavior primitives. Library graphs compose them into Custom Nodes, branches, loops, delays and previews.
4. Signals control work; data wires provide JSON values. Fan-out is concurrent, and an awaited emission joins its branches. Dispatches have separate ownership of their child work.
5. Script has signal input `in`, code input `script` and completion output `out`. Success emits `out` automatically. Named signal outputs use `node.output.name.emit(options?)`; names are exact.
6. `context.state` is shared durable JSON. Run, Pause, Stop, navigation and restart preserve it. Port values and previews are also durable. JavaScript globals are host-local memory.
7. Pause gates code starts and continuations. Stop interrupts host work and preserves data. Restart restores data without resuming JavaScript stacks or external operations.
8. Ordinary execution has no configured depth, concurrency, time or result-size quotas. Controlled runs can opt into inherited admission/time budgets; diagnostics have bounded retention. Valid structure, JSON data and permission checks remain requirements.
9. Each workflow's JavaScript host is isolated. Script calls are checked against current enclosing-instance grants and project policy. Library defaults initialize new instances only. Code written through APIs is quarantined.
10. The core provides general graph, resource, storage and UI mechanisms. Domain schemas, AI and integrations belong to executable plugins.
11. Plugin metadata describes loading and permissions. `activate(context)` registers behavior and owns its cleanup. Plugins use isolated hosts and sandboxed views.
12. Import/export and duplication carry graph JSON state and values. Editor undo history covers definitions, not runtime state or external side effects.
13. Durable operation boundaries use explicit versioned checkpoints and retry policies. A restart marks unfinished work interrupted and never reconstructs JavaScript stacks or automatically replays external effects. High-level orchestration lives in a universal SDK library.
14. Independent JSON areas and operation metadata share the application's storage/CAS boundary. They supplement shared `context.state`; they do not transact arbitrary JavaScript or replace latest-value ports. Structured traces contain metadata only.
