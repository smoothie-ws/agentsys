# AgentSys round 3 — reliability and advanced engineering

Branch: `audit/reliability-round3`, based on the audited `audit/12h-platform-hardening` at `e52eb4d`.
`main` was not modified. Baseline was verified independently before any change; no number from the previous
report was reused without running the command.

Measured active time: about 90 minutes of wall-clock work between the first independent check (16:40) and the
final verification (18:12 local), not the 12-hour budget. The worklog records each stage and its limits.

## Baseline (verified, not assumed)

- `node --test` at `e52eb4d`: **351 tests, 350 pass, 0 fail, 1 skipped (~12.4 s)**. The previous "351 Node tests"
  is confirmed for this commit.
- Browser suite: `platform`, `plugin_security`, `editor`, `ux` — **4/4 passed**.
- `tools/bench.js` failed on a removed `plugin-host.js`; repaired before measuring.
- `tools/stress.js` ran with 0 failures; graph read 22.26 ms median, Stop 14.02 ms, 0 running runtimes.

## Results by direction

### 1. Security verification

Confirmed and fixed defects:

| # | Severity | Finding | Fix | Regression |
|---|---|---|---|---|
| S1 | High (availability) | An operator token beginning with `pst_` was treated as an invalid plugin token and rejected | Compare the operator token first; plugin-token parsing only for non-operator bearers | `security.test.js` |
| S2 | High (client trust) | `api.ui.notify` bypassed the capability host and used the user's session, so a read-only plugin could post notifications | Check `notifications.write` and route through the scoped token | `browser_plugin_security.py` |
| S3 | High (client trust) | The plugin iframe could call `fetch`/load external images directly; "no direct network" was only documentation | Sandbox CSP: `connect-src 'none'`, `img-src data: blob:`, `frame-src 'none'`, `default-src 'none'` | local recorder server sees zero requests |
| S4 | High (XSS) | URL schemes were matched before whitespace normalization; `java&#10;script:` executed in the host page | Compact/strip control whitespace; remove non-image `data:`, SVG data, `<style>`, action attributes | clicked obfuscated link leaves the title unchanged |
| S5 | Medium | A plugin frame navigated to another page could post messages accepted as the plugin | Require `event.origin === 'null'` in addition to `event.source` | browser test |
| S6 | Medium (DoS) | Authenticated callers could hold unlimited SSE streams | `eventLimit` (1000) with a 429, release on disconnect | `lifecycle.test.js` |
| S7 | Medium (robustness) | A malformed cookie escape produced a 500 | Ignore undecodable cookie values; the request is anonymous | `security.test.js` |
| S8 | Medium (Windows) | NTFS 8.3 aliases could spell a server-only directory past the static-file pattern | Refuse `NAME~1` segments before lookup (8.3 is disabled on this volume, so code-level only) | static tests remain |
| S9 | Medium | `/api/net` buffered an arbitrary response before checking 2 MB; timeout/secret-in-URL were loose | Stream with a hard limit, validate timeout, refuse secret placeholders in the URL, map errors | `network-policy.test.js` |
| S10 | Medium (restore) | Backups copied `.server.lock`, making a restored copy look owned by the source process | Exclude the lock; start the restored folder while the source runs | `backup.test.js` |

Reviewed sound: timing-safe token comparison, session entropy/TTL/cap/sweep, CSRF header plus exact origin on
cookie writes, CORS echo without `*`, Host/rebinding defence, static manifest, secret redaction/0600 mode,
plugin-token non-escalation (cannot mint, cannot read events/diagnostics/contract, capability checked from the
actual method/path/body on the server).

### 2. Network isolation

- Normalized authority matching (case, root dot, port, IPv4/IPv6 brackets); wildcard is anchored and cannot match
  look-alike suffixes.
- `--deny-private-net` / `AGENTSYS_NET_DENY_PRIVATE=1`: resolve every answer, require all public, then **pin** the
  connection to the checked address with a custom Node HTTP(S) transport — no second DNS lookup, so a rebinding
  answer cannot redirect the connection. A test uses a non-existent name (`rebind.invalid`) that succeeds only
  because it is pinned to `127.0.0.1`.
- Per-project egress policy `PUT /api/projects/{id}/policy` with `net:{allow:[…], deny_private:true}`, enforced for
  that project's Scripts after the capability layers; omitting `net` preserves the existing policy.
- Redirects remain refused; 2 MB cap, 1–120 s timeout, Stop abort, connection errors, secret reflection redaction,
  IPv6 loopback, wildcard/look-alike, private refusal and project narrowing all have tests against local servers.

Limitation: a host resolving to both public and private addresses is refused (fail closed). Without a deny-private
policy the historical allowlist-only model remains.

### 3. Multi-client consistency

- Undo history was global per workflow, so two tabs undid each other's edits. History is now keyed by a stable
  per-tab `X-Agentsys-Client` id and returned per caller; an edit by another client clears the stale stacks. Bounded
  at 2000 stacks.
- The transport re-checks the environment generation after reading a response body; a switch during the body read
  now yields `stale_environment`.
- Browser platform test now waits for the SSE client to reconnect **without a reload** after a server restart and
  checks that no node remains `running`/`waiting`/`sleeping`.
- Existing conditional `If-Match`, parallel Run/Stop, collection versions, vanished-client and restart tests pass.

### 4. Storage integrity

- A commit the folder cannot accept previously left a redo record that made every later start replay the same
  impossible write. Replay now sets it aside as `.transaction.json.invalid` and boots.
- A failed migration never closed its server/lock; `migrateData` now closes in `finally`. Fault test: corrupt
  `other/collections.json`, expect rejection, lock released, second run converges.
- Corrupt `ui-state.json` no longer 500s the editor; the direct storage read still reports it.
- Re-ran interrupted transaction replay, invalid JSON, partial writes, concurrent writes, script sidecars,
  collections, secret mode (POSIX-only), repeated migration and backup/restore.

### 5. Runtime robustness

New property and randomized tests:

- 25 parallel signals on one Script: count exactly 25, 25 completions, one idle runtime, Stop releases the worker.
- Stop while paused: the delayed continuation never runs, no worker survives.
- 20 workflows: idle runtime bound (16), evicted workers exit, saved display survives a rebuild, shutdown releases
  all workers.
- 120 random documents: canonical encode/decode equivalence, stable re-encoding, script sidecar round-trip,
  eight malformed packet classes rejected.

### 6. Long-running execution

`tools/soak.js` now records heap, RSS, handles/requests/resources/listeners, file descriptors on Linux, request
and run latency, live runtimes/sessions/streams. 30 s run: **300 cycles, 0 errors, heap 5→11 MB, RSS 38→69 MB,
300 workers started/terminated/exited, 0 running or live runtimes, 0 sessions, 0 streams**. `tests/soak.test.js`
asserts bounded growth and request p95. `tests/lifecycle.test.js` covers SSE release/cap, session cap and expiry,
close with an open stream, immediate port reuse and the sign-in limit window.

### 7. Plugin architecture

Capability grants, iframe isolation, scoped-token issuance/expiry/revocation, cross-plugin command isolation,
page sanitization and Library nodes running without a client were re-verified. Added: `notifications.write`
positive path, immediate revocation on disable, manual revocation returning 401, failing `activate` isolated, and
the CSP/direct-network check. S2/S3/S4/S5 above are the architecture fixes.

### 8. UI/UX

- Fixed the unsaved-change gap on browser close: `beforeunload` warns only while an autosave form or inline canvas
  edit is dirty. Browser test fills a settings field, proves `isDirty`, reloads and handles the dialog.
- Added a 390×844 workflow-editor check: no horizontal overflow, Run/Undo reachable, Run shows the result.
- Existing empty states, offline retry, readable API errors, keyboard search, mobile sheet, accessibility names,
  collections validation, undo/redo, runtime controls and responsive pages still pass — including UX on Firefox and
  WebKit.

### 9. Performance

- Repaired `tools/bench.js`.
- HTTP responses are serialized once instead of parse+stringify+stringify: **5.854 → 1.931 ms** for the same
  335 KB, 800-node snapshot (`tools/perf-round3.js`).
- Storage writes stat the old file first: unequal size proves a difference without reading it; script references
  are cached by file stamp. **5.126 → 2.052 ms** for a 1.02 MB changed document.
- Final stress: read 0.53 ms, run 23.95 ms, record write 4.23 ms, graph read 14.22 ms, Stop 21.33 ms, 0 failures.
  Absolute bench values vary 10–30% between runs; no regression outside that noise was claimed.

### 10. Deployment

- CLI validates host, origins, host names, net patterns, port, session hours, both TLS files and data-folder
  writability, naming the bad value; a used port gets a clear message. Added `--deny-private-net`,
  `AGENTSYS_NET_DENY_PRIVATE`, `AGENTSYS_AUTH_ATTEMPTS` and `SIGBREAK`/`SIGHUP` handling.
- `tests/deployment.test.js` covers help/version, validation, offline status exit code and a real start/stop.
- **TLS is tested locally**: `tests/tls.test.js` generates a self-signed certificate, starts HTTPS, checks the
  protocol header, `Secure`/`HttpOnly` session cookie and an authenticated read; also verifies the trusted-proxy
  Secure-cookie rule. No VPS or public certificate was needed.
- Documentation updated; nginx/Caddy SSE configuration was already correct.

### 11. Architecture invariants

Extended `architecture.test.js`: server never requires a plugin/loads `data/plugins` code; client plugin code uses
neither `Backend.request` nor `/__data`; the client CLI imports only `shared/protocol` and `server/manifest` from the
server half; client UI has no server runtime symbols or route declarations; every route lives in `js/backend` with a
valid method/pattern. Existing fixed-manifest, DOM-free-server, acyclic-require, neutral-shared and no-compiled-address
checks pass. Graph-format compatibility is covered by the existing suite plus the new property test.

### 12. Documentation and final verification

Updated `security.md`, `permissions.md`, `plugins.md`, `server.md`, `deployment.md`, `testing.md`; added
`WORKLOG.md` and `BENCHMARKS.md` in this folder and this report.

## Final verification

| Check | Result |
|---|---|
| `node --test` | **387 tests, 386 pass, 0 fail, 1 skipped (~20.6 s)**; skip is POSIX file mode on Windows |
| `python tests/browser_suite.py` | **7/7 passed** (platform, plugin_security, editor, ux, execution_ui, shell, design) |
| `python tests/browser_ux.py firefox` | **12/12 passed** |
| `python tests/browser_ux.py webkit` | **12/12 passed** |
| `node --expose-gc tools/stress.js --json` | 0 run failures, 0 runtimes after Stop |
| `node --expose-gc tools/soak.js --seconds 30` | 300 cycles, 0 errors, 0 live resources |
| `node tools/perf-round3.js` | the before/after pairs above |
| `node tools/bench.js` | repaired; reproducible numbers in `BENCHMARKS.md` |
| TLS | real local HTTPS with a generated certificate |
| `git diff` secret scan | no private keys or token-like secrets added |

## Limitations

- No durable JavaScript resumption or distributed execution (unchanged design).
- TLS is local/self-signed; no public CA/OCSP or deployed proxy.
- A malicious installed plugin is outside the model: a granted `graph.write` can plant code a user later runs.
- Windows 8.3 names are disabled on this volume, so that specific bypass is hardened by code inspection and a
  refusal test rather than reproduction.
- The combined `server.js` remains for local `/editor/` and the regression suite; it is not the deployment server.
- `AGENTSYS_ALLOW_SHARED_DATA=1` remains last-writer-wins; one folder per server is the supported mode.

## Repository state

Changes are on `audit/reliability-round3`, uncommitted, as the task did not ask for a commit. No files outside the
checkout were modified; all tests use temporary data folders, and browser-generated screenshots were reverted.
