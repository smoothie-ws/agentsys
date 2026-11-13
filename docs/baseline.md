# Baseline measurements

Taken before the first hardening change, on branch `hardening/12h` at commit
`cafb1e8` (`chore: checkpoint before 12h hardening`).

- Date: 13 November 2026
- Node: v20.11.0, Windows
- Command: `node tools/bench.js --json`
- Raw log: `node_modules/.cache/agentsys/baseline-bench.json` (not committed)
- Test baseline: `npm test` — **230 pass, 0 fail, ~9.2 s**
  (`node_modules/.cache/agentsys/baseline-test.log`)

> These numbers are from this machine. The reconnaissance table in `PLAN.md` §1.1
> was taken earlier on the same repository but with a different graph fixture, so
> absolute values differ. Every before/after comparison in `REPORT.md` uses the
> same `tools/bench.js` fixture and this table as the "before" side.

## Results

| Metric | Baseline |
|---|---:|
| `GET workflow` ×10, 100 nodes | 30.1 ms (3.01 ms/read) |
| `GET workflow` ×10, 200 nodes | 53.7 ms (5.37 ms/read) |
| `GET workflow` ×10, 400 nodes | 108.9 ms (10.89 ms/read) |
| `GET workflow` ×10, 800 nodes | 217.6 ms (21.76 ms/read) |
| `GET execution` ×50, 800 nodes | 1.04 ms (0.02 ms/read) |
| Script loop, 5 000 assignments (`context.state` + `node.output`) | 70.9 ms |
| DB commits for that loop | 5 |
| Idle runtimes after 20 workflow visits | 22 (2 already open) |
| `data/` | 48.8 MB, 227 files |
| Hand-written JS (`js/**/*.js` without `builtin-nodes.js`) | 17 830 lines |
| Generated JS (`js/backend/builtin-nodes.js`) | 1 717 lines |
| CSS (`css/*.css`) | 5 902 lines |
| `server.js` + `headless.js` + `plugin-host.js` | 1 123 lines |

## How it is measured

`tools/bench.js` builds a fresh in-memory backend and, for each size, a project
whose workflow is a chain of Script nodes (`in` → `out`, nothing executes while
measuring). It performs one warm-up read, then times 10 reads of
`GET projects/{id}/workflow`. The runtime read opens one 800-node workflow and
times 50 `GET projects/{id}/execution` calls. The loop places a Library node
around one Script that performs 2 500 `context.state.count=i` and 2 500
`node.output.value=i` assignments, dispatches it with `wait: true`, and counts
store commits. Idle runtimes are counted after opening 20 fresh workflows.
`data/`, JS and CSS sizes are counted by the same script.

```bash
node tools/bench.js
node tools/bench.js --json
npm test
```

Static counts (for the size targets):

```bash
# hand-written JS, excluding the generated catalog
Get-ChildItem js -Recurse -Filter *.js |
  Where-Object { $_.Name -ne 'builtin-nodes.js' } |
  Get-Content | Measure-Object -Line
# CSS
Get-ChildItem css -Filter *.css | Get-Content | Measure-Object -Line
# tests
Get-ChildItem tests -Filter *.test.js | Get-Content | Measure-Object -Line
```

## Baseline behaviour notes

- `GRAPH_RUNTIMES` grows with every opened workflow and is only removed when the
  workflow is deleted (V1).
- A successful dispatch can leave a stale `errors.host` entry (C1).
- `node_ids` naming a group or a non-executable node is accepted by
  `checkRoots` (C2).
- `new AsyncFunction` is compiled on every Script invocation (V6).
- `context.state` copies the whole state and `node.output` emits an event on
  every assignment (V7).
- `syncRuntimeGraph` compares `JSON.stringify(document)` (V2).
- `instanceScopes` and `buildSnapshot` do repeated linear scans over complex
  nodes and groups (V3/V4).
