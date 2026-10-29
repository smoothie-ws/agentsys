# Permissions

A Script has only the capabilities that (1) its Library node's payload (or its own `config`) **declares** in `capabilities`, (2) a person **grants** in `grants`, and (3) the workspace policy **allows** (`GET/PUT projects/{id}/policy {allow: [...]}`). Effective rights are the intersection; missing fields mean none. `x:*` grants a family; hostnames match exactly, port included.

Edit the project policy in the canvas Workflow settings, below Available nodes. It autosaves using the same Allow/Disallow table and specific-permissions field as nodes, and applies to all workflows in the project. Runs contains execution monitoring and history.

Names: `graph.read`, `graph.write`, `library.read`, `library.write`, `net.fetch:<host>`, `run.read`, `run.start`, `notifications.read`, `notifications.write`, `secrets.use:<name>`.

- Every route has method-specific `needs` (OpenAPI `x-needs`). Admin and unknown routes are denied to scripts.
- Rights are checked **at node start** against the current policy and the version's grants; a denied version is `blocked` with a reason and runs no code. Every bridge call checks again, hook calls included.
- **Quarantine:** what a Script writes through the bridge (a node, a Library node, a change of code) comes out with `grants: ["graph.read"]`. A Script cannot give itself or another more than it holds; changed code loses its grants until a person grants them again in the inspector. Code arriving through a wire instead of typed in the node gets only the read grants.
- The host UI/API is the user's authority and can edit policies.

## Network and secrets

`agentsys('POST', 'net', {url, method?, headers?, body?, timeout?})`. Redirects are refused, so each new host needs its own checked call. Credentials go in `PUT secrets/{name} {value}`; `GET` returns metadata only. Use placeholders: `Authorization: "Bearer {{secret:service}}"` (needs `secrets.use:service` as well as the host capability). The host substitutes and redacts reflected values before returning data.

## Isolation

Workers hide networking, imports, worker creation, host messaging and Node globals. On Node, user code runs in a separate VM realm inside the Worker; host callbacks are closures and messages cross as JSON. The browser's CSP restricts imported code to application/blob sources. Denied and sensitive actions are audited in the run log. The inline test runner has **no isolation** — use `scripts: 'worker'` for security tests.
