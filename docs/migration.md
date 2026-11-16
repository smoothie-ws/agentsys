# MVP compatibility changes

The supported Client/Server protocol is 2. Update both sides together. The combined root server, raw storage
routes and server-side UI-state routes are removed. Use the independent CLI launchers documented in README.

Plugin API 2 and package format 2 are the supported plugin contracts. Rebuild older source projects with
`tools/plugin-pack.js`; unsupported installed records do not activate. Reading the browser store does not
delete their private data. Back up browser data before replacing packages. Modern onUpdate/migrate lifecycle
hooks remain available and retain per-plugin data versions.

Current workflows, Library graphs, Collections, secrets, canonical JSON and sidecars retain their formats.
Take a stopped-server backup with `tools/backup.js` before updating. This cleanup does not rewrite user files.
Old server-plugin folders are ignored and never executed. The former server-plugin migrator is available only
in Git at baseline `6d9d623e6cd19db726be293ec03e0e5962183d3d`; it is not a supported current command.
