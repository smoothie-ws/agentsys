# Running without a page: the HTTP API, runs, triggers, state

`node server.js` runs the same backend the browser has (`js/storage`, `js/model`, `js/backend`, loaded by `headless.js` into a Node `vm` context) next to the site. It uses the data folder as its store, runs Custom node code in worker threads (one per run; 120 s limit for each node; the whole run is stopped at once when it is cancelled) and ticks the scheduler once a second. So a workflow can be started, watched and changed by a program, by a webhook or by a timer with no browser open. The browser keeps working as before: it uses its own in-browser backend and shares the data folder with the server.

## Reaching it

| | |
|---|---|
| `GET /api/openapi.json` | description of every route (also shown on the **API** page) |
| `GET|POST|PUT|PATCH|DELETE /api/<route>` | the same routes the API page lists, e.g. `POST /api/projects/{id}/runs`. JSON body, query string for `query` parameters. Errors are `{"error": {"code", "message"}}` with the status (400, 404, 409, 429…). |
| `GET /api/runs/{id}/stream` | Server-Sent Events of a run: `run_started`, `node_started`, `node_completed`, `node_failed`, `node_cancelled`, `run_finished` |
| `POST /hooks/{token}` | starts the run of a webhook trigger (see below) |

Who may call `/api` (it can run code, so it is closed by default):

- Bound to loopback (`HOST` unset): the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (others: `ALLOWED_HOSTS=name1,name2`), and every request that changes data must send `X-AgentSys: 1`.
- `AGENTSYS_TOKEN=secret` additionally requires `Authorization: Bearer secret` on every `/api` call (then `X-AgentSys` is not needed).
- On any other `HOST` (e.g. `0.0.0.0`) the API stays off until `AGENTSYS_TOKEN` is set.
- Custom nodes run with the server's privileges, unlike in the browser. Anyone who can call the API can run code as you: keep it on loopback, or use a token.
- `/hooks/{token}` needs no other credential: the token is the secret. It only starts runs of workflows that already exist.

## Runs

A run evaluates a workflow in the background and leaves a trace.

```
POST /api/projects/{project}/runs   {workflow_id?, node_ids?, payload?, wait?}   -> {id, status: "running", …}
GET  /api/runs/{id}                 status, trace of every node (status, ms, error), outputs, errors
GET  /api/runs/{id}/events?after=N&wait=MS   long poll: {events, next, status, finished}
POST /api/runs/{id}/cancel          stops the running node; status becomes "cancelled"
GET  /api/projects/{project}/runs   the history (last 50 per workflow, newest first)
GET  /api/runs                      runs started by this process
```

- Without `node_ids` a run evaluates what the Run button does: every Custom node with code whose outputs are wired nowhere.
- `wait` (seconds, up to 120) answers with the finished run instead of "running".
- Script code sees `context.run_id`, `context.trigger` (`api`, `interval`, `webhook`) and `context.payload` next to `project_id`, `workflow_id` and `node_id`.
- At most 16 runs are active at once (429 beyond that).
- The history is stored as `runs/<id>.json`; outputs above 256 000 characters are replaced by `{truncated: true}` there.

The canvas "Run" button still uses `evaluate-node`; both go through `evaluateGraph`, which compiles a plan, hands it to `runPlan` (one worker for the whole run) and takes an `AbortSignal` and node hooks. The starts of a run are the on_run nodes (or the nodes named in `node_ids`); Scripts reached by different signals run at the same time, so the order of their events is not fixed.

## Triggers

`POST /api/triggers {name, type, project_id, workflow_id?, every_seconds?, enabled?}`; `GET/PUT/DELETE /api/triggers/{id}`; `POST /api/triggers/{id}/fire {payload?}` starts one by hand.

- `interval`: fires every `every_seconds` (10 to 2 592 000) while the server runs; a trigger whose previous run is still going is skipped, not overlapped. `POST /api/scheduler/tick {now?}` is what the server calls each second.
- `webhook`: has a random `token`; `POST /hooks/{token}` with a JSON object body starts a run with that object as `payload`.
- Deleting a project or workflow deletes its triggers.

## State (memory between runs)

A key-value store per project for node code and outside programs.

```
GET    /api/projects/{p}/state[?prefix=&values=true]
GET    /api/projects/{p}/state/{key}                   -> {key, value, revision, updated}
PUT    /api/projects/{p}/state/{key}  {value, if_revision?}
DELETE /api/projects/{p}/state/{key}[?if_revision=]
```

Keys are `A-Za-z0-9_.:-` up to 100 characters; a value is JSON up to 256 000 characters; 500 keys per project. Every write bumps the entry's `revision`; `if_revision` makes a write conditional (0 means "must not exist"), answered with 409 if it does not hold. A script keeps a counter with `agentsys('GET', …/state/count)` then `agentsys('PUT', …, {value, if_revision})`.

## Conditional edits

The workflow snapshot has a `cursor` that grows with every change. Any edit of a workflow may carry `?if_cursor=<cursor>` (over HTTP the `If-Match` header): if the workflow changed since it was read the call is refused with 409 and nothing is applied. This is how two programs (or a program and a person) edit one graph without overwriting each other.

## Export and import

```
GET  /api/projects/{p}/workflows/{w}/export    -> {agentsys, kind: "workflow", name, document}
POST /api/projects/{p}/workflows/import        {name?, document}   -> {id, name, diagnostics}
GET  /api/projects/{p}/export                  -> {agentsys, kind: "project", name, description, workflows: [{name, document}]}
POST /api/projects/import                      {name, description?, workflows: [{name, document}]}
```

A document is `{nodes, layout, style, groups, complex, port_edges, widgets, types}`; node ids are kept as they are. Names that are taken get a number. Import checks the shape (at most 1000 nodes) and returns the graph's diagnostics instead of refusing a graph with problems.

## Data and limits

New files in the data folder: `other/triggers.json`, `other/state__<project>.json`, `runs/<id>.json`. The server notices files edited on disk within a second when a page is open, and within about five seconds otherwise.

## Node hooks

```
GET /api/node-hooks[?workflow_id=]   -> [{at, hook, node_id, project_id, workflow_id, ok, error, ms}]
```

The last 200 firings of on_placed / on_deleted / on_wired / on_widget event nodes (the graph their signal reaches), oldest first (`hook` is `on_placed`, `on_deleted`, `on_wired` or `on_widget`; `error` is set when `ok` is false). They run after the request that placed, removed or rewired the Library node copy has been saved. A run result (`GET /api/runs/{id}`, `evaluate-node`) also has `displays`: `{node_id: text}` for the nodes that called `node.display()` (an image shown that way is a `data:image/...;base64,` URL). `PUT /api/settings {developer_mode: true}` allows making and editing Custom nodes by hand (`typed-nodes` writes and `library/node-editor` answer 403 `developer_mode_required` otherwise).


Controller endpoints: `GET/POST initiatives`, `GET/PUT initiatives/{id}`, collection routes for tasks/decisions/artifacts/facts and `GET .../log`; `POST events/{name}`; `POST runs/{id}/resume` and `/cancel`; `GET approvals`, `GET/POST approvals/{id}`; `GET runs/{id}/budget`; `GET/PUT budgets/{id}`; `GET/PUT projects/{id}/policy`; `PUT/GET/DELETE secrets/{name}` (metadata-only GET); `POST net`; `GET versions/{kind}/{id}`, `GET .../{hash}`, `POST .../{hash}/restore`; `POST runs/{id}/replay`; `GET projects/{id}/lint`. OpenAPI includes every route's required capability in `x-needs`. Graph import/export uses the canonical text envelope, with no old-format fallback.
