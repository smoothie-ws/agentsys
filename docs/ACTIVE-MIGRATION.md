# Active product migration

Migration completed: **FULLY SEPARATED**. Final evidence is in ../REPORT.md and ../COMPLETION-AUDIT.md. The entries below are chronological work records.

Local history-preserving repositories:
- ../agentsys-server, main d35840eb2ebf562da0fa1c75b91b4fba450d3def
- ../agentsys-client, main 86c7284b8d09462dbe14caf80ae44d6bd41c0b9c

Both retain original ancestry and migration/source-5f916bf provenance tag. Neither
has an origin remote yet. No remote repository was created or pushed.

Server runtime is owned under runtime/; GUI and client plugin source are absent.
Client owns js/app/core.js and protocol.js and has no backend/interpreter/storage.
Client authoritative manifest and CLI import client-owned static serving only.

Verified: server extraction suite 281/281; client suite 83/83; new canonical API
contract tests 2/2. API 2.0 covers 71 route paths and is served verbatim from api/.
Server application 0.4.0, client application 0.7.0. Both have independent Node
22/24 Linux/Windows CI definitions. Local server npm pack and client build/pack
succeeded. CI has not been run remotely.

Next required work:
1. Complete schemas/fixtures and client API-major tests; public runtime config,
   no forced localhost or same-origin environment on first install.
2. Repeated-build behavior, independent CLI packaging and clean installation tests.
3. Artifact-only integration tests A-G, browser/security and performance evidence.
4. Server/client deployment documents, Docker/systemd/static hosts and SDK release.
5. Recover remaining applicable tests from integration tree without weakening them.
6. Convert this original checkout to integration-only after validating both products;
   retain history, add artifact launcher/Compose, compatibility matrix and results.
7. Final requirement-by-requirement audit, remote creation if capability available
   or documented owner instructions if not. Do not claim completion prematurely.

Migration helper scripts in tools are one-time migration records, not build-time
or cross-product dependencies. Do not rerun extraction against existing targets.

## Artifact validation update

Client main now fa41869. It has public config.json, optional defaultServerURL,
no forced localhost/same-origin environment, disconnected first boot and guarded
server calls. CLI supports `serve`, imports package metadata rather than excluded
source, and serves dist/client from installed npm package. Default rebuild is
repeatable with checked fixed output path. First successful connection after an
offline boot now initializes the full application.

Client regression suite: 85/85. tools/artifact-smoke.py installs server/client
tarballs via npm into separate temporary prefixes, starts their installed CLIs,
checks HTTP discovery, creates and reads a project/workflow, checks CORS preflight,
loads Chromium disconnected, connects across origins using bearer credentials,
verifies initialized app and no page errors, then restarts server and verifies
persistence. All 15 checks passed. Evidence is integration-results/artifact-smoke.json
and connected.png; isolated packages/logs retained at the path recorded in JSON.

This smoke test does not yet prove execution, SSE delivery, plugins, simultaneous
clients, multi-server switching or other browser engines. Those remain required.

## Extended integration and regression update

Artifact-only E2E now passes in Chromium, Firefox and WebKit. Evidence:
integration-results/{chromium,firefox,webkit}-extended.json. It proves authenticated
SSE to a second client, distinct tab IDs, simultaneous conditional-write conflict,
CORS rejection of unlisted origins, Library Pack and Integration Studio sandbox
installation/resource deployment, credential and data isolation across two servers,
reconnection to the original server, headless execution after every browser closes,
expected Library-node output, and persistence across server restart.

Server main: 6822ab9; client main: 0f66185. Restored additional original regressions
and split mixed tests into their owning product. Server full suite: 345 tests,
344 pass, 1 skip, no failures. Client full suite: 104 pass. Local default Node is
20.17.0; supported Node 22/24 and Linux CI still need execution/verification.
New architecture tests inspect relative require paths, package dependencies,
symlinks, manifest ownership and absence of the other product implementation.
Both products have independently stored public graph/capability JSON conformance
fixtures and tests. Root installation/architecture/API/plugin/security/deployment
and build guides now exist. Server Dockerfile added; Docker has not been tested.

Remaining: complete API entity schemas and stronger fixtures, independent-update
E2E/incompatible API major, runtime config browser test, no-client execution A and
Integration Studio workflow F in full, performance comparison, independent browser
CI/release ZIP/SDK artifact validation, actual GitHub remotes/CI if available,
local artifact launcher, integration-only tree conversion, complete final audit.
Migration helper scripts are historical one-time records; do not rerun them.

## Remote CI and delivery update

Both remotes now exist, same visibility as original source:
https://github.com/smoothie-ws/agentsys-server
https://github.com/smoothie-ws/agentsys-client
Main branches pushed without force. Server at ef2b7d4; client at 94308d1.
Independent GitHub CI succeeded for server b82038f (run 43826846853) and client
94308d1 (run 43826888365): Node 22/24 Linux/Windows; all three client browser jobs.
Local Node 24 also passed server 344+1 skip and client 104 tests.
OpenAPI 3.1 passes openapi-spec-validator. Added named entity/auth/discovery schemas.

Independent tag-triggered release pipelines produce npm artifacts, static ZIP and
SDK tarball for client, API ZIP and Docker image archive for server. No release
has been tagged/published yet. Server Docker build succeeded remotely; initial
container readiness check hit a startup connection reset. The bounded readiness
retry now handles resets; ef2b7d4 CI is pending and MUST be checked.

Added independent static browser/config tests and client pretest/prepack builds.
Added tools/local.py artifact-only two-process launcher; local smoke succeeded,
log in integration-results/local-launcher.log. Root COMPATIBILITY.md and
INTEGRATION-TESTS.md added. Artifact runner supports explicit artifact paths and
Node executable overrides for CI. Current CI evidence is ci-status.json; it is a
snapshot, not proof of the newest server commit until refreshed.

Pending npm Node22 download session 30266 may still exist; remote Node22 evidence
already passed, so local download is not required. Do not restart on timeout.

Next: validate latest container CI, strengthen independent-update/incompatible
major and full Integration Studio execution scenarios, performance baseline,
release artifact verification, artifact-only integration CI, final conversion of
original tree to integration-only (products already safe in own committed remotes),
and requirement-by-requirement completion audit. Keep goal active.

## Integration-only conversion and final-scenario update

Original checkout is now on refactor/product-separation and contains no product
source tree. 381 tracked monolith files were removed with Git history intact;
user data, node_modules and other untracked files were not removed. README and
start.bat now launch independent artifacts. tests/integration-boundary.test.js
passes and prevents reintroduction of active product trees or a combined package.
The integration CI checks out pinned product commits solely to produce tarballs;
its E2E runner installs them in separate prefixes and has no source imports.

Full Integration Studio scenario passed: install/deploy, create a six-stage graph
via sandbox Host API, explicitly grant owner execution policy, close all clients,
execute HTTP/transform/store workflow on the server and verify saved records.
Evidence: integration-results/studio-e2e.json. Independent synthetic patch-update
matrix passed client-only, server-only and both updates; each run also launched a
separate incompatible-major server artifact, observed explanatory rejection and
recovered by switching back. Matrix evidence: independent-updates.json and its
retained per-run directories. These synthetic versions were not published releases.

Performance evidence: performance.json. One-host descriptive measurements only,
no statistically significant speedup claim. Baseline source installation 10.19 MB;
server npm installation 0.79 MB; client npm installation 0.96 MB. Baseline had no
independent client dist. Browser JS bytes roughly unchanged (661266 -> 661887).
SSE remained connected across one 21-second heartbeat interval on both versions.

Server-only container CI passed at ab606cd (run 43828755752), including meaningful
workflow execution and persisted result verification after docker restart.
Client 60682c3 CI run 43828767493 passed all seven jobs. Canonical API contract now
includes its own discovery path (72 paths); server latest d92a2a7 CI is pending.
Integration branch has not yet been pushed or merged. No releases tagged yet.
Remaining work: verify integration CI and newest product CI, release artifacts
and SDK integrity, integration default branch transition without force/history
loss, inspect all original requirements in a final audit, address any omissions.

Integration checkout fix: actions/checkout treats abbreviated SHAs as branch names;
client pin now uses its full commit SHA. Latest integration branch 8d41984 is pushed;
new workflow must be verified. Product main commits d92a2a7 and 60682c3 both have
successful independent CI (latest product results in ci-status.json). Original
origin/main is an ancestor of integration HEAD, so a future verified transition
can fast-forward without rewriting history. Do not update main until integration
checks and final acceptance audit pass. Release tags still not created.


## Final verified state

Server 0.4.1: 62789987a3e303f940c94ebf3ec8cb8275b3c86d.
Client 0.7.0: 83835ea0d77b1e35fe3e972a1dd7205b97f730be.
API 2.0; SDK 2.0.0. Both GitHub releases and all product CI/release workflows
passed. Server patch 0.4.1 fixes the discovery limit to match its existing 20 MB
enforcement. Main integration CI 43851420888 passed all three engines at 34bef63.
Published archives were downloaded and hashed; E2E/measurement input hashes match
them. Static ZIP hosting without an AgentSys CLI/backend passed all three engines.
The original main branch is integration-only, advanced by normal fast-forward.
All original user data remains untouched. Final acceptance audit passed; no
required implementation or verification work remains.
