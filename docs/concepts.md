# Concepts

A project contains workflows. Each workflow is a graph document with nodes, typed ports, wires, layout, groups, Custom Node interfaces and widgets. Project policy constrains checked API access.

An execution captures the current graph, starts its enabled on_run Events and finishes after all signalled work settles. Pause/resume and Stop control the current execution. There is no permanent execution environment or stored history.

Script runs JavaScript when signalled. Event starts a signal chain at workflow start, on a data read or for a Library copy's placement, deletion, wiring or widget interaction. Values are read through data wires; signals carry control without a payload. Reroutes and visual groups organize the graph; a group with an interface becomes a reusable Custom Node.

Library / Nodes contains reusable graphs, edited in private Library workflows. The built-in catalog supplies values, branches, loops, flow control, Delay and previews. More examples live in examples/. Developer mode enables editing primitive definitions; ordinary users can place and configure Library nodes.

Plugins add their own typed JSON collections and behavior through the application API. The bundled Provider collection belongs to its plugin. The core supplies shared presentation, CRUD and credential storage.

The canonical file format is agentsys.text/1. Graph data, layout and script files are separated so a position change touches layout and a code edit touches its script file. The Node server stores these files under data/; static deployments use browser storage.
