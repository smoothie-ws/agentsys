# Verification

Baseline: `6d9d623e6cd19db726be293ec03e0e5962183d3d`; final code/package implementation: `113f48a33ee6e9b0603c7e1c1e3e1832cb3626ed`.
Local platform: Windows, Node v20.17.0 compatibility, Python 3.12.6, Playwright browsers.

| Check | Result |
|---|---|
| Baseline `node --test --test-concurrency=1` | 460 tests: 459 PASS, 0 FAIL, 1 Windows POSIX-mode skip |
| Full regression after cleanup and shutdown change | 446 tests: 445 PASS, 0 FAIL, same skip |
| Latest package/SDK/static/architecture checks | 33 PASS, 0 FAIL |
| Dedicated lifecycle/shutdown regressions | 19 PASS, 0 FAIL (includes plugin manifest tests) |
| Chromium platform, plugin_platform, plugin_certification, plugin_security, editor, ux, execution_ui, shell, design | 9/9 PASS |
| Firefox plugin_platform, plugin_certification, plugin_security, ux | 4/4 PASS |
| WebKit plugin_platform, plugin_certification, plugin_security, ux | 4/4 PASS |
| Remote Linux Node 22 / 24 | PASS — all matrix jobs completed |
| Remote Windows Node 22 / 24 | PASS — all matrix jobs completed |
| Remote Chromium / Firefox / WebKit | PASS — all matrix jobs completed |

Current coverage includes concurrent signals/fan-out/join, recursion/nested Custom Nodes, state, cancellation,
pause/resume, worker cleanup, graph mutation, runtime bounds, server restart and current-data recovery. Existing
security assertions for host-realm escape, scoped-token fallback, verified identity, ownership, cross-plugin
commands, HTML/CSS and endpoint credential affinity remain active. Failure injection covers disk writes, journal
recovery, worker failure, request aborts, plugin token refusal, activation crash and environment switching.

Real browser certification installs Integration Studio and Graph Developer Tools, deploys Library resources,
runs saved server graphs without the Client and verifies endpoint isolation. Browser-only execution and old
server-plugin scenarios were replaced or retired; their test counts are not carried forward as current coverage.

The first cleanup regression found an import of the retired raw-storage transformer in request-node.test.js;
its checked HTTP Script behavior was moved to an independent program fixture. Temporary failing assertions
during development were fixed; no security assertion or current storage/runtime test was disabled for CI.

Reproduce with docs/testing.md. Performance comparison is in BEFORE-AFTER.md. GitHub Actions preserves all four
OS/Node combinations and all three browser engines, and now triggers on refactor branches. A full readiness
verdict requires completed remote results; local success alone is insufficient.

Final implementation GitHub Actions: [run 43783423515](https://github.com/smoothie-ws/agentsys/actions/runs/43783423515),
commit `113f48a33ee6e9b0603c7e1c1e3e1832cb3626ed`: **7/7 jobs successful**. The earlier full matrix at
`bc5e5473716ae009e1ce97680a25bbbed8a8e8f8` also passed [run 43782980562](https://github.com/smoothie-ws/agentsys/actions/runs/43782980562).
Exact job identities/statuses are preserved in [ci-results.json](ci-results.json). Final documentation follows
the tested implementation; its delivery commit receives the same unchanged full CI workflow before handoff.

Package reproducibility after regenerating all eight examples/reference packages: 16 focused tests PASS.
Current-document relative links (including Linux-sensitive filename case) and `git diff --check` PASS.
Three five-sample browser pairs and two runtime runs per revision are in [measurements.json](measurements.json).
The initial slower plugin/layout pair did not reproduce in either follow-up, including reversed execution order.
No speculative interpreter optimization was performed. The temporary detached baseline worktree was removed.
