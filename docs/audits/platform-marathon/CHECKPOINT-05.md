# CHECKPOINT-05 — Graph engine regression audit

Written 2026-11-14T15:31+10:00.

## 1. What was investigated

The existing engine suites (30 execution tests, 16 Custom node tests, 8 on_read, 9 Script, 7 engine, 4
scope/emit) and the interpreter's handling of dynamic edits, cancellation, workers and eviction. Then four
scenarios that were not covered:

- a Script creating nodes in its own workflow while running;
- creation repeated until a bound, over several runs;
- a Script deleting its own node mid-run;
- repeated runs and a Stop, checking worker settlement.

## 2. Hypotheses checked

- A node created during a run joins the graph, advances the cursor and runs on the next signal. **Confirmed.**
- A created node is not signalled by being created (so no accidental recursion). **Confirmed**; the bound test
  creates two nodes over three runs and stops.
- A Script that deletes its own node leaves the runtime idle and usable. **Confirmed**; the run settles and the
  next run on the remaining graph succeeds.
- Repeated runs leak workers. **Disproved**: four runs on one worker, Stop terminates it, diagnostics shows every
  runtime idle.
- The engine needed a semantic change. **No**: no defect was found in these scenarios, so no engine code changed.

## 3. Defects reproduced

None. This is a negative result, recorded as such.

## 4. Fixes

None to the engine. `tests/engine-regression.test.js` (4 tests) locks the behaviour in.

## 5. Tests

`node --test tests/engine-regression.test.js` → 4/4. Full suite 306/306 at this point.

## 6. Results

The refactor did not damage the engine's dynamic-editing, cancellation or worker lifecycle behaviour. The
existing coverage (deep chains >1000, delete during await, Stop of synchronous infinite code, idle eviction,
pause/resume, rewiring during a delay, stop of a nested workflow) is credible and was exercised by the suite.

## 7. Next

Long-running behaviour and resource growth.
