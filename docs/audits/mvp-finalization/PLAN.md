# MVP finalization work plan

Baseline: clean working tree; Node 413 tests, 410 passed, 2 failed (shipped plugin checksums), 1 POSIX-only skip. Browser baseline running separately. Source inventory and counting scope: metrics-before.json (generated catalog excluded). Generated packages, legacy, user data, dependencies and tests are excluded from application metrics.

Current architecture takes precedence over obsolete filenames in the task: concepts/API/limits are covered by architecture.md, engine.md, runtime.md and server.md. Browser-only execution and server plugins were explicitly removed in the existing product; they will not be reintroduced.

- [x] Inventory source, read current architecture, execution, permissions, security, plugin and testing contracts; establish Node baseline.
- [x] Extract cohesive server infrastructure; remove unreachable browser storage implementation; enforce boundaries.
- [x] Fix plugin credential ownership, issuance races and late requests after disposal; add regressions.
- [x] Audit storage recovery, script isolation, cancellation and remote transport; fix confirmed defects.
- [x] Make plugin packaging reproducible across checkouts and platforms.
- [x] Review UI feedback, asynchronous navigation and responsive browser journeys.
- [x] Run complete Node/browser verification and representative performance workloads.
- [x] Update authoritative documentation, final measurements and technical report; disclose remaining limitations.

Decisions and evidence will be recorded here as work proceeds. No new AI functionality or execution quotas.

Final evidence: 435 Node tests on both Node 20.17.0 and 24.22.3: 434 pass, zero fail, one POSIX-only skip.
Chromium suite 7/7; WebKit UX passes; Firefox UX passes with a disclosed native-dialog environmental skip
confirmed on an independent empty page. Five-reference-plugin platform scenario passes. A 60-second Node 24
soak completed 192 cycles with zero errors and every Worker released. See REPORT.md for exact scope, metrics,
security fixes, slower workload samples and remaining platform limitations.

Decisions: preserve the already-shipped server/client split and interpreter semantics; isolate persistence,
credentials, static assets and passive plugin content; rebuild errors at the VM membrane; fail closed on scoped
credential failures; retain 404-only compatibility for older servers. Remove retired executable plugin hosts.
Active handwritten source is essentially flat (+7 lines); total including retired code shrank by 400 lines.
No assertion of a large active-code reduction or a formal sandbox proof.
