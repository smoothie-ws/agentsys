# Roadmap

The current target is the graph-editor MVP described in [Decisions](decisions.md): a persistent live graph interpreter, signals and controlled flow, pause/resume and stop, reusable nodes and imperative plugins.

Further domain-specific features should be developed in plugins against the general application API. They should not introduce application-specific concepts into the execution engine.

General execution infrastructure now includes identified dispatches, independent versioned JSON areas, retained traces, operation checkpoints, explicit retries and optional controlled-run budgets. The non-LLM readiness example exercises parallel parts and server restart. Future controllers should own decomposition, semantic context trees, scheduling, prompts, model selection, token/cost budgets and domain retry/approval decisions. Distributed execution ownership, deterministic replay and restoration of JavaScript stacks are outside the current contract.
