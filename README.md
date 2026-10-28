# AgentSys

A visual workflow system that runs by itself. You draw a graph of nodes; the graph is **interpreted live** (edit it while it runs), keeps **durable state and queues**, waits for time or people, and can be inspected, paused and corrected by a person at any moment. It is a general engine for continuous computation — event handling, queues, timers, long jobs — and agents are one thing you can build on it, not something built into it.

- Static browser editor, no build step, no framework, no dependencies.
- A tiny Node server (`server.js`) keeps all data as readable JSON/JS files in `data/`, runs the same backend as an HTTP API, ticks a scheduler and serves webhooks. With no server the editor works on its own with IndexedDB.
- Everything the UI can do is an API call (`/api/...`); the API page (`/editor/api`, a card on the Dashboard) has the full reference.

## Run

```sh
node server.js          # http://127.0.0.1:8080/  (opens the editor at /editor/)
npm test                # node --test (Node 20+)
```

Environment: `PORT`, `HOST` (default `127.0.0.1`), `DATA_DIR`, `AGENTSYS_TOKEN` (required to use `/api` on a non-loopback `HOST`), `ALLOWED_HOSTS`. See [API](docs/api.md) for the access rules.

## Where things are

| Page | Path | What it is |
|---|---|---|
| Dashboard | `/editor/` (the logo) | counts of projects, workflows, Library nodes; run metrics; what needs attention; recent runs; the way to the API |
| API | `/editor/api` | the reference generated from the route table, OpenAPI download; reached from the Dashboard, not from the sidebar |
| Projects | `/editor/projects` | projects and their workflows |
| Library | `/editor/resources` | the Library's sections as cards; today one: **Nodes** (`/editor/resources/nodes`: reusable Custom Nodes and the groups they are kept in) |
| Runs | `/editor/runs` | workflows' control, activations, versions, permissions, limits |
| Settings | `/editor/settings` | appearance, shortcuts, developer mode |

## Documentation

- [Concepts](docs/concepts.md) — workflows, nodes, signals, the Library
- [Engine](docs/engine.md) — how a graph is executed: signals, reading, the Script API, flow control, live edits
- [Runtime](docs/runtime.md) — activations, durable waits, state, queues, supervision, intervention, versions, replay
- [API](docs/api.md) — HTTP access, runs, triggers, webhooks, batch edits, route catalogue
- [Permissions](docs/permissions.md) — capabilities, grants, secrets, isolation
- [Limits](docs/limits.md) — every limit of the system and whether the UI exposes it
- [Code guide](docs/code-guide.md) — file map, how to add a route, an op, a page
- [Testing](docs/testing.md)
- [Roadmap](docs/roadmap.md) — plugins and what is planned
