# Workflow runtime

Each workflow has one runtime with status `idle`, `running` or `paused`. `idle` means no signal work is active; it does not clear values or destroy the graph. Pausing an idle graph is allowed. Multiple signals and editor events can be active together in the same runtime.

Stop is available while idle and while a Run request is pending. It terminates the current host, including its background timers, and clears the pause gate while preserving JSON data.

## API

- `GET projects/{project_id}/execution?workflow_id=...` reads the selected workflow's runtime.
- `POST projects/{project_id}/execution` signals enabled `on_run` Events. Optional body fields are `workflow_id`, `node_ids`, `payload` and `wait`. `node_ids` signals those nodes directly. `payload` is an object available as `context.event.payload`.
- `wait: true` waits for that call and everything it started, and for the JSON state to be saved. It does not wait on unrelated calls. The response is the runtime plus `dispatch_status` (`completed`, `failed` or `cancelled`), `dispatch_outputs` (the outputs of the signalled nodes by node ID) and `errors`.
- `DELETE projects/{project_id}/execution?workflow_id=...` stops active host work, preserving graph data.
- `POST projects/{project_id}/execution/pause` and `/resume` set the graph's pause gate, selecting `workflow_id` in the body. Acceptance does not require already-running synchronous code to yield.
- `POST projects/{project_id}/evaluate-node` dispatches selected nodes or reads selected values through this same runtime. It returns outputs by node ID, errors, displays and node statuses. With `collect: true`, node failures are returned as data.

The runtime response contains `workflow_id`, `revision`, `status`, `paused`, `active_signals`, `nodes`, `runs` (how many times each node finished or failed since the server started), `activity`, `outputs`, `errors`, `displays` and `state`. `revision` changes when runtime data changes and supports UI synchronization. `activity` retains the last 128 starts as `{sequence, node_id}` so the canvas can show short passes in their actual start order even when updates are coalesced. This transient history and the pass counts are not persisted or replayed when opening a graph.

Node statuses are `ready`, `running` (code), `sleeping` (timer), `waiting` (an explicit awaited branch), `completed`, `failed`, `blocked`, `skipped` and `stopped`. Starting a node clears old terminal states downstream along signal connections, without clearing stored values or interrupting active parallel invocations. Automatic completion leaves its Script marked completed while following nodes work. Overlapping calls keep the node active until its active invocations settle.

The canvas uses white for active work and briefly holds short passes before settling to green (completed) or red (failed). Signal wires animate in the flow direction. The presentation never delays graph execution. Animation-off and reduced-motion preferences show static states.

## Persistence

`workflows/{workflow_id}/runtime` stores JSON `state`, port values, previews and the latest presentation state in the application's key-value store. The server maps this to `data/workflows/{workflow_id}/runtime.json`. There is no browser-only storage mode in the platform client; older IndexedDB data must be exported.

JSON mutations and previews are sent to the host and writes are serialized/coalesced. A call with `wait: true` and Stop wait for outstanding persistence. On restart, active node marks become stopped; no pending calls are replayed. The saved pause gate is retained. Output and preview entries for deleted nodes are pruned.

A failed write keeps the change dirty and is reported as `storage_error`; the next save writes the current state. `wait: true` reports that error instead of rejecting the dispatch. Idle runtimes may be released (see [engine](engine.md)); the saved runtime is what a later read restores.

Workflow/project export includes `document.runtime` with `{state, outputs, displays}`. Import restores it. Duplication copies shared JSON and remaps node IDs in output/preview maps. Execution stacks, live globals, timers and external requests are not exportable graph data. Undo/redo changes the graph definition and does not roll back runtime state or external actions.

Storage failures are reported by awaited requests or in `storage_error`.

## Limits and validation

The live graph interpreter has no configured limits on signal/read chain length, active Script count, Script execution time, individual result size or total graph results. Its values remain subject to available memory, JavaScript serialization and the application's storage and transport.

Stop terminates the graph host, including synchronous code that does not yield. Pause is cooperative: it gates new code and continuations, not arbitrary instructions inside an executing function. A delay accepts a finite nonnegative duration and uses timer-sized chunks internally without an application duration ceiling.

Graph structure must remain valid: existing nodes and ports, compatible wires, acyclic data dependencies and acyclic group/interface bindings. Editor fields, HTTP transport and checked network requests have their own validation. These are separate from graph-interpreter execution quotas. API permission checks and secret separation apply regardless of graph size or elapsed work.

## Using the API

The server exposes JSON endpoints under `/api/`; `/api/openapi.json` is the generated contract. The editor's API page includes a searchable method tree and examples.

Mutation requests require `X-AgentSys: 1`; cookie-authenticated mutations also require an allowed `Origin`. Host validation and bearer/session auth protect the server; non-loopback access requires an API token. The client uses one environment transport rather than a fixed `/api` URL.

The core API covers projects, workflow editing and batches, graph validation and evaluation, live graph signals and controls, Library nodes, generic collections, settings, permissions, secrets and checked network calls. Server plugin routes were removed; a client plugin uses this same API.

See the sections above for Run/Pause/Resume/Stop and [Permissions](permissions.md) for capability checks. `if_cursor` or `If-Match` makes a graph edit conditional on its current cursor. Edit history provides undo/redo for every editing route (nodes, wires, splits, layout, titles, values, types and grants) and is kept in memory per workflow: a restart keeps the document but starts with an empty history. The limit is the `undo_steps` preference (50 by default).

`GET projects/{project_id}/execution` returns the current workflow runtime, including its JSON `state`, outputs and previews. `POST` sends a signal; `DELETE` stops active work. Workflow exports include durable runtime data.

To invoke a signal input of a dynamically placed Custom Node, POST `{node_ids:[node_id],input_port:"in",wait:true}` to that existing execution route. The native interpreter resolves the interface binding, sends and joins a signal wave, then returns that invocation's normal outputs in `dispatch_outputs[node_id]`. No `input_port` preserves the existing Run/evaluation behavior. Library / Graph / Invoke Node wraps this call using implicit current project/workflow context. Placement and data wiring remain separate checked graph edits.

`/api/openapi.json` is generated from the registered routes, their body examples, query fields and capability declarations. User-only `node-permissions/{node_id}` PUT authorizes a standalone Script without changing code or requiring Developer mode.
