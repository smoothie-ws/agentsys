# Flow control decisions

Waves form a tree addressed by invocation/emit paths. Each wave records its parent, handles, failFast, cancellation and control result. Suspend propagates through an awaiting emit; break/continue and real errors take precedence when their wave cancels a pending wait. User pause remains transient; durable wait releases the Worker. A restarted running segment is interrupted and requires explicit recovery from a saved checkpoint.
