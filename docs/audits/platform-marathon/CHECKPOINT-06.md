# CHECKPOINT-06 — Long-running runtime and resource stability

Written 2026-11-14T15:35+10:00.

## 1. What was investigated

Repeated runs, parallel runs and Stop, event-stream bookkeeping, the session map, large workflows, large
collections, timers and handles. A reproducible benchmark was written (`tools/stress.js`).

## 2. Hypotheses checked

- Work under parallel runs settles and leaves no running runtime: **confirmed** (12 runs, Stop in the middle,
  final status idle, `diagnostics.runtime.running === 0`).
- Closed SSE streams are forgotten: **confirmed**, ten closed streams leave `clients: 0`.
- The session map is bounded: it was **not**; a cap was added and the oldest session is evicted (test with a
  limit of three).
- A 600-node workflow saves and reads in linear time: **confirmed**, 1.28 s save, ~17 ms read.
- 1000 collection records paginate and stay responsive: **confirmed**, page capped at 500 records.
- Heap grows per run: **not observed**; 5 MB → 11 MB across ~1000 writes and the large graph, with workers
  settled.

## 3. Defects reproduced

Unbounded session growth (fixed); no other leak or hang was found.

## 4. Fixes

`sessionLimit` (default 10 000) with oldest-first eviction, swept on login and by an unref'd timer; a test asserts
the eviction. `tools/stress.js` added for repeatable measurements.

## 5. Tests

`tests/resource.test.js` 6/6; `node --expose-gc tools/stress.js` run recorded in `BENCHMARKS.md`.

## 6. Results

Measured: reads p95 1.15 ms; a two-node run median 22 ms; collection writes ~255/s; 600-node save 1.28 s, read
p95 23 ms; Stop of 12 runs 9 ms. Bounds in the suite are loose enough for a slow machine and tight enough to
catch a quadratic path or a leak.

## 7. Next

Interface checks at real sizes and the states a person actually meets.
