# AgentSys

A visual workflow system that runs by itself. You draw a graph of nodes; the graph is **interpreted live** (edit it while it runs), keeps **durable state and queues**, waits for time or people, and can be inspected, paused and corrected by a person at any moment. It is a general engine for continuous computation — event handling, queues, timers, long jobs — and agents are one thing you can build on it, not something built into it.

- Static browser editor, no build step, no framework, no dependencies.
- A tiny Node server (`server.js`) keeps all data as readable JSON/JS files in `data/`, runs the same backend as an HTTP API, ticks a scheduler and serves webhooks. With no server the editor works on its own with IndexedDB.
- Everything the UI can do is an API call (`/api/...`); the API page (`/editor/api`, under Dashboard) has the full reference.

## Run

```sh
node server.js          # http://127.0.0.1:8080/  (opens the editor at /editor/)
npm test                # node --test (Node 20+)
```

Environment: `PORT`, `HOST` (default `127.0.0.1`), `DATA_DIR`, `AGENTSYS_TOKEN` (required to use `/api` on a non-loopback `HOST`), `ALLOWED_HOSTS`. See [API](docs/api.md) for the access rules.

## Where things are

| Page | Path | What it is |
|---|---|---|
| Dashboard | `/editor/` (the logo) | counts of projects and workflows; run metrics; recent runs; the way to the API |
| API | `/editor/api` | the reference generated from the route table, OpenAPI download; under Dashboard in the navigation |
| Projects | `/editor/projects` | projects and their workflows |
| Plugins | `/editor/plugins` | installed plugins: import, enable, disable, remove, permissions, settings; the pages they add |
| Notifications | the bell beside Search | messages from plugins and workflows (`/api/notifications`); empty until something posts |
| Library | `/editor/library` | reusable Nodes and plugin collections, including AI providers and skills |
| Runs | `/editor/runs` | under Dashboard: workflows' control, activations, versions, limits |
| Settings | `/editor/settings` | appearance, shortcuts, developer mode |

Workflow settings on the canvas contain Types, Available nodes and Permissions. The permission policy applies to every workflow in the project and uses the same Allow/Disallow controls as nodes.

Dashboard and Runs update automatically. Runs supports shareable workflow/status/time filters and paginated retained history; policy forms autosave and protect unsaved edits when leaving. An empty workspace offers a runnable starter workflow. See [interface improvements](docs/interface-polish.md) for validation and remaining scope.

## Documentation

- [Concepts](docs/concepts.md) — workflows, nodes, signals, the Library
- [Engine](docs/engine.md) — how a graph is executed: signals, reading, the Script API, flow control, live edits
- [Runtime](docs/runtime.md) — activations, durable waits, state, queues, supervision, intervention, versions, replay
- [API](docs/api.md) — HTTP access, runs, triggers, webhooks, batch edits, route catalogue
- [Permissions](docs/permissions.md) — capabilities, grants, secrets, isolation
- [Limits](docs/limits.md) — every limit of the system and whether the UI exposes it
- [Code guide](docs/code-guide.md) — file map, how to add a route, an op, a page
- [Testing](docs/testing.md)
- [Full audit, 2026-10-29](docs/full-audit-2026-10-29.md) — findings, fixes, measurements and improvement priorities (Russian)
- [Plugins](docs/plugins.md) — package format, rights, pages, endpoints
- [Roadmap](docs/roadmap.md) — plugins and what is planned
