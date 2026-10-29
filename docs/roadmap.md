# Roadmap

Status of the core: signal engine, live plan, durable waits, state and queues, supervision, human intervention, permissions, versions and replay are done (see [Runtime](runtime.md)). The next stage is **extensibility**: everything AI-, team- or service-specific becomes a plugin, and the core stays small ([Decisions](decisions.md)).

## 1. Plugins: done

The plugin infrastructure exists: packages, install/enable/disable/remove, grants, Library nodes, templates, pages, tiles, commands, endpoints, settings, private data and a sandboxed UI ([Plugins](plugins.md)). Still open: plugin **secrets page** (today `PUT secrets/{name}` and the Secrets block of a plugin's page), **triggers contributed by plugins** (a plugin starts work through a workflow with an interval or queue trigger), install from a URL, signed packages, a plugin gallery.

## 2. AI Controller (plugin)

What was removed from the core returns here as a plugin: model providers and a call node, skills, Initiative/approvals as nodes over `node.wait`, budgets over bridge quotas, trace of agent decisions. Providers and skills become pages of the plugin; the LLM call is a Library node (`agentsys('POST','net',…)` with `secrets.use`, usage reported as `usage.units` so quotas apply). Agent supervision uses what the core has: pause, replace output, replay.

## 3. Assistant chat (plugin)

A chat panel that creates and edits projects and workflows on request. It works only through the batch API with `if_cursor` (so it cannot overwrite a person's edit), proposes a diff before applying, every applied change is a version that can be restored, and it holds only the capabilities granted for the session (`graph.write` for the chosen workspace); code it writes is quarantined by the core. The chat can read run traces to explain failures.

## 4. Integrations (plugins)

Inbound: git webhooks (GitHub/GitLab with HMAC signature check), Discord/Telegram (outbound long polling → queue trigger, so no public URL is needed), Google Docs/Drive (OAuth flow supplied by the plugin; tokens in secrets). Outbound: nodes for the same services. Each is a catalog of Library nodes + optionally a trigger type + secrets. Core support needed: HMAC verification for `hooks/{token}`, per-source rate limits, a secrets page.

## 5. Collaboration (plugin)

The core already has what an optimistic collaborative editor needs: a monotonic `cursor` per workflow, conditional edits (`if_cursor`), atomic batches and change notifications (SSE). The plugin adds presence (cursors, selection), a relay, merge of concurrent edits, comments, and per-user rights. Needed in the core first: **identity** (`context.user`, a user on every edit and version, an authorization hook per route) — today the system is single-user with an optional bearer token.

## Reliability and usability

Ordered by value:

1. **UI for what is API-only today:** triggers (interval/webhook/queue) and queues, secrets (there is no page), workflow `dedupe_ms`/`pending_limit` (now on Runs → Workflows).
2. **Live Runs page** (SSE instead of Refresh), filters (workflow, status, time), failure notifications (desktop, and through plugins Telegram/Discord/email).
3. **Backup and safety:** one-click workspace export/import (zip of the data folder), optional auto-commit of `data/` to git (the text format is diff-friendly), a trash for deleted projects/workflows/nodes, a `data/format` version with explicit migrations.
4. **Health:** `GET /api/health` (scheduler lag, active runs, disk space, last error), a Dashboard status tile, structured log file with rotation, a guard against a full disk.
5. **Dashboard metrics over time:** run counts, failure rate and duration per workflow from run summaries (sparklines), queue depth and state size, quota usage.
6. **Onboarding:** a templates gallery from `examples/` (import in one click), first-run sample project, meaningful empty states.
7. **Safe operation:** dry-run mode that feeds a workflow recorded bridge responses (replay without the original run), a step-through replay debugger in Runs → Trace, a "what would this edit change" diff before restoring versions.
8. **Server hardening:** a Settings page for the API token, rate limits on `/hooks`, HTTPS behind a reverse proxy (documented), a Windows service / Docker recipe next to `start.bat`.
9. **Tests:** run the node and browser suites in CI (the browser suites need Playwright and a fresh data folder per run).
10. **Scaling:** move the journal to a transactional store (SQLite) when the thresholds in [Runtime](runtime.md) are reached; the file layout then stays as an export.
