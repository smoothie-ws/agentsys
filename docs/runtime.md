# Execution

A workflow has one current in-memory execution. Its lifecycle is `idle -> running -> completed`, `failed` or `stopped`. While active it may switch between `running` and `paused`.

## API

- `POST projects/{project_id}/execution` starts the selected workflow. Optional body fields: `workflow_id`, `node_ids`, `payload`, `wait`. With `wait: true`, the response waits for completion; otherwise it immediately returns the current execution.
- `GET projects/{project_id}/execution?workflow_id=...` reads its current state and transient node results.
- `DELETE projects/{project_id}/execution?workflow_id=...` stops it.
- `POST projects/{project_id}/execution/pause` and `/resume` control it, selecting `workflow_id` in the body.
- Pause, resume and stop of an idle or finished workflow return its current state without an error.
- An optional `id` guards control or polling against a newer execution of the same workflow.
- `POST projects/{project_id}/evaluate-node` evaluates selected nodes and returns outputs directly.

Without `node_ids`, explicit start fires every enabled `on_run` Event. No start event is required: if nothing starts, execution completes immediately. Independent workflows may execute concurrently. A second start for an active workflow returns a conflict.

The current state contains its status, node statuses, displays, outputs and errors. A new start replaces the previous state. No execution records or events are written to disk, and restarting the server does not resume work.

Delay uses an in-process timer through `node.sleep`; waiting does not mark the graph completed. Pause/resume and Stop remain available while it waits. There are no external event waits.
