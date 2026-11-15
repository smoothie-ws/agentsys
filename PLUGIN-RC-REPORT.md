# AgentSys Plugin Platform RC engineering report

## Provenance and duration

- Source: `66b3b06a6c4124164a1889c20a246957f566f0d4`, `refactor/architecture-simplification`.
- Implementation: `f8d733360ca91fb6b2bb64bc6e5610a02f8806e6`, `certification/plugin-platform-rc`.
- Final report commit: the branch HEAD containing this report; `git log -1` identifies it without a self-referential commit hash.
- Started: 2026-11-15 17:14:51 +10:00 (Asia/Vladivostok). Implementation certification completed at 18:04:10 +10:00: 49 minutes 19 seconds elapsed, including remote CI. Report publication and its final documentation-only CI verification follow that cutoff.
- Initial working tree was clean. Eight architecture-simplification commits above `main` were retained. `main` and user data were not modified.

## Findings and fixes

1. Token endpoint 404 silently enabled owner-session authority. Removed that fallback. All issuance refusals,
   timeouts, network failures and unsupported endpoints now refuse plugin operations.
2. Server credentials lacked plugin identity. Tokens now bind a trusted-host `plugin_id`; the host checks the echo.
   Identity-unaware servers require an upgrade. Equal capabilities no longer imply shared credentials or revocation.
3. Library replacement trusted client JSON ownership. The server now checks verified identity inside its writer queue
   across raw resources, script nodes, Library editor, move and `lib-` project mutations; bulk folder mutation is denied.
4. Deployment could overwrite a user-edited Library node or alter an existing template graph. Deployed node payloads
   now have an edit baseline checked by preflight and replacement; changed saved workflows are preserved.
5. Package updates granted expanded capabilities automatically. The store rejects escalation without explicit trusted
   approval. Import/update/editor dialogs show package metadata, source, all grants and dangerous permissions; Cancel
   retains the prior version and grants. Failed activation restores the previous package.
6. Browser storage used only saved environment ID. It now includes exact server URL, migrating old scopes to the
   original address before an address edit. Node and real two-server tests assert separation.
7. Linux storage failure prevented creation of a redo journal: POSIX reports `ENOTDIR` where Windows reports
   `ENOENT` for a missing key below a file. Treating both as an absent read lets the later failed write retain its
   durable redo record. The original strict recovery test remains intact and passes on Linux in remote CI.
8. The browser platform scenario existed but did not run in CI. Added it and certification/security scenarios to a
   three-engine matrix, plus uploaded logs. Pinned Playwright 1.57.0 and its supported Ubuntu 24.04 browser runner
   after the moving `ubuntu-latest` image proved incompatible. Node 22/24 still run on Linux and Windows.
9. Documentation and the shipped starter called nonexistent `api.escape`. Fixed them to `api.ui.escape`, rebuilt the
   starter package and verified rendering and a persistent command in a real browser.
10. A WebKit cross-origin cancellation diagnostic occurred when the test reloaded before the restored plugin view
    finished requesting data. The scenario now waits for that view and zero pending work, retaining the strict
    no-page-errors assertion. The synthetic unsupported-server response now also supplies correct CORS headers.

11. Final negative-path review found that percent-encoded `lib-` IDs could evade the extra Library capability
    classification. Host, scoped server and Script boundaries now classify the decoded project ID; a real HTTP
    regression asserts `library.write` denial.
12. Connectivity analysis now follows a linked Custom Node's interface bindings, so an internal Script behind a
    connected Library wrapper is not incorrectly reported as disconnected. Unit and browser graph assertions cover it.

13. Integration Studio now retains the record version read when its edit form opens. Saving an obsolete form
    cannot overwrite a concurrent update, and a deleted connection is not silently recreated. The browser fixture
    asserts a stale-save conflict and preservation of the newer record. Deployment preview also compares definition
    content when a package changes without a version bump.

## SDK and architecture

The injected SDK remains API 2 with no new application-specific server endpoints. The host gained a read-only
deployment preview and credential-free lifecycle diagnostics, neither exposed to plugin iframes. The transport's
identity binding is stricter; old servers must upgrade. See the [contract and inventory](docs/plugin-rc-contract.md)
for private/shared/owned resource semantics, UI extension points and deliberate omissions.

Two independent packages exercise the same SDK:

- [Integration Studio](client-plugins/integration-studio/README.md): connection CRUD/form/check, parameters,
  server bearer-secret reference, settings/commands/Inspector, two Collections and six reusable Library stages.
  Its ordered saved workflow executes on the existing server runtime with the browser closed, saves a result and
  displays it after mobile reconnect. Build progress can resume without duplicating placed stages.
- [Graph Developer Tools](client-plugins/graph-developer-tools/README.md): workflow structure, dangling links,
  disconnected nodes, Custom Node references and diagnostics; page, toolbar, selection context command and
  Inspector. Reports survive reload, remain environment scoped, and an exported package installs in a fresh client.

Neither imports private application code, accesses canvas internals, installs a server plugin or supplies a second
interpreter. A client without either product reads the same ordinary graph through the public server API.

## Tests and evidence

Baseline: 443 Node tests, 442 passed, zero failures, one platform skip. Final local regression: 460 tests, 459 passed,
zero failures, the same POSIX-permissions skip on Windows. Seventeen tests were added; no assertions were weakened.
Local environment: Windows, Node 20.17.0, Python 3.12.6, Playwright 1.57.0. Remote jobs cover Node 22/24 independently.

New/expanded tests cover token refusal scenarios, identity-unaware server rejection, revoked/expired renewal refusal,
real HTTP ownership attacks, capability escalation approvals, URL-bound storage migration, read-only preflight,
edited-node preservation, interrupted deployment retry and graph analysis. The new browser certification scenario
adds permission review/cancel, real connection form, authenticated local HTTP service, Inspector/selection actions,
fresh-client graph read/export/install, both products against two independent servers, starter verification,
lifecycle metrics, headless execution and reconnect.

The full local Chromium browser runner passed 9/9 scenarios: platform, plugin platform, plugin certification,
plugin security, editor, UX, execution UI, shell and design. Firefox/WebKit plugin suites and UX passed; the final
expanded product scenario was also rerun separately on all three engines. Logs are retained under
[`docs/audits/plugin-rc`](docs/audits/plugin-rc/) and remote Actions artifacts.

Stress: twenty UI Showcase cycles plus ten cycles of both products. After disable, iframe/listener/UI/command/
pending/token counts are zero. Chromium's before/after-GC heap measurements are in its certification log;
Firefox/WebKit do not provide equivalent heap telemetry in this harness. Hung iframe recovery is independently tested.

Security evidence includes forbidden DOM/storage/token access, forged messages, foreign commands/settings,
unapproved network/secrets/API operations, passive HTML/CSS loading, owner spoofing, stale tokens and work after
disable/switch. Tests use isolated temporary directories and synthetic HTTP services, not user data or real API keys.

The initial remote browser jobs failed on Ubuntu 26.04 before test execution; pinning the supported browser runner
resolved that setup failure. The initial Linux Node jobs exposed the journal bug above. Earlier Windows Node
jobs exceeded existing latency/soak assertions when test files competed for CPU and disk. CI now runs every Node
test file sequentially; assertions and thresholds remain unchanged. All supported-version jobs passed with this isolation. The final implementation run, [43692551394](https://github.com/smoothie-ws/agentsys/actions/runs/43692551394), completed with all seven jobs successful. The exact SHA and job steps are retained in [ci-results.json](docs/audits/plugin-rc/ci-results.json).

## Remaining limits and release decision

Deployment is not atomic; successful earlier writes survive a later failure and retry uses the returned state.
An interruption before a new project/workflow ID is saved may leave an empty project for manual inspection.
Legacy Library nodes without a content baseline refuse automatic replacement until owner review and explicit redeployment. Existing workflows are preserved
rather than automatically upgraded; apply changed templates to a new workflow. Plugin-authored migrations are
not transactional with package rollback. Collections and ordinary projects are shared according to coarse family
capabilities, and the package fingerprint does not establish publisher authenticity. HTTP hosts and secret names
must be explicitly approved; project runtime policy remains a separate owner decision.

No unresolved vulnerability was observed in the exercised plugin/host/server boundaries. The bounded stress and
synthetic integrations do not certify arbitrary third-party code or indefinite operation. Old identity-unaware
servers are intentionally unsupported by the hardened plugin transport.

**Verdict: READY WITH LIMITATIONS.** All required exercised scenarios and the remote release gates passed.
Linux Node 22/24 ran all 460 tests without skips; Windows Node 22/24 retained the existing POSIX-only skip.
Chromium, Firefox and WebKit each executed the plugin platform, product certification and security scenarios.
The [certification matrix](PLUGIN-RELEASE-CANDIDATE.md) records the evidence and practical limits.
The final report/evidence commit has no runtime changes, and its branch CI is checked before delivery.
