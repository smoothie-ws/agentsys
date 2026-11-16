# Storage

The Server owns current data below `--data`; Client UI preferences and installed plugins stay in browser storage.
`js/storage/db.js` supplies Context reads and commits. `js/backend/runtime.js` serializes API writers, and
`server/file-store.js` is the canonical disk-write path. Collections are a separate optional API, not an interpreter dependency.

Graph definitions use `agentsys.text/1`. Script text and layout may be stored as sidecars referenced by the
canonical JSON. Runtime state/outputs/previews live in workflow runtime files and do not duplicate definitions.
Secrets are separate files and reads report presence without returning values.

A multi-key commit writes a redo journal and atomically renames temporary files. Startup replays a pending
record once; invalid or impossible records are quarantined for diagnosis. Corrupt data fails the affected read
without crashing unrelated API families. Fingerprints invalidate caches after external graph, layout or Script edits.
The folder lock prevents independent processes from overwriting each other's cached documents. Shutdown
keeps that lock until request writers, hooks, runtime cleanup and connections finish.

Back up a stopped data folder using [Deployment](deployment.md). This cleanup makes no current storage-format
change and never automatically deletes user data. See storage-integrity, server, backup and concurrency tests.
