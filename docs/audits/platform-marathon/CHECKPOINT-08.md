# CHECKPOINT-08 — API, performance and compatibility

Written 2026-11-14T15:45+10:00.

## 1. What was investigated

Every route in `Backend.openapi()`: methods, bodies, query parameters, validation, error shapes, pagination,
cursors, version reporting, and whether a caller depends on a particular client.

## 2. Hypotheses checked

- A known path called with the wrong method answers 405. **Disproved** — it answered 404, which hides a typo in
  a client. Fixed with an `Allow` header and `method_not_allowed`.
- A malformed body writes nothing. **Confirmed**: 400 with `invalid_request`, no partial write.
- Every answer, including errors, reports the protocol. **Confirmed**.
- Discovery is public and carries no secret. **Confirmed**.
- Pagination is bounded and invalid numbers fall back to defaults. **Confirmed**; the cap is 500.
- An older client without If-Match or the CSRF header (bearer) still works. **Confirmed**.
- The answer depends on a client header. **Disproved**: none is required or read.
- The contract reports the running version. Was hard-coded; fixed earlier in the cycle.

## 3. Defects reproduced

405 reported as 404.

## 4. Fixes

`Backend.request` finds the path's methods and answers 405 with them; the server sets `Allow`.

## 5. Tests

`tests/api-contract.test.js` 8/8; `tests/security.test.js` also checks the OpenAPI structure, and
`tests/resource.test.js` measures the hot paths.

## 6. Results

The public contract is explicit and tested: methods, validation, codes, pagination, cursors, version and
client independence. Performance is recorded in `BENCHMARKS.md`; no optimisation was made without a measured
bottleneck, and none was found in the tested paths.

## 7. Next

Deployment artefacts, documentation and the final audit.
