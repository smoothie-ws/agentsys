# Future runtime capabilities

This is a roadmap, not a description of implemented behavior. The platform deliberately contains no
AI-specific server entity: no Agent, Planner, LLMContext, Reasoning or Prompt object. Such systems are built
from the general mechanisms below.

## What the current runtime guarantees

- A workflow has one interpreter and durable JSON state (`context.state`, values, previews).
- Signals can overlap; Pause gates continuations; Stop cancels work.
- Scripts run in isolated workers with checked API access.
- JSON survives restart; JavaScript stacks, timers and external requests do not.
- Idle runtimes are evicted and rebuilt from saved data.
- Multiple clients observe one server; closing them does not stop execution.

## Needed next

1. **Durable checkpoints.** Persist a resumable execution boundary (node, input values, pending signals) at
   explicit points. A restart can continue from a checkpoint without re-running side effects.
2. **Resumable workflows.** A policy per workflow: resume automatically, resume on request, or never resume.
   Side-effecting nodes must be marked and handled idempotently.
3. **Independent execution scopes.** A child graph instance with its own state, permissions and lifetime,
   addressable from its parent. This is the foundation for recursion and parallel decomposition.
4. **Per-task state isolation.** Child scopes do not share `context.state` unless a wire or an explicit
   resource passes a value. Garbage collection follows scope lifetime.
5. **Execution tracing.** A bounded, queryable trace of node starts, completions, errors and emitted signals
   with correlation ids across scopes. Redact secrets and cap retention.
6. **Resource budgets.** Per run/scope limits for wall time, CPU, worker count, memory, network calls and
   output size; cancellation when a budget is exhausted.
7. **Idempotent external operations.** A standard request wrapper with an operation id and a result store, so
   a retry after a crash does not duplicate a side effect. Opt-in per node.
8. **Workflow deployment.** Export a workflow with its Library dependencies, types, collection schemas and
   secret *names* (never values), verify version compatibility, and import it to another server. Do not move an
   active runtime; require a stop and a consistency snapshot.
9. **Distributed execution.** A worker pool beyond one process, with leases, heartbeats and a clearly defined
   failure model. This is only useful after checkpoints and idempotency exist.
10. **Fault recovery.** Detect a dead worker/host, mark affected scopes, and resume from the last checkpoint
    according to policy. Surface an audit trail of what was retried.

## Design constraints

- The graph format (`agentsys.text/1`) should remain the canonical definition; runtime records are separate.
- The server API version must change when a client cannot safely interpret new semantics.
- Secrets never leave the server; deployment moves references, not values.
- Generic collections are the place for plugin-defined records; the server must not grow domain-specific
  tables for providers, prompts or agents.
- Client plugins may author these resources, but execution must never require the client to be running.

## Not planned

- Arbitrary server plugins or in-process extension code.
- Optimistic optimizations based on unmeasured assumptions.
- Automatic migration of a live runtime between servers.
- A second graph engine: new capabilities extend the existing interpreter.
