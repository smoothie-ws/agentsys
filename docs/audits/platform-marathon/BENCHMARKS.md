# Benchmarks — measured, with the machine named

Measured with `node --expose-gc tools/stress.js --json` on 2026-11-14T05:29:54Z (15:29 local), Windows 11,
Node v20.11.0, win32. One run; the tool exists so a later cycle can repeat it on the same machine. There is no
pre-refactor measurement of these scenarios to compare with: the previous architecture served a different API
and had no equivalent harness. The numbers below are therefore the reference for future runs, and the test
suite's loose bounds (not these numbers) are what guards against regressions.

| Metric | Value |
|---|---|
| Reads: 300 authenticated `GET /api/projects` | median 0.49 ms, p95 1.15 ms, max 2.91 ms; ~1787 reads/s |
| Runs: 40 executions of a two-node workflow (`wait: true`) | median 22.03 ms, p95 24.92 ms, max 78.61 ms; 0 failures |
| Writes: 500 collection records | median 3.73 ms, p95 5.44 ms; ~255 writes/s |
| Collection page (`limit=100&offset=250` of 500) | 1.79 ms |
| Large workflow: 600 nodes saved in 6 batches | 1282 ms end to end |
| The same workflow read whole | median 17.36 ms, p95 23.15 ms |
| Stop 12 running graphs | 8.95 ms; final status `idle`; 0 running runtimes |
| Workers | started 2, terminated 1, exited 1 (no live worker left) |
| Heap (with `--expose-gc`, before → after all scenarios) | 5 MB → 11 MB |
| Storage mode | `files` |

## Interpretation

- The read path is in-memory and cheap; the per-request cost is HTTP plus the serialising queue.
- A run costs about 22 ms even for two nodes: worker startup is not repeated (2 workers for 40 runs), so this is
  the engine's save-and-settle path plus the HTTP round trip. It is the number to watch if it grows.
- A 600-node workflow writes ~1.3 s in batches and reads in ~17 ms. Both are linear in the tested range; the
  Node suite fails if a 600-node read exceeds 3 s or the save 30 s.
- Collection writes rewrite one JSON document per write; 255/s is the expected shape of that design. If a
  workload needs faster appends, that is a schema decision (several records documents), not a leak.
- The heap grows by 6 MB across ~1000 writes and a 600-node graph, and does not grow per run after the workers
  settle. The `idle runtime` eviction and `Stop` paths are covered by `tests/execution.test.js`.

## Resource bounds asserted by tests

`tests/resource.test.js` asserts: 100 read/write pairs with p95 < 250 ms; twelve parallel runs all idle at the
end with no running runtime and at least one worker used; ten closed event streams removed from memory; the
session map capped at its limit with the oldest evicted; a 600-node save under 30 s and read p95 under 3 s; 1000
collection records written under 60 s and a page never wider than 500 records.
