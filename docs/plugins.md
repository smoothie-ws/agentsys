# Plugins

AgentSys plugins are **client-side extensions**. The server never loads plugin code, never scans a plugin folder and
has no plugin route. A plugin extends the editor; anything it creates on a server is ordinary AgentSys data that
outlives both the plugin and the browser.

This page is the index. The platform is documented in:

| Document | What it covers |
|---|---|
| [plugin-architecture.md](plugin-architecture.md) | How the parts fit: package store, sandbox, capabilities, tokens, deployment |
| [plugin-sdk.md](plugin-sdk.md) | Every member of the injected `api` object |
| [plugin-manifest.md](plugin-manifest.md) | Package and manifest fields, versions, dependencies, files, assets |
| [plugin-lifecycle.md](plugin-lifecycle.md) | Install, enable, disable, reload, update, uninstall, migration, recovery |
| [plugin-ui.md](plugin-ui.md) | Pages, navigation, toolbar, context menus, commands, settings, dialogs, widgets, inspector, views, notifications |
| [plugin-library.md](plugin-library.md) | Library sections, Custom Nodes, workflow templates, collections, server-only execution |
| [plugin-capabilities.md](plugin-capabilities.md) | The capability list and what each name permits |
| [plugin-security.md](plugin-security.md) | Sandbox, CSP, message validation, secret handling, tokens, isolation |
| [plugin-packaging.md](plugin-packaging.md) | Building, exporting and installing a package |
| [plugin-development.md](plugin-development.md) | A complete developer loop, from an empty folder to an update |
| [plugin-testing.md](plugin-testing.md) | Automated node, browser and server-only tests |
| [plugin-migration.md](plugin-migration.md) | From old server plugins and from the first client package format |

## In one minute

```js
exports.activate = async api => {
  api.commands.register('hello', () => api.ui.toast('Hello'), {title: 'Say hello'});
  api.ui.addPage({
    id: 'home',
    title: 'Hello',
    render: async () => `<h2>Hello from a plugin</h2><p>${api.escape(api.id)}</p>`,
  });
};
```

Install it from the **Plugins** page: open the **⋯** menu and choose **Install plugin…** (write the form, or import a package file). It is stored in this browser
only. It runs in a sandboxed iframe with no access to the application DOM, `localStorage`, cookies or the server
token. Server calls go through `api.request`, checked against the capabilities the package declares and, when the
server supports it, against a short-lived scoped token as well.

A package that declares no capabilities is read-only. A package gains writes, runs, secrets and network hosts only by
naming them in its manifest.

## Client installation is not server deployment

There are two separate actions:

1. **Install** puts a package in this browser. It changes the editor.
2. **Deploy resources** (on the plugin page) creates the package's declared collections, Library nodes and workflow
   templates on the **active server**, through the plugin's own capabilities.

Deployment records are kept per environment. Switching servers shows the data of the active server only; deploying
again on another server creates its own resources and never reuses an id. Server resources keep working when the
plugin is disabled, removed or the browser is closed.

No server plugins are supported. Old server plugin folders are handled by `agentsys-server migrate`; see
[migration.md](migration.md).

The certification matrix and test evidence are in [PLUGIN-CERTIFICATION.md](../PLUGIN-CERTIFICATION.md).
