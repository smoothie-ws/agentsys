# Signal engine

The model of a workflow's execution: this file is the contract the code is written against.

## Why

Loops, feedback, recursion and "do A, then B" need one thing: **explicit flow of control**. Data flows by wires and is read when needed; *doing* something flows by **signals**.

## The model

- **Data** still flows through ordinary wires. A node keeps its **latest result**. A data input is read when something runs and needs it.
- **Signal** is a built-in port type (`signal`). A signal carries no data. An output signal goes to **every** wire at once; the receivers work independently (in parallel). An input signal accepts any number of wires (any of them triggers it). Signal wires may form loops (data wires may not).
- **Value nodes** (a Custom node with no `op` and no signal ports) only hold a value typed on an output (or a widget); a Reroute point passes one on. Reading them costs nothing.
- **Running nodes** (the nodes with the op `script` and the event nodes) do something when a signal reaches them and keep their latest outputs. Reading a running node gives its latest result.
- **Nothing is read before it exists.** Inside a Library node that has an `on_read` node, a read from outside fires the `on_read` first and waits for the chain to finish (see *Reading*).
- A node that **does** something (an effect: it changes, shows or sends) has signal ports. A node that **gives** something has an `on_read`.
- **Nothing hidden.** Code lives only in the `script` node. A Library node is a graph of nodes that you can open and read; its slots are bound to ports inside or are free (read by name with `read`). Nothing ships with the app but providers and skills: every node a person uses is made from the operations below.

## Operations

What a Custom node does is its `op` (none: it only holds the values typed into its outputs).

The two bricks everything is built from, **Script** and **Event**, are not Library nodes: the first two items of the Add node menu make them (`POST projects/{id}/primitives`). A Script is the `script` row below. An Event has no inputs and one signal output; the event it fires (its `op`: one of the `on_*` rows) is chosen with the combobox on the node (`PUT projects/{id}/primitives/{node}/event`).

| `op` | inputs | outputs | |
|---|---|---|---|
| `script` | a signal input `In` and `script` (the code): nothing else | none | runs the code when the signal input is signalled; the code reads the inputs and writes the outputs of the Library node it is in (below) |
| `on_run` | – | a signal output | fired by Run (the Run button, the API, a trigger); a data output carries the payload of the trigger |
| `on_placed`, `on_deleted` | – | a signal output | fired for **a copy** of the Library node that contains it, when the copy is placed / removed |
| `on_wired` | – | a signal output | fired for the copy when its wired inputs change; a data output lists their names |
| `on_widget` | – | a signal output | fired for the copy when a person used one of its widgets; a data output is `{id, kind, label, value}` |
| `on_read` | – | a signal output | fired for the copy when something outside it reads one of its running nodes |

The event nodes put their data on the data outputs the node declares (`payload`, `wired`, `widget`). `on_placed`, `on_deleted`, `on_wired`, `on_widget` and `on_read` exist **relative to the Library node they are in**; in an ordinary workflow they are never fired. `on_run` fires on every Run, in every copy.

## The code of a Script

A Script has no slots of its own. It belongs to the Library node (the placed copy) it is in and works through it. The code has three variables: `node` (that Library node), `agentsys(method, path, body)` and `context`. Nothing else is named for the code, so every access says whose it is.

- `node.input.<name>` is a data input of the Library node (every one, whatever it is bound to inside; `node.input['a b']` for a name that is not an identifier). The inputs are read once, when the signal arrives. `await node.reread('x')` reads input `x` again (it gives the latest result of the node it comes from, or computes it if it is behind an on_read): for a loop that watches a value.
- `node.output.<name>` sets a **free data output** of the Library node (one that no node inside feeds); reading it gives what it holds now. Whatever the Script did not set stays as it was; typed values of editable outputs are there from the start. Setting a name that is not a free output (a typo, an output a node inside feeds, a signal output) is an error, and so is a value that is not data (a function). `return` is not used. A Script in a workflow outside any Library node has no inputs and no outputs: it can only `node.display`, call `agentsys` and put `node.widgets`.
- `await node.emit('name')` fires the free **signal output** `name` of the Library node **now**, from the middle of the code, and returns when everything that signal started has finished. An error of a node that was started is thrown by `emit`. The name is required; a name that is not a free signal output is an error. Nothing is fired when the code ends: a Script that does not call `emit` fires nothing. The latest outputs are what `node.output` has set at that moment.
- `await node.emit('name', {handles, failFast})` takes options. `handles` is a list of `'break'` and/or `'continue'`: the emit takes those control signals (see `node.flow`) and answers `'break'`, `'continue'` or `undefined` when everything the signal started has finished. `failFast: true`: the first failure in what the signal started cancels the rest of it (nodes that have not started do not start; the error is thrown by `emit` as always).
- `node.flow` is what a node does to the flow it is in. Each call ends the code of the Script (as `return` would; do not catch it: a `catch` must rethrow an error that has `.control`) and that is not a failure of the node:
  - `node.flow.break()` and `node.flow.continue()` go up to the nearest `emit` above that handles them (`handles`). What that emit started stops starting new nodes: the nodes that run finish, the ones that did not start are skipped, the Scripts of that flow end their code at their next `emit`. The emit then answers `'break'` or `'continue'`, and the code that called it decides (a loop leaves on `'break'` and goes on to the next pass on `'continue'`). An `emit` in between that does not handle them just answers (its Script goes on, and its next `emit` ends its code). With no emit above that handles it, it is an error of the node that called it: `node.flow.break() outside a loop`.
  - `node.flow.cancel()` cancels the flow of the `emit` above (in a Script that nothing emitted for: everything started from its root), without an error and without an answer.
  - `node.flow.abort()` ends the whole run: nothing new starts, and loops that are running end their code at their next `emit`.
- `node.cancelled` is `true` once the flow the node belongs to was cancelled (a long code can look at it and end early). A cancelled flow cannot be left by code: its next `emit` ends the code.
- `node.display(...)` shows text or an image on the node; each call replaces the one before (the last call wins).
- `context`: `{project_id, workflow_id, node_id, instance_id, widgets, event?}`. `instance_id` is the Library node (copy) the Script is in, or `null`; `agentsys('PUT', 'projects/<id>/node-slots/' + context.instance_id, {inputs})` changes that copy's own slots. `widgets` are the values of the widgets of the copy (those of all its nodes together by widget ID, the Script's own winning when an ID repeats; or of the Script itself outside a copy). `event` is the data of the event nodes beside the Script (`payload`, `wired`, `widget`).
- `await node.widgets([{id: 'name', kind: 'text', label: 'Name', value: ''}])` puts widgets on this node (the list replaces the node's own; a widget that stays keeps its value unless the list gives one); `await node.widgets.set({name: 'abc'})` sets values. Kinds: text, textarea, number, checkbox, select (options), range (min, max, step), button (its value counts clicks), label (text), html (html, height). A Script in a Library node shows them on the copy.
- Time: 120 s of the code between `emit` calls, not counting the wait in `emit`. A running Script does not hold one of the 16 places while it waits in `emit`.
- A signal that reaches a Script that is still running starts another execution at once. Prevent it with the graph; the engine only stops a chain of more than 1000 signals that follow each other (`Signal chain is longer than 1000 nodes`).

## Reading (on_read)

A **scope** is a Library node (a placed copy) that contains an on_read. When a node outside the scope reads a running node inside it:

1. If the scope has a result it still can trust, the read gives it.
2. Otherwise the scope is *freshened*: first the nodes outside that its inside reads (its **dependencies**) are freshened, in the order of its inputs (left to right); then the on_read fires and the read waits until everything the signal started has finished; then the read gives the result.

A result is trusted until a dependency gives a different result than the one the scope saw (every running node counts how many times its latest result changed; equal results do not count: a change that makes no difference stops there). So each node of a connected graph is computed once per change, and a change far upstream marks only the nodes that read it. An error in the chain is the result of the read, kept until a dependency changes. A node that is read while it is being computed is a cycle and an error (recursion will need a rule of its own).

The Script of such a chain reads `Object.keys(node.input)`, the names of the data inputs of its Library node, to read inputs it does not know in advance. `node.output.<name>` reads the current value of a free output of the Library node (what was typed there or left by a Script), and `context.event` holds the data of the event nodes beside it (`payload`, `wired`, `widget`).

## Run

A run is a set of **starts** (event nodes to fire) and the work they cause; it lasts until nothing is running. `POST evaluate-node` with node ids: a value node is read; a Script is executed once as if signalled; an event node is fired. Its outputs are the latest outputs of the node. Run without node ids fires every on_run.

## Hooks

on_placed / on_deleted / on_wired / on_widget are fired by the backend after the change is saved, and the thing that runs is the graph: the event node inside the copy and everything its signal reaches (the plan is compiled from the document at that moment; for on_deleted from the document before).

## Types and wires

`signal` is a built-in type like `any`. It fits only `signal`. A signal output has any number of wires; a signal input has any number of wires; a data input has one. Cycle checks look at data wires only.

## Durable waiting and host authority

`await node.wait(spec)` accepts exactly one event/match, delay (milliseconds), until (ISO date) or approval condition. It ends the current execution by suspend control; do not swallow errors with `.control`. Write `if (!node.resumed) await node.wait(...)` and then consume `node.resumed.value`. The Script runs again from its beginning. All effects before wait must be idempotent, including ancestor Scripts that were awaiting a suspended emit. `node.runKey` remains stable across those attempts. Completed sibling executions are skipped. Waiting consumes no Worker and none of the 120 s code allowance.

An approval requires `approval.request`; inspect `node.resumed.value.approved` before continuing a sensitive action. A rejected/expired answer is a normal continuation value. The bridge enforces the intersection of capabilities, policy and grants; direct network/global host APIs are unavailable. Time and randomness use the Script's Date/Math bindings and are recorded for replay.
