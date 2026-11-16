# AgentSys product separation report

**FULLY SEPARATED**. Both independent products are released, their published
artifacts verified, and all product/release/main integration CI checks passed. The requirement-by-requirement record is [COMPLETION-AUDIT.md](COMPLETION-AUDIT.md).

## Delivered products

| Product | Repository/release | Version | Commit |
| --- | --- | --- | --- |
| Server | [repository](https://github.com/smoothie-ws/agentsys-server), [release](https://github.com/smoothie-ws/agentsys-server/releases/tag/v0.4.1) | 0.4.1 | `62789987a3e303f940c94ebf3ec8cb8275b3c86d` |
| Client | [repository](https://github.com/smoothie-ws/agentsys-client), [release](https://github.com/smoothie-ws/agentsys-client/releases/tag/v0.7.0) | 0.7.0 | `83835ea0d77b1e35fe3e972a1dd7205b97f730be` |
| Plugin SDK | Public declarations package attached to Client release | 2.0.0 | Client release commit |
| Web API | Canonical OpenAPI 3.1, schemas and versioned API ZIP in Server release | 2.0 | Server release commit |

Source baseline: `5f916bf24bea3a10a0566c68992f1eacb79a999a` from the architecture
branch. Its GitHub head was checked before starting. Full ancestry and a provenance
tag are preserved in both new repositories. The original main branch was advanced
normally to integration implementation commit `6408e0d`, with final integration tooling at `34bef63`; no force push, history
rewrite, remote replacement or user-data deletion was performed.

## Ownership and removed dependencies

Server owns headless.js, server HTTP/auth/credentials/file-store modules and the
runtime backend, graph model/interpreter, storage and worker execution. Former
js/backend, server model/storage files and shared helpers moved into runtime/.
It contains no HTML/CSS application, Canvas, Inspector, plugin host or client package.

Client owns index.html/CSS, js/app/pages/canvas/inspector, its snapshot/type/import
editing model, client plugins, SDK and static distribution. The former shared
helpers/protocol are product-owned adapters; executable code is not shared between
repositories. Client core no longer contains server manifest validation. Public
JSON graph/capability fixtures verify independent implementations against the same
formats, including script extraction, Unicode, layout and opaque runtime data.

The Client CLI imports client-owned static serving and package metadata, serves
only dist/client and requires no Server source. Static access uses an exact public
manifest, with traversal/symlink/Windows path checks. The Server static helper and
combined local source launcher were removed. There is no root combined package or
npm workspace. Integration tooling installs exact tarballs into separate prefixes
and starts separate CLI processes. The products exchange only HTTP JSON and SSE.

## Installation, build and release results

Both npm packages install cleanly without the other product. The Server CLI
start/status/version surface is tested; Server-only Docker CI creates and executes
a workflow and verifies saved results after container restart. Docker image and
systemd/TLS/data/environment documentation are delivered in the Server repository.
Client static hosting needs no Node.js; the optional CLI supports serve. Public
config.json, disconnected first boot and multiple environment management are tested.
nginx/Caddy deployment examples retain the existing framing/content-security policy.

Published files were downloaded and checked for size and SHA-256 against GitHub
metadata. The Client ZIP exactly matches its allowlist. Backend/interpreter/data
and tests are absent from Client artifacts; GUI is absent from Server artifacts.
The API ZIP matches the contract shipped in the Server package. The SDK tarball
contains only declarations, README and package metadata. Full digests and URLs:
[releases.json](integration-results/releases.json).

| Release asset | Bytes |
| --- | ---: |
| agentsys-server-0.4.1.tgz | 136,982 |
| agentsys-api-2.0.zip | 16,832 |
| agentsys-server-image.tar.gz | 61,229,535 |
| agentsys-client-0.7.0.tgz | 257,644 |
| agentsys-client-static.zip | 304,179 |
| agentsys-plugin-sdk-2.0.0.tgz | 5,048 |

## Tests and CI

Server local suite: 347 tests, 346 passed and one POSIX permission test skipped on
Windows. Client local suite: 107 passed. Independent CI covers Node 22/24 on Linux
and Windows; Client browser jobs cover Chromium, Firefox and WebKit. Server
container CI and both release workflows passed. Product test/build dependencies
remain independent; no runtime dependency was added.

- [Server CI](https://github.com/smoothie-ws/agentsys-server/actions/runs/43839810976)
- [Server release](https://github.com/smoothie-ws/agentsys-server/actions/runs/43839811016)
- [Client CI](https://github.com/smoothie-ws/agentsys-client/actions/runs/43831105744)
- [Client release](https://github.com/smoothie-ws/agentsys-client/actions/runs/43831105389)
- [Final main integration CI](https://github.com/smoothie-ws/agentsys/actions/runs/43851420888)

Integration tests install distributions and use real HTTP. They cover exact-origin
CORS, unlisted-origin refusal, Bearer/session authentication, SSE to a second client,
simultaneous conditional-write conflict, tab identity/credential isolation, two
servers, stale-request cancellation, independently versioned patch artifacts and
incompatible-major refusal/recovery. Optional SSE/session features can be absent
while Bearer REST remains usable.

Library Pack, Integration Studio and Graph Developer Tools are exercised. A client
dispatches a saved workflow, disconnects, and the Server completes execution and
stores a transformed HTTP result; a fresh browser retrieves it. The original editor,
UX, malicious-plugin security, plugin platform and certification suites run against
installed artifacts. Local E2E input digests match the published release files.
Evidence and screenshots are under integration-results/; the CI snapshot is
[ci-status.json](integration-results/ci-status.json).

## Performance and remaining limits of measurement

Final measurements use Node 24.22.3 and downloaded release tarballs whose digests
match the E2E inputs. Uncompressed baseline source installation was 10,188,705
bytes, Server 769,710 bytes and Client 937,028 bytes. Baseline included development
and test files; no independent Client distribution existed. The final static
Client distribution is 923,645 bytes. Browser JavaScript was 661,266 -> 647,233
bytes; line-ending normalization contributes to this difference.

Server RSS was 67,026,944 -> 57,536,512 bytes; static CLI RSS 60,035,072 ->
48,201,728 bytes; browser heap 2,890,800 -> 2,871,840 bytes. API p50 was
1.107 -> 1.314 ms and p95 15.439 -> 16.250 ms. Cold Server startup was
555.74 -> 589.57 ms; static CLI startup 68.16 -> 73.49 ms; browser connection
272.22 -> 267.77 ms. These single-run samples are sensitive to caching/GC and
establish neither a statistically significant speedup nor a leak. Both SSE
connections stayed up across a 21-second heartbeat interval. Methodology and
remaining fields are in integration-results/performance.json.

The local POSIX permission test is covered by Linux CI. User data in the original
untracked directory was preserved; select that directory explicitly with the
standalone Server CLI when migrating an existing installation.

Ordinary static hosting without the AgentSys CLI/backend passed in Chromium, Firefox and WebKit; see integration-results/static-only.json. Server 0.4.1 also corrects discovery to report the actual enforced 20 MB application request limit from the same constant used by the parser.
