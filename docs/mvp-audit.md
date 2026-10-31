# Implementation audit

The implementation is checked against the live workflow model in [Decisions](decisions.md) and [Engine](engine.md).

| Invariant                                        | Verification                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Run is an ordinary signal                        | Empty on_run sets do no work; repeated Run signals share context and host                         |
| Graph edits are live                             | Code and rewiring changed during a delay affect the next node/emission                            |
| Script completion is explicit in its port schema | Standalone Script chains work through automatic out; a manual emission is additional              |
| Signals own their child work                     | Awaited branches join; nested API dispatch does not wait on its caller                            |
| JSON belongs to the workflow                     | State, outputs and previews survive Stop and backend restart                                      |
| Exported graphs carry state                      | Import preserves arbitrary JSON arrays and objects; duplication remaps node values                |
| Pause preserves work                             | Queued signals wait for Resume; switching editor tabs retains current values                      |
| Stop remains an external interrupt               | A synchronous infinite Script can be stopped while acknowledged JSON survives                     |
| Ordinary execution quotas are absent             | More than sixteen asynchronous bodies, one thousand emissions and a 1200-node chain are exercised |
| Permissions are live                             | Actual API calls use current instance grants and project policy                                   |
| Plugin behavior is executable                    | Packages activate and register owned callbacks, resources and views                               |
| UI responses have ownership                      | Stale polls and responses from another editor cannot overwrite current controls                   |

Browser scenarios also check stable header geometry, explicit-only Library expansion, Script API help, workflow settings, Providers, AI graphs and mobile layout. Run the Node and browser suites described in [Testing](testing.md).

The [durable execution audit](execution-audit.md) records the verified baseline and architectural boundaries. Additive guarantees now include causal identities, CAS areas, bounded metadata traces, explicit operation policies/history and optional budgets. Crash, disk-failure, cancellation and permission tests are listed in [Testing](testing.md); exact limitations are in [Durable execution](durable-execution.md).
