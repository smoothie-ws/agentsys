# Durable execution infrastructure

These APIs extend the live graph; they do not introduce a scheduler, static execution plan or domain-specific task model. Existing graphs need no migration. `context.state` remains shared, durable, nontransactional JSON; ports retain their latest shared values.

## Dispatch identity

`POST /api/projects/{project}/execution` accepts the existing `workflow_id`, `node_ids`, `payload`, `wait` and optional `policy` and `parent_dispatch_id`. A new root dispatch gets a new `run_id`; checked nested API/plugin dispatches inherit that run and link to their caller. An external caller may attach a child to an active dispatch in the selected workflow using `parent_dispatch_id`. Independent Run, editor events and root evaluations get separate identities.

The response keeps runtime fields and adds `run_id`, `dispatch_id`, `parent_dispatch_id`, `parent_invocation_id`, `graph_revision`, `policy` and `dispatch_status`. With `wait:true` it also includes `dispatch_outputs`, a copy of root results for that dispatch. Nonwaiting responses acknowledge durable dispatch admission; their initial status can become stale immediately. Poll the dispatch record for its current status.

Inside Script, immutable `context.execution` contains these IDs plus `invocation_id`. Each actual invocation, including an `on_read` computation, has an identity. Cached/coalesced reads reuse the first caller's computation; cache hits do not invent extra invocations. Parent invocation IDs and signal IDs describe causality without growing invocation IDs with graph depth.

`graph_revision` identifies the live definition observed by an invocation. A running function keeps its revision; subsequent invocations and signal routing use the current definition's revision. Revisions are opaque identifiers, not saved source snapshots or a deterministic replay mechanism. Layout changes may also change the revision.

```js
const started = await agentsys('POST', `projects/${context.project_id}/execution`, {
  workflow_id: context.workflow_id,
  node_ids: ['another-node-id'],
  payload: {part: 'left'},
  wait: false,
});
// This checked child automatically has the caller's run_id and parent invocation.
```

## Independent JSON areas

Use an explicit area ID for independent data. A run ID is a convenient namespace; names are 1–100 letters, digits or `_ . : -`, excluding reserved prototype keys. Values are JSON copies. The backend reuses the application's key-value store, JSON validator and version conflict rules; it does not replace shared runtime state or plugin-private data.

```js
const path = `projects/${context.project_id}/execution/scopes/${context.execution.run_id}`;
const before = await agentsys('GET', path);
const saved = await agentsys('PUT', path, {
  version: before.version,
  value: {result: 42},
  temporary: true,
});
// saved.version is the next version. A stale expected version returns HTTP 409 / code conflict.
```

An absent area returns `{id,version:0,value:null,deleted:true}`. Deletion retains a version tombstone, preventing deletion/recreation from accepting an old writer. `DELETE scopes/{id}?version=N` deletes one area. `DELETE scopes?run_id=ID` removes only temporary areas owned by that run; it never clears user areas or `context.state`. Recreating an area uses its tombstone's version.

CAS is atomic in an IndexedDB read/write transaction or at the local server's file commit boundary. Custom headless stores may implement `compareAndSet(key,version,value)`; without it their mutations are serialized within one backend only. CAS conflicts never silently replace a different area version. Callers decide whether and how to merge and retry.

Storage data is explicit user data, including ordinary keys such as `token` or `op`. Areas and operation inputs/results are not a credential vault. Keep credentials in the application's secret facilities and put opaque references into checkpoints.

## Checkpoints and recovery

Operations are durable records for explicit resumable boundaries. Their inputs, results, structured errors, attempts, idempotency key, parent operation and transition history survive restart. The core validates records and transitions; [sdk/operations.js](../sdk/operations.js) handles callback orchestration outside the interpreter.

Register an operation with `POST operations` using `{id,input,policy,parent_id?,run_id?,idempotency_key?}`. A parent must already exist. Policy is:

| Policy | Meaning |
| --- | --- |
| `safe` | The caller declares repetition safe, such as a deterministic calculation. |
| `idempotent` | The caller supplies the persisted idempotency key to a service that actually supports it. |
| `manual` | Default: an uncertain effect requires a person to decide. |

`PUT operations/{id}` requires `version` and `status`. Allowed transitions are `pending → running/cancelled` and `running → completed/failed/cancelled`. Starting increments `attempt`. A completed record is terminal; ordinary Run does not replay it. Optional `result` and `error` store explicit JSON checkpoint data, separate from metadata-only traces.

On backend initialization, prior `running` operations and active dispatch records become `interrupted`. No JavaScript functions, requests or timers are reconstructed. Graceful Stop changes running operations to `cancelled`. External operations can have an uncertain outcome after failure, cancellation or interruption, even when a stable key makes a retry safe.

`POST operations/{id}/retry` requires the current version and an eligible `failed`, `cancelled` or `interrupted` record. Only `safe`/`idempotent` policies can retry. It moves the record to `pending`; it does not execute an effect. A user may resolve a manual record with `POST operations/{id}/resolve`, choosing `completed`, `pending` or `cancelled` and optionally a verified result. Scripts/plugins cannot access this administrative route.

External Node/controller example:

```js
const {createOperationRunner} = require('./sdk/operations');
// request(method,path,body,query) is an authenticated API adapter.
const steps = createOperationRunner(request, {project_id, workflow_id});
const result = await steps.execute('aggregate', {left:20,right:22},
  async ({input}) => input.left + input.right,
  {policy:'safe', retry:true});
```

The library returns a completed checkpoint's result without invoking its callback. Competing claims use CAS, so only one callback claims a pending attempt. Package this ordinary CommonJS file with an extension to use it with `app.request`; it has no privileged server access. A Script can use the same operation routes through `agentsys` without importing a module.

For an external side effect, use the key provided to the callback:

```js
await steps.execute('publish', {reference:'saved-document'},
  async ({input,idempotency_key}) => request('POST','net', {
    url:'https://service.example/publish', method:'POST',
    headers:{'Idempotency-Key':idempotency_key,'Content-Type':'application/json'},
    body:JSON.stringify(input),
  }), {policy:'idempotent',retry:true});
```

The service must support that header/key. The library cannot provide exactly-once external execution: a crash after an effect but before checkpoint persistence leaves an unknown outcome. It never retries automatically or assumes an HTTP failure means nothing happened.

## Diagnostic history

`GET execution/trace` accepts `workflow_id`, `run_id`, `dispatch_id`, `node_id`, `after` and `limit`. It returns `{events,next,oldest}`. `sequence` is a monotonic cursor; retention can create gaps. Filters select the events retained for the selected workflow. Workflow-wide controls are associated with each active dispatch, or just the workflow if idle.

Events cover dispatch start/end, invocation start/end, signals, waits, errors, flow cancellation, shared state changes, checked API calls, operation transitions and Pause/Resume/Stop. They include available causal IDs and graph revision. API call events record the registered route pattern and method, never dynamic URLs, query strings, headers, code, payloads, response bodies, results or free-form error messages. Dispatch errors persist node IDs and opaque failure codes. Explicit checkpoint results remain user data.

`GET/PUT execution/retention` controls detailed tracing, event count, serialized UTF-8 bytes, age and retained dispatch count. Defaults are enabled, 1000 events, 1 MiB of trace JSON, seven days and 200 dispatch records. Disabled tracing still stores recovery/checkpoint records. Active records are never pruned to satisfy the dispatch count. Trace writes are batched; final dispatch completion and Stop flush them. A crash can lose the last unflushed diagnostic batch, but not acknowledged checkpoints. Expiration is applied on reads and writes; physical cleanup happens on the next write.

Workflow settings → Execution → Execution history opens a compact viewer with links to existing graph nodes. Deleted nodes may no longer be revealable.

## Optional execution budgets

Ordinary workflow execution retains no configured execution quotas. To opt in, send:

```json
{"node_ids":["start"],"policy":{"max_duration_ms":30000,"max_invocations":1000,"max_dispatches":100,"max_parallelism":8,"max_active_operations":8}}
```

Limits are positive safe integers. Checked child dispatches inherit the parent's limits and can tighten them. Invocation/dispatch accounting is shared by the active run tree, including checked plugin dispatches. Parallelism counts active invocation bodies, including those waiting for their branches; reaching it rejects/stops work rather than introducing an implicit queue. `max_active_operations` counts running checkpoint records for the run in the selected workflow. Diagnostics use their separate retention policy.

An exceeded budget produces `dispatch_status:'budget_exceeded'`, distinct from `completed`, `failed`, `cancelled` and `interrupted`. Duration is measured from the run's start, including pauses. A watchdog outside the Worker can terminate synchronous infinite code. A workflow has one shared Worker: hard cancellation of a dispatch/run can also stop other dispatches sharing that workflow's host. The API's per-dispatch DELETE therefore explicitly stops its workflow. Stop propagation reaches checked child workflows and plugin network work. Pause remains cooperative.

Controlled invocations cannot extend their budget through callbacks after completion. Ordinary host callbacks keep their existing JSON/checked API behavior while their host and node are alive. Stop, deletion, host replacement and permission revocation fence stale calls. Run arriving during Stop waits for the stop boundary before using a new host.

## Routes and authority

All routes are under `/api/projects/{project_id}/`; select `workflow_id` in mutation bodies and GET/DELETE queries. The generated `/api/openapi.json` and API page list them.

| Route | Methods | Checked capability |
| --- | --- | --- |
| `execution` | GET / POST / DELETE | run.read / run.start / run.start |
| `execution/pause`, `execution/resume` | POST | run.start |
| `execution/dispatches`, `execution/dispatches/{id}` | GET; DELETE on an ID | run.read; run.start |
| `execution/trace`, `execution/retention` | GET | run.read |
| `execution/retention` | PUT | user only |
| `execution/scopes`, `execution/scopes/{id}` | GET; PUT/DELETE as described above | run.read / run.start |
| `execution/operations` | GET / POST | run.read / run.start |
| `execution/operations/{id}` | GET / PUT | run.read / run.start |
| `execution/operations/{id}/retry` | POST | run.start |
| `execution/operations/{id}/resolve` | POST | user only |
| `node-permissions/{node_id}` | GET / PUT | graph.read / user only |

Plugin conveniences are `app.workflows.run`, `inspect`, `stop`, `dispatch`, `trace`, `getScope` and `setScope`. Other checkpoint operations use `app.request` with exactly the same capability checks. Installation grants and manifests still apply; no extension receives a server-state reference.

## Building independent contexts and an operation tree

Choose an area for each independent context; use versioned writes to maintain its JSON. Represent parent/child work with operation `parent_id` and dispatch causal IDs. Launch independent parts concurrently with ordinary API dispatches, collect results from their areas/checkpoints, and resume only explicitly eligible operations. Persist references rather than relying on `globalThis`. These mechanisms work for data processing, integrations and future controllers alike.

Run `node examples/durable-process.cjs` for a complete non-LLM example. It creates two concurrent Script dispatches, saves separate areas, deliberately fails aggregation, restarts the server, retries under a safe policy and produces 42 without replaying completed parts. It prints its temporary data directory for inspection. The crash regression additionally kills a separate server process while synchronous Script code is running.

## Boundaries

- One authoritative execution backend owns a workflow. In server mode all browser tabs call that backend. A replacement owner fences old journal writers; this is not a distributed multi-server runtime. Custom stores need CAS for writes from multiple backends.
- Shared `context.state` and latest-value ports still permit ordinary concurrent updates. The new area/checkpoint APIs provide opt-in isolation; they do not transact arbitrary JavaScript or external effects.
- Runtime snapshots and the execution journal are separate records. They are not one transaction with each other or with external systems. A `wait:true`/checkpoint storage failure is reported instead of acknowledging durability. Inspect `storage_error` for background persistence failures.
- Operation inputs/results/history and area tombstones remain until workflow deletion; trace/dispatch retention does not delete recovery data. Deleting/duplicating/exporting a workflow continues to handle its ordinary graph/state data. Copies start with new execution histories; checkpoints are not silently replayed or carried as executable work.
- Scheduling, semantic context inheritance/merging, decomposition, prompts, model/provider selection, token/cost accounting, domain retry decisions and approval rules belong in a future controller or plugin. None are core graph entities.
