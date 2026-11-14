# Plugin development guide

This is the complete loop for a third-party developer: an empty folder, a running AgentSys, an installed plugin, an
error to fix, capabilities, Library nodes, a package and an update.

## 1. Start AgentSys

```bash
npm start
```

Open the printed client address. The default server is loopback only. For a separate client and server:

```bash
npm run server
npm run client
```

## 2. Write the smallest plugin

```
hello/
  plugin.json
  main.js
```

`plugin.json`:

```json
{
  "id": "hello-agent",
  "name": "Hello Agent",
  "version": "1.0.0",
  "description": "A first plugin.",
  "icon": "sparkles",
  "api": 2,
  "capabilities": ["graph.read"],
  "main": "main.js"
}
```

`main.js`:

```js
exports.activate = async api => {
  api.commands.register('hello', () => api.ui.toast('Hello'), {title: 'Say hello'});
  api.ui.addPage({
    id: 'home',
    title: 'Hello',
    render: async () => `<h2>Hello</h2><p>${api.escape(api.id)}</p><button type="button" data-command="hello">Say hello</button>`,
  });
};
```

The full example lives in [`examples/hello-plugin`](../examples/hello-plugin).

## 3. Build and install

```bash
node tools/plugin-pack.js hello
```

Open the **Plugins** page, open its **⋯** menu, choose **Install plugin…**, then **Import JSON file…**, choose `hello/hello-agent-1.0.0.agentsys-plugin.json`. The
plugin is stored in this browser only. Open its card to see its state, interface contributions and package.

For a quick experiment without a file, the install form accepts the same fields and source directly.

## 4. See errors

- The plugin card says **Interface failed** and shows the message; `/plugins/<id>` shows the full error and
  **Try again**.
- `api.log(...)` writes to the browser console prefixed with the plugin id.
- A page/card render error is shown in its own region; other cards continue.
- A command error becomes a toast and is thrown to the caller.
- A package validation error is shown in the install form before anything is stored.

## 5. Capabilities

A plugin without `capabilities` is read-only. Add only what the code uses:

```json
"capabilities": ["graph.read", "graph.write", "library.write", "collections.write", "secrets.use:weather", "net.fetch:api.weather.test"]
```

A refused call names the missing capability. The server applies the same rule to the plugin's scoped token. See
[plugin-capabilities.md](plugin-capabilities.md).

## 6. Debug the UI

- `api.ui.addPage` gives a real route; open `/ext/<plugin>/<page>`.
- Buttons in passive HTML use `data-command` and optional `data-args` JSON:
  `<button data-command="hello" data-args='[{"name":"Ada"}]'>`.
- Use the application's classes (`page-facts`, `button-row`, `primary`, `muted`, `card`, `empty`, `form-error`,
  `oc-table`) for a native look. `api.ui.addStyles` adds scoped CSS; it cannot load external resources.
- Settings, Library, Inspector and resource-view sections are registered with `addSettingsSection`,
  `addLibrarySection`, `addInspectorSection` and `addResourceView`.
- Dialog input is read from the shared modal and passed to the action command as its first argument.

## 7. Add a Library node

```js
const node = await api.library.ensureNode({
  name: 'Slug',
  code: "node.output.slug = String(node.input.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  inputs: ['text'],
  outputs: ['slug'],
  grants: ['graph.read'],
  folder: 'Text',
});
```

The node is saved by the server. Place it on a canvas or declare it in `contributes.library`; it runs after the plugin
is gone. If the node writes a collection or fetches the network, its grants and the project policy must both allow it.
See [plugin-library.md](plugin-library.md).

## 8. Declare server resources

Add `contributes` for collections, Library nodes and a workflow template. The plugin page's **Deploy resources**
button creates them on the active server through the plugin's checked token. It is idempotent per version and per
environment.

A workflow template gets a native Event trigger by default, so it can be run from the canvas or the API with no client:

```bash
curl -X POST http://127.0.0.1:8080/api/projects/<id>/execution?workflow_id=<wf> \
  -H 'X-AgentSys: 1' -H 'Content-Type: application/json' -d '{"wait":true}'
```

## 9. Update the package

1. Change the code and bump `manifest.version`.
2. Build again.
3. On the plugin page choose **Update from file…** and pick the new package.

Private data and enabled state are kept. `onUpdate(api, {from, to, dataVersion})` runs before `activate`; return a new
data version if you migrate stored values. If the new version cannot start, the previous package is restored.

## 10. Test it

- `node tools/plugin-pack.js --check .` for the manifest and paths.
- `node tools/plugin-pack.js --validate package.agentsys-plugin.json` for a built file.
- `npm test` for the platform tests.
- For end-to-end behaviour, use the reference tests as a template:
  `tests/browser_plugin_platform.py` installs packages, exercises the UI, switches servers and runs a deployed graph
  with the browser closed.

## Common mistakes

| Symptom | Cause |
|---|---|
| `Module not found in the package` | The path is missing from `files`, is not relative, or has no `.js` |
| `The plugin must export activate(api)` | `main.js` does not assign `exports.activate` |
| `Unknown plugin capability` | A typo or an invented name; the list is closed |
| `Permission denied: graph.write` | The package did not declare it, or the project policy does not allow a node's grant |
| The deployment did nothing | The plugin is disabled, or the package's `contributes` is empty |
| A node shows a permission error | Its `grants` and the project policy must both allow the capability |
| A page is blank | The renderer threw; the error is in the console and the page body |
| An image does not show | Assets must be PNG/JPEG/GIF/WebP and used with `api.asset` in an `<img>` |
