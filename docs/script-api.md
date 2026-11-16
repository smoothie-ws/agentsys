# Script API

Scripts execute on the Server in worker threads. `node.input` reads inputs, `node.output` writes outputs,
`node.display` publishes a preview, and `context.state` stores JSON. Named signal emission, data dependencies,
nested Custom Node scopes and recursive execution are specified in [Engine](engine.md) and [Runtime](runtime.md).

`agentsys(method, path, body)` calls the checked backend API. Authority is the intersection of the executing
instance's grants and project policy, including named network hosts and secret references. Worker bridges do
not receive root credentials. Stop aborts the execution signal; an aborted Script cannot start or commit API writes.
Errors use the API error code/message contract and runtime node errors; they do not terminate the HTTP server.

Scripts do not import Client plugins. A plugin-deployed Library Script is ordinary server graph data and runs
without the browser. VM/worker isolation is not an OS sandbox. See [Permissions](permissions.md) and
[Security](security.md), with script, permissions, network-policy and scope-emit regressions.
