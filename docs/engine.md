# Engine

Execution is explicit: start a workflow, execute its graph, then finish or stop. A workflow has at most one active execution. Each start captures the current graph into an execution plan and uses a fresh isolated Worker. Edits made during execution take effect on the next start.

## Data and signals

Data inputs read their connected values when a node needs them. Pure value nodes and Reroutes are computed on read. Running nodes keep their latest output values within the current execution. Values crossing node boundaries are copied as JSON.

Signals carry no data. A signal starts every connected receiver; independent branches may execute in parallel. `await node.emit(name)` waits for all work started by that emission. Nothing is implicitly emitted when a Script returns. Execution ends when all started work has settled.

## Primitives

- Script executes JavaScript when a signal arrives.
- Event starts a signal chain: `on_run` at explicit start; `on_read` when a Custom Node's outputs are needed; placement, deletion, wiring and widget events for Library copies.
- Custom Nodes are reusable graphs of these primitives, not additional engine operations.

Nested Custom Nodes have their own input/output scopes, including helpers built inside another Library graph. Permissions still come from the enclosing placed instances. Editor hooks capture current graph/widget state when their queued execution starts; deletion hooks retain the removed graph. Reconnecting an input to a different source fires `on_wired` even if the input port itself is unchanged.

A read scope containing `on_read` refreshes its dependencies before executing. It caches outputs within the current execution until a dependency produces a different value. Data cycles and excessive dependency chains are errors.

## Script interface

Code receives `node`, `agentsys(method, path, body, query)` and `context`.

- `node.input` holds the Custom Node's data inputs.
- `node.output` writes its free data outputs.
- `node.emit(name, {handles, failFast})` fires a free signal output and waits for its branches.
- `node.reread(name)` reads an input again.
- `node.flow.break()` and `continue()` reach the nearest emission that handles that control signal.
- `node.flow.cancel()` cancels the current emission's work; `abort()` cancels the entire graph's flow.
- `node.sleep(ms)` waits within the current execution. The node remains working, and continuation respects manual pause.
- `node.cancelled` lets long-running code observe cancellation of its flow.
- `node.display()` and `node.widgets()` update the node's presentation.

Context identifies the project, workflow, node and Library instance. Explicit workflow starts can supply `payload`. No execution-history entity is exposed.

## Pause and stop

Pause prevents new node code from starting and prevents continuation after an awaited emission or `node.sleep`. Code already running may finish its current segment. Resume releases those boundaries.

Stop terminates the Worker, cancels pending model-independent network requests from that execution and prevents downstream nodes from starting. Already completed external actions are not reversed. Starting again creates independent execution state.

Script errors are shown on the canvas. There are no automatic restarts, recovery segments or background activations. Limits on script time, result size, graph depth and parallel code prevent runaway execution.
