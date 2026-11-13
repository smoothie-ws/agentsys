# Hello UI

An example of every official interface tool a plugin can use from `client.js`:

- `api.ui.addPage` registers the **Hello** page (and its sidebar entry) at `/ext/hello-ui/hello`.
- `api.ui.addToolbarButton` puts the sparkle button in the top strip.
- `api.commands.register` adds **Hello UI: say hello** to the command palette (Search) and to the menu.
- `api.ui.addMenuItem` adds it to the Plugins section menu as well.
- `api.ui.addHomeCard` adds a card to the dashboard.
- `api.ui.addStyles` adds the panel styles; they are scoped with the `plugin-hello-ui` body class.
- `api.request` calls the backend route in `main.js`, and `api.onDidChange` refreshes the page when its data changes.

Turn the plugin off on its page under **Plugins**: the sidebar entry, toolbar button, commands, page, card and
styles disappear with it. Turn it on again to bring them back. Edits to `client.js` take effect after
**Reload plugins**.

See [plugins](../../../docs/plugins.md#interface) for the complete reference.
