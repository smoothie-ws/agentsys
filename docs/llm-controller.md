# Building an LLM controller from nodes

AgentSys has no AI in its core. A controller (an agent, a planner, a recursive problem solver) is a graph that you assemble, plus one plugin that talks to a model. This page lists what is there and how the pieces fit.

## 1. Model access is a plugin

The plugin owns the credentials and the HTTP call, and offers the model as a route and as a Library node. A complete skeleton for an OpenAI-compatible endpoint:

```js
// plugins/llm/main.js
exports.title = 'LLM';
exports.settings = [
  {key: 'baseURL', label: 'Base URL', type: 'text', default: 'http://localhost:11434/v1'},
  {key: 'apiKey', label: 'API key', type: 'password'},
  {key: 'model', label: 'Model', type: 'text'},
];
exports.start = api => {
  api.route('POST', 'chat', async ({body, signal}) => {
    const s = await api.settings.get();
    const response = await fetch(s.baseURL.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...(s.apiKey ? {Authorization: 'Bearer ' + s.apiKey} : {})},
      body: JSON.stringify({model: body.model || s.model, messages: body.messages ?? [{role: 'user', content: body.prompt}]}),
      signal, // Stop aborts the request
    });
    if (!response.ok) throw new Error('Model request failed: HTTP ' + response.status);
    const data = await response.json();
    return {text: data.choices[0].message.content, usage: data.usage ?? null};
  });
  return api.library.addScriptNode({
    name: 'Ask', folder: 'LLM', grants: ['plugins.call'], inputs: ['prompt'], outputs: ['response'],
    code: "node.output.response = (await agentsys('POST', 'plugins/llm/chat', {prompt: node.input.prompt})).text;",
  });
};
```

Always pass the route's `signal` to the request: that is how Stop reaches a model call that is in flight. The key lives in the plugin's settings and is never sent back to the page. See [plugins](plugins.md).

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
- **Stop** cancels the run and everything it started: generated nodes, `net` requests and plugin routes (through `signal`). Pause holds new work until Resume.
- **Permissions.** A node that calls a plugin needs `plugins.call`; Add Node, Set Input, Connect, Remove Node need `graph.write`; Find Library Node needs `library.read`; Invoke Node needs `run.start`. The project policy must allow them too ([permissions](permissions.md)).
- **Generated nodes are ordinary nodes**: visible on the canvas, inspectable, movable. **Add Node** without a point stacks them below what is already there. Remove them with **Remove Node** when the work is done.
