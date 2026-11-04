# AgentSys

A local visual programming application. A workflow is a live graph: typed ports, data and signal wires, nested Custom Nodes, and persistent JSON state, port values and previews. Run signals the enabled `on_run` Events; later signals use the same interpreter and state. There is no per-Run initialization and no execution plan.

```sh
npm start
npm start -- --port 3000
```

On Windows, `start.bat 3000` selects a port. `PORT`, `HOST` and `DATA_DIR` are supported. The editor is at `/editor/`, the application API under `/api/`.

- Script and Event are the behavior primitives. Branches, loops, delays and previews are Library graphs built from them.
- Signals carry control; data wires carry JSON values. Run, Pause, Resume and Stop work on a graph that already has active work.
- Live edits: subsequent nodes and emissions use the current code and connections.
- Shared durable JSON at `context.state`, kept across Run, Stop, navigation and restart.
- A graph can edit itself: `agentsys(method, path, body)` calls the same checked API as the editor, and the Library's Graph nodes (Add Node, Remove Node, Connect, Get Nodes, Invoke Node) wrap it. Recursion and macros are ordinary graphs.
- Undo/redo, copy/paste, import/export, project permissions and secrets.
- [Plugins](docs/plugins.md): a folder in `plugins/` with a `main.js` exporting `start(api)` and `stop()`, as in Substance Painter. A plugin can add Library nodes, answer API routes, keep settings and react to changes.

The Node server stores definitions, layout, scripts and runtime JSON as files in `data/`. JSON state and previews survive a restart; JavaScript stacks, timers and pending external work do not resume.

```sh
npm test
python tests/browser_suite.py
```

Read [Architecture](docs/architecture.md) first, then [Engine](docs/engine.md), [Runtime](docs/runtime.md), [Permissions](docs/permissions.md), [Plugins](docs/plugins.md) and [Building an LLM controller from nodes](docs/llm-controller.md).
