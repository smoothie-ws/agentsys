# The graph engine

How a workflow is run and why. The model (what a signal is, what a Script can do) is in `docs/signal-engine.md`; this file is about the code. The code is `js/model/evaluate.js` (compile and collect), `js/model/executor.js` (carry out) and `js/backend/scripts.js` (start the Worker); `docs/architecture.md` has the short version.

## Two kinds of flow

- **Data** goes along ordinary wires and is read when something needs it. A node keeps its latest result.
- **Signals** (the built-in type `signal`) say "do it now". A signal carries no data, goes to every wire at once, and the receivers work independently.

Loops, feedback, "do A, then B" and recursion are all explicit control flow, so they are written with signals (and `emit` in a Script) rather than guessed from the shape of the data graph. A graph of value nodes (Custom nodes with no `op`, and Reroute) needs no signals at all. A node that *gives* a value after computing it is a Library node with an **on_read**: it is computed when it is read (see *Reading*). The engine has one node that runs code (`script`) and the event nodes; there are no special nodes for logic or for values.

## The design

**1. Compile — `compilePlan(snapshot, roots, {context, events})`.** Looks at the graph once and produces a *plan*, plain data (it is sent to the Worker as it is):

```
plan.nodes  [{id, label, kind: 'custom' | 'reroute' | 'plain', op, running, prefix,
              inputs: [{id, name, signal?, ref, has, fallback}], vars: [[name, input index]],
              outputs: [{id, name, signal?}], preset, targets: {signal output ID: [node ID]},
              event: {output name: value} | null, context}]
plan.roots  [{id, node: true} | {id, ports: [{id, ref}]} | {id, error}]
ref         {n: node id, p: port id} | {err: message} | null
```

`op` is `script` or one of the events (`on_run`, `on_read`, `on_placed`, `on_deleted`, `on_wired`, `on_widget`): a Custom node with the op `event` has the one its input `event` names as its default (`opOf` in `schema.js`; the plan only knows the result). `compilePlan` also takes the on_read nodes of every scope whose nodes it needs. Complex Nodes are looked through (a wire that ends at a wrapper's port starts at the port it is bound to), the default of a free input and the values of the widgets are already in place, and a node with a diagnostic is left out: whatever reads it gets `{err}` with its message. A Library node (a placed copy that has members besides its body) is a *scope*: `context.instance_id`, `body_id` and `widgets` of the Scripts inside are those of the copy. Nothing in the executor knows about documents, groups or types.

`hookPlan` builds the plan of a hook: the event node of the copy and everything its signal reaches.

**2. Carry out — `executePlan(plan, env)`.** Written to be embedded as source text in the Worker, so it uses nothing but its own body and `env` (`AsyncFunction`, `displayText`, `emit`, `call`, `limits`).

- *Constant nodes* (values, Reroute) are looked through when read.
- *Running nodes* (Script, event nodes) run when a signal reaches them and keep their latest outputs; a read of them gives those. If the node is in a scope (see below) and the read comes from outside, the scope is freshened first. The outputs are kept per port as a primitive or as JSON text, and each reader gets its own copy, so changing a received value changes it for nobody else.
- *Signals.* A signal output starts every node it is wired to at once. A Script has no outputs of its own and fires nothing when its code ends: `node.emit(name)` fires a free signal output of its Library node now and returns when everything it started has finished; errors of those nodes are thrown by `emit`. The event nodes fire their signal output when they are fired. A signal reaching a node that is still running starts another execution at once.
- *Parallel.* The code of Scripts runs `limits.parallel` (16) at a time; a Script waiting in `emit` or for its inputs does not take a place.
- *Limits.* 1000 nodes in a chain of signals (`Signal chain is longer than 1000 nodes`), 120 s of a Script's own code (not counting the wait in `emit`), 20 MB per result, 100 MB per run. Data wires cannot make a cycle (the snapshot refuses it); signal wires can.
- *Errors.* The error of a Script's code is `Node code: <message>`; a Script that does not finish is `Node code execution timed out`. An error in a branch does not stop the other branches; it is reported for its node, and thrown to a Script that waits in `emit`.
- *Events.* `start`, `done`, `fail` for each execution of a node, `pause`/`resume` around a wait in `emit`, and one `root` for each root. The run lasts until nothing is running.

**3. Start — `runPlan(plan, onEvent, signal)`.** One Web Worker (a worker thread on the server) for the whole run: it is told the plan, runs `executePlan` and posts every event. The code of a node reaches the site's API through the page (`call`), with the node's id, so `agentsys()` knows whose `context` it belongs to. The page also keeps a watchdog: a script that never returns control (`for (;;) {}`) cannot stop its own timer, so the page ends the run when a node has run longer than its limit plus two seconds. Cancelling terminates the Worker. Fresh Workers are started ahead while runs follow each other (`spawnWorker`).

`evaluateGraph` ties them together and keeps the contract the rest of the application uses: hooks for `onNodeStart/Done/Fail`, `{outputs, errors, status, evaluated_nodes, displays}`, `collect`, `signal`. `runPlanned` and the runs API sit on top.

## Flow control: waves

An `emit` opens a **wave**: the signal it sends and everything that causes. Waves form a tree like a call stack (`ctx.wave` in `fire`, `trigger`, `run` and `execute`; the roots of a run and every on_read of a scope start under `runWave`). A wave has `cancelled`, `handles` (the control signals the emit that opened it takes), `control` (which one arrived) and `failFast`.

- *Cancelling.* A wave is cancelled when it or any wave above it is. `trigger` does not start a node of a cancelled wave (the event `skip`, which `evaluateGraph` passes on as the hook `onNodeSkip`, and the run API as `node_skipped`), `execute` checks again after the node got its turn (a node waits for its inputs and for one of the 16 places), and `emit` in a cancelled flow ends the code. What already runs is not interrupted (as with Pause); `node.cancelled` lets long code end early.
- *Control signals.* `node.flow.break()` / `continue()` walk up from `ctx.wave` to the first wave whose `handles` has the name, cancel every wave on the way (the one that handles it too: what that emit started is over) and set `control` on it; then they throw an error with `.control`, which `execute` takes for the normal end of the node. The emit that opened the wave answers its `control`. Nothing is thrown through the nodes in between: cancelling the waves is what unwinds them, the way exceptions unwind a call stack. `cancel()` cancels the wave of the emit above, `abort()` cancels `runWave`.
- *failFast.* When a node fails, the waves from its own up to the nearest one with `failFast` are cancelled at once (waiting for the error to come up through the emits would let siblings run on).
- *Why not more.* Nothing interrupts code that runs (that is what a Worker per node would be for), and break/continue have no labels: they take the nearest handler. A pass also ends where its signal path ends, so `continue` is only needed to stop other branches of the pass.

The loops are not built in: For, For each, While, Break, Continue and Variable are Library nodes made of one Script (`examples/flow-nodes.json`, imported with Library → Import…; `tests/flow-nodes.test.js` runs them). Their loop is `for (…) { if ((await node.emit('body', {handles: ['break', 'continue']})) === 'break') break; }` followed by `await node.emit('done')`. Iterations do not add up to the chain limit: every `emit` starts from the depth of its own Script.

## Roots of a run

### Reading

The executor keeps, for every running node, a signature of its latest result and a version that grows only when the signature changes (early cutoff), and a global tick. A **scope** is a copy that contains an on_read (`readNodes`: scope id → on_read ids). `outputsOf` of a running node read from outside its scope calls `freshen(scope, path)`:

- a scope that has not been computed, or whose recorded dependency versions (`seen`) differ from the current ones, is computed: its dependencies (running nodes outside that its inside reads, through Reroutes and value nodes, `dependencies(scope)`) are freshened first, in input order; then every on_read is fired (`run(node, {depth: 0, via})`) and the call waits until the signal chain has finished;
- concurrent reads of the same scope share one computation; an error of the chain is cached like a result and cleared when a dependency changes; a failure of a dependency is an error of the scope that is not cached as done;
- `path` carries `scope:<id>` marks (and `ctx.via` carries them into the code, `node.reread(name)`), so a node that is read while it is computed is reported as a cycle.

`ctx = {depth, via}` replaces the numeric depth in `fire`, `trigger`, `run` and `execute`. Recursion (a scope reading itself on purpose) is not supported yet.

A run is a set of **starts**: the event nodes to fire. Run without node ids fires every on_run. `POST evaluate-node` with node ids reads a value node, executes a Script once as if signalled, or fires an event node. A hook is a run whose only start is the event node of a Library node copy.

## Hooks

on_placed / on_deleted / on_wired / on_widget are fired by the backend after the change is committed (`Call.collectHooks` compares the Library node copies of the document before and after the request; on_widget only comes from the `PUT widget-values` route). The thing that runs is the graph: the event node inside the copy and everything its signal reaches, compiled from the document at that moment (for on_deleted: from the document before). The hooks run one after another, so they may call the API. They are logged in `GET /api/node-hooks`.

## Library nodes

A Library node is a Complex Node (a group) whose inside is on the canvas of its editor; nothing is hidden. A slot of the group is *bound* to ports of nodes inside (`bound: [{node_id, port_id}]`; an input may be bound to several ports and feeds them all, an output to one) or *free*. A Script has no slots: it belongs to the closest copy around it (`instanceScopes`). Its plan entry lists every data input of the copy as an input of its own (`wrapper: true`, resolved to the wire that arrives at the slot, so a slot bound to a node inside is read as well), `node.input.<name>` reads them, and `context.inputs` names them. What it writes goes to the copy: a copy with a Script is a running plan node of its own (`op: scope`, `plan.nodes` entry with the id `complex:<group>`) that keeps the latest value of each free data output; Scripts merge what they set into it (`commit`), readers outside read it, and reading it from outside freshens the read scope as it does for any node of the copy. A free signal output is fired by `node.emit(name)` through `scope_signals` of the Script (the nodes its wires reach). A Script outside a copy has neither. Slots a copy has of its own (`extra`, `PUT node-slots/complex:<group>`) are free slots.

The unit of a node is the closest placed copy around it (`instanceScopes`); `context.instance_id`, `widgets` and the events (on_placed…) are those of that copy. Widgets belong to nodes (`config.widgets` declares them); a placed copy lists the nodes with widgets (`widget_nodes` in the snapshot) and shows them on itself. Refreshing a copy from its definition keeps the widget values of the k-th node with the same title.

The engine knows the `op`s of a Custom node: `script` and the event ops (`on_run`, `on_read`, `on_placed`, `on_deleted`, `on_wired`, `on_widget`). Nothing else is built in and no node ships with the app: a node is a Custom node (a value holder when it has no `op`), and a Library node is a group made of them. Nothing in the executor knows what a node is for.

## Where the ideas come from

- *Signals as explicit control flow* is how Unreal Blueprints (white execution pins next to coloured data pins) and Godot's visual scripting work. *Data read when needed, from the latest value of a node* is how Blender's geometry nodes and spreadsheets work.
- *Compile first, then run* keeps the page's knowledge of documents and types out of the Worker.
- *Values are copied for every reader* is what makes parallel branches safe without locks.
- *Not taken:* a persistent runtime between runs (results would depend on history), and a Worker per node (the 15–30 ms start of each).

## Tests

`tests/engine.test.js` covers the executor with hand-made plans and graphs: reading through on_read (`tests/onread.test.js`), signals to many wires, `emit`, loops, errors in branches and thrown by `emit`, the chain limit, timeouts, cancel, size limits and runs staying apart. `tests/custom.test.js` and `tests/body.test.js` cover Library nodes and hooks; the other suites run through the same engine.

## Suspend/resume and vocabulary

Project means the editor workspace; Initiative means the project managed by the controller. `executePlan` keeps invocation journals, a wave tree, latest output maps, read versions and dependency signatures as serializable data. At `node.wait`, a suspend control unwinds incomplete invocations while unrelated branches drain. The checkpoint retains these maps and the pending wait conditions. Completed invocations are skipped when restoring; incomplete parents repeat their code and `emit` sequence. The waiting invocation receives `node.resumed` and stable `node.runKey`.

The backend stores each run, checkpoint and append-only events separately, releases the Worker and registers its wait atomically under the request lock. Startup loads waiting runs and marks running segments interrupted. Scheduler ticks resolve timer waits and enforce the run lifetime (default one week); `POST events/{name}` resolves event matches. Manual resume from the last checkpoint is allowed for interrupted runs. Approvals require the approval route, never manual bypass. Default checkpoint limits are 1,000 checkpoints and 20 MB each. `run_retention` defaults to 200 finished runs; active/waiting work is retained.

The server owns runs when present. Browser-only execution uses the same engine and IndexedDB, but external wakeups require an active application or a server. Capability checks, budget reservations and trace recording stay in the host bridge. See the specialized permission, format, versioning and replay documents.
