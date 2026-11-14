# CHECKPOINT-11 — Third phase: randomized editing, undo coverage, soak and WebKit

Written 2026-11-14T16:31+10:00, covering 16:20–16:31.

## 1. What was investigated

The editor's undo coverage, the document's invariants under random mutations, the per-process nature of undo
history, long-running behaviour under a bounded loop, and the interface on WebKit.

## 2. Hypotheses checked

- Every editing route is undoable. **Disproved for five**: `primitives` (adding a Script or Event, and changing an
  Event's kind), `split-connections`, `output-values`, `types`, `node-permissions`. A direct reproduction showed
  `history.undo` staying at 0 after adding a primitive, and undo removing an unrelated earlier edit.
- Random sequences of editor operations keep the document valid. **Confirmed** over 5 seeds × 30 accepted
  operations: unique node and edge ids, every edge endpoint exists, every group member exists, every position is
  finite, the cursor never goes back, and redo after undo restores the same document.
- Undo history survives a restart. **Disproved** (it is in memory); now stated in `docs/runtime.md` and asserted
  after a real restart, including that the document itself is durable.
- 60 seconds of create/edit/run/delete is stable. **Confirmed**: 450 cycles, 0 errors, heap 5 → 11 MB, every
  worker terminated, no runtime left running.
- The interface works on WebKit. **Confirmed**; WebKit words a cross-origin fetch to an unreachable server as
  "due to access control checks", which the test now recognises as the expected closed-environment state.

## 3. Defects reproduced

One: five editing routes missing from the undo set (defect 21 in the report).

## 4. Fixes

`primitives`, `split-connections`, `output-values`, `types` and `node-permissions` added to the edit set; the
undo/redo and history contract documented; the soak tool and its thresholds; WebKit support in the interface
check and CI; `tests/browser_ux.py` filters WebKit's wording for the deliberately unreachable environment.

## 5. Tests

`tests/graph-mutation.test.js` 3/3 (random mutations, a run after mutation, undo coverage for all five routes);
`tests/soak.test.js` 1/1 (8 s, fixed thresholds); `tests/storage-integrity.test.js` 12/12 (undo is per process);
`browser_ux.py webkit` 8/8. Node total **343**.

## 6. Results

The editor's undo now covers every route that changes the document, and the randomized test gives the document
an invariant check beyond hand-written cases. The bounded soak is the reference for long runs; a 24-hour run
still needs a host that stays up. The client is verified on Chromium, Firefox and WebKit.

## 7. Next

A 24 h soak on a Linux host, the systemd/nginx/TLS deployment run, and file-descriptor sampling.
