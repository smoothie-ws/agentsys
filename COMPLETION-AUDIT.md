# Completion audit

Status: **FULLY SEPARATED**. All twenty acceptance requirements are verified.
The original main branch is integration-only; both independent releases and the
latest product/integration CI runs passed. Machine audit: integration-results/completion-audit.json.

## Product identity and provenance

Baseline: `5f916bf24bea3a10a0566c68992f1eacb79a999a`, original architecture branch.
Both product repositories retain full ancestry and the `migration/source-5f916bf`
tag. No force push or remote replacement was used.

| Product | Version | Release/source commit |
| --- | --- | --- |
| [Server](https://github.com/smoothie-ws/agentsys-server) | 0.4.1 | `62789987a3e303f940c94ebf3ec8cb8275b3c86d` |
| [Client](https://github.com/smoothie-ws/agentsys-client) | 0.7.0 | `83835ea0d77b1e35fe3e972a1dd7205b97f730be` |
| Client Plugin SDK | 2.0.0 | declarations package in Client release |
| Public API | 2.0 | canonical OpenAPI 3.1 and JSON schemas in Server |

## Acceptance requirements

| Requirement | Authoritative evidence |
| --- | --- |
| 1. Independent Git repositories | Separate remotes, main branches, commits and preserved ancestry above |
| 2. Independent package and release lifecycle | Each package.json; independent tag-triggered release workflows; release artifacts |
| 3. Independent CI | Product CI snapshots in integration-results/ci-status.json; Node 22/24 on Linux/Windows |
| 4. Server works without Client | Server-only Docker CI creates a project/workflow, runs a Script, restarts container and verifies saved result |
| 5. Client works without Server | Independent browser_static.py in all three engines; disconnected boot and unavailable-server error |
| 6. Remote Server connectivity | Configurable absolute HTTP(S) environment URLs, cross-origin installed-artifact tests, container HTTP tests and TLS regression suite |
| 7. Server serves no GUI | Product-boundary tests; package audit; container /index.html returns 404 |
| 8. Client contains no backend | Product-boundary tests; public manifest; npm/static ZIP audit |
| 9. No shared executable dependency | No shared directory, workspace or cross-root imports; independent JSON conformance fixtures |
| 10. Web API is the only interaction | Closed relative-import checks; installed CLI processes communicate through REST/JSON and authenticated SSE |
| 11. Versioned formal contract | api/openapi.json, api/schemas, API.md and api/README.md; route parity and independent OpenAPI validation |
| 12. Independent updates | Synthetic patch matrix: Client-only, Server-only, both; incompatible major rejection/recovery |
| 13. Cross-origin CORS/auth | Exact-origin preflight, unlisted-origin refusal, Bearer/browser sessions and credential isolation |
| 14. Authenticated SSE | Second browser client receives changes; heartbeat comparison and reconnect tests |
| 15. Client plugins | Library Pack, Integration Studio, Graph Developer Tools; original malicious-plugin browser security suite |
| 16. Published nodes execute without Client | All browsers close before Library and Integration Studio execution; saved output/collection result verified |
| 17. Graph Engine regression protection | Server tests: 347 total, 346 passed, one Windows permission test skipped locally; Linux/Windows CI |
| 18. Existing data/formats | Existing untracked data untouched; restart persistence; canonical graph/script/layout/Unicode/runtime fixtures and randomized format tests |
| 19. Security guarantees | Auth/CSRF/Host/Origin, permissions, scoped tokens, sandbox, network-policy, storage-integrity and TLS suites; original malicious browser test |
| 20. Independent and integration CI green | Latest matching product and main implementation commits passed every job; ci-status.json and completion-audit.json |

## Named artifacts and commands

Server owns README.md, ARCHITECTURE.md, INSTALLATION.md, API.md, SECURITY.md,
DEPLOYMENT.md, Dockerfile, OpenAPI/schemas and its own tests. CLI start/status/version
are covered by deployment tests. Node-only install and unprivileged container
operation are verified; systemd instructions are provided rather than claiming a
systemd service was installed on this Windows workstation.

Client owns README.md, ARCHITECTURE.md, INSTALLATION.md, API-INTEGRATION.md,
PLUGINS.md, BUILD.md, SDK documentation/tests, independent static build and CLI.
The static client uses hash routing and works on ordinary hosting. Production
nginx/Caddy header examples preserve the existing plugin framing/CSP policy.
config.json is public and contains no credentials. User environments override
deployment defaults; no localhost/same-origin environment is forced.

The integration repository owns COMPATIBILITY.md, INTEGRATION-TESTS.md, this audit,
artifact-only tests, tools/local.py and start.bat. There is no combined package.
The launcher installs two artifacts in separate prefixes and starts two processes.
Original product source trees have been removed from main. The transition was a
normal fast-forward preserving all original ancestry.

## Scenarios A–G and boundaries

A: server-only container HTTP execution and restart persistence. B: standalone
static browser tests and public runtime config. C: independent processes/origins,
authenticated stream and container transport. D: two clients, concurrent conflict,
SSE broadcast and tab identity/token isolation, including one browser profile.
E: two servers, credential/data isolation and switching; unit tests also verify
aborted requests and stale-answer rejection. F: installed Integration Studio
publishes six stages; explicit owner policy; headless HTTP/transform/store result.
G: independently upgraded synthetic patch artifacts plus incompatible-major
artifact rejection/recovery. Synthetic versions are test artifacts, not releases.

No graph execution algorithm, UI framework, database, server plugin system,
Electron/Tauri layer, API proxy or new shared runtime package was introduced.
Storage/graph model paths moved to Server runtime ownership. Client owns its
presentation/editing/serialization implementations and static serving. Capability
validation remains authoritative on Server; plugin Host checks add browser-side
containment without replacing server enforcement.

## Performance and practical limits of evidence

Final measurements use Node 24.22.3 and downloaded release tarballs whose digests
match the E2E inputs. Uncompressed baseline source installation was 10,188,705
bytes, Server 769,710 bytes and Client 937,028 bytes. Baseline included development
and test files; no independent Client distribution existed. The final static
Client distribution is 923,645 bytes. Browser JavaScript was 661,266 -> 647,233
bytes; line-ending normalization contributes to this difference.

Server RSS was 67,026,944 -> 57,536,512 bytes; static CLI RSS 60,035,072 ->
48,201,728 bytes; browser heap 2,890,800 -> 2,871,840 bytes. API p50 was
1.107 -> 1.314 ms and p95 15.439 -> 16.250 ms. Cold Server startup was
555.74 -> 589.57 ms; static CLI startup 68.16 -> 73.49 ms; browser connection
272.22 -> 267.77 ms. These single-run samples are sensitive to caching/GC and
establish neither a statistically significant speedup nor a leak. Both SSE
connections stayed up across a 21-second heartbeat interval. Methodology and
remaining fields are in integration-results/performance.json.

The local POSIX file-mode test is skipped on Windows and runs in Linux CI.
Systemd documentation was delivered; no systemd service was installed on this
Windows workstation. Synthetic patch versions are test artifacts, not releases.
Published assets were downloaded and checked against GitHub SHA-256 metadata.
The API ZIP matches the contract in the Server package; the Client ZIP matches
its exact public-file manifest; the SDK contains declarations/README/metadata.
