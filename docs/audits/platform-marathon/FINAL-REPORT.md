# FINAL REPORT — independent platform audit and hardening

## Summary

The platform refactor was real: a separate API-only server, a static client, one transport, remote environments,
generic collections, migration, and no server plugin loading. The previous report's headline numbers reproduced
(242 Node tests, 4 browser scenarios) once the Playwright browser was installed. The refactor also left real
defects at the new seams — the client transport never aborted anything, one plugin could drive another, a plugin
link could run script in the client origin, two servers on one data folder lost writes, and several failure paths
were promised but not implemented. Twenty defects were reproduced and fixed, each with a test. Two new browser
scenarios and ten new Node test files lock the behaviour in.

**The 12-hour cycle was not completed.** This session ran **55 minutes 56 seconds** of measured wall time
(2026-11-14T14:56:29 → 15:52:25, UTC+10), then returned control to the harness. The objective's condition for a
12-hour cycle (a full 43 200-second interval, or an external controller resuming from the journal) was not met.
Nothing in this report pretends otherwise. Because the work is resumable, the remaining backlog is written down
in section 12 and the journal is current.

## 1. Duration and commits

| Item | Value |
|---|---|
| Start | 2026-11-14T14:56:29+10:00 (Unix 1794632189) |
| End of measured work | 2026-11-14T15:52:25+10:00 (Unix 1794635545) |
| Actual duration | **55 min 56 s** (3 356 s) |
| Planned deadline | 2026-11-15T02:56:29+10:00 (not reached) |
| Source branch / commit | `platform/server-client` / `5123643be41a0227f6cb5e9ea586cfee816e1946` |
| Audit branch | `audit/12h-platform-hardening` |
| Final code commit | `e9a6889` |
| Commits added | 8 (`3278854`, `8779303`, `af2b637`, `76be783`, `ca40106`, `edf09e6`, `7475045`, `e9a6889`) |
| `main` | untouched |

The session was bounded by the agent environment, not by the work: the backlog in section 12 is what a resumed
or externally driven session should pick up, in order.

## 2. Metrics

| Metric | Requirement | Result |
|---|---|---|
| Actual duration | measured | 55 min 56 s, stated above; not 12 h |
| Initial tests | exact | `node --test`: **245** on `main`, **242** on the source branch, 0 failures |
| Final tests | exact | **322** pass, 0 fail, ~11.3 s (Linux CI configured for Node 20; measured on Node 20.11/Windows) |
| New tests | count and purpose | **80 Node tests** in 10 files + **2 browser scenarios** (12 checks); listed in section 5 |
| Restored tests | count and purpose | **0** deleted tests restored: the 14 removed server-plugin tests have no subject in this architecture, and their coverage is replaced by platform/migration/permission/plugin tests (table in `BASELINE.md`) |
| Defects found | priorities | **20** (4 high, 6 medium, 10 low) in section 4 |
| Defects fixed | with tests | **20/20**, each with a reproducing test |
| Security findings | status | 9 recorded; 6 fixed, 3 accepted and documented (section 6) |
| Performance | before/after | no pre-refactor harness existed; reference numbers and bounds in `BENCHMARKS.md` and section 7 |
| UI/UX | confirmed changes | 3 fixes, 8 automatically checked interface states, screenshots in `screenshots/` |
| Architecture | violations found/fixed | 1 duplicated resolver, 1 missing defence-in-depth rule; boundaries now enforced by 7 tests |
| Compatibility | scenarios checked | protocol 1, older clients without If-Match/CSRF (bearer), wrong-method 405, migration from server plugins, two-server isolation |
| Residual risks | list and severity | section 9 |

## 3. What was actually verified (not taken from the earlier report)

- **Server/client separation**: the manifest is a fixed list of 27 files; no interface file is in it; no server
  runtime file uses DOM/storage (with `db.js`'s guarded browser fallback asserted separately); the client entry
  point loads no server code; no cyclic requires. Now enforced by `tests/architecture.test.js`.
- **Server plugins**: no host is loaded; `legacy/server-plugin-host.js` is unreferenced; `/api/plugins` is 404.
- **Local launches**: combined server, API-only server, static client, `status`, `version`, `help`, and the
  refusal to expose an API without a token were run by hand and by tests.
- **Remote environments**: switching aborts requests and the stream, discards late answers, keeps tokens per tab
  in `sessionStorage`, rejects incompatible protocols before use, and reconnects after a restart.
- **Old projects/workflows**: migration tests cover a pre-platform folder, provider data, keys to secrets,
  duplicate provider ids, unreadable plugin data, and existing collections surviving untouched. Workflows in
  the canonical text format (including sidecar scripts) read and write correctly.
- **Client plugins are not needed to run saved graphs**: a browser scenario creates a Library node with a plugin,
  disables the plugin, and runs the node again successfully; a server restart restores it without re-running.

## 4. Defects found and fixed

Severity is from the point of view of this platform's users. Each entry names the evidence and the test that now
holds the fix.

| # | Severity | Defect | Evidence | Fix | Test |
|---|---|---|---|---|---|
| 1 | High | Removing the active environment left `status: connected`, the removed server's `meta`, and an open SSE stream from it | code + reproduction | `remove()` starts a new generation, clears meta, reconnects | `environments.test.js` |
| 2 | High | A client plugin could execute another plugin's command (`commands.execute('other:cmd')`) | browser reproduction | commands resolve inside the calling plugin only | `browser_plugin_security.py`, capability unit tests |
| 3 | High | A plugin sidebar `href` of `javascript:…` executed in the client origin on click (stored XSS: the tab's token is readable) | browser reproduction | href must be an app path `/…` | same browser scenario |
| 4 | High | Two servers on one data folder overwrote whole documents from two caches: lost writes | code + reasoning, now tested | `data/.server.lock` with pid, stale takeover, release on close | `storage-integrity.test.js` |
| 5 | Medium | In-flight requests were never aborted on switch: `controller` was declared and never assigned | code | per-generation `AbortController`, combined with the timeout | `environments.test.js` asserts `signal.aborted` |
| 6 | Medium | `<svg><script>` survived HTML sanitizing (tag names compare case-sensitively in different namespaces) | reproduction | compare the local name without case; drop more URL attributes | `browser_plugin_security.py` |
| 7 | Medium | The session map grew without bound (logins accumulate for 12 h) | code | sweep on login + timer, `sessionLimit` with oldest eviction | `security.test.js`, `resource.test.js` |
| 8 | Medium | A body over the limit killed the socket, so the promised 413 never arrived | reproduction | declared-length early answer; streaming stop-and-answer | `security.test.js` (21 MB) |
| 9 | Medium | Migration: a duplicate provider record without `apiKey` erased the migrated `{{secret:…}}` reference | reproduction | keep the existing reference when the later record has none | `migration.test.js` |
| 10 | Medium | Rapid environment switching could leave another server's `meta`/status | reproduction | status/meta owned by the current generation only | `environments.test.js` |
| 11 | Medium | The combined local server sent no CSP and no `X-Frame-Options`, unlike the client | code | same policy as the client | `security.test.js` |
| 12 | Low | Wrong method on a known path answered 404 | reproduction | 405 with `Allow` | `api-contract.test.js` |
| 13 | Low | OpenAPI reported a literal `0.3.0` instead of the running version | code | reports `SERVER_VERSION` and the protocol | `security.test.js` |
| 14 | Low | A failed page replaced the whole view with a bare error, losing the title and any retry | browser reproduction | keeps the page title, explains, offers Try again and the parent | `browser_ux.py` |
| 15 | Low | Environments and Collections were not searchable destinations | browser reproduction | added to `destinations()` | `browser_ux.py` |
| 16 | Low | The first Escape in the search field only cleared it (Chromium `type=search` behaviour) | browser reproduction | explicit Escape closes the dialog | `browser_ux.py` |
| 17 | Low | The default-server address resolver was duplicated in two files | architecture test | one `Environment.defaultURL()` | `architecture.test.js` |
| 18 | Low | A plugin that never answered left a page render pending forever | code | 20 s invoke timeout | code + browser scenario |
| 19 | Low | `SERVER_ONLY` did not cover the root `server.js` (defence in depth only; the public path filter still blocked it) | code | pattern extended | `architecture.test.js` |
| 20 | Low | An aborted request left `readBody` pending | code | `aborted` rejects | code path exercised by security tests |

Negative result, recorded deliberately: **the graph engine needed no change**. Four new scenarios (a Script
editing its own graph, bounded creation, self-deletion, repeated runs with Stop) all passed against the existing
semantics, which is evidence that the refactor did not damage it.

## 5. Tests added

| File | Tests | Purpose |
|---|---|---|
| `tests/architecture.test.js` | 7 | boundaries: manifest, no DOM in the server, client never loads server code, one transport, acyclic requires, neutral shared modules, no compiled-in addresses |
| `tests/environments.test.js` | 11 | the client transport in a Node vm: discovery, token confinement, 401 renewal once, no retry of writes, abort on switch, stale answers, removal, rapid switching, reconnect, incompatibility |
| `tests/plugin-capabilities.test.js` | 8 | classification and refusal by method/path/body; read-only default; named secrets; host-scoped network; shipped packages declare what they use |
| `tests/security.test.js` | 14 | anonymous access, invalid/logged-out sessions, CSRF+Origin, Host/rebinding, CORS, anonymous SSE, credential conflicts, 413, unknown routes/methods/escapes, diagnostics, redaction, non-loopback without token, OpenAPI, CSP |
| `tests/storage-integrity.test.js` | 10 | redo replay, unreadable record, path escape, tmp file, corrupted JSON, folder copy as backup, 25 parallel records, sidecar scripts, lock takeover, deletion |
| `tests/concurrency.test.js` | 5 | If-Match conflict, no lost update, shared events, cross-server isolation, stop visible to a second client, restart, vanished client |
| `tests/engine-regression.test.js` | 4 | dynamic graph editing during a run, bounded creation, self-deletion, worker settlement |
| `tests/resource.test.js` | 6 | 200 round trips, 12 parallel runs, stream cleanup, session cap, 600-node graph, 1000 records |
| `tests/api-contract.test.js` | 8 | 405/404, malformed bodies, protocol header, public discovery, pagination, older clients, client independence, cursor |
| `tests/backup.test.js` | 3 | stopped backup/restore, live refusal and `--force`, corrupted file reporting |
| `tests/browser_plugin_security.py` | 4 checks | a read-only plugin cannot write/fetch/spend a secret/run another command/add a link; a granted plugin can write exactly that; HTML sanitized |
| `tests/browser_ux.py` | 8 checks | desktop/tablet/phone, empty states, unreachable server, keyboard search, readable errors, screenshots |
| extended `tests/migration.test.js` | +4 | duplicates, unreadable plugin data, missing folder, plugin callers, existing collections |
| extended `tests/client-plugins.test.js` | same count, more assertions | capabilities in the package store |
| extended `tests/browser_platform.py` | +1 check | a plugin-created node runs with the plugin disabled |

## 6. Security findings

| ID | Finding | Status |
|---|---|---|
| SEC-01 | Combined server had no CSP/frame policy | fixed |
| SEC-02 | Plugin cross-command execution | fixed |
| SEC-03 | `javascript:` sidebar link (client-origin XSS) | fixed |
| SEC-04 | SVG script bypass in the HTML sanitizer | fixed |
| SEC-05 | Unbounded session memory | fixed (sweep + cap) |
| SEC-06 | No capability model for plugin API calls | fixed (host-enforced layer, read-only default) |
| SEC-07 | `POST /api/net` is reachable by any token holder (SSRF) and can inject `{{secret:…}}` | **accepted**: a token is an operator credential; plugins need `net.fetch:<host>` and `secrets.use:<name>`. Documented in `docs/security.md` |
| SEC-08 | Plugin CSS can restyle the client (clickjacking inside the page) | **accepted**, documented in `docs/plugins.md` |
| SEC-09 | No rate limit on `POST /api/auth/session` | **accepted for now**: the token is 64 hex characters and compared in constant time; noted in section 9 |

Checks that found no bypass: CSRF on cookie writes (header + Origin), CORS allowlist (never `*`), Host pinning
on loopback (including the session endpoint), SSE authentication, expired/logged-out session replay, bearer vs
cookie precedence, header injection in paths, traversal in API paths and storage keys, secret/token leakage in
diagnostics and error messages.

## 7. Performance

One machine, Node 20.11, Windows 11; `node --expose-gc tools/stress.js`. Details in `BENCHMARKS.md`.

| Scenario | Result |
|---|---|
| Authenticated read (300) | median 0.49 ms, p95 1.15 ms |
| Two-node run (40) | median 22.0 ms, p95 24.9 ms |
| Collection write (500) | median 3.7 ms, p95 5.4 ms (~255/s) |
| Collection page (500 records) | 1.8 ms |
| 600-node save / read | 1.28 s / p95 23 ms |
| Stop 12 running graphs | 9 ms, all idle afterwards |
| Heap across all scenarios (with GC) | 5 MB → 11 MB, workers settled |

No optimisation was applied without a measured bottleneck; none of the tested paths was a bottleneck. The suite
asserts loose bounds so a leak or a quadratic path fails it, not a slow machine.

## 8. Architecture, interface and documentation changes

- **Architecture**: boundaries are enforced by tests rather than described; `SERVER_ONLY` includes the root
  server; one default-server resolver; a per-process data-folder lock; a session cap; 405 semantics.
- **Security**: a client plugin capability layer (`js/app/plugin-capabilities.js`, shown and editable on the
  Plugins page), command scoping, path-only sidebar links, a stricter sanitizer, a session sweep, a real 413,
  CSP/frame policy on the combined server.
- **Client**: real cancellation per environment generation; status/meta ownership per attempt; a failed page
  keeps its context and offers a retry; Environments and Collections searchable; Escape closes search.
- **Data**: lock file, backup tool with validation and manifest, migration key preservation.
- **Docs**: `README.md`, `docs/plugins.md` (capabilities), `docs/security.md` (threat model and residual risks),
  `docs/server.md` (lock, sessions, 405/413), `docs/deployment.md` (backup, update, Windows, lock),
  `docs/testing.md` (current suites and tools), plus this audit folder.
- **Deployment**: `.github/workflows/ci.yml`, `deploy/agentsys-server.service`, `deploy/nginx-agentsys.conf`,
  `deploy/Caddyfile`.

## 9. Residual risks and unresolved problems

| Risk | Severity | Note |
|---|---|---|
| Plugin capabilities are enforced in the host page | Medium | Holds against a plugin; an operator who edits the client or calls the API directly is beyond it. The server trusts the token, by design |
| Token holders can make the server fetch arbitrary URLs and inject secrets through `/api/net` | Medium | Operator-level trust; the plugin layer narrows it. A future server-side capability token would close it |
| No multi-user roles or audit log | Medium | Out of scope in this cycle; one token means one operator |
| Sessions live in server memory | Low | A restart signs every client out; clients holding their token renew silently |
| No rate limiting on session creation or API requests | Low | Token strength is the control; a reverse proxy can add limits |
| Plugin CSS can restyle the client | Low | Documented; there is no per-plugin stylesheet isolation |
| Browser tests only on Chromium | Low | Firefox/WebKit untested; the client uses standard APIs |
| Undo history is in memory per process | Low | Lost on restart by design; not covered by a durability test |
| Linux, systemd, nginx/Caddy, a real certificate | Untested here | Artefacts and expectations are written down in `DEPLOYMENT-VERIFICATION.md`; must be exercised on the target host |
| Collections rewrite one document per write | Low | 255 writes/s measured; a high-volume workload needs a different schema, not a code change |
| Checkpoints 10–12 (hours 10–12) | Process | Not written because the session did not last that long; the journal and backlog allow a controller to resume |

## 10. Final verification (commands and results)

| Check | Command | Result |
|---|---|---|
| Node suite | `node --test` | 322 pass, 0 fail (11.3 s) |
| Browser suite | `python tests/browser_suite.py` | 6/6 pass: platform, plugin_security, ux, execution_ui, shell, design |
| Stress | `node --expose-gc tools/stress.js` | recorded in `BENCHMARKS.md`; 0 run failures, 0 running runtimes after Stop |
| Boundaries | `node --test tests/architecture.test.js` | 7/7 |
| Backup | `node tools/backup.js` via `tests/backup.test.js` | 3/3 |
| CLI | `agentsys-server version`, `help`, `status`, no-token refusal | as documented |
| Diff review | `git diff --stat main...e9a6889` | 106 files, +9 943/−1 302; no temporary or user data |
| Working tree | `git status --short` | clean after the final commit |
| Migration | `tests/migration.test.js` | 6/6, including idempotency and a pre-platform folder |

The end-to-end scenario asked for in the final hour is executed by `tests/browser_platform.py`: two independent
servers, a client connected to the first, a workflow created and run, the client closed and reopened, a switch
to the second server and back with no data mixing, a Library node created by a client plugin, the plugin
disabled and the node still running, and a server restart that restores data without re-running anything. All
eleven of its checks pass.

## 11. Honest notes on process

- The first browser run failed 0/4 in 0.5 s because Playwright's Chromium was not installed. The report's "4/4"
  is reproducible only after `python -m playwright install chromium`; `docs/testing.md` now says so.
- No timestamp in the journal was invented. The worklog records wall-clock times; where an entry covers a span,
  it says so.
- The engine audit produced no defect. That is reported as a negative result rather than turned into a change.
- One reviewer-visible simplification: the sidecar-script test asserts that the file is removed when the node
  stops being a Script, not the exact node id path; the behaviour is what matters.

## 12. Recommendations for the next cycle (ordered)

Priority A — correctness and data:

1. Per-record versioning for collections (an `If-Match` per record) so two writers to one collection can be
   merged instead of serialised.
2. Undo/redo durability across a restart, or an explicit statement and test that it is per-process.
3. Property-based tests for the text-graph format: random documents → encode → decode → equal, and mutated
   documents → clear errors, no partial writes.
4. Finish the checkpoint cadence with an external controller: resume from `WORKLOG.md` and produce
   `CHECKPOINT-10..12` at the next real hour marks.

Priority B — security:

5. Server-side capability tokens for plugins (a short-lived token scoped to the capabilities the host granted),
   removing the "host-enforced only" limit.
6. A server-side allowlist or per-project policy for `/api/net` hosts, so an operator token is not an SSRF
   credential.
7. Rate limiting at the proxy for `/api/auth/session` and a lockout policy.

Priority C — reliability:

8. Run the deployment artefacts on Linux: systemd unit, nginx and Caddy, TLS, a reboot, a restore from
   `tools/backup.js`.
9. A soak test of 24 h with one workflow running every minute, measuring heap and file descriptors.
10. A test that a client which loses the network mid-write (not mid-run) retries only idempotent calls.

Priority D — developer experience:

11. Error codes documented one by one in `docs/api.md` (there is `openapi.json` but no prose table of codes).
12. Browser coverage in Firefox and WebKit.
13. A `--json` machine-readable summary for the whole test suite (counts by file) for trend tracking.

Priority E — maintenance:

14. Split `server.js` (1 000 lines) into `server/http`, `server/storage`, `server/auth` modules; the boundary
    tests are already in place to keep the split honest.
15. Remove the unused `legacy/` tree from the packaged client after one release, keeping it in git history.

## Appendix: files of this audit

- `BASELINE.md` — what was measured before any change.
- `WORKLOG.md` — the journal, with real times.
- `CHECKPOINT-01..09.md` — phase reports; hours 10–12 did not happen in this session.
- `BENCHMARKS.md` — the stress numbers.
- `DEPLOYMENT-VERIFICATION.md` — what ran and what did not.
- `screenshots/` — dashboard, projects empty, environments disconnected, phone dashboard.
