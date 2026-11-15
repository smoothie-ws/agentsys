# AgentSys Plugin Platform Release Candidate

Certification date: 2026-11-15 (Asia/Vladivostok). Implementation commit:
`f8d733360ca91fb6b2bb64bc6e5610a02f8806e6`, branch `certification/plugin-platform-rc`.
Source: `66b3b06a6c4124164a1889c20a246957f566f0d4` on `refactor/architecture-simplification`.

The clean source branch was eight commits ahead of `main`; its architecture changes were retained.
The initial local baseline was 442 passed, zero failed, one Windows-only POSIX-permissions skip (443 tests).
Final local Node regression: 459 passed, zero failed, the same skip (460 tests). No test was disabled or weakened.

The [API inventory and interaction map](docs/plugin-rc-contract.md) distinguishes implemented SDK operations,
shared server data, private client storage, intentional omissions and compatibility requirements.
The [engineering report](PLUGIN-RC-REPORT.md) records fixes, evidence and the release decision.

## Certification matrix

Test filenames below are in `tests/`. Each PASS is backed by an executed test, not source inspection alone.

| Area | Requirement | Test / actual result | Implementation | Status | Residual limit |
|---|---|---|---|---|---|
| SDK contract | Public API supports two independent application classes | `plugin-sdk.test.js`, `browser_plugin_certification.py`: both packages activate and render | [SDK](sdk/agentsys-plugin.d.ts), [contract](docs/plugin-rc-contract.md) | PASS | No plugin shortcut registry, host DOM or raw secret API |
| Package validation | Standalone reproducible package; safe paths and manifest | `plugin-manifest.test.js`, `plugin-packages.test.js`: formats 1/2, bad inputs and independent product packages pass | [Manifest](js/app/plugin-manifest.js), [CLI](tools/plugin-pack.js) | PASS | FNV is an accidental-edit fingerprint, not cryptographic authenticity |
| Install/Update/Uninstall | Preserve data, require approval, recover failed activation | `plugin-lifecycle.test.js`, platform and certification browser tests: install, update, cancel, reload, recovery, uninstall/reinstall pass | [Store](js/app/plugin-store.js), [host](js/app/extensions.js) | PASS | App-defined migration effects are not rolled back transactionally |
| Dependency management | Reject missing, cyclic, incompatible and disabled dependencies | Manifest/lifecycle Node tests and platform browser dependency recovery pass | [Manifest](js/app/plugin-manifest.js) | PASS | No remote dependency download or marketplace |
| Capability enforcement | Enforce host, API and runtime/project-policy boundaries | Capability/token/permissions tests; browser negative writes/net/secrets/auth tests pass | [Host classification](js/app/plugin-capabilities.js), [server](server.js), [runtime permissions](js/backend/permissions.js) | PASS | Coarse family grants deliberately expose shared server resources |
| Token isolation | Per-plugin identity, revocation, expiry; failures cannot select owner authority | `environments.test.js`, `plugin-sandbox.test.js`, `plugin-tokens.test.js`; browser unsupported-endpoint check pass | [Transport](js/app/environments.js), [credentials](server/credentials.js) | PASS | Old or identity-unaware servers require upgrade; browser-close revocation cannot guarantee network delivery |
| Resource ownership | A second plugin cannot spoof ownership or mutate foreign Library data | Real HTTP negative tests cover forged create/update, raw replace/delete, move, editor, folders and grants; unchanged data asserted | [Backend boundary](js/backend/runtime.js), [Library routes](js/backend/routes-library.js) | PASS | Owner-authenticated clients retain administrative editing authority; reads remain shared |
| UI extension points | Pages, sidebar, dashboard, toolbar, menus, Inspector, resources, dialogs/settings | Platform A/C/D and certification selection/Inspector/form tests pass | [Views](js/app/plugin-views.js), [content sanitizer](js/app/plugin-content.js) | PASS | Passive HTML; no direct canvas internals |
| Library integration | Script-backed Custom Nodes, ports, persistence and server execution | Deployment tests; six integration stages execute successfully | [Library](js/backend/routes-library.js), [Integration package](client-plugins/integration-studio/plugin.json) | PASS | Typed signal and HTTP text ports; structured configuration/result ports carry generic JSON |
| Collections integration | CRUD, validation, migration, optimistic concurrency and retained records | Collections, deployment and platform C tests; authenticated integration persistence pass | [Collections](js/backend/routes-collections.js) | PASS | Shared data, not plugin-private; schema changes do not automatically migrate old records |
| Secrets handling | Secret values remain on server; metadata and substitution require named grants | Token/security tests, platform D, authenticated Integration Studio local fixture pass | [Permissions](js/backend/permissions.js), [Integration](client-plugins/integration-studio/main.js) | PASS | Plugin cannot provision secret values; configuration uses `secretName` because secret-valued fields are redacted from Script API replies |
| Network integration | Host capability, egress/private-network policy, timeouts and response limits | Permission/security/resource suites and browser synthetic HTTP scenarios pass | [Network routes](js/backend/routes-permissions.js) | PASS | Shipped integration permits local fixture hosts; other hosts require an approved manifest change |
| Environment isolation | Separate credentials, data, deployments and URL edits | Environment/lifecycle tests; both products switch independent servers and retain separate resource IDs | [Transport](js/app/environments.js), [scoped storage](js/app/plugin-store.js) | PASS | Legacy local data binds once to its originally saved server address |
| Multi-client compatibility | Graph remains usable without plugin; versions cannot silently downgrade deployments | Platform browser two-client version scenario, deployment downgrade tests, fresh-client certification read/export/install pass | [Deployment](js/app/plugin-deploy.js), [graph API](js/backend/routes-workflow.js) | PASS | Same plugin ID deliberately shares ownership across clients; collection migrations remain application responsibility |
| Headless graph execution | Close client, execute saved integration graph over HTTP, persist and reconnect | Certification: six ordered stages with server bearer secret, persisted result, mobile reconnect pass | [Integration stages](client-plugins/integration-studio/plugin.json), existing graph runtime | PASS | Project owner must separately approve runtime policy |
| Deployment recovery | Preview, retry partial work, preserve user edits and old graphs | `plugin-deploy.test.js`: plan is read-only, interrupted deployment recovers, no duplicate resources, edited-node conflict, saved workflow preserved | [Deployment](js/app/plugin-deploy.js), [server conflict guard](js/backend/routes-library.js) | PASS | Nonatomic; legacy nodes without a content baseline require owner review and explicit redeployment; early interruption can leave an empty project |
| Sandbox security tests | Negative tests at iframe/host/server boundaries | Sandbox/token/capability tests plus platform E and browser security scenarios pass | [Iframe](js/app/plugin-frame.js), [host](js/app/extensions.js), [content](js/app/plugin-content.js) | PASS | Trusted owner modifications and malicious browser extensions are outside this boundary |
| Integration Studio | Real product using SDK only, UI, data, Library, workflow and persistence | Certification Chromium/Firefox/WebKit: connection form/check, secret, build/retry, two servers, headless/reconnect pass | [Product](client-plugins/integration-studio/README.md) | PASS | First saved connection; demonstration transform returns `ok`, `path`, timestamp |
| Graph Developer Tools | Graph analysis, selected elements, context action and Inspector | Unit graph test + certification page/selection/Inspector/export/reload/two-server checks pass | [Product](client-plugins/graph-developer-tools/README.md) | PASS | Analysis uses serialized snapshots and server diagnostics; no canvas mutation access |
| Browser compatibility | Plugin platform/security/products on Chromium, Firefox, WebKit; mobile layout | Three plugin browser suites; full local Chromium 9/9; Firefox/WebKit UX and certification pass | [Browser runner](tests/browser_suite.py), [workflow](.github/workflows/ci.yml) | PASS | Reload scenario waits for the restored view to settle; cancellation races are covered separately in sandbox/environment tests |
| Node regression suite | Storage, runtime, security, deployment and architecture regression | Local 459 PASS / 1 platform skip; supported-version remote results recorded below | [Tests](tests/), [POSIX storage fix](server/file-store.js) | PASS | Local Node is 20.17; supported Node 22/24 are independently checked in CI |
| GitHub Actions | Publish branch and verify all four Node jobs plus all three browser jobs | [Run 43692551394](https://github.com/smoothie-ws/agentsys/actions/runs/43692551394): all seven jobs completed successfully | [CI](.github/workflows/ci.yml) | PASS | Exact implementation SHA and job steps retained in [CI evidence](docs/audits/plugin-rc/ci-results.json) |
| Documentation | A developer can build a working starter using published instructions | Starter package renders and its command persists data in certification; standalone package checks pass | [Quickstart](docs/plugin-development.md), [starter](examples/hello-plugin/), [RC contract](docs/plugin-rc-contract.md) | PASS | SDK is injected, with optional TypeScript declarations; no runtime npm dependency |

## Lifecycle metrics

Ten certification cycles disable both products, assert zero iframes, actual host message listeners, commands,
UI contributions, pending callbacks/requests and live server tokens, then enable exactly two sandboxes/listeners.
The platform scenario separately runs twenty UI Showcase cycles and tests a hung iframe's stop/recovery.
Chromium samples heap after explicit GC before and after the bounded cycle test; the log records both values.
Firefox/WebKit heap telemetry is not available in this harness. This bounded exercise is not a long-duration leak proof.

## Remote release gate

The implementation commit was independently verified in [GitHub Actions run 43692551394](https://github.com/smoothie-ws/agentsys/actions/runs/43692551394): all four Node jobs and all three browser jobs succeeded.
Linux ran all 460 Node tests without a skip; Windows retains only the existing POSIX-specific skip.
The browser jobs executed plugin platform, independent-product certification and security scenarios on all engines.
Earlier failed runs informed the fixes and are not counted as successful releases.

**Verdict: READY WITH LIMITATIONS.** The required scenarios pass, with the explicit compatibility, migration,
shared-data and nontransactional deployment limits recorded above. The report/evidence commit contains no runtime
changes; its subsequent branch CI run is also checked before delivery.
