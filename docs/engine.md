# Live graph interpreter

A workflow owns one live runtime. The runtime remains available when no work is active. It retains port values, previews, errors and shared JSON state. An isolated JavaScript host is created when work needs it and is reused by subsequent signals.

Run sends a signal to every enabled `on_run` Event. There is no special execution admission path: the same interpreter handles Run, editor events and signals emitted by nodes. A graph without an enabled `on_run` receives no work from Run. Repeated Run signals are allowed while other work is active.

## Current graph

The interpreter indexes the current graph for port lookup and describes nodes as they are reached. It does not construct an immutable execution plan. Edits update the live view: the next invocation reads current code and inputs, the next emission follows current connections, and `node.reread(name)` resolves the current input connection again. Code already executing retains its function and initial `node.input` values until that invocation returns. Explicit rereads can observe newer values.

Changing a saved Library definition refreshes its live placed instances. Disabled nodes do not receive signals; their data connections behave as disconnected inputs. Removing nodes removes their runtime values and previews. Deletion-event handlers temporarily retain their detached node data until those handlers finish.

## Data and signals

Data wires supply values when an input is read. Pure values and Reroutes compute on read. Running nodes and Custom Node scopes retain their latest JSON output values. Values crossing a node boundary are JSON copies, so changing a received object does not change another node's data.

Signals carry control, not a data payload. An output signals all connected receivers concurrently. `await node.output.name.emit(options?)` waits for the work started by that emission. An unawaited emission still belongs to the signal call that started it. Separate signal calls do not wait for each other; a nested API evaluation cannot wait on its own caller.

Every Script has a concrete `out` signal output. It emits automatically once after successful completion, including `return`. Errors and flow cancellation do not emit it. Calling `node.output.out.emit()` manually sends an additional signal; it does not suppress automatic completion. A Custom Node may publish the Script's completion port by binding a signal output to it. The name `out` in a Script's output API is reserved for this completion signal.

Free data outputs of the enclosing Custom Node use `node.output.name = value`. Free named signal outputs use `node.output.name.emit()`. Names are exact and case-sensitive. Unknown outputs and assigning a data value to a signal are errors.

## Events and reads

Script executes JavaScript when signalled. Event fires its signal outputs for its selected operation:

- `on_run`: an explicit Run signal, carrying `{payload}`.
- `on_read`: a Custom Node's values are needed.
- `on_placed`: a Library instance is placed.
- `on_deleted`: a Library instance is removed.
- `on_input_connected`: an instance's input connections change, carrying `{connected: [input names]}`. Replacing a source counts as a change; the list describes the current connections, including after disconnection.
- `on_widget`: a user changes a widget, carrying `{widget: {id, kind, label, value}}`.

Custom Nodes compose these primitives and provide input/output scopes. Nested instances retain their own scopes and enclosing permission chain. Library events and Run use the same live runtime and shared `context.state`.

Editor events dispatch independently. A paused workflow does not block events in another workflow. Retained errors from earlier work remain visible on the graph without marking a successful later event as failed.

An `on_read` scope caches computed outputs until its data dependencies or graph definition change. Dependencies are brought up to date before computing the scope. A changed shared JSON context also invalidates read caches. Data-dependency cycles and cyclic interface/group bindings are invalid graph structure.

## Shared state and presentation

`context.state` is the workflow's shared JSON object. Scripts change it by assigning or deleting properties; nested objects and arrays are observed. Values must be JSON data. Functions, symbols, bigint and non-finite numbers cannot be assigned. Object keys `__proto__`, `prototype` and `constructor` are reserved. Concurrent Scripts share the object; their multi-step changes are not transactions.

Output assignments publish values immediately. Emissions, API calls, delays and completion also publish current output objects. `node.display()` publishes text, JSON or base64 image previews immediately. The host saves JSON state, outputs and previews independently of editor undo history. Import/export and workflow/project duplication carry these values; duplicated node IDs are remapped in output/preview maps.

`globalThis` is shared JavaScript memory for the current workflow host. Run does not replace that host. Stop or application restart loses these globals. Durable application data belongs in `context.state`.

## Pause, cancellation and Stop

Pause prevents new node code and continuations after an awaited emission or `node.sleep` from starting. The pause request is accepted immediately; synchronous code already executing is not frozen. Run while paused queues its ordinary signals. Resume releases the gate. Timer time can elapse while paused; continuation waits for Resume.

`node.flow.break()` and `continue()` end the current Script and reach the nearest emission whose `handles` includes that control. `cancel()` cancels the current wave. `abort()` cancels everything the current signal call started. Code can inspect `node.cancelled`. An emission's `{failFast: true}` cancels further work in that wave after a branch error.

Stop terminates the host and aborts its outstanding checked network operations. It preserves acknowledged JSON state, outputs and previews. A later signal creates a host initialized from those values. External actions already completed are not reversed. Application restart restores data but does not reconstruct pending JavaScript calls, timers or requests.

## Resource behavior

Ordinary execution has no configured Script timeout, chain-depth, concurrency, result-size or total-result quota. Infinite synchronous code can occupy the host until Stop terminates it. Hardware, JavaScript and storage/transport behavior still determine what can be represented. Permissions and graph/JSON validity remain enforced.

Removing a node or stopping its host rejects its late state and API writes. Stop acts on the workflow's shared Worker, so it ends every signal call of that workflow.
