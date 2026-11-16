# Decisions

Baseline is `6d9d623e6cd19db726be293ec03e0e5962183d3d`.

1. Replace the API wrapper with the actual implementation in server/api-server.js. Root server.js combined
   static UI, API and raw browser storage; its supported consumers were migrated before removal. Authentication,
   credentials, route dispatch, worker isolation and file store remain the same implementation.
2. Remove `/__data`, its alternate SSE encoding, `/editor` API aliases, server UI-state writes/export and
   combined HTML bootstrap. Preferences are owned by browser storage. Protocol advances from 1 to 2;
   graph text, Library bundle and current disk formats remain unchanged.
3. Remove server/migrate.js, its CLI command and tests of that retired command. Remove only tracked legacy
   plugin sources and legacy README; ignore all data files. No recursive deletion or migration of local data.
4. Remove the one-off simplify-request raw-storage transformer. Its migration-only tests are retired; checked
   HTTP Script behavior remains tested using a standalone program fixture. This consumer was found during
   the first full regression and corrected before committing the removal.
5. Remove obsolete browser-only/server-plugin scenarios. Migrate browser_server, shell/design/execution checks,
   smoke and client benchmarks to the actual separate API and static Client. Preserve static traversal/symlink,
   CSP, authentication, journal recovery and current-data corruption assertions on their supported boundaries.
6. Accept only Plugin API 2 and package format 2. Retain the internal normalized formatVersion 2 storage record
   representation and current per-plugin onUpdate/migrate hooks. Legacy/future packages fail explicitly;
   unreadable installed records do not activate and reads do not delete private data. Modern fixtures replace
   old-format security fixtures so malicious behavior is still exercised. SDK declarations match the contract.
7. Fix current-package export metadata: normalizing an already normalized format 2 record now preserves its
   icon. Regenerate Integration Studio/Graph Developer Tools, five reference packages and the hello example; source, behavior and checksums stay
   unchanged (the checksum does not include the icon). Reproducibility tests assert equality.
8. Give terminal backend shutdown an explicit owner. It blocks new/queued request commits, drains the writer
   queue and hook tasks, stops runtime work, and keeps the data lock until server teardown finishes. Repeated
   close calls share a Promise. Dedicated tests cover an admitted writer, queued write and competing folder owner.
9. Retain Canvas/Inspector W: one active page owns it and has leave guards, timer/subscription cleanup and
   execution-session identity. No separate state store is warranted. Retain runtime snapshots, persistence
   caches and host/server capability checks because their boundaries differ.
10. Retain Collections as an optional independent server API consumed by current plugins; do not add it to the
    interpreter. Retain historical audits as evidence, labeled historical, with original commit provenance.
11. Extend architecture guards for removed executables, sole API composition, supported plugin contracts and
    hash-only navigation. Include refactor branches in CI's push filter and keep the full OS/Node/browser matrix.

Retained current-data transitions are deliberate: browser preference keys consolidate into the existing local
UI store; id-only tab credentials/private plugin storage bind once to their original endpoint before its URL
changes; unversioned current Collection records acquire version 1 for conditional writes; deployed Library
resources without a content baseline refuse automatic overwrite. Removing these paths would lose current
data or weaken endpoint/ownership safety. None reintroduces a legacy execution mode or package parser.

No new product features, dependencies, database, UI framework, interpreter, or AI controller were introduced.
