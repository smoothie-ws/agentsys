# Decisions

Settled design decisions. A decision changes only by an explicit new decision written here.

1. **The graph is interpreted, not compiled.** A running workflow picks up edits without a restart; the plan is live ([Engine](engine.md)). Rejected: "edits take effect only in a new run" (useless for continuous workflows) and "keep the last valid version of a broken node" (hides the error and creates a second path).
2. **A workflow runs continuously and autonomously, for any computation, not only agents.** "Continuous" is graph + state + queues, not a process: work is a series of short activations; there is no permanent environment between runs. The only way to pass data between activations is `node.state` or a queue. A failing activation does not switch the workflow off: it retries with backoff, then fails and is logged; after K consecutive failures the workflow is paused with a visible reason. Run limits (lifetime, size) apply to one activation, not to the workflow.
3. **Signals carry no data.** A stream of items is a queue with a limit and an overflow policy; an item starts an activation. Rejected: "signal with a payload" (breaks independence of receivers and durability).
4. **The core is not agentic.** There is no Initiative, approval entity, budget, AI primitive, linter or eval in the core: they would be imposed on everyone. Agents are built from Custom Nodes now and from plugins later. The core keeps only general mechanisms: the signal engine, flow control, durable waiting, checkpoints and Runs, the permission model, the canonical format, versions, replay.
5. **The model provider/LLM call and Library providers and skills were removed from the core** (2026-10-28): they belong to the AI-controller plugin.
6. **Accounting and the journal live on the bridge**, because a node cannot reliably limit the spending of other nodes. Generic units, quotas, a journal of calls (`bridge_call`) that is the basis of replay. The core does not know what a "token" is.
7. **Human intervention is part of the core**: pause/resume, answering a wait, replacing an invocation's output and restarting from there, cancelling a wave, restoring a node version. "Ask human" is a Library node over `node.wait`, not a core entity.
8. **Rights are checked at node start** against the current version, so editing the graph cannot bypass them; code written by Scripts is quarantined.
9. **Related edits are applied as one batch**, so a running graph never sees half of a wiring.
10. **No legacy.** One way to do a thing; the old way is removed with its code, tests, docs and data.
11. **Plugins are the way to extend the product** (see [Roadmap](roadmap.md)); the core stays small.
