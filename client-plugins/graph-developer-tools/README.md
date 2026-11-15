# Graph Developer Tools

Build with `node tools/plugin-pack.js client-plugins/graph-developer-tools`, import the package and open its page.
The plugin requests only `graph.read`. It lists workflows and summarizes their nodes, connections, dangling links,
disconnected nodes, Custom Node sources and server diagnostics. The Inspector summarizes the open workflow;
the canvas context action stores a summary of the selected IDs for this environment. The toolbar opens the tools page.

All data comes through `api.workflows` and ordinary `api.request` graph snapshots. There is no host DOM access,
canvas global, private import, backend extension or separate interpreter. Reports and selection summaries use
plugin-private browser storage scoped to the active server. Removing the plugin does not modify a graph.

`tests/graph-developer-tools.test.js` exercises invalid links and disconnected nodes; the browser certification test
uses the tools against Integration Studio's saved graph and installs an exported package in a fresh client.
