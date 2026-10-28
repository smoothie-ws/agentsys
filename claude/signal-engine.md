# Signal engine decisions

`docs/signal-engine.md` is the public contract. `node.wait` is the sole durable wait API and `node.resumed={key,value}` is the continuation input. There is no promise/closure serialization. A resumed invocation executes from the beginning. Completed sibling invocations are not replayed live. Parallel branches drain before a checkpoint; cancellation prunes waits in cancelled waves.
