# Versions

Each changed workflow or Library node gets a SHA-256 content version. Immutable content is stored at `versions/content/<hash>` and deduplicated. `versions/workflow/<id>` and `versions/node/<id>` contain the current hash and save history. `Context.commit` writes document and history together. Runs pin complete plans, manifests and `version_refs`; later edits and rollbacks cannot change a suspended or active run.

`GET versions/{kind}/{id}` lists saves. `GET versions/{kind}/{id}/{hash}` returns the canonical text files. `POST .../{hash}/restore` makes the selected content current. Controller compares changed files and restores versions. Node restoration invalidates the editor copy so the next opening reads restored code. Version content is deduplicated; finished-run retention is configurable independently.

Storage remains a directory of readable UTF-8 files. Consider moving the journal to a transactional database when exceeding 10,000 runs/day, 5 GB of run logs or one concurrent writer process. The current exclusive queue coordinates one application process; running multiple server writers against one data directory is unsupported.
