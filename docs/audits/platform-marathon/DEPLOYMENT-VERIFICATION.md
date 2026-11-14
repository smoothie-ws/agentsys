# Deployment verification — what was actually run

Measured on 2026-11-14 on Windows 11 with Node v20.11.0. Anything not run is named as not run: this file does
not claim a check that did not happen.

## Run and verified locally

| Check | Command | Result |
|---|---|---|
| Combined local server | `node server.js --port 0` | starts, redirects `/` to `/editor/`, sends CSP and `X-Frame-Options: DENY` |
| API-only server | `node bin/agentsys-server.js start --port <free> --data <tmp> --quiet` | starts; `GET /api/meta` reports version, protocol and features |
| Client | `node bin/agentsys-client.js --port <free> --server <url>` | serves the interface with CSP; no backend |
| Status command | `node bin/agentsys-server.js status --url http://127.0.0.1:<port>` | prints name, version, protocol, uptime, auth |
| `--help`, `version` | `node bin/agentsys-server.js help` / `version` | usage and `0.3.0 (protocol 1)` |
| Refusing to expose without a token | `agentsys-server start --host 0.0.0.0` with no token | exits 2 with a message naming `AGENTSYS_TOKEN`; tested in `tests/security.test.js` |
| Graceful shutdown | stop the API server with a run in flight | process stops; `close()` waits for the runtime to save; tested in `tests/execution.test.js` |
| One writer per folder | second `start` on the same `--data` | exits with the pid that holds it; tested in `tests/storage-integrity.test.js` |
| Stale lock taken over | lock file with a dead pid | server starts and rewrites the lock |
| Data directory permissions | `UMask=0077` in the unit; files created by the process | documented, not asserted by a test on Windows |
| Backup | `node tools/backup.js --data <tmp> --out <tmp>` | copies, validates JSON, writes `manifest.json`; tested in `tests/backup.test.js` |
| Restore | start a server on the backup folder | projects and collection records return; tested |
| Live backup refused | `tools/backup.js` while a server holds the folder | exits 3 unless `--force`; tested |
| Headless execution | `tests/browser_platform.py` (client closed mid-run) | the run finishes on the server; no client process needed |
| Restart persistence | `tests/browser_platform.py`, `tests/concurrency.test.js` | data returns; the workflow is idle, not re-run |
| CI configuration | `.github/workflows/ci.yml` | written and reviewed; the workflow itself has not run on GitHub from this machine |

## Prepared but NOT run here

| Check | Why not | What to do |
|---|---|---|
| systemd unit | no Linux/systemd here | `deploy/agentsys-server.service`; copy to `/etc/systemd/system/`, `daemon-reload`, `enable --now` |
| nginx reverse proxy | no proxy here | `deploy/nginx-agentsys.conf`; `nginx -t` then reload; the e2e suite already exercises proxy headers only structurally |
| Caddy | no Caddy here | `deploy/Caddyfile` |
| HTTPS with a real certificate | no certificate/domain | `--tls-cert/--tls-key` or the proxy; the cookie becomes `Secure` and the server sets it from `X-Forwarded-Proto` only with `--trust-proxy` |
| LAN from another device | one machine | bind `--host 0.0.0.0 --token …`, add the client origin with `--allowed-origin` |
| After a system reboot | would require changing this machine's services | the unit is `WantedBy=multi-user.target` |

## Reverse proxy expectations

The server does not trust `X-Forwarded-Host` and derives cookies from `X-Forwarded-Proto` only with
`--trust-proxy`. The proxy must pass `Host` unchanged (both example configs do) and must not buffer
`/api/events` (both examples disable buffering). `Host` pinning on loopback is on; a public name reaches the
server through the proxy as `Host: <public name>`, and a remotely bound server accepts any Host unless
`--allowed-host` is given — put it behind the proxy rather than exposing the port.

## Windows service

Not run as a service. `start.bat` and a Task Scheduler entry with
`node bin\agentsys-server.js start --host 127.0.0.1 --port 8080 --data <folder>` are the documented route; the
server's signals are `SIGINT`/`SIGTERM`, and Task Scheduler stops a console process by closing it, which the
server handles as an exit. A controlled restart is `taskkill /PID <pid>` after `agentsys-server status`.
