# CHECKPOINT-10 — Second phase: server-enforced plugin tokens, record versions, limits, second engine

Written 2026-11-14T16:16+10:00, covering 16:00–16:16 (the first report was written at 15:59).

## 1. What was investigated

The remaining security gap from CHECKPOINT-02: the plugin capability check ran only in the host page. Also the
collection update path (last write wins), the sign-in endpoint (no attempt limit), and browser coverage (Chromium
only).

## 2. Hypotheses checked

- A plugin's capabilities can be enforced by the server if the host exchanges its session for a scoped token.
  **Confirmed**: `POST /api/auth/plugin-session` issues one, the server checks the required capability from the
  method, path and body, and a request outside it is refused with `permission_denied` even with a valid session
  cookie present.
- A scoped token can be confined further: cannot mint another, cannot read events/diagnostics/contract, cannot
  hold `system.admin`. **Confirmed** by tests.
- Revocation is immediate. **Confirmed**: after `DELETE` with the token, the same token gets 401 even when the
  cookie would authenticate the request.
- Two writers to one collection record can be merged instead of overwriting. **Confirmed** after adding record
  versions: one wins, the other gets 409.
- Sign-in is a brute-force oracle. **Confirmed**; a per-address limit was added, and the right token waits out
  the window too (no oracle for which guess was right).
- The interface works on a second engine. **Confirmed**: all eight `ux` checks pass on Firefox.

## 3. Defects reproduced

No new defects; these were gaps in the design rather than broken code. The capability gap was already recorded
as SEC-06; it is closed now.

## 4. Fixes

Scoped plugin tokens (server issue/revoke/enforce, bounded, short-lived; host mint/cache/renew/revoke, fallback
when the server has no such route); per-record versions with `If-Match` and an upgrade path for old records;
per-address sign-in rate limit with `Retry-After`; `settings.read/write` added to the shared capability vocabulary
so host and server agree; error-code table in `docs/server.md`; the interface checks can run on another engine.

## 5. Tests

`tests/plugin-tokens.test.js` 7/7; `tests/environments.test.js` 11 → 13 (mint once per set, revocation,
older-server fallback); `tests/security.test.js` 15 (rate limit); `tests/storage-integrity.test.js` 11 (old
records read as version 1); `tests/concurrency.test.js` 6 (record conflicts); `browser_plugin_security.py` 5
checks (including a server refusal with the host layer bypassed); Firefox `ux` 8/8. Node total **338**.

## 6. Results

The plugin boundary no longer depends on the host being honest: the server enforces the same capabilities. A
record write can be conditional. Sign-in attempts are limited. The interface is verified on two engines.

## 7. Next

A 24-hour soak, a real Linux/systemd/nginx/TLS deployment run, and WebKit. None is possible in this session.
