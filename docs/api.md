# API

`node server.js` runs the same backend the browser has (`js/storage`, `js/model`, `js/backend`, loaded by `headless.js` into a Node `vm` context) next to the site. It stores data in `data/`, runs Script code in worker threads (one per run; 120 s per code segment; a cancelled run stops at once) and ticks the scheduler once a second. A workflow can be started, watched and changed by a program, a webhook or a timer with no browser open.

## Reaching it

| | |
|---|---|
| `GET /api/openapi.json` | description of every route |
| `GET POST PUT PATCH DELETE /api/<route>` | JSON body; query string for query parameters. Errors: `{"error": {"code", "message"}}` with the status (400, 404, 409, 429…) |
| `GET /api/runs/{id}/stream` | Server-Sent Events: `run_started`, `node_started`, `node_completed`, `node_failed`, `node_cancelled`, `run_finished` |
| `POST /hooks/{token}` | starts the run of a webhook trigger |
| `/__data/…` | the browser's storage (reads open; writes need `X-AgentSys`) |

The app lives under `/editor/` (files, `/__data` and `/api` are reached through that prefix too); `/` redirects there. In scripts the same routes are called as `agentsys(method, path, body)`.

### Who may call `/api`

`/api` can run code, so it is closed by default.

- On loopback (`HOST` unset) the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (more names: `ALLOWED_HOSTS=a,b`) and every request that changes data must send `X-AgentSys: 1`.
- `AGENTSYS_TOKEN=secret` additionally requires `Authorization: Bearer secret` (`X-AgentSys` is then not needed).
- On any other `HOST` (e.g. `0.0.0.0`) the API stays off until `AGENTSYS_TOKEN` is set.
- Anyone who can call the API can run code as you: keep it on loopback or use a token.
- `/hooks/{token}` needs no other credential — the token is the secret. It only starts runs of workflows that exist.

## Runs

```
POST /api/projects/{project}/runs   {workflow_id?, node_ids?, payload?, wait?, dedupe_key?}
GET  /api/runs/{id}                 status, per-node trace, outputs, errors, displays, invocations, waves
GET  /api/runs/{id}/events?after=N&wait=MS     long poll
POST /api/runs/{id}/cancel | pause | resume | replay
POST /api/runs/{id}/output | waves/cancel      intervention
GET  /api/projects/{project}/runs   history
GET  /api/runs                      runs of this process
```

Without `node_ids` a run fires every `on_run`. `wait` (seconds, ≤ 120) answers with the finished run instead of `running`. At most 16 runs are active at once (429 beyond).

## Triggers and webhooks

`POST /api/triggers {name, type: interval|webhook|queue, project_id, workflow_id?, every_seconds?, queue?, max_concurrency?, overlap?, enabled?}`; `GET/PUT/DELETE /api/triggers/{id}`; `POST /api/triggers/{id}/fire {payload?}`. A webhook has a random token: `POST /hooks/{token}` with a JSON object starts a run with that object as `context.payload`. Deleting a project or workflow deletes its triggers.

## Conditional and atomic edits

- Every workflow snapshot has a `cursor`. An edit may carry `?if_cursor=<cursor>` (HTTP: `If-Match`): if the workflow changed since, the call is refused with 409 and nothing is applied.
- `POST /api/projects/{project}/batch {workflow_id?, operations: [{method, path, body}]}` (1–200 operations) validates all in one private document and commits once with one atomic plan patch; on error nothing is committed. Supply explicit node ids when creating and wiring in one batch.

## Export and import

```
GET  projects/{p}/workflows/{w}/export  /  POST projects/{p}/workflows/import
GET  projects/{p}/export                /  POST projects/import
```

Files are `agentsys.text/1` packets (see [Concepts](concepts.md)). A workflow has at most 1000 nodes; import returns diagnostics instead of refusing a graph with problems.

## Settings

`GET/PUT /api/settings`: `developer_mode`, `undo_steps` (0–500), `shortcuts`, `style`, `themes`, `theme`, and every run/state/queue limit ([Limits](limits.md)); `GET` also returns the Library (`resources`, `node_folders`) and `limits` with defaults.

## Route catalogue

Generated from the route table (the API page, `/editor/api`, shows the same with parameters and bodies). `projects` is split by what it edits.

### session

| | path | |
|---|---|---|
| GET | `session` | Read the session |

### settings

| | path | |
|---|---|---|
| GET | `settings` | Read or change application settings |
| PUT | `settings` | Read or change application settings |

### search

| | path | |
|---|---|---|
| GET | `search/nodes` | Search nodes across all projects |

### resources

| | path | |
|---|---|---|
| GET | `resources` | List or create Library nodes |
| POST | `resources` | List or create Library nodes |
| GET | `resources/{resource_id}` | Read, change or delete a Library node |
| PUT | `resources/{resource_id}` | Read, change or delete a Library node |
| DELETE | `resources/{resource_id}` | Read, change or delete a Library node |

### project-defaults

| | path | |
|---|---|---|
| GET | `project-defaults` | Suggest a name for a new project |

### projects

| | path | |
|---|---|---|
| GET | `projects` | List or create projects |
| POST | `projects` | List or create projects |
| GET | `projects/{project_id}` | Read, change, rename or delete a project |
| PUT | `projects/{project_id}` | Read, change, rename or delete a project |
| PATCH | `projects/{project_id}` | Read, change, rename or delete a project |
| DELETE | `projects/{project_id}` | Read, change, rename or delete a project |
| POST | `projects/{project_id}/duplicate` | Duplicate a project with its workflows |
| GET | `projects/{project_id}/workflows` | List or create workflows |
| POST | `projects/{project_id}/workflows` | List or create workflows |
| PATCH | `projects/{project_id}/workflows/{workflow_id}` | Rename or delete a workflow |
| DELETE | `projects/{project_id}/workflows/{workflow_id}` | Rename or delete a workflow |
| POST | `projects/{project_id}/workflows/{workflow_id}/duplicate` | Duplicate a workflow |
| GET | `projects/{project_id}/last-run` | Read or store the result of the last run of a workflow |
| PUT | `projects/{project_id}/last-run` | Read or store the result of the last run of a workflow |
| POST | `projects/{project_id}/batch` | Apply related graph edits as one document transaction |
| GET | `projects/{project_id}/workflow` | Read the workflow graph |
| GET | `projects/{project_id}/edit-history` | Read the undo and redo depth |
| POST | `projects/{project_id}/undo` | Undo the last edit |
| POST | `projects/{project_id}/redo` | Redo the last undone edit |
| GET | `projects/{project_id}/node-types` | List node types |
| PUT | `projects/{project_id}/available-nodes` | Include or exclude a Library node or all current nodes in a Library group from this workflow’s Add menu |
| POST | `projects/{project_id}/custom-nodes/{resource_id}` | Place a Library Custom Node on the canvas as one node |
| POST | `projects/{project_id}/typed-nodes` | Create a Custom node |
| POST | `projects/{project_id}/primitives` | Add a Script or an Event node |
| PUT | `projects/{project_id}/primitives/{node_id}/event` | Choose the event of an Event node |
| PUT | `projects/{project_id}/typed-nodes/{node_id}` | Change a Custom node's configuration |
| POST | `projects/{project_id}/split-connections` | Break connections in the middle with a Reroute point |
| PUT | `projects/{project_id}/widgets/{node_id}` | Put widgets on a Custom node, or set the values of its widgets (for Script code that puts widgets on a node) |
| PUT | `projects/{project_id}/widget-values` | A person changed widgets of a node: sets the values and calls on_widget of the node |
| PUT | `projects/{project_id}/input-values` | A person typed into the control of a free input: sets the value (the default of the input) on the node; null takes it away |
| PUT | `projects/{project_id}/output-values` | A person typed into the control of an output that shows one (`editable`): sets the value the node holds there, which is its output until its code sets another; null takes it away |
| GET | `projects/{project_id}/types` | The types this workflow defines (records of named, typed fields; ports use them as t:<id>) |
| PUT | `projects/{project_id}/types` | Replace the types of this workflow (a type that ports use cannot be removed) |
| PUT | `projects/{project_id}/node-slots/{node_id}` | Change the input and output slots of a node (for Script code that manages the slots of a Library node copy); a direction that is left out stays |
| POST | `projects/{project_id}/port-connections` | Add or remove wires between ports |
| PUT | `projects/{project_id}/complex/{group_id}` | Turn a group into a Complex Node, or change its ports, collapsed state or size |
| GET | `projects/{project_id}/graph-validation` | Check the graph for problems |
| POST | `projects/{project_id}/graph-validation` | Check the graph for problems |
| PUT | `projects/{project_id}/groups` | Replace the list of groups |
| DELETE | `projects/{project_id}/groups/{group_id}` | Delete a group with its nodes |
| POST | `projects/{project_id}/delete-nodes` | Delete nodes, optionally reconnecting their wires |
| POST | `projects/{project_id}/copy` | Copy nodes into a clipboard bundle |
| POST | `projects/{project_id}/paste` | Paste a clipboard bundle |
| PUT | `projects/{project_id}/node-style` | Pin, color, collapse (folded) or disable (disabled) a node or group; a disabled group disables everything in it |
| PUT | `projects/{project_id}/node-title` | Rename a Custom node on this workflow (a Complex Node or a group is renamed through its group) |
| PUT | `projects/{project_id}/layout` | Move or resize nodes |
| POST | `projects/{project_id}/evaluate-node` | Evaluate nodes and return their outputs |
| POST | `projects/{project_id}/runs` | Start a run of a workflow in the background |
| GET | `projects/{project_id}/runs` | List the runs of a workflow, newest first |
| GET | `projects/{project_id}/policy` | Read or set the workspace capability allow list |
| PUT | `projects/{project_id}/policy` | Read or set the workspace capability allow list |
| GET | `projects/{project_id}/workflows/{workflow_id}/export` | Export a workflow as one JSON document |
| POST | `projects/{project_id}/workflows/import` | Add a workflow from an exported document |
| GET | `projects/{project_id}/export` | Export a project with all its workflows as one JSON document |
| POST | `projects/import` | Create a project from an exported document |

### node-hooks

| | path | |
|---|---|---|
| GET | `node-hooks` | Read the log of the on_placed, on_deleted, on_wired and on_widget signals that ran without a Run (the last 200) |

### library

| | path | |
|---|---|---|
| GET | `library/node-folders` | List, create, rename or delete Library groups |
| POST | `library/node-folders` | List, create, rename or delete Library groups |
| GET POST | `library/builtin` | List the built-in nodes, or add the ones the Library lacks (`{restore: true}` also those deleted before) |
| POST | `library/custom-nodes/{resource_id}/move` | Move a Custom Node into a group |
| POST | `library/node-editor` | Open the graph editor for a new or existing Custom Node |
| POST | `library/custom-nodes/{resource_id}/duplicate` | Duplicate a Custom Node |

### runs

| | path | |
|---|---|---|
| GET | `runs` | List the runs this application started recently |
| GET | `runs/{run_id}` | Read a run: status, a trace of every node, outputs and errors |
| POST | `runs/{run_id}/cancel` | Cancel a running run |
| POST | `runs/{run_id}/pause` | Pause a running run: no node starts until it is resumed (the nodes already running finish) |
| POST | `runs/{run_id}/resume` | Resume a paused run |
| GET | `runs/{run_id}/events` | Events of a run since `after`, optionally waiting for new ones (long poll) |
| POST | `runs/{run_id}/replay` | Reproduce recorded node versions, plan patches and calls offline |
| POST | `runs/{run_id}/output` | Replace one invocation output and restart dependent work |
| POST | `runs/{run_id}/waves/cancel` | Cancel one wave and its descendants cooperatively |

### events

| | path | |
|---|---|---|
| POST | `events/{name}` | Deliver a deduplicated event to waiting runs |

### triggers

| | path | |
|---|---|---|
| GET | `triggers` | List or create triggers that start runs by themselves |
| POST | `triggers` | List or create triggers that start runs by themselves |
| GET | `triggers/{trigger_id}` | Read, change or delete a trigger |
| PUT | `triggers/{trigger_id}` | Read, change or delete a trigger |
| DELETE | `triggers/{trigger_id}` | Read, change or delete a trigger |
| POST | `triggers/{trigger_id}/fire` | Start the run of a trigger now |

### hooks

| | path | |
|---|---|---|
| POST | `hooks/{token}` | Webhook: start the run of a webhook trigger with the request body as its payload |

### scheduler

| | path | |
|---|---|---|
| POST | `scheduler/tick` | Start every interval trigger that is due (the headless server calls this every second) |

### workflows

| | path | |
|---|---|---|
| GET | `workflows/{workflow_id}/state` | List workflow state entries |
| GET | `workflows/{workflow_id}/state/{key}` | Read, compare-and-set or delete workflow state |
| PUT | `workflows/{workflow_id}/state/{key}` | Read, compare-and-set or delete workflow state |
| DELETE | `workflows/{workflow_id}/state/{key}` | Read, compare-and-set or delete workflow state |
| GET | `workflows/{workflow_id}/queues` | List workflow queues |
| GET | `workflows/{workflow_id}/queues/{name}` | Inspect or configure a queue |
| PUT | `workflows/{workflow_id}/queues/{name}` | Inspect or configure a queue |
| POST | `workflows/{workflow_id}/queues/{name}/push` | Push a JSON item |
| POST | `workflows/{workflow_id}/queues/{name}/pull` | Lease queue items |
| POST | `workflows/{workflow_id}/queues/{name}/ack` | Acknowledge a delivery receipt |
| GET | `workflows/{workflow_id}/control` | Read or configure workflow supervision |
| PUT | `workflows/{workflow_id}/control` | Read or configure workflow supervision |
| GET | `workflows/{workflow_id}/usage` | Read workflow bridge accounting |

### notifications

The bell at the top right of the editor shows these. The core posts nothing yet; plugins and workflows will. A Script or plugin posts with `notifications.write` (a plugin's `source` is always `plugin:<id>`) and reads with `notifications.read`; everything else is `system.admin`. There is no "read" state: a notification is there until it is deleted. At most 200 are kept (the oldest drop); title ≤ 200, text ≤ 2000 characters; `level` is `info|success|warn|error`; `href` is a page of the app.

| | path | |
|---|---|---|
| GET POST DELETE | `notifications` | List (newest first; `?limit=`), post one, or clear all |
| DELETE | `notifications/{id}` | Delete one |

### plugins

Management is `system.admin`; see [Plugins](plugins.md).

| | path | |
|---|---|---|
| GET POST | `plugins` | List installed plugins, or install one from a package |
| GET PUT DELETE | `plugins/{id}` | Read, enable, disable, change the grants of, or remove a plugin |
| GET | `plugins/{id}/ui?path=`, `plugins/{id}/file?path=`, `plugins/{id}/log` | Declared UI assets, one file, recent activity |
| GET PUT | `plugins/{id}/settings` | Settings checked against the declared schema |
| GET PUT DELETE | `plugins/{id}/data[/{key}]` | Private data with compare-and-set |
| POST | `plugins/{id}/bridge` | An API call as the plugin, with the rights it was granted |
| GET POST PUT DELETE | `plugins/{id}/call/{name}` | An endpoint of the plugin |
| POST | `plugins/{id}/templates/{template}/instantiate` | Create a project from a template |

### native Library collections

See [the collection contract](plugins.md#native-library-collections) for schemas, actions, secrets and SKILL.md.

| Method | Path | Purpose |
|---|---|---|
| GET | `library/sections` | Enabled Library section declarations |
| GET POST | `library/sections/{section}/items` | List or create typed resources; GET `?summary=1` omits values/content |
| GET PUT DELETE | `library/sections/{section}/items/{id}` | Read, partially update or delete one resource |
| POST | `library/sections/{section}/folders` | Create, rename or delete a folder |

### secrets

| | path | |
|---|---|---|
| GET | `secrets/{name}` | Store a secret; reads return metadata only |
| PUT | `secrets/{name}` | Store a secret; reads return metadata only |
| DELETE | `secrets/{name}` | Store a secret; reads return metadata only |

### net

| | path | |
|---|---|---|
| POST | `net` | Make a capability checked HTTP request |

### versions

| | path | |
|---|---|---|
| GET | `versions/{kind}/{id}` | List immutable versions and the current pointer |
| GET | `versions/{kind}/{id}/{hash}` | Read a version as canonical text files |
| POST | `versions/{kind}/{id}/{hash}/restore` | Restore an immutable version |
