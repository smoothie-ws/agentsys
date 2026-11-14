# UI extensions

A plugin extends the interface through declarations, not by editing the application DOM. Each registration belongs to
one sandbox and is removed when the plugin stops. Renderers return passive HTML; the host sanitizes it and inserts it
into its own layout, so the application's design system (classes, colours, spacing, focus states) applies.

## Pages and navigation

```js
api.ui.addPage({
  id: 'overview',
  title: 'Overview',
  description: 'What this plugin shows',
  icon: 'chart',
  order: 10,
  nav: true,
  render: async context => `<h2>Overview</h2><p>${api.escape(api.id)}</p>`,
});
```

- The page is at `/ext/<plugin>/<page>`.
- `nav: false` hides the sidebar entry; `addSidebarItem` adds a separate link.
- `render` may return HTML, an element, or a promise of either. It receives the route context as plain JSON.
- `api.ui.pageHref(id)` returns the path for a link.

`addSidebarItem({id, title, icon, href?, page?, order?})` accepts either a client path (`/library`) or a registered
page id. External and `javascript:` URLs are refused at registration.

## Toolbar, menus and commands

```js
api.commands.register('hello', name => api.ui.toast(`Hello ${name}`), {title: 'Say hello', icon: 'sparkles'});
api.ui.addToolbarButton({id: 'hello', command: 'hello', title: 'Say hello', icon: 'sparkles'});
api.ui.addMenuItem('section:plugins', {label: 'Say hello', command: 'hello', icon: 'sparkles'});
api.ui.addContextMenu({label: 'Greet the selection', command: 'hello', args: [{name: 'selection'}], order: 40});
```

Known menus:

| Menu | Appears on |
|---|---|
| `canvas:add` | The canvas Add menu |
| `canvas:selection` | The canvas selection/context menu |
| `library:resource` | A Library node's “⋯” menu |
| `nodes:` / `folder:<path>` | Library nodes and group menus |
| `resource:<id>` | One Library node |
| `section:library`, `section:projects`, `section:plugins`, `section:settings` | Section menus |
| `plugin:<id>` | A plugin card/page menu |
| `ext:<plugin>:<page>` | A plugin page menu |

A menu command receives the menu's context as its first argument: `{type, id, resource?, project?, workflow?,
folder?, section?, plugin?, selection?}`. `canvas:add` receives `{project, workflow, point}`; `canvas:selection`
receives `{project, workflow, selected}`.

The same command can be a button in passive HTML:

```html
<button type="button" data-command="hello" data-args='[{"name":"Ada"}]'>Say hello</button>
```

Only this plugin's commands are accepted; `other-plugin:hello` is refused.

## Dashboard cards

```js
api.ui.addHomeCard({id: 'stats', title: 'Stats', icon: 'chart', render: async () => '<p class="muted">3 items</p>'});
```

Cards are drawn in the dashboard's grid with the application card styles. A failing card shows an error in its own
body; other cards and the page continue.

## Settings

```js
api.ui.addSettingsSection({
  id: 'preferences',
  title: 'My plugin',
  description: 'Settings stored by the plugin',
  render: async () => '<button type="button" data-command="reset">Reset</button>',
});
```

Sections are appended to the application Settings page, outside the application's own autosaving form. Use
`api.settings` for values and commands for changes.

## Inspector

```js
api.ui.addInspectorSection({
  id: 'node-info',
  title: 'Node info',
  when: 'any', // or "node" or "complex"
  render: ({node, selection, project, workflow}) => `<p>${api.escape(node?.name || 'nothing')}</p>`,
});
```

Sections appear in the Inspector of the selected node, after the application's own properties. `when: "node"` limits
the section to ordinary nodes; `"complex"` to Complex Nodes.

## Library sections and custom resource views

```js
api.ui.addLibrarySection({
  id: 'notes',
  title: 'Notes',
  icon: 'database',
  render: async () => '<h2>Notes</h2>',
});
```

A Library section is a normal plugin page shown in the Library overview and in the Library navigation. Use
`api.library.list()` and `api.collections.*` for its content.

```js
api.ui.addResourceView({
  id: 'note-table',
  title: 'Note table',
  collection: 'notes',
  sidebar: true,
  render: ({records, total}) => `<table>...</table>`,
});
```

A resource view is a page at `/ext/<plugin>/view-<id>` that the host fills with the collection's records (up to 200)
before calling `render`. This is the supported way to give a collection a custom UI without direct DOM access.

## Dialogs

```js
const answer = await api.ui.showDialog({
  title: 'Endpoint',
  body: '<label class="field"><span>URL</span><input name="url" value="http://127.0.0.1:8791"></label>',
  actions: [{label: 'Save', id: 'save', command: 'save-url', variant: 'primary'}],
});
// answer = {action: "save", values: {url: "..."}, result: <command result>}
```

The dialog's form values are passed as the first command argument. `api.ui.closeDialog()` closes it. The dialog is the
application's modal, so focus, Escape and the close button behave natively.

## Notifications, toasts and navigation

```js
await api.ui.notify({title: 'Done', body: 'The import finished', level: 'success'}); // needs notifications.write
api.ui.toast('Saved');
api.ui.navigate('/plugins');
api.ui.refresh();
```

`notify` is a server write. `toast` is local. `refresh` redraws the current page.

## Styles

`api.ui.addStyles(css)` appends scoped CSS to the page. `@import`, `url(...)`, `expression(...)` and `javascript:` are
refused, so a plugin cannot load a remote resource through CSS. The style node is removed with the plugin.

## What a plugin cannot do

- It cannot access the application DOM, `document`, `window.parent.document`, `localStorage`, `sessionStorage`,
  cookies or the server token.
- It cannot inject scripts, frames, forms, event-handler attributes, external images or unsafe URLs; the host
  sanitizer removes them.
- It cannot register a server route.
- It cannot use another plugin's command, storage or token.

See [plugin-security.md](plugin-security.md) and the reference plugin `reference-ui-showcase`, which registers every
extension point.
