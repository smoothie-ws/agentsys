# Migration from the combined/server-plugin architecture

The old application was one browser program with a local backend and optional server plugins. The new
architecture is a separate server and client. This migration is conservative: it copies, reports and never
deletes user data.

## What changed

| Old | New |
|---|---|
| `server.js` served UI, API, `/__data` and plugin host | `bin/agentsys-server.js` (API only) and `bin/agentsys-client.js` (static UI) |
| Browser loaded the backend and could run graphs | Client loads only the editing model; the server runs graphs |
| UI state in `data/other/ui-state.json` | Browser `localStorage`; optional one-time import |
| `data/plugins/<id>/main.js` executed in the server | Never executed. Client plugins only |
| Plugin routes `/api/plugins/<id>/…` | Removed; use the documented API or a generic collection |
| Fixed `/api` in the browser | Environment transport; any server URL |
| No auth session model | Bearer token and HttpOnly session cookie |

## Before migrating

1. Stop the old server.
2. Copy the whole data folder somewhere safe.
3. Run a preview:

   ```sh
   node bin/agentsys-server.js migrate --data ./data --dry-run
   ```

The preview lists plugins, route dependencies, workflow files that call plugin routes and what would be copied.
It writes nothing.

## Migrating

```sh
node bin/agentsys-server.js migrate --data ./data
```

What it does:

1. Copies `data/plugins`, `settings.json`, `library` and `other/ui-state.json` to
   `data/backups/pre-platform-<timestamp>/` with a manifest.
2. Preserves each plugin's `main.js`, optional `client.js`, README and `data.json` under
   `data/plugins-migrated/<id>/`. The server never executes this folder.
3. Creates the generic collection `providers` when `plugins/ai/data.json` has providers. Each provider becomes
   a record; each API key is stored as a normal server secret (`provider-<id>-api-key`) and the record keeps
   only `{{secret:…}}`.
4. Copies `ui-state.json` to `data/client-migration/ui-state.json` and writes a migration report.
5. Scans workflows, Library resources and scripts for calls to `plugins/…` and reports the files. It does not
   rewrite code: a server route has no general client equivalent.
6. Keeps project ids, workflow ids, node ids, Library ids, types and graph format unchanged.

Running it twice is safe for the provider collection: a record with the same `providerId` is updated instead of
duplicated. The backup and preserved copies remain.

## After migrating

1. Start the server (`node bin/agentsys-server.js start --data ./data`).
2. Start the client (`node bin/agentsys-client.js --server http://127.0.0.1:8080`).
3. Open **Server** and check the connection. For a remote server, add its token.
4. If the old layout matters, use **Server → Import old interface state from this server**.
5. Review `data/client-migration/migration-report.json`.
6. For each warning about `plugins/…` calls, replace the call in the Script with a standard API call
   (`projects/…`, `library/…`, `collections/…`) or recreate the functionality as a workflow.

## What is preserved

- Projects, workflows, graphs, layout, groups and Custom Nodes.
- Library resources, groups, icons, built-in nodes and types.
- Runtime JSON: state, outputs and previews.
- Secrets (metadata and values on disk; reads never return values).
- Project policies and node grants. `plugins.call` is accepted in old graphs but no longer grants a route.
- Plugin sources, raw plugin data and the old UI state in the backup/preserved folders.

## What is not converted automatically

- Arbitrary server plugin routes and lifecycle hooks. A client plugin is not a drop-in replacement.
- Old `client.js` modules. They expect direct page DOM and the old `api.ui` function API; the sandboxed client
  plugin API uses HTML strings and a narrower RPC surface. The file is preserved, and the migration warns.
- An active JavaScript run. Stacks, timers and pending network calls cannot be resumed.
- A workflow calling a removed plugin route: the data is kept, the call fails at run time until it is replaced.

## Recovery

Restore the backup folder:

```sh
rm -rf data/plugins
cp -R data/backups/pre-platform-<timestamp>/plugins data/plugins
cp data/backups/pre-platform-<timestamp>/settings.json data/settings.json
cp data/backups/pre-platform-<timestamp>/ui-state.json data/other/ui-state.json
```

The graph format (`agentsys.text/1`) did not change, so old workflows remain readable by the engine.

## Browser-only data

The old browser-only mode stored keys in IndexedDB when no server answered. There is no automatic export from
an arbitrary browser profile. Export projects and Library nodes from the old editor first (JSON), then import
them through the new client. The new client requires a server; it does not fall back to IndexedDB.
