# Round 3 — measurements

Machine: Windows, Node v20.11.0, same checkout. Numbers are medians from one process unless stated. Absolute
values on this laptop vary by 10–30% between runs; comparisons below either come from one process (the two
microbenchmark pairs) or are reported with that variance, not as a claimed win.

## Baseline at the start of this round (`e52eb4d`)

- `node --test`: 351 tests, 350 pass, 1 skipped.
- Browser: `platform`, `plugin_security`, `editor`, `ux` — 4/4 pass.
- `tools/stress.js --json`: read median 0.54 ms, run median 27.46 ms, record write median 4.64 ms, graph save
  1423.8 ms (600 nodes in batches), graph read median 22.26 ms, Stop 14.02 ms, heap 5→11 MB, 17 open handles.
- `tools/bench.js` did **not** run: it referenced the removed `plugin-host.js`. Repaired in this round.

## After the repair, before the HTTP/storage optimizations

`node tools/bench.js` (first successful run on this branch):

| Metric | Value |
|---|---:|
| GET workflow, 100 nodes | 4.49 ms/read |
| GET workflow, 200 nodes | 9.40 ms/read |
| GET workflow, 400 nodes | 18.82 ms/read |
| GET workflow, 800 nodes | 36.57 ms/read |
| GET workflow, 800 nodes / 200 groups | 46.73 ms/read |
| GET execution, 800 nodes, 50 reads | 0.039 ms/read |
| Script loop, 5 000 assignments | 100.0 ms (5 commits) |
| Library type lookup, 20 ids / 6 workflows | 62 ms |
| Idle runtimes after 20 visits | 16 |

The before/after worktree runs (`git worktree` at `e52eb4d`, same `tools/bench.js`) were alternated three times;
800-node medians were 51.31/38.92/40.32 ms before and 48.81/43.18/44.98 ms after, and the loop and type-lookup
pairs crossed over in both directions. That is within the machine noise; no regression is claimed or observed.

## Microbenchmarks of the two changes (`node tools/perf-round3.js`)

The same 800-node workflow snapshot (335,430 bytes) is serialized with and without the extra realm copy, and a
1,020,000-byte changed document is written with and without the size shortcut:

| Path | Old | New | Saved |
|---|---:|---:|---:|
| HTTP serialization (`JSON.parse(JSON.stringify(x))` + `JSON.stringify` vs one `JSON.stringify`) | 5.854 ms | 1.931 ms | 3.923 ms |
| Storage write (read whole old file vs stat size first) | 5.126 ms | 2.052 ms | 3.074 ms |

Reproduce with:

```sh
node tools/perf-round3.js
node tools/bench.js
node --expose-gc tools/stress.js --json
```

## Stress after the changes (`node --expose-gc tools/stress.js --json`)

40 runs, 300 reads, 500 records, 600 nodes; **0 run failures**:

| Metric | Start of round | Final |
|---|---:|---:|
| Read median | 0.54 ms | 0.53 ms |
| Run median | 27.46 ms | 23.95 ms |
| Record write median | 4.64 ms | 4.23 ms |
| Graph save (600 nodes, batches) | 1423.8 ms | 1446.2 ms |
| Graph read median | 22.26 ms | 14.22 ms |
| Stop | 14.02 ms | 21.33 ms |
| Heap before → after | 5 → 11 MB | 5 → 11 MB |
| Running runtimes after Stop | 0 | 0 |

Both graph figures are within the machine's variance across repeated runs; the final run is reported as measured,
not as an optimization claim.

## Soak (30 s, `--expose-gc`)

300 cycles, 0 errors. Heap 5→11 MB (max 11), RSS 38→69 MB (max 69), request median 4.19 ms / p95 48.5 ms, run
median 48.4 ms / p95 56.6 ms, handles peak `{handles:6,requests:1,resources:9,listeners:3}`, workers 300
started / 300 terminated / 300 exited, 0 running runtimes, 0 live runtimes, 0 sessions, 0 streams after the loop.
A 15-second run earlier reported 93 cycles and the same shape. `tests/soak.test.js` asserts the same bounds on an
8-second bounded run.
