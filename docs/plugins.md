# Plugins

Plugins extend the application through executable packages. A module exports `activate(context)` and optionally `deactivate()`. The manifest describes metadata and loading requirements; registration and behavior live in code.

## Package

Import a JSON package from the Plugins menu:

```json
{
  "format": "agentsys.plugin/2",
  "manifest": {
    "id": "example",
    "name": "Example",
    "version": "1.0.0",
    "engine": ">=2",
    "authors": [{"name": "Example author"}],
    "main": "main.js",
    "permissions": [],
    "dependencies": {}
  },
  "files": {"main.js": "exports.activate = context => {};"}
}
```

JavaScript modules use CommonJS. Relative packaged JavaScript and JSON modules are supported and cached. TypeScript compiles to CommonJS JavaScript with the declarations in [sdk/plugin.d.ts](../sdk/plugin.d.ts). Direct DOM, network, filesystem and Node module access are unavailable in the plugin host. Custom views use sandboxed HTML files.

## Registration API

The context supplies `app`, `id`, dependency metadata, `subscriptions.add(disposable)` and `onReady(callback)`.

| Namespace           | Operations                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `app.library`       | Register sections, typed JSON collections and node catalogs; list/create/update/delete own items |
| `app.commands`      | Register function handlers and execute owned commands                                            |
| `app.endpoints`     | Register request handlers with method lists                                                      |
| `app.views`         | Register packaged HTML pages and Dashboard tiles                                                 |
| `app.templates`     | Register exported project templates                                                              |
| `app.events`        | Subscribe to workspace, Library, settings and private-storage changes                            |
| `app.timers`        | Owned timeout/interval callbacks                                                                 |
| `app.settings`      | Register fields and read/write validated settings                                                |
| `app.storage`       | Private bounded JSON store with compare-and-set versions                                         |
| `app.secrets`       | Obtain a granted credential placeholder without reading its value                                |
| `app.navigation`    | Return a navigation effect from a user command                                                   |
| `app.notifications` | Post through the checked notifications API                                                       |
| `app.workflows`     | Read/edit graphs, signal workflows and inspect their live runtime                                |

`app.request(method,path,body,query)` provides other checked application operations. Lifecycle handlers stage registrations, validate them and publish them atomically. Failed activation clears partial registrations and displays its error. Each enabled plugin has an isolated Worker retaining callback closures. Disable/update/removal calls cleanup and terminates owned work. Stable collection IDs keep resource data across disable/re-enable.

`app.workflows` also exposes `stop`, `dispatch`, `trace`, `getScope` and `setScope`. Durable checkpoint routes use ordinary `app.request` with `run.read`/`run.start`; see [Durable execution](durable-execution.md). A package can include the universal `sdk/operations.js` CommonJS library for callback orchestration. Nested checked endpoint calls retain their originating execution identity, inherited budgets and Stop signal. Plugin storage and checkpoint writes queued after callback cancellation are rejected. None of these interfaces expose internal server state.

An endpoint may declare `permissions` required from a calling Script, for example `{permissions:['library.read']}`. Without a declaration it remains unavailable to Scripts. `net.fetch:{host}` resolves the host from the request body's URL. These checks do not replace the plugin's own API grants. Optional `timeout` sets a bounded callback budget (100–300000 ms). Calls made from an execution propagate Stop to the plugin's outstanding checked network operations.

## Node catalogs

`app.library.registerNodeCatalog(file)` seeds missing nodes into the ordinary Library data, like built-in nodes. Their graphs, names, groups, icons and default permissions can be edited normally in Developer mode. Placed copies inherit the saved defaults; plugin host grants are separate.

The installation remembers which catalog nodes it has already added. Reactivation and updates preserve user edits and deletions, adding only new catalog entries. Disabling or uninstalling a plugin leaves these nodes in the Library. Graphs calling that plugin's endpoints require the plugin to be enabled.

## Collections

```js
exports.activate = ({app}) => {
  const group = app.library.registerSection({id: 'tools', title: 'Tools'});
  app.library.registerCollection({
    id: 'notes',
    title: 'Notes',
    parent: group,
    item: {name: 'Note', format: 'json', fields: [{key: 'body', label: 'Text', type: 'textarea'}]},
  });
};
```

The application owns generic cards, folders, forms, CRUD and credential storage. The plugin owns its resource schema. Field types are `text`, `textarea`, `number`, `boolean`, `select`, `json`, `secret` and `list`; fields can specify defaults, help, required/unique values, JSON object/array shape and text ID/URL formats. A read-only `list` declares an `endpoint`: on opening an item or saving changes the host calls that POST endpoint with `{item_id}` and displays its `{items:[{id,label}]}` result. Lists are not saved as resource values. Actions name registered plugin endpoints. There are no domain-specific formats in the core.

Own item routes live at `library/sections/{plugin}.{collection}/items`. Secrets are stored separately, omitted from exports and represented by presence flags. Omitted secret fields preserve saved credentials; an empty secret removes one.

The owning plugin's isolated host may read a saved credential with `app.library.getSecret(collection, itemId, fieldKey)`. Only its registered collections and secret fields are accessible. Ordinary resource CRUD and the page bridge have no credential-read operation; plugin authors must keep credentials out of handler results and logs. Network requests still require an explicit network grant.

## Permissions and lifecycle

Rights are requested in `manifest.permissions` and intersected with current installation grants on each call. Own collections, settings and private storage need no global Library permission. Cross-application operations use normal capability checks. Plugin management is never available to plugin code.

Dependency ranges support exact versions, `*`, `>=`, `^` and `~`. Dependencies activate first; missing/incompatible dependencies and cycles prevent enabling. Disable or removal is refused while enabled dependents require the plugin. Callback timeouts terminate a blocked host and clear registrations.

Commands are available in Ctrl+K and at `POST plugins/{id}/commands/{command}`. Views receive `window.agentsys` with the checked request bridge, owned commands, settings, data and endpoint calls. Views cannot access the host DOM or network directly.

## Bundled plugin

`plugins/ai` registers AI / Providers plus the AI node group (Provider, Model, Ask). Its module, schemas and graph scripts own model discovery and text requests; the core does not interpret models or provider options. Rebuild the distributable and node catalog with `npm run build:plugins`. Bundled updates preserve Provider data and disabled state. User-installed replacements are not overwritten.
