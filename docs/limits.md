# Limits

Execution limits are engine safeguards: 1000 chained reads/signals, 16 simultaneously executing Script segments, 20 MB per node result and 100 MB of current graph results. A Script segment has a 120-second timeout. Waiting in an emission or `node.sleep` releases its concurrency slot and code timer.

Each workflow has one active execution. The number of independent workflows and start events is not capped by admission rules. Stop terminates an execution's Worker. Plugin callbacks have their own bounded execution timeout and package/storage limits.

There are no execution-history retention settings or background scheduling limits.
