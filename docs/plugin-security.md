# Plugin security model

## Threat model

A plugin is untrusted JavaScript installed by the user. It must not be able to:

- read or change the application DOM, cookies, browser storage or the server token;
- reach the network except through a permitted server call;
- read a secret value;
- call another plugin, read its storage or use its token;
- perform an API operation its package did not declare;
- keep working after it is disabled;
- persist a server-side hook or route.

A plugin **is** allowed to do what it declared: a `graph.write` plugin writes graphs, a `net.fetch:host` plugin makes
the server fetch that host, and a plugin with a page can draw in the application's layout. Installing a plugin is a
real grant.

## Layers

### Sandbox

Each plugin runs in `<iframe sandbox="allow-scripts">` with an opaque origin, one CSS pixel in size, off-screen. It has
no same-origin access: `parent.document`, `localStorage`, `sessionStorage`, cookies and `fetch` are unavailable.

The sandbox document has a restrictive CSP:

```
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none';
frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'
```

The plugin's own code is plain JavaScript loaded from a blob URL, so `'unsafe-eval'` is needed for modules; the frame
cannot use it to load remote code because `connect-src` is `none` and there is no import/network path.

### Messages

Host ↔ plugin communication is JSON `postMessage`. The host accepts a message only when:

- `event.source === iframe.contentWindow`;
- `event.origin === 'null'` (the opaque blob origin);
- the payload has the `__agentsys: 'plugin'` marker and a known `kind`.

A frame that navigates to a real page changes its origin and is ignored. A message from the application page itself
has a different `source` and is ignored. The plugin side likewise accepts only messages whose `source === parent`.

Pages, cards, settings, inspector content and dialogs are sanitized before insertion: `<script>`, `<style>`, frames,
forms, objects, event-handler attributes, `javascript:`/`vbscript:`/`file:`/HTML data URLs and remote image `src` are
removed. CSS with `@import` or `url(...)` is refused. `data:` images must be PNG/JPEG/GIF/WebP inside an image element.

### Capability enforcement

The host classifies every request and refuses undeclared capabilities. The server repeats the check on a short-lived
token scoped to the plugin's exact capabilities. The server also enforces its unrestricted families: a plugin token
cannot read diagnostics, the event stream, the OpenAPI contract or authentication, and cannot mint another token.
See [plugin-capabilities.md](plugin-capabilities.md).

### Tokens

- Issued only to an authenticated caller.
- Held in the host page's memory, never written to storage, never sent to the iframe.
- Bounded in count and lifetime; diagnostics count them but never print a value.
- Revoked at the issuing server on disable/remove and on environment switch. A revoked token returns 401 even when a
  valid session cookie is also present.
- A 401 caused by a stale token is refreshed once, then the call fails with a readable error.

### Secrets

- A plugin never receives a value. `api.secrets.present` returns metadata only.
- `{{secret:name}}` substitution happens on the server after capability checks.
- A secret in a network URL is refused.
- A response is scrubbed of every stored secret placeholder value before it returns.
- Stored secrets are not listed with values; `GET /api/secrets/<name>` returns `{name, present}`.

### Isolation between plugins

- One iframe per plugin, one message listener per iframe, one scoped token per plugin.
- Storage is namespaced by plugin and environment; the sandbox cannot name another namespace.
- `api.commands.execute` accepts only this plugin's own command name.
- Resource ownership: a deployed Library node may be updated only by the plugin tag that owns it.
- Host bookkeeping (`__agentsys:` storage keys) is unreachable from `api.storage`.

### Shutdown

Disabling or removing a plugin:

1. sets the sandbox to stopping, so a request already in flight from `deactivate` is refused;
2. runs `deactivate` (and `onUninstall` on removal) with a 3-second bound;
3. revokes the token;
4. removes the iframe (killing timers, listeners, workers and pending promises), the message listener, the blob URL,
   every UI registration, styles and commands;
5. leaves private data on disable/reload; deletes it on uninstall;
6. never deletes server data implicitly.

A plugin command that never answers is stopped after 20 seconds; a failed activation is reported and other plugins
continue.

## Independent security tests

| Check | Test |
|---|---|
| Iframe sandbox attribute, no same-origin access | `tests/browser_plugin_security.py` |
| CSP blocks direct fetch and image beacons | `tests/browser_plugin_security.py` |
| HTML sanitizer (SVG script, obfuscated `javascript:` link) | `tests/browser_plugin_security.py` |
| Host refuses write/net/secret/auth/foreign command/notification | `tests/browser_plugin_security.py` |
| Scoped token enforcement with the host layer bypassed | `tests/browser_plugin_security.py`, `tests/plugin-tokens.test.js` |
| Token expiry, revocation, bounded count | `tests/plugin-tokens.test.js` |
| Forbidden operations after disable | `tests/browser_plugin_platform.py` |
| Sandbox escape, storage, session, traversal, forged result, popup | `tests/browser_plugin_platform.py` (Plugin E) |
| Secret not in iframe, page, package or result | `tests/browser_plugin_platform.py` (Plugin D) |
| Message from the page is ignored | `tests/browser_plugin_platform.py` |
| Cross-plugin command/data isolation | `tests/browser_plugin_security.py`, Plugin E |
| Network allowlist and private-address policy | `tests/network-policy.test.js`, `tests/net-allowlist.test.js` |

## Not guaranteed

- A user who modifies the client, or uses the owner's API token directly, is outside this model.
- Scoped CSS can restyle the application; install trusted packages.
- A plugin page can display anything it likes inside its own region; sanitization prevents script, not misleading text.
- The package checksum is not a signature. There is no marketplace and no remote auto-install in this cycle; packages
  are imported from a local file chosen by the user.
- A remote endpoint that transforms a secret (for example, returns it base64-encoded or split) can defeat the
  literal-value scrubber. The plugin never receives the stored value, but an untrusted endpoint can leak a derived
  value; treat a permitted host as trusted for the secrets you send to it.
