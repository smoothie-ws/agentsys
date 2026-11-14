# CHECKPOINT-03 — Storage, migration and data integrity

Written 2026-11-14T15:22+10:00.

## 1. What was investigated

`server.js` storage (`fileOf`/`keyOf`, `atomicText`, `commitKeys`, `replayTransaction`, `writeKey`/`removeKey`),
`js/storage/db.js`'s `Context`, `js/storage/format.js` sidecars, `server/migrate.js`, and the data layout on disk.

## 2. Hypotheses checked

- A commit interrupted after its redo record is replayed exactly once. **Confirmed** by writing the record by
  hand and starting a server; a second start changes nothing.
- An unreadable redo record stops the server. **Disproved**: it is renamed to `.invalid` and boot continues.
- A redo record can write outside the folder. **Disproved**: keys are validated; a `../` key is refused.
- A leftover `<file>.tmp-<pid>` is read as data. **Disproved**: it is ignored.
- A corrupted JSON file kills the server. **Disproved**: one request fails with 500 and a redacted message, the
  rest of the API answers, diagnostics records it, and a restart after repair recovers.
- Two servers on one data folder are safe. **Disproved**: each caches and rewrites whole documents, so the last
  save wins. A lock was added; the test starts a second server and is refused.
- Migration is idempotent. **Confirmed** for records and secrets. A defect was found: a later duplicate provider
  without a key **erased** the `{{secret:…}}` reference from the earlier record. Fixed.

## 3. Defects reproduced

Lost writes with two processes on one folder; the duplicate-provider key loss.

## 4. Fixes

`data/.server.lock` with pid, stale-lock takeover and release on close; `AGENTSYS_ALLOW_SHARED_DATA=1` as an
explicit opt-out; migration keeps the migrated key reference when a later duplicate has none.

## 5. Tests

`tests/storage-integrity.test.js` 10/10 (replay, unreadable record, path escape, tmp file, corrupted file, folder
copy as backup including a pending commit, 25 parallel records, sidecar script lifecycle, lock takeover, workflow
deletion), `tests/migration.test.js` 6/6 (duplicates, unreadable plugin data, missing folder, plugin callers,
existing collections untouched), `tests/backup.test.js` 3/3 later.

## 6. Results

Every failure mode in the task list has a test: restart during save, write failure, corrupted JSON, partial
migration, repeated migration, missing files, invalid identifiers, concurrent changes, backup/restore.

## 7. Next

Several clients against one server and against two servers.
