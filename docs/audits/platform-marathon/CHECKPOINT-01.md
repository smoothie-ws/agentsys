# CHECKPOINT-01 — Baseline and architectural boundaries

Written 2026-11-14T15:15+10:00. Covers the work from the start at 14:56.

## 1. What was investigated

The three commits on `platform/server-client`, the full diff against `main`, the server manifest and launcher,
the API transport, the plugin host, storage, migration and the test tree.

## 2. Hypotheses checked

- The reported 242 tests exist and pass: **confirmed** (242/242, 9.5 s).
- `main` had 245: **confirmed** in a worktree (245/245).
- The difference is explained by deleting server-plugin tests: **confirmed**, 9 + 5 deleted, 11 added
  (`platform` 7, `migration` 2, `client-plugins` 2). No test was silently dropped.
- Browser 4/4: **confirmed after installing Chromium**; the first run failed in 0.5 s only because the browser
  was absent.
- The server loads no client interface code: **confirmed** by reading the manifest and by a new analyser.

## 3. Defects reproduced

None in this phase; the boundaries held. Two weak points were recorded for later: no automated boundary check
existed, and the Environments page carried a copy of the default-server resolver.

## 4. Fixes

- Added `tests/architecture.test.js` (7 tests): manifest existence and contents, no DOM/browser APIs in the
  server runtime (with `db.js`'s guarded browser fallback asserted separately), the client entry point never
  loads server code, no client file reaches the store/Node/a second transport, acyclic requires, neutral shared
  modules, no compiled-in server addresses.
- Removed the duplicated resolver in `js/pages/environments.js`.
- `SERVER_ONLY` now also covers the root `server.js`.

## 5. Tests run

`node --test tests/architecture.test.js` → 7/7. Full suite after the change → 249/249.

## 6. Results

The advertised architecture is real: an API-only server, a static client, a shared model, one transport. The
boundary is now enforced by tests rather than described.

## 7. Next

The HTTP security surface (authentication, sessions, CORS, Host, SSE) and the plugin sandbox.
