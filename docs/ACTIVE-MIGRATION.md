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
