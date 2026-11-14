# AgentSys Server

`bin/agentsys-server.js` is a headless Node program. It has no GUI dependency, no server plugin loader and no
browser storage endpoint. It only needs Node.js (20 or newer) and a writable data folder.

## Commands

```sh
node bin/agentsys-server.js start --port 8080 --data ./data
node bin/agentsys-server.js status --url http://127.0.0.1:8080
node bin/agentsys-server.js version
node bin/agentsys-server.js migrate --data ./data --dry-run
```

`npm run server` runs the start command with the defaults. `--help` lists every option.

| Option | Meaning |
|---|---|
| `-p, --port <n>` | TCP port; `0` chooses a free port (printed at startup) |
| `-H, --host <address>` | Bind address; default `127.0.0.1` |
| `-d, --data <folder>` | Data folder; default `./data` |
| `--name <text>` | Name shown to clients |
| `--token <token>` | API token; also `AGENTSYS_TOKEN` |
| `--allowed-origin <url>` | Exact browser origin allowed by CORS (repeatable) |
| `--allowed-host <name>` | Accepted `Host` name on loopback, or the pinned names when remotely bound |
| `--allow-net <host>` | Restrict `POST /api/net` and a Script's `net.fetch` to these hosts (repeatable; `*` allowed) |
| `--tls-cert`, `--tls-key` | PEM files; enables HTTPS directly |
| `--session-hours <n>` | Session lifetime; default 12 |
| `--trust-proxy` | Trust `X-Forwarded-Proto` from a local reverse proxy (Secure cookies) |
| `-q, --quiet` | Print only errors |

Environment variables: `AGENTSYS_TOKEN`, `AGENTSYS_ALLOWED_ORIGINS` (comma separated), `ALLOWED_HOSTS`,
`AGENTSYS_ALLOW_NET` (comma separated egress hosts), `DATA_DIR`, `HOST`, `PORT`, `AGENTSYS_NAME`,
`AGENTSYS_TRUST_PROXY=1`.

## Startup and shutdown

1. The data folder is created if needed.
2. The folder is locked (`data/.server.lock`, holding the pid): a second server on the same folder exits with a
   message naming the process that holds it. A lock left by a crashed process is detected and taken over.
3. An interrupted `.transaction.json` is replayed once, then the files are scanned.
4. The backend loads from the fixed `server/manifest.js`; the API is available immediately.
5. The file watcher announces external changes to connected clients.
6. On `SIGINT`/`SIGTERM`: active workflows are stopped, event streams close, the lock is released, and the
   process exits.

The server restores stored JSON, port values and previews. It does **not** resume JavaScript stacks, timers or
pending external requests, and it does not automatically re-run workflows that were active before a restart.
No auto-start option exists in this cycle; a future policy must be explicit.

## Data folder

```text
data/
  settings.json          preferences (server-side graph settings, not client UI layout)
  projects.json
  workflows/<id>.json     graph definition (agentsys.text/1)
  workflows/<id>.files/   layout.json and script sidecars
  workflows/<id>/runtime.json  durable runtime JSON
  library/resources.json
  library/editors/…       Library graph definitions
  library/types.json
  other/                  application keys (policies, notifications, collections, …)
  secrets/<name>.json     secret values (never returned by GET)
  backups/                migration snapshots
  plugins/                legacy server-plugin files (never executed; preserved)
  plugins-migrated/       preserved plugin sources/data from the migration
```

Writes are atomic: a temporary file is renamed into place, a transaction record makes multi-key commits
recoverable, and a stale write is detected with the workflow cursor / `If-Match`.

## API

- Application API: `/api/...`, OpenAPI at `GET /api/openapi.json`.
- Public discovery: `GET /api/meta`.
- Events: `GET /api/events` (authenticated SSE; `change` and `hook` envelopes).
- Diagnostics: `GET /api/diagnostics`.
- No `/__data` endpoint on the platform server. The combined legacy `server.js` keeps it for the old local
  browser store and its regression tests only.

Errors are JSON:

```json
{"error": {"code": "invalid_request", "message": "…"}}
```

## Authentication

- Loopback with no token: trusted for a local desktop.
- A token is required on any other address; the CLI refuses to start without one.
- `POST /api/auth/session` accepts a token in the JSON body or as a Bearer header and sets an HttpOnly session
  cookie. Reads and writes accept either the cookie or the Bearer header.
- Sessions live in memory for `--session-hours` (12 by default). The map is swept and capped (`sessionLimit`,
  10 000 by default); the oldest session is evicted first. A restart invalidates every session.
- Sign-in attempts are limited per address (10 per minute by default; `AGENTSYS_AUTH_ATTEMPTS` and
  `AGENTSYS_AUTH_WINDOW_MS`). Over the limit answers `429` with `Retry-After`; a success clears the count.
- Unsafe cookie-authenticated requests need `X-AgentSys: 1` and an allowed `Origin` (CSRF protection).
- CORS is an exact allowlist (`--allowed-origin`); `*` is never sent for credentials. A tokenless loopback
  server also accepts loopback origins so the split local launcher works.
- A known path called with an unsupported method answers `405` and names the methods in `Allow`; an unknown path
  is `404`; a body over the limit is `413`.
- `POST /api/auth/plugin-session` issues a short-lived token scoped to a list of capabilities for a client plugin
  (`{"capabilities":["graph.read", …]}`); the server enforces it on every call, an issued token cannot issue
  another, and `DELETE` with the token revokes it. Tokens live in memory (one hour by default,
  `pluginSessionTtlMs`; at most 1000, `pluginSessionLimit`) and diagnostics reports their count, never a value.

See [security.md](security.md) and [deployment.md](deployment.md).

## Errors

Every API error has the shape `{"error": {"code": "...", "message": "..."}}`. Codes a client should branch on:

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | The body, a value, a schema or a path is malformed |
| `unauthorized` | 401 | No credential, or the token/session is not valid |
| `plugin_token_invalid` / `plugin_token_expired` | 401 | A scoped plugin token was revoked, is unknown, or timed out |
| `forbidden` | 403 | Host, Origin or CSRF check refused the request |
| `permission_denied` | 403 | A capability or Script grant does not cover this call; the message names it |
| `developer_mode_required` | 403 | Editing Custom nodes by hand needs developer mode |
| `not_found` | 404 | Unknown route, project, record or collection |
| `method_not_allowed` | 405 | The path exists with other methods; `Allow` names them |
| `conflict` | 409 | `If-Match` did not match the workflow cursor or the record version; read again and retry |
| `too_large` | 413 | The body is over the route's limit (20 MB for graph routes, 64 KB for a session request) |
| `rate_limited` | 429 | Too many sign-in attempts from this address; `Retry-After` says how long |
| `internal` | 500 | An unexpected failure; the message is redacted and the details are in diagnostics |

The client also produces `network_error` (the server could not be reached), `stale_environment` (an answer of a
previous environment was discarded) and `invalid_response` (the address did not answer as an AgentSys server) —
those never come from the server.

## Multiple clients

Any number of clients may connect. State changes are broadcast over SSE to all authenticated streams. Each
client reads the current state after reconnecting; mutations are never replayed automatically. A slow or dead
client cannot block execution; its stream is simply closed.
