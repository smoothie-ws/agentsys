# AgentSys plugin platform — final report

Branch: `feature/plugin-platform-certification`  
Base: `audit/reliability-round3`  
Scope: the client plugin platform, its public SDK, lifecycle, UI and Library extensions, packaging, reference plugins,
security, environments and documentation. No AI controller, no server plugins, no general refactoring outside the
plugin path.

## 1. Architecture

```
Browser client                                      AgentSys server
┌───────────────────────────────────────┐           ┌────────────────────────────────┐
│ Plugins page                          │           │ capability-checked routes      │
│ PluginStore (localStorage)            │           │ scoped plugin tokens           │
│ PluginManifest (pure contract)        │           │ secrets, net egress policy     │
│ Extensions host                       │  HTTPS    │ JSON collections               │
│  ├─ one sandboxed iframe per plugin   │ ────────► │ Library nodes / workflows      │
│  ├─ opaque origin, CSP, no DOM/token  │           │ graph runtime                  │
│  ├─ capability layer + scoped token   │           │                                │
│  ├─ UI registries and lifecycle       │           │ Server code never loads a      │
│  └─ PluginDeploy                      │           │ plugin                         │
└───────────────────────────────────────┘           └────────────────────────────────┘
```

The split is deliberate:

- **Installation** changes one browser. Package source, modules, images, enabled state, private values and deployment
  records live in that browser.
- **Deployment** changes one server. It creates ordinary collections, Script-backed Library nodes and workflow
  templates through the plugin's checked capabilities. The server stores and runs them with no knowledge of the
  plugin.
- A plugin never imports application internals; the application never imports plugin code. JSON messages and the
  public `api` object are the only contract.

See [docs/plugin-architecture.md](docs/plugin-architecture.md).

## 2. Public API

### Package

Format 2: `manifest` (`id`, `name`, `version`, `description`, `icon`, `api`, `engines`, `capabilities`,
`dependencies`, `author`, `license`, `homepage`), `main`, `files`, `assets`, `contributes`
(`collections`, `library`, `workflows`), `checksum`. Format 1 is still accepted. TypeScript declarations:
[`sdk/agentsys-plugin.d.ts`](sdk/agentsys-plugin.d.ts).

### Injected API

| Namespace | Public members |
|---|---|
| identity | `id`, `title`, `description`, `icon`, `version`, `api`, `capabilities`, `manifest`, `signal` |
| transport | `request(method, path, body?, query?)` |
| storage | `storage.get/set/remove`, `settings.get/set` |
| commands | `commands.register`, `commands.execute` (own commands only) |
| UI | `addPage`, `addSidebarItem`, `addToolbarButton`, `addMenuItem`, `addContextMenu`, `addHomeCard`, `addSettingsSection`, `addLibrarySection`, `addInspectorSection`, `addResourceView`, `showDialog`, `closeDialog`, `addStyles`, `notify`, `toast`, `navigate`, `refresh`, `escape`, `pageHref` |
| Library | `library.list/get/createNode/ensureNode/updateNode/deleteNode` |
| Collections | `collections.list/define/records/create/update/remove` |
| Workflows | `workflows.projects/createProject/workflows/createWorkflow/placeNode` |
| network/secrets | `net.fetch`, `secrets.present` (metadata only) |
| environment | `env.info`, `onDidChange`, `on('change')`, `log`, `asset`, `assets` |

Lifecycle exports: `activate`, `deactivate`, `onInstall`, `onUpdate`, `migrate`, `onUninstall`. See
[docs/plugin-sdk.md](docs/plugin-sdk.md).

### UI extension points

Pages, sidebar/navigation items, toolbar actions, named context menus, commands, Settings sections, dialogs, dashboard
cards, Library sections, custom collection resource views, Inspector sections and notifications. All render passive
HTML sanitized by the host; buttons can invoke the declaring plugin's commands with `data-command`/`data-args`.
See [docs/plugin-ui.md](docs/plugin-ui.md).

## 3. Changed components

| File | Change |
|---|---|
| `js/app/plugin-manifest.js` | **New.** Public package contract: semver, ranges, format 1/2, safe paths, modules, assets, contributions, dependencies, cycles, compatibility, checksum, export, record migration |
| `js/app/plugin-deploy.js` | **New.** Per-environment resource deployment: collections, owned Library nodes, workflow projects/templates/triggers; idempotence and newer-version guard |
| `js/app/plugin-store.js` | Rewritten around the contract: lifecycle fields, dependencies, export, host-only deployment storage, legacy records |
| `js/app/extensions.js` | Lifecycle hooks and rollback, module loader, command JSON results, settings/library/inspector/resource-view/dialog extension points, decorations, crash and navigation detection, cleanup |
| `js/app/environments.js` | Tokens remember their issuing environment; revocation goes to that server without changing active status; generation clears and revokes tokens |
| `js/app/shell.js` | Environment switch restarts plugin sandboxes; fixed the obsolete `ClientPlugins.sync` call |
| `js/pages/plugins.js` | Install/update/export/deploy/recover/remove UI, dependency state, contributions and package facts |
| `js/pages/library.js` | Plugin Library sections in the overview |
| `js/pages/settings.js` | Plugin Settings slot |
| `js/app/nav.js` | Plugin Library rows and menu context for plugin menu commands |
| `js/canvas/menus.js` | Plugin entries in the Add and selection context menus |
| `js/inspector/inspector.js` | Plugin Inspector sections for nodes and Complex Nodes |
| `js/backend/routes-library.js` | Owner-checked in-place update of a plugin's Script-backed Library node (`resource_id`, `plugin`) |
| `index.html` | Loads the two new client modules |
| `README.md`, `docs/*` | New plugin documentation set and accurate overview |

The only server change is additive: existing calls without `resource_id`/`plugin` behave exactly as before.

## 4. Implemented capabilities

- Full package contract with semantic versions, engine ranges, plugin dependencies, cycle detection, safe module
  paths, bundled images and declarative server resources.
- Install, enable, disable, reload, update, migrate, uninstall, reinstall and recovery, with dependency-aware
  activation and rollback of a failed update.
- A sandboxed module loader (`require('./relative')`) so a plugin can be more than one file without a bundler.
- UI extension points for every requested surface, plus measurement-safe dialogs and command buttons in passive HTML.
- Library sections, owned Custom Nodes, workflow templates with a native trigger, Generic Collections helpers and a
  per-environment deployment record.
- Server-resource execution with no client and no plugin, including network and secret use.
- Independent environments: install is client-local, deployment is server-local, tokens never cross, ids never cross.
- Package build/validate/export tooling (`tools/plugin-pack.js`, npm scripts).
- Five reference packages and a minimal example project.

## 5. Defects fixed

1. **`deactivate` was never called.** Disabling set the sandbox dead and disposed it; the hook was unreachable.
   Lifecycle now runs hooks before disposal.
2. **Format 2 packages could not start.** The public plugin record omitted `files`/`assets`, so the loader said
   “Module not found”. The execution record now carries them.
3. **Command results were stringified.** Commands returned a display string, so a caller could not use the value.
   Renderers still return HTML; commands now return JSON.
4. **A server switch left old plugin frames and tokens.** Frames kept the previous environment, and a stale token
   revocation after switching back produced a 401 and left the client “unauthorized”. Tokens now remember their
   environment, revocation is sent to that server without touching active status, and sandboxes restart on a switch.
5. **Deployment placed nodes in the wrong workflow.** Graph edits need `workflow_id`; the deployer sent it only for
   reads. Workflow templates now place their nodes, trigger and wires in their own workflow.
6. **A redeploy created the project and event again.** Missing workflow context was one cause; the other was a shallow
   state copy shared between two server deployments. State is now deep-copied and environment-scoped.
7. **A plugin could overwrite host deployment bookkeeping** through `api.storage`. Host records use a reserved key and
   a host-only storage scope.
8. **A disabled dependency left its dependants running.** Activation now stops dependants whose dependency is missing
   or disabled.
9. **Uninstall had no cleanup hook.** `onUninstall` now runs (API access allowed), then `deactivate`, then removal.
10. **A plugin page could make the browser beacon a remote image.** Remote `img src`/`srcset`/`poster` are removed by
    the sanitizer; only bundled image data is allowed.
11. **A navigated or unresponsive frame stayed registered.** A `pagehide` message and the 20-second invoke timeout stop
    the sandbox; recovery starts a fresh one.
12. **There was no dependency, engine or version validation.** Added in the manifest/store and enforced at enable.

## 6. New tests

| File | Coverage |
|---|---|
| `tests/plugin-manifest.test.js` | Semver/ranges, format 1/2, paths, assets, contributions, dependencies, cycles, compatibility |
| `tests/plugin-lifecycle.test.js` | Store lifecycle, reinstall, version order, dependency errors, export round trip, legacy records, uninstall, reserved storage |
| `tests/plugin-deploy.test.js` | Idempotent deployment, user data, ownership, update, newer-version guard, two servers, no-client execution, capability refusal |
| `tests/plugin-packages.test.js` | Five reference sources and distributions, module resolution, no server code, checksum, empty catalog |
| `tests/plugin-sdk.test.js` | SDK declarations, every documented guide, no current guide presents the removed server-plugin API |
| `tests/browser_plugin_platform.py` | Five plugins end to end; UI points; dialogs; update; crash/recovery; dependency shutdown; 20 enable/disable cycles; two servers; server-only execution; Chromium, Firefox and WebKit |

Existing tests extended where behaviour changed: `tests/environments.test.js` still passes with env-scoped token
revocation, and the full suite has **413 tests, 0 failures, 1 pre-existing skip**.

## 7. Reference plugins

| Plugin | Demonstrates |
|---|---|
| `reference-ui-showcase` | Page, toolbar, context menu, command, notification, dashboard card, Settings, Inspector, bundled image, modules, install/update hooks |
| `reference-library-pack` | Library section, three Custom Nodes, workflow template, runnable without the plugin |
| `reference-structured-data` | Collection definition, CRUD, validation, 409 conflict, migration, custom resource view, persistence |
| `reference-external` | Allowed `net.fetch`, server secret with `{{secret:…}}`, executable Library node, response scrubbing |
| `reference-security` | Forbidden writes, secrets, auth, traversal, foreign command, notification, fetch, parent DOM/storage, popup, style import, forged message |

Sources and generated packages are in [`client-plugins/reference/`](client-plugins/reference/). The test installs the
generated distribution files, not the source folders.

## 8. Compatibility

- Format 1 packages and records from the previous client install and run; they are exported as format 2.
- Existing `api.*` members and `api.request` keep their shape.
- Existing projects and workflows are untouched. Deployed nodes are ordinary Custom Nodes.
- The server route change is additive and owner-checked.
- All 413 Node tests and the existing browser platform/security scenarios pass.
- The catalog remains empty; no package is installed without the user asking.

## 9. Security findings

No critical issue remains. Verified properties:

- one opaque-origin sandbox per plugin, restricted CSP, no DOM/localStorage/session/cookies;
- source and origin validation of `postMessage`; page-forged messages ignored;
- capability classification in the host and enforcement on the server through a scoped token;
- token expiry, bounded count, immediate revocation and no token crossing environments;
- cross-plugin command isolation and per-plugin storage;
- secret values never enter the iframe, the package, the page or results; response scrubbing;
- network allowlist, per-host capability, redirect refusal and optional private-address refusal;
- cleanup on disable/uninstall (frame, listeners, registrations, styles, token, timers).

Residual risks are stated in [docs/plugin-security.md](docs/plugin-security.md): a modified client or the owner's own
token is outside the model, scoped CSS can restyle the client, the checksum is not a signature, and a remote endpoint
can transform a secret before returning it (only literal values are scrubbed).

## 10. Performance

No dedicated benchmark was added. The platform is bounded: 50 packages, 900 KB per package, 400 KB per file, 8-second
activation, 3-second lifecycle hooks, 20-second command/render, one iframe per enabled plugin. Twenty enable/disable
cycles leave one iframe and one registration set. Deployment is idempotent. The full three-engine browser scenario
runs in about one to two minutes per engine here.

## 11. Remaining limitations

- No URL installation and no marketplace; packages are imported from a local file chosen by the user.
- No server plugins; server-side work is data (nodes, workflows, collections).
- Deployment does not change project security policy. A node that writes collections needs a project that allows it;
  Plugin B's runnable template uses a `graph.read` node, and its writing node is available to grant explicitly.
- The capability boundary is not a defence against a modified client or the owner's token.
- Scoped CSS is a real restyling grant; install trusted packages.
- A 20-second command timeout is fixed, not configurable. A renderer process crash is handled through that same
  timeout, not a separate crash callback.

## 12. Verdict

The platform meets the completion criteria in [PLUGIN-CERTIFICATION.md](PLUGIN-CERTIFICATION.md). A third-party
developer can build a complex extension with the public SDK alone, deploy server resources that execute without the
client, switch environments without mixing data, and rely on the server to enforce the capabilities the package
declared.
