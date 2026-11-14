# Legacy server plugins (never loaded)

These two files are the removed server-plugin implementation, kept as a reference for migration:

- `server-plugin-host.js` — the old host that `require`d `data/plugins/<id>/main.js` into the server process.
- `routes-plugins.js` — the old `/api/plugins/...` routes.

Nothing in `server/manifest.js` loads them. The platform server has no plugin mechanism, and static serving does
not expose this folder. The user's plugin data and source files are preserved under `data/plugins-migrated/` and
`data/backups/` by `agentsys-server migrate`; they are not executed.

The replacement is a client plugin (sandboxed in the browser) plus ordinary server resources. See
`docs/plugins.md`.
