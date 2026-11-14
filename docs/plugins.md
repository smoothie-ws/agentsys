# Client plugins

Plugins exist **only in the client**. The server does not load plugins, does not scan plugin folders for code and
does not expose a plugin route. A plugin extends the editor; anything it creates on the server is ordinary
AgentSys data.

## What a plugin can add

- Pages (`/ext/<plugin>/<page>`).
- Commands, toolbar buttons and menu items.
- Sidebar items and dashboard cards.
- Scoped CSS (no external URLs or `@import`).
- Server resources through the normal API: Library nodes, workflows, collection definitions and records,
  notifications, settings.
- A Library node created by a plugin is saved by the server and keeps working when the plugin or the client is
  gone. This is the required boundary.

## Package

A package is one JSON object:

```json
{
  "id": "my-plugin",
  "title": "My plugin",
  "version": "1.0.0",
  "description": "What it adds.",
  "icon": "sparkles",
  "api": 1,
  "capabilities": ["graph.read"],
  "source": "exports.activate = api => { api.commands.register('hi', () => api.ui.toast('Hello'), {title: 'Say hello'}); };"
}
```

Install it from **Plugins → Install plugin**: paste the form or import a `.json` file. Packages live in this
browser (`localStorage`, 400 KB source, at most 50 plugins). They are never uploaded to the server.
Bundled examples are in `client-plugins/index.json` and are loaded by the client static server.
A package without `capabilities` runs read-only; see [Capabilities](#capabilities).

## Sandbox

Each plugin runs in its own `<iframe sandbox="allow-scripts">` loaded from a Blob URL. It has an opaque origin:

- No access to the page DOM, `localStorage`, `sessionStorage`, cookies or the server token.
- No `require`, no network of its own. Server calls go through the host's authenticated transport.
- Communication is JSON `postMessage` with the host; the host validates plugin ids, page ids and limits.

Page and card HTML returned by a plugin is passive and sanitized: scripts (including `<svg><script>`), frames,
forms, event-handler attributes and `javascript:`/HTML-data URLs are removed. Plugin CSS is rejected if it
references external URLs or uses `@import`.

A plugin can only execute its own commands: `api.commands.execute('other:command')` is refused, so one plugin
cannot drive another. A sidebar item's `href` must be a path of this client (`/…`); an absolute URL or a
`javascript:` URL is refused at registration.

## Capabilities

The host decides what a plugin may ask the server to do, from the call itself (method, path and, for `net`, the
body), never from the plugin's own label. A package declares what it needs:

```json
{
  "id": "my-plugin",
  "title": "My plugin",
  "api": 1,
  "capabilities": ["graph.read", "library.read", "library.write"],
  "source": "exports.activate = async api => { … };"
}
```

| Capability | Allows |
|---|---|
| `graph.read` / `graph.write` | Read / change projects, workflows and the graph |
| `library.read` / `library.write` | Read / change Library nodes and resources |
| `collections.read` / `collections.write` | Read / change generic collections |
| `run.read` / `run.start` | Inspect a live run / start, stop, pause or resume it |
| `notifications.read` / `notifications.write` | Read / post notifications |
| `settings.read` / `settings.write` | Read / change preferences and interface state |
| `secrets.use:<name>` | Use one named server secret (no wildcard) |
| `net.fetch:<host>` | Make the server fetch that host (`*` allowed inside the value) |

A package that declares no `capabilities` is **read-only**: the six `*.read` capabilities above. Writes, runs,
secrets and network hosts are each named explicitly. Anything outside the table (authentication, unknown
routes, another plugin's secret) is refused whatever the package declares. `api.request` rejects with a message
that names the missing capability, and the Plugins page shows and edits the list.

**Limits, stated honestly:** the capability check runs in the host page, because the server authenticates the
browser session, not the plugin. It therefore holds against a plugin's code, which is the sandboxed attacker
here, but not against a user who edits the client or calls the API directly. That user is the operator and has
the token, so the server's trust boundary is the token, not the plugin. Install untrusted plugins knowing that
the sandbox protects your browser session, and that a granted write capability is a real write.

## Plugin API

The `api` object passed to `activate(api)`:

```js
exports.activate = async api => {
  api.commands.register('greet', name => api.ui.toast('Hello ' + name), {title: 'Greet', icon: 'sparkles'});
  api.ui.addToolbarButton({id: 'greet', command: 'greet', title: 'Greet'});

  api.ui.addPage({
    id: 'overview',
    title: 'Overview',
    icon: 'chart',
    render: async () => {
      const projects = await api.request('GET', 'projects');
      return '<h2>Projects</h2><p>' + projects.length + '</p>';
    },
  });

  api.ui.addHomeCard({
    id: 'hello',
    title: 'Hello',
    render: () => '<p class="muted">From a client plugin.</p>',
  });
};

exports.deactivate = () => {};
```

| Member | Purpose |
|---|---|
| `api.request(method, path, body?, query?)` | Calls the active server through the host transport, if the plugin's capabilities cover the call. `path` is relative to `/api`. Auth endpoints are blocked. |
| `api.capabilities` | The capabilities this plugin was granted (read-only list). |
| `api.storage.get/set/remove` | Private JSON in this browser, scoped by plugin and environment. |
| `api.settings.get/set` | Shortcut for a settings object in the same store. |
| `api.commands.register(id, handler, meta)` | A command callable from toolbar, menus and `api.commands.execute`. |
| `api.ui.addPage({id,title,render,...})` | A page. `render` returns an HTML string (or a Node, converted to HTML). |
| `api.ui.addSidebarItem`, `addToolbarButton`, `addMenuItem(menu,item)`, `addHomeCard` | Interface contributions. |
| `api.ui.addStyles(css)` | Adds CSS to the page. `@import`, `url(...)` and `expression(...)` are refused, so it cannot load external resources; it can still restyle the client, so install trusted plugins. |
| `api.ui.notify`, `toast`, `navigate`, `refresh`, `escape`, `pageHref` | Small host conveniences. |
| `api.env.info()` | `{id, name, url, status, protocol}` of the active environment. |
| `api.onDidChange(listener)` / `api.on('change', listener)` | Called with changed storage keys. |
| `api.log(...)` | Writes to the host console. |

A client plugin cannot register a server route. If it needs server-side background work, it created a workflow
at install time (through the normal API); the workflow then runs on the server independently.

## Standard resources instead of privileged code

Old server plugins could register arbitrary API routes and hooks. A client plugin has no equivalent and should
not need one:

1. Define a generic collection with `PUT /api/collections/<name>` and store records with
   `POST /api/collections/<name>/records`.
2. Create a reusable Script node with `POST /api/library/script-nodes`.
3. Compose those with workflows and the existing `net` API for external calls.
4. Store credentials as server secrets and reference them as `{{secret:name}}` where the standard API supports
   it. The plugin itself never receives a secret.

The server validates collections and Script nodes without understanding the plugin's domain.

## Examples

- `hello-ui`: page, command, toolbar button, dashboard card, reads projects through `api.request`.
- `script-node-builder`: creates a `Greeting` Library node through `POST /api/library/script-nodes`. Disable or
  remove the plugin: the node remains in the Library and runs on the server.

## Migration from server plugins

The old `data/plugins/*/main.js` code is no longer executed; the removed host and routes are kept, unloaded, in
`legacy/` as migration reference. `agentsys-server migrate` preserves every plugin
folder, copies sources and data to `data/plugins-migrated/`, snapshots `data/plugins/`, moves provider
configurations to the generic `providers` collection and moves API keys to secrets. It reports route
dependencies and any workflow that calls `plugins/…`; those calls are not rewritten automatically. See
[migration.md](migration.md).
