# AgentSys architecture

AgentSys consists of an independent execution Server, a static browser Client, shared contracts and a public Plugin SDK.

```text
Browser UI / sandboxed plugin
    -> Environment transport (HTTP + session/bearer + SSE)
    -> Server authentication and scoped capability checks
    -> Backend route table and serialized request Context
    -> Graph runtime / Script worker / canonical file store
```

## Components and ownership

| Component | Responsibility and state owner |
|---|---|
| shared/core.js, shared/protocol.js | Pure helpers, errors, capabilities and protocol 2 |
| server/api-server.js | Sole HTTP API, Host/Origin/CSRF checks, authentication, SSE and server shutdown |
| server/credentials.js | In-memory sessions and scoped plugin identities; expiry and revocation |
| headless.js, server/manifest.js | Fixed server VM script order, no UI or plugin discovery |
| js/backend/runtime.js and routes | Checked API calls, writer queue, per-client undo and hooks |
| js/model server modules, backend/execution.js and scripts.js | Graph validation, snapshots, scopes, signals, runtime state and workers |
| js/storage/db.js, server/file-store.js | Request transactions, canonical JSON, sidecars, redo recovery and disk-change fingerprints |
| js/app/environments.js | Sole browser transport, generation cancellation, endpoint-bound credentials and SSE |
| js/app, pages, canvas, inspector | Browser shell, navigation and graph presentation |
| js/app/plugin-store.js, extensions.js, plugin-frame.js, plugin-views.js | Installed records, sandbox lifecycle/RPC, iframe SDK and rendered contributions |
| sdk/, tools/plugin-pack.js | Public API 2 declarations and format 2 packaging |

`bin/agentsys-server.js` owns the API process. `bin/agentsys-client.js` serves public static assets through
`server/static-assets.js`; it has no backend. `bin/agentsys-local.js` spawns both programs.
Classic scripts use explicit manifests, not ES-module imports. The browser loads shared lookup/type/format
helpers, never graph mutation, snapshot construction or interpreter implementations.

## Request and execution flow

A page calls `api()`, which delegates to Environment. The transport binds the request to the selected server
and its generation. HTTP validates credentials and permissions, then dispatches through Backend.request.
Context reads and commits under one writer queue. Errors are `{error:{code,message}}` with HTTP status;
conflicting versions return 409. OpenAPI is generated from the actual routes at `/api/openapi.json`.

The server builds a graph snapshot and owns each workflow runtime. Signals propagate through the interpreter;
data lookup and nested Custom Node scopes preserve their existing semantics. Script workers receive checked
bridges with project policy and instance grants. Pause gates continuations; Resume releases them; Stop aborts
work and preserves JSON. Saved graphs execute without a client or an installed plugin. Restart restores JSON,
outputs and previews; it does not restore JavaScript stacks or automatically rerun programs.

## Storage and lifecycle

Definitions, Library resources, policies, Collections and secrets live below `--data`. Graph definitions use
`agentsys.text/1`, with layout and Script sidecars. Runtime JSON is separate from definitions. One file-store
commit path writes temporary files and a redo record; restart replays or quarantines an invalid record.
External edits invalidate caches through fingerprints. Browser preferences, environment lists and installed
plugins stay in browser storage; credentials are bound to an endpoint and tab.

Shutdown stops admission, marks the backend closing, prevents queued/in-progress request commits, stops
runtimes, drains writers and hooks, closes streams/connections, and releases the folder lock last. Repeated
close calls share one shutdown Promise. Client disconnection does not stop a server workflow.

Canvas and Inspector intentionally share the active workflow page's `W`. It owns transient presentation indexes,
selection and camera. The page resets it and owns leave guards, subscription/timer cleanup and execution-session
tracking. It is not another persistent graph authority. No lifecycle defect requiring another state abstraction
was established in this audit.

## Plugin host and trust boundaries

Only Plugin API 2 / package format 2 is supported. Normalized formatVersion 2 records are the browser's internal
storage representation. Plugin data migrations on current-version updates remain supported. Iframes run with
sandbox/CSP; RPC checks ownership/capabilities, and server-scoped tokens independently enforce permissions.
PluginViews owns UI contributions; navigation and page lists are projections. Disposal releases registrations,
frames and scoped credentials. Switching environments aborts the old generation and rejects late responses.

Plugins may extend UI and deploy ordinary Library nodes, workflows and Collections through the public SDK.
They cannot register server routes or load code in the server. Collections are an optional generic API used by
reference plugins and Integration Studio, with no interpreter dependency.

Trust boundaries remain Browser -> Server, iframe -> Host, Host -> Server and Script worker -> Server. VM
isolation is not an operating-system sandbox. Deployment must retain the documented HTTPS/authentication and
egress controls. Independent checks across these boundaries are intentional.

## Contracts and invariants

See [Public contracts](architecture-finalization/DEPENDENCIES.md), [Graph model](graph-model.md),
[Script API](script-api.md), [Storage](storage.md), [Permissions](permissions.md) and [Plugin SDK](plugin-sdk.md).
Protocol 2 removes obsolete UI-state and combined-server routes. Graph/storage formats are unchanged.
There is no combined launcher, raw browser storage API or server-plugin migrator.

Server executes; Client manages and observes. All browser server operations use Environment. Server never loads
Client plugins or UI; Client never imports the interpreter. Permissions remain server-enforced. Each resource
has an owner and cleanup path. Endpoint generations never share credentials or runtime state. Public plugin
contracts contain serializable data, not private UI objects. Architecture tests enforce these boundaries.
