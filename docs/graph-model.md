# Graph model

The canonical graph interchange/storage format remains `agentsys.text/1`; Library bundles use version 3.
Projects own workflows. A workflow contains typed ports, nodes, groups, signal/data connections, values,
layout and nested Custom Node interfaces. Shared `graph.js` resolves lookup/bindings; shared `types.js` handles
type rules. Server-only schema/documents/editor/snapshot modules validate edits and construct snapshots.

Client graph mutations go through the API. A workflow cursor supports conditional edits (`If-Match`, conflict
409); a visual position or colour change does not rebuild interpreter semantics. Runtime follows semantic
graph changes and retains its own execution scopes and JSON state. Canvas indexes are presentation caches.

Signals, fan-out, joins, recursion, nested scopes and async Script execution retain their existing behavior.
There is one interpreter, `js/model/executor.js`. Pause gates continuations; Stop aborts worker work and keeps
durable values. See [Engine](engine.md), [Runtime](runtime.md) and graph-format/engine-regression tests.
