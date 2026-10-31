# Durable execution audit

Audit of the working tree before this change (2026-10-31). `npm test`: 211/211 passed.

Already implemented and retained:

- One live interpreter and isolated Worker per workflow; concurrent dispatch ownership, automatic `out`, live edits and cooperative Pause.
- Stop terminates synchronous Worker code and propagates an AbortSignal through checked network/plugin calls.
- Durable shared JSON state, output values and previews; restart does not reconstruct JavaScript stacks.
- API mutations are serialized; graph cursors detect stale edits. Plugin private storage has optional compare-and-set versions.
- API permissions are checked against current instance chains and project policy. Programmatic code edits are quarantined.
- Server multi-key writes use a redo record. Existing tests exercise live rewiring, repeated Run, Stop, restart and real Worker isolation.

Verified gaps:

- Invocation keys are host-local, API responses have no dispatch identity, and read-triggered work has no caller correlation.
- Runtime persistence retains presentation only; it cannot distinguish individual completed and interrupted dispatches.
- Shared state has no transactional multi-step updates. Plugin storage is private to a plugin and is not workflow execution storage.
- No durable operation/checkpoint protocol, explicit retry policy, structured retained trace or optional run budgets.
- Standalone Script grants lack a user form. Existing instance/project forms must retain their autosave behavior.
- Late node closures can still publish shared state after node deletion; host failures need explicit generation invalidation.

Implementation boundaries:

- Reuse the application key-value store and JSON/version validation; add atomic compare-and-set at its storage boundary.
- Keep execution records separate from graph definitions and shared runtime JSON. Do not change signal payloads or latest-value wires.
- Put callback orchestration in a small universal SDK library; core only stores and validates operation transitions.
- Trace metadata only: no payloads, code, request URLs/headers/bodies, results or free-form error text.
- Check persistence failures, races, permission revocation and restart with actual Workers, then run Node and browser regressions.

Cross-backend writes require storage-level CAS. IndexedDB and the local server implement it; custom headless stores must supply CAS for multiple backend instances. A workflow Worker is an execution boundary: forcibly stopping synchronous code also stops other dispatches sharing that Worker.
