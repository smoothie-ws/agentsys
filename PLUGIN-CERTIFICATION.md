# AgentSys plugin platform — certification

Branch: `feature/plugin-platform-certification`  
Base: `audit/reliability-round3`  
Date: 2026-11-14  
Runtime checked: Node.js 20.11.0, AgentSys 0.3.0, Playwright with Chromium 1255, Firefox 1572 and WebKit 2388.

Status values: **PASS**, **PARTIAL**, **FAIL**, **NOT TESTED**. A PASS names a test or a reproducible command.

## Completion criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Public Plugin API documented | **PASS** | `sdk/agentsys-plugin.d.ts`, `docs/plugin-sdk.md`, `docs/plugin-manifest.md`; five reference packages use only the public API (`tests/plugin-packages.test.js`) |
| 2 | All lifecycle operations work | **PASS** | `tests/plugin-lifecycle.test.js`; `tests/browser_plugin_platform.py` (install, update, disable, enable, uninstall, reinstall, recovery) |
| 3 | Required UI extension points | **PASS** | `docs/plugin-ui.md`; Plugin A exercise in `tests/browser_plugin_platform.py`; `Extensions.describe` assertions |
| 4 | Library node creation | **PASS** | `POST library/script-nodes`; `tests/plugin-deploy.test.js`; Plugin B in `tests/browser_plugin_platform.py`; `tests/browser_platform.py` |
| 5 | Generic Collections | **PASS** | `tests/browser_plugin_platform.py` (Plugin C: CRUD, validation, 409 conflict, migration, persistence, resource view); `tests/plugin-deploy.test.js` (definition + records preserved) |
| 6 | Safe capability management | **PASS** | `tests/plugin-capabilities.test.js`, `tests/plugin-tokens.test.js`, `tests/browser_plugin_security.py`, `tests/browser_plugin_platform.py` (Plugin E) |
| 7 | Secrets not exposed to client plugins | **PASS** | `tests/browser_plugin_platform.py` (Plugin D): local endpoint receives the secret; the page, package and results do not contain it |
| 8 | Package install and update | **PASS** | `tests/plugin-lifecycle.test.js` (format 2, export, update, rollback); `tests/plugin-packages.test.js`; local-file install UI |
| 9 | Dependencies and version compatibility | **PASS** | `tests/plugin-manifest.test.js` (ranges, cycles, engines); `tests/plugin-lifecycle.test.js`; `tests/browser_plugin_platform.py` (dependency shutdown/recovery; update 1.0.0 → 1.1.0; newer deployment is not downgraded) |
| 10 | Plugins work across environments | **PASS** | `tests/environments.test.js`; `tests/browser_platform.py`; `tests/browser_plugin_platform.py` (two servers, independent ids, switch back) |
| 11 | Saved graphs run without a client | **PASS** | `tests/plugin-deploy.test.js`: HTTP execution with no browser; `tests/browser_plugin_platform.py`: browser closed and plugin uninstalled, then both deployed nodes run |
| 12 | Reference plugins pass automated tests | **PASS** | `tests/plugin-packages.test.js` + `tests/browser_plugin_platform.py`, five packages |
| 13 | Existing projects and workflows stay compatible | **PASS** | Full `npm test` suite (413 tests, one pre-existing skip); `tests/browser_platform.py`; the library-node route change is additive (`resource_id` and `plugin` are optional) |
| 14 | Documentation complete and current | **PASS** | `docs/plugins.md` and twelve `docs/plugin-*.md` guides, SDK README, example project, packaging tool; obsolete server-plugin examples removed from the plugin guide |

## Detailed matrix

### Package and manifest

| Item | Status | Evidence |
|---|---|---|
| Format 1 read and format 2 export | PASS | `tests/plugin-manifest.test.js`, `tests/plugin-lifecycle.test.js` |
| Semantic versions and ranges | PASS | `tests/plugin-manifest.test.js` |
| Manifest metadata and API version | PASS | `tests/plugin-manifest.test.js` |
| Engine compatibility | PASS | `tests/plugin-manifest.test.js` |
| Safe module paths and size limits | PASS | `tests/plugin-manifest.test.js`, `tests/plugin-packages.test.js` |
| Modules (`require('./…')`) | PASS | Plugin A in `tests/browser_plugin_platform.py` |
| Bundled images | PASS | Plugin A `assets/logo.png`; browser assertion on the data URI |
| Declarative contributions | PASS | `tests/plugin-deploy.test.js`, `tests/plugin-packages.test.js` |
| Distribution from a URL | **NOT TESTED** | Not implemented by design: packages are imported from a local file chosen by the user; no remote auto-load |
| Export for redistribution | PASS | `PluginStore.export`, `tools/plugin-pack.js --validate`; `tests/plugin-lifecycle.test.js` |

### Lifecycle

| Operation | Status | Evidence |
|---|---|---|
| Install | PASS | `tests/browser_plugin_platform.py` (five packages), store tests |
| Enable | PASS | stress step, dependency step |
| Disable | PASS | `tests/browser_plugin_platform.py`, `tests/browser_plugin_security.py` |
| Reload | PASS | `Extensions.reload` in stress and update steps |
| Update (version, modules, hooks, data) | PASS | Plugin A 1.0.0 → 1.1.0; rollback path |
| Uninstall | PASS | `onUninstall` writes a project, then package is gone; values deleted |
| Reinstall | PASS | after uninstall with the same package |
| Dependency validation | PASS | missing, disabled, incompatible and cycle cases |
| Compatibility checks | PASS | API 99 refused; engine range refused |
| Migration | PASS | `onUpdate` context and stored data in Plugin A; `migrate` returning a new data version in `tests/browser_plugin_platform.py`; collection migration in Plugin C |
| Cleanup | PASS | no iframe, page, toolbar, command or style after disable; token revoked |
| Recovery after activation failure | PASS | broken 1.0.0 → fixed 1.0.1 |
| Recovery after unresponsive frame | PASS | 20-second invoke timeout stops the sandbox; `Extensions.recover` restarts. A renderer process crash is treated as a hang by the same path. |
| Reinstall of the same version | PASS | `tests/plugin-lifecycle.test.js` |
| Update with user data | PASS | private count survives the update; collection record survives redeploy |
| Disable during active operations | PASS | `stopping` refuses new requests; queued work dies with the frame; tested by “after disable” and Plugin E |
| Event handler, timer, token and subscription leaks | PASS | 20 enable/disable cycles; `describe(...).commands/pages/toolbar` stay at one set; no iframe |

### UI extension points

| Point | Status | Evidence |
|---|---|---|
| Pages | PASS | Plugin A page + `PAGES.ext` |
| Navigation items | PASS | toolbar/sidebar assertions; Library section navigation |
| Toolbar actions | PASS | Plugin A click increments the command counter |
| Context menus | PASS | `addContextMenu`; `Extensions.menuItems('canvas:selection')` |
| Commands | PASS | Plugin A/B/C/D; return values are JSON |
| Settings | PASS | Plugin A rotates the greeting in Settings |
| Dialogs | PASS | Plugin D endpoint dialog; form values reach the action command |
| Dashboard widgets | PASS | Plugin A `[data-ext-home]` card |
| Custom resource views | PASS | Plugin C `view-structured-notes` |
| Inspector extensions | PASS | Plugin A inspector render for a selected node |
| Notifications | PASS | Plugin A posts through `notifications.write` |
| Direct unrestricted DOM access | PASS (refused) | Plugin E `parent.document`, storage and popup attempts |
| Design system | PASS | Pages/cards use application classes; screenshots are not part of the automated suite |

### Library and collections

| Item | Status | Evidence |
|---|---|---|
| Create a Library section | PASS | Plugin B `addLibrarySection` |
| Register a collection | PASS | Plugin B/C deployment |
| Create a Custom Node | PASS | `library/script-nodes`, Plugin B nodes |
| Register a set of nodes | PASS | three contributed nodes |
| Create a workflow template | PASS | one project, workflow, Event trigger and placed node |
| Generic Collections API | PASS | Plugin C CRUD and version conflict |
| Update own resources | PASS | plugin-owned node updated in place on 1.1.0; user node untouched |
| Existing data | PASS | records preserved across redeploy and migration; collection definition conflict is reported |
| Server execution without a client | PASS | browser closed, plugin removed, HTTP run in both package tests |

### Security

| Check | Status | Evidence |
|---|---|---|
| Iframe sandbox | PASS | `sandbox="allow-scripts"`, opaque origin |
| CSP | PASS | direct fetch/image blocked; no request reached the recorder |
| postMessage origin/source | PASS | page-forged message ignored; frame navigation/removal detected |
| Capability enforcement in host | PASS | read-only plugin refused write/net/secret/notification |
| Capability enforcement on server | PASS | scoped token test with host layer bypassed |
| Token lifetime | PASS | expiry test (`tests/plugin-tokens.test.js`) |
| Token revocation | PASS | disable and explicit revocation; 401 even with a session cookie |
| Cross-plugin isolation | PASS | foreign command refused; per-plugin storage and token |
| Unauthorized API operations | PASS | diagnostics/events/OpenAPI/auth refused to a plugin token |
| Secret access | PASS | metadata only; server substitution; response scrubbing |
| Network policy | PASS | server allowlist, private-address policy, redirects refused, per-host capability |
| Plugin shutdown | PASS | disable/uninstall removes frame, listeners, styles, registrations and token |
| Plugin HTML sanitizer | PASS | script/SVG script/style/handler/remote image/SVG data removed |

### Environment and data separation

| Item | Status | Evidence |
|---|---|---|
| Two independent servers | PASS | `tests/browser_plugin_platform.py` |
| Two clients | PASS | separate browser contexts in `tests/browser_plugin_platform.py` |
| Different plugin versions | PASS | update path; a newer deployment is not overwritten by an older client (`tests/plugin-deploy.test.js`); two contexts hold 1.1.0 and 1.0.0 |
| Missing plugin on one client | PASS | packages are browser-local; the second context starts with no packages, no pages and no toolbar |
| Plugin resources on one server, none on another | PASS | second server starts without the deployment |
| Re-publishing Library resources | PASS | idempotent redeploy; no duplicate node |
| Identifier conflicts | PASS | owner tag and name checks; foreign node refused |
| Preserving user changes | PASS | records preserved; user node untouched; collection rename kept |
| Client install vs server deployment | PASS | separate actions, separate records |

### Cross-browser

| Engine | Status | Evidence |
|---|---|---|
| Chromium | PASS | `python tests/browser_plugin_platform.py` |
| Firefox | PASS | `AGENTSYS_BROWSER=firefox python tests/browser_plugin_platform.py` |
| WebKit | PASS | `AGENTSYS_BROWSER=webkit python tests/browser_plugin_platform.py` |

## Commands used

```bash
npm test
node --test tests/plugin-manifest.test.js tests/plugin-lifecycle.test.js tests/plugin-deploy.test.js tests/plugin-packages.test.js
python tests/browser_plugin_platform.py
AGENTSYS_BROWSER=firefox python tests/browser_plugin_platform.py
AGENTSYS_BROWSER=webkit python tests/browser_plugin_platform.py
python tests/browser_plugin_security.py
python tests/browser_platform.py
node tools/plugin-pack.js --all client-plugins/reference
node tools/plugin-pack.js --validate client-plugins/reference/ui-showcase/reference-ui-showcase-1.0.0.agentsys-plugin.json
```

## Performance notes

No dedicated plugin benchmark was run; the platform has bounded work rather than a hot path:

- at most 50 packages; 400 KB per file; 900 KB per package; 24 images of 200 KB;
- 8-second activation limit, 3-second lifecycle-hook limit, 20-second command/render limit;
- one iframe per enabled plugin; each reload removes the old frame and its listeners;
- 20 enable/disable cycles in the browser test leave one iframe and one registration set;
- deployment is idempotent and reads the server's lists once per contribution group; a redeploy of the same version
  creates nothing.

The full browser scenario (two servers, one client, five plugins, deployment, execution, three browsers) runs in
roughly one to two minutes per engine on this machine. That is an end-to-end test time, not a claim about production
throughput.

## Limitations and intentional exclusions

1. **No URL installation and no marketplace.** A package is a local file the user picks. This avoids auto-loading
   remote code. The checksum is change detection, not a signature.
2. **No server plugins.** A server never loads plugin code. Server-side work is ordinary data: Library nodes,
   workflows and collections.
3. **The capability boundary does not defend against a modified client or the owner's token.** It defends against a
   plugin inside one browser session.
4. **Deployment never changes a project's security policy.** A deployed node whose grants include
   `collections.write` still needs a project policy that allows it. Plugin B's runnable template uses a node that needs
   only `graph.read`; the collection-writing node is available for projects that grant it.
5. **Scoped CSS can restyle the client.** Install trusted packages.
6. **The 20-second command timeout is not configurable.** It is a safety bound for a crashed frame.
7. **A browser renderer crash is treated as an unresponsive frame.** The host stops it after the invoke timeout;
   there is no separate OS-level crash callback in the platform.

## Verdict

The plugin system is functionally complete for the criteria in this cycle. The public SDK is sufficient to build a
non-trivial extension without application internals: the five reference packages use pages, commands, menus, settings,
dashboard cards, inspector and resource views, Library sections, Custom Nodes, workflow templates, Generic
Collections, network access and server secrets. Deployed server data runs with no client or plugin attached. No
critical unresolved problem was found.
