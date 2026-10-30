# MVP behavior audit

Reviewed execution admission and lifecycle, graph evaluation and flow control, editor operations, API routes, storage, UI controls and plugin boundaries. The purpose was to remove hidden policy and unnecessary work from the MVP without weakening data integrity or plugin isolation.

## Changes

| Finding | Result |
| --- | --- |
| Starting was blocked after 16 active workflows | Independent workflows no longer share an admission quota. Each workflow still has one current execution. |
| A graph with more than 200 start events could not run | Removed the root-count quota. Script concurrency, time, depth and result-size safeguards remain. |
| Pause/resume failed if execution finished before the request arrived | Idle and finished executions return their current state. No new execution is created. |
| Polling and controlling execution loaded the editable workflow, merged types and refreshed Library instances | These requests now resolve project/workflow metadata and read only the current execution. |
| An empty execution created a Worker | Empty plans complete without a Worker. |
| Empty port/widget value updates were rejected | An empty values object performs no changes, emits no widget events and adds no undo entry. Invalid node IDs and malformed values still fail. |
| Editing the next graph cleared statuses of the active execution | Active statuses and results stay visible; semantic edits clear old results after execution finishes. |
| A node queued for a concurrency slot could bypass a later Pause | The pause boundary is checked after obtaining the slot, before starting node code. |
| Workflow deletion had a second Library-editor guard behind a project-level guard that already rejected that operation | Removed the unreachable check. |

Empty graphs and graphs without enabled start events remain valid: start, settle the work that actually starts, finish.

## Checks retained

- Project/workflow/node existence, port compatibility, valid bindings and acyclic data dependencies protect graph integrity.
- A second simultaneous execution of the same workflow is rejected; controls may use the execution ID to avoid acting on a newer start.
- Permission checks, secret separation, package/path validation, Worker isolation and storage access checks protect application boundaries.
- Script time, result memory, dependency depth and per-execution Script concurrency are resource safeguards, rather than workflow admission policy.
- Editor hooks (`on_placed`, `on_deleted`, `on_wired`, `on_widget`), explicit `on_run` events and dependency-driven `on_read` retain their defined purposes.
- Library refresh on opening/editing a workflow and installing missing built-in nodes on boot remain existing product behavior. Execution polling no longer invokes Library refresh.

## Further simplification candidates

These affect established graph/package semantics and were left explicit for a separate change:

- `Editor.deleteGroup` also deletes empty ancestor groups without stored positions. Keeping those containers would make deletion more local, but requires preserving their canvas positions.
- `node.emit` falls back to a case-insensitive port-name match. Exact names would be simpler, but existing scripts using `Out` for `out` would need updating.
- The plugin host still adapts version 1 declarative packages. Removing that adapter would reduce code, but would also stop accepting existing version 1 packages.

## Validation

Regression coverage includes 201 start events, 17 concurrent workflows, empty execution, controls arriving after completion, empty value updates, a paused node waiting for a concurrency slot, and editing a graph during a paused execution. The browser scenarios also cover Delay, Stop, canvas latency and workspace navigation.
