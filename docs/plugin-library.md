# Library and collection extensions

A client plugin can add a Library section, create reusable Custom Nodes, define collections and compose a workflow
template. The server stores and runs all of it without the plugin.

## Library sections

```js
api.ui.addLibrarySection({
  id: 'pack',
  title: 'Library Pack',
  description: 'Nodes and a workflow template',
  icon: 'library',
  render: async () => {
    const nodes = (await api.library.list()).filter(item => item.payload.plugin?.id === api.id);
    return `<h2>Library Pack</h2><ul>${nodes.map(node => `<li>${api.escape(node.name)}</li>`).join('')}</ul>`;
  },
});
```

The section appears in the Library overview and in the Library navigation. Its content is drawn by the plugin's
renderer; the nodes it lists are ordinary server resources.

## Creating a Custom Node

```js
const node = await api.library.createNode({
  name: 'Slug',
  code: "node.output.slug = String(node.input.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  inputs: ['text'],
  outputs: ['slug'],
  grants: ['graph.read'],
  folder: 'Text',
  description: 'A reusable slug node.',
});
```

`createNode` calls `POST /api/library/script-nodes`, which builds a normal Script-backed Custom Node. Its id is
returned. `ensureNode` returns a node with the same name when one exists, so installing twice does not duplicate it.
`updateNode(id, spec)` replaces a node **only when this plugin owns it**; a user's node is refused by the server.

Nodes are owned through a `plugin` tag in their payload: `{id, name, version, checksum}`. The tag is not a security
boundary; the server also requires the caller's `library.write` capability and, for an update, that the tag's id
matches.

A node created this way is a graph with a Script. It is saved and versioned by the server and has no dependency on the
plugin after the call.

## Custom Node code

The code of a Script runs inside the server's graph runtime. It can use the ordinary Script API:

```js
// Read data; every call is checked against the node's grants and the project policy.
const notes = await agentsys('GET', 'collections/notes/records');
const made = await agentsys('POST', 'collections/notes/records', {data: {text: 'from a node'}});
const response = await agentsys('POST', 'net', {url: 'https://example.test/', headers: {Authorization: '{{secret:api-key}}'}});
node.output.id = made.id;
node.display('stored ' + made.id);
```

The `grants` list on the node is its request budget. The enclosing project policy must also allow a capability; a new
project starts with `graph.read` only, so a node that writes collections needs a project that allows
`collections.write`. Deployment never changes a project's security policy.

## Workflow templates

A package can declare a template instead of (or in addition to) creating nodes at runtime:

```json
"contributes": {
  "library": [{"name": "Greeting", "code": "node.display('Hello');"}],
  "workflows": [{"name": "Demo flow", "project": "My pack", "nodes": [{"library": "Greeting"}]}]
}
```

**Deploy resources** creates the project if needed, creates the workflow, places each named Library node and adds a
native Event trigger wired to the placed nodes (`run: false` skips the trigger). Redeploying the same version is
idempotent; a new version updates the plugin's own nodes in place. The deployment record remembers project, workflow,
node and event ids per environment.

The template is ordinary graph data. When saved, the server can run it from its own runtime with no client and no
plugin, which is the required boundary. `tests/plugin-deploy.test.js` and `tests/browser_plugin_platform.py` prove it:
the browser is closed and the plugin uninstalled, then a plain HTTP request starts the workflow.

## Generic Collections

The server has a generic JSON collection API; it gives no meaning to the fields.

```js
await api.collections.define('notes', {
  title: 'Notes',
  schema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']},
});
const list = await api.collections.records('notes', {limit: 20});
const made = await api.collections.create('notes', {title: 'First'});
const updated = await api.collections.update('notes', made.id, {title: 'Second'}, made.version);
await api.collections.remove('notes', made.id);
```

- Names are lower-case letters, digits and `-`.
- Records are JSON objects, at most 1 MB, 10,000 per collection.
- The definition schema supports `type`, `properties`, `required`, `enum`, `items`, `maxLength` and
  `additionalProperties`.
- Each write returns a version. Send the version read with the record as `if_version` to make the next write
  conditional; a stale version is `409 conflict`.
- A schema update keeps records. A collection delete needs `?force=1` when records exist.
- Concurrent writes from two tabs are resolved by the version, not last-write-wins silently.

A resource view can render records:

```js
api.ui.addResourceView({
  id: 'notes',
  title: 'Notes',
  collection: 'notes',
  sidebar: true,
  render: ({records, total}) => `<h2>${total} notes</h2>`,
});
```

## Deploying declared resources

The plugin page's **Deploy resources** button runs `plugin-deploy.js` through the plugin's checked token:

| Contribution | Operation | User data |
|---|---|---|
| Collection | `PUT /api/collections/<name>` | Existing records are never rewritten; `strategy: "update"` changes the definition only |
| Library node | create, or update its own node in place | Other nodes and copies already placed on canvases are untouched |
| Workflow | create project/workflow, place nodes, add trigger | Existing project/workflow names are adopted with a warning; graphs are not deleted |

Deployment is per environment. The record is `{environment, plugin, version, collections, library, workflows}` in a
host-only storage key. Switching servers and deploying again creates new ids on the other server; forgetting the
record does not delete server data.

## Uninstall

Removing the plugin deletes the package and its browser values. It does **not** delete collections, Library nodes,
workflow templates or records. They are ordinary data, shared with the rest of the application, and the plugin page
says so before removal.
