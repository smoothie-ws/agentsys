# Artifact integration checks

Build and pack each product in its own repository (`npm pack`; the client build
is performed by prepack). The integration runner installs exact tarballs into
separate temporary prefixes. It does not import product sources or use npm links.

```sh
python tools/artifact-smoke.py
```

Requires Node.js, Python 3.12, Playwright 1.57.0 and installed browser engines.
Set AGENTSYS_BROWSER to chromium, firefox or webkit. The current runner reads
agentsys-server-0.4.1.tgz and agentsys-client-0.7.0.tgz from sibling product
repositories. Only the tarballs are consumed; no source dependency is introduced.
The runner prints the retained evidence directory and records individual checks.

Covered: clean independent installations, no wrong-product code in packages,
CLI startup, discovery, REST project/workflow creation, exact-origin preflight,
unlisted origins, conditional-write conflict, static disconnected boot, browser
Bearer connection, SSE delivery to a second client, independent tab identities,
Library Pack and Integration Studio installation/deployment, switching two
servers with isolated credentials/data, headless Library execution after browser
shutdown, and restart persistence. JSON results are in integration-results/.

One-command local use of prebuilt independent artifacts:

```sh
python tools/local.py --server-artifact ../agentsys-server/agentsys-server-0.4.1.tgz --client-artifact ../agentsys-client/agentsys-client-0.7.0.tgz
```

This creates separate local installations under .local/packages and starts two
processes. Ctrl+C stops both. Persistent server data is under .local/data; --data
can select a different directory. The launcher never imports product modules.
