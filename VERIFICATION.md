# MVP verification

The initial products are published independently:

| Product | Release | Source |
|---|---|---|
| Server | [v0.1.0](https://github.com/smoothie-ws/agentsys-server/releases/tag/v0.1.0) | `4dd2bc1aa3c21a850eb3c3634b9f694a65efb7c4` |
| Client and SDK | [v0.1.0](https://github.com/smoothie-ws/agentsys-client/releases/tag/v0.1.0) | `fe70ac150c41bcb0e6bf9fc6b2ebf0c4979cd3ee` |

Web API is `1.0` with protocol `1`; Plugin API, plugin package format and Library bundle format are `1`. Graph documents use `agentsys.text/1`; stores use `agentsys.store/1`.

## Product checks

- Server: 349 tests, 348 passed and one POSIX permissions check skipped on Windows. Linux runs include that check.
- Client: 107 unit tests passed. Static browser tests also exercise installation through the plugin form and isolation from unrelated browser storage.
- Both products passed Node.js 22 and 24 on Linux and Windows. Server container HTTP/restart checks passed. Client static hosting passed Chromium, Firefox and WebKit.
- Store tests verify initialization/reopen, transaction recovery, backup restoration and refusal of nonempty unmarked or unsupported directories without file changes. Record revisions and workflow cursors retain conditional-write protection.
- Plugin tests verify checksum-based replacement with an unchanged version label, ID dependencies/cycles, lifecycle cleanup, permission approval and resource ownership.

CI records are in [ci-status.json](integration-results/ci-status.json). The pinned product source passed the [three-engine integration matrix](https://github.com/smoothie-ws/agentsys/actions/runs/43989195740).

## Published artifact checks

[releases.json](integration-results/releases.json) records public download URLs, sizes and SHA-256 digests for Server npm/API ZIP/container image and Client npm/static ZIP/SDK. Downloaded contents and SDK declarations were validated independently of the source checkouts.

All three browser engines passed 42 checks each against the downloaded release tarballs:

- [Chromium](integration-results/artifact-chromium/results.json)
- [Firefox](integration-results/artifact-firefox/results.json)
- [WebKit](integration-results/artifact-webkit/results.json)

These include editor and UX scenarios, environment switching, CORS/authentication/SSE, concurrent writes, plugin sandbox security, lifecycle, Library/collection deployment, Integration Studio, Graph Developer Tools and execution after all browsers close. Per-scenario logs and screenshots accompany each result.

The published Client ZIP also passed [ordinary static HTTP hosting](integration-results/static-only.json) in all three engines without an AgentSys CLI or backend.

Reproduce with [INTEGRATION-TESTS.md](INTEGRATION-TESTS.md). Each run uses temporary stores and browser contexts.
