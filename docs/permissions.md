# Permissions

A Library node has default permissions (`payload.grants`). Placing it on the canvas copies those values to the new instance. There is no declaration or Library-level runtime permission check: existing instances may allow or deny permissions independently of the defaults. Changing the defaults affects subsequent placements only.

Capabilities include graph.read/write, library.read/write, run.read/start for current execution, notifications.read/write, net.fetch:HOST and secrets.use:NAME. Unknown/admin routes are denied to scripts. The host UI represents the user's authority and edits project policy.

In a Library node's graph editor, Workflow / Default permissions edits these placement defaults. On the canvas, Properties / Permissions edits the selected instance. A Script inside nested placed nodes must have permission from each enclosing instance and the project's allow list (Workflow / Project permissions). A standalone Script uses `config.grants`. The source of its code, typed or wired, does not add a permission layer.

Only actual API calls check these permissions. Ordinary calculations, signals and delays do not require API permissions and are not rejected because an unused permission is absent from project policy. Script-created or modified code is quarantined until explicitly granted by a person. Plugin host permissions are configured separately in Plugins.

Checked HTTP requests use `agentsys('POST','net',{url,method,headers,body,timeout})`. Redirects require a separate checked call. Secrets use `{{secret:NAME}}` placeholders; reads return metadata only and reflected credential values are redacted from network responses.

See [Script API examples](scripts-api.md) for Library reads, HTTP requests and permission setup.

Scripts run in isolated Workers with networking, imports, worker creation, host messaging and Node globals hidden. Node execution uses a separate VM realm inside the Worker. The inline runner is a trusted test harness; security tests use actual Workers.
