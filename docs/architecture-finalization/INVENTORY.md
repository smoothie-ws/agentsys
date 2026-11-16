# Architecture inventory

Baseline: `6d9d623e6cd19db726be293ec03e0e5962183d3d` (origin/main, Plugin RC merge).
The initial worktree was clean. Work branch: `refactor/mvp-architecture-finalization`.

Classification applies to logical components, including all files below each listed directory.
The ordered classic-script manifests are dependencies; absence of a CommonJS import is not evidence of dead code.

| Component | Class | Consumers, state owner and lifecycle | Decision / evidence |
|---|---|---|---|
| shared/core.js, shared/protocol.js | PLATFORM | Browser and server; pure contracts, no mutable application state | Keep; architecture and API contract tests |
| js/model/graph.js, types.js, storage/format.js | CORE | Both manifests; lookup, bindings, type rules and canonical text serialization | Keep shared pure behavior; graph-format, types and format-property tests |
| js/model/schema.js, documents.js, editor.js, snapshot.js | CORE | Server manifest; request Context owns persisted graph changes | Keep; graph mutation, custom, exchange and concurrency tests |
| js/model/evaluate.js, executor.js | CORE | Server runtime; per-workflow runtime owns scopes, signals and cancellation | Keep semantics; engine, controls, scope-emit, onread and robustness suites |
| js/backend/scripts.js | CORE | Runtime owns worker invocations and abort cleanup | Keep worker/VM boundary; script, security and permissions tests |
| js/backend/runtime.js, execution.js | CORE | Backend owns runtime map, eviction and durable state | Keep; lifecycle, restart, execution and soak tests |
| js/storage/db.js, server/file-store.js | PLATFORM | Context serializes writers; file store owns disk, sidecars, stamps and redo journal | Keep one commit path; storage-integrity, concurrency and backup suites |
| js/backend/settings.js, resources.js, permissions.js | PLATFORM | Server owns settings, Library resources and effective grants | Keep; permissions, resource and library tests |
| js/backend/routes-*.js | PLATFORM | Backend route table; HTTP and checked Script callers | Keep current routes; audit old UI-state endpoints separately |
| js/backend/routes-collections.js | OPTIONAL | Independent server API used by Integration Studio and structured-data plugin | Keep outside interpreter; platform, plugin-deploy and browser certification |
| js/backend/builtin-nodes.js, graph-nodes.js | CORE | Generated Library definitions used by backend and export tools | Keep; builtin, flow/data nodes and graph-primitives tests |
| headless.js, server/manifest.js | PLATFORM | Server owns fixed VM context and script order | Keep; no UI imports or plugin discovery |
| server/credentials.js | PLATFORM | Server owns session and scoped-token maps, expiry and revocation | Keep; security, plugin-tokens and lifecycle tests |
| root server.js | LEGACY | API wrapper, tests/server, security/storage tests, migration, browser_server and smoke/bench tools | Move API implementation to server/api-server.js; remove combined static hosting and raw storage after migrating consumers |
| server/api-server.js (baseline wrapper) | REDUNDANT | Canonical CLI and most integration suites; delegates to root server | Replace wrapper with sole implementation; do not create another HTTP engine |
| server/static-assets.js | PLATFORM | Static client CLI; public-file and symlink boundary | Keep; migrate combined-server security assertions to static client |
| bin/agentsys-server.js, agentsys-client.js | PLATFORM | Independent CLI processes own sockets and shutdown handlers | Keep; deployment, TLS and browser suites |
| bin/agentsys-local.js, start.bat | OPTIONAL | Local convenience; spawns independent server/client processes | Keep orchestration; no second backend |
| server/migrate.js, tests/migration.test.js, legacy/README.md | LEGACY | Only migrate CLI and migration tests reference the removed server-plugin architecture | Remove retired command and tests of that command; retain current-data recovery tests |
| data/plugins tracked sources | LEGACY | Old server-plugin examples; browser_server copies AI files unnecessarily | Stop shipping source only; preserve all local user data and configuration |
| js/app/environments.js | PLATFORM | Sole server transport owns generation, requests, SSE and credential affinity | Keep; environments and browser platform/security suites |
| js/app/helpers.js, preferences.js, shell.js, router.js, nav.js, tabs.js, notifications.js | PLATFORM | Browser shell owns navigation, preferences and views; events dispose on page change | Keep loaded files; remove legacy routing only after browser fixtures migrate |
| js/app/plugin-*.js, extensions.js | PLATFORM | Store owns installed records; host owns frames/commands; views owns contributions; transport owns scoped tokens | Keep trust boundaries; simplify supported package forms with fixture updates |
| sdk/, tools/plugin-pack.js | PLATFORM | Public types and package validation; no private UI objects in SDK | Keep API 2 and reproducible package tools |
| js/app presentation helpers, js/pages/* | PLATFORM | Shell loads all via index.html; page-local UI state and handlers | Keep; architecture manifest audit finds no unloaded interface modules |
| js/canvas/*, js/inspector/inspector.js | PLATFORM | Active workflow page owns W; Inspector and Canvas consume its presentation indexes | Retain shared page state unless lifecycle defect is demonstrated; not a second graph authority |
| css/*, index.html | PLATFORM | Static browser assets; dynamic classes and data attributes | Keep; selectors cannot be classified dead from imports alone |
| client-plugins/reference/*, integration-studio, graph-developer-tools, examples/hello-plugin | OPTIONAL | Manifest/tool loaded public-SDK packages; browser owns frames, server owns deployed resources | Keep and run certification; no server execution of plugin modules |
| tests/browser_smoke.py, browser_plugins.py | LEGACY | Excluded from default browser suite; target removed browser-only/server-plugin modes | Remove after confirming no CI references |
| tools/simplify-request.js | LEGACY | One-off mutation through /__data; no package script, test or launcher consumer | Remove; current Library API replaces raw edits |
| tools/* other benchmarks, backup, soak, stress, export | OPTIONAL | Explicit developer CLIs and tests; disposable data except explicit backup/export targets | Retain and migrate canonical launchers |
| docs/audits/*, root certification reports | OPTIONAL | Historical evidence, referenced by current reports | Retain with explicit historical labeling; do not erase unique security evidence |

No UNCERTAIN module is removed. Runtime/format caches and graph representations serve different persistence,
execution and presentation boundaries; size alone is not a reason to split or replace them.
