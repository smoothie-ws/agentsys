# AgentSys

A local visual programming application. A workflow is a live graph with persistent JSON state, port values and node previews. Run signals its enabled `on_run` Events; subsequent signals use the same interpreter and state. There is no per-Run initialization or execution plan.

```sh
npm start
npm start -- --port 3000
```

On Windows, `start.bat 3000` selects a port. `PORT`, `HOST` and `DATA_DIR` are supported. The editor is at `/editor/`, and the application API is under `/api/`.

- Projects and workflows, typed ports, data and signal wires, nested Custom Nodes and widgets.
- Script and Event primitives. Every Script has `in`, `script` and an automatic completion signal `out`.
- Explicit signal emission through `await node.output.name.emit(options?)`.
- Run, Pause, Resume and Stop. Run can signal a graph that already has active work. Stop cancels work without clearing graph values.
- Live edits: subsequent nodes and emissions use current code and connections. An invocation already executing keeps its current function.
- Shared durable JSON at `context.state`, retained across Run, Stop, navigation and application restart.
- Undo/redo for graph edits, copy/paste, import/export, checked API calls, permissions and secrets.
- Executable plugins with `activate(context)`, owned registrations, isolated hosts and sandboxed views.
- The bundled AI plugin supplies Providers, model discovery and Provider/Model/Ask graphs.

Ordinary graph execution has no configured timeout, concurrency, chain-depth or result-size quotas. Controlled API runs can opt into inherited budgets. Stop terminates its Worker when code must be interrupted. API permission checks, valid graph structure, JSON serialization, transport boundaries and plugin package/callback validation still apply.

Optional [durable execution APIs](docs/durable-execution.md) provide dispatch/invocation identities, versioned independent JSON areas, bounded metadata traces and explicit operation checkpoints/retries. `context.state` and latest-value ports keep their shared semantics. Try `node examples/durable-process.cjs` for a parallel, restartable process without an LLM. Standalone Script permissions are editable in Properties; Workflow / Execution opens execution history.

The Node server stores definitions, layout, scripts and runtime JSON in `data/`. Without it, the application uses browser storage. JSON state and previews survive application restart; JavaScript stacks, timers and pending external work do not resume. `globalThis` properties belong to the current host and are lost on Stop or restart.

```sh
npm test
python tests/browser_suite.py
```

See [Engine](docs/engine.md), [Runtime](docs/runtime.md), [Script API](docs/scripts-api.md), [Plugins](docs/plugins.md) and [Decisions](docs/decisions.md). Script API help is also available beside code editors. TypeScript declarations are in `sdk/script.d.ts` and `sdk/plugin.d.ts`.
