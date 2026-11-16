# Dependencies and public contracts

```text
Client manifest -> shared contracts + read-only model + UI
UI -> api() -> Environment -> HTTP API
Plugin iframe -> Host RPC -> capability check -> Environment scoped token -> HTTP capability check
HTTP API -> credentials + headless loader + file store + shared contracts
headless manifest -> storage Context -> graph model -> Backend routes/execution -> Script worker
Script worker -> checked bridge -> Backend.request (project policy + instance grants)
```

The static Client CLI imports only protocol and static asset policy. API server imports no Client UI or plugin
code. CommonJS imports are acyclic; ordered server classic scripts are checked separately for browser globals
and manifest membership. Mutual function calls inside one VM are not claimed to be a module import graph.

| Contract | Version / operations | Boundary, errors and lifecycle |
|---|---|---|
| Server HTTP / Environment | Protocol 2; discovery, auth, CRUD, execution, SSE; OpenAPI from routes | HTTP auth/Host/Origin/CSRF and scoped identity; `{error:{code,message}}`; 409 conflicts; generation rejects late responses |
| Graph interchange | agentsys.text/1; Library bundle 3 | Shared pure serialization; server validates/mutates; workflow cursor, semantic snapshot synchronization |
| Script | Existing runtime API (no new version) | Worker -> checked bridge; policy and instance grants; abort prevents writes; state JSON survives restart, stacks do not |
| Library | Resources + bundle 3 | Server owns resources; plugin identity/ownership checked; deployed nodes run independently of plugin |
| Plugin | API 2, package format 2 | Public SDK; iframe/RPC and server token are separate checks; host owns disposal; update hooks retain dataVersion |
| Permissions | Named capabilities / project policy | Server-enforced, deny unknown authority; scoped token cannot fall back to root token |
| Collections | Current CRUD/schema/versioned records, protocol 2 API | Optional independent platform service; 409 conditional-write conflicts, server schema validation; deployment preserves records |
| Storage | Current JSON + sidecars + redo journal | One writer/commit path; folder lock, recovery/quarantine; errors remain visible |
| Browser state | Current localStorage structures | Client owns preferences, installed packages and environment projections; endpoint/tab credential affinity |

Resource ownership: HTTP owns streams/heartbeats/watcher and credentials; Backend owns writers/hooks/history;
execution owns runtime hosts/controllers; Script host owns worker bridge requests; workflow page owns W/Inspector
cleanup; plugin host owns frames/commands; PluginViews owns UI registrations; Environment owns abort controllers,
SSE retries and scoped credentials. Failure/restart behavior is covered by lifecycle, security, storage-integrity,
runtime-robustness, environments and real browser suites. See [Architecture](../ARCHITECTURE.md).
