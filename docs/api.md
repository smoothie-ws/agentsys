# API

The server exposes JSON endpoints under `/api/`; `/api/openapi.json` is the generated contract. The editor's API page includes a searchable method tree and examples.

Mutation requests require `X-AgentSys: 1`. Host and optional bearer-token checks protect the server; non-loopback access requires an API token.

The core API covers projects, workflow editing and batches, graph validation and evaluation, explicit execution controls, Library nodes and generic plugin resources, settings, permissions, secrets, checked network calls, notifications and plugin lifecycle.

See [Execution](runtime.md) for Start/Pause/Resume/Stop, [Plugins](plugins.md) for extension APIs, and [Permissions](permissions.md) for capability checks. `if_cursor` or `If-Match` makes a graph edit conditional on its current cursor. Edit history provides undo/redo.

The execution engine exposes no history, trigger, scheduler, queue, checkpoint or replay endpoints.
