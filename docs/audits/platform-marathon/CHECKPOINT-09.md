# CHECKPOINT-09 — Deployment, documentation and release engineering

Written 2026-11-14T15:50+10:00.

## 1. What was investigated

Local launch (combined, API-only, client), CLI commands, health endpoints, graceful shutdown, the data-folder
lock, TLS and reverse-proxy requirements, backup/restore, CI, and every document the refactor touched.

## 2. Hypotheses checked

- `agentsys-server status` works against a live server: **confirmed** (printed version, protocol, uptime, auth).
- The CLI refuses to expose an API without a token: **confirmed**, exits 2 with a message.
- A backup taken while stopped is restorable: **confirmed** with the new tool and a boot on the copy.
- A backup of a live folder is refused unless forced: **confirmed** (exit 3).
- A corrupted file makes a backup exit non-zero and is kept for repair: **confirmed**.
- CI could run without dependencies: **confirmed in design** — Node built-ins only; the workflow file is written,
  but has not run on GitHub from this machine.
- Documentation matches the code: three contradictions were found and corrected — the plugin trust statement,
  the test counts, and the missing lock/session-limit/405 facts.

## 3. Defects reproduced

Stale documentation (README plugin model, test counts, deployment gaps); no deployment artefact for systemd or
a proxy; no backup tool.

## 4. Fixes

`.github/workflows/ci.yml`; `deploy/agentsys-server.service`, `deploy/nginx-agentsys.conf`,
`deploy/Caddyfile`; `tools/backup.js` with tests; updates to `README.md`, `docs/deployment.md`,
`docs/testing.md`, `docs/server.md`, `docs/security.md`, `docs/plugins.md`.

## 5. Tests

`tests/backup.test.js` 3/3; CLI checks by hand; the browser suite continues to pass.

## 6. Results

A reproducible deployment path exists and is documented. What was not run here (systemd, a real proxy, Linux,
a real certificate) is named as not run in `DEPLOYMENT-VERIFICATION.md` rather than implied.

## 7. Next

The final independent audit and the report.
