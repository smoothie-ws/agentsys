# Plugin SDK

The SDK is the object passed to `activate(api)`. There is no package to import at runtime: AgentSys injects `api` into
the sandbox. TypeScript declarations live in [`sdk/agentsys-plugin.d.ts`](../sdk/agentsys-plugin.d.ts); plain
JavaScript is supported without a build step.

## Module shape

```js
exports.activate = async api => {
  // registrations, commands, requests
};

exports.deactivate = async api => {};
exports.onInstall = async (api, context) => {};
exports.onUpdate = async (api, context) => {};
exports.migrate = async (api, context) => {};
exports.onUninstall = async (api, context) => {};
```

A package's main file may use `require('./relative')`. Only `.js` and `.json` files from the same package are
available; there is no `node_modules`, no network `require` and no external module. `module.exports` works as in
CommonJS.

`activate` may also return a cleanup function. It runs on disable, reload and uninstall, after `deactivate` when both
exist.

`activate` throwing rejects the activation. The plugin is marked failed, the rest of the client keeps working, and the
Plugins page offers **Try again**. An update that fails is rolled back to the previous package.

## `api` members

| Member | Returns | Purpose |
|---|---|---|
| `api.id`, `title`, `description`, `icon`, `version`, `api` | values | Package metadata |
| `api.capabilities` | `string[]` | The capabilities granted to this plugin |
| `api.manifest` | object | The safe subset of the manifest (`id`, `name`, `version`, `api`, `capabilities`, `icon`) |
| `api.signal` | `AbortSignal` | Aborted when the plugin stops; observe it in long work |
| `api.log(...args)` | — | Host console, prefixed with the plugin id |
| `api.asset(name)` | data URI | An image bundled in `assets` |
| `api.assets()` | object | All bundled images |
| `api.request(method, path, body?, query?)` | JSON | One checked API call; `path` is relative to `/api` |
| `api.storage.get/set/remove` | JSON | Private values, scoped by plugin and active server |
| `api.settings.get/set` | JSON | A settings object in the same private storage |
| `api.commands.register(id, handler, meta?)` | promise | A command callable from UI and `execute` |
| `api.commands.execute(id, ...args)` | any | Only this plugin's own commands |
| `api.ui.*` | promises | Interface contributions, dialogs, toasts, navigation |
| `api.library.*` | JSON | List, create, ensure and update Script-backed Library nodes |
| `api.collections.*` | JSON | Generic Collections CRUD with versions |
| `api.workflows.*` | JSON | Projects, workflows and node placement |
| `api.net.fetch(spec)` | `{status, text}` | A checked server-side HTTP request |
| `api.secrets.present(name)` | `{name, present}` | Secret **metadata**; never the value |
| `api.env.info()` | `{id,name,url,status,protocol}` | The active environment |
| `api.onDidChange(listener)` / `api.on('change', listener)` | unsubscribe | Server change keys |

## Requests

```js
const projects = await api.request('GET', 'projects');
const made = await api.request('POST', 'projects', {name: 'From a plugin'});
const page = await api.request('GET', 'collections/notes/records', undefined, {limit: 20});
```

`api.request` is capability checked twice:

1. the host classifies the call as a read or write in one family and refuses it with a message naming the missing
   capability;
2. the host attaches the plugin's scoped token; the server applies the same capability rules to that token.

Authentication endpoints (`auth/...`) are always refused. Redirects, private addresses, secrets and network hosts
follow the server's own policies.

Errors reject with a message that can be shown to a person. Do not catch and ignore a capability error: fix the
manifest or the call.

## Storage and settings

```js
const count = (await api.storage.get('count', 0)) + 1;
await api.storage.set('count', count);
const settings = await api.settings.get();
await api.settings.set({...settings, colour: 'blue'});
```

Values are JSON, at most 100 KB each. A key beginning `__agentsys:` is reserved for the host. Storage is separated by
plugin **and by server**: switching environments does not show values from the previous one.

## Commands

```js
api.commands.register('say', async (name = 'there') => {
  api.ui.toast(`Hello, ${name}`);
  return {name};
}, {title: 'Say hello', icon: 'sparkles', order: 10});
```

A command may be called from a toolbar button, a menu item, a page button (`data-command="say"`) or
`api.commands.execute('say', 'Ada')`. A foreign command (`other-plugin:say`) is refused.

Command return values are sent back as JSON. Page/card/inspector renderers return HTML strings instead.

## UI in passive HTML

A renderer returns a string. The host sanitizes it and inserts it into its own DOM. Scripts, frames, forms, event
handler attributes, external images and `javascript:` URLs are removed. The page cannot reach the application DOM.

Buttons may call a command:

```html
<button type="button" data-command="say" data-args='["Ada"]'>Say hello</button>
```

Use the application's classes (`page-facts`, `button-row`, `primary`, `muted`, `card`, `empty`, `form-error`,
`oc-table`) so a plugin looks native. Add scoped CSS with `api.ui.addStyles`; `@import` and `url(...)` are refused.

## Helpers as the stable contract

Prefer the helpers over raw paths:

```js
const node = await api.library.ensureNode({name: 'Slug', code: '...', outputs: ['slug']});
const records = await api.collections.records('notes', {limit: 50});
const made = await api.collections.create('notes', {title: 'First'});
await api.collections.update('notes', made.id, {...made.data, title: 'Second'}, made.version);
```

They compose the same public API and inherit the same capability checks. A plugin never needs an internal module of
the application.

## Compatibility

`api.api` is the plugin API version. This client implements **2**; format 1 packages (`api: 1`) keep the API they
had, and all members above remain additive. A package declares the AgentSys version it needs with
`manifest.engines.agentsys`. A package whose API or engine range is incompatible is refused at install with a readable
message; it is not started speculatively.
