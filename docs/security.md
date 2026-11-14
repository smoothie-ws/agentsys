# Security

## Threat model

Trusted: the person running the server, the server's data folder and a local loopback connection on a machine
with no token. Untrusted: network clients, browser origins other than the configured ones, workflow Scripts,
graph content and (by default) client plugins.

## Authentication

| Situation | Rule |
|---|---|
| Server bound to loopback, no token | Requests from loopback are trusted. This is the desktop case. |
| Server bound to any other address | A token is mandatory. The CLI refuses to start without one and the API answers `503` if a token is ever missing. |
| Token supplied | `Authorization: Bearer <token>` or one `POST /api/auth/session` exchange. Tokens are compared with a timing-safe comparison. |
| Browser client | The bearer token stays in `sessionStorage` for the tab. After exchange, requests use an HttpOnly `SameSite` cookie. |
| Session lifetime | 12 hours by default (`--session-hours`); sessions are in server memory and vanish on restart. The client renews once from the per-tab token. |
| Wrong/expired token | `401`; the client shows **Unauthorized** and does not retry with mutations. |

Tokens are never accepted from query parameters, never written to `localStorage`, never logged, and are redacted
from error text.

## CSRF and CORS

- Cookie-authenticated unsafe requests require `X-AgentSys: 1` and an `Origin` that is this origin or an exact
  `--allowed-origin`.
- A cross-site HTML form cannot add the header; a cross-site `fetch` triggers a preflight that is only granted
  for an allowed origin.
- CORS echoes only an allowed origin and sets `Access-Control-Allow-Credentials: true`. It never returns `*` for
  an API that uses credentials.
- A tokenless loopback server also accepts loopback origins so the separate local client on another port works.
  A token-protected server accepts only its same origin and the explicit allowlist.
- `null`/`file://` origins are not allowed.

## Head and network origin

- On loopback, the `Host` header must be a loopback name or one of `ALLOWED_HOSTS`; this blocks DNS rebinding.
- A remotely bound server can pin accepted `Host` names with `--allowed-host`. Without a list it accepts any
  host, which is normal behind a TLS reverse proxy that owns the name.
- Every answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and the protocol header.
- The static client server sets a CSP, `X-Frame-Options: DENY` and serves only the public client file set.

## HTTPS

Direct TLS:

```sh
node bin/agentsys-server.js start --host 0.0.0.0 --token "$TOKEN" \
  --tls-cert /etc/agentsys/cert.pem --tls-key /etc/agentsys/key.pem
```

Recommended remote deployment is a reverse proxy that terminates HTTPS and forwards to a loopback server (see
[deployment.md](deployment.md)). With HTTPS, the session cookie is `Secure`; a genuinely cross-site client gets
`SameSite=None` (which browsers only accept with `Secure`).

The client does not bypass browser mixed-content or private-network rules. A public HTTPS client calling a
private HTTP server is expected to fail; use HTTPS or a tunnel/VPN.

## Secrets and redaction

- `GET /api/secrets/<name>` returns `{name, present}`, never the value.
- Scripts can use a secret only with `secrets.use:<name>` in both their instance grants and the project policy;
  the placeholder `{{secret:name}}` is replaced inside checked host operations.
- Network responses are scrubbed of any stored secret value before returning to a Script.
- Error messages redact bearer tokens and `apiKey/password/secret/token` assignments.
- Collection records may contain a `{{secret:name}}` reference; the value remains in `data/secrets`.

## Script sandbox

Scripts run in worker threads with frozen intrinsics, no direct filesystem or network access, and only the
checked `agentsys()` API. Generated code is quarantined; writes from a Script cannot grant themselves library
permissions. Stop aborts the signal, and late writes after Stop or deletion are rejected. These mechanisms were
not rewritten in this cycle; their regression tests still pass.

## Client plugin isolation

A client plugin runs in a sandboxed iframe with an opaque origin: no host DOM, no browser storage, no cookies, no
token, no direct network. It receives a narrow RPC API through the host. Page HTML is sanitized (including
namespaced `<svg><script>`), CSS cannot load external resources, sidebar links must be paths of this client, and
a plugin can execute only its own commands.

On top of the sandbox there is a **capability layer** for server calls: the host classifies every `api.request`
by method, path and (for `net`) the body, and refuses calls the package did not declare. A package without
`capabilities` is read-only; writes, runs, secrets and network hosts are named explicitly
(`graph.write`, `run.start`, `secrets.use:<name>`, `net.fetch:<host>`). Auth endpoints are never reachable.

This is still isolation of code inside a trusted browser session, not authorization of the person: the check runs
in the host page, so it holds against the plugin, not against an operator who edits the client and calls the API
directly. **Install plugins with the capabilities you are willing to grant.** See [plugins.md](plugins.md).

## Remaining risks

- Loopback trust assumes the machine itself is not hostile. Any local process can use a tokenless loopback API.
- In-memory sessions are lost on restart; a client must hold its token to renew silently. The session map is
  capped (10 000) and swept, and a restart invalidates every session.
- The client loads local validation code from its own origin; a compromised client host can change the client,
  but not the server (the server manifest is independent).
- Generic collections and Script nodes are user data. The server validates their shape but cannot know whether a
  workflow has harmful external side effects; permissions and project policy are the control.
- `POST /api/net` is reachable by any token holder and by a plugin with `net.fetch:<host>`; the host, not the
  method, decides what is fetched. Treat a token as an operator credential.
- A plugin's `graph.write` (or `library.write`) is a real write to the user's data. Capabilities bound the
  plugin's reach; they do not make an untrusted plugin safe to install.
- No multi-user roles, no per-user audit log. These are future work.
