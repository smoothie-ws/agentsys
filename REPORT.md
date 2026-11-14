# AgentSys platform refactoring — report

Branch: `platform/server-client`, based on `main` at `7cca21e`.
Cycle: the platform split (server/client), remote environments, client-only plugins and the migration.
Nothing in this report is marked verified unless the command or file is named.

## 1. Executive summary

The single local application is now two programs with one documented contract:

- **AgentSys Server** (`bin/agentsys-server.js`): API-only CLI, no GUI, no server plugins, fixed manifest,
  JSON storage, worker-based execution, sessions, CORS/CSRF, SSE, diagnostics and a conservative migration tool.
- **AgentSys Client** (`bin/agentsys-client.js` and the static files in `js/`, `css/`, `index.html`): no backend,
  no interpreter, no storage access, one environment-aware transport, client-local UI state, environments page,
  connection status and sandboxed client plugins.
- **Shared** (`shared/core.js`, `shared/protocol.js`): helpers and the versioned contract.

The graph engine was not rewritten. Its 242-node-test suite still passes, and the browser suites still pass
against the combined local editor as well as the new split platform. A new end-to-end browser test covers the
required scenario: start server and client separately, create and run a graph, close the client, observe the
server finish, reopen, switch to a second server, use a sandboxed plugin-created node, restart the server and
verify JSON restoration without a rerun.

The honest limits are in §13: no durable checkpoints, no per-plugin capability model, no automated TLS test, and
the old combined `server.js` remains for the regression suite/local `/editor/` mode.

**Status at a glance**

| Area | Status |
|---|---|
| Independent API server / CLI | Implemented and verified |
| Independent static client / transport | Implemented and verified |
| Environment management and switching | Implemented and verified |
| Client plugin sandbox and node creation | Implemented and verified |
| Server plugin removal and data preservation | Implemented and verified |
| Generic collections API | Implemented and verified |
| Migration (providers/secrets/backups) | Implemented and verified |
| HTTPS/reverse-proxy deployment | Implemented; documented; not automated-tested |
| Per-plugin authorization, durable execution, workflow transfer | Not implemented (roadmap) |

## 2. Architecture

```text
Client (static) ── environment transport ── Server (headless)
  UI, canvas            HTTPS/token/session          API, engine, runtime
  edit/validate         SSE events                   projects, Library, collections
  client plugins        generation guard             secrets, permissions, storage
```

Implemented rules:

- The server does not import client UI, does not serve it in the platform CLI, does not load plugins and has a
  fixed file manifest (`server/manifest.js`). `index.html` is no longer a server manifest.
- The client does not start a backend, does not load `executor.js`, `js/backend/**` or `js/storage/db.js`, and
  never reads server storage directly.
- `GET /api/meta` is public and reports product, server version, protocol version, auth mode, features and
  uptime. `X-Agentsys-Protocol` is on every answer. A client refuses an incompatible protocol.
- The server owns definitions, Library, runtime, secrets and permissions. The client owns environments, UI
  layout, per-tab tokens and client plugins.

See `docs/architecture.md`.

## 3. Server

**Implemented**

- API-only composition (`server/api-server.js`) and CLI (`bin/agentsys-server.js`):
  `start`, `status`, `version`, `help`, `migrate`.
- `--host`, `--port`, `--data`, `--name`, `--token`, `--allowed-origin`, `--allowed-host`, `--tls-cert/key`,
  `--session-hours`, `--quiet`; environment equivalents.
- Refuses to bind a non-loopback address without a token.
- Public `/api/meta`; authenticated `/api/diagnostics` (uptime, version, storage mode, workers, live runtimes,
  recent errors, client count).
- Bearer auth plus `POST /api/auth/session` → HttpOnly `SameSite` cookie; logout; CSRF header/origin checks.
- Exact CORS allowlist, no `*` with credentials; loopback origins only on a tokenless loopback server.
- Authenticated SSE at `/api/events` with `ready`, `change` and `hook` events; heartbeat; reconnect clients read
  current state.
- Sessions in memory, 12 h default; no session survives a restart, but the client renews once from its tab token.
- No `/__data` on the platform server; no plugin host; the removed host/routes are archived under `legacy/` and
  are not in the manifest.
- Static allowlist in the combined server rejects `js/backend/**`, `js/storage/db.js`, `js/model/executor.js`
  and server files.
- Graceful stop stops active runtimes and closes clients; restart restores JSON and never auto-runs.
- Generic collections API (`GET/PUT/DELETE /api/collections…`) with a JSON-Schema subset, record and size
  limits, ids, timestamps and permissions.
- `POST /api/library/script-nodes`: a documented route a client plugin uses to create an ordinary Script-backed
  Library node.
- `GET /api/migration/ui-state`: one-time read of old server-side UI state.
- Migration CLI with dry run, backup, preserved plugin sources/data, provider→collection/secret conversion and
  reporting of `plugins/…` callers.

**Verified**: `tests/platform.test.js`, `tests/migration.test.js`, `tests/server.test.js`, `browser_platform.py`,
and `agentsys-server status/version/help` run manually.

## 4. Client

**Implemented**

- Static client; index no longer loads storage/backend/executor. The static server refuses server-only files.
- One transport (`js/app/environments.js`):
  - active base URL, bearer or HttpOnly session;
  - 30/120 s timeouts, abort, caller signal;
  - `stale_environment` generation guard;
  - no mutation retries (one renewal after a clean 401 only);
  - SSE over `fetch` with backoff;
  - statuses connected/connecting/disconnected/unauthorized/incompatible/error.
- UI state moved to `localStorage`; old server state can be imported once; per-tab token in `sessionStorage`.
- Environments page: list, add, test, edit, remove, use, reconnect, sign out; active indicator in the top strip.
- Environment switch: flush edits, abort old requests, close stream, clear tabs/caches, load new server, reject
  late old answers.
- Settings page works without backend globals (`GRAPH_RANGES` moved to shared).
- Collections page for generic definitions/records.
- Client plugin system: package store, install/import/enable/disable/remove, sandboxed iframe, commands, pages,
  toolbar, menus, sidebar, dashboard cards, restricted styles, API requests, per-plugin/per-server storage.

**Verified**: `browser_platform.py` (split, environments, reconnect, two servers), `browser_execution_ui.py`,
`browser_shell.py`, `browser_design.py`, and manual Playwright checks of Settings, API reference, Collections and
the plugin page.

## 5. Remote environments

Implemented scenarios:

1. Client on a PC → local server (split launcher).
2. Client → another server on the network (manual address; exact CORS; token/session).
3. Client → VPS (documented HTTPS reverse proxy; direct TLS option in the server).
4. Phone → VPS (responsive environment page and indicator; not re-tested on a physical phone).
5. Two clients → one server (SSE broadcast; the old combined tests also use two pages).
6. Client disconnects while a workflow runs (verified: it finishes).
7. Reconnect and read current state (verified after page close/reopen and server restart).
8. Server restart (verified: JSON restored, idle state, no rerun).
9. Two independent servers and switching without mixing data (verified).

Not implemented: transferring projects/workflows between environments.

## 6. Plugins

**Implemented**

- Server host removed from the runtime and the manifest. `legacy/server-plugin-host.js` and
  `legacy/routes-plugins.js` are reference archives and are never required.
- Client plugin package: id/title/version/description/icon/api/source, validation, size limits, `localStorage`.
- Sandbox: opaque-origin Blob iframe, `allow-scripts`, no DOM/storage/cookies/token, JSON RPC host.
- Host API: request, storage, settings, commands, pages, sidebar, toolbar, menu, home cards, restricted CSS,
  notifications, toast, navigate, refresh, env info, change events.
- Page/card HTML sanitizer; external CSS URLs refused.
- Bundled examples: `hello-ui` and `script-node-builder`.
- `script-node-builder` creates `Greeting` through the standard API; disabling the plugin leaves the node in the
  Library and executable on the server (verified).
- Legacy plugin data is preserved, providers migrate to a collection, API keys to secrets; route callers are
  reported.

**Limits**: no per-plugin capability declarations; a plugin can call the user's API. Documented as a trust
boundary, not a sandbox for malicious plugins.

## 7. Security

Implemented: token requirement off-loopback, timing-safe compare, HttpOnly session, CSRF header + origin,
exact CORS, Host validation, security headers, no tokens in query/localStorage, secret metadata-only reads,
secret redaction in errors, static allowlist, plugin iframe isolation and HTML sanitization, migration secret
move.

Not proven/remaining: no automated TLS handshake test; loopback trust assumes a benign local machine; a
user-installed client plugin has the user's API authority; sessions are memory-only; no multi-user roles or
audit log. See `docs/security.md`.

## 8. Reliability

Defects found and fixed during the work:

1. Removing client backend code exposed `parentPath`/`underPath` missing in navigation and Library pages → moved
   to `shared/core.js`.
2. `GRAPH_RANGES`/`WIRE_STYLE_IDS` missing in Settings → shared.
3. `checkManifest` missing in the client editor → shared; server still enforces it.
4. `/api/library/sections` was registered by the removed plugin routes → fixed empty server route; boot no longer
   fails.
5. `/editor/` deep links resolved `shared/` and `client-plugins/` against the workflow URL → fixed `/editor/`
   asset rewrite (caught by `browser_execution_ui`).
6. Token-protected SSE was unusable from `EventSource` → fetch streaming with auth and cookie session.
7. Browser-only mode could execute graphs locally → removed; client has no interpreter.
8. UI state was shared on the server → moved to client with one-time import.
9. Server plugins could register arbitrary routes → removed; fixed manifest.
10. Server restart lost in-memory sessions → transport renews once from the per-tab token.
11. Edits of an environment cleared its saved token → empty now keeps it; explicit sign-out clears it.
12. Failed plugin activation could leave registrations behind → cleanup path added.

Existing mechanisms preserved: atomic multi-key commits, `.transaction.json` replay, stale cursor conflicts,
Stop/Pause/Resume behavior, worker cancellation, runtime eviction, durable JSON.

## 9. Performance

No engine rewrite and no optimization based on guesses. Current measurements on the same machine (Node
v20.11.0, Windows):

| Metric | Before (`docs/baseline.md`) | After | Note |
|---|---:|---:|---|
| `GET workflow` 100 nodes | 2.32 ms | 2.04 ms | within run variance |
| 200 nodes | 4.92 ms | 3.66 ms | |
| 400 nodes | 8.43 ms | 7.22 ms | |
| 800 nodes | 17.98 ms | 26.08 ms | run-to-run variance; no engine change |
| 800 nodes in 200 groups | 23.41 ms | 19.26 ms | |
| `GET execution` 800 nodes | 0.025 ms | 0.018 ms | |
| Script loop 5 000 assignments | 61.6 ms | 45.4 ms | engine change from the earlier hardening branch, not this one |
| Idle runtimes after 20 visits | 22 (then fixed to 16) | 16 | prior hardening |
| Library type lookup, 20 ids/6 workflows | 187 ms | 25 ms | prior hardening |

Platform-specific additions measured now:

- API-only server start through first `/api/meta` response: **46 ms** (in-process, temp folder).
- `GET /api/projects`, authenticated, empty folder: **0.85 ms median**, 1.62 ms p95 over 30 requests.
- Client scripts requested by `index.html`: **48 files / 664 KB**.
- All `js/**/*.js`: 65 files / 898 KB; server-only set no longer requested by the browser: 19 files / 238 KB.
- Node test suite: **242 pass / 0 fail / 9.1 s**.
- Browser suite: platform 9.7 s, execution_ui 10.0 s, shell 14.2 s, design 6.5 s (4/4 pass).

## 10. UI/UX

- Current environment shown in the top strip with a state dot and a menu of servers.
- Environments page with test/use/edit/remove/reconnect/sign-out and clear status messages.
- Sidebar entries for Environments and Collections.
- Connection states and actionable errors (token, incompatible version, unreachable).
- Environment switch clears stale tabs and data and returns to the dashboard.
- Client plugin pages integrate with the existing page header, cards, dialogs and toasts.
- Collections page for generic resources.
- Mobile: environment indicator shrinks, environment rows stack, existing responsive layout otherwise kept.
  A full mobile canvas review was not part of this cycle.

## 11. Compatibility

- Graph format `agentsys.text/1`, project ids, workflow ids, node ids and Library ids are unchanged.
- Existing projects, workflows, Custom Nodes, types, permissions, signals, Run/Pause/Resume/Stop and
  import/export remain; 242 Node tests pass against the same engine.
- Old Library nodes created by the AI plugin remain ordinary graphs and can still be placed and run, unless
  their Script calls a removed `plugins/…` server route.
- Old UI state is preserved and importable.
- Old plugin sources/data are preserved under `data/plugins-migrated/` and in a backup; they are not executed.
- Tokens move from a header on every request to an optional session cookie; bearer still works.
- `plugins.call` grants still validate for old projects but grant nothing.

## 12. Tests

Commands run:

```sh
npm test
python tests/browser_suite.py
node tools/bench.js --json
node bin/agentsys-server.js status --url http://127.0.0.1:8123
```

Results:

- Node: **242 pass, 0 fail** (9.1 s). Includes new `platform`, `client-plugins` and `migration` tests.
- Browser: **4/4** — `platform`, `execution_ui`, `shell`, `design`.
- `browser_platform.py` chain: split start → no Backend/DB → Environments connected → create/run → close client →
  server finishes → reopen → second server isolated → back → plugin creates node → plugin off, node remains →
  server restart restores JSON, no rerun. All steps passed.
- Bench: JSON above.
- Legacy `browser_smoke.py` and `browser_plugins.py` target removed modes and are not in the default suite.

## 13. Remaining issues

**Partially implemented / limitations**

- Server sessions are memory-only; a hard restart loses cookies (client renews only if it still holds a token).
- Client plugins have no capability manifest; sandbox isolates code, not API authority.
- Collections validate a subset of JSON Schema (`type`, `properties`, `required`, `items`, `enum`,
  `additionalProperties`, `maxLength`); no `pattern`, `minimum`, `oneOf`, etc.
- Generic collection UI shows and edits raw JSON; no generated forms.
- Client plugins cannot add DOM-rendered pages or custom Library forms; they return sanitized HTML.
- Mobile layout was only checked through the existing design script and CSS, not on a device.

**Not implemented**

- Durable checkpoints, resumable JavaScript, per-task state isolation, resource budgets, idempotent external
  operations, distributed execution, fault recovery (see `docs/future-runtime.md`).
- Workflow deployment/copy between servers.
- Execution history beyond durable runtime JSON and diagnostics.
- Multi-user roles, per-plugin permissions, audit log.
- TLS end-to-end automation, reverse-proxy automation.
- Automatic rewriting of Scripts that call removed plugin routes.

**Debt**

- `server.js` is still a combined local/test server with `/__data`; it is not the deployment server but remains
  in the tree for the old suite and `/editor/` convenience.
- `js/model/editor.js` and `js/inspector/inspector.js` remain large; the split did not rewrite them.
- Client still duplicates small display helpers from the server (`previewText`), intentionally to avoid loading
  backend code.

## 14. Roadmap

1. Durable checkpoints and explicit resume policy; side-effect idempotency.
2. Per-scope state and execution tracing; resource budgets.
3. Per-plugin capability manifest and a real authorization boundary for installed plugins.
4. Workflow deployment with dependency/version checks (definitions only, never an active runtime).
5. TLS and reverse-proxy integration tests; certificate guidance in CI.
6. Generated forms for collection schemas; mobile canvas pass.
7. Distributed workers only after 1–2 exist.
