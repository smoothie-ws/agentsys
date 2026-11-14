# Plugin manifest and package format

A package is one JSON file. The current format is **2**; the original single-source format (1) is still accepted and
is upgraded in the browser. Validation lives in `js/app/plugin-manifest.js` and is used by the client, the packaging
tool and the tests.

## Format 2

```json
{
  "format": 2,
  "manifest": {
    "id": "com.example.notes",
    "name": "Notes",
    "version": "1.2.0",
    "description": "A note collection with a custom view.",
    "icon": "database",
    "api": 2,
    "engines": {"agentsys": ">=0.3.0 <1.0.0"},
    "capabilities": ["collections.read", "collections.write", "library.write"],
    "dependencies": {"core-tools": "^1.0.0"},
    "author": "Example",
    "license": "MIT",
    "homepage": "https://example.test/notes"
  },
  "main": "main.js",
  "files": {
    "main.js": "const view = require('./lib/view'); exports.activate = api => view(api);",
    "lib/view.js": "module.exports = api => api.ui.addPage({id: 'notes', render: () => '<h2>Notes</h2>'});"
  },
  "assets": {
    "logo": {"type": "image/png", "data": "iVBORw0KGgo="}
  },
  "contributes": {
    "collections": [
      {"name": "notes", "title": "Notes", "schema": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}}
    ],
    "library": [
      {"name": "Word count", "code": "node.output.count = String(node.input.text || '').split(/\\s+/).length;", "outputs": ["count"]}
    ],
    "workflows": [
      {"name": "Notes demo", "project": "Notes", "nodes": [{"library": "Word count"}]}
    ]
  },
  "checksum": "fnv1a-1a2b3c4d"
}
```

`tools/plugin-pack.js` produces this from a source directory and fills `checksum`. The checksum detects an accidental
change; it is **not** a security signature.

## Manifest fields

| Field | Required | Rules |
|---|---|---|
| `id` | yes | `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`; stable for the life of the plugin |
| `name` | yes | 1 to 120 characters, shown in the interface |
| `version` | yes | Semantic version (`1.2.0`, `1.2.0-beta.1`) |
| `description` | no | Up to 2000 characters |
| `icon` | no | A built-in icon name (`[a-z][a-z0-9-]{0,39}`), default `plug` |
| `api` | no | Plugin API version; 1 (legacy) or 2 (current). Format 2 defaults to 2 |
| `engines.agentsys` | no | Semver range checked against the client version; default `>=0.3.0` |
| `capabilities` | no | Up to 50 capability names; absent means read-only |
| `dependencies` | no | Up to 20 plugin ids mapped to semver ranges |
| `author`, `license`, `homepage` | no | Metadata only; homepage is displayed as a link |

## Files and modules

- `main` is a relative path, default `main.js`, and must exist in `files`.
- Every path is relative, uses `/`, has no `.`/`..`/empty segment, no drive letter and no backslash.
- Only `.js` and `.json` files are package files. Each is at most 400 KB; the whole package is at most 900 KB.
- Modules use `require('./relative')`; resolution is package-local and appends `.js` when needed. `require` cannot
  leave the package.
- `main.js` is the entry. The loader passes `exports`, `module`, `require`, `api` and `console`.

## Assets

- PNG, JPEG, GIF or WebP only, as a base64 data URI or `{type, data}`.
- At most 24 assets, 200 KB each.
- Available with `api.asset('logo')`; use them in `<img src="...">`. SVG is not accepted as an asset because an image
  SVG can carry script in other contexts; use a built-in icon name instead.
- Plugin HTML may not load a remote image; passive pages cannot beacon to a third party.

## Contributions

`contributes` is declarative server resource deployment. It is validated at install, but **nothing is written to a
server until the user presses “Deploy resources”** on the plugin page.

| Key | Purpose |
|---|---|
| `collections` | Collection definitions. `strategy: "create"` (default) keeps an existing definition; `"update"` replaces it in place and keeps every record. |
| `library` | Script-backed Custom Nodes. `name`, `code`, optional `inputs`, `outputs`, `grants`, `folder`, `icon`, `description`. |
| `workflows` | Project/workflow templates and the Library nodes to place. `run` defaults to true and adds a native Event trigger. |

A deployment never deletes records, user nodes or projects. Redeploying the same version makes no duplicates; a new
version updates the plugin's own Library nodes in place. See [plugin-library.md](plugin-library.md).

## Capability names

`graph.read`, `graph.write`, `library.read`, `library.write`, `collections.read`, `collections.write`, `run.read`,
`run.start`, `notifications.read`, `notifications.write`, `settings.read`, `settings.write`, `secrets.use:<name>` and
`net.fetch:<host>` (a `*` may appear in the host pattern). See [plugin-capabilities.md](plugin-capabilities.md).

## Legacy format 1

```json
{"id": "hello", "title": "Hello", "version": "1.0.0", "api": 1, "capabilities": ["graph.read"],
 "source": "exports.activate = api => api.ui.toast('Hello');"}
```

It is read as a package with `main: "plugin.js"`, no modules and no contributions. The browser writes it back as
format 2 on the next save or export. New packages should use format 2.

## Compatibility rules

- An unknown or higher `api` is refused (`incompatible_protocol`), not guessed.
- An unmet `engines.agentsys` range is refused at install.
- A required dependency must be installed and enabled; a disabled dependency stops its dependants at activation.
- Dependency cycles are reported and the involved plugins are not started.
- A version older than the installed one needs an explicit downgrade in the store API; the normal UI update path
  refuses it.
