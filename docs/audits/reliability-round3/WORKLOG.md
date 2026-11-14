# Round 3 — reliability and advanced engineering (WORKLOG)

Repository: `C:\Users\Admin\Desktop\Coding\agentsys`
Working branch: `audit/reliability-round3`, created from `audit/12h-platform-hardening` at
`e52eb4d` (`git reflog`: 2026-11-14 16:56 +10:00). `main` is untouched.

The time below is wall-clock time from the shell where a checkpoint was taken. The session began around
16:40; the last checkpoint in this log is recorded at the end. No duration was estimated from the 12-hour budget.

## Baseline verification (before any change)

- `git status` clean on `audit/12h-platform-hardening`; `main` at `7cca21e`.
- `node --test` → **351 tests, 350 pass, 0 fail, 1 skipped (~12.4 s)**. The previous report's 351 is therefore
  confirmed for this commit, not copied.
- `python tests/browser_suite.py platform plugin_security editor ux` → **4/4 passed**.
- `node tools/bench.js` failed before running: it still counted the removed `plugin-host.js`. That is a real
  tooling regression from the platform split; repaired before measuring.
- `node --expose-gc tools/stress.js --json` ran (600-node graph, Stop under load) with 0 run failures.

## 1. Security verification

Reviewed the auth/session, CSRF/CORS, Host, SSE, static-serving, secret and plugin-token paths in `server.js`,
`bin/agentsys-client.js`, `js/backend/permissions.js`, `js/backend/routes-permissions.js`,
`js/app/extensions.js`, `js/app/plugin-capabilities.js`, `js/app/plugin-store.js` and `shared/*`.

Confirmed and fixed:

1. **An operator token beginning with `pst_` could not authenticate.** `pluginTokenOf` classified it as an
   invalid plugin token and answered 401 before the configured-token comparison. Fixed by checking the operator
   token first; regression in `tests/security.test.js`.
2. **A malformed cookie escape answered with a URI error.** `cookies()` now ignores a value it cannot decode;
   the request is anonymous (401). Regression in `tests/security.test.js`.
3. **`api.ui.notify` bypassed the capability layer.** It called the host `api()` directly, so a read-only plugin
   could post notifications with the user's session. It now needs `notifications.write`, is classified by the
   plugin host and goes through the scoped token. Browser regression in `tests/browser_plugin_security.py`.
4. **The plugin sandbox had no network CSP.** Its opaque-origin iframe could issue a direct `fetch` (and leak
   through it) although the documentation said "no direct network". The sandbox document now carries
   `default-src 'none'; connect-src 'none'; img-src data: blob:; frame-src 'none'`, while keeping the inline
   loader working. A recorder server proves no request reaches it.
5. **Sanitizer URL-scheme bypass.** `java&#10;script:` (and tab/newline variants) is parsed as `javascript:` by
   a browser but not by the old `^\s*javascript` test. URL values are now whitespace-stripped before matching;
   non-image `data:` URLs, SVG data, `<style>` elements and action attributes are removed. Browser regression
   clicks the obfuscated link and checks the title.
6. **Plugin frame navigation could impersonate a plugin.** The host now also requires `event.origin === 'null'`,
   the opaque origin of its own frame, besides `event.source`.
7. **Unbounded SSE connections.** Added `eventLimit` (default 1000) with a 429 `too_many_streams`; streams are
   still removed on disconnect. Regression in `tests/lifecycle.test.js`.
8. **Windows 8.3 alias static-file bypass (defence in depth).** A request containing `NAME~1` is refused before
   the file lookup in both static servers, as `::$DATA` already was. The current volume has 8.3 names disabled,
   so this is a code-level hardening; the traversal/ADS cases remain covered by the existing tests.
9. **`/api/net` buffered an arbitrary response before checking its size.** It now checks the declared length and
   streams with a hard 2 MB cap, cancels the reader, validates the timeout (1–120 s), refuses a secret placeholder
   in the URL, and maps transport errors to 502/504 without a stack trace.
10. **Backup copied `.server.lock`.** Restoring a live backup produced a folder that looked owned by the source
    process. The lock is no longer copied; `tests/backup.test.js` starts the restored copy while the source runs.

Reviewed and found sound: timing-safe token comparison, session entropy/TTL/cap, CSRF header plus origin on
cookie writes, exact CORS echo with credentials (no `*`), Host pinning/rebinding defence, static manifest and
server-only set, secret redaction and 0600 mode, plugin token non-escalation (cannot mint, cannot read events or
diagnostics, capability checked from method/path/body on the server), auth endpoint exclusion.

## 2. Network isolation

Implemented in `js/backend/permissions.js`, `js/backend/routes-permissions.js`, `headless.js`, `server.js`,
`bin/agentsys-server.js`, tests in `tests/network-policy.test.js`:

- Authority normalization (lower case, root dot, explicit port, IPv4 and bracketed IPv6); wildcard match is
  anchored and cannot match a suffix look-alike.
- Optional `--deny-private-net` / `AGENTSYS_NET_DENY_PRIVATE=1`: resolve every address, require all public, then
  **pin** the connection to the checked address using a Node `http`/`https` transport with a custom `lookup`.
  This removes the check-to-connect DNS rebinding window for that mode.
- Per-project egress policy in `PUT /api/projects/{id}/policy`
  (`net:{allow:[patterns], deny_private:boolean}`), enforced for that project's Scripts after the capability
  layers. Existing policies are preserved if `net` is omitted; `null` clears it.
- Redirects remain manual; connection errors, Stop and timeout all settle. Tests cover a local allowlisted
  server, redirect refusal, 2.5 MB response, timeout and invalid timeout, Stop during a slow request, secret
  reflection redaction, IPv6 loopback, private refusal, project narrowing, look-alike refusal and the pinned
  transport (`rebind.invalid` connected to 127.0.0.1 by address only).

Limitation: a hostname that resolves to both public and private addresses is refused (fail closed); pinning
uses the first public answer. A deployment without `deny_private` keeps the historical "allowlist only" model.

## 3. Multi-client consistency

- **Undo was one stack shared by every client.** Two tabs edited each other's history. Undo history is now keyed
  by a stable per-tab `X-Agentsys-Client` id; the history endpoint reports the caller's depth. An edit by one
  client clears other clients' stacks for that workflow, because their next undo would revert work they never
  saw. The map is capped at 2000 stacks. Regression in `tests/concurrency.test.js` (two clients, undo isolation,
  no revert after a foreign edit).
- The client transport now sends the tab id on requests and the event stream; CORS allows the header.
- A response that finishes reading after an environment switch now throws `stale_environment` (the check was
  previously only before the body read).
- Existing conditional-write/`If-Match`, SSE fan-out, parallel Run/Stop, vanishing client, server restart and
  collection-version tests still pass. The browser platform test now also waits for the SSE client to reconnect
  **without a reload** after a restart and asserts no node is left `running`/`waiting`/`sleeping`.

## 4. Storage integrity

- A commit that the folder cannot accept (for example a file where a directory is needed) left
  `.transaction.json` behind and made every later boot replay the same impossible write. Replay now sets the
  record aside as `.transaction.json.invalid` and starts on the data files that reached disk. Regression in
  `tests/storage-integrity.test.js`.
- A migration that failed after creating the backup never closed its server, so the folder lock stayed held.
  `migrateData` now closes in a `finally`; a new test corrupts `other/collections.json`, expects the rejection,
  checks the lock is gone and runs a successful second migration.
- A corrupt `ui-state.json` made `/editor/` answer 500. Static hosting now starts with an empty UI store while a
  direct read of the record still fails; `tests/server.test.js` covers both.
- Repeated migration, interrupted transaction replay, invalid JSON, partial writes, script sidecars,
  collections, secret mode (POSIX), backup/restore and concurrent writes were re-run and remain covered.
- The backup tool no longer copies the source folder's lock file (`tests/backup.test.js`).

## 5. Runtime robustness

Added `tests/runtime-robustness.test.js` and `tests/format-property.test.js`:

- 25 parallel signals on one Script (random 0–12 ms delay): all complete, state count is exactly 25, 25 runs are
  counted, one idle runtime remains, Stop releases the worker.
- Stop while paused: the delayed continuation never runs, no worker is left, status is idle.
- 20 workflows of short runs: idle runtimes are bounded (16), workers of evicted runtimes exit, the last saved
  display is readable after rebuilding its runtime, shutdown releases every worker.
- Property tests over 120 random documents: `encode`/`decode` equivalence by canonical form, stable re-encoding,
  sidecar script round-trip with difficult characters, and eight malformed packets each rejected.

## 6. Long-running execution

`tools/soak.js` now samples heap, RSS, handles/requests/resources/listeners and, on Linux, open file descriptors,
and records request latency plus live runtimes/sessions/streams after the loop. `tests/soak.test.js` asserts
bounded growth, request p95 and no surviving runtime. Measured 15 s run: 93 cycles, 0 errors, heap 5→10 MB,
RSS 38→61 MB, workers 93 started/93 exited, 0 live runtimes, 0 streams. `tests/lifecycle.test.js` covers SSE
release and the stream cap, session cap/expiry, close with an open stream and immediate port reuse, and the
sign-in limit window.

## 7. Plugin architecture

- Capability grants, scoped tokens, revocation, cross-plugin commands, page sanitization and Library-node
  creation without a client are covered by the existing browser/Node tests and re-run here.
- Fixed the notification bypass and the direct-network gap (see Security).
- Added browser checks: `notifications.write` actually posts a notification; disabling a plugin revokes its
  token immediately; a manually revoked token is 401; a plugin that throws on `activate` is reported and the
  client keeps working.

## 8. UI/UX

- Found and fixed an unsaved-change gap: closing the browser bypassed the route leave guards. A `beforeunload`
  warning now appears when an active autosave form or an inline canvas edit is dirty. `tests/browser_ux.py`
  fills a settings field, checks `isDirty`, reloads and expects the dialog.
- Extended `tests/browser_editor.py` with a 390×844 workflow-editor check: no horizontal overflow, Run/Undo
  reachable, and Run from the phone layout displays the result.
- Existing coverage (empty states, unreachable server/retry, error text, keyboard search, mobile sheet,
  accessibility names, collections validation, undo/redo, runtime controls) still passes.

## 9. Performance

- Repaired `tools/bench.js` (removed `plugin-host.js` from the line count and made it run).
- The HTTP layer serialized every result twice (`JSON.parse(JSON.stringify(result))` then `JSON.stringify`).
  It now serializes once. `tools/perf-round3.js` measures the same 800-node, 335 KB snapshot:
  **5.854 ms → 1.931 ms** per response.
- Storage writes first read the whole previous file to compare it. An unequal size already proves a difference,
  so only equal-size writes read; script-reference extraction also caches names keyed by the file stamp. The
  same tool measures a 1.02 MB changed document: **5.126 ms → 2.052 ms**.
- A “before” worktree at `e52eb4d` and the current branch were run alternately (`tools/bench.js`); absolute
  graph-read numbers vary by 10–30% on this machine and showed no regression outside that noise. Request latency
  and storage are recorded in `BENCHMARKS.md`.

## 10. Deployment

- CLI validates host, origins, allowed hosts, net patterns, port, session hours, both TLS files and data-folder
  writability; it names the bad value. A used port gets a clear message.
- Added `--deny-private-net`, `AGENTSYS_NET_DENY_PRIVATE`, `AGENTSYS_AUTH_ATTEMPTS` documentation and
  `SIGBREAK`/`SIGHUP` handling. `tests/deployment.test.js` covers help/version, validation, status exit code and
  a real start/stop.
- **TLS is now tested locally**, not just documented: `tests/tls.test.js` generates a self-signed certificate
  with the available `openssl`, starts HTTPS, checks the protocol header, `Secure`/`HttpOnly` cookie and an
  authenticated read; it also checks the trusted-proxy cookie path. No VPS or public certificate was used.
- Updated `docs/deployment.md` with the new switch and the local TLS verification; reverse-proxy SSE settings
  were already correct and were left unchanged.

## 11. Architecture invariants

Extended `tests/architecture.test.js` with source checks that:

- server files never `require` a plugin or load `data/plugins` code;
- client plugin files use neither `Backend.request` nor `/__data`;
- the client CLI imports only `shared/protocol.js` and `server/manifest.js` from the server half;
- the client interface has no server runtime symbols and no route declarations;
- every route declaration lives in `js/backend` and uses a valid method/pattern.

Existing checks (fixed manifest, no DOM in the server, no server runtime in `index.html`, acyclic require graph,
neutral shared modules, no compiled server address) still pass. Workflow format compatibility is covered by
`tests/graph-format.test.js` plus the new property test.

## 12. Documentation and final verification

Updated `docs/security.md`, `permissions.md`, `plugins.md`, `server.md`, `deployment.md`, `testing.md` and this
worklog; the final report is `REPORT.md` in this folder, with `BENCHMARKS.md`. Final verification at 18:12
(about 90 minutes after the first independent check):

- `node --test`: **387 tests, 386 pass, 0 fail, 1 skipped (~20.6 s)**.
- Full browser suite: **7/7**; `ux` on Firefox and WebKit: 12/12 each.
- Stress: 0 run failures, 0 runtimes after Stop; soak 30 s: 300 cycles, 0 errors, 0 live resources; perf pairs
  5.854→1.931 ms and 5.126→2.052 ms; TLS test passes with a generated certificate.
- `git diff` secret scan found no private key or token-like secret; screenshots from re-runs were reverted.

## Limitations left

- No durable resumption of JavaScript stacks, no distributed execution (unchanged by design).
- TLS is verified locally with a self-signed certificate; a public CA, OCSP and real proxy are not exercised.
- Plugin capabilities still cannot make a malicious *installed* plugin safe (documented trust model); a granted
  `graph.write` can plant code that a user later runs.
- The combined `server.js` remains for local `/editor/` and the regression suite; it is not the deployment server.
- An `AGENTSYS_ALLOW_SHARED_DATA=1` deployment is still last-writer-wins by design; one folder/one server is the
  supported mode.
