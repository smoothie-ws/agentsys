# Script API

A Script has signal input `in`, code input `script` and signal output `out`. Code is an async function body: `await` and `return` are available. Successful completion emits `out` automatically. Help is available beside each Script code editor and on the API page. [TypeScript declarations](../sdk/script.d.ts) describe the globals.

## Workflow state

All Scripts in one workflow share `context.state`, a durable JSON object:

```js
context.state.count = (context.state.count ?? 0) + 1;
context.state.items ??= [];
context.state.items.push({count: context.state.count});
node.display(context.state.count);
// out emits when this code finishes successfully
```

Run sends `on_run` signals without clearing state. Stop cancels active work and keeps JSON state, outputs and previews. These values survive navigation and application restart. Active JavaScript functions, timers and requests do not resume after restart.

Assign or delete properties, including nested properties. The root `context.state` reference cannot be replaced. Values must be JSON; functions, symbols, bigint and non-finite numbers are rejected. Keys `__proto__`, `prototype` and `constructor` are reserved. Multi-step updates shared by concurrent Scripts are not transactions.

`globalThis` is the JavaScript host's global object. Custom globals survive successive signals while that host lives; Stop and application restart discard them. Store durable data in `context.state`.

## Node operations

| API                                     | Behavior                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `node.input.name`                       | Initial JSON input value of the enclosing Custom Node                   |
| `node.output.name = value`              | Publish a free data output as JSON                                      |
| `await node.output.name.emit(options?)` | Emit a named signal and join its branches                               |
| `node.output.out`                       | Script's own completion signal; manual `.emit()` adds an extra emission |
| `await node.reread(name)`               | Read an input using current connections and values                      |
| `await node.sleep(ms)`                  | Wait a finite nonnegative duration; Pause gates continuation            |
| `node.display(...parts)`                | Publish text, JSON or `{mime_type, data}` base64 image previews         |
| `await node.widgets(list)`              | Replace this Script's widgets through the checked graph API             |
| `await node.widgets.set(values)`        | Set widget values through the checked graph API                         |
| `node.cancelled`                        | Whether this invocation's signal flow is cancelled                      |
| `node.flow.break()` / `continue()`      | End code and reach the nearest emission handling this control           |
| `node.flow.cancel()`                    | End code and cancel its current signal wave                             |
| `node.flow.abort()`                     | End code and cancel currently dispatched graph flow                     |

Names are exact and case-sensitive. `out` is reserved for Script completion. A Custom Node can publish it by binding an interface signal to the Script port. Other free signal outputs and data outputs belong to the enclosing Custom Node. A signal has no data payload; publish data outputs before emitting. The emission options are `{handles: ['break', 'continue'], failFast: true}`; handled emissions return the control name, or `undefined`. Flow operations unwind with an internal control exception: do not catch it without rethrowing errors with a `control` property. Errors and cancellation do not emit automatic `out`.

Output assignments publish immediately; emissions, API calls, sleep and completion publish nested output object changes too. Graph edits affect subsequent invocations, emissions and rereads; already executing code keeps its current function and initial input values. See [Engine](engine.md) for reads, flow and pause semantics.

## Context

| Property                                       | Value                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `context.project_id`, `workflow_id`, `node_id` | Current project, workflow and Script IDs                                                            |
| `context.instance_id`, `resource_id`           | Enclosing Custom Node instance and Library resource, or null                                        |
| `context.widgets`                              | Initial widget values of the enclosing Custom Node and this Script                                  |
| `context.event.payload`                        | Object supplied with a Run signal                                                                   |
| `context.event.connected`                      | Current connected input names for `on_input_connected`, including an empty list after disconnection |
| `context.event.widget`                         | `{id, kind, label, value}` for `on_widget`                                                          |
| `context.state`                                | Shared durable JSON object                                                                          |
| `context.execution`                            | Immutable run/dispatch/invocation IDs, parent links, graph revision and optional inherited policy      |

Event data follows its signal chain. Other event fields are absent when that event did not supply them.

## Checked application API

Script code uses `agentsys(method, path, body?, query?)`. The paths are application API paths without the `/api/` prefix. Calls are awaited and use the node's permissions. Direct `fetch` is unavailable in the isolated Worker.

## Library

Reusable graph nodes:

```js
const nodes = await agentsys('GET', 'resources');
const text = nodes.find(item => item.name === 'Text');
node.display(text?.name ?? 'Not found');
```

Plugin-owned collections:

```js
const {items} = await agentsys('GET', 'library/sections/ai.providers/items');
const provider = items.find(item => item.values.providerId === 'local');
node.display(provider?.values.baseURL ?? 'Provider not found');
```

Use `GET library/sections` to discover active collections and their IDs. Read an individual item at `library/sections/{section}/items/{id}`. Provider API keys are not returned by these routes.

## HTTP

```js
const response = await agentsys('POST', 'net', {
  url: 'http://localhost:11434/v1/models',
  method: 'GET',
  timeout: 10000,
});
if (response.status < 200 || response.status >= 300) {
  throw Error('HTTP ' + response.status);
}
const data = JSON.parse(response.text);
node.display(data);
```

For a JSON POST, set `method: 'POST'`, `headers: {'Content-Type': 'application/json'}` and `body: JSON.stringify(payload)`. The `net` wrapper returns `{status, text}`; it does not parse JSON or throw for ordinary HTTP error statuses. Stop cancels pending requests from the execution. Redirects need a separate request and host permission.

A named application secret can be used without exposing its value:

```js
const response = await agentsys('POST', 'net', {
  url: 'https://example.com/api',
  headers: {Authorization: 'Bearer {{secret:MY_API_KEY}}'},
});
```

Named secrets and the private API key stored on a Provider are separate storage mechanisms. `MY_API_KEY` must first be created through `PUT secrets/MY_API_KEY` by the user. Provider keys stay private to the owning AI plugin.

## Required permissions

- Library reads need `library.read`.
- HTTP needs `net.fetch:HOST`, including a port when present, for example `net.fetch:localhost:11434`.
- A named secret additionally needs `secrets.use:MY_API_KEY`.

The permissions must be present on the instance and in the project's allow list. For nested placed nodes, the enclosing instances also apply. Library defaults only initialize new instances; they do not restrict later edits. Script code cannot grant itself permissions.

The project allow list is editable in the inspector's Workflow tab under Project permissions. Placed node grants are in Properties / Permissions. Library defaults are in the Library graph editor's Workflow / Default permissions. A standalone Script's Properties / Permissions form edits `config.grants` with user authority and shows effective project/enclosing restrictions. Grant changes do not require Developer mode. A nested Script displays its enclosing permission layers.

External user-authorized tools can use `GET/PUT projects/{project}/node-permissions/{node}` with `{workflow_id,grants:[...]}`. Scripts and plugins cannot authorize themselves. Changing code through `typed-nodes` still requires Developer mode and programmatic changes remain quarantined.

## Independent state and checkpoints

For parallel work, use an area keyed by `context.execution.run_id` and supply the expected version on every mutation. A version conflict is explicit; `context.state` remains nontransactional. Checked nested evaluations inherit execution ancestry and optional budgets. See [Durable execution](durable-execution.md) for scope/checkpoint examples, explicit retry policies, metadata history and cancellation boundaries.
