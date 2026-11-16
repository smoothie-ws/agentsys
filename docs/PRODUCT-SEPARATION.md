# Product separation progress

Status: **NOT SEPARATED**. This is an intermediate implementation, not acceptance of the complete migration.

## Verified source

Baseline: `5f916bf24bea3a10a0566c68992f1eacb79a999a`.
GitHub heads checked before changes: architecture branch at baseline; main at
`6d9d623e6cd19db726be293ec03e0e5962183d3d`.
The local checkout was clean. The architecture branch was used.

## Dependency audit

`separation-dependencies.json` inventories relative CommonJS edges. Browser scripts
are explicitly enumerated by index.html; server VM scripts by server/manifest.js.
The CommonJS inventory alone is not a complete dependency graph.

| Module | Consumers | Ownership / required treatment |
| --- | --- | --- |
| shared/core.js | browser globals, server VM, credentials/API | Mixed helpers, validation and capability policy; separate client presentation from authoritative server validation |
| shared/protocol.js | both CLIs, API, credentials, browser transport | Wire constants plus coupled application version; replace with independently owned adapters against a formal contract |
| js/storage/format.js | browser import/export, server VM/file store | Public serialization with executable implementation; specify schemas and fixtures before separating implementations |
| js/model/graph.js | browser editor, server VM | Mixed graph representation and operations; preserve semantics and establish fixture parity |
| js/model/types.js | browser type presentation, server VM | Presentation and type semantics require separate ownership |
| server/manifest.js | headless loader, architecture checks | Server runtime list; client static hosting no longer imports it |
| server/static-assets.js | legacy test imports | Compatibility re-export; implementation moved to client/static-assets.js |

Server-only: server API/credentials/file-store, headless loader, js/backend,
js/storage/db, model executor/editor/snapshot/evaluate/schema/documents.
Client-only: HTML/CSS, js/app/pages/canvas/inspector, client plugins and SDK.

## Implemented boundary change

The client CLI now imports client/static-assets.js. That module imports only Node
built-ins and a reviewed exact public-file manifest. Unknown files cannot become
public by being dropped under js/ or docs/. Traversal, symlink and Windows path
checks remain enforced. Existing server/static-assets.js is a compatibility shim
for integration tests; the API server does not serve GUI files.

`npm run build:client` produces dist/client. The build refuses an existing output
instead of deleting files. It copies only the reviewed manifest, rejecting
nonregular files and symlink paths. No server runtime or build dependency is
included. This artifact can be hosted as static files; current default environment
behavior remains unchanged and needs the runtime configuration work below.

## Verification

Baseline `node --test`: 446 tests, 445 pass, 1 skipped, no failures.
After static boundary changes: 15 targeted architecture/static/build tests passed.
The build test creates an isolated artifact, resolves all listed assets, checks
absence of backend/data/interpreter, rejects an accidental JS file, and exercises
SPA fallback. Browser E2E, remote CI and performance comparisons were not run.

## Remaining phases

1. Formal OpenAPI, JSON schemas, SSE/concurrency semantics and route parity tests.
2. Independent server and client implementations for the mixed modules above.
3. Independent application versions with API-major compatibility and feature discovery.
4. Runtime public config, explicit first-connection UI, cross-origin lifecycle verification.
5. Separate history-preserving repositories, package manifests, SDK distribution,
   Docker/systemd/static-host deployment instructions and independent release CI.
6. Artifact-only integration runner and all requested E2E scenarios A–G.
7. Remove product sources from integration workspace only after validated extraction.

No new repositories, remote pushes, releases or independent product commits have
been created. No FULLY SEPARATED claim is made.

Final local regression run after changes: 447 tests, 446 passed, 1 skipped, 0 failed (37.2 seconds). Full TAP output: separation-test-results.txt. Intermediate commits: audit 85df8f7; static boundary 0a203a9.
