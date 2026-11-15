# Integration Studio

Build with `node tools/plugin-pack.js client-plugins/integration-studio`. Import the generated package from Plugins,
review its permissions, then deploy its six Library stages and two Collections to the active server.

Open Integration Studio, add an HTTP connection and check it. The shipped manifest grants local `127.0.0.1` hosts
and the server secret named `integration-demo`; change the manifest and explicitly approve the new permissions
to use another host or secret. For bearer authentication, create the secret through the owner's server UI/API and
enter only its name in the connection. Parameters are a JSON object of URL query values. No secret value is stored
by the plugin. Connections and results are shared server Collections, not private plugin storage.

Build workflow uses the first saved connection. It creates an ordinary saved graph:

`On Run → Read Configuration → HTTP Request → JSON Parse → Response Transform → Store Result → Display Result`

The project owner must approve its runtime policy, independently of plugin installation. For the local fixture:

```json
{"allow":["graph.read","collections.read","collections.write","net.fetch:127.0.0.1:*","secrets.use:integration-demo"]}
```

The graph can then run through the server execution API with the client closed. Reopen the page to see persisted
results. Repeated builds reuse the saved graph. Removing the package leaves the graph, Library and collection data.
The default transform returns `ok`, `path` and a receive timestamp; customize an ordinary Library copy for another
API response shape. Keep custom edits in a copy: package redeployment reports a conflict for an edited definition.

Run `python tests/browser_plugin_certification.py` for an isolated local service, bearer-secret check, headless
execution and browser reconnect. No subscription or external API key is needed.
