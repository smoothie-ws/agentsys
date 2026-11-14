# Capabilities

A capability is a permission a plugin package declares and the host and server enforce. A package that declares
nothing is **read-only**. Writes, runs, secrets and network hosts must each be named.

## The list

| Capability | Allows |
|---|---|
| `graph.read` | Read projects, workflows, graph snapshots, search, project defaults, exchange |
| `graph.write` | Create/change projects, workflows, graph nodes, wires, groups, policies, exchange |
| `library.read` | Read Library nodes, resources, node folders |
| `library.write` | Create/change/delete Library nodes and Script nodes, deploy Custom Nodes |
| `collections.read` | Read collection definitions and records |
| `collections.write` | Define collections and create/change/delete records |
| `run.read` | Inspect a live workflow run and its results |
| `run.start` | Start, stop, pause or resume a run, evaluate a node |
| `notifications.read` | Read notifications |
| `notifications.write` | Post and clear notifications |
| `settings.read` | Read preferences and interface state |
| `settings.write` | Change preferences and interface state |
| `secrets.use:<name>` | Use one named server secret in a request body (no wildcard on the name) |
| `net.fetch:<host>` | Make the server fetch that host. `*` may appear inside the host pattern |

Read-only default: `graph.read`, `library.read`, `collections.read`, `run.read`, `notifications.read`,
`settings.read`.

Everything else is refused, including authentication endpoints, diagnostics, the OpenAPI document, unknown routes,
another plugin's secret and server administration. A plugin cannot mint another plugin token.

## Declaration

```json
{
  "manifest": {
    "id": "my-plugin",
    "capabilities": ["graph.read", "library.write", "collections.write", "secrets.use:weather", "net.fetch:api.weather.test"]
  }
}
```

A declaration is validated at install. A typo is an install error, not a silently ignored permission.

## Two checks

### Host classification

The host decides what a call needs from its **method, path and body**, not from the plugin's label:

| Call | Needs |
|---|---|
| `GET projects`, `GET projects/…/workflow` | `graph.read` |
| `POST/PUT/DELETE projects`, graph edits | `graph.write` |
| `GET resources`, `GET library/…` | `library.read` |
| `POST/PUT/DELETE resources`, `POST library/script-nodes` | `library.write` |
| `GET collections…` | `collections.read` |
| `PUT collections/…`, record writes | `collections.write` |
| `GET projects/…/execution` | `run.read` |
| `POST projects/…/execution`, pause/resume | `run.start` |
| `GET notifications` | `notifications.read` |
| `POST/DELETE notifications` | `notifications.write` |
| `GET settings`, `GET ui-state` | `settings.read` |
| `PUT settings`, `PUT ui-state` | `settings.write` |
| `GET secrets/<name>` | `secrets.use:<name>` |
| `POST net` | `net.fetch:<host>` plus `secrets.use:<name>` for every `{{secret:name}}` in the body |
| `auth/...` | always refused |

A query string or a body cannot turn a read into a write. A body carrying a secret placeholder is classified with
the secret requirement.

### Server token

When the server supports it, the host exchanges its own credential for a short-lived token scoped to exactly the
plugin's capabilities (`POST /api/auth/plugin-session`). The plugin's calls carry that token. The server applies the
same capability rules to it, so the boundary does **not** rely on the host page being honest. The token:

- is issued only to an authenticated caller;
- lives minutes, not hours, and is renewed once after expiry;
- is revoked immediately when the plugin is disabled, removed or the environment changes;
- is never written to plugin storage and never exposed to the sandbox.

An older server without the route answers 404; the host-side check is then the whole boundary, and the Plugins page
documented this limit.

## Secrets

A client plugin never receives a secret value. It can:

- read metadata with `api.secrets.present(name)` (for `secrets.use:<name>`);
- write `{{secret:name}}` into a `net` header/body, which the server substitutes after its checks.

The server replaces a secret in the response text with `[REDACTED]` before returning it. A placeholder in a network
URL is refused, because expanding it could move the checked host. This is tested by
`tests/plugin-deploy.test.js` and `tests/browser_plugin_platform.py` (the local endpoint receives the secret in its
Authorization header; the value is not in the plugin page, the plugin record or the graph result).

## Network

`net.fetch:<host>` names a destination. The value may contain `*`; matching is case-insensitive and ignores a trailing
dot. The server's `AGENTSYS_ALLOW_NET` / `allowedNetHosts`, and a project's net policy, narrow it further. Redirects
are refused (a second redirect target would need its own permission). Private, loopback and link-local destinations
can be refused by server policy (`--deny-private-net`). `tests/network-policy.test.js` and `tests/net-allowlist.test.js`
cover the server side.

## Honest limits

- Capabilities bound a plugin inside one browser session. An operator who edits the client or calls the API with the
  owner's token is outside the plugin model.
- Installing an untrusted plugin is a real grant: a write capability is a write, and scoped CSS can restyle the
  application.
- The token is a second layer, not a replacement for the host check: both are required for a robust deployment.
