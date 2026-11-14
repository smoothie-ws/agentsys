# Environments

An environment is a connection to one AgentSys Server instance. It is not a folder, a project or a copy of a
workflow. Each server has its own projects, Library, runtime, storage, secrets and permissions.

```text
AgentSys Client
      │
      ├── Localhost         http://127.0.0.1:8080
      ├── Home server       https://agentsys.home.example
      └── VPS Frankfurt     https://agentsys.example.com
```

## Managing environments

Open the **Server** row in the left sidebar, just above **Settings** (it shows the active server, `Local Server` by default). It opens the Manage servers page, where each saved server is a card. A card's **⋯** menu has Use/Reconnect, Test connection, Edit server and Remove server; the page heading's **⋯** has Add server and Reconnect.

- **Add**: name, base URL and, if the server asks, a token.
- **Test**: probes `/api/meta` without switching.
- **Use this server**: makes it active and loads its data.
- **Edit**: change the name or URL; leave the token field empty to keep the current one.
- **Remove**: deletes the saved connection only. No server data is touched.
- **Reconnect**: retries the active server, useful after a restart.
- **Forget token for this tab** (on an active server with a saved token): removes the tab's token and asks the server to end the cookie session.

Tokens are stored in `sessionStorage`, per tab. They are never written to `localStorage`, never put in a URL
and never shown again by the client. A token is exchanged for an HttpOnly session cookie; plugin code cannot
read either.

## Defaults

- The split local launcher passes `http://127.0.0.1:<server port>` as the default for a new environment.
- A client served by the combined local server uses the page origin.
- A client opened on a phone or another machine does not assume that `127.0.0.1` is the user's PC. The address
  field starts with a value but must be confirmed and can be replaced by the LAN/VPS address.
- The last active environment is remembered by id.

## Switching and isolation

Switching flushes edits, aborts old requests, closes the old stream, clears the old server's tabs and caches,
then loads the new server. Each request carries the generation of the environment it was made for. An answer
from a previous generation raises `stale_environment` and is ignored. SSE events from the old socket are
discarded because the socket is closed and the generation changed.

Client plugins remain installed across environments; their private storage is namespaced by environment id so
one server's settings do not appear on another.

## Statuses

| Status | Meaning |
|---|---|
| Connected | `/api/meta` matches the protocol and the session works. |
| Connecting | Probe, auth or initial state load in progress. |
| Disconnected | Network failure, server stopped, or SSE lost; reconnect is retried. |
| Unauthorized | The server requires a token or rejected the session. |
| Incompatible version | The server speaks another protocol version; update one side. |
| Connection error | Any other transport/protocol error, with the message shown. |

## Scenarios covered by tests

- Client on a PC → local server.
- Client → LAN/VPS over HTTP with exact CORS (HTTPS documented in [deployment.md](deployment.md)).
- Two clients → one server (shared SSE and change notifications).
- Closing the client while a workflow runs; reopening and seeing the result.
- Server restart; client reconnects and reads the stored state.
- Two independent servers and switching between them without mixing projects or Library data.

Not implemented: copying a workflow or project between environments, and synchronising server data. This is
intentionally a separate feature because it needs dependency and runtime consistency checks.
