# AgentSys

AgentSys has two independent products:

- [Server](https://github.com/smoothie-ws/agentsys-server): headless graph execution, persistence, HTTP API and SSE.
- [Client](https://github.com/smoothie-ws/agentsys-client): static browser application, graph editor and sandboxed plugins.

This workspace installs their artifacts and verifies integration through the public Web API. Each product owns its source, builds, tests and releases. Both start at `0.1.0`; Web API is `1.0` (protocol `1`), Plugin API and package format are `1`.

Build an artifact with `npm pack` in each product repository, then run:

```sh
python tools/local.py --server-artifact ../agentsys-server/agentsys-server-0.1.0.tgz --client-artifact ../agentsys-client/agentsys-client-0.1.0.tgz
```

The launcher starts separate processes and uses `.local/mvp-data`. Node.js 22+ and Python are required for this tooling. The client can also be deployed to static hosting without Node.js.

Use a new empty data directory. Server stores carry `.agentsys-store.json` with format `agentsys.store/1`; a nonempty unmarked or unsupported directory is refused before writes. Browser data uses the `agentsys.client.v1` namespace.

See [integration tests](INTEGRATION-TESTS.md) and [verification](VERIFICATION.md).
