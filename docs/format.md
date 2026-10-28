# Canonical text format

An AgentSys graph, node or catalog is a virtual directory of UTF-8 files. `graph.json` contains `{format:"agentsys.text/1",value:...}`. Object keys are sorted. Collections of nodes, records, edges, types and groups are ordered by ID; port and workflow order remain meaningful. `layout.json` contains positions indexed by their JSON path. Script input defaults are references `{ "$script": "scripts/<path>.js" }`; their source is a real `.js` file with literal newlines.

`TextGraph.encode(value)` is the only serializer; `TextGraph.decode(files)` is the only reader. Import/export APIs transfer `{format:"agentsys.text/1",files:{relativePath:text}}`. A directory can be reconstructed by writing these files. Other JSON export formats are rejected. A file reference must match the supported path pattern; `..`, absolute paths and unknown references are rejected.

For example, a graph with an Event wired to a Script has two records and one edge in `graph.json`, the Script source in `scripts/value-nodes-1-config-inputs-1-default.js`, and positions in `layout.json`. Moving either node changes only `layout.json`; editing code changes only the `.js` file. `examples/format-example/` is executable source for a three-node example.
