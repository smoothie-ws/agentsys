# API

The server exposes JSON endpoints under `/api/`; `/api/openapi.json` is the generated contract. The editor's API page includes a searchable method tree and examples.

Mutation requests require `X-AgentSys: 1`. Host and optional bearer-token checks protect the server; non-loopback access requires an API token.

The core API covers projects, workflow editing and batches, graph validation and evaluation, live graph signals and controls, Library nodes and generic plugin resources, settings, permissions, secrets, checked network calls, notifications and plugin lifecycle.

See [Execution](runtime.md) for Run/Pause/Resume/Stop, [Plugins](plugins.md) for extension APIs, and [Permissions](permissions.md) for capability checks. `if_cursor` or `If-Match` makes a graph edit conditional on its current cursor. Edit history provides undo/redo.

`GET projects/{project_id}/execution` returns the current workflow runtime, including its JSON `state`, outputs and previews. `POST` sends a signal; `DELETE` stops active work. Workflow exports include durable runtime data. The Script editor and API page expose the Script API reference; see [Script API](scripts-api.md).

The additive [durable execution API](durable-execution.md) documents identified dispatches, status/results, parent links, optional budgets, versioned areas, operation checkpoints/retries/resolution and metadata-only history. `/api/openapi.json` is generated from the same registered routes, body examples, query fields and capability declarations. Expected versions are mandatory for area and checkpoint changes; conflicts return 409. User-only `node-permissions/{node_id}` PUT authorizes a standalone Script without changing code or requiring Developer mode.
