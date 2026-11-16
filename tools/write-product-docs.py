from pathlib import Path
import shutil
base=Path(__file__).resolve().parents[1]
s=base.parent/'agentsys-server'; c=base.parent/'agentsys-client'
server_docs={
'ARCHITECTURE.md': '''# Server architecture

The server is a headless Node.js 22+ service. bin/agentsys-server.js owns process
lifecycle; server/api-server.js owns HTTP, authentication, origin/host validation,
SSE and diagnostics. server/file-store.js owns durable files and locking.
headless.js loads a fixed server/manifest.js list into an isolated VM. runtime/
contains authoritative graph, storage, mutation, permissions and execution code.
Script workers are isolated from Node globals and are terminated on shutdown.

No browser application, plugin host, client package or client filesystem is used.
Only JSON over HTTP and SSE cross the product boundary. Runtime implementation
is owned by this repository. Public data formats and conformance fixtures, not
executable shared packages, coordinate independently released products.
''',
'INSTALLATION.md': '''# Installation

Requirements: Node.js 22 or 24. No client installation is needed.

```sh
npm install -g ./agentsys-server-0.4.0.tgz
agentsys-server version
agentsys-server start --port 8080 --data ./data
agentsys-server status --url http://127.0.0.1:8080
```

Use `agentsys-server help` for complete flags. A loopback-only installation can
run without a token. For remote access set AGENTSYS_TOKEN and use --host 0.0.0.0.
Add every browser origin explicitly with --allowed-origin https://client.example.
Store data on a persistent writable filesystem. Never expose that directory with
a static web server. Back up while the server is stopped or use tools/backup.js
from the source distribution. Do not run two servers against one data directory.

Source installation needs no npm dependencies: `node bin/agentsys-server.js start`.
Build an npm artifact with `npm pack`. CLI status exits nonzero when unreachable.
''',
'API.md': '''# Public API

API version 2.0 is independent of server version 0.4.0 and client releases.
Discovery: GET /api/meta. Canonical specification: api/openapi.json, also served
by authenticated GET /api/openapi.json. Authentication, errors, concurrency,
idempotency and SSE semantics are defined in [api/README.md](api/README.md).

Use an explicit Authorization: Bearer header for remote REST and fetch-based SSE.
Never infer compatibility from the application version. Compare the API major;
use feature discovery for optional capabilities. Unknown optional response fields
must not break clients. Conditional writes use If-Match where documented.

```sh
curl http://127.0.0.1:8080/api/meta
curl -H "Authorization: Bearer $AGENTSYS_TOKEN" http://127.0.0.1:8080/api/projects
```
''',
'SECURITY.md': '''# Server security

Enforcement belongs to the server. Explicit bearer credentials or authenticated
sessions are required outside the supported loopback trust mode. Origin and Host
validation are separate from authentication. Configure exact client origins;
wildcard origins with credentials are not supported. Cookie writes require CSRF
headers. Cross-site clients use bearer headers and need not accept third-party
cookies. Scoped plugin sessions are bound to identity and declared capabilities.
The server never installs or executes client plugin packages.

Keep AGENTSYS_TOKEN in a service environment file readable only by the service
owner. Public client config must not contain it. Use HTTPS for remote access;
either configure --tls-cert/--tls-key or terminate TLS at a trusted reverse proxy.
Only enable --trust-proxy for a local trusted proxy. Preserve Authorization and
Origin, disable SSE proxy buffering and allow streaming connections.

Use --deny-private-net and --allow-net to constrain Script network access when
appropriate. DNS-pinned requests prevent policy bypass through rebinding. Keep
data and backup paths private. Never expose server source or secrets as static
assets. See tests/security.test.js, script.test.js and plugin-tokens.test.js.
''',
'DEPLOYMENT.md': '''# Deployment

## Docker

```sh
docker build -t agentsys-server:0.4.0 .
docker run --rm -p 8080:8080 -v agentsys-data:/data -e AGENTSYS_TOKEN agentsys-server:0.4.0 start --host 0.0.0.0 --port 8080 --data /data --allowed-origin https://client.example
```

The image contains no GUI. /data must persist across upgrades. Supply the token
through the container environment or deployment secret facility. Terminate TLS
at a reverse proxy or mount certificate files and pass CLI TLS flags.

## systemd

Install the npm package for a dedicated unprivileged service user. Create a mode
0600 /etc/agentsys-server.env containing AGENTSYS_TOKEN. A unit may use:

```ini
[Unit]
Description=AgentSys Server
After=network.target
[Service]
User=agentsys
WorkingDirectory=/var/lib/agentsys
EnvironmentFile=/etc/agentsys-server.env
ExecStart=/usr/local/bin/agentsys-server start --host 0.0.0.0 --port 8080 --data /var/lib/agentsys/data --allowed-origin https://client.example
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```

Adjust executable paths for your installation. Health: GET /api/meta; operational
diagnostics: authenticated GET /api/diagnostics. Stop gracefully before restoring
data. Test backups before upgrading; versioned release artifacts include the API
contract. Server and client upgrades are independent within API major 2.
'''}
client_docs={
'ARCHITECTURE.md': '''# Client architecture

The client is a static application. index.html loads presentation helpers, the
editing snapshot model, environment transport, UI and sandboxed client plugins.
js/app/environments.js is the single transport for server resources and SSE.
Browser preferences, environment lists and plugin records remain browser-local;
projects, workflows, collections, secrets and runtime state belong to the server.
Switching environments aborts old requests and invalidates caches. Credentials
are scoped to the exact URL and tab session. No server implementation is imported.

client/public-files.json is the exact distribution allowlist. client/build.js
copies only those files to dist/client. Optional bin/agentsys-client.js serves
that artifact and does not proxy API calls. Production needs only static hosting.
''',
'INSTALLATION.md': '''# Installation

For production, unzip the release static artifact into an nginx/Caddy/CDN root.
Serve index.html for application routes; missing asset paths must remain 404.
No Node.js or server package is required. HTTPS clients require HTTPS API URLs.

For the optional local CLI (Node.js 22+):

```sh
npm install -g ./agentsys-client-0.7.0.tgz
agentsys-client serve --port 8081
```

The first visit opens Servers disconnected. Use the Servers action menu to add
an absolute HTTP(S) URL and, when required, a token. Test it, then choose Use this
server. Multiple saved environments can be switched independently of deployment
configuration. An unavailable server leaves the application usable disconnected.

Set config.json to {"defaultServerURL":"https://server.example"} for an optional
installation default. It is public: never add credentials or API keys. Existing
user environments take precedence. The CLI also accepts --server for a default.
Add this client's exact origin to the server allowlist. Do not proxy the API
through this static client to bypass CORS. For nginx use `try_files $uri $uri/
/index.html` only for application routes and return 404 for missing asset paths.
''',
'API-INTEGRATION.md': '''# API integration

The client supports API major 2 independently of application releases. Discovery
uses GET /api/meta, integer protocol major and api_version (major.minor). Optional
capabilities are announced by features. No exact application-version match is
required. Incompatible majors produce an incompatible connection state.

All server reads/writes and event streams use Environment transport. Explicit
bearer headers support cross-origin installations without third-party cookies.
Tokens remain in tab sessionStorage, keyed by environment and exact server URL.
Environment changes abort previous requests and prevent late answers from
updating the newly selected environment. Never replay an ambiguous mutation.
On SSE reconnection reload current resources; the stream has no replay guarantee.

Canonical OpenAPI is published by the server repository with API release 2.0.
This client owns its adapter and model; contract-fixtures contain public JSON
conformance data and introduce no shared executable dependency.
''',
'PLUGINS.md': '''# Client plugins

The client owns Plugin Host, Store, packaging, Integration Studio, Graph Developer
Tools and reference packages. The server accepts ordinary API operations and
does not install client packages. Plugin UI runs in sandboxed iframes with CSP;
Host RPC validates identity and declared capabilities. Server-scoped tokens
independently enforce capabilities for deployed server resources.

SDK: sdk/README.md and sdk/agentsys-plugin.d.ts. The declarations package has its
own package version and can be packed with `cd sdk && npm pack`. It has no server
source dependency. Packaging: `node tools/plugin-pack.js <plugin-directory>`;
see docs/plugin-packaging.md for options. Detailed lifecycle, permissions and
extension points are documented in docs/plugin-architecture.md and docs/plugins.md.

Published Library nodes and workflow templates are server-owned data and keep
executing after a plugin or the whole client disconnects. Uninstalling a plugin
does not silently delete user server data.
''',
'BUILD.md': '''# Build and release

Requirements: Node.js 22 or 24; no external npm runtime dependencies.

```sh
npm test
npm run build
npm pack --ignore-scripts
```

The static artifact is dist/client. The npm artifact includes the static files
and optional CLI. Build before packing; source checkout scripts are not shipped
as public assets. The default generated output can be rebuilt; explicit output
paths must not already exist. All copied source assets must be regular files
without symlink traversal. To produce a ZIP, archive the contents of dist/client.

CI independently tests Node 22/24 on Linux/Windows and uploads the npm artifact.
Cross-product browser verification belongs to the integration repository and
installs the exact independently versioned server and client tarballs.
'''}
for target,docs in [(s,server_docs),(c,client_docs)]:
    for name,text in docs.items(): (target/name).write_text(text,encoding='utf-8')
    with (target/'.gitignore').open('a') as f: f.write('restored-tests.txt\n')
(s/'Dockerfile').write_text('''FROM node:22-alpine
WORKDIR /app
COPY package.json headless.js ./
COPY bin ./bin
COPY server ./server
COPY runtime ./runtime
COPY api ./api
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/meta').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "bin/agentsys-server.js"]
CMD ["start", "--host", "0.0.0.0", "--port", "8080", "--data", "/data"]
''')
(s/'.dockerignore').write_text('.git\nnode_modules\ndata\n*.tgz\n*-tests.txt\n')
