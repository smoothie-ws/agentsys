# Audit (platform cycle)

Baseline: `main` at `7cca21e`, Node v20.11.0, Windows. `npm test` was **245 pass, 0 fail** (~9.5 s).
This audit was taken before any change in the `platform/server-client` branch; the final suite is **242 pass**
because the server-plugin tests were replaced by platform, client-plugin and migration tests. Findings marked
**confirmed** were reproduced by reading the code and/or running it; assumptions are marked as such.

## What the application was

- `index.html` loaded the entire application: storage, graph model, interpreter, backend routes, client UI and
  the canvas. The same `Backend` object answered `/api` on the server and ran in the browser.
- `server.js` served the UI, the API (`/api`), raw browser storage (`/__data`) and loaded server plugins.
- `plugin-host.js` required `data/plugins/<id>/main.js` **inside the server process** and gave it arbitrary API
  access, route registration and access to secrets.
- Projects, workflows, Library resources, runtime state, secrets, UI preferences and browser-storage keys all
  lived in one `data/` tree with no owner boundary.
- The only client/server distinction was "does `/__data` answer?" (`DB.mode === 'files'`); there was no
  environment concept, and every request used a fixed `/api`.

## Confirmed defects and architectural problems

| # | Area | Finding | Evidence |
|---|---|---|---|
| A1 | Security | Server plugins executed arbitrary code in the main server process and could register any API route. A broken plugin could observe or replace application behaviour; there was no manifest, sandbox or permission list. | old `plugin-host.js` (now `legacy/server-plugin-host.js`); `server.js` created the host at boot. |
| A2 | Security | Plugin routes were registered as `unlocked` and their handler did its own checks, so the main permission layer did not cover `plugins/{id}/{name}` consistently. | old `routes-plugins.js` (now `legacy/routes-plugins.js`). |
| A3 | Security | The API had no CORS policy and no Origin validation. A tokenless loopback server relied on the `X-AgentSys` header alone; a cookie/session model did not exist. | `server.js` `refuse()`. |
| A4 | Security | Server-Sent Events were reachable only through `/__data/events`, and `EventSource` cannot send an `Authorization` header. A remote, token-protected server therefore could not stream state to a browser. | `js/storage/db.js` `new EventSource(API + '/events')`; `server.js` token checks. |
| A5 | Security | Bearer tokens, if configured, were usable in a query string by any caller; the client kept the token in memory only because there was no session flow. | `server.js` `tokenGiven()`; no session endpoint. |
| A6 | Client/server | The browser loaded the interpreter (`js/model/executor.js`), backend routes and the storage layer. A client tab was a second implementation of the server and could run graph code locally when `/__data` was absent. | `index.html` script list; `DB.mode`. |
| A7 | Client/server | `headless.js` read the server's script list from `index.html`, so a client asset change silently changed which code the server loaded. | `headless.js` regex over `index.html`. |
| A8 | Data | UI state (`tabs`, camera, clipboard, panel sizes) was stored on the server in `data/other/ui-state.json` and written through the graph API. Closing a browser could not reset it; two clients shared it. | `js/app/helpers.js` `store`; `PUT ui-state`. |
| A9 | Data | No migration path existed from server-plugin data (for example provider configurations and API keys) to normal server resources. | `data/plugins/ai/data.json`; plugin host data keys. |
| A10 | Runtime | The live runtime was owned by the server, which was correct, but the client assumed it could also call `Backend.subscribe` and `Backend.subscribeHooks`; neither could be provided by a remote server. Hook failures were invisible when the client was closed. | `js/app/shell.js`, `canvas/run.js`, `extensions.js`. |
| A11 | API | There was no version handshake. A client could not distinguish an old server, a wrong address or a plain web server. | no `/api/meta`. |
| A12 | Operations | `server.js` only accepted `--port`; there was no `status`, `version`, data-folder option, token flag, TLS or graceful shutdown contract. | end of `server.js`. |
| A13 | Packaging | The server and client were one process and one static tree. It was impossible to run a server without shipping the GUI or to point a client at another machine. | `createServer` served static files and `/api`. |
| A14 | Tests | Plugin tests exercised the privileged server host, so they implicitly required arbitrary code execution in the server. No test covered a client with no backend. | `tests/plugins.test.js`, `tests/plugins-controller.test.js`. |

## Confirmed defects found while splitting the code

| # | Finding | Fix |
|---|---|---|
| B1 | `parentPath` and `underPath` were defined in `js/backend/routes-library.js` but used by client navigation and Library pages. Removing the backend from the client made those pages throw `ReferenceError`. | Moved them to `shared/core.js`. |
| B2 | `GRAPH_RANGES` and `WIRE_STYLE_IDS` were defined in `js/backend/settings.js` but used by the client Settings page. | Moved them to `shared/core.js`; the server keeps validation alongside the API. |
| B3 | `checkManifest` was defined in `js/backend/permissions.js` but called by the client graph editor. | Moved the validator to `shared/core.js`; the server still calls it at every API boundary. |
| B4 | `/api/library/sections` was registered by `routes-plugins.js`. Without the plugin host the client's `loadLibrary()` failed at boot with "API endpoint not found". | The endpoint is now a fixed, empty server route in `routes-library.js`; client plugins add their own pages in the client. |
| B5 | The combined server's static allowlist served `js/backend/*`, `js/storage/db.js` and `js/model/executor.js` to any browser. | Static serving now rejects the server-only set from `server/manifest.js`. |
| B6 | The client's UI store wrote every change to the server (`PUT ui-state`) even for a theme toggle. | Replaced by a browser-local store with a one-time import of old server state. |

## Assumptions (not proven in this cycle)

- **Mixed content.** A browser served over HTTPS will block HTTP API calls to a plain server (except some
  loopback exemptions). The client reports the network failure; it does not bypass the browser policy. This was
  reasoned from browser rules, not measured on every browser.
- **Private Network Access.** Chromium may require a preflight or a user permission when a public page calls a
  private address. The client reports the resulting CORS/network error; an HTTPS reverse proxy or VPN is the
  documented answer.
- **Mobile canvas.** The environment indicator, environment page, project/workflow navigation and run controls
  use the existing responsive layout. A new mobile canvas review was not performed.
- **TLS.** The HTTPS option uses Node's `https.createServer` with supplied PEM files. The automated suite starts
  plain-HTTP servers; TLS itself was not exercised end-to-end.
- **Plugin isolation strength.** The iframe sandbox prevents direct DOM/storage/cookie access, but an installed
  plugin can still call any API this user can. It is not a defence against a malicious user-installed plugin.

## Technical debt that remains

- `server.js` is still the combined local/test server (UI + API + `/__data`). The production CLI uses
  `server/api-server.js`, which is API-only. The combined file is retained so the existing regression suite and
  the `/editor/` convenience mode keep working; it is not the deployment server.
- The client still loads `js/model/editor.js`, `js/model/evaluate.js` and the schema for fast local validation.
  It does not load `executor.js` and cannot execute a Script.
- Sessions are in memory. A server restart invalidates session cookies; the client renews from its per-tab token
  once, otherwise asks for the token again.
- Collections validate a documented JSON-Schema subset, not every JSON Schema keyword.
- Client plugins have no per-plugin capability declaration; installing one is an act of trust, as documented.
- Durable checkpoints, resumable JavaScript stacks and distributed execution are not implemented; see
  [future-runtime](future-runtime.md).
