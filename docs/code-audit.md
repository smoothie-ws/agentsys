# Code and UI audit — 2026-10-29

Historical record of the earlier UI pass. For the current broad review, unresolved issues, measurements and validation, use the [full audit](full-audit-2026-10-29.md). Navigation descriptions below may predate the later changes.

Reviewed the shared shell, routing, page renderers, Library, plugin package lifecycle, storage, permissions and execution boundaries. The engine and HTTP behavior were also checked through the full automated suite. This records verified findings; it does not claim that arbitrary future plugin code is error-free.

| Criterion | Findings and changes |
|---|---|
| Duplication | One navigation registry and row renderer for every primary section. Plugin page trees share a renderer. Headers, cards, action menus, permission tables and settings save lifecycle use shared primitives. Built-in plugin output is generated from its source, rather than edited separately. |
| Complexity | Removed page-specific secondary navigation, remembered-URL redirects, duplicate mobile section tabs, plugin export and the custom AI iframe catalog. Native collections use declarative fields and a shared resource API. Graph editing remains in its existing graph editor. |
| Correctness | Validated hierarchy, cycles, resource fields, names and identifiers. Checked credential isolation, folder cascades, skill rename and physical Markdown persistence. Plugin removal also clears collections retired by a package update. Bundled upgrades preserve disabled state and user records. |
| Predictable behavior | Links open their stated destinations. Back/Forward and direct URLs select the same subsection. Saves finish before navigation and menu mutations; failed saves expose a stay/discard choice. Project settings names follow normal autosave. Saving a workflow policy no longer collapses its diagnostics or redraws the page. |
| Consistency | The primary rail selects a section; its permanent second panel selects a subsection/item. Plugins change it only with an explicit declaration. Navigation and page dots resolve the same action definitions. Collection, group and item menus are scoped to their respective objects. |
| Reuse | Nodes, Projects, workflows, plugins and native Library resources use common cards and page headers. Custom resources use the same editor and permission primitives. Skills use canonical SKILL.md rather than duplicate instruction fields in JSON. |
| Composition and colors | Plugin details now separate icon/title, concise metadata, content tabs, overview and a details column. Shared theme tokens control colors. Mobile keeps action dots at the top right, all seven primary destinations remain reachable, and the secondary panel opens the same tree in a sheet. Obsolete control styles were removed. |

## Verification

- `node --test`: **305 passed**, including runtime, permissions, plugin lifecycle, resource schema/CRUD, migration, cleanup, HTTP and server restart coverage.
- Browser checks passed: `browser_catalog.py`, `browser_navigation_audit.py`, `browser_workspace_layout.py`, `browser_navigation_fixes.py`, `browser_permissions.py`, `browser_available_nodes.py`, `browser_runs.py`.
- Checked desktop/mobile layouts, direct and hash URLs, native links, Back/Forward, delayed responses, editor exits, settings, API reference/download, plugin frames and explicit navigation overrides.
- Inspected screenshots of plugin details and mobile Library; no browser page errors occurred in the listed checks.

## Boundaries

The built-in AI plugin manages provider configurations and Skills. It does not execute model requests, resolve environment credentials, perform OAuth or claim a successful connection. Its provider data model is based on [OpenCode](https://opencode.ai/docs/providers/); skill files follow [Agent Skills](https://agentskills.io/specification). Plugin metadata and overview structure use [VS Code extension conventions](https://code.visualstudio.com/api/references/extension-manifest) and the title/author/details hierarchy of [s&box package pages](https://sbox.game/facepunch/sandbox) and [Steam Workshop items](https://steamcommunity.com/sharedfiles/filedetails/?id=160250458).

Checks ran against disposable data directories. Changes to backend routes and bundled startup require restarting an already running Node server.
