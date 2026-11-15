# AgentSys MVP finalization

Date: 15 November 2026. Baseline: `8eeb31e4887f7f32a377cbc4df5c43379a07edf8`.

## 1. Executive summary

Implemented an incremental hardening/refactoring cycle over the existing split client/server platform. Fixed a
confirmed Script host-realm escape, scoped plugin requests retrying as the operator, passive plugin HTML
dispatching host commands, Windows public-file classification bypasses, credential lifecycle races, unfinished
network responses and failed-save environment switches. Added 22 Node regression tests and expanded real-browser
security/navigation checks. No AI functionality, graph execution quotas or new runtime dependencies were added.

The existing product already has an independent server and a static client. Browser-only execution and server
plugins were removed before this task; they were not reintroduced. Existing graph/API contracts remain intact.

This is a verified hardening cycle, not a claim of formal security proof, hostile multi-tenant isolation or a
complete rewrite. Active source size is essentially unchanged; retired executable code was removed. Exact
measurements and remaining limitations follow.

## 2. Architecture and ownership

| Responsibility | Module | Boundary |
|---|---|---|
| HTTP composition, routes, auth policy, notifications | `server.js` | Adapts HTTP to the application service; no file-layout implementation |
| Canonical graph files, script/layout sidecars, redo journal, external-change fingerprints | `server/file-store.js` | `get`, `commit`, `keys`, `scan`; no HTTP, credentials or presentation |
| Session and plugin bearer credentials | `server/credentials.js` | Per-server private maps, expiry, issuance, revocation and cleanup |
| Public assets and client security headers | `server/static-assets.js` | Shared by both static launchers; no backend execution dependency |
| Cached storage and request contexts | `js/storage/db.js` | Memory or injected store; no IndexedDB, fetch, BroadcastChannel or EventSource fallback |
| Application service and interpreter | `js/backend/*`, `js/model/executor.js` | Server manifest only; never loaded or served to the browser |
| Remote transport and environment generations | `js/app/environments.js` | One request path, explicit credentials, cancellation, SSE and stale-result rejection |
| Sandboxed extension RPC and registrations | `js/app/extensions.js` | Owns sandbox lifecycle and requests |
| Passive extension content | `js/app/plugin-content.js` | HTML/CSS validation and owner-scoped command decoration |

`tests/architecture.test.js` now applies the no-browser-API rule to the DB adapter too. It still enforces fixed
server/browser manifests, no client imports into execution, a single client transport and acyclic Node imports.
The old `legacy/server-plugin-host.js` and `legacy/routes-plugins.js` were unused and are removed. Migration
continues through `server/migrate.js`; old implementations remain in git history. User data was not removed.

## 3. Source measurements

Reproduce with `node tools/source-metrics.js --ref <baseline>` and `node tools/source-metrics.js`. Full inventories
are [metrics-before.json](metrics-before.json) and [metrics-after.json](metrics-after.json). Counts include blank
lines/comments consistently. Tests, tools, SDK declarations, dependencies, user data and generated catalog
`js/backend/builtin-nodes.js` are excluded from application source. Retired code is reported separately.

| Metric | Before | After |
|---|---:|---:|
| Active handwritten application source lines | 30,660 | 30,667 |
| Retired executable source lines | 407 | 0 |
| Active + retired handwritten source | 31,067 | 30,667 |
| Active source files (JS, CSS, HTML) | 86 | 90 |
| JavaScript source files | 76 | 80 |
| Relative CommonJS dependency edges | 15 | 20 |
| `server.js` | 1,353 | 851 |
| `js/app/extensions.js` | 1,506 | 1,414 |
| `js/storage/db.js` | 192 | 83 |

Net removal including retired code: **400 lines (1.29%)**. Active source grew by seven lines as security checks
offset most removed duplication. This is not a substantial active-source reduction and must not be presented as one.
Four cohesive modules replace implicit ownership, rather than adding a forwarding layer or DI framework.
The increased explicit require count is expected from this extraction; the dependency graph remains acyclic.

Largest remaining files: extensions 1,414; graph editor 1,405; canvas CSS 1,383; inspector 1,348; canvas renderer
1,082. The latter editing/presentation implementations were retained rather than rewritten without defect
evidence. Shared MIME/header/path rules now have one implementation; obsolete browser storage branches and
unused transport bookkeeping are gone.

## 4. Confirmed defects and regressions

| Defect/root cause | Implemented correction | Evidence |
|---|---|---|
| Node timer argument errors crossed into the Script VM as host objects; their constructor exposed the host realm | Coerce and validate timer arguments in the Script realm; rebuild host callback errors as realm-local errors | New real-Worker regression failed before the fix (`typeof process` was `object`) and passes afterwards |
| Scoped 401 could renew an operator session and retry without the scoped auth override | Scoped errors preserve their code and never take the owner renewal path; owner retries preserve explicit request options | `environments.test.js`, `plugin-sandbox.test.js` |
| Equal-grant plugins shared a credential, so one plugin could revoke another's token | Cache/issue by sandbox owner, environment and capability set; join concurrent issuance | `environments.test.js` |
| Issuance failures silently fell back to owner auth; issuance could finish after disposal or a server switch | Fail closed except explicit 404 compatibility; validate lifecycle after await; revoke late credentials; abort requests | `plugin-sandbox.test.js` |
| Delayed expired responses could revoke a token already renewed by another request | Reuse the newer sandbox token instead of refreshing again | Concurrent-expiry regression |
| Editing a saved URL could transfer credentials between different servers; reconnect kept the old URL | Bind tab credentials to exact URLs, migrate legacy keys before edits, never prefill token forms, use guarded switching on URL-changing reconnect | Two credential-affinity/reconnect regressions |
| Logout URL arguments were reversed and the caught exception hid the missing logout request | Construct the actual server logout URL | Logout-request regression |
| Removing a server could send revocation credentials to the new active URL | Retain the issuing URL in each credential entry | Original-URL revocation regression |
| Failed edit flush was swallowed; an older delayed switch could win | Propagate failures, honour leave guards and check switch revision before changing authority | Save-veto and delayed-switch regressions |
| Windows case variants bypassed a case-sensitive server-only filename pattern | One resolver classifies normalized paths, rejects dangerous spellings and validates realpath too | Both static launchers, case/dot/space/stream paths and symlink regressions |
| Plugin HTML could forge `data-ext-command`/host action attributes and bypass the RPC command-owner check | Strip reserved data attributes before decorating validated own-command buttons | Browser attacker/victim command test; own commands still work |
| Passive content could carry active templates/SVG/media or obfuscated resource-loading CSS | Remove active elements and restrict resource-bearing/escaped/comment-obfuscated CSS | Browser sanitizer and CSS attack tests |
| Rejected redirect/declared oversize bodies remained open after clearing their timeout | Abort in `finally`; destroy failed pinned input and decoder | Real upstream servers intentionally leaving bodies unfinished |
| Slow SSE subscribers could retain an unlimited outgoing queue | Disconnect on backpressure and let reconnect refresh authoritative state | Lifecycle HTTP integration with simulated full write buffer |
| Spoofed X-Forwarded-For prefixes bypassed proxy sign-in throttling | Use the rightmost address appended by the configured final proxy | Spoofed-prefix regression |
| Malformed redo types could partly apply before failing; unrelated malformed filename escapes could break scanning/startup | Validate the entire transaction first; ignore undecodable external filenames | Storage integrity regressions |
| CRLF checkout text differed from shipped package checksums | Normalize source text to LF in the packaging tool | Both original failures fixed; LF/CRLF reproducibility regression |

Storage watcher commit fingerprints remain scoped to changed keys. Old revision markers are pruned after a
completed scan, preserving protection for commits that race with that scan.

## 5. Security model and remaining risks

The discovered host-realm escape is critical and fixed. URL-bound owner credentials, scoped credentials, host UI command dispatch and
static file serving are enforced at their actual boundaries, with regressions. Scripts still require current
instance grants and project policy; no grants were widened. Server token/auth, secret substitution/redaction,
SSRF controls, DNS pinning and quarantine tests remain enabled. There are no third-party npm runtime packages
to upgrade or audit in the application manifest.

Use supported Node LTS, preferably 24. Node 20 is EOL according to the
[official release schedule](https://nodejs.org/en/about/previous-releases). Both local Node 20.17.0 and an isolated
Node 24.22.3 binary were tested; the latter was downloaded from nodejs.org and checked against its official SHA-256
manifest. The user's system installation was not replaced. CI now targets Node 22/24 on Linux and Windows.

Worker/VM capability checks are not an OS sandbox. Node explicitly states that
[`node:vm` is not a security mechanism](https://nodejs.org/api/vm.html). The repaired bridge does not establish
the absence of every possible V8/VM escape. Hostile multi-tenant execution requires OS isolation and resource
controls outside this single-operator MVP. Operator credentials intentionally retain broad authority; network
egress restrictions are opt-in. Older servers returning 404 for plugin tokens retain host-only enforcement.
A credential issued by the server but lost before its response reaches the host cannot be revoked by value;
it expires under the server TTL/token-map cap. Plugin CSS may still affect host presentation. These are disclosed limits, not guarantees silently added here.

## 6. UI/UX

Loading views expose `aria-busy` and are inert until the current render completes. Controls from the previous
page cannot be operated while a new page is pending. A delayed response cannot overwrite a newer route.
Switching/removing servers runs save/leave guards; a failed save preserves the current environment and edits.
Native unload handling sets both cancellation and a nonempty legacy return value.

Kept the existing visual identity. Reviewed desktop/mobile/disconnected screenshots and graph geometry tests;
no large visual redesign was justified. Browser checks cover desktop 1440, tablet 1024 and phone 390 widths,
named controls, headings, overflow, keyboard search/navigation, graph add/connect/run, undo/redo, runtime state,
reloads, plugin pages and disconnection. [Screenshots](screenshots/) are from isolated test data.

The installed Windows headless Firefox build suppresses native unload dialogs even on an independent empty
page with user activation and a cancelling handler. The test detects and explicitly reports this environmental
skip; the real AgentSys handler must still cancel unloading a dirty form. Chromium/WebKit native confirmation
is required and verified. This does not claim native Firefox dialog coverage on this machine.

## 7. Plugin system

Package validation, dependency checks, activation ordering, failed-start cleanup, update/migration rollback,
private storage, deployment idempotency and deactivation were preserved and exercised. Added owner-isolated
credentials, cancellation, late-issuance cleanup, scoped renewal and passive-content separation. Five reference
plugins passed the platform scenario: UI contributions, notifications, Library nodes, collections, templates,
dependency failure/recovery, two independent servers and execution after the browser/plugin is gone.

Plugins remain client-only. They cannot install server hooks or routes. Completed ordinary server operations
are not rolled back when their initiating plugin is disabled.

## 8. Execution, persistence and remote operation

No live-interpreter execution semantics changed. Existing tests cover repeated Run, independent dispatches,
fan-out/join ownership, more than 1,000 signals/deep chains, live self-editing/deletion, nested scopes, cache
invalidation, Pause/Resume, Stop, durable state and restart without JavaScript resumption. New resource behavior
concerns HTTP/SSE/plugin lifecycle, not limits on graph duration/depth/concurrency/results.

Supported modes remain separate local client/server, remote Node backend, direct TLS and combined local test
server. The API-only backend still runs without clients. Remote browser scenarios verify reconnection,
multi-client visibility, environment isolation, durable restart and plugin-independent execution. TLS, CORS,
Host, session and permission checks run in the Node suite.

Persistence remains synchronous canonical JSON plus sidecars and a redo journal. Malformed records are isolated
before writes. A valid redo encountering an OS write failure can still partially apply and be retained as
`.transaction.json.invalid` for repair. This is not database-grade power-loss atomicity or JavaScript-stack
resumption. Backup/restore and failure-injection tests remain in the suite.

## 9. Verification and measurements

| Command/scenario | Result |
|---|---|
| Initial `npm test`, Node 20.17.0 | 413 tests: 410 pass, 2 checksum failures, 1 POSIX skip; 18.86 s |
| Final `node --test`, Node 20.17.0 | 435 tests: 434 pass, 0 fail, 1 POSIX skip (timing in verification.json) |
| Final `node --test`, Node 24.22.3 | 435 tests: 434 pass, 0 fail, 1 POSIX skip (timing in verification.json) |
| `python tests/browser_suite.py`, Node 24 servers | 7/7: platform, plugin_security, editor, ux, execution_ui, shell, design |
| `python tests/browser_ux.py firefox` | UX checks pass; independent-probe-confirmed native unload dialog skip described above |
| `python tests/browser_ux.py webkit` | UX checks pass, including native unload confirmation |
| `python tests/browser_plugin_platform.py` | Five-reference-plugin platform/lifecycle/deployment scenario passes on Chromium |
| `git diff --check` | Clean |

Before/after stress measurements use the baseline archive and the working tree on the same Windows machine,
Node 20.17.0, 300 reads, 40 runs, 500 collection records and a 600-node graph. Raw JSON is in
[performance-before.json](performance-before.json) and [performance-after.json](performance-after.json).

| Workload | Before | After |
|---|---:|---:|
| API read median / p95, ms | 0.57 / 1.36 | 0.56 / 1.34 |
| Graph run median / p95, ms | 27.72 / 40.16 | 27.19 / 29.78 |
| Collection write median / p95, ms | 5.43 / 6.61 | 5.35 / 7.40 |
| 600-node graph save, ms | 1396.89 | 1655.69 |
| 600-node graph read median / p95, ms | 17.34 / 21.19 | 20.72 / 24.79 |
| Stop under load, ms | 20.40 | 23.15 |
| Heap before / after GC, MB | 5 / 11 | 5 / 11 |
| Run failures / running runtimes after Stop | 0 / 0 | 0 / 0 |

These individual runs do not establish a speedup. Graph save/read and Stop were slower in the second sample;
no performance improvement is claimed and no speculative interpreter optimization was made. Existing resource
tests pass; representative heap and error counts remain stable. A bounded soak result is recorded in
[soak.json](soak.json): Node 24, 60 seconds, 192 cycles, zero errors, all 192 Workers terminated/exited,
zero active runtimes/streams, heap 7 to 13 MB (maximum 13 MB). Per-request timing arrays are omitted from the
summary. This is not a 24-hour endurance claim.

## 10. Documentation and contracts

Updated README, architecture/code guide, client/server/environment/deployment guides, security/permissions
context, runtime persistence caveats, decisions, plugin lifecycle/security/UI/packaging and testing instructions.
Root historical reports point to this report. Added a reproducible source inventory tool and CI matrix.

No graph format, Script API, route shape or public SDK method was removed. Intentional restrictions:
plugin CSS cannot hide loading tokens through escapes/comments; passive HTML cannot carry host action attributes
or active embedded content; token issuance fails closed except an explicitly unsupported endpoint. Deprecated
server-plugin executable source was removed without changing migration or user data.

## 11. Remaining limitations

- No formal sandbox proof, hostile multi-tenant hosting, OS container or global memory quota.
- No new browser-only backend or server plugin host; these were already retired product modes.
- No Linux service/proxy/public-certificate deployment was performed here. CI configuration is updated, not
  claimed to have run remotely. Windows POSIX mode check remains skipped.
- Native Firefox unload confirmation is unverified in this headless build; application cancellation and native
  Chromium/WebKit dialogs are verified.
- No 24-hour soak, statistically rigorous performance conclusion or complete coverage proof.
- Active code size did not substantially shrink; some cohesive graph/UI files remain large.
- Single-operator credentials, opt-in egress policy, volatile sessions/undo and JSON journal recovery retain the
  explicitly documented product limits. A failed valid redo may need operator repair.

No known confirmed critical/high defect discovered in this cycle is left unfixed. This statement is limited to
the inspected boundaries and tests above; it is not a guarantee that every vulnerability has been discovered.
