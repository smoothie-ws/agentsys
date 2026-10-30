# Library and HTTP from Script

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
  timeout: 10000
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
  headers: {Authorization: 'Bearer {{secret:MY_API_KEY}}'}
});
```

Named secrets and the private API key stored on a Provider are separate storage mechanisms. `MY_API_KEY` must first be created through `PUT secrets/MY_API_KEY` by the user. Provider keys stay private to the owning AI plugin.

## Required permissions

- Library reads need `library.read`.
- HTTP needs `net.fetch:HOST`, including a port when present, for example `net.fetch:localhost:11434`.
- A named secret additionally needs `secrets.use:MY_API_KEY`.

The permissions must be present on the instance and in the project's allow list. For nested placed nodes, the enclosing instances also apply. Library defaults only initialize new instances; they do not restrict later edits. Script code cannot grant itself permissions.

The project allow list is editable in the inspector's Workflow tab under Project permissions. Placed node grants are in Properties / Permissions. Library defaults are in the Library graph editor's Workflow / Default permissions. A standalone Script uses `config.grants`, currently edited through the API rather than a standalone Script permissions form.

For example, from the authenticated application's browser console (user authority, **outside Script code**), configure a standalone Script selected on the canvas:

```js
const project = W.project, workflow_id = W.workflow;
const snapshot = await api(`projects/${project}/workflow`, {query: {workflow_id}});
const script = snapshot.nodes.find(n => W.selected.has(n.id) && n.config?.op === 'script');
if (!script) throw Error('Select a standalone Script first');
const permissions = ['library.read', 'net.fetch:localhost:11434'];
await api(`projects/${project}/typed-nodes/${script.id}`, {
  method: 'PUT',
  body: {workflow_id, node_type: 'custom', config: {
    ...script.config, grants: permissions
  }}
});
const policy = await api(`projects/${project}/policy`);
await api(`projects/${project}/policy`, {
  method: 'PUT', body: {allow: [...new Set([...policy.allow, ...permissions])]}
});
await reload();
```

Changing a node definition through `typed-nodes` requires Developer mode. For HTTP POST to another host, replace the sample host permission with that host. Configuration done by a Script or plugin is quarantined and cannot grant this authority.
