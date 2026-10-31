# Runtime and validation

The live graph interpreter has no configured limits on signal/read chain length, active Script count, Script execution time, individual result size or total graph results. Its values remain subject to available memory, JavaScript serialization and the application's storage and transport.

This describes the default. Controlled API runs can opt into positive limits on duration, invocation/dispatch counts, active invocation bodies and running operations. Checked children inherit limits and can tighten them. Budget exhaustion has its own outcome. A watchdog acts outside the Worker; hard stopping that Worker affects other dispatches sharing it. There is no implicit admission queue. See [Durable execution](durable-execution.md) for accounting rules, per-workflow active-operation counting and retention.

Stop terminates the graph host, including synchronous code that does not yield. Pause is cooperative: it gates new code and continuations, not arbitrary instructions inside an executing function. A delay accepts a finite nonnegative duration and uses timer-sized chunks internally without an application duration ceiling.

Graph structure must remain valid: existing nodes and ports, compatible wires, acyclic data dependencies and acyclic group/interface bindings. Editor fields, HTTP transport, checked network requests and plugin packages/storage/callbacks have their own validation. These are separate from graph-interpreter execution quotas. API permission checks and secret separation apply regardless of graph size or elapsed work.
