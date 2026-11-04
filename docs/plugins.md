# Plugins

The plugin contract is two functions: `start(api)` and `stop()`. Put a `main.js` in a folder under `plugins/`; the application discovers it and manages its lifecycle. `api(method, path, body, query)` calls the same application API as the editor. There is no manifest or required settings schema. A plugin is trusted code that runs in the server process.

```
plugins/
  hello/
    main.js
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

Optional display metadata is `exports.title`, `exports.description`, and `exports.icon` (an application icon name such as `sparkles`). It is read even when the plugin is disabled. The bundled **AI** example is in `plugins/hello`; its original id and greeting behavior are kept for existing workflows and saved settings.

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
| `GET plugins` | `[{id, title, description, icon, enabled, running, error}]` |
| `GET plugins/{id}` | the same plus `routes`, `readme` and `settings` (with values; a password only as `set`) |
| `PUT plugins/{id}` `{enabled}` | turns one on or off |
| `PUT plugins/{id}/settings` `{values}` | saves settings (the name `settings` is reserved) |
| `POST plugins/reload` | reloads the folder |
| `GET/POST/PUT/DELETE plugins/{id}/{name}` | a route a plugin registered |

`PLUGINS_DIR` selects another folder (default: `plugins/` beside `server.js`).

## Scripts and plugins

A Script can call a plugin's route with `await agentsys('GET', 'plugins/hello/greet', undefined, {name: 'Ann'})`. That needs the `plugins.call` permission on the node and in the project policy, like every other checked call. Listing and switching plugins is administrative and not available to Scripts.

Plugins need the server. In a browser without the server there is no plugin host and the list is empty.

To build an LLM controller on top of a plugin like this, see [building an LLM controller from nodes](llm-controller.md).
