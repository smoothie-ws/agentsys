# State ownership audit

This inventory groups values with the same writer, observer and invalidation rules. Request-local arithmetic,
temporary traversal sets and immutable-by-convention schema/style tables are not additional sources of truth.
The stateful module families below are a semantic inventory, not a count inferred from `new Map` syntax.

| State / module family | Authority and writers | Observers / invalidation / disposal |
|---|---|---|
| Canonical graph/project/Library/policy/secret/collection JSON and sidecars (`server/file-store.js`) | File store; transaction commits and external editors | DB/API/runtime. Redo journal recovery at startup; commits update fingerprints; scans detect external changes |
| Store `changedAt`, directory/stamp maps, `madeDirs`, `scriptRefsCache` | One file-store instance | Scan/commit implementation only. Changed keys invalidate fingerprints/reference caches; instance lifetime |
| DB `cache` (`js/storage/db.js`) | Server-owned cached reads/commits | Contexts. `changed(keys)` deletes entries before announcing external changes; no browser fallback |
| DB `listeners`, `committed`, `announced` | Subscription registration | Backend and HTTP adapter. Returned unsubscribe removes an observer from all sets |
| Context `loaded` entries (`value`, `base`, `json`, `deleted`) | One request/transaction | Call and Editor. Originals detect changes; mutations commit through DB or are discarded on failure; request lifetime |
| `ROUTES`, `EDITS` (`backend/runtime.js`) | Fixed startup manifest | Backend matching, docs and permission classification. No plugin route writer |
| Writer `queue`, request `Call.docs`, edited resource/type sets and hook events | Backend request coordinator | Serializes document commits. Call-local drafts are not authoritative until committed |
| Undo/redo histories | Backend, per client/workflow | Edit API only; per-stack step limit and bounded history count; incompatible edits clear other client stacks |
| `HOOKS.pending`, `log`, `listeners` | Hook coordinator | Diagnostics, hooksIdle and subscribers. Tasks removed on settlement, log bounded, subscriptions explicitly removed |
| `GRAPH_RUNTIMES`, entry task sets, controller, host, outputs/state/displays/errors, revisions (`backend/execution.js`) | One live runtime per workflow | Execution API/SSE and current Script invocations. Live edits synchronize graph view; Stop aborts work; idle eviction and shutdown close Workers; durable JSON saved separately |
| Script host RPC pending calls, Worker state and compiled-body cache (`backend/scripts.js`, `headless.js`) | Host/Worker | Checked Script bridge. Replies settle pending calls; cancellation/close rejects outstanding work. Compiled source cache has its existing bounded policy |
| Interpreter dispatches, read caches, scopes (`model/executor.js`, `evaluate.js`) | Runtime/interpreter | Invocations and awaited branches. Existing dependency invalidation, ownership/join, Pause/Resume and Stop semantics retained |
| Editor `doc`, type tables and snapshot traversal maps (`model/*`) | Call owns mutable document; Editor mutates it | Snapshot/API/interpreter. Pure snapshots and per-TypeTable shape caches are rebuilt from definitions; no browser mutation replica |
| Session/plugin credentials and expiry maps (`server/credentials.js`) | One server instance | HTTP authentication. Revocation, expiry, limits and server close remove credentials |
| HTTP `authFailures`, recent errors, watcher lifecycle (`server.js`) | One HTTP server | Auth/diagnostics. Window expiry/caps and shutdown; watcher serializes scans |
| HTTP `eventClients` | One HTTP subscription owner | Both public SSE encodings. Close, backpressure, failed heartbeat and server shutdown use the same cleanup; no second subscriber collection |
| Environment list, active ID/URL, metadata/status (`app/environments.js`) | Browser-local configuration; active transport | Pages, indicator and API callers. Explicit URL changes/switching create a new generation; saved list and per-tab tokens are separate |
| Environment generation/controller, stream/reconnect timer, switch revision | Environment transport | In-flight requests/subscribers. Switching aborts old work, closes stream and rejects stale replies; retry/backoff owned here |
| Environment `pluginTokens`, `pluginTokenRequests` | Transport, indexed by environment/owner/capabilities | Sandbox request adapter. Concurrent acquisition joins; expiry/refresh, disposal and generation change revoke at the issuing URL |
| Environment change/hook/status listeners, before/after-switch hooks | Registered client owners | Explicit unsubscribe functions; page-owned subscriptions disposed on navigation |
| `store.values`, legacy migration keys and persist timer (`app/helpers.js`) | Browser-local UI preferences | Tabs, navigation, appearance and editors. One coalescing write timer; synchronous state assignment; no redundant promise queue |
| `app` preferences/projects/resources/session projections | Bootstrap/loaders | Pages/navigation. Server data is cached projection; SSE reloads and environment changes clear it. No persistence authority in these arrays |
| Installed packages and `loaded` records (`app/plugin-store.js`) | Browser localStorage | Host/pages. Reads validate/migrate records, writes persist; public copies do not expose mutable storage authority |
| Plugin-private and deployment values | Per plugin and active environment storage keys | Plugin/host respectively. Reserved host keys remain inaccessible to sandbox; uninstall clears all owner scopes |
| Live sandboxes, `errors`, explicit sidebar/toolbar/menu/command/style entries (`app/extensions.js`) | Extension host | Plugin UI/actions. One error map determines failure. Disable/uninstall/crash removes owner registrations, styles and sandbox; reload serializes lifecycle |
| Rendered view `entries` (`app/plugin-views.js`) | One registry | Page, section and navigation projections. Removing an owner removes all projections. Returned metadata objects cannot mutate registry state |
| Sandbox ready/invocation promises, timeouts, request AbortController and scoped token reference | One PluginSandbox | Host RPC. Startup/invocation/lifecycle deadlines; disposal aborts requests, revokes credential, settles dialog, rejects pending invocations and removes frame/listeners |
| Plugin-side module cache, handler/change-listener/pending maps (`app/plugin-frame.js`) | Isolated iframe program | Only its own SDK. Module failure removes failed cache entry; shutdown aborts signal; frame destruction ends the realm |
| Tabs/items/pages, `seen`, runtime projections and tab polling timer (`app/tabs.js`) | Client navigation | Tab strip/router. Closed tabs prune associated state; environment reset clears server-specific state; runtime state is a cached server projection |
| `W.snapshot`, `nodes`, `groups`, `complex`, types/policy/history (`canvas/page.js`, `data.js`) | Current canvas, derived from API reads | Canvas and Inspector. Rebuilt on accepted reload; generation/route checks reject stale answers. Redundant `W.nodeMap` removed: binding lookup uses the existing `W.nodes` index |
| W selection, edges, gesture/pointer, tool, camera and pending inline edits | Current canvas interactions | Rendering and Inspector. Gestures end/release capture; page leave flushes edits, cancels timers and unsubscribes; camera/preferences are client-owned |
| W execution session/starts, statuses/results/state/revision, glow timers | Current page's runtime observer (`canvas/run.js`) | Controls/renderer/tabs. Session and command revisions reject old answers; page leave unfollows, clears timers; server runtime remains authoritative |
| W DOM/position/socket/frame/wire indexes, WeakMap signatures and inner-node caches, minimap/scene revisions | Renderer/current canvas | Rendering/hit tests. Reconcile only changed geometry; snapshot/page replacement invalidates derived caches; detached elements and obsolete sockets removed |
| Inspector current form/pending saves/connection jobs (`inspector/inspector.js`) | Current selection/form | Selection navigation and canvas leave. Shared port handler changes the same form draft; leave/flush waits for pending writes; no separate durable graph model |
| Form `saved`, `chain`, `inflight`, debounce timer (`app/dialogs.js`) | One autosave form | Status, leave guard and unload warning. Captured edits serialize writes; in-flight state remains dirty; errors remain visible until corrected/discarded |
| Router revision, leave guards, page save/dispose callback (`app/router.js`) | Router/current page | Shell/navigation. Older renders cannot replace newer ones; leave guards can veto navigation/environment switching; old page disposes subscriptions |
| Navigation open branches, projectTree cache, shown target and animation frames (`app/nav.js`) | Navigation | Subnav/seam rendering. API/SSE refresh cache; environment reset clears it; animation frames are bounded by active transition |
| Appearance projections (`graphStyle`, theme/preferences) and `TYPE_COLORS` | Appearance/type UI (`app/preferences.js`, `type-ui.js`) | Renderer, controls and minimap. Recomputed from preferences/current type definitions; no server write authority |
| Shell connection-status projection, layout/resizer state | Shell/current browser document (`app/shell.js`) | Status indicator and panel layout. Environment observations update status; drags end/release capture; saved dimensions use the UI store |
| Notifications, popups, color/type/code editor observers, mobile panel/gesture state | Their UI component owners (`app/*`) | Corresponding controls. Close/blur/unmount/gesture end manages transient handlers; document-level delegation persists for the tab lifetime. Server notification records remain authoritative |

Removed mutable collections: five rendered-view registries, the duplicate failure set, one SSE subscriber
collection and the duplicate canvas node index: **eight**. UI preference scheduling also loses one promise-chain
value. These are distinct from necessary derived indexes such as sockets, group membership and type shapes.

The audit retains two explicit cross-owner boundaries: server data changes invalidate client projections through
Environment, and a page owns its subscriptions/form flushes. It does not introduce a global state framework.
