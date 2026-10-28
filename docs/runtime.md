# Runtime

Durable behaviour of workflows: activations, waiting, state, queues, supervision, human intervention, versions, replay.

## Activations

An activation is a run started by the Run button, the API (`POST projects/{id}/runs`), an interval, a webhook or a queue item. It may suspend with `node.wait`; its checkpoint is separate from workflow state. Signals carry no payload and outputs are local to an activation. **The only way to pass data between activations is `node.state` (or a queue).**

Each run is stored under `runs/<id>/` (record, checkpoint, `events.jsonl`, redacted blobs).

## Durable waiting

```js
if (!node.resumed) await node.wait({event: 'approved', match: {id: 7}});
const answer = node.resumed.value;
```

`wait` takes exactly one of `event` (with optional `match`), `delay` (ms) or `until` (ISO date). It ends the current execution by a control signal (do not swallow it); the Worker is released and the code allowance is not consumed. On resume the Script runs again **from its beginning**: effects before `wait` must be idempotent; `node.runKey` is stable across attempts. Completed siblings are skipped.

A person or another system answers with `POST events/{name}` (body → `node.resumed.value`). `?run_id=&key=` targets one waiting invocation; without them it broadcasts by name and match. `dedupe_key` suppresses repeated delivery.

## State

Each workflow has a JSON key space (`node.state`, `GET/PUT/DELETE workflows/{id}/state/{key}`):

- `get(key)` → `{key, value, version, updated}`, absent → `not_found`
- `set(key, value, {version?})` — compare-and-set when a version is given (version 0 = must be absent)
- `delete(key, {version?})`, `list(prefix?)`
- `update(key, fn)` — retries CAS up to 256 times; `fn` must be free of external effects

Keys: letters, digits, `_ . : -`, ≤ 100 chars. A conflict is HTTP 409. State values stay plain data (a field named `op` is not executable).

## Queues

```js
const q = node.queue('jobs');
await q.push({value: 42});
const [d] = await q.pull({max: 1, visibility_ms: 30000});
if (d) { node.display(d.value); await q.ack(d.id); }
```

Delivery is at-least-once; `d.id` is a **receipt** (an expired one cannot acknowledge a replacement); `item_id` is the stable id (use it or `node.runKey` for idempotency). `PUT workflows/{id}/queues/{name}` sets `limit`, `visibility_ms` and `overflow`: `fail`, `drop_oldest`, `drop_new`, `block` (a scripted push suspends through `node.wait` and restarts when space is freed). Journals are JSON Lines compacted every 256 operations. At most 100 queues per workflow.

## Triggers and supervision

Triggers (`/api/triggers`): `interval` (every 10 s … 30 days; the previous run still going is skipped), `webhook` (`POST /hooks/{token}`), `queue` (`queue`, `max_concurrency` 1–16: the activation owns that delivery; success acknowledges it). `overlap` is `skip`, `queue` or `parallel`.

`GET/PUT workflows/{id}/control`: `status` (`enabled`, `paused`, `disabled`), `max_attempts`, `backoff_ms`, `pause_after`, `dedupe_ms`, `pending_limit`, bridge `quotas`. A failed activation retries with exponential backoff; each attempt is its own run with the same `activation_id`. After `pause_after` consecutive exhausted failures the workflow is paused with reason `consecutive_failures`. Pause blocks new activations and stops execution between nodes; answers received meanwhile are kept. On the canvas, while a run is paused (by its Pause button, the Runs page or its workflow) the nodes that were running show **Paused** with the pause icon; they show Running again after Resume. Cancellation never retries.

## Human intervention (Runs → Trace)

- **Send a payload** to an event wait (validated JSON, targeted by run and invocation).
- **Replace an invocation's output**: `POST runs/{id}/output {invocation, output, signals, wait?}` creates a linked activation (`restarted_from`) that publishes the supplied outputs and fires the chosen signals without running that Script. Works on completed and failed runs. Dependent calls recompute, independent completed ones do not repeat, ancestors resume from their start (their earlier effects can repeat; they keep their `runKey`). Effects already committed stay committed.
- **Cancel a wave**: `POST runs/{id}/waves/cancel {path}` — cooperative; started code finishes, later emits in that wave stop.
- Pause/resume a run; resume a delay/until wait manually (`POST runs/{id}/resume`).

Intervention needs host authority; Scripts cannot acquire it.

## Bridge accounting and journal

Every call a Script makes through `agentsys(...)` is journalled (`bridge_call`: method, path, invocation key, node hash, request/response SHA-256 and sizes, duration, order, errors; bodies are redacted blobs). Quotas are generic units on `METHOD path`, `*` or a prefix ending `*`:

```json
[{"key": "POST net", "limit": 100, "window_ms": 60000, "capacity": 10, "refill_per_second": 2, "reserve_units": 1}]
```

Before a live call the host reserves `reserve_units` (fixed-window quota + token bucket) and settles the actual `usage.units` (default 1) after it. Overrun fails the call and leaves the rule exhausted. `GET workflows/{id}/usage` shows counters.

## Versions

Each save of a workflow or Library node gets a SHA-256 content version, stored once under `versions/content/<hash>`. `GET versions/{workflow|node}/{id}` lists saves, `GET …/{hash}` returns the files, `POST …/{hash}/restore` makes it current. Runs → Versions diffs and restores. Each node start records its executable `node_version`.

## Replay

`POST runs/{id}/replay` re-runs from recorded versions, plan patches, authorization decisions and bridge responses with **no live calls**. Each call is addressed by segment, invocation path and index and must match the trace; parallel responses are released in recorded order; `Date.now()`, `new Date()` and `Math.random()` are recorded. A missing, repeated, changed or unused call fails with `replay_diverged`. Replay is unavailable when trace data has expired (`trace_retention_ms`), a journal limit was hit, or redaction changed a returned value (`replay_redacted`).

## Storage and scaling

Storage is a directory of readable files; one writing process per data directory is supported (several tabs are fine with the server). Consider a transactional database beyond ~10 000 activations/day, 5 GB of run logs, sustained frequent state writes or several writer processes.
