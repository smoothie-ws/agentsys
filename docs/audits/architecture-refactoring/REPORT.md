# AgentSys architectural refactoring

Date: 15 November 2026. Branch: `refactor/architecture-simplification`.
Baseline: `ba4bca8`, preserving the previously uncommitted MVP hardening work. Implementation checkpoints:
`558dcdb`, `1201720`, `892fbbc`, `2197e4c` and `aac80ce`, including geometry, lifecycle, canvas state, transport and dead-helper cleanup.

## A. Architecture and implementation

The starting platform already had separate client/server launchers, a single environment transport, a fixed
server manifest, durable file storage and hardened Worker/plugin boundaries. Replacing those mechanisms would
have repeated the previous cycle. The structural audit instead found unnecessary browser dependencies,
overlapping plugin state and repeated registration, form and subscription infrastructure.

The client now loads only graph reading contracts and type compatibility from the model. It cannot load or be
served the mutation editor, schema validation, snapshot/document construction, execution-view builder or
interpreter. All edits continue through the existing API. This removes five implementation files from the
browser's dependency set without removing their functionality from the server.

Rendered plugin contributions now have one authoritative registration list. Pages, Library sections, resource
views and navigation are projections of that list. Six repeated registration paths share validation, invocation
and owner-scoped passive rendering. The isolated iframe SDK program has one document-generation interface;
it cannot capture host lifecycle state. Host rendering shares section/error handling; its unused generic DOM
builder was removed. The duplicate failure set and redundant live-plugin wrapper were removed.

The server has one SSE subscriber map and one cleanup/backpressure path for both supported encodings. The
Inspector has one port add/remove/reorder handler for its three editing contexts. Canvas value edits share
one request/reload lifecycle. Wire paths, hit-test samples and page previews share pure geometry with explicit
appearance input. UI preference writes no longer queue promises around synchronous state updates. The API
facade no longer JSON-clones a body before the transport serializes it. The transport retains its encoded
payload across a clean-401 renewal, so a caller's later mutation cannot change the retried operation.

The subsystem responsibility/dependency inventory and priorities are in [WORKLOG.md](WORKLOG.md).
The state/lifetime/invalidation inventory is in [STATE.md](STATE.md). Binding lookup now uses the existing
canvas node index; the redundant `W.nodeMap` and its rebuild path were removed.
No new framework, runtime package, server plugin mechanism, execution quota or AI behavior was introduced.

## B. Measurements and their limits

Reproduce source counts with `node tools/source-metrics.js [--ref ba4bca8]`, and structural indicators with
`node --expose-internals tools/architecture-metrics.js [--ref ba4bca8]`. Full per-file inventories:
[before](metrics-before.json), [after](metrics-after.json),
[architecture before](architecture-before.json), [architecture after](architecture-after.json).

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Active handwritten application source lines | 30,667 | 30,357 | -310 (-1.01%) |
| Active source bytes, normalized LF | 1,233,101 | 1,221,664 | -11,437 |
| Active source files (JS/CSS/HTML) | 90 | 94 | +4 |
| Largest source module, lines | 1,414 | 1,383 | -31 |
| Browser dependencies on mutation/construction/execution implementation files | 5 | 0 | -5 |
| Browser JavaScript bytes, normalized LF | 760,529 | 638,671 | -121,858 (-16.02%) |
| Browser script files | 51 | 50 | -1 |
| Relative CommonJS edges | 20 | 20 | 0 |
| CommonJS cycles | 0 | 0 | 0 |
| Exact duplicated token-range bytes | 5,366 | 1,802 | -3,564 (-66.42%) |
| AST function nodes | 3,319 | 3,327 | +8 |
| AST branch points | 7,599 | 7,522 | -77 |
| Application API paths / method operations | 67 / 92 | 67 / 92 | 0 |
| Plugin SDK declaration content | same SHA-256 | same SHA-256 | unchanged |
| Rendered-view mutable registries | 6 | 1 | -5 |
| Failure collections | 2 | 1 | -1 |
| SSE subscriber collections | 2 | 1 | -1 |
| Canvas node indexes | 2 | 1 | -1 |

The file-count increase buys explicit independent ownership and reusable pure geometry; it is not counted as
a simplification in itself. The function count increases because small boundaries replace larger mixed
responsibilities. No application code was moved into excluded tools, tests, data or generated catalogs.

Source counts include comments and blank lines. The existing exclusions remain: tests, tools, dependencies,
SDK declarations, user data and generated `builtin-nodes.js`. Retired code remains separately reported.
Duplication is the union of both copies of exact 40-token windows covering at least five lines and 160
characters, including literal values. It does not detect semantic clones or measure iframe source embedded
inside strings as independent JavaScript. Branch counts include conditions, loops, logical expressions,
switch cases and catches; they are not formal cyclomatic complexity. CommonJS cycle checks do not prove
the classic-script global call graph acyclic.

**Total source contraction is modest. This is not a radical total-line reduction.** The substantial verified
changes are the removal of unused browser implementation, repeated registration machinery and eight mutable
collections. The baseline had only 5,366 bytes in the measured exact clone ranges. Removing all such ranges
could not by itself remove thousands of source lines. The CSS audit found one overwritten same-selector
declaration, rather than a large obsolete override layer. The remaining large modules implement distinct
document invariants, controls, interaction modes and rendering behavior described in section I. No claim is
made that they are optimal; compressing their syntax or replacing them with a general form/framework engine
would not demonstrate the requested simplification.

## C. Module changes

| Module | Before → after, lines | Architectural change |
|---|---:|---|
| `js/app/extensions.js` | 1,414 → 874 | Owns lifecycle/RPC/host actions; independent iframe program and rendered registry removed; repeated handlers and failure state consolidated |
| `js/app/plugin-frame.js` | new | Owns the opaque document's module loader, SDK and plugin-side message handlers; accepts serialized configuration only |
| `js/app/plugin-views.js` | new | Owns rendered contributions, validation, rendering capabilities and derived page/navigation/section metadata |
| `js/model/graph.js` | new | Read-only graph lookup/binding resolution plus shared event/import/display contracts; replaces UI dependence on Editor |
| `js/model/editor.js` | 1,405 → 1,383 | Mutation-only responsibility; static readers now belong to Graph; no browser dependency |
| `js/model/schema.js`, `documents.js`, `snapshot.js`, `evaluate.js` | retained server-only | No longer shipped as browser implementation; shared small contracts moved to graph.js |
| `js/inspector/inspector.js` | 1,348 → 1,294 | Consolidated port editing and plugin-section mounting rather than splitting a singleton across files |
| `js/canvas/render.js` | 1,082 → 1,028 | Pure geometry removed from DOM reconciliation and reused by previews/selection |
| `js/canvas/geometry.js` | new | DOM/workflow-independent paths and samples; explicit appearance parameters |
| `js/canvas/commands.js`, `js/app/helpers.js` | smaller | One value edit lifecycle; removed duplicate body serialization and preference promise queue |
| `server.js` | 851 → 817 | One SSE subscription lifecycle and encoding adapter; existing storage/auth service boundaries retained |
| `css/shell.css` | smaller | Moved the authoritative hidden-header declaration to its original rule; removed the obsolete override |

No entire supported subsystem or public API family was removed. Existing package formats and graph formats
remain readable. Internal asset URLs for server-only model implementations are deliberately no longer public;
they are not plugin SDK entry points. Reloading the client obtains the current manifest.

## D. Client/server contracts

```text
Client UI -> api facade -> Environment (credentials, cancellation, generations, SSE)
          -> existing HTTP application protocol
Server HTTP -> credentials + Backend -> Call/Context -> Editor/domain -> DB -> file-store
Runtime -> interpreter -> isolated Script Worker -> checked Backend operations
Plugin -> opaque iframe RPC -> host capability gate -> scoped Environment request
```

The actual generated application OpenAPI documents are byte-identical after JSON serialization:
67 paths, 92 operations, SHA-256 `8600bf4977a47c0c26b069c50978753db5e48032543aca39364fd0b5be1d078d`.
See [api-contracts.json](api-contracts.json). HTTP platform endpoints and the public SDK remain covered by
existing contract tests. The SDK declaration SHA-256 is recorded in the architecture inventories.

The client still knows graph snapshot shapes, route names and resource IDs, which are application contracts.
It does not know filesystem mappings, backend module references or Worker state. Server modules do not import
DOM/canvas/page code. Environment switching retains save vetoes, generation rejection, URL-bound credentials,
scoped retry behavior and reconnection. Both legacy and typed SSE payloads remain compatible.

Remaining implicit coupling is within each program: ordered global manifests, W shared by canvas/Inspector,
and backend globals coordinating writer contexts, execution and hooks. No claim of full ES-module isolation
is made. Automated checks enforce manifests, server-only assets, one client transport and no CommonJS cycles.

## E. State and lifecycle

The server remains authoritative for definitions, graph layout, Library resources/types, collections, policies,
secrets and durable runtime JSON. Call/Context owns transaction drafts; the writer queue serializes commits.
Runtimes own live tasks, caches, cancellation and Workers. Those execution and persistence mechanisms were
retained rather than replaced with mirrored client state.

The client owns environments, per-tab credentials, preferences, navigation, selection and transient forms.
Project/Library/snapshot/runtime caches are remote projections invalidated by SSE and cleared on environment
switches. Canvas maps remain derived indexes and geometry caches; no client mutation engine is loaded. Binding
resolution reuses W.nodes rather than rebuilding a separate node index after every snapshot read.

PluginViews entries own all rendered contribution projections. One host error map determines failure.
The live map contains sandboxes directly rather than another copy of their metadata. Disposing a sandbox
aborts requests, revokes its scoped credential, rejects pending invocations and removes listeners/registrations.
Open dialog promises now settle on the sandbox abort and remove their host callbacks. Preference persistence
keeps one coalescing timer; no promise chain is needed to schedule a synchronous value assignment.

SSE subscriptions have one map and cleanup function. Disconnect, backpressure, heartbeat failure and server
shutdown all remove the same entry and clear its timer. External-change scans now recognize typed subscribers
as well as legacy ones when choosing their scan interval.

## F. Plugin isolation and extensibility

Packages, dependencies, checksums, activation order, updates/migrations/rollback, deployment records and private
storage retain their existing contracts. The iframe document keeps its opaque origin, CSP and source/origin
message checks. Host calls still enforce capabilities; scoped tokens still enforce them again at the server.
Missing mandatory capability/manifest modules no longer have permissive host/store fallback branches.
An older server's explicit 404 scoped-token compatibility remains in Environment, preserving that supported mode.

The registry receives only a sandbox's invocation and checked-request capabilities. A resource view cannot
bypass the owner to read a collection. All returned plugin content still passes through PluginContent. Explicit
commands, toolbars, menus and styles retain their distinct policies and owner cleanup. Plugins remain
client-only; saved ordinary resources execute after their initiating plugin/browser is gone.

Limits remain: global plugin CSS can affect presentation; the host is not an authorization boundary against
a modified operator client; client-only packages cannot install server routes/background hooks. These were
not expanded to reduce implementation size.

## G. Verification

Final verification status is recorded in [verification.json](verification.json). Full suites ran on
`2197e4c`. The final `aac80ce` deletes one unreferenced pure private version helper; its focused package,
manifest, lifecycle, client-plugin and syntax suite passed 23/23. No other application changes followed.

| Command | Result |
|---|---|
| `node --test`, Node 20.17.0 | 443 tests: 442 pass, 0 fail, 1 Windows/POSIX skip; 33.11 s |
| isolated Node 24.22.3 `--test` | 443 tests: 442 pass, 0 fail, 1 Windows/POSIX skip; 43.30 s |
| `python tests/browser_suite.py`, final Node 24 servers | 7/7 scenarios pass |
| `python tests/browser_plugin_platform.py`, final Node 24 servers | 25 checks pass |
| Native unload confirmation: Chromium, Firefox, WebKit | All three pass |
| Focused architecture/static-serving/graph/concurrency/plugin/geometry tests | Passed |

Eight added Node tests cover owner-wide view removal/projections, cross-kind page collisions, checked resource
rendering, returned metadata isolation, open-dialog disposal, geometry without DOM/global appearance state,
and single payload encoding across clean-401 renewal despite caller mutation.
Existing security/runtime regressions remain enabled: realm-safe Worker errors, scoped auth, permission and
SSRF policy, static paths, transactions, fan-out/join, live edits, nested scopes, Pause/Resume/Stop and restoration.

An initial browser execution test raced the pending Run request: waiting for `!W.running` could complete before
the server's Run response arrived. Its condition now uses `!runActive()`, including pending starts. A standalone
rerun and complete subsequent checkpoint passed. The backpressure fixture now accepts both handshake writes
before simulating a full buffer, because handshakes also check backpressure. The underlying assertions remain.

The shell geometry check now waits for its target rather than sampling an animation after a fixed delay.
Explicit browser contexts also corrected a native-unload test race: Page.close disposed its implicitly owned
context before asynchronous dialog handling completed. A controlled pending-save gate now replaces a delay.
Native confirmation passes in all three installed engines; the earlier Firefox limitation was a harness
artifact. The new transport regression failed before encoded-payload retention and passed after the fix.

Skipped/unverified: Windows cannot verify POSIX secret modes; remote CI, a public TLS/reverse-proxy deployment,
physical phones, formal sandbox proofs and a long-duration soak were not rerun in this structural cycle.
The previous hardening report remains the source for its independent audits and historical claims.

## H. Performance

Backend command: `node --expose-gc tools/stress.js --json`, Node 20.17.0, Windows, 300 reads, 40 runs,
500 records and a 600-node graph. All measurements use disposable data. Initial
[before](performance-before.json)/[after](performance-after.json) samples are retained. An adjacent repeat
of the unchanged baseline and final implementation is
[before-repeat](performance-before-repeat.json)/[after-repeat](performance-after-repeat.json).

| Workload | Initial before | Initial after | Adjacent baseline repeat | Adjacent after repeat |
|---|---:|---:|---:|---:|
| API read median / p95, ms | 0.59 / 1.31 | 1.59 / 3.52 | 1.56 / 3.55 | 1.51 / 3.57 |
| Graph run median / p95, ms | 29.25 / 31.50 | 68.44 / 74.70 | 68.19 / 73.83 | 68.68 / 90.49 |
| 600-node save, ms | 1,420.53 | 3,840.95 | 3,830.66 | 3,989.34 |
| Graph read median / p95, ms | 17.59 / 20.58 | 40.64 / 46.83 | 49.19 / 49.43 | 42.72 / 47.90 |
| Stop under load, ms | 22.06 | 29.51 | 26.06 | 28.64 |
| Run failures / running runtimes after Stop | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Heap before / after GC, MB | 5 / 11 | 5 / 11 | 5 / 11 | 5 / 11 |

The unchanged baseline reproduced the large timing shift, so the initial delta does not isolate a refactoring
effect. In the adjacent comparison save was 4.1% slower and Stop 2.58 ms slower; graph-read median was lower.
These small samples do not establish statistical significance or a speedup. Run p95 also varied; all runs
settled successfully. No interpreter tuning was justified from these samples.

Matched main-isolate CPU profiles put `buildSnapshot` at 19.0% before / 18.4% after self-samples. Rename, open,
fsync and writeFileUtf8 collectively account for about 31% in each. The same hotspots dominate both revisions.
See [cpu-profile-summary.json](cpu-profile-summary.json) and the separate instrumented
[before](performance-before-profiled.json)/[after](performance-after-profiled.json) workloads. Profiled save
was 5,305.74 / 5,080.93 ms; these instrumented numbers are not mixed into the unprofiled table. Profiles cover
the main isolate, not Worker-internal cost or per-route wall time. Raw profiles are temporary; recreate with
`node --cpu-prof --cpu-prof-dir PATH --cpu-prof-name NAME --expose-gc tools/stress.js --json` on each checkout.

Browser command: `python tools/client-bench.py --root CHECKOUT --samples 5 --nodes 200 --output FILE`.
Chromium 143.0.7499.4, viewport 1440×1000, new contexts for cold loads, fresh servers/data, alternating color
edits and actual position changes. Browser samples and final results are recorded in
[client-performance-before.json](client-performance-before.json) and
[client-performance-after.json](client-performance-after.json). These are local samples, not a performance SLA.
The fixed 16% script-payload reduction is independent of wall-clock variance.

| Browser workload median, ms | Baseline | Final |
|---|---:|---:|
| Cold dashboard | 393.13 | 398.12 |
| 200-node graph load | 1,306.9 | 1,325.8 |
| Selection/color edit | 1,538.7 | 1,519.7 |
| Layout save | 99.6 | 97.8 |
| Plugin install/disable/enable/remove | 735.4 | 851.1 |
| Environment round trip | 170.6 | 168.3 |

Both runs recorded zero page errors. Plugin-cycle median increased 15.7%; five samples include startup,
filesystem and browser scheduling, so this does not isolate an implementation regression. The preserved
[initial baseline](client-performance-initial-before.json) / [initial after](client-performance-initial-after.json)
pair measured 957.0 / 1,000.6 ms for that cycle. These samples justify no browser speedup claim.

## I. Complexity retained after review

- **Graph editor, 1,383 lines:** type merging, binding validation, groups/Complex Nodes, clipboard remapping and
  Library refresh operate on one transaction document. Their rules differ; replacing them with a generic
  mutation framework would hide invariants. Read-only operations have been removed from this responsibility.
- **Inspector, 1,294 lines:** selected primitive, group and linked-Library instance forms have different editing
  and permission rules. Common port events were consolidated. A blind split would still share W and pending
  saves across the same singleton; no such split was made.
- **Renderer, 1,028 lines:** incremental DOM reconciliation preserves focus, iframe widgets, field heights,
  measured sockets and minimap caches. Pure geometry is separate and reused; caches with actual rendering
  invalidation responsibilities were retained.
- **Canvas CSS, 1,383 lines:** wires/sockets, controls, widgets, groups, resize handles, code editing and motion
  styles correspond to supported visual behavior. Dynamic classes make blanket dead-selector deletion unsafe.
  The same-selector override audit found one obsolete declaration; the stylesheet was not cosmetically split.
- **Interpreter/Worker and persistence:** concurrent signal ownership, live graph reads, nested scopes, durable
  JSON and capability boundaries are essential complexity. Their state machines were not rewritten. The
  self-contained graph-view adapter remains necessary for serialization into an isolated Worker.
- **Global script composition and combined compatibility server:** ordered manifests, W and backend globals
  remain implicit coupling. The legacy raw-storage endpoint is retained behind its existing authorization
  boundary; it is not made public on the platform server or replaced by a second client transport.

## J. Necessary follow-up

The strongest remaining coupling is the canvas/Inspector singleton and its page disposal contract. If further
editor changes require independently mounted views, introduce a small explicit page context at that boundary
and remove globals as callers migrate; do not create forwarding modules around W. If large-graph read/save
latency becomes a product constraint, profile snapshot construction and file commits with representative
projects before changing cache/validation behavior. No new product features or framework migration are
required by this refactoring.
