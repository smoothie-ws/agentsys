# AgentSys integration workspace

AgentSys consists of two independently installed and released products:

- [AgentSys Server](https://github.com/smoothie-ws/agentsys-server): headless graph platform, HTTP API and SSE.
- [AgentSys Client](https://github.com/smoothie-ws/agentsys-client): static browser application, graph editor and sandboxed client plugins.

This repository contains integration tooling and compatibility evidence. Product
source code is maintained only in those repositories. Original monolithic history
remains intact; the extraction baseline is `5f916bf24bea3a10a0566c68992f1eacb79a999a`.

Build/download each product's npm artifact, then run:

```sh
python tools/local.py --server-artifact ../agentsys-server/agentsys-server-0.4.1.tgz --client-artifact ../agentsys-client/agentsys-client-0.7.0.tgz
```

The launcher installs them into separate prefixes and starts two processes.
Alternatively, run the server CLI alone and deploy the client ZIP on static hosting.
The products communicate only through public REST/JSON and authenticated SSE.
Node.js 22+ and Python are needed for integration tooling; production static
client hosting needs no Node.js. Existing untracked data has been preserved;
select its directory explicitly with the server CLI --data when migrating.

See [compatibility](COMPATIBILITY.md), [integration tests](INTEGRATION-TESTS.md),
and [migration evidence](docs/ACTIVE-MIGRATION.md). Measurements and E2E results
are under integration-results/. Each product owns its installation, architecture,
security/API or plugin documentation and release workflow.

Final delivery details: [separation report](REPORT.md) and [acceptance audit](COMPLETION-AUDIT.md).
