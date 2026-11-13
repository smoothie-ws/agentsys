# Plugins

The plugin contract is two functions: `start(api)` and `stop()`. Put a `main.js` in a folder under `data/plugins/`; the application discovers it and manages its lifecycle. `api(method, path, body, query)` calls the same application API as the editor. There is no manifest or required settings schema. A plugin is trusted code that runs in the server process. An optional `client.js` in the same folder is the other half: a browser module that changes the interface through the official tools described under [Interface](#interface-clientjs).

```
data/plugins/
  my-plugin/
    main.js
    client.js   # optional: the interface half
```

`main.js` is a CommonJS module:

```js
let timer;
exports.start = async api => {
  const projects = await api('GET', 'projects');
  api.log('Projects:', projects.length);
  timer = setInterval(() => api.log('Plugin is active'), 60000);
};

exports.stop = () => clearInterval(timer);
```

That is the complete required structure. `start` and `stop` may be async; await application calls during startup. `stop` is optional if there is nothing to release. It is also called when startup fails, to release partially created resources. `api.signal` aborts on disable/reload so a plugin can cancel its background work. Registered routes and change listeners are removed automatically.

Optional display metadata is `exports.title`, `exports.description`, and `exports.icon` (an application icon name such as `sparkles`). It is read even when the plugin is disabled. The **AI** plugin is in `data/plugins/ai`. It registers the Providers section of Library; disabling it removes the section while retaining saved providers.

## Optional API helpers

The direct application call is enough for normal API operations. These conveniences remain available for existing plugins and integrations; none adds a lifecycle requirement.

| Member | Does |
| --- | --- |
| `api.id` | the folder name |
| `api(method, path, body, query)` | calls the application API directly |
| `api.signal` | aborts when this instance is stopped or fails to start |
| `api.log(...)` | writes a line to the server's error output, prefixed with the id |
| `api.request(method, path, body, query)` | calls the application API, the one the editor and Scripts use (`projects`, `resources`, `projects/{id}/typed-nodes`, ...). Not permission-checked: the plugin is trusted. |
| `api.on('change', keys => {})` | called with the stored keys that changed. Returns the function that stops listening. |
| `api.route(method, name, handler)` | answers `/api/plugins/{id}/{name}`. `handler({body, query, signal, caller})` returns JSON (it may be `async`). `signal` aborts when the calling run is stopped; `caller` is `{project_id, workflow_id, node_id}` of the calling Script. |
| `api.notify({title, body, level, href})` | adds a message to the notification list (the bell at the top right); `level` is `info`, `success`, `warn` or `error`, `href` a page of the app |
| `api.settings.get()` | the plugin's settings (below), saved values over the defaults |
| `api.data.get()`, `api.data.set(value)` | private JSON the plugin keeps between runs |
| `api.secret(name)` | the value of a stored secret (`PUT secrets/{name}`); the Secrets API itself never returns values |
| `api.library.addScriptNode(spec)` | adds a node made of one Script to the Library unless a node of that name exists. `spec`: `{name, inputs, outputs, code, description, folder, icon, grants}`; ports are names or `{id, name, type}`. |
| `api.library.add({name, payload})` | adds any Library node (a full graph payload) unless a node of that name exists |

## Optional settings

`exports.settings = [{key, label, type, default, options, help}]` gives the plugin a form on its page, saved by itself. Types: `text`, `textarea`, `password`, `number`, `boolean`, `select` (with `options`). A password is stored on the server and never sent back to the page: the field shows only that one is saved, an empty field keeps it, and the page can clear it. The plugin reads the values with `api.settings.get()`. A malformed schema stops the plugin and shows the error.

Whatever a plugin registers with `on` and `route` is removed when it stops. Library nodes it added stay, like any Library node the person may edit or delete.

## Turning plugins on and off

The Plugins page (sidebar) shows every folder that has a `main.js` as a card, like the Library. A card opens the plugin's page: its state and any error, the routes it answers and its `README.md` if the folder has one. The card's menu turns the plugin on or off; the page menu has Reload plugins. Reload stops all plugins, scans the folder again and starts the enabled ones, so new, removed and edited plugins take effect without restarting the server. A plugin that is switched off stays off after a restart. The API behind the page:

| Call | Does |
| --- | --- |
| `GET plugins` | `[{id, title, description, icon, enabled, running, error, client}]`; `client` says the folder has a browser module |
| `GET plugins/{id}` | the same plus `routes`, `readme` and `settings` (with values; a password only as `set`) |
| `GET plugins/{id}/client` | the source of the plugin's `client.js`: `{code, path, modified}` |
| `PUT plugins/{id}` `{enabled}` | turns one on or off |
| `PUT plugins/{id}/settings` `{values}` | saves settings (the name `settings` is reserved) |
| `POST plugins/reload` | reloads the folder |
| `GET/POST/PUT/DELETE plugins/{id}/{name}` | a route a plugin registered |

Plugins always load from `plugins/` inside the selected data folder (`data/` by default). `DATA_DIR` moves the whole data folder, including plugin code and settings.

## Scripts and plugins

A Script can call a plugin's route with `await agentsys('GET', 'plugins/ai/providers')`. That needs the `plugins.call` permission on the node and in the project policy, like every other checked call. Listing and switching plugins is administrative and not available to Scripts.

Plugins need the server. In a browser without the server there is no plugin host, the list is empty and no interface modules load.

To build an LLM controller on top of a plugin like this, see [building an LLM controller from nodes](llm-controller.md).

`api.library.addSection({id, title, icon, description, route, fields})` registers a Library collection for the lifetime of a running plugin. Its route returns the collection items; POST, PUT and DELETE edit them. The AI plugin uses this for Providers.

## Interface: client.js

A plugin may also change the interface itself. Put a `client.js` beside `main.js`; the page loads it for every running plugin that has one and gives it the official extension tools. A plugin with only `main.js` works as before and changes no interface.

```
data/plugins/
  my-plugin/
    main.js
    client.js
```

`client.js` is CommonJS-shaped and runs in this page (not in the server process):

```js
exports.activate = api => {
  api.commands.register('greet', () => api.ui.toast('Hello from my plugin'), {
    title: 'My plugin: greet',
    icon: 'sparkles',
  });
  api.ui.addToolbarButton({id: 'greet', title: 'Greet', icon: 'sparkles', command: 'greet'});
  api.ui.addPage({
    id: 'home',
    title: 'My plugin',
    icon: 'sparkles',
    render(root) {
      root.textContent = 'Hello from client.js';
    },
  });
  api.ui.addStyles('.plugin-my-plugin h2 { color: var(--accent); }');
};
```

`activate` and `deactivate` may be async; `activate` may instead return a cleanup function. Everything registered through `api` is removed when the plugin stops, is turned off or the folder is reloaded. A `dispose` function returned by a registration removes that one contribution earlier.

### The official interface tools

| Member | Does |
| --- | --- |
| `api.id`, `api.title`, `api.description`, `api.icon` | this plugin's metadata, as on its Plugins card |
| `api.signal` | an `AbortSignal` that aborts when the plugin's interface is stopped or reloaded |
| `api.request(method, path, body, query)` | the application API, exactly as the editor calls it (`projects`, `resources`, `notifications`, its own routes, ...) |
| `api.settings.get()` | the values of the settings `main.js` declared |
| `api.storage.get(key, fallback)`, `api.storage.set(key, value)` | small interface state, saved with the rest of the UI state and namespaced to the plugin |
| `api.on('change', listener)`, `api.onDidChange(listener)` | called with the stored keys that changed; returns the unsubscribe function |
| `api.commands.register(id, handler, {title, icon, order})` | a named command, listed in Search and runnable from buttons and menus; returns a dispose function |
| `api.commands.execute(id, ...args)`, `api.commands.list()` | run or list the commands this plugin registered |
| `api.ui.addPage({id, title, icon, description, order, nav, render})` | a page at `/ext/{plugin}/{id}`; `render(container, context)` is called on every visit and may return a cleanup function (or, instead, `deactivate` does the cleanup). `nav` is `false` to keep it out of the sidebar. |
| `api.ui.addSidebarItem({id, title, icon, page, href, order})` | another entry under the plugin's section in the sidebar; `page` is a registered page, `href` an application path |
| `api.ui.addToolbarButton({id, title, icon, command, order})` | an icon button in the top strip that runs a command |
| `api.ui.addMenuItem(menu, {label, icon, command, order})` | an item in an existing menu: `section:projects`, `section:library`, `section:plugins`, `section:settings`, or `ext:{plugin}:{page}` |
| `api.ui.addHomeCard({id, title, icon, order, render})` | a card on the Dashboard; `render(container)` draws it |
| `api.ui.addStyles(css)` | a `<style>` element for the lifetime of the plugin. Styles are global: scope selectors with the `plugin-{id}` class the host puts on `<body>` |
| `api.ui.notify({title, body, level, href})` | a message in the notification bell (`level`: `info`, `success`, `warn`, `error`) |
| `api.ui.toast(message, error)`, `.dialog(...)`, `.confirm(...)` | the application's own transient messages and dialogs |
| `api.ui.el(tag, props, ...children)` | a small DOM builder (`class`, `text`, `html`, `style`, `dataset`, `onclick`, attributes) |
| `api.ui.card(options)`, `.field(label, control)`, `.icon(name)`, `.escape(text)` | the application's card, form field, icon and escaping helpers, as HTML strings |
| `api.ui.navigate(path)`, `.refresh()`, `.pageHref(pageId)` | go to a path, draw the current page again, or get the address of a plugin page |
| `api.log(...args)` | a line in the page console, prefixed with the plugin id |

Icons are application icon names (`sparkles`, `plug`, `chart`, `wrench`, ...) or an uploaded icon data URL. A plugin page gets the page header, its sidebar entry in the plugin's section and the second panel automatically; `render` fills the body.

A page's `render` receives `(container, context)`, where `context` is `{page, route, api, go, refresh}`. Returning a function makes it the page's cleanup, called when leaving the page. Errors do not break the application: a failed `activate` or a failed `render` is reported on the plugin's Plugins page and in a toast, and the rest of the interface keeps working.

`client.js` is trusted code in the page with the page's authority, so it can also use browser globals and the application's own functions. It cannot `require` modules. Like `main.js`, it has full access: the official tools are the supported way to change the interface, not a sandbox. In a browser without the server there is no plugin host and no interface modules.

### Lifecycle

The interface follows the server module. The page loads `client.js` for plugins that are running and have the file; turning a plugin off, failing its startup or reloading the folder removes its pages, sidebar entries, toolbar buttons, commands, menu items, dashboard cards and styles. The Plugins page shows what a plugin registered, any interface error, and has **Reload plugins** in its menu, which reloads both `main.js` and `client.js` so edits take effect without restarting the server.

`data/plugins/hello-ui` is a complete example: it registers a page, a toolbar button, a command, a menu item, a dashboard card and styles, and calls its own server route.

