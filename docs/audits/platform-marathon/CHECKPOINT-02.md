# CHECKPOINT-02 — Security: HTTP surface and client plugins

Written 2026-11-14T15:20+10:00.

## 1. What was investigated

`server.js` end to end: session creation, cookie flags, CSRF, CORS, Host checks, the legacy `/__data` endpoint,
the SSE stream, body limits, diagnostics, error redaction, proxy-header trust. `js/app/extensions.js` and
`plugin-store.js`: iframe sandbox, `postMessage` handling, command registration, sidebar items, HTML sanitizing,
plugin storage.

## 2. Hypotheses checked

- A plugin can reach another plugin's command. **Reproduced** (`commands.execute('victim:mark')` ran it).
- A plugin can add a `javascript:` sidebar link that executes in the client origin. **Reproduced** (the router
  only intercepts same-origin URLs, so the browser followed the scheme).
- `sanitizeHTML` removes SVG scripts. **Disproved**: `tagName` is upper-case for HTML but lower-case in the SVG
  namespace, so `<svg><script>` survived.
- The session map is bounded. **Disproved**: expired entries were only dropped when presented, and nothing
  capped the map.
- An oversized body gets a 413. **Disproved**: `req.destroy()` killed the socket before the answer.
- The combined server sends the same headers as the client: **disproved** (no CSP, no frame policy).
- A plugin's `api.request` is scoped to what it declared. **Disproved**: there was no capability model at all.

## 3. Defects reproduced

All six above, plus: `invoke()` could wait forever for a plugin answer, and the OpenAPI contract hard-coded its
version.

## 4. Fixes

`js/app/plugin-capabilities.js` (host-side classification and check, read-only default, named secrets, host-scoped
`net.fetch`); commands scoped to the owning plugin; sidebar href must be an app path; sanitizer compares local
names without case and removes more URL-bearing attributes; 20 s invoke timeout; session sweep, cap and count in
diagnostics; declared-length 413 plus a streaming limit that answers instead of killing the socket; CSP and
`X-Frame-Options` on the combined server; OpenAPI reports the running version.

## 5. Tests

`tests/security.test.js` 14/14; `tests/plugin-capabilities.test.js` 8/8; `tests/browser_plugin_security.py`
4/4 checks; extended `client-plugins.test.js`.

## 6. Results

A read-only plugin cannot write, fetch, read a secret, run another plugin's command or add a link; a plugin with
`graph.write` performs exactly that write and no more; plugin page HTML is sanitized. The HTTP surface refuses
anonymous access, forged origins, unexpected Hosts, replay of a logged-out session, wrong credentials and
anonymous SSE, and reports 413 for oversized bodies.

## 7. Next

Storage integrity, migration and multi-process safety.
