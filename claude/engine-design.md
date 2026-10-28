# Recorded decisions

The roadmap targets an autonomous controller. Initiative names the managed project; Project remains the editor workspace. Persistent state is data, never a serialized JS stack or retained Worker. Invocation paths distinguish repeated/concurrent nodes. A wait checkpoints the wave tree, results, read versions, invocation journal and pending waits; incomplete ancestors restart code and completed children are skipped. Side effects before waits require idempotency with `node.runKey`.

The bridge owns capabilities, external-call tracing, retries and budget reservations. Approvals are durable wait conditions. Canonical text files and immutable SHA-256 snapshots define one format. Runs pin their code; replay substitutes bridge responses and per-invocation time/randomness. See `docs/engine-design.md`, `docs/permissions.md`, `docs/format.md`, `docs/replay.md`.
