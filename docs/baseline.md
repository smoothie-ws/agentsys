# Baseline measurements

Taken before the first hardening change, on branch `hardening/12h` at commit
`cafb1e8` (`chore: checkpoint before 12h hardening`). Re-measured with the final
`tools/bench.js` inside a second worktree checked out at the same commit, so the
before and after sides use identical fixtures and method.

- Date: 13 November 2026
- Node: v20.11.0, Windows
- Command: `node tools/bench.js` / `node tools/bench.js --json`
- Test baseline: `npm test` — **230 pass, 0 fail, ~9.2 s**
  (`node_modules/.cache/agentsys/baseline-test.log`)

> The reconnaissance table in `PLAN.md` §1.1 was taken earlier with a different
> fixture and includes the test harness's defensive JSON copy of every result.
> `tools/bench.js` measures the backend call itself, as the editor makes it
> (`Backend.request`, no JSON round trip). Absolute values therefore differ; all
> before/after comparisons in `REPORT.md` use this table.

## Results

| Metric | Baseline |
|---|---:|
| `GET workflow` ×10, 100 nodes | 2.32 ms/read |
| `GET workflow` ×10, 200 nodes | 4.92 ms/read |
| `GET workflow` ×10, 400 nodes | 8.43 ms/read |
| `GET workflow` ×10, 800 nodes | 17.98 ms/read |
| `GET workflow`, 800 nodes in 200 groups | 23.41 ms/read |
| `GET execution` ×50, 800 nodes | 0.025 ms/read |
| Script loop, 5 000 assignments (`context.state` + `node.output`) | 61.6 ms (median of 5) |
| DB commits for that loop | 3 |
| Idle runtimes after 20 workflow visits | 22 (2 already open) |
| Library type lookup, 20 unused ids over 6 workflows | 187 ms |
| `data/` | 48.8 MB, 227 files |
| Hand-written JS (`js/**/*.js` without `builtin-nodes.js`) | 17 830 lines |
| Generated JS (`js/backend/builtin-nodes.js`) | 1 717 lines |
| CSS (`css/*.css`) | 5 902 lines |
| `server.js` + `headless.js` + `plugin-host.js` | 1 123 lines |

Run-to-run variance on this machine is about 5–10 % for the flat graph reads;
the loop is a median of five dispatches, and every median above is the better of
two identical runs.

## How it is measured

`tools/bench.js` builds a fresh in-memory backend and, for each size, a project
whose workflow is a chain of Script nodes (`in` → `out`, nothing executes while
measuring). It performs one warm-up read, then times 10 reads of
`GET projects/{id}/workflow`; the median is reported. The grouped fixture adds
200 groups of four nodes. The runtime read opens one 800-node workflow and times
50 `GET projects/{id}/execution` calls. The loop places a Library node around one
Script that performs 2 500 `context.state.count=i` and 2 500
`node.output.value=i` assignments, dispatches it five times with `wait: true`,
and counts store commits for the last dispatch. Idle runtimes are counted after
opening 20 fresh workflows. The Library type lookup asks for 20 unused ids over
6 workflows (the cleanup path). `data/`, JS and CSS sizes are counted by the
same script.

```bash
node tools/bench.js
node tools/bench.js --json
npm test
```

## Baseline behaviour notes

- `GRAPH_RUNTIMES` grows with every opened workflow and is only removed when the
  workflow is deleted (V1).
- A successful dispatch can leave a stale `errors.host` entry (C1).
- `node_ids` naming a group is accepted and silently answers an empty result (C2).
- A disabled node signalled directly reports the values of an earlier run (C3).
- `new AsyncFunction` is compiled on every Script invocation (V6).
- `context.state` copies the whole state and `node.output` emits an event on
  every assignment (V7).
- `syncRuntimeGraph` compares `JSON.stringify(document)` (V2).
- `instanceScopes` and `buildSnapshot` do repeated linear scans over complex
  nodes and groups (V3/V4).
- `Library.typeInUse` serializes every workflow and resource once per checked type (V12).
