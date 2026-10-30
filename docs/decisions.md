# Decisions

These MVP decisions supersede the earlier autonomous workflow design.

1. The core is a general graph editor and executor. AI resource definitions, model behavior and integrations belong to plugins.
2. Execution is explicit: start, execute the graph, finish or stop. Pause/resume is available at safe execution boundaries.
3. The graph is captured at start. Edits affect the next execution. Undo/redo remains an editor feature.
4. Signals control execution; data wires supply values. Signal fan-out may run independent branches concurrently, and an awaited emission joins its branches.
5. Script and Event are the engine primitives. Custom Nodes implement reusable graph behavior, including branches and loops.
6. The current execution is transient. There is no persisted history, scheduler, retry supervisor, durable waiting, queue system, checkpoint, live patching or replay.
7. Each execution uses a fresh isolated Worker. Library defaults initialize new instances; instance permissions and project policy constrain actual API calls. There is no Library declaration gate. Script-created code is quarantined.
8. Plugins activate imperatively, register their extensions through the public API and release owned resources on deactivation. Manifests describe metadata and loading requirements.
9. The Library host supplies generic collections, forms, folders, typed JSON data and credential storage. Plugins supply their domain schemas.
10. The built-in AI plugin owns Provider configuration, model discovery and the Provider/Model/Ask graphs. The core has no AI-specific format, resource or migration.
11. Removed subsystems are deleted together with their UI, APIs, obsolete tests and examples.
