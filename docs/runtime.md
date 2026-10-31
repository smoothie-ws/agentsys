# Workflow runtime

Each workflow has one runtime with status `idle`, `running` or `paused`. `idle` means no dispatched signal work is active; it does not clear values or destroy the graph. Pausing an idle graph is allowed. Multiple signals and editor events can be active together in the same runtime.

Stop is available while idle and while a Run request is pending. It terminates the current host, including its background timers, and clears the pause gate while preserving JSON data.

## API

- `GET projects/{project_id}/execution?workflow_id=...` reads the selected workflow's runtime.
- `POST projects/{project_id}/execution` signals enabled `on_run` Events. Optional body fields are `workflow_id`, `node_ids`, `payload` and `wait`. `node_ids` targets nodes directly using the same dispatch mechanism. `payload` is an object available as `context.event.payload`.
- `wait: true` waits for that dispatch and its descendants and for their JSON state to be saved. It does not wait on unrelated dispatches. Errors are reported in runtime state.
- `DELETE projects/{project_id}/execution?workflow_id=...` stops active host work, preserving graph data.
- `POST projects/{project_id}/execution/pause` and `/resume` set the graph's pause gate, selecting `workflow_id` in the body. Acceptance does not require already-running synchronous code to yield.
- `POST projects/{project_id}/evaluate-node` dispatches selected nodes or reads selected values through this same runtime. It returns outputs by node ID, errors, displays and node statuses. With `collect: true`, node failures are returned as data.

Execution POST responses additionally identify `run_id`, `dispatch_id`, parent dispatch/invocation and graph revision. `wait:true` returns that dispatch's status/errors/root results. GET `execution/dispatches/{id}` reads its durable record; `/trace` filters retained metadata. Optional `/scopes` and `/operations` supply versioned independent JSON and explicit checkpoint/retry boundaries. `policy` opts a dispatch into inherited budgets. See the complete [durable execution contract and examples](durable-execution.md).

The runtime response contains `workflow_id`, `revision`, `status`, `paused`, `active_signals`, `nodes`, `outputs`, `errors`, `displays`, `state` and `evaluated_nodes`. `revision` changes when runtime data changes and supports UI synchronization. `evaluated_nodes` is the workflow's retained count of completed invocations; it is presentation data.

Node statuses are `running` (code), `sleeping` (timer), `waiting` (an explicit awaited branch), `completed`, `failed`, `blocked`, `skipped` and `stopped`. Automatic completion leaves its Script marked completed while following nodes work. Overlapping calls keep the node active until its active invocations settle.

## Persistence

`workflows/{workflow_id}/runtime` stores JSON `state`, port values, previews and the latest presentation state in the application's key-value store. The Node server maps this to `data/workflows/{workflow_id}/runtime.json`. Browser-only deployments use IndexedDB.

JSON mutations and previews are sent to the host and writes are serialized/coalesced. Dispatches requested with `wait: true` and Stop wait for outstanding persistence. On restart, active node marks become stopped; no pending calls are replayed. The saved pause gate is retained. Output and preview entries for deleted nodes are pruned.

Workflow/project export includes `document.runtime` with `{state, outputs, displays}`. Import restores it. Duplication copies shared JSON and remaps node IDs in output/preview maps. Execution stacks, live globals, timers and external requests are not exportable graph data. Undo/redo changes the graph definition and does not roll back runtime state or external actions.

`workflows/{workflow_id}/executions` stores a CAS-versioned execution journal in the same database. It retains bounded trace/dispatch metadata and user-managed operation checkpoints/areas. Restart marks unfinished operations interrupted without starting a Worker. Copies/imports start new execution histories. Runtime JSON and the execution journal are separate durability boundaries; storage failures are surfaced by awaited requests or `storage_error`, never acknowledged as a successful checkpoint.
