# Engine

How a graph is executed. The contract the code in `js/model/` (`evaluate.js`, `executor.js`) is written against.

## Why signals

Loops, feedback, recursion and "do A, then B" need explicit flow of control. **Data** flows by wires and is read when needed; **doing** flows by **signals**.

## The model

- A node keeps its **latest result**. A data input is read when something runs and needs it.
- A **signal** has no data. An output signal goes to every wire at once; receivers work independently, in parallel. An input signal accepts any number of wires; any of them triggers it.
- **Value nodes** only hold typed values. **Running nodes** (Script, Event) act when a signal reaches them and keep their latest outputs; reading one gives that.
- A node that *does* something has signal ports; a node that *gives* something has an `on_read`.
- Code lives only in the Script. A Library node is a graph you can open and read.

## Events

| op | fired by |
|---|---|
| `on_run` | a run (Run button, API, trigger); data output carries the trigger payload |
| `on_placed`, `on_deleted` | placing / removing **a copy** of the Library node that contains it |
| `on_wired` | the copy's wired inputs changing; data output lists their names |
| `on_widget` | a person using a widget of the copy; data output is `{id, kind, label, value}` |
| `on_read` | something outside the copy reading one of its running nodes |

Except `on_run`, events exist relative to the Library node they are in and never fire in an ordinary workflow. Hooks (`on_placed`…`on_widget`) run after the change is saved; the thing that runs is the graph: the event node and everything its signal reaches. Failures are listed by `GET node-hooks` and shown as a toast.

## The code of a Script

Three variables: `node`, `agentsys(method, path, body)`, `context`.

- `node.input.<name>` — data inputs of the Library node the Script is in, read once when the signal arrives. `await node.reread(name)` reads again.
- `node.output.<name>` — sets a **free** data output (one no inner node feeds). Unset outputs keep their value. Setting anything else, or a non-data value, is an error. `return` is not used.
- `await node.emit(name, {handles, failFast}?)` — fires a free signal output now and returns when everything it started has finished. Errors of started nodes are thrown by `emit`. Nothing fires when the code ends.
- `node.flow.break() / continue() / cancel() / abort()` — control the flow; each ends the Script's code (do not swallow it: a `catch` must rethrow errors with `.control`). `break`/`continue` go to the nearest `emit` that lists them in `handles`, which then answers `'break'` / `'continue'`. `cancel()` cancels the flow of the emit above; `abort()` ends the whole run. `node.cancelled` tells a long code to stop.
- `node.display(...)` — shows text or an image (`{mime_type, data}`) on the node; the last call wins.
- `node.widgets([...])`, `node.widgets.set({...})` — put widgets on the node / set values.
- `node.wait(spec)`, `node.resumed`, `node.runKey` — durable waiting ([Runtime](runtime.md)).
- `node.state`, `node.queue(name)` — durable state and queues ([Runtime](runtime.md)).
- `context` — `{project_id, workflow_id, node_id, instance_id, widgets, event?, run_id, trigger, payload}`.

A Script outside any Library node has no inputs or outputs; it can display, call the API and put widgets.

A signal reaching a Script that is still running starts another execution at once: prevent it with the graph.

## Reading (`on_read`)

A **scope** is a placed Library node containing an `on_read`. When something outside reads a running node inside:

1. If the scope has a result it can still trust, the read gives it.
2. Otherwise the scope is **freshened**: its dependencies (nodes outside that its inside reads) are freshened left to right, then `on_read` fires and the read waits until everything the signal started finishes.

A result is trusted until a dependency gives a *different* result than the scope saw (a change that makes no difference stops there). So each node of a connected graph is computed once per change. An error is the result of the read until a dependency changes. Reading a node that is being computed is a cycle and an error.

## Runs

A run is a set of **starts** (event nodes to fire) and the work they cause; it lasts until nothing is running. Without node ids it fires every `on_run`. A run is compiled into a **plan**, executed in one Web Worker (worker thread on the server), isolated from other runs. Independent inputs are read at the same time; each node runs once per read; cycles and over-long chains are errors. Limits are listed in [Limits](limits.md).

## The plan is live

The graph is interpreted, not compiled once: a running workflow picks up edits without a restart.

1. The executor finds a node and its wires in the plan **when the node starts**.
2. After a document commit the backend builds a plan delta (only touched nodes are rebuilt) and delivers it to active Workers; no page is needed.
3. A node that started finishes on the version it started with; the next signal sees the new one. The target of a signal is resolved at `emit`; a deleted target is skipped with `node_removed`.
4. A **node version** is the SHA-256 of its canonical executable content; it is recorded in the node's start event.
5. Read caches track node versions: a change inside a scope invalidates it.
6. A checkpoint stores `graph_ref` and `node_versions`; resume uses the *current* graph. A waiting node whose version changed restarts on the new version; a removed one is skipped.
7. Permissions are checked at node start, against the current version.
8. A node with a diagnostic (a broken edit) stays out of the plan; reads of it get `{err}`.
9. Related edits go in **one batch** (`POST projects/{id}/batch`): one document transaction, one plan patch. Half-wired graphs are never visible to a running workflow.
