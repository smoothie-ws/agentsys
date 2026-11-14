# Plugin architecture

## The boundary

```
Browser (client)                                     Server
┌──────────────────────────────────────────┐         ┌─────────────────────────────┐
│ Plugins page / plugin store               │         │ API routes                  │
│  localStorage: packages, enabled state    │         │  capabilities on every call │
│  per-environment private storage          │         │  short-lived plugin tokens  │
│              │                            │         │  secrets, net egress policy │
│              ▼                            │  HTTPS  │              │              │
│ Extension host                            │ ──────► │              ▼              │
│  manifest/dependency checks               │         │ JSON data: projects,        │
│  one sandboxed iframe per plugin          │         │ workflows, Library nodes,   │
│   opaque origin, CSP, no DOM/token        │         │ collections, notifications  │
│  postMessage bridge ── capability layer   │         │                             │
│  scoped token per plugin                  │         │ Graph runtime executes      │
│  UI registries, lifecycle hooks           │         │ saved Script nodes          │
└──────────────────────────────────────────┘         └─────────────────────────────┘
```

The client is a static application. Plugins are data in `localStorage`, not files served by the server. The server
sees only the ordinary API calls a plugin makes. A package cannot install a server route, hook or background process.

## Parts

### Package store — `js/app/plugin-store.js`

- Keeps at most 50 packages, validates every field and refuses duplicate ids, non-semantic versions and unsafe paths.
- Keeps the enabled state, the installed and updated timestamps, the activated version and the data version.
- Provides private storage scoped by plugin **and active environment**. Host bookkeeping uses a reserved key a
  sandbox cannot read or write.
- Exports a package in the distributable format. It never executes code.

### Manifest contract — `js/app/plugin-manifest.js`

Pure validation shared by the browser, the pack tool and the tests:

- semantic versions and ranges (`^`, `~`, `>=`, `<`, `||`, hyphen ranges);
- package formats 1 and 2, safe relative module paths and size limits;
- dependencies, dependency cycles and AgentSys engine compatibility;
- deterministic checksums and export/import round trips.

### Extension host — `js/app/extensions.js`

- Starts every enabled plugin in its own `<iframe sandbox="allow-scripts">` with an opaque origin and a restrictive
  CSP. The frame is one CSS pixel and off-screen.
- Implements the public `api`: requests, storage, settings, commands, UI contributions, Library/collection/workflow
  helpers, network and secret metadata.
- Owns lifecycle: activation context (`install`, `update`, `activate`), `deactivate`, `onUninstall`, cleanup and
  failure recovery.
- Holds every UI registration in a host-side registry and removes it with the plugin.

### Capability layer — `js/app/plugin-capabilities.js`

Classifies each API call from its method, path and body (not from the plugin's label) and rejects one the package did
not declare. The server repeats the check on a scoped token.

### Scoped plugin tokens

The host exchanges its own credential for a short-lived token limited to the plugin's capabilities
(`POST /api/auth/plugin-session`). Requests made with it are enforced by the server. Disabling or removing a plugin
revokes its token immediately; a server switch revokes tokens at the server that issued them and never sends them to
the next environment. See [plugin-capabilities.md](plugin-capabilities.md) and [plugin-security.md](plugin-security.md).

### Resource deployment — `js/app/plugin-deploy.js`

Turns a package's `contributes` section into ordinary server data, idempotently and per environment:

- collection definitions (records are never rewritten or deleted);
- Script-backed Library nodes owned by the plugin, updated in place on a new version;
- a workflow project, a workflow and its Library nodes, usually with a native Event trigger.

The deployed graph is saved by the server. Running it needs no client, plugin host or plugin token.

## Dependency direction

- A plugin never imports application internals. It receives `api` and uses `api.request` or the helpers built on it.
- The application never imports plugin code. It starts a sandbox and exchanges JSON messages.
- The server does not know that a Library node came from a plugin. It validates and runs it like any other node.
- The shared rules live in `shared/core.js`, `js/app/plugin-manifest.js` and `js/app/plugin-capabilities.js`; the
  server and the client use the same capability grammar.

## State ownership

| State | Owner | Scope |
|---|---|---|
| Package source, modules, assets | Browser (`localStorage`) | Client |
| Enabled state, dependency decisions | Browser | Client |
| Plugin private values (`api.storage`) | Browser | Client **and** environment |
| Deployment record | Browser (host key) | Client **and** environment |
| Collections, Library nodes, workflows, records | Server | Server |
| Secrets | Server | Server |
| Scoped token | Browser memory | One plugin, one server, minutes |

This split is why two servers can hold different deployments of the same plugin and why a browser can hold a package
that no server has ever seen.
