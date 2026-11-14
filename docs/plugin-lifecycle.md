# Plugin lifecycle

A package is installed in a browser, then activated in a sandbox. It can be switched off, reloaded, updated, removed
and recovered without restarting the client. Every operation removes the previous sandbox and its registrations.

## Operations

| Operation | What happens |
|---|---|
| **Install** | Validate the package, check API/engine/dependencies, write it to this browser, activate it if enabled. A first activation receives `hook: "install"`. |
| **Enable** | Check dependencies, start a sandbox, run `onInstall` (first time) or `activate`, register the UI. |
| **Disable** | Run `deactivate`, stop the sandbox, remove every registration, style and scoped token. Queued work in the frame dies with it. |
| **Reload** | Run `deactivate`, stop the sandbox, start a new one and run `activate` against the same package. |
| **Update** | Install the new package over the old one, keep private data and the enabled state, start it with `hook: "update"` (`from` and `to` versions), run `onUpdate`/`migrate`. A failure restores the previous package. |
| **Uninstall** | Run `onUninstall` and `deactivate`, stop the sandbox, remove registrations, revoke the token, delete the package and all its environment-scoped values. Server resources stay. |
| **Recover** | Clear the failure and try activation again without a reload. |

Reinstalling the **same version** replaces the package record but not the plugin identity: it does not duplicate the
entry and does not lose storage. Reinstalling after an uninstall starts as a new install, with empty private storage
and no deployment record; server data remains.

## Hooks

```js
exports.onInstall = async (api, context) => {};
exports.onUpdate = async (api, context) => {};
exports.migrate = async (api, context) => {};
exports.activate = async api => {};
exports.deactivate = async api => {};
exports.onUninstall = async (api, context) => {};
```

`context` is `{hook: "install" | "update" | "activate", from, to, dataVersion}`. `onUpdate` and `migrate` may return
a number, stored as the plugin's data version for the next activation.

Order on an update: `onUpdate`, then `migrate` (when exported), then `activate`. On a first activation:
`onInstall`, then `activate`. On disable: `deactivate`. On uninstall: `onUninstall` (which may still use the API for
cleanup), then `deactivate` (which cannot start new work), then removal. A returned cleanup function from `activate`
runs with `deactivate`'s semantics.

Each hook has 3 seconds to answer; a plugin that hangs is stopped instead of leaving the client waiting. A stop that
throws is logged and the sandbox is still removed.

## Activation and dependencies

- Enabled plugins are activated in dependency order: dependencies first.
- A missing, disabled or incompatible dependency blocks activation with a readable message.
- Turning a dependency off stops its dependants and marks them failed; **Try again** (or enabling the dependency and
  recovering) starts them after the dependency is back.
- A cycle is reported and the involved plugins are not activated.
- Plugins are isolated: a dependency is an ordering and availability contract, not a way to read another plugin's
  storage or call its commands.

## Failure and recovery

- `activate` throwing, a module that cannot be loaded, or an 8-second start timeout marks the plugin **failed**. Other
  plugins and the client continue.
- A command or page render that never answers is stopped after 20 seconds and the plugin is marked failed.
- A failed update restores the previous package and reloads it.
- **Try again** calls recovery; the Plugins page also shows the error text.

## Cleanup guarantees

Stopping a plugin removes:

- the `<iframe>` and its blob URL, with every timer, listener and pending promise inside it;
- its window message listener;
- pages, sidebar items, toolbar buttons, menu items, dashboard cards, settings/library/inspector sections, resource
  views and commands;
- injected `<style>` elements;
- its scoped server token (revoked at the server that issued it).

Private values are kept on disable and reload, and deleted on uninstall. Server data created by the plugin is never
deleted implicitly.

## Lifecycle of a server switch

Installing belongs to the client and survives a switch. When the active environment changes:

1. the transport aborts old requests and the event stream;
2. scoped tokens of the old server are revoked there and never sent to the new server;
3. plugin sandboxes restart, so their `api.env.info()` and storage point at the new environment;
4. deployment records are read per environment; nothing from the previous server is shown.

A plugin can be installed in the browser and absent from a server; that is normal. Deployment is a separate action.

## Tested scenarios

`tests/plugin-lifecycle.test.js` covers store rules (reinstall, version order, dependencies, export, legacy records,
uninstall). `tests/browser_plugin_platform.py` covers install → update → disable → enable, failed activation →
recovery, uninstall → reinstall, dependency shutdown, eight enable/disable cycles, environment switches and a plugin
frame that is gone after disable. `tests/browser_plugin_security.py` covers activation failure isolation and immediate
token revocation.
