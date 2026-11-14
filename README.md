# AgentSys

AgentSys is a visual programming platform for dynamic computation graphs: typed ports, data and signal wires,
nested Custom Nodes, asynchronous execution, persistent JSON state and graph editing from a browser.

It is two independent programs:

- **AgentSys Server** — a headless CLI that stores projects, Library resources, runtime state and secrets, and
  executes graphs in worker threads. It runs without a browser and without any client connected.
- **AgentSys Client** — a static browser application. It edits and observes through the server API; it has no
  backend, no graph interpreter and no authority over workflow state.

```text
Client (browser) ── HTTPS + token/session + SSE ── Server (Node CLI) ── data/*.json
```

Server plugins do not exist. A plugin extends the client only; a Library node it creates is ordinary server data
and keeps running when the client and plugin are gone.

## Run locally

```sh
npm start
```

This starts the server on `127.0.0.1:8080`, the client on `127.0.0.1:8081`, and opens the client. Closing the
browser leaves the server and its workflows running. On Windows, `start.bat` does the same.

Or run the pieces yourself:

```sh
node bin/agentsys-server.js start --port 8080 --data ./data
node bin/agentsys-client.js --port 8081 --server http://127.0.0.1:8080
```

No npm install or build step is required: Node.js 20+ built-in modules and browser APIs are enough.

## Use another server

Open **Environments**, add the server's HTTPS address and its token if it has one, and choose *Use*. A client
can switch between a local server, a LAN machine and a VPS. Projects, Library and runtime belong to each
server and are never merged. See [Environments](docs/environments.md).

## What a workflow is

- A workflow is a live graph: typed ports, data wires, signal wires, groups and nested Custom Nodes.
- Script and Event are the behavior primitives. Branches, loops, delays and previews are Library graphs built
  from them.
- Run signals the enabled `on_run` Events; later signals use the same interpreter and state. There is no
  per-Run initialization and no execution plan.
- Scripts read `node.input`, write `node.output`, emit named signals and use `context.state` for shared JSON.
  `agentsys(method, path, body)` calls the same checked API as the editor.
- A graph can edit itself: the Library's Graph nodes wrap that API. Recursion and macros are ordinary graphs.
- Pause gates continuations, Resume releases them, Stop cancels work and keeps JSON values. State survives a
  restart; JavaScript stacks do not.

## Client plugins

Install a JSON package from **Plugins**. It runs in a sandboxed iframe with a narrow host API; its pages and
cards are sanitized. It reaches the server only through the normal API and cannot read the server token. A
package declares what it may do there: without `capabilities` it is read-only, and writes, runs, secrets and
network hosts are named explicitly. The check runs in the host page, so it holds against the plugin, not against
an operator who edits the client. See [Plugins](docs/plugins.md).

## Tests

```sh
npm test
python tests/browser_suite.py
```

The Node suite covers the engine, editing, permissions, storage, API and migration. The browser suite starts
real server and client processes and covers connection, environment switching, plugin-created nodes, execution
after the client closes, and server restart. Requires Python Playwright and Chromium; set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` when the browser is not in Playwright's default cache. See [Testing](docs/testing.md).

## Documentation

Read [Architecture](docs/architecture.md) first, then:

- [Audit](docs/audit.md) — what was wrong and what this cycle changed.
- [Server](docs/server.md) — CLI, storage, runtime, API.
- [Client](docs/client.md) — transport, UI state, environments.
- [Environments](docs/environments.md) — connecting and switching servers.
- [Plugins](docs/plugins.md) — client extension API and its limits.
- [Security](docs/security.md) — auth, CORS, secrets, sandbox.
- [Deployment](docs/deployment.md) — local, LAN, VPS, HTTPS, systemd.
- [Migration](docs/migration.md) — moving from the old combined/server-plugin version.
- [Engine](docs/engine.md), [Runtime](docs/runtime.md), [Permissions](docs/permissions.md) — the graph engine.
- [Testing](docs/testing.md) and [Future runtime](docs/future-runtime.md).

`node server.js` is still available as the combined local test server (editor at `/editor/`, API at `/api`).
The platform server is `bin/agentsys-server.js`; it never serves the GUI.
