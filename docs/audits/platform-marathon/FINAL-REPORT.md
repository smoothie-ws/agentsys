# FINAL REPORT — independent platform audit and hardening

## Summary

The platform refactor was real: a separate API-only server, a static client, one transport, remote environments,
generic collections, migration, and no server plugin loading. The previous report's headline numbers reproduced
(242 Node tests, 4 browser scenarios) once the Playwright browser was installed. The refactor also left real
defects at the new seams — the client transport never aborted anything, one plugin could drive another, a plugin
link could run script in the client origin, two servers on one data folder lost writes, and several failure paths
were promised but not implemented. Twenty defects were reproduced and fixed, each with a test. Two new browser
scenarios and sixteen new Node test files lock the behaviour in. A second phase closed the largest remaining
security gap: plugin capabilities are now enforced by the server through scoped tokens, not only by the host
page that issues them. Later phases closed a Windows static-file bypass, added egress and session limits, and
put the editor's menu/undo/run path and the Collections flow under browser tests on three engines.

**The 12-hour cycle was not completed.** This session ran **113 minutes 31 seconds** of wall time
(2026-11-14T14:56:29 → 16:50:00, UTC+10, including all four phases), then returned control to the
harness. The objective's condition for a
12-hour cycle (a full 43 200-second interval, or an external controller resuming from the journal) was not met.
Nothing in this report pretends otherwise. Because the work is resumable, the remaining backlog is written down
in section 12 and the journal is current.

## 1. Duration and commits

| Item | Value |
|---|---|
| Start | 2026-11-14T14:56:29+10:00 (Unix 1794632189) |
| End of measured work | 2026-11-14T16:50:00+10:00 (Unix 1794639000), after the fourth phase |
| Actual duration | **113 min 31 s** (6 811 s) |
| Planned deadline | 2026-11-15T02:56:29+10:00 (not reached) |
| Source branch / commit | `platform/server-client` / `5123643be41a0227f6cb5e9ea586cfee816e1946` |
| Audit branch | `audit/12h-platform-hardening` |
| Final code commit | `f8da522` (the report and its figures follow in later docs commits) |
| Commits added | 24 audit commits on top of the 3 platform commits (`git log main..HEAD`: 27); the last code commit is `f8da522` |
| `main` | untouched |

The session was bounded by the agent environment, not by the work: the backlog in section 12 is what a resumed
or externally driven session should pick up, in order.

## 2. Metrics

| Metric | Requirement | Result |
|---|---|---|
| Actual duration | measured | 113 min 31 s, stated above; not 12 h |
| Initial tests | exact | `node --test`: **245** on `main`, **242** on the source branch, 0 failures |
| Final tests | exact | **351** (350 pass, 0 fail, 1 skipped: a POSIX-only file-mode check), ~13 s (Linux CI configured for Node 20; measured on Node 20.11/Windows) |
| New tests | count and purpose | **109 Node tests** (16 new files plus 4 added to migration) + **7 browser scenarios** (4 on the split client with 33 checks; the interface one also on Firefox and WebKit); listed in section 5 |
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
| 21 | Medium | Five editing routes were absent from the undo set: adding a Script/Event primitive, splitting a wire, typing an output value, changing workflow types, changing a Script's grants | reproduction + randomized test | all five are edits; undo restores them | `graph-mutation.test.js` |
| 22 | Medium | Both static servers served `js/storage/db.js` and `js/model/executor.js` when the URL ended in `::$DATA` (Windows NTFS alternate data stream), bypassing the server-only pattern | reproduction on Windows | reject a colon, backslash or NUL in a request path before lookup | `static-serving.test.js` |

Negative result, recorded deliberately: **the graph engine needed no change**. Four new scenarios (a Script
editing its own graph, bounded creation, self-deletion, repeated runs with Stop) all passed against the existing
semantics, which is evidence that the refactor did not damage it.

## 5. Tests added

| File | Tests | Purpose |
|---|---|---|
| `tests/architecture.test.js` | 7 | boundaries: manifest, no DOM in the server, client never loads server code, one transport, acyclic requires, neutral shared modules, no compiled-in addresses |
| `tests/environments.test.js` | 13 | the client transport in a Node vm: discovery, token confinement, 401 renewal once, no retry of writes, abort on switch, stale answers, removal, rapid switching, reconnect, incompatibility |
| `tests/plugin-capabilities.test.js` | 8 | classification and refusal by method/path/body; read-only default; named secrets; host-scoped network; shipped packages declare what they use |
| `tests/security.test.js` | 17 | anonymous access, invalid/logged-out sessions, CSRF+Origin, Host/rebinding, CORS, anonymous SSE, credential conflicts, 413, unknown routes/methods/escapes, diagnostics, redaction, non-loopback without token, OpenAPI, CSP |
| `tests/storage-integrity.test.js` | 12 | redo replay, unreadable record, path escape, tmp file, corrupted JSON, folder copy as backup, 25 parallel records, sidecar scripts, lock takeover, deletion |
| `tests/concurrency.test.js` | 6 | If-Match conflict, no lost update, shared events, cross-server isolation, stop visible to a second client, restart, vanished client |
| `tests/engine-regression.test.js` | 4 | dynamic graph editing during a run, bounded creation, self-deletion, worker settlement |
| `tests/resource.test.js` | 6 | 200 round trips, 12 parallel runs, stream cleanup, session cap, 600-node graph, 1000 records |
| `tests/api-contract.test.js` | 8 | 405/404, malformed bodies, protocol header, public discovery, pagination, older clients, client independence, cursor |
| `tests/backup.test.js` | 3 | stopped backup/restore, live refusal and `--force`, corrupted file reporting |
| `tests/graph-mutation.test.js` | 3 | 5 seeds × 30 random editor operations through the API with invariants after every step (unique ids, every edge endpoint exists, every group member exists, finite positions, monotonic cursor), redo restores what undo removed, a mutated graph still runs, and every editing route is undoable |
| `tests/static-serving.test.js` | 3 | both static servers: public files served, server-only and non-public files refused for traversal, encoded separators, backslashes, NULs, trailing dots/spaces and NTFS stream suffixes |
| `tests/net-allowlist.test.js` | 3 | the optional egress allowlist: exact host, wildcard, lookalike, a Script with a net.fetch grant, and the meta flag |
| `tests/browser_editor.py` | 6 checks | Add menu, toolbar undo/redo, keyboard delete and undo, persistence across a reload, Run and display on the split client |
| `tests/soak.test.js` | 1 | an 8 s create/edit/run/delete loop with fixed thresholds: no error, progress, no running runtime, bounded heap |
| `tests/graph-format.test.js` | 4 | 200 generated documents round-trip through encode/decode (modulo the canonical collection order), encode is idempotent, a script default becomes a sidecar and returns, damaged/unreferenced/escaping/proto-polluting packets are refused, runtime stays opaque |
| `tests/plugin-tokens.test.js` | 7 | server-enforced plugin tokens: issuance, refusal by capability family, named secrets, host-scoped net, auth/events/diagnostics denied, revocation under a valid cookie, expiry and a bounded token map, and agreement between the host and server matchers |
| `tests/browser_plugin_security.py` | 5 checks | a read-only plugin cannot write/fetch/spend a secret/run another command/add a link; a granted plugin can write exactly that; HTML sanitized |
| `tests/browser_ux.py` | 11 checks | desktop/tablet/phone, empty states, one heading and named controls per page, unreachable server, environment removal, keyboard search, readable errors, Collections create/validate/add/delete, screenshots |
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
| SEC-06 | No capability model for plugin API calls | fixed twice over: a host-side layer (read-only default) and a server-enforced scoped token per plugin |
| SEC-07 | `POST /api/net` is reachable by any token holder (SSRF) and can inject `{{secret:…}}` | **accepted**: a token is an operator credential; plugins need `net.fetch:<host>` and `secrets.use:<name>`. An optional server-wide allowlist (`--allow-net` / `AGENTSYS_ALLOW_NET`) restricts every caller; it is empty (no extra restriction) by default. Documented in `docs/security.md` |
| SEC-08 | Plugin CSS can restyle the client (clickjacking inside the page) | **accepted**, documented in `docs/plugins.md` |
| SEC-09 | No rate limit on `POST /api/auth/session` | fixed: 10 attempts per minute per address by default, 429 with `Retry-After`, success clears the count |
| SEC-10 | Windows NTFS stream suffix bypassed the server-only static-file pattern | fixed in both static servers; tested |
| SEC-11 | Secret files were world-readable on POSIX unless the unit's umask applied | fixed: 0600 on the file and the commit record |

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
  Plugins page) plus **server-enforced scoped tokens** (`POST/DELETE /api/auth/plugin-session`), command
  scoping, path-only sidebar links, a stricter sanitizer, a session sweep and cap, a sign-in rate limit, a real
  413, CSP/frame policy on the combined server.
- **Editor**: every editing route is undoable now (five were missing: primitives, wire splits, output values,
  types, grants); undo history is documented and tested as per-process.
- **Client**: real cancellation per environment generation; status/meta ownership per attempt; scoped plugin
  token minting, caching, renewal and revocation; a failed page keeps its context and offers a retry;
  Environments and Collections searchable; Escape closes search.
- **Server**: static files refuse stream/backslash/NUL paths; secret files are 0600; an optional egress
  allowlist covers HTTP and Scripts; a token flood is refused rather than silently revoking a live plugin.
- **Data**: lock file, backup tool with validation and manifest, migration key preservation, per-record
  versions with conditional writes (`If-Match`), and the record upgrade path.
- **Docs**: `README.md`, `docs/plugins.md` (capabilities), `docs/security.md` (threat model and residual risks),
  `docs/server.md` (lock, sessions, 405/413), `docs/deployment.md` (backup, update, Windows, lock),
  `docs/testing.md` (current suites and tools), plus this audit folder.
- **Deployment**: `.github/workflows/ci.yml`, `deploy/agentsys-server.service`, `deploy/nginx-agentsys.conf`,
  `deploy/Caddyfile`.

## 9. Residual risks and unresolved problems

| Risk | Severity | Note |
|---|---|---|
| Plugin capabilities on a server from before this release | Low | Such a server answers 404 to the token request, and the host-side check is the boundary. Current servers enforce the scoped token themselves |
| Token holders can make the server fetch arbitrary URLs and inject secrets through `/api/net` | Medium | Operator-level trust; the plugin layer narrows it. A future server-side capability token would close it |
| No multi-user roles or audit log | Medium | Out of scope in this cycle; one token means one operator |
| Sessions live in server memory | Low | A restart signs every client out; clients holding their token renew silently |
| No general API rate limiting (beyond sign-in) | Low | A reverse proxy can add per-address limits; a token is an operator credential |
| Plugin CSS can restyle the client | Low | Documented; there is no per-plugin stylesheet isolation |
| Browser tests on Chromium, Firefox and WebKit; the editor scenario runs on Chromium only | Low | the interface checks pass on all three; Safari's real build and the editor flow there are not covered |
| Undo history is in memory per process | Low | Documented in `docs/runtime.md` and asserted by `storage-integrity.test.js`; a restart keeps the document and clears the history |
| Linux, systemd, nginx/Caddy, a real certificate | Untested here | Artefacts and expectations are written down in `DEPLOYMENT-VERIFICATION.md`; must be exercised on the target host |
| Collections rewrite one document per write | Low | 255 writes/s measured; a high-volume workload needs a different schema, not a code change |
| Checkpoints 10–12 (hours 10–12) | Process | Not written because the session did not last that long; the journal and backlog allow a controller to resume |

## 10. Final verification (commands and results)

| Check | Command | Result |
|---|---|---|
| Node suite | `node --test` | 350 pass, 0 fail, 1 skipped (~13 s) |
| Browser suite | `python tests/browser_suite.py` | 7/7 pass: platform, plugin_security, editor, ux, execution_ui, shell, design |
| Other engines | `python tests/browser_ux.py firefox` / `… webkit` | 11/11 each; screenshots `*-firefox.jpg`, `*-webkit.jpg` |
| Soak | `node --expose-gc tools/soak.js --seconds 60` | 450 cycles, 0 errors, heap 5→11 MB, 450/450 workers settled, 0 running runtimes |
| Stress | `node --expose-gc tools/stress.js` | recorded in `BENCHMARKS.md`; 0 run failures, 0 running runtimes after Stop |
| Boundaries | `node --test tests/architecture.test.js` | 7/7 |
| Backup | `node tools/backup.js` via `tests/backup.test.js` | 3/3 |
| Plugin tokens | `node --test tests/plugin-tokens.test.js` | 7/7, including a server refusal with the host layer bypassed in the browser |
| Static files | `node --test tests/static-serving.test.js` | 3/3, including the NTFS stream suffix on both servers |
| CLI | `agentsys-server version`, `help`, `status`, no-token refusal | as documented |
| Diff review | `git diff --stat main...f8da522` | 127 files, +12 389/−1 319; no temporary or user data |
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
- Further phases ran after the first report (16:00–17:00) because the objective is a long cycle: they closed
  the server-side capability gap, added record versions, the sign-in limit and randomized editing tests, fixed
  five routes missing from undo, ran a bounded soak, reproduced the interface checks on Firefox and WebKit,
  closed a Windows static-file bypass, added secret modes, session expiry, egress and token limits, and put the
  editor and Collections flows under browser tests. The report was updated rather than replaced.
- One reviewer-visible simplification: the sidecar-script test asserts that the file is removed when the node
  stops being a Script, not the exact node id path; the behaviour is what matters.

## 12. Recommendations for the next cycle (ordered)

Priority A — correctness and data:

1. ~~Per-record versioning for collections~~ — done in the second phase (versions + `If-Match`, 409 on a
   stale write or delete, old records read as version 1).
2. ~~Undo/redo durability~~ — decided and tested: history is per process, stated in `docs/runtime.md` and
   asserted after a restart. Making it durable is a separate design (state size, conflict with concurrent edits).
3. ~~Property-based tests for the text-graph format~~ — done (`tests/graph-format.test.js`, 200 generated
   documents, hostile packets). Randomized editor mutations are done too (`tests/graph-mutation.test.js`).
4. Finish the hourly checkpoint cadence with an external controller: resume from `WORKLOG.md` and continue
   at the next real hour marks.

Priority B — security:

5. ~~Server-side capability tokens for plugins~~ — done (`POST /api/auth/plugin-session`, enforced per call,
   revocable, bounded).
6. ~~A server-side allowlist for `/api/net` hosts~~ — done as an optional deployment control; it is empty by
   default, so a per-project default-deny policy is still open.
7. ~~Rate limiting for `/api/auth/session`~~ — done in the server; a proxy limit is still worth adding.

Priority C — reliability:

8. Run the deployment artefacts on Linux: systemd unit, nginx and Caddy, TLS, a reboot, a restore from
   `tools/backup.js`.
9. A 24 h soak. A bounded 60 s soak exists (`tools/soak.js`, 450 cycles, stable heap); a full day still needs a
   host that stays up, and file-descriptor sampling on Linux.
10. A test that a client which loses the network mid-write (not mid-run) retries only idempotent calls.

Priority D — developer experience:

11. ~~Error codes documented one by one~~ — done as the Errors table in `docs/server.md`.
12. ~~Browser coverage in Firefox and WebKit~~ — both pass the interface checks.
13. A `--json` machine-readable summary for the whole test suite (counts by file) for trend tracking.

Priority E — maintenance:

14. Split `server.js` (1 000 lines) into `server/http`, `server/storage`, `server/auth` modules; the boundary
    tests are already in place to keep the split honest.
15. Remove the unused `legacy/` tree from the packaged client after one release, keeping it in git history.

## Appendix: files of this audit

- `BASELINE.md` — what was measured before any change.
- `WORKLOG.md` — the journal, with real times.
- `CHECKPOINT-01..12.md` — phase reports (the checkpoints are per phase, not per elapsed hour); 10–12 cover the
  second, third and fourth phases.
- `BENCHMARKS.md` — the stress numbers.
- `DEPLOYMENT-VERIFICATION.md` — what ran and what did not.
- `screenshots/` — dashboard, projects empty, environments disconnected, phone dashboard.
