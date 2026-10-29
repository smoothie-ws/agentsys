# Limits

Every limit in the system, and whether a person can see and change it in the UI. Nothing should limit a person without being listed here; a *fixed* limit is a safety bound of the engine, not a policy.

## Changeable in the UI

| What | Default | Where |
|---|---|---|
| Undo steps per workflow | 50 (0–500) | Settings → Editing |
| Developer mode (hand-made Custom Nodes) | off | Settings → Editing |
| Retries (`max_attempts`), `backoff_ms`, `pause_after`, `dedupe_ms`, `pending_limit`, bridge quotas | 3, 1 s, 5, 1 day, 1000, none | Runs → Workflows |
| Finished runs / summaries kept, their age; run lifetime; replay data retention and size; checkpoints; events; bridge calls per run; event dedupe window; state value / total size / keys; queue item / total size (18 values) | see `LIMITS` in `js/backend/settings.js` | Runs → Run limits |
| Queue `limit`, `visibility_ms`, `overflow` | 1000, 30 s, fail | API only (`PUT workflows/{id}/queues/{name}`) |
| Trigger interval, `max_concurrency`, `overlap` | 10 s – 30 days, 1–16 | API only (`/api/triggers`) |
| Project permission allow list | `graph.read` | Canvas → Workflow settings → Permissions (applies to all workflows in the project) |

The single source of the defaults of the Run limits is the `LIMITS` table in `js/backend/settings.js`; `GET settings` returns it with the defaults, and the Runs page is drawn from it.

## Fixed (engine bounds)

| What | Value | Where |
|---|---|---|
| Code time of a Script between `emit`s (waiting in `emit` or `wait` not counted) | 120 s (+ 2 s watchdog grace) | `SCRIPT_TIMEOUT`, `scripts.js` |
| Scripts running at once in one run | 16 | `MAX_PARALLEL` |
| Active runs | 16 (429 beyond) | `MAX_ACTIVE_RUNS` |
| Signals following each other / nodes waiting for each other | 1000 | `MAX_CHAIN` |
| Roots of one evaluation | 200 | `MAX_ROOTS` |
| Result of one node (JSON) / all results of one run | 20 000 000 chars / 100 000 000 bytes | `MAX_RESULT`, `MAX_RUN_BYTES` |
| `display()` text / image data URL | 100 000 / ≈ 3 000 000 chars | `MAX_DISPLAY`, `MAX_DISPLAY_IMAGE` |
| Saved last run of a workflow | 20 000 000 chars | `MAX_LAST_RUN` |
| Nodes per workflow | 1000 | `editor.js`, import |
| Ports per node direction; widgets per node; one widget value | 256; 100; 1 000 000 chars | `schema.js` |
| Config of one Custom node / its definition | 400 000 chars | `CUSTOM_CONFIG_LIMIT` |
| A Custom Node in the Library | 4 000 000 chars; description 2000; group name 200 | `resources.js` |
| Types per document / fields / option count / text | 256 / 32 / 64 / 10 000 | `types.js` |
| Saved themes | 100 | `settings.js` |
| Triggers | 100 | `MAX_TRIGGERS` |
| Webhook body / API body / browser storage write | 64 KB / 20 MB / 200 MB | `server.js` |
| Operations in one batch | 200 | `routes-workflow.js` |
| State key length; queues per workflow; queue journal compaction; CAS retries | 100; 100; every 256 operations; 256 | `routes-state.js`, `queues.js` |
| Waiting hooks / hook log | 100 / 200 | `runtime.js` |
| Spare Workers started ahead | 2 (1 s busy, 10 s idle) | `scripts.js` |
| Dedupe indexes | 10 000 live keys | `routes-runs.js` |

## Behaviours that are not limits but are imposed

- A Script that does not call `emit` fires nothing; `return` is not used.
- A signal reaching a running Script starts another execution at once.
- On resume a Script restarts from its beginning (at-least-once).
- Code that arrives through a wire gets only read grants; code written by a Script loses its grants.
- Custom Node editing is gated by Developer mode.
- Redirects in `net` are refused.
- The server notices files edited on disk within 1 s when a page is open, ≈ 5 s otherwise.

## Notifications

| Limit | Value | Where |
|---|---|---|
| Notifications kept | 200 (title 200, text 2000 characters) | `NOTIFICATION` in `routes-notifications.js` |

## Plugins

| Limit | Value | Where |
|---|---|---|
| Files per package / bytes per file / per package | 200 / 2 MB / 8 MB | `PLUGIN` in `plugins.js` |
| Plugin data | 2 MB total, 500 KB per value, 500 keys | `PLUGIN` |
| Endpoint time / at once / result | 30 s / 4 / 1 MB | `PLUGIN` |
| Activity log | 100 entries per plugin, in memory | `PLUGIN` |
| Plugin API version | 1 | `PLUGIN_API` |
