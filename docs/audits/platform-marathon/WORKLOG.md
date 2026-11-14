# Work log — platform hardening marathon

Real clock times (local, UTC+10) unless marked UTC. Every entry was written while the step was happening,
not reconstructed afterwards. If the session is resumed, read the last entry and continue there.

Conventions: `HEAD` is the audit branch `audit/12h-platform-hardening`. Test counts are from
`node --test` on the whole suite.

---

## 2026-11-14T14:56 — Session start

- Start: 2026-11-14T14:56:29+10:00, Unix 1794632189. Deadline: 2026-11-15T02:56:29+10:00.
- `git status --short`: empty. HEAD `5123643`, branch `platform/server-client`.
- Baseline `node --test`: **242 tests, 242 pass, 0 fail** (9.5 s).
- `main` worktree `node --test`: **245 pass**; delta explained by deleting 14 server-plugin tests and
  adding 11 platform tests (see `BASELINE.md`).
- Browser suite: first run 0/4 in 0.5 s — Playwright Chromium not installed. Installed it
  (`python -m playwright install chromium`), then **4/4 pass** (platform 9.2 s, execution_ui 9.3 s,
  shell 15.1 s, design 5.9 s).
- Created branch `audit/12h-platform-hardening` and `docs/audits/platform-marathon/`.

## 2026-11-14T15:15 — Reading the code that matters

Read `server.js`, `server/api-server.js`, `server/manifest.js`, `server/migrate.js`, `headless.js`,
`shared/core.js`, `shared/protocol.js`, `js/app/environments.js`, `js/app/plugin-store.js`,
`js/app/extensions.js`, `js/app/router.js`, `js/backend/runtime.js`, `js/backend/execution.js`,
`js/backend/routes-collections.js`, `js/storage/db.js`, `bin/*.js`, `tests/*` (new files).

Candidates recorded for verification (not yet confirmed defects):

1. `Environment.setActive()` calls `controller?.abort()`, but `controller` is never assigned — the
   comment promises that in-flight requests are aborted on a switch; they are only ignored after the
   fact by the generation check.
2. `Environment.remove()` on the active environment switches `active` without incrementing
   `generation`, without resetting `status`/`meta`, and without reconnecting.
3. `Extensions` lets a plugin execute another plugin's command: `commands.execute` prefixes the
   *calling* plugin id to an arbitrary string, so `"other:cmd"` resolves to another plugin's command.
4. `Extensions` accepts any `href` for `ui.addSidebarItem`; `js/app/router.js` only intercepts links
   whose URL has the page's origin, so a `javascript:` href is followed by the browser (stored XSS in
   the client origin, and therefore access to the client's `sessionStorage` token).
5. `sanitizeHTML` compares `tagName` against upper-case names only; SVG elements keep lower-case names
   (`<svg><script>`), so the SVG script element is not removed.
6. `server.js` never sweeps the `SESSIONS` map: expired sessions are only removed when presented.
7. `readBody()` destroys the request socket when the body is too large, so the promised `413` cannot
   reach the client; a limit should be answered before the socket dies.
8. The combined `server.js` sends no `Content-Security-Policy` and no `X-Frame-Options`, while
   `bin/agentsys-client.js` sends both.
9. `Backend.openapi()` hard-codes `version: '0.3.0'` instead of `Protocol.VERSION`.
10. `exclusive()` serialises every non-`unlocked` request per process; the data folder has no
    process-level lock, so two servers started on the same `--data` would write concurrently.

## 2026-11-14T15:20 — Automated architecture boundaries

- Added `tests/architecture.test.js`: a static analyser that enforces (a) the server manifest exists and
  never lists client UI/app/canvas files, (b) no server runtime file references DOM/browser storage
  globals, (c) `shared/*.js` stays environment-neutral, (d) the client entry point never loads server
  code, (e) client sources never use the server store or `require()` Node modules, (f) the server source
  tree never requires a client module, (g) no hard-coded `localhost`/`127.0.0.1` in client logic except
  the documented default resolver, (h) no cyclic relative requires between Node modules.

## 2026-11-14T15:23 — Phases 2–6 done; suite at 301 tests

Written at 15:23 (27 min after the start), covering 15:15–15:23. Each phase ended in a commit:

- `3278854` Architecture + transport: boundary analyser, transport in a Node vm, abort on switch/remove, one
  default URL resolver. +16 tests.
- `8779303` Security (plugins + HTTP): capability layer, command scoping, href check, sanitizer, session
  sweep, 413, CSP, OpenAPI version. +14 Node tests, +1 browser scenario.
- `af2b637` Storage + migration: one writer per data folder, recovery tests, migration key preservation.
  +14 tests.
- `76be783` Concurrency: If-Match conflicts, two clients, restart, rapid switching. +7 tests.

Confirmations against the candidates recorded at 15:15 (all reproduced, all fixed):

1. Transport abort: `controller` was never assigned. Each generation owns one now; a test asserts
   `signal.aborted` after a switch.
2. Removing the active environment left `status: connected` and an open stream from the removed server.
   `remove()` now starts a new generation and connects the next environment.
3. `commands.execute('other:cmd')` reached another plugin's command. Refused; a browser test proves the
   victim command never ran.
4. `ui.addSidebarItem({href:'javascript:…'})` executed in the client origin on click (the router only
   intercepts same-origin links). Only `/…` paths are accepted now.
5. SVG `<script>` survived `sanitizeHTML` (upper-case tagName comparison). Removed by local name now.
6. `SESSIONS` grew forever. Swept on login and every 5 minutes (unref'd); diagnostics reports the count.
7. An oversized body killed the socket before the 413. A declared oversized body is answered now, and a
   streaming one stops buffering and is answered. Test posts 21 MB and reads the JSON 413.
8. The combined server sent no CSP/frame policy. Identical to the client now.
9. OpenAPI reported a literal `0.3.0`; it reports the running version and protocol now.
10. Two servers on one data folder overwrote each other's documents. A pid lock refuses the second process,
    takes over a stale lock, and `AGENTSYS_ALLOW_SHARED_DATA=1` is the explicit escape hatch.

Additional defect found while testing migration: a duplicate provider record without `apiKey` erased the
`{{secret:…}}` reference migrated from the earlier record. Fixed; the key reference is kept.

Still open: engine regression scenarios, resource/bench measurements, UI checks and screenshots, API/perf
matrix, deployment artefacts, final audit.
