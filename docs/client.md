# AgentSys Client

The client is a static browser program. It serves nothing, runs no graph JavaScript, owns no projects and
contains no storage access. It edits and observes whatever the active AgentSys Server owns.

## Running

```sh
node bin/agentsys-client.js --port 8081 --server http://127.0.0.1:8080
# or, for a local session with both processes:
npm start
```

`npm start` / `start.bat` launch an AgentSys Server on port 8080 and a client on 8081, then open the client.
They remain separate processes: closing the browser does not stop the server or its workflows.

The client can also be served by any static web server. `--server` and `AGENTSYS_DEFAULT_SERVER` only choose
the initial environment for a fresh browser profile; the user can add or change servers in the interface.

## What it loads

`index.html` loads:

- `shared/core.js`, `shared/protocol.js` — pure helpers and the API contract.
- `js/storage/format.js` — reading and writing `agentsys.text/1` packets for import/export.
- `js/model/{schema,types,snapshot,documents,editor,evaluate}.js` — local graph editing, validation and previews.
- `js/app/*`, `js/pages/*`, `js/canvas/*`, `js/inspector/*`, CSS.

It does **not** load `js/model/executor.js`, `js/backend/**` or `js/storage/db.js`. The static server refuses
to send them even if a link points there.

## API transport

`js/app/environments.js` is the only transport. Every request passes through it; there is no direct `fetch('/api')`
in a page or canvas module.

- Base URL of the active environment.
- Bearer token (from `sessionStorage`) or the HttpOnly session cookie.
- JSON error mapping to `ApiError`.
- Abort/timeout, and a generation counter that rejects answers from a previous environment with
  `stale_environment`.
- No automatic retry of mutations. A clean `401` may renew the session and retry once; a network failure is
  reported, not repeated.
- SSE through `fetch` streaming so the same auth applies; reconnect with exponential backoff.
- `subscribe()` and `subscribeHooks()` expose server changes without exposing the transport.

## Local storage

| Key | Contents |
|---|---|
| `agentsys-ui-store` | panel sizes, theme, tabs, camera, clipboard, filters |
| `agentsys-environments` | environment id, name and base URL (no tokens) |
| `agentsys-active-environment` | id of the last active environment |
| `agentsys-client-plugins` | installed client plugin packages |
| `agentsys-plugin-<id>@<env>:` | plugin-private JSON, scoped per plugin and server |
| `sessionStorage: agentsys-token:<env>` | per-tab token; cleared when the tab closes |

The old server-side `data/other/ui-state.json` is not used for new writes. Environments → *Import old interface
state* reads it once through the authenticated API for a person who wants the previous layout.

## Switching environments

1. Flush every open editor to the old server (or ask the user).
2. Abort in-flight requests and close the old event stream.
3. Clear per-server view state: tabs, project tree, Library caches.
4. Change the active endpoint.
5. Probe `/api/meta`, check the protocol, renew/exchange the session.
6. Load the new session, projects, Library.
7. Reconnect SSE and render the dashboard.

Late answers from the old environment are rejected by the generation check; they cannot repaint the new one.
Workflows are not copied between environments. Moving data between servers is a separate future feature.

## Connection states

`connected`, `connecting`, `disconnected`, `unauthorized`, `incompatible`, `error`. They are shown by the dot
beside the environment name, in the environment menu and on the Environments page, with an actionable message
("Add its token", "Update the server", "The server could not be reached").

## Client plugins

Installed in this browser and run in a sandboxed iframe. See [plugins.md](plugins.md).

## Packaging later

The client is already a standalone static program with a single transport and no backend. A PWA manifest,
service worker or a desktop shell can wrap it later without changing the server contract. No Electron/Tauri
infrastructure is included in this cycle.
