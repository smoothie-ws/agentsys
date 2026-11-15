# Legacy server plugins (never loaded)

The removed server-plugin implementation is available in git history:

- `server-plugin-host.js` — the old host that `require`d `data/plugins/<id>/main.js` into the server process.
- `routes-plugins.js` — the old `/api/plugins/...` routes.

The executable copies have been removed from the checkout. Migration uses `server/migrate.js`, not the old host
or routes. The platform server has no server plugin mechanism, and static serving does
not expose this folder. The user's plugin data and source files are preserved under `data/plugins-migrated/` and
`data/backups/` by `agentsys-server migrate`; they are not executed.

The replacement is a client plugin (sandboxed in the browser) plus ordinary server resources. See
`docs/plugins.md`.
