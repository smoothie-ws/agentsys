# Final architecture engineering report

Status: **NOT READY** while remote CI and the repeated performance investigation are pending.

Baseline commit: `6d9d623e6cd19db726be293ec03e0e5962183d3d` (current origin/main at task start).
Final implementation commit: `a462071` (canonical architecture `0a745c8`; terminal shutdown `a462071`).
Documentation and verification commits follow this implementation; delivered HEAD is recorded in Git history.
Work branch: `refactor/mvp-architecture-finalization`.

The platform now has one HTTP API implementation in server/api-server.js, an independent static Client,
unchanged universal interpreter, and Plugin API 2 / package format 2. Removed mechanisms include combined root
hosting, `/__data` and its SSE format, `/editor` API aliases, server UI-state endpoints/bootstrap, retired
server-plugin migration CLI/code, tracked old plugin sources, one-off raw-storage graph conversion and
unsupported package conversion. No user data was deleted, rewritten or migrated by this work.

Terminal shutdown now rejects queued/in-progress commits and keeps the data folder locked until writers,
hooks, runtimes and connections finish. The interpreter and current JSON/sidecar formats remain unchanged.
Canvas/Inspector W remains the active page's presentation state with explicit page cleanup; splitting it was
not justified. Collections remain an optional independent API used by current plugins.

Client fixtures and tools now exercise separate programs. Plugin security/lifecycle checks use current API
fixtures; modern private-data migrations remain supported. Normalized format 2 exports preserve package icon
metadata, and Integration Studio / Graph Developer Tools generated packages were updated reproducibly.
Server protocol is 2 because deprecated public routes were removed. Graph text remains agentsys.text/1 and
Library bundles remain version 3. Public SDK declarations accept API 2 only.

See [Inventory](INVENTORY.md), [Decisions](DECISIONS.md), [Dependencies and contracts](DEPENDENCIES.md),
[Before/after and performance](BEFORE-AFTER.md), [Verification](VERIFICATION.md) and [Architecture](../ARCHITECTURE.md).

Local verification: Node 445 PASS, 0 FAIL, 1 Windows skip; Chromium 9/9; Firefox 4/4; WebKit 4/4.
Remote matrix and the initial slower plugin/layout timings remain under investigation. No claim of complete
architectural readiness is made until those checks are resolved.

Defined architectural limits: classic-script manifest ordering remains; static checks do not infer every
dynamic/global call dependency. Workers/VM are not an OS sandbox. Durable JSON survives restart, JavaScript
stacks do not; no automatic workflow resumption is introduced. This is a single-operator platform, not a new
multi-user authorization system. Historical audits are retained, explicitly labeled as evidence at baseline
commit `6d9d623`; no unique security evidence was deleted. Future work should add application plugins through
the public SDK and existing server resource contracts, preserving the enforced trust boundaries.
