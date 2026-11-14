# Plugin testing guide

The plugin platform is covered at four levels: pure contract tests, an API/server test, browser end-to-end tests in
three engines, and a server-only test with the browser closed.

## Commands

```bash
# Everything Node can run without a browser
npm test

# The plugin tests alone
node --test tests/plugin-manifest.test.js tests/plugin-lifecycle.test.js tests/plugin-deploy.test.js tests/plugin-packages.test.js

# Browser end-to-end (requires Playwright)
python tests/browser_plugin_platform.py
AGENTSYS_BROWSER=firefox python tests/browser_plugin_platform.py
AGENTSYS_BROWSER=webkit python tests/browser_plugin_platform.py

# The narrower security scenario
python tests/browser_plugin_security.py
```

`tests/browser_plugin_platform.py` starts two independent servers, one client and a local HTTP endpoint on free ports,
then cleans up. It needs no project data.

## What each test proves

### `tests/plugin-manifest.test.js`

- Semantic version comparison and ranges (`^`, `~`, `>=`, `<`, `||`).
- Format 2 normalization: modules, assets, contributions, metadata, `engines`.
- Format 1 read/export round trip.
- API/engine compatibility, bad versions.
- Safe paths: no `..`, absolute paths, drive letters, backslashes or `.html` files.
- Dependency checks, activation order and cycle detection.

### `tests/plugin-lifecycle.test.js`

- Install, reinstall the same version, enable/disable state.
- Version order and explicit downgrade.
- Missing, incompatible and disabled dependencies.
- Format 2 modules across export and reinstall.
- A record written by the older client.
- Uninstall removes packages and environment-scoped values.
- A sandbox storage key cannot touch the host's reserved deployment key.

### `tests/plugin-deploy.test.js`

- Deployment creates a collection, a Library node and a workflow with a native Event trigger.
- Redeploying the same version creates nothing twice.
- User records survive a redeploy; a user node of another owner is untouched.
- A plugin update changes its own node in place.
- Two servers get independent identifiers.
- The saved workflow runs from an HTTP request with no browser.
- A deployment without the needed capabilities writes nothing.

### `tests/plugin-packages.test.js`

- All five reference packages build from source and validate.
- Every module `require` resolves inside its package.
- No server code, DOM access or remote import.
- Contributions and capabilities match the feature each plugin is meant to demonstrate.
- Built distribution files validate and match the checksum.
- The shipped catalog is empty: installation is always a user action.

### `tests/browser_plugin_platform.py`

Reference Plugin A: page, toolbar, context menu, command, notification, dashboard, settings, inspector, update hook.

Reference Plugin B: Library section, three nodes, workflow template; runs with the plugin disabled; environment
isolation; deploys independently to a second server; switching back restores the first server.

Reference Plugin C: CRUD, server validation, concurrent update conflict, schema migration, resource view,
persistence across reload.

Reference Plugin D: allowed `net.fetch`, server secret not present in the iframe/page/result, deployed node runs on the
server and scrubs the secret.

Reference Plugin E: writes, collection writes, foreign secret read/use, authentication, path traversal, foreign
command, notification, direct fetch, parent document, local/session storage, popup and forged message are refused.

Lifecycle: disabling removes the iframe, registrations and queued work; eight enable/disable cycles leave one sandbox;
failed activation recovers; uninstall/reinstall; a disabled dependency stops its dependant.

Server-only: after the browser closes and the Library Pack plugin is uninstalled, a plain HTTP request runs the saved
workflow and the External Integration node.

### `tests/browser_plugin_security.py`

- Sandbox attribute and opaque origin.
- CSP blocks direct fetch and image beacons.
- Host refuses a read-only plugin's write, net, secret, auth, foreign command, notification and unsafe links.
- The server enforces the scoped token even when the host layer is bypassed.
- Disabling revokes the token; a revoked token is 401 even with a session cookie.
- A failing activation is isolated.

## Writing a test for a new plugin

1. Start with `tools/plugin-pack.js --check` and a manifest/package test.
2. Add the behaviour to a Node test if it is server data (collections, nodes, workflow execution).
3. Add a browser step only for host behaviour (UI registration, sandbox, lifecycle, environment switching).
4. Use a fresh data folder and a fresh browser profile; never reuse the user's project data.
5. Assert the negative case: a refused operation must leave no record behind, not merely throw.
6. Close the browser and run the saved graph over HTTP to prove the server-only boundary.

The reference tests use `browser_context` and per-run temporary folders; they do not rely on the developer's existing
environment list.
