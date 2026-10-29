# UI navigation audit

## Changes

| Area | Problem | Result |
|---|---|---|
| Workflow settings | Available nodes preceded Types and used large rows and explanatory text | Available nodes follows Types, with compact rows and nested groups |
| Built-in AI | Installation depended on a browser startup request; errors could hide the plugin | The server installs built-ins before accepting requests. Browser-only mode initializes its own registry |
| API reference | Trailing `/` could enter the HTTP API handler; an extra `/` also broke other page reloads | Editor documents and API calls are distinguished, including trailing slashes and IDs containing dots |
| API content | The reference described the browser's route table instead of the running server | File-backed mode uses the server's OpenAPI document; the first call opens immediately |
| Async navigation | A slow response could paint an older project, settings page, Library page, plugin or workflow over the current one | Page identity and render generations reject outdated work, including late iframe mounts |
| Editor exits | Closing the final editor or opening a deep link gave little context for returning | Both editors have a parent link; closing all editors returns to the project or Library folder |
| Settings / Runs sections | Section selection was not consistently represented in the address or browser history | Section URLs support reload, Back and Forward; invalid remembered section indices fall back safely |
| Library / projects | A directly opened nested page could be hidden in a collapsed navigation tree | The ancestors of the selected folder, node, workflow and plugin page open on arrival |
| Native links | Already-addressed links could acquire a second `/editor` prefix; modifier clicks were intercepted | Links normalize once, preserve modifier/native new-tab actions and support copying ordinary links |
| Error destinations | Unknown routes silently became Dashboard; page failures offered an unrelated exit | Unknown addresses show a missing-page view; failures provide a contextual parent link |
| Keyboard navigation | Editor tabs did not consistently support arrow navigation | Editor tabs support arrows, Home/End and the appropriate tab stop; Delete closes an unpinned editor. Phone navigation uses the same section tree in a sheet |
| Phone navigation | Runs/API could trap a tap on the Dashboard destination; changing viewport could retain dialog metadata | Dashboard remains reachable; closing or leaving the navigation sheet clears modal/inert state |

## Coverage

`tests/browser_navigation_audit.py` creates disposable projects, workflows and Library groups. It checks Dashboard,
Projects, project settings, workflows, Library and nested folders, plugin management, AI/Providers/Skills, Settings,
Runs and API reference on desktop and phone. It also exercises search, notification destinations, editor closing,
Back/Forward, middle-click, OpenAPI download, error exits, delayed requests, viewport changes, direct URL reloads
and hash URLs.

Related checks: `browser_navigation.py`, `browser_navigation_fixes.py`, `browser_workspace_layout.py`,
`browser_available_nodes.py`, `browser_runs.py`, `browser_permissions.py`, and the Node test suite.

## Plugin locations

- `plugins/ai/`: source distributed and versioned with the app.
- `js/backend/builtin-plugins.js`: generated package used to initialize a registry.
- `data/plugins/index.json`: installed plugin registry.
- `data/plugins/ai/package.json`: installed AI package.
- `data/plugins/ai/settings.json` and `data/plugins/ai/data.json`: private settings and records when created.

An already running Node process needs a restart to use changed server routing and startup code. Updating browser
assets or an installed plugin package does not replace the running server's code.

## Unified navigation and native Library

All primary sections now use `NAV_TREES`; Settings and Runs select content through URL subsection links. Pages never replace the second panel. Custom plugin pages retain it unless they explicitly declare `navigation` in the manifest. Navigation and page header dots share the same action resolver.

AI collections now live at `/resources/ai.ai`, `/resources/ai.providers` and `/resources/ai.skills`. Skills are physical `SKILL.md` files under `data/library/skills`; provider records are under `data/library/sections`, with credentials separate. Old AI iframe pages and plugin export were removed. See [the final code/UI audit](code-audit.md) and [the native Library API](plugins.md#native-library-collections).
