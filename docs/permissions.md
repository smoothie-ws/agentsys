# Permissions

A Library node has default permissions (`payload.grants`). Placing it on the canvas copies those values to the new instance. There is no declaration or Library-level runtime permission check: existing instances may allow or deny permissions independently of the defaults. Changing the defaults affects subsequent placements only.

Capabilities include graph.read/write, library.read/write, collections.read/write, run.read/start for workflow inspection and signals, net.fetch:HOST and secrets.use:NAME. `plugins.call` is still accepted in old graphs but no server route grants it; server plugins were removed. Unknown/admin routes are denied to scripts. The host UI represents the user's authority and edits project policy.

In a Library node's graph editor, Workflow / Default permissions edits these placement defaults. On the canvas, Properties / Permissions edits the selected instance. A Script inside nested placed nodes must have permission from each enclosing instance and the project's allow list (Workflow / Project permissions). A standalone Script uses `config.grants`. The source of its code, typed or wired, does not add a permission layer.

Standalone Scripts now have a Properties / Permissions form, including effective grants and project/enclosing constraints. `GET projects/{project}/node-permissions/{node}` exposes these layers; user-only PUT edits standalone `config.grants` without Developer mode. Scripts cannot call that administrative mutation. Reading the runtime needs `run.read`, signalling or stopping it `run.start`. These routes do not loosen live checks or quarantine.

Only actual API calls check these permissions. Ordinary calculations, signals and delays do not require API permissions and are not rejected because an unused permission is absent from project policy. Script-created or modified code is quarantined until explicitly granted by a person.

Each API call checks the current graph's enclosing instances and current project policy. Editing grants affects subsequent calls in an already active host. Reading or changing the workflow's own `context.state` needs no API permission.

Checked HTTP requests use `agentsys('POST','net',{url,method,headers,body,timeout})`. Redirects require a separate checked call. Secrets use `{{secret:NAME}}` placeholders in headers or the body; a placeholder in the URL is refused. Reads return metadata only and reflected credential values are redacted from network responses.

A project can narrow its own network egress in addition to the server allowlist. `PUT projects/{id}/policy` accepts `{allow:[…], net:{allow:["api.example.com"], deny_private:true}}`; `net.allow` is a list of host patterns (port included, `*` allowed), and `deny_private` refuses loopback/private/link-local destinations for that project's Scripts. Omitting `net` keeps the existing egress policy; `net:null` returns to the server's policy. The check is applied to the Script's checked `net` call, after the capability layers, and never weakens the server list.

Scripts run in isolated Workers with networking, imports, worker creation, host messaging and Node globals hidden. Node execution uses a separate VM realm inside the Worker. The inline runner is a trusted test harness; security tests use actual Workers.
