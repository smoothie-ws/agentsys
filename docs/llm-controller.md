# Building an LLM controller from nodes

AgentSys has no AI in its core. A controller (an agent, a planner, a recursive problem solver) is a graph you
assemble from general nodes, plus one ordinary Script node that calls a model endpoint through the checked
network API. Nothing in that is a server plugin.

## 1. Model access is a standard Script node

Store the key as a server secret (an empty value never returns from a read):

```sh
curl -X PUT https://agentsys.example.com/api/secrets/llm-api-key \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"sk-…"}'
```

Create a reusable Library node through the same API a client plugin uses:

```sh
curl -X POST https://agentsys.example.com/api/library/script-nodes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Ask",
    "folder": "LLM",
    "inputs": ["prompt"],
    "outputs": ["response"],
    "grants": ["net.fetch:api.example.com", "secrets.use:llm-api-key", "graph.read"],
    "code": "const r = await agentsys(\"POST\", \"net\", {url: \"https://api.example.com/v1/chat/completions\", method: \"POST\", headers: {\"Content-Type\": \"application/json\", \"Authorization\": \"Bearer {{secret:llm-api-key}}\"}, body: JSON.stringify({model: \"model-name\", messages: [{role: \"user\", content: node.input.prompt}]})}); node.output.response = JSON.parse(r.text).choices[0].message.content;"
  }'
```

The Script runs in the worker, uses only the checked API, and is aborted by Stop. The secret is substituted
inside the host operation; the page never sees it. The node is ordinary Library data: it keeps working when no
client or plugin is open. See [security](security.md) and [plugins](plugins.md).

## 2. The nodes

| Need | Library node |
| --- | --- |
| Build a prompt | **Template** (`{{data.path}}`; a lone placeholder keeps the value's structure) |
| Read a reply | **Parse JSON** (accepts a code fence; optional schema with `type`, `required`, `properties`, `items`, `enum`, `additionalProperties`) |
| Write JSON | **Stringify JSON** |
| Decide, repeat | **Branch**, **For**, **For each**, **While**, **Break**, **Continue**, **Delay** |
| Remember | **Get State**, **Set State** (the workflow's shared `context.state`, kept across runs and restarts), **Variable** |
| Edit the graph | **Find Library Node**, **Add Node**, **Set Input**, **Connect**, **Get Nodes**, **Remove Node** |
| Run a generated node | **Invoke Node** (waits for it and returns its outputs) |
| Your own logic | **Execute**, or a Script |

All of them are ordinary Library nodes: open one to see or change its graph.

## 3. Recursion without fixed levels

Make the procedure one Custom Node in the Library, for example `Task` with a `problem` input and a `result` output. Inside it: Template → Ask → Parse JSON → Branch on the reply's `kind`. A direct answer goes to verification. A decomposition goes to **For each** child problem: **Find Library Node** (`Task`) → **Add Node** (with `values` such as `{problem: child}`) → **Invoke Node** → collect the result. The node that handles children is the same `Task`, so depth is decided by the model's replies at run time, not by how many copies you drew. Put the limits in the graph: a depth counter passed down in `problem`, a cap on children, and a check for a child equal to its parent.

## 4. What to know about the engine

- **Wires and values.** Signals carry control, data wires carry values. A wired input ignores `input-values`; for an unwired input of a placed node use **Set Input** or pass `values` to **Add Node**.
- **Children are separate instances.** Each generated node keeps its own inputs and outputs, so concurrent children cannot overwrite each other. **Invoke Node** returns the outputs of that call only. The relation parent → child is an invocation, not a wire.
- **Shared memory** is `context.state` (**Get State** / **Set State**): one store per workflow, shared by every child, durable.
- **Stop** cancels the run and everything it started: generated nodes and checked `net` requests. Pause holds new work until Resume.
- **Permissions.** A Script that calls `net` needs `net.fetch:<host>` and, if it uses one, `secrets.use:<name>`; Add Node, Set Input, Connect, Remove Node need `graph.write`; Find Library Node needs `library.read`; Invoke Node needs `run.start`. The project policy must allow them too ([permissions](permissions.md)).
- **Generated nodes are ordinary nodes**: visible on the canvas, inspectable, movable. **Add Node** without a point stacks them below what is already there. Remove them with **Remove Node** when the work is done.
