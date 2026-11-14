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
| `--tls-cert`, `--tls-key` | PEM files; enables HTTPS directly |
| `--session-hours <n>` | Session lifetime; default 12 |
| `--trust-proxy` | Trust `X-Forwarded-Proto` from a local reverse proxy (Secure cookies) |
| `-q, --quiet` | Print only errors |

Environment variables: `AGENTSYS_TOKEN`, `AGENTSYS_ALLOWED_ORIGINS` (comma separated), `ALLOWED_HOSTS`,
`DATA_DIR`, `HOST`, `PORT`, `AGENTSYS_NAME`, `AGENTSYS_TRUST_PROXY=1`.

## Startup and shutdown

1. The data folder is created if needed.
2. An interrupted `.transaction.json` is replayed once, then the files are scanned.
3. The backend loads from the fixed `server/manifest.js`; the API is available immediately.
4. The file watcher announces external changes to connected clients.
5. On `SIGINT`/`SIGTERM`: active workflows are stopped, event streams close, and the process exits.

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
- Unsafe cookie-authenticated requests need `X-AgentSys: 1` and an allowed `Origin` (CSRF protection).
- CORS is an exact allowlist (`--allowed-origin`); `*` is never sent for credentials. A tokenless loopback
  server also accepts loopback origins so the split local launcher works.

See [security.md](security.md) and [deployment.md](deployment.md).

## Multiple clients

Any number of clients may connect. State changes are broadcast over SSE to all authenticated streams. Each
client reads the current state after reconnecting; mutations are never replayed automatically. A slow or dead
client cannot block execution; its stream is simply closed.
