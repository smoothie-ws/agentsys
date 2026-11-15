# Architecture

AgentSys is two programs and a shared contract:

```text
AgentSys Client (static browser program)
        │  Environment transport: HTTPS + token/session + SSE
        ▼
AgentSys Server (headless Node CLI)
        │
        ├── graph engine (model, interpreter, workers)
        ├── projects / workflows / Library / collections
        ├── runtime state and execution control
        └── storage (JSON files below --data)
```

The server executes. The client edits, observes and manages. A client never runs graph JavaScript, and the
server never serves client UI or loads client plugins.

## Source layout

```text
shared/
  core.js            helpers shared by both programs (errors, clone, paths, appearance bounds, grant check)
  protocol.js        product name, protocol version, paths, header and cookie names
server/
  manifest.js        the fixed server script list (no index.html reading, no plugin discovery)
  api-server.js      createApiServer(): API-only composition
  file-store.js      canonical files, sidecars, redo recovery, external-change fingerprints
  credentials.js     per-server session/token maps, expiry and revocation
  static-assets.js   public asset resolution and shared client headers (no execution/storage dependency)
  migrate.js         conservative server-plugin data migration
client/ (static)   js/app, js/pages, js/canvas, js/inspector, js/model (editing only), css, index.html
bin/
  agentsys-server.js headless server CLI
  agentsys-client.js static client server
  agentsys-local.js  convenience launcher for a local session (two processes)
js/backend/          server-only API routes and execution (never loaded by the browser)
js/storage/db.js     server-only key-value store and Context
js/model/executor.js server-only interpreter
```

`server/manifest.js` is the single list of server files. The browser cannot add a server file by editing
`index.html`. `index.html` loads only shared helpers, the editing model, and the client.

## Server

- Starts without a browser and without any client connected.
- HTTP API under `/api`, versioned by `protocol` in `GET /api/meta` and the `X-Agentsys-Protocol` header.
- Fixed feature set. **No server plugins**: no file below `data/plugins/` is executed or scanned by the
  server. User code runs only through the graph runtime (Script nodes in worker threads). The removed host and
  routes are available in git history; executable legacy copies are no longer shipped.
- Owns definitions, Library resources, generic collections, secrets, runtime and permissions.
- Owns execution. Closing a browser, or all browsers, does not pause or stop a workflow.
- Persists JSON below `--data`. JavaScript stacks, timers and pending external work do not survive a restart.
- Restores definitions and durable JSON on startup. It never silently re-runs a workflow; an automatic start
  would have to be an explicit future policy.

See [server.md](server.md).

## Client

- Static files: HTML, CSS and browser JavaScript. There is no backend, storage layer or interpreter in it.
- Loads `js/model/graph.js` for read-only snapshot lookup, binding resolution, event names and import defaults,
  and `js/model/types.js` for presentation and wire compatibility. Graph mutations and snapshot construction
  run only on the server. `schema`, `documents`, `editor`, `snapshot`, `evaluate` and `executor` are server-only
  assets, as are `js/backend/**` and `js/storage/db.js`.
- All server reads and writes go through one transport (`js/app/environments.js`). No component calls a fixed
  `/api` URL.
- Keeps only client concerns locally: environments (URLs and names), per-tab tokens, UI state, layout and
  installed client plugins.
- Can point at a local server, a LAN server or a VPS without a code change.
- Status model: `connected`, `connecting`, `disconnected`, `unauthorized`, `incompatible`, `error`.

See [client.md](client.md) and [environments.md](environments.md).

## Shared

`shared/core.js` contains pure helpers used by both programs; it has no storage, DOM or server logic.
`shared/protocol.js` is the contract:

- `PRODUCT = 'agentsys'`, `PROTOCOL = 1`.
- `GET /api/meta` returns `{agentsys, product, protocol, version, auth, features, ...}`.
- Every API answer carries `X-Agentsys-Protocol`.
- A client refuses a server whose protocol is not compatible and shows *Incompatible version*.

## HTTP API and versioning

The application API is the existing backend route table, exposed as HTTP. It is documented automatically at
`GET /api/openapi.json` and in the client's API page. Platform endpoints around it:

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | Public version/protocol/capability discovery; no secrets. |
| `POST /api/auth/session` | Exchange a bearer token for an HttpOnly session cookie. |
| `POST /api/auth/plugin-session` | Issue a short-lived token scoped to client plugin capabilities; `DELETE` revokes it. |
| `POST /api/auth/logout` | End the session. |
| `GET /api/events` | Authenticated SSE stream of `change` and `hook` events. |
| `GET /api/diagnostics` | Uptime, version, worker counts, runtime states, recent errors. Authenticated. |
| `GET /api/migration/ui-state` | Read the old server-side UI state once. Authenticated. |
| `/api/collections/...` | Generic JSON resources with schema validation. Records carry a `version`; send it as `If-Match` to make a write conditional (409 on a mismatch). |

The graph API keeps its existing shape (`projects`, `workflows`, `library`, `execution`, `net`, `secrets`, ...).
Compatibility matters more than renaming routes.

## Authorization

- A server bound to loopback with no token trusts loopback clients (the local desktop case).
- Any other exposure requires a token. The CLI refuses to start without one.
- A token is sent as `Authorization: Bearer …` by CLIs and the client; the browser client exchanges it once for
  an HttpOnly `SameSite` session cookie, so EventSource-like streaming and reloads do not expose it to scripts.
- Scripts still need both the enclosing instance grants and the project policy. `plugins.call` is accepted in
  old projects for compatibility but grants nothing now.
- Client plugins use distinct server-enforced scoped bearer tokens. Host checks and token checks both apply.
  Only a server returning 404 for token issuance uses legacy host-only checks; other failures stop the call.
  See [plugins.md](plugins.md) and [security.md](security.md).

## State ownership

| State | Owner | Location |
|---|---|---|
| Projects, workflows, graphs, layout | Server | `--data` JSON |
| Library resources and groups | Server | `--data/library` |
| Runtime JSON (state, outputs, previews) | Server | `--data/workflows/<id>/runtime.json` |
| Generic collection definitions and records | Server | `--data/other`, `--data/collections...` |
| Secrets | Server | `--data/secrets` (never returned by reads) |
| Project policies / node grants | Server | `--data/other/policy…` |
| Environment list, UI layout, theme, clipboard, tabs | Client | browser `localStorage` |
| Per-tab server token | Client | browser `sessionStorage` (never `localStorage`) |
| Server session | Server memory + HttpOnly cookie | expires after `--session-hours` |
| Client plugins | Client | browser `localStorage` |

## Lifecycle

**Server:** create backend → recover an interrupted transaction if one exists → watch files → listen → serve
runs and API → on SIGINT/SIGTERM stop runtimes, close streams, flush the store, exit.

**Client:** read local preferences → choose the active environment → probe `/api/meta` → verify protocol →
renew/exchange the session → load session, projects, Library → connect SSE → render. On environment switch:
flush edits to the old server, abort its requests, close its stream, clear per-server caches and tabs, then load
the new server. Responses from the old generation are rejected with `stale_environment`.

## Compatibility

The refactoring responsibility/dependency inventory is in
[the architectural worklog](audits/architecture-refactoring/WORKLOG.md). Ordered manifests still provide
classic-script dependencies; the source graph is not an ES-module graph. Canvas and Inspector share the
current page's `W` object. It contains presentation indexes and transient edits, not an executable graph or
an independently authoritative backend model.

Rendered plugin contributions have one owner (`PluginViews`): page, Library, resource, home, settings and
Inspector registrations live in one list. Navigation and page/section lists are projections; disabling a plugin
removes one owner's entries. `extensions.js` owns sandbox lifecycle, commands and explicit toolbar/menu links;
`plugin-frame.js` supplies the isolated SDK program; `plugin-content.js` remains the sanitization boundary.
Failures are recorded once in the host's error map. Scoped credentials remain owned by the environment
transport and revoked when a sandbox is disposed or an environment generation ends.

The HTTP server has one SSE subscriber map and cleanup path for both `/api/events` and legacy
`/__data/events`. Their public encodings remain distinct. Backpressure ends a subscription, including during
the handshake. The file watcher uses the actual subscriber count; both encodings observe external changes.

Existing project data uses `agentsys.text/1` graph files and JSON keys; the engine and format were not
rewritten. Existing Library nodes, including nodes created by the old AI plugin, remain ordinary graphs and
keep running. What changes is where the client gets them and how it authenticates. Migration is described in
[migration.md](migration.md).
