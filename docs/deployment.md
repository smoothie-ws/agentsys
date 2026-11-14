# Deployment

## Local desktop

```sh
npm start
```

`bin/agentsys-local.js` starts two processes:

- AgentSys Server on `127.0.0.1:8080`, data in `./data`.
- AgentSys Client on `127.0.0.1:8081`, with `http://127.0.0.1:8080` as the default environment.

`start.bat` does the same on Windows. Closing the browser leaves the server running; the workflow continues.
Use Ctrl+C in the server console to stop it. A token is not needed on loopback.

Separate commands, if you prefer:

```sh
npm run server -- --port 8080 --data ./data
npm run client -- --port 8081 --server http://127.0.0.1:8080
```

## LAN

1. Start the server on a stable address with a token:

   ```sh
   AGENTSYS_TOKEN="$(openssl rand -hex 32)" node bin/agentsys-server.js start \
     --host 0.0.0.0 --port 8080 --data /srv/agentsys/data
   ```

2. Serve the client from any static host, or from another machine:

   ```sh
   node bin/agentsys-client.js --host 0.0.0.0 --port 8081 --server http://192.168.1.20:8080
   ```

3. In the client, open the **Server** row in the sidebar, then its **⋯** menu → **Add server**; enter `http://192.168.1.20:8080` and the token. Add the
   client origin to the server's allowlist if it is not the same origin:

   ```sh
   --allowed-origin http://192.168.1.20:8081
   ```

LAN HTTP is acceptable only on a trusted network. For anything else use HTTPS.

## VPS with HTTPS

The recommended layout is: the server listens on loopback; a reverse proxy owns the public name and TLS.
Ready-to-edit files are in `deploy/`: `agentsys-server.service` (systemd, with hardening),
`nginx-agentsys.conf` and `Caddyfile`.

```ini
# /etc/systemd/system/agentsys-server.service — see deploy/agentsys-server.service for the full unit
[Unit]
Description=AgentSys Server
After=network.target

[Service]
Type=simple
User=agentsys
Group=agentsys
WorkingDirectory=/opt/agentsys
# The token lives in a root-owned file, not in the unit, so `systemctl cat` does not show it.
EnvironmentFile=/etc/agentsys/server.env
ExecStart=/usr/bin/node /opt/agentsys/bin/agentsys-server.js start \
  --host 127.0.0.1 --port 8080 --data /var/lib/agentsys/data --name "VPS Frankfurt" --trust-proxy
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agentsys/data
UMask=0077

[Install]
WantedBy=multi-user.target
```

`/etc/agentsys/server.env` (mode `600`, owner `root`):

```sh
AGENTSYS_TOKEN=<64 hex characters: openssl rand -hex 32>
AGENTSYS_ALLOWED_ORIGINS=https://client.example.com
# Optional: only these hosts may be fetched by POST /api/net or a Script's net.fetch (`*` allowed).
# AGENTSYS_ALLOW_NET=api.example.com,*.example.com
# Optional hardening: refuse loopback, private and link-local destinations (DNS pinned).
AGENTSYS_NET_DENY_PRIVATE=1
```

The directory `/var/lib/agentsys/data` must be writable by `agentsys` and by nobody else. The server creates
`data/.server.lock` and refuses to start if another live process holds the same folder — two servers on one
folder would overwrite each other's documents. Use one folder per server; `AGENTSYS_ALLOW_SHARED_DATA=1` is the
deliberate escape hatch and is almost never right.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now agentsys-server
sudo systemctl status agentsys-server
journalctl -u agentsys-server -f
```

Caddy (automatic HTTPS):

```caddyfile
agentsys.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080
}
```

Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name agentsys.example.com;

  ssl_certificate     /etc/letsencrypt/live/agentsys.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/agentsys.example.com/privkey.pem;

  client_max_body_size 20m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # SSE: do not buffer the event stream
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

Serve the client statically from the same host (for example `/opt/agentsys/client`) or from another HTTPS host
listed in `AGENTSYS_ALLOWED_ORIGINS`. If the client is on another host, add it exactly:

```sh
--allowed-origin https://client.example.com
```

Do not expose `/__data`: the platform server does not have it.

## Direct TLS

If you do not want a reverse proxy:

```sh
node bin/agentsys-server.js start --host 0.0.0.0 --port 8443 \
  --token "$AGENTSYS_TOKEN" \
  --tls-cert /etc/agentsys/cert.pem --tls-key /etc/agentsys/key.pem \
  --allowed-origin https://agentsys.example.com
```

The client must use `https://…:8443`. The session cookie becomes `Secure`.

## VPN

WireGuard/Tailscale is a simple alternative: bind the server to the VPN address, keep the token, and use the
VPN address as the environment URL. No public proxy is needed.

## Backups

The data folder is plain JSON. `tools/backup.js` copies it, skips half-written `.tmp-` files, checks that every
JSON file parses and writes a manifest:

```sh
# while the server is stopped: an exact copy
node tools/backup.js --data /var/lib/agentsys/data --out /var/backups/agentsys

# while it runs (accepted, with the caveat it prints)
node tools/backup.js --data /var/lib/agentsys/data --out /var/backups/agentsys --force
```

The tool refuses a live folder without `--force`, and exits non-zero when a copied JSON file does not parse
(the file is still copied, for repair). Restore by pointing `--data` at the backup folder while no server uses
it: a `.transaction.json` inside is replayed at start, so a copy taken during a commit still becomes consistent.
The migration command creates `data/backups/pre-platform-<timestamp>/` before it writes anything.

What a backup must contain: `projects.json`, `settings.json`, `library/`, `workflows/` (each with its `.files`
sidecar), `collections.json`, `collection-*.json`, `secrets/`, `other/`. A recursive copy of the folder gets all
of them.

## Updating

1. Take a backup (above).
2. Stop the service: `systemctl stop agentsys-server`.
3. Replace the checkout (`git fetch && git checkout <tag>`); there is no build step and no `npm install`.
4. Start it and check `GET /api/meta` reports the expected version and protocol.
5. Run `node bin/agentsys-server.js migrate --data <folder> --dry-run` if the update crosses the platform split.
6. Clients that report "Incompatible version" need the new client; the protocol number is bumped only when a
   client of the previous version can no longer work.

## Health checks and operations

- `GET /api/meta` is public and cheap; use it for liveness and version checks.
- `GET /api/diagnostics` (authenticated) reports uptime, version, worker counts, live runtimes, the open event
  streams, the session count and recent errors — never workflow data, tokens or secret values.
- `agentsys-server status --url https://agentsys.example.com` prints the same discovery data from a shell.
- Graceful stop (`SIGTERM`) stops active workflows and closes clients; `systemd` sends it by default.
- A server restart restores saved JSON but does not resume JavaScript. Workflows do not auto-start.
- One process per data folder: a second one exits with a message naming the pid that holds it.

## Windows

`start.bat` runs the combined local server. For a service, use Task Scheduler with `node bin/agentsys-server.js
start --host 127.0.0.1 --port 8080 --data <folder>`, and keep the token in a user environment variable. Windows
antivirus and indexers may briefly lock a file during a rename; the store retries the rename and fails without
replacing the target with a partial write.

## Local TLS verification

`tests/tls.test.js` generates a self-signed certificate with `openssl` when it is installed, starts the real API
server over HTTPS, and checks the protocol header, the `Secure`/`HttpOnly` session cookie and an authenticated
read. The same file verifies that `--trust-proxy` marks the cookie `Secure` only when `X-Forwarded-Proto: https`
is present. A machine without `openssl` skips the first check with that reason; the reverse-proxy path is still
tested. Nothing in the suite needs a public VPS or a publicly trusted certificate.

## Troubleshooting

| Symptom | Check |
|---|---|
| Client says Disconnected | Server running? URL reachable from the client device? HTTPS mixed content? |
| Client says Unauthorized | Token correct? Session expired after a server restart? Enter it again. |
| CORS error in the console | Add the exact client origin with `--allowed-origin`; include scheme and port. |
| SSE reconnects repeatedly | A proxy is buffering; disable buffering and raise the read timeout. |
| Incompatible version | Update the client or the server; the protocol number is in `/api/meta`. |
| Port in use | `--port 0` chooses a free port for the server; the client has its own port. |
