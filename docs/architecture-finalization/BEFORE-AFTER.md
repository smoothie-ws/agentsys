# Before and after

Baseline: `6d9d623`. Implementation: `a462071` (following canonical-contract commit `0a745c8`).

| Indicator | Before | After |
|---|---:|---:|
| Handwritten production source lines (same source-metrics scope) | 30,532 | 30,043 |
| Source bytes (LF normalized, generated builtins excluded) | 1,235,217 | 1,212,524 |
| Production modules | 94 | 92 |
| Local CommonJS require edges | 20 | 15 |
| Browser imports of server implementation | 0 | 0 |
| Server imports of Client UI | 0 | 0 |
| CommonJS import cycles | 0 | 0 |
| HTTP API implementation location | Root combined server, API wrapper | server/api-server.js only |
| Combined execution / raw storage | Present | Removed |
| Plugin package formats / APIs | 1 and 2 | 2 only |
| Server-side UI state routes | 2 | 0 |
| Backend shutdown writer barrier | Absent | Terminal close + queue/hook drain |

This is actual code removal, not movement to excluded directories. The API implementation moved to the canonical
module while combined static/raw-storage paths and the migration implementation were removed. Browser payload
and exact before/after measurements are finalized after the repeated benchmark investigation; lower source
line count alone is not an architectural quality claim.

Performance measurements use Node v20.17.0, Windows, Chromium 143.0.7499.4, a 1440x1000 viewport and 200-node
graphs. Both revisions use independent API/static Client processes and disposable data with five samples.
Cold API startup (five fresh processes): median 73.26 -> 63.08 ms; RSS 38,658,048 -> 38,498,304 bytes;
heap used 6,715,608 -> 6,690,992 bytes. These are local observations, not deployment guarantees.

Initial same-launcher browser pair: dashboard 228.55 -> 213.90 ms; graph load 591.50 -> 602.20 ms;
layout save 38.50 -> 59.50 ms; plugin lifecycle 58.60 -> 358.50 ms; environment roundtrip 64.20 -> 64.40 ms.
The slower plugin/layout measurements require repeated investigation before drawing a performance verdict.
Raw temporary logs stay under ignored node_modules/.cache/architecture-finalization.
