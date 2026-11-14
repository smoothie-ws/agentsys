# Plugin migration guide

## From server plugins

Old AgentSys versions loaded `data/plugins/<id>/main.js` on the server with `api.route(...)`, background hooks and
direct storage. That host is removed: the server no longer loads plugin code and has no plugin route.

`agentsys-server migrate` preserves every old plugin folder, copies sources and data to `data/plugins-migrated/`,
snapshots `data/plugins/`, moves provider configurations to the generic `providers` collection and API keys to
secrets. It reports route dependencies and workflows that call `plugins/…`; those calls are not rewritten
automatically. See [migration.md](migration.md) for the command and its report.

Port an old plugin in this order:

| Old server plugin | New client plugin |
|---|---|
| `api.route('GET', 'providers', handler)` | Generic collection `providers`, read with `api.collections.records('providers')` |
| Arbitrary UI route | `api.ui.addPage` or `api.ui.addLibrarySection` |
| Server hook / background job | A Script-backed Library node, a workflow with an Event/Schedule trigger, or a collection record processed by a node |
| `data.json` storage | `api.storage` (browser, per environment) for UI state; Generic Collections for shared data |
| API key in plugin data | Server secret, referenced as `{{secret:name}}`; the plugin never receives it |
| Provider HTTP call | `api.net.fetch` with `net.fetch:<host>` and `secrets.use:<name>` |
| Server-side validation | Collection schema and the generic API; the server validates without knowing the plugin |

A client plugin cannot register a server route, a server hook or a background timer. If it needs server work, it
deploys a Library node or a workflow; the server runs that data on its own.

The old host and routes remain, unloaded, in `legacy/` as a migration reference. They are not part of the runtime and
must not be re-enabled.

## From client plugin format 1

Format 1 was one source string:

```json
{"id": "hello", "title": "Hello", "api": 1, "source": "exports.activate = api => {}"}
```

It still installs and runs. The store records it as `formatVersion: 1`, `main: "plugin.js"` and exports it as format 2
on the next save/export. There is no need to rewrite a working plugin.

To adopt format 2:

1. Rename `title` to `manifest.name` and keep `id`, `version`, `api: 2`.
2. Put the source into `files["main.js"]`, set `main: "main.js"`.
3. Add `engines.agentsys`, `dependencies` and `contributes` if needed.
4. Move settings/migration code to `onInstall`/`onUpdate`.
5. Build with `tools/plugin-pack.js`.

## API changes from the first client host

- Commands now return JSON values, not a string. A page/card/inspector renderer still returns HTML.
- `activate` may return a cleanup function.
- `onInstall`, `onUpdate`, `migrate`, `onUninstall` and the activation context are available.
- New UI points: settings sections, Library sections, inspector sections, resource views and plugin dialogs.
- New helpers: `api.library`, `api.collections`, `api.workflows`, `api.net.fetch`, `api.secrets.present`.
- Format 2 modules: `require('./relative')` inside the package; no bundler and no npm.
- Package installation and server deployment are explicitly separate.
- `api.request` still accepts `(method, path, body, query)`; the path is relative to `/api`.

## Data and server resources

A client update keeps private browser storage. A server deployment record is per environment; switching servers does
not move resources. Reinstalling after uninstall starts with empty private storage but leaves server data.

Old provider data should be migrated once with `agentsys-server migrate`; do not ask a client plugin to import an old
server plugin's `data.json` directly.

## Removing obsolete examples

The documentation set now distinguishes the client architecture from the removed server host:

- `docs/plugins.md` is an index for the client platform.
- `docs/plugin-*.md` describe the public API, lifecycle, security and packaging.
- `docs/migration.md` covers the server data migration.
- `legacy/` holds the removed host only as a reference.

Examples that called `api.route`, added server plugin files or assumed a server plugin folder are obsolete and are not
part of the current documentation.
