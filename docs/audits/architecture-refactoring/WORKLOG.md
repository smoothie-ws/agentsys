# Architectural refactoring

Starting point: `ba4bca8`, a checkpoint of the previously uncommitted MVP hardening work. Branch:
`refactor/architecture-simplification`. No user changes discarded. AI integrations are outside scope.

## Structural audit and implementation decisions

The runtime uses ordered global scripts, not importable ES modules. Consequently CommonJS imports alone
understate coupling. The dependency map below includes global dependencies and lifecycle ownership.
Every active source file is inventoried in metrics-before.json; generated builtins remain separately counted.

| Subsystem / files | Responsibility and public interface | Dependencies / authoritative state / lifecycle | Decision |
|---|---|---|---|
| bin/*, server/api-server, headless, server/manifest | CLI configuration, API/combined/static startup; createApiServer/loadBackend | Node; one VM/backend and process per data folder; manifest controls server code | Preserve entry points; keep transport and domain separate |
| server.js | HTTP routes, auth/Host/CORS/CSRF, SSE, legacy storage compatibility | credentials, file-store, backend service; owns HTTP subscribers/watch interval | Consolidate SSE lifecycle; keep legacy public endpoints compatible |
| server/credentials | Sessions and scoped credentials; issue/revoke/lookup | per-server private maps, expiry and shutdown | Preserve independent security boundary |
| server/static-assets | Asset allowlist, path classification, headers | filesystem, manifest; no domain state | Extend boundary to forbid mutation implementation in browser |
| server/file-store, migrate | Canonical text/JSON, sidecars, redo journal, fingerprints and migration | filesystem, TextGraph; one authoritative data folder | Preserve transaction validation/recovery |
| shared/core, protocol | Pure errors, grants, protocol names | environment neutral; no owned lifecycle | Keep shared contract small |
| js/storage/db, format | Cached store/Context and graph serialization | injected store, TextGraph; Context owns pending transaction | Preserve graph format and commit semantics |
| model/schema, types, snapshot, documents | Graph invariants, types, snapshots and durable shape | pure domain; caller owns document; TypeTable cache per definition set | Remove unused domain implementation from browser manifest |
| model/editor | Mutating graph operations including copy/paste/Library refresh | domain document, schema, types, snapshot; Call owns/discards failed edits | Retain operations, move read-only lookup out of Editor |
| model/evaluate, executor | Graph view, scopes, reads and concurrent signal execution | snapshot; runtime owns execution state/caches/tasks | Preserve interpreter; isolate read-only lookup without changing Worker semantics |
| backend/runtime | Route table, writer lock, Call contexts, history, Library reconciliation/hooks | DB, Editor, execution; per-client history, request-local document drafts | Retain serialized mutation boundary; avoid extra service wrappers |
| backend/execution, scripts | Workflow runtimes, persistence, cancellation, Worker bridge | executor, DB, checked API; runtime/Worker owns tasks and Stop | Preserve concurrency, realm and permission regressions |
| backend/permissions, routes-permissions | Script/scoped authorization, secrets, egress, quarantine | route metadata, DB, DNS; security boundary independent of UI checks | Do not merge client and server authorization policies |
| backend/routes-* | Projects, workflows, exchange, resources, collections, notifications, settings | Call and domain operations; no HTTP/DOM; persisted through Context | Public routes and serialization remain compatible |
| backend/resources, settings, builtin-nodes, graph-nodes | Resource validation, preferences, built-in Library definitions | pure/domain helpers and fixed route registration | Generated catalog excluded consistently; no code moved into it |
| app/environments | Only remote transport; requests, sessions, SSE, generation guards | protocol/fetch/browser storage; generation owns requests/tokens/stream | Keep one authority and explicit URL affinity |
| app/helpers, preferences | UI preferences, API facade, browser app state | Environment; local UI store distinct from remote caches | Remove redundant request serialization and promise scheduling where safe |
| app/router, shell, nav, tabs, mobile | Bootstrap, navigation, leave guards and layout | app, PAGES, Environment, Extensions; route owns view disposal | Preserve stale-route/save veto behavior |
| app/plugin-store, manifest, capabilities, deploy | Package validation/storage/dependencies, host permission preflight, deployment | browser storage, checked API; package/owner/environment scopes | Keep package and scoped request boundaries |
| app/extensions, plugin-content | Plugin lifecycle, iframe document/RPC, contributions, presentation/sanitization | PluginStore, Environment, content boundary; sandbox owns requests/registrations | Split independent iframe program; replace mirrored contribution registries with one owner |
| app/dialogs, popup, notifications, code-editor, color-picker, markdown, type-ui | Forms/autosave, menus, notifications, presentation controls | DOM, UI store/API; form/popup owns cleanup | Consolidate repeated controls; retain visual behavior |
| pages/* | Presentation of server resources, settings, environments and plugins | API, app caches, page helpers; route owns subscriptions/forms | Do not let pages construct backend state except documented import packet |
| canvas/page, data, run | Open workflow lifecycle, snapshots and runtime projection | API; W owns current page, server owns persisted graph/runtime | Keep indexes derived from snapshot; do not mirror mutating Editor |
| canvas/interaction, commands, selection, menus, wires | Input gestures, selection and API edits | W, camera, geometry; gestures own pointer capture, API owns mutations | Preserve history and batch semantics |
| canvas/render, camera, hints | DOM reconciliation, geometry, viewport/minimap/hints | snapshot and W-derived caches; renderer owns DOM/geometry caches | Consolidate repeated controls and keep geometry pure where possible |
| inspector/inspector | Selection, property forms, connection editing, permissions | W, API, form/type helpers; Inspector owns autosave jobs | Consolidate repeated port editing infrastructure rather than split singleton |
| css/*, index.html | Visual behavior, responsive rules, ordered client bootstrap | DOM classes and tokens; no execution | Audit exact duplicate rules and obsolete overrides, preserve cascade |

### Dependency map

```text
static client CLI -> static-assets -> server-only classification (no backend)
index -> shared protocol/core + graph reading/types + app/pages/canvas/inspector
UI -> api facade -> Environment -> HTTP protocol
plugin package -> opaque iframe RPC -> host capabilities -> Environment scoped request
HTTP -> credentials + application Backend -> Call/Context -> Editor/domain -> DB -> file-store
Backend -> runtime -> interpreter -> Script Worker -> checked Backend operations
file-store -> TextGraph; domain has no filesystem/HTTP/DOM dependency
```

Implicit coupling: ordered global manifests; W shared by canvas and Inspector; app resource/project caches
invalidated through SSE; Extensions currently couples sandbox RPC to nine mutable contribution arrays.
These are more consequential than the acyclic CommonJS graph. No framework migration is justified.

### Priorities / verification

1. Establish reproducible source/browser payload/dependency/duplication baseline and performance samples.
2. Make graph lookup a small read-only contract; stop shipping unused mutation/snapshot construction code.
3. Give plugin contributions one registry and cleanup owner; isolate the iframe program from host internals;
   remove repeated registration/render infrastructure while preserving SDK and all capability checks.
4. Consolidate repetitive UI controls/Inspector editing, remove proven redundant state/implementation and
   exact CSS duplication. Assess Editor/server individually; do not rewrite interpreter without evidence.
5. Run full Node/browser regressions and comparable performance samples; update architecture/report/metrics.

Targets are elimination of duplicate mechanisms and unused browser implementation, a material net active-source
reduction, fewer overlapping mutable registries and no new forbidden edges/cycles. No arbitrary line quota.

## Progress

- Baseline Node suite: 435 tests, 434 pass, 0 fail, 1 platform skip, 16.82 seconds (Node as installed).
- Baseline source inventory and representative stress measurement recorded before application edits.

- Boundary/plugin/UI checkpoint: 439 Node tests (438 pass, 1 platform skip); full browser suite 7/7. The browser now loads only graph reading contracts and types, never Editor/schema/snapshot/document mutation or execution-view implementations. Views have one authoritative registration list, failure state one error map, SSE one subscriber map. Focused static-serving tests pass for the expanded boundary.
- One initial browser run exposed a test wait racing a pending Run; the condition now includes pending starts (runActive). SSE backpressure injection now starts after both handshake writes, since handshake writes also enforce backpressure. Neither regression assertion was removed.
- CSS audit found one overwritten declaration; consolidated it. Broad stylesheet churn is unsupported by the audit.
