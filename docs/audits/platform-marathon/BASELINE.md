# Baseline — independent verification of the platform refactor

This file records what was measured directly, not what a previous report claimed. Every number below was
produced by a command on the checkout described here.

## Environment and starting point

| Item | Value |
|---|---|
| Date and time at start | 2026-11-14T14:56:29+10:00 (Unix 1794632189) |
| Planned end (start + 43 200 s) | 2026-11-15T02:56:29+10:00 |
| Repository | `smoothie-ws/agentsys` (local checkout) |
| Source branch | `platform/server-client` |
| Source commit | `5123643be41a0227f6cb5e9ea586cfee816e1946` (`docs: record final platform test timings`) |
| `main` at the same time | `7cca21e` (`Merge pull request #1 from smoothie-ws/hardening/12h`) |
| Node / npm | v20.11.0 / 10.2.4 |
| Platform | Windows 10, PowerShell |
| Audit branch | `audit/12h-platform-hardening` (created from `platform/server-client`) |
| Working tree at start | clean (`git status --short` empty) |

## Test baseline (measured, not reported)

Command: `node --test` in the checkout root.

| Checkout | Tests | Pass | Fail | Duration |
|---|---|---|---|---|
| `platform/server-client` @ `5123643` | 242 | 242 | 0 | 9.5 s |
| `main` @ `7cca21e` (git worktree at `%TEMP%\agentsys-main`) | 245 | 245 | 0 | ~10 s |

Browser suite: `python tests/browser_suite.py` → **4/4 PASS** (`platform`, `execution_ui`, `shell`, `design`).
The first run failed in 0.5 s because the Playwright Chromium build was missing; after
`python -m playwright install chromium` the suite passes. The previous report's "4/4" is therefore reproducible,
but only with browsers installed. This is an environment dependency that `docs/testing.md` must state.

## Where the 3 missing tests went (245 → 242)

The delta is fully accounted for; no test was silently dropped.

| File | On `main` | Now | Delta |
|---|---|---|---|
| `tests/plugins.test.js` | 9 | deleted | −9 |
| `tests/plugins-controller.test.js` | 5 | deleted | −5 |
| `tests/platform.test.js` | 0 | 7 | +7 |
| `tests/migration.test.js` | 0 | 2 | +2 |
| `tests/client-plugins.test.js` | 0 | 2 | +2 |
| all other `*.test.js` | unchanged | unchanged | 0 |

`245 − 14 + 11 = 242`. The 14 removed tests covered the server plugin host (`api.route`, plugin
controllers, plugin servers routes), which this architecture intentionally removes. Their replacement
coverage is partial and was checked item by item:

| Removed capability | Replacement | Verdict |
|---|---|---|
| Plugin provider routes (`POST plugins/ai/providers`, URL validation, key masking) | `collections` schema validation + `secrets` routes (`platform.test.js`, `migration.test.js`) | covered, but no test asserts that a provider URL like `file://` is refused by the collection itself (the old plugin enforced it) |
| Plugin route reached by a Script (`plugins.call` grant) | `permissions.test.js` still validates the grant string; the route no longer exists | grant string accepted but unusable — documented in `shared/core.js` |
| Plugin client module (`client.js`) | sandboxed client plugins (`client-plugins.test.js`, `browser_platform.py`) | covered |
| Plugin stop aborts its calls | engine/execution tests cover Stop; no server-plugin equivalent needed | covered |
| Plugin secrets with masked key | `secrets` route + migration test | covered |

No test was deleted that still had a subject in the new architecture.

## Architecture claims checked against the source

| Claim | Evidence | Result |
|---|---|---|
| The server does not depend on the client | `server/manifest.js` lists 27 runtime files; `js/backend/` and `js/storage/db.js` are server-only; `headless.js` loads only that list into a `vm` | confirmed |
| The client contains no executable backend | `index.html` loads `shared/*`, `js/model/*`, `js/app/*`, `js/canvas/*`; it never loads `js/backend/*`, `js/storage/db.js`, `js/model/executor.js` | confirmed |
| The server loads no plugins | no `plugin-host` reference in `server.js`; `legacy/server-plugin-host.js` is not in the manifest and nothing requires it | confirmed |
| A local launch works | `bin/agentsys-local.js` composes the API server and the client | confirmed by code; run check below |
| Client plugins use ordinary API calls | `extensions.js` → `Environment.request`; `plugin-store.js` keeps packages in `localStorage` | confirmed |
| Remote environments are isolated in the client | `environments.js` keeps one active environment, a generation counter and per-environment tokens in `sessionStorage` | mostly; the switch does not actually abort in-flight requests (found in the audit, see `CHECKPOINT-01.md`) |

## Launch checks

- `node bin/agentsys-server.js start --port 0 --data <tmp>` starts and answers `/api/meta`.
- `node bin/agentsys-client.js --port 0 --server <url>` serves `index.html` with CSP and `X-Frame-Options: DENY`.
- `node bin/agentsys-local.js` serves the combined editor (verified through the browser suite).
- The combined `node server.js` (legacy convenience mode) does **not** send the CSP / `X-Frame-Options`
  headers the standalone client sends — a real gap recorded as finding `SEC-01`.
- `tests/browser_platform.py` independently exercises: client connects to a separate server, has no
  `Backend`/`DB`, creates a project + workflow, runs work that survives closing the client, reopens,
  switches to a second server and back with no data mixing, runs a bundled client plugin that creates a
  Library node, disables the plugin, and restarts the server without re-running the workflow. All pass.

## What this baseline does *not* prove

- Passing tests do not prove architectural boundaries; there were no automated boundary checks at
  `5123643`. `tests/architecture.test.js` is added by this audit.
- The browser suite covers one viewport (1400×900); mobile layout, focus handling and keyboard
  navigation were not asserted.
- No test asserted that two concurrent writers cannot lose an update, nor that a client plugin cannot
  reach another plugin's commands.
- No test measured memory or worker growth over repeated runs.

These gaps are the subject of the checkpoints that follow.
