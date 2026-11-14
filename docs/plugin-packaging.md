# Packaging and distribution

A distributable plugin is one JSON file ending in `.agentsys-plugin.json`. It contains the manifest, the JavaScript
modules, images and declared server resources. AgentSys installs it from a local file chosen by the user; it does not
auto-load remote code.

## Source layout

```
my-plugin/
  plugin.json          manifest fields and contributes
  main.js              entry (or the file named by "main")
  lib/
    view.js            required as require('./lib/view')
  assets/
    logo.png           becomes api.asset('logo')
  README.md            not packaged
```

`plugin.json`:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "description": "Notes and a custom view.",
  "icon": "database",
  "api": 2,
  "engines": {"agentsys": ">=0.3.0 <1.0.0"},
  "capabilities": ["collections.read", "collections.write"],
  "author": "Example",
  "license": "MIT",
  "main": "main.js",
  "contributes": {
    "collections": [{"name": "notes", "title": "Notes", "schema": {"type": "object"}}]
  }
}
```

## Build

```bash
node tools/plugin-pack.js my-plugin
# or
npm run plugin:pack -- my-plugin
# writes my-plugin/com.example.notes-1.0.0.agentsys-plugin.json
```

Options:

| Command | Effect |
|---|---|
| `node tools/plugin-pack.js <dir> [--out <file>]` | Build one package |
| `node tools/plugin-pack.js --check <dir>` | Validate the source without writing |
| `node tools/plugin-pack.js --validate <file>` | Validate a built package and report checksum state |
| `node tools/plugin-pack.js --all <dir>` | Build every directory that has a `plugin.json` |

The builder:

- collects `.js` and `.json` files except `plugin.json` and built packages;
- puts `main` in `files`, so `require('./main')` and a re-export work;
- base64-encodes PNG/JPEG/GIF/WebP files under `assets/`;
- copies `contributes`;
- runs the same `PluginManifest.normalizePackage` validation as the client;
- writes a format 2 package and an FNV-1a checksum.

## Package

```json
{
  "format": 2,
  "manifest": {"id": "...", "name": "...", "version": "...", "api": 2, "...": "..."},
  "main": "main.js",
  "files": {"main.js": "...", "lib/view.js": "..."},
  "assets": {"logo": "data:image/png;base64,..."},
  "contributes": {"collections": [], "library": [], "workflows": []},
  "checksum": "fnv1a-..."
}
```

The checksum detects an accidental local edit. It is **not** a cryptographic signature and does not prove who built
the package. There is no marketplace and no URL installer in this cycle.

## Install and update

1. Open the **Plugins** page and choose **Install plugin…** from its **⋯** menu.
2. Write the form for a first experiment, or choose **Import JSON file…** and pick a `.agentsys-plugin.json`.
3. A package with the same id and a newer semantic version updates in place from the plugin page
   (**Update from file…**). It keeps the enabled state and private data, runs `onUpdate`/`migrate`, and rolls back on a
   start failure.
4. **Export package** produces the same format with the current modules and contributions, ready to send to another
   user.

Installing never writes to a server. **Deploy resources** on the plugin page is the separate server action.

## Versioning

- Use semantic versions. `1.0.1` may be installed over `1.0.0`; a lower version is refused by the normal path.
- Bump the version whenever behaviour, modules, assets or `contributes` change; the deployment record uses it to decide
  whether its nodes need an update.
- Keep the id stable. A new id is a new plugin with new storage and a new deployment.
- Declare compatible AgentSys versions with `engines.agentsys`. A package outside the range is refused before any
  code runs.

## Dependencies

```json
"dependencies": {"core-tools": "^1.0.0"}
```

The dependency must be installed and enabled before this plugin activates. Dependencies are ordering and availability
contracts, not shared memory: a plugin still cannot call another plugin's commands or read its storage. Use a
Generic Collection or Library node to share data through the server.

## Distribution checklist

- [ ] `node tools/plugin-pack.js --validate <package>` reports valid and checksum matches.
- [ ] A fresh browser installs the package without a server write.
- [ ] The manifest lists every capability the code uses, and no more.
- [ ] Secrets are referenced as `{{secret:name}}`, never embedded.
- [ ] `contributes.library` code runs without the plugin after deployment.
- [ ] A second installation on another server creates independent resources.
- [ ] The package contains no absolute paths, external imports or server modules.
- [ ] The README states what the plugin writes and how to remove it.
