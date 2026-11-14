# CHECKPOINT-12 — Fourth phase: static files, secrets at rest, limits and interface coverage

Written 2026-11-14T16:50+10:00, covering 16:31–16:50. This is the twelfth phase report; the checkpoints are per
phase, not per elapsed hour, and the session has not run for twelve hours (see FINAL-REPORT).

## 1. What was investigated

The static half of both servers (`handleStatic` and `bin/agentsys-client.js`): traversal, encodings, Windows path
rules, server-only patterns. Secrets at rest and the commit record. The plugin-token map at its limit. Session
expiry. Network egress. The editor and page flows through the actual interface: Add menu, undo/redo, delete,
reload, Run; Collections creation and validation; environment removal; headings and accessible names.

## 2. Hypotheses checked

- The server-only pattern cannot be bypassed by a Windows path spelling. **Disproved**: `/js/storage/db.js::$DATA`
  and `/js/model/executor.js::$DATA` answered 200 on both the combined and client static servers (NTFS reads the
  default data stream for a path with a stream suffix, and the anchored server-only regex did not match).
- Secrets are private on disk. **Partly**: the systemd unit set `UMask=0077`, but a manual run wrote them with the
  default mode.
- A plugin-token flood leaves live plugins working. **Disproved**: at the limit the oldest token was evicted.
- Sessions expire. The code did; no test covered the expiry path (the TTL floor was 60 s, too slow for a test).
- The editor's undo covers the Add menu path through real controls. **Confirmed** after the earlier fix.
- Every main page has one heading and no unnamed control; Collections can be created and validated through the
  UI; an environment can be removed from its row. **Confirmed** on Chromium, Firefox and WebKit.

## 3. Defects reproduced

Defect 22: a Windows NTFS alternate data stream suffix bypassed the server-only file pattern on both static
servers, serving `js/storage/db.js` and `js/model/executor.js` (server-internal code, not secrets).

## 4. Fixes

Both static servers refuse `:`, `\` and NUL in a request path before lookup (`tests/static-serving.test.js`).
Secret files and the commit record are `0600` on POSIX. At the token limit a new token is refused (`429
too_many_tokens`) instead of revoking a live one. Session TTL floor is 1 s so expiry is testable (production
default stays 12 h). An optional `--allow-net` / `AGENTSYS_ALLOW_NET` allowlist is enforced in the shared net route
for HTTP callers and Scripts. The editor and page flows above are now browser scenarios.

## 5. Tests

`tests/static-serving.test.js` 3/3; `tests/net-allowlist.test.js` 3/3; `tests/security.test.js` 17 (16 pass, 1
POSIX-only skipped on Windows); `browser_editor.py` 6 checks; `browser_ux.py` 11 checks on each of Chromium,
Firefox and WebKit; the full browser suite 7/7. Node total **351** (350 pass, 1 skipped).

## 6. Results

No path spelling reaches server code through the static servers, secrets are owner-only on POSIX, a token flood
cannot silently break a running plugin, session expiry is covered, egress can be constrained by a deployment, and
the editor's menu/undo/run path plus the Collections and Environments flows are verified through the interface on
three engines.

## 7. Next

The 24 h soak and the Linux/systemd/nginx/TLS deployment run remain, plus WebKit-specific editor coverage beyond
the interface checks.
