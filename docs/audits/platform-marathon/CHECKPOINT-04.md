# CHECKPOINT-04 — Multi-client and environment concurrency

Written 2026-11-14T15:23+10:00.

## 1. What was investigated

`Backend.request` and its `exclusive` queue, the `if_cursor`/`If-Match` path, the SSE broadcast, the execution
routes (`unlocked`), the client's generation counter, `setActive`, `remove`, `signOut`, the event stream and its
reconnect.

## 2. Hypotheses checked

- Two edits with the same cursor apply one after the other: **disproved** — the second gets 409 with a code and
  the document advanced once. Exactly one write applies.
- Without If-Match two concurrent edits lose one: **disproved** — requests are serialised per process, both
  apply, and the cursor advances twice. A lost update needs a second process, which the lock now prevents.
- Two SSE clients get the same change: **confirmed**. A second server gets nothing.
- One client stopping a run is visible to the other: **confirmed**, and the stopped work does not finish later.
- A client that vanishes mid-run does not stop it: **confirmed**.
- Rapid environment switching can leave another server's status/meta: **reproduced**. Each connect now owns the
  state only while it is the current generation, and `setActive` no longer skips a switch that is in flight.
- Switching aborts in-flight requests: **disproved** — the controller was declared and never assigned. Fixed.

## 3. Defects reproduced

Stale meta/status after rapid switching; a removed active environment keeping its stream open; no request abort.

## 4. Fixes

Per-generation `AbortController`, meta/status guarded by the attempt's generation, `remove()` starts a new
generation and reconnects, `signOut()` cancels the stream and clears meta, `switching` guards the early return.

## 5. Tests

`tests/concurrency.test.js` 5/5; `tests/environments.test.js` 11/11 (rapid switching, reconnect with backoff,
no mutation replay, token confinement, 401 renewal once, stale answers rejected).

## 6. Results

Two servers are isolated on the wire, in events and in the client. Conflicts are explicit. A switch is a hard
boundary: old answers carry an older generation and are discarded; their requests are aborted.

## 7. Next

The graph engine, for regressions the existing 30 execution tests might miss.
