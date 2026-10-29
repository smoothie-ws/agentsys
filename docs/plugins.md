# Plugins

A plugin extends the product through **one JSON package** (`agentsys.plugin/1`), imported from the Plugins action menu. Native Library collections are declarative: the host owns their navigation, cards, groups, menus and settings forms. Custom pages run in sandboxed iframes; endpoints run in isolated Workers when called. Plugin export is not supported.

## Package

```jsonc
{
  "format": "agentsys.plugin/1",
  "manifest": {
    "id": "ai-controller", "name": "AI Controller", "version": "1.0.0", "engine": ">=1",
    "description": "…", "author": "…", "icon": "plug",
    "capabilities": ["graph.read", "net.fetch:api.example.com", "secrets.use:llm"],
    "secrets": ["llm"],
    "contributes": {
      "nodes":     ["nodes/tools.json"],                              // exported Library catalogs
      "templates": [{"id": "starter", "name": "Starter", "file": "templates/starter.json"}],   // exported projects
      "pages":     [{"id": "providers", "title": "Providers", "section": "plugins|library", "icon": "key", "entry": "ui/providers.html"}],
      "tiles":     [{"id": "spend", "title": "Spend", "height": 140, "entry": "ui/spend.html"}],  // Dashboard
      "commands":  [{"id": "ask", "title": "Ask AI…", "page": "providers"}],                       // Ctrl+K ("path": "/runs" for an app page)
      "endpoints": [{"name": "ask", "methods": ["POST"], "entry": "server/ask.js"}],
      "settings":  {"fields": [{"key": "model", "label": "Model", "type": "text|textarea|number|boolean|select", "default": "x"}]}
    }
  },
  "files": {"ui/providers.html": "…", "server/ask.js": "…"}
}
```

Limits: 200 files, 2 MB per file, 8 MB per package; `PLUGIN_API = 1` (a package with `engine: ">=2"` is refused). Everything is checked on install (names, files, duplicates, capability syntax); a failed install leaves nothing behind.

## Life cycle

- **Install** (`POST plugins {package, grants, enable, replace}`): disabled unless asked; the person ticks which declared capabilities to **grant**. An id already installed answers `409 already_installed` unless `replace` (an update keeps enabled state, grants still declared, settings and data).
- **Enable / disable** (`PUT plugins/{id} {enabled}`): an enabled plugin puts its nodes into the Library (folder named after the plugin, ids `plugin.<id>.<name>`, so copies already placed keep following), its pages into the sidebar, its tiles on the Dashboard, its commands into Ctrl+K. Disabling removes them; **placed copies keep working**. A name clash with an existing Library node refuses the enable.
- **Remove** (`DELETE plugins/{id}`): package, settings, private data and native Library resources are deleted. Plugin nodes in the Library, and their groups, are read-only for people (only Export and Duplicate; a duplicate is an ordinary node without grants).

## Native Library collections

Declare `contributes.library` to add sections, nested sections and typed resources:

```json
[
  {"id":"tools", "title":"Tools", "icon":"folder"},
  {"id":"prompts", "title":"Prompts", "parent":"tools", "icon":"file",
   "actions":[{"id":"sync", "title":"Sync collection", "endpoint":"sync"}],
   "folderActions":[{"id":"sync-folder", "title":"Sync group", "endpoint":"sync"}],
   "item":{"name":"Prompt", "format":"json", "fields":[
     {"key":"body", "label":"Instructions", "type":"textarea", "required":true}
   ], "actions":[{"id":"check", "title":"Check prompt", "endpoint":"check"}]}}
]
```

IDs are scoped to the plugin: `demo.prompts`. Parents must exist in the same plugin; cycles and duplicate IDs are rejected. Sections without `item` contain child sections. Collections can also have child sections and user-created groups.

Fields support `text`, `textarea`, `number`, `boolean`, `select`, `json` and `secret`, plus `label`, `help`, `required` and `default`. Selects declare `options`; JSON can declare `shape: "object" | "array"`; text can declare `format: "url" | "id"`. Text, number and select fields can be `unique` across the collection. Secrets are stored separately, omitted from reads and resource exports, and represented by boolean `secrets` flags. Omit a secret on update to keep it; send an empty string to remove it.

Actions reference declared POST endpoints. The host passes `{section, folder}` for collection/group actions, adding `item` for a resource action. Built-in creation, rename, move, deletion and resource export use the common menus. New Node/New Group belong to Nodes, never the whole Library. A plugin uses the same API as the host:

| Method | Path | Body / result |
|---|---|---|
| GET | `library/sections` | Enabled section declarations, including core Nodes |
| GET | `library/sections/{section}/items` | `{folders, items}`; `?summary=1` omits content and values |
| POST | `library/sections/{section}/items` | `{name, description, folder, values}` |
| GET PUT DELETE | `library/sections/{section}/items/{id}` | Read, partial update or delete one resource |
| POST | `library/sections/{section}/folders` | `{action:"create", path, name}`, `{action:"rename", path, name}` or `{action:"delete", path}` |

Plugins access their own collections through `agentsys.request` without global Library grants. Other collections require the normal Library permissions. Core graph Nodes expose a summary through this API and retain their graph editor and graph-specific mutation endpoints.

### Skills

An item with `format: "skill"` uses fixed `name`, `description` and `values.instructions` fields. Its source is a standard [Agent Skills SKILL.md](https://agentskills.io/specification): YAML frontmatter with name and description, followed by Markdown instructions. Names use 1–64 lowercase letters/digits and single hyphens. Description is required and limited to 1024 characters. Extra frontmatter is preserved on editing. POST `{content: markdown, folder}` imports a document; GET returns its `content` for export.

On disk: `data/library/skills/<section>/<name>/SKILL.md`. Collection JSON holds IDs and references, not another copy of the instructions. Typed JSON resources live in `data/library/sections/<section>.json`; secret values live under `data/library/credentials/<section>/`.

## Rights

A plugin's page or endpoint may call the API only through `POST plugins/{id}/bridge`: allowed = capabilities the plugin **declares** ∩ what the person **granted** (read fresh on every call, so revoking or disabling acts at once), with the same quarantine as Scripts (what it writes into a graph or the Library carries `grants: ["graph.read"]`). Its own settings, data, native Library collections, log and endpoints need no global grant. The plugin management routes themselves are `system.admin` and unreachable from plugins and Scripts. Secrets are used with `{{secret:NAME}}` placeholders and need `secrets.use:NAME`.

## Pages and tiles (UI)

A page is an HTML file in the package. The host builds a `srcdoc`, inlines the relative `<script src>` and `<link rel=stylesheet>` files of the package, adds a CSP (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'`) and runs it in `<iframe sandbox="allow-scripts">` (no same-origin rights, no network). The only way out is `postMessage`, answered only for the frame the host made. In the page, `window.agentsys` has:

`request(method, path, body, query)`, `get/post/put/delete`, `settings.get()/set(values)`, `data.list/get/set(key, value, version?)/delete`, `call(name, body, method?)` (own endpoint), `navigate('/runs')`, `toast(text, isError?)`, `resize(px)`, `onTheme(fn)`. Theme colours arrive as CSS variables (`--text`, `--accent`, `--surface`, …).

**Navigation.** Custom pages default to the permanent tree of their declared primary section. A page may explicitly set `navigation: {title, items:[{page, title, icon}]}` to override the second panel. Each referenced page must belong to the same plugin and primary section. Omit this property for standard navigation. Native collections always use the standard host layout.

**Plugin details.** The host shows a common page header with an action menu, a custom icon, version/publisher/status, Overview, Settings, Permissions and Activity. Set `readme` to a packaged `.md` path and optionally `homepage` to an HTTPS URL. The `icon` can be a built-in name, an SVG package path or a PNG package path whose file value is a data URL. This follows the metadata and overview structure of [VS Code extension pages](https://code.visualstudio.com/api/references/extension-manifest). Custom pages load declared UI assets from `plugins/{id}/ui?path=...`; there is no package export endpoint.

**Built-in AI.** `plugins/ai/` declares Library / AI / Providers / Skills using the native API. Provider configuration follows [OpenCode](https://opencode.ai/docs/providers/): stable provider ID, API adapter (`npm`), base URL, model map, environment variable names, headers, options and a separately stored API key. This is a configuration scaffold: model execution, environment credential resolution, OAuth and connection tests are not implemented. Skills are canonical SKILL.md files. Run `npm run build:plugins` after editing the source. Bundled updates keep settings, enabled state and resources; user-installed replacements are not overwritten. The 0.1.0 scaffold data is converted once, retaining its original private entries as an archive. Deleted built-ins remain deleted unless `restore: true` is passed.

**Source and installed data.** `plugins/ai/` is version-controlled source shipped with the app. Installed packages live in `data/plugins/<id>/package.json`; their settings and private records live beside them, and `data/plugins/index.json` is the registry. Keep source outside `data/`: deleting or moving a user's data directory must not delete the plugin code bundled with the application. `DATA_DIR` moves installed packages and user records together.

The page sandbox does not allow native form submission. Use button click handlers and the bridge for saves; native `form.submit()` and submit buttons are blocked.

## Endpoints

`GET|POST|PUT|DELETE /api/plugins/{id}/call/{name}`: the file is the body of `async (request, agentsys, plugin) => {…}`; `request = {method, query, body}`, `agentsys(method, path, body, query)` is the checked bridge, `plugin.data` and `plugin.settings` are the plugin's own. It returns JSON (≤ 1 MB). It runs in an isolated Worker (same sandbox as Scripts: no network, no imports, frozen intrinsics), 30 s limit, 4 at once (`429 too_many_calls`). Network access goes through `agentsys('POST','net',…)`, so it needs `net.fetch:<host>`.

## Data

`plugins/{id}/data[/{key}]`: a private key-value store with compare-and-set (`version`), 2 MB total, 500 KB per value, 500 keys. Settings are validated against the declared schema. An in-memory activity log (100 entries: calls, denied requests, changes) is at `plugins/{id}/log` and on the plugin's page.

## What a plugin cannot do

Run code on its own (no startup hook, no timers: use a workflow with an interval trigger and a Library node for periodic work), change the core UI outside the contributed places, read another plugin's data, or touch plugin management. Add a new extension point in the core, not a way around these limits.
