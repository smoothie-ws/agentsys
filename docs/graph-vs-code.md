# Graph and code

The graph expresses orchestration: step order, parallel work, waits, approvals, retries and error boundaries that a person needs to see. Code expresses computation inside a step: parsing, transformations and prompt construction. The roadmap recommendation is adopted as the implementation default.

Good: Planner → Task runner → Ask human → Publish. The pending human review is visible, survives restart and has its own permissions. `examples/planner-task-runner.json` demonstrates the first two steps; wait/AI catalogs supply the others. Poor: hide planning, review and publication inside one large Script with unobservable effects.

Good: compute an entire small report with `rows.map(...).filter(...).reduce(...)` in one Script (`examples/code-step.json`). Poor: make an arithmetic node for every operator when the intermediate values do not help a person understand the workflow. Signal branching and loops remain available when their structure matters; an agent's repeated model/tool exchange belongs in the tested Tool-use loop Library node.

`GET projects/{id}/lint` and the canvas show advisory warnings: Scripts over 80 lines, raw Scripts without declarations, loops without a visible bound/budget. These are heuristics, never execution prohibitions. The same API returns script lengths, raw Script count and Library node count. Review actual usage after six months (2027-04-28): if most workflows are one large Script, improve observability, permissions and replay before adding language-like nodes. This future empirical review remains a scheduled project practice, not a claim that usage data already exists.
