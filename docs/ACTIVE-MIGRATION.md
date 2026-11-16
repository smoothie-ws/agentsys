# Active product migration

Goal remains active; acceptance is not yet complete.

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
