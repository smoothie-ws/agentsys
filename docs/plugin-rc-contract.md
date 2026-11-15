# Plugin API 2 release candidate contract

API 2 remains the public JavaScript/TypeScript contract in [`sdk/agentsys-plugin.d.ts`](../sdk/agentsys-plugin.d.ts).
No server plugin loader, application-specific backend, canvas internals or second graph interpreter is involved.
The RC hardens transport and resource ownership without changing the injected SDK method signatures.

## Interaction map

```text
package -> PluginManifest -> PluginStore (browser package + approvals)
                                |
                            Extensions
                         /                \
               PluginFrame iframe       PluginViews / PluginContent
               opaque origin, CSP       sanitized passive host UI
                         |
               checkedRequest(capabilities)
                         |
               Environment(plugin_id, caps, URL, generation)
                         |
               POST auth/plugin-session (owner authenticates issuance)
                         |
               server credentials: scoped bearer -> identity + caps + expiry
                         |
               server capability boundary -> Backend writer queue / ownership
                         |
               Collections / Library / saved workflows -> existing graph runtime
```

`plugin-frame.js` implements the SDK and package-local module loader. `plugin-views.js` owns registrations;
`plugin-content.js` sanitizes their rendered HTML. `plugin-deploy.js` uses the same checked API as SDK requests.
Installing never deploys. Disabling removes code and authority. Uninstalling retains ordinary server resources.

## Capability inventory

| Area | Public implementation | Executed evidence | Contract / limit |
|---|---|---|---|
| Pages, sidebar, dashboard | `api.ui.addPage/addSidebarItem/addHomeCard` | `browser_plugin_platform.py`, Plugin A | Passive sanitized HTML; no host DOM |
| Toolbar, menus, Inspector | `api.ui.addToolbarButton/addContextMenu/addInspectorSection` | Platform A; certification Graph Developer Tools | Selection callback supplies `{project, workflow, selected}` |
| Resource views, settings | `api.ui.addResourceView/addSettingsSection`, `api.settings` | Platform C, A | Plugin settings are local and environment scoped |
| Dialogs, notifications, commands | `api.ui.showDialog/notify`, `api.commands` | Platform A, D; certification installation + connection form | Only the caller's own commands; notification writes require capability |
| Keyboard shortcuts | No plugin shortcut registry | Inventory of injected SDK and declarations | Intentionally not provided; ordinary accessible controls use host keyboard handling |
| Events and cleanup | `api.onDidChange`, activation disposer, lifecycle hooks | Sandbox, lifecycle and platform tests | Disable aborts transport and removes iframe and registrations |
| Private storage | `api.storage`, `api.settings` | Lifecycle tests, certification reload/stress | Per plugin + saved environment ID + exact server URL; not encrypted storage for secrets |
| Collections | `api.collections`, ordinary `/collections` routes | Platform C; certification results | Shared server data under coarse read/write grants, not private plugin data |
| Schema/concurrency/migration | Collection schemas, record versions, `onUpdate/migrate` | Collections and lifecycle tests; platform C | App owns migration logic. Schema edits preserve records; existing rows are not automatically converted |
| Library/Custom Nodes | `api.library`, `/library/script-nodes`, ordinary graph editor routes | Token ownership negative tests; deployment; certification | Shared reads. Scoped writes require verified matching owner; user nodes cannot be adopted by a plugin |
| Ports and templates | Contribution inputs/outputs/grants; ordinary placement and connections routes | Deployment tests; six-stage integration execution | Native signal ports; text HTTP/JSON boundary; generic JSON values for configuration/results |
| Graph reading/editing | `api.request`, `/projects/.../workflow`, graph edit routes | Graph Developer Tools and Integration Studio | Serialized public graph snapshot; no canvas object access |
| Execution/monitoring | `/projects/.../execution`, `run.start/run.read` | Headless certification and platform tests | Saved Script grants and project policy independently constrain runtime operations |
| Persistence | Server file store + client storage | Storage integrity, reload, headless/reconnect tests | Client package is not needed to read or execute a saved graph |
| HTTP/secrets | `api.net.fetch`, `api.secrets.present`, server placeholders | Platform D, token tests, authenticated integration fixture | Values stay on server; named capabilities and egress policy apply; response/timeout limits are server enforced |
| Cancellation/offline | Plugin `api.signal`; host abort on disable/switch | Sandbox and environment tests; unavailable-server UX tests | No per-call AbortSignal option in API 2. Completed server effects cannot be undone by aborting the client |
| Lifecycle/dependencies | Store + manifest + sandbox host | Node lifecycle/manifest, browser platform | Missing/incompatible/disabled/cyclic dependencies fail; failed activation restores the previous package |
| Packaging | `tools/plugin-pack.js`, formats 1/2 | Package tests, fresh-client export/install | FNV fingerprint detects accidental edits; no cryptographic authenticity, signature or marketplace |

## Identity and compatibility

The trusted host supplies `plugin_id` when minting. The server stores it with the capability list and returns it
as `plugin_id`. The host verifies the binding before sending any plugin operation. An absent endpoint, wrong
identity, refusal, rate limit, timeout or network failure cannot select the owner's credential. A token that loses
validity is refreshed once as a scoped token. Old servers require an upgrade; host-only authorization is unsupported.
Server metadata advertises `features.plugin_identity`.

For compatibility, an authenticated external HTTP caller may omit `plugin_id` and receive a token for ordinary data
families. Such an unbound token cannot mutate Library resources. Owner-authenticated API clients remain able to edit
server data; a modified owner client is outside the plugin threat boundary.

Plugins with the same ID on different clients deliberately share resource ownership. Different plugin IDs cannot
replace each other's Library nodes, delete them, modify their grants or edit their backing `lib-` workflows. Bulk
Library folder mutations are unavailable to scoped plugins because they can affect several owners. Library reads,
ordinary projects, application settings and Collections remain shared according to their declared capabilities.
Server secrets are accessible only as metadata and server-side substitution through a named capability.

Updates adding any capability not covered by the previously approved grants require explicit trusted-host approval.
The import/update/editor dialog shows the package, version, author, source and all grants, highlighting writes,
execution, network and secrets. Cancel preserves the previous package. Direct store/host update calls without
`{approveCapabilities: true}` reject escalation; that option is not available inside plugin sandboxes.

ID-only browser storage migrates once to the original saved URL. Editing a server address binds old data before the
edit and creates a separate scope for the new address. The migration preserves the original server's values.

## Deployment and recovery

The Plugins page shows a read-only plan before applying changes: create/update/skip/conflict/inspect and required
permissions. It is a preview, not a reservation or transaction. Every Library mutation repeats ownership checks
inside the server writer queue. Partial deployments return their successful state, and retry reuses ordinary server
resource IDs. Collections retain records; uninstall never removes server resources.

Script-backed Library nodes receive a content fingerprint at deployment. User edits that change their payload
cause a conflict at both preflight and server replacement. The fingerprint detects accidental changes; authorization
comes from the scoped token identity. Legacy deployed nodes without a content baseline cannot offer the same edit
detection until explicitly redeployed. Keep a backup or duplicate legacy edits before an upgrade.

An existing deployed workflow is preserved on package updates. Apply changed templates deliberately to a new
workflow rather than rewriting a user's saved graph. The first template deployment can resume missing elements;
Integration Studio also saves build progress and reuses placed stages and connections when retrying a partial build.
An interruption before project/workflow IDs are recorded may leave an empty project; it is preserved for manual
inspection. Plugin migrations can have app-defined effects and are not transactional with package rollback.

## Verification and scope

Run `npm test`, then `python tests/browser_suite.py plugin_platform plugin_certification plugin_security`.
Set `AGENTSYS_BROWSER` to `firefox` or `webkit` to exercise those engines. The runner saves logs under
`node_modules/.cache/browser-tests/<engine>/`; GitHub Actions uploads these with UI screenshots.

The certification fixture uses synthetic data and a local HTTP service, an owner-approved project policy and a
server-held bearer secret. It closes the client context, executes all six integration stages through HTTP, checks
the persisted result, and restores a mobile client. A fresh client reads the graph without plugins and installs an
exported Graph Developer Tools package. Stress checks frames, actual message listeners, UI registrations, commands,
pending calls and live server token counts after disable. Chromium also samples heap after GC; the bounded sample
is not a proof against every long-running leak. Firefox/WebKit do not expose equivalent heap telemetry here.

See [the certification matrix](../PLUGIN-RELEASE-CANDIDATE.md) for actual results and residual limitations.
