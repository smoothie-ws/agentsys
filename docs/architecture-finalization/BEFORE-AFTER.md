# Before and after

Baseline: `6d9d623`. Final code/package implementation: `113f48a` (canonical contract `0a745c8`, shutdown `a462071`).

| Indicator | Before | After |
|---|---:|---:|
| Handwritten production source lines (same source-metrics scope) | 30,532 | 30,043 |
| Source bytes (LF normalized, generated builtins excluded) | 1,235,217 | 1,212,524 |
| Production modules | 94 | 92 |
| Local CommonJS require edges | 20 | 15 |
| Browser JavaScript (50 manifest scripts, LF normalized bytes) | 648,650 | 646,587 |
| AST functions / branch points | 3,357 / 7,645 | 3,334 / 7,474 |
| Exact repeated-token bytes | 1,802 | 1,802 |
| Browser imports of server implementation | 0 | 0 |
| Server imports of Client UI | 0 | 0 |
| CommonJS import cycles | 0 | 0 |
| HTTP API implementation location | Root combined server, API wrapper | server/api-server.js only |
| Combined execution / raw storage | Present | Removed |
| Plugin package formats / APIs | 1 and 2 | 2 only |
| Server-side UI state routes | 2 | 0 |
| Backend shutdown writer barrier | Absent | Terminal close + queue/hook drain |

This is actual code removal, not movement to excluded directories. The API implementation moved to the canonical
module while combined static/raw-storage paths and the migration implementation were removed. Twelve files were
removed, plus the architecture document was replaced under its requested uppercase name. One API wrapper/
implementation pairing was collapsed and one alternative SSE encoding removed. Eight compatibility mechanisms
were removed: combined hosting, raw storage, old SSE, editor API aliases, server UI-state routes/bootstrap,
server-plugin migration, API 1 acceptance and package format 1 conversion. These are behavior counts, not counts
of AST `if` statements. Shared W and runtime/persistence caches were retained with their existing owners;
no additional mutable state replica was introduced. Source lines alone are not an architectural quality claim.

Server-owned code (backend, server-only model/db, server except static-assets, headless and server CLI;
generated builtins excluded) decreased from 407,473 to 386,876 bytes and 9,408 to 8,962 lines. Generated builtin
definitions are unchanged. CSS and manifest-loaded
interface modules were audited with their dynamic registrations; no unsupported dead-selector inference was used.

Performance measurements use Node v20.17.0, Windows, Chromium 143.0.7499.4, a 1440x1000 viewport and 200-node
graphs. Both revisions use independent API/static Client processes and disposable data with five samples.
Cold API startup (five fresh processes): median 73.26 -> 63.08 ms; RSS 38,658,048 -> 38,498,304 bytes;
heap used 6,715,608 -> 6,690,992 bytes. These are local observations, not deployment guarantees.

Initial same-launcher browser pair: dashboard 228.55 -> 213.90 ms; graph load 591.50 -> 602.20 ms;
layout save 38.50 -> 59.50 ms; plugin lifecycle 58.60 -> 358.50 ms; environment roundtrip 64.20 -> 64.40 ms.
The slower plugin/layout measurements prompted two additional pairs; the initial observation is preserved here.
Raw temporary logs stay under ignored node_modules/.cache/architecture-finalization; compact samples are in
[measurements.json](measurements.json).

Repeated identical browser pair: dashboard 214.72 -> 204.95 ms; graph load 593.40 -> 596.20 ms; layout save
48.50 -> 43.00 ms; plugin lifecycle 46.60 -> 42.10 ms; environment roundtrip 63.90 -> 64.70 ms.
The initial plugin/layout slowdown was not reproducible in this pair; no speculative optimization was made.

Third pair, reversing execution order (current first): dashboard 212.12 -> 215.42 ms; graph load
547.70 -> 536.50 ms; layout save 42.90 -> 36.10 ms; plugin lifecycle 42.30 -> 40.60 ms;
environment roundtrip 64.60 -> 64.30 ms. Selection-colour latency was 740.40 ms on both.
No persistent slowdown was established across the repeated pairs. The first sample of either revision can
show a 300+ ms iframe lifecycle outlier, so these distributions must not be represented by one timing alone.

Two runtime benchmark runs per revision (medians within each run):

| Workload | Before (two runs, ms) | After (two runs, ms) |
|---|---|---|
| 800-node workflow read | 23.825 / 30.164 | 24.095 / 24.657 |
| 800-node runtime read | 0.031 / 0.030 | 0.030 / 0.031 |
| 5,000 state/output assignments | 75.599 / 79.892 | 77.137 / 73.979 |
| 800 nodes / 200 groups read | 30.203 / 42.057 | 30.147 / 34.142 |

All four runs recorded six loop commits and no non-idle runtimes. The engine itself was not rewritten.
The runtime tool's `data/` size field is excluded from comparison because local user data and the clean
baseline checkout differ; no workload uses those files. The first repeat briefly overlapped process tails;
these are local observational ranges, not a formal isolated performance claim.
