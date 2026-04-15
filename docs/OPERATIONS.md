# PAS Operations Guide

## Health Monitoring

PAS exposes three health endpoints:

### `GET /health`

Basic stub. Always returns 200.

```json
{ "status": "ok" }
```

### `GET /health/live`

Liveness probe. Always returns 200 as long as the process is running. Use this for process supervisors (launchd `KeepAlive`, Docker restart policies).

```json
{ "status": "ok", "uptime": 3842.7 }
```

### `GET /health/ready`

Readiness probe. Returns 200 when the system is fully operational, 503 when any essential check fails.

**200 — healthy:**
```json
{
  "status": "ok",
  "uptime": 3842.7,
  "checks": [
    { "name": "telegram", "status": "ok" },
    { "name": "filesystem", "status": "ok" }
  ]
}
```

**503 — degraded:**
```json
{
  "status": "degraded",
  "uptime": 3842.7,
  "checks": [
    { "name": "telegram", "status": "fail", "detail": "timeout" },
    { "name": "filesystem", "status": "ok" }
  ]
}
```

A 503 response means the bot is not accepting messages or cannot read/write data. Check the `checks` array to identify which component failed.

### Suggested monitoring setup

Poll `/health/ready` every 60 seconds. Alert on any 503 response or connection timeout.

**curl one-liner for cron:**
```bash
curl -sf http://localhost:3000/health/ready || echo "PAS health check failed" | mail -s "PAS DOWN" admin@example.com
```

**UptimeRobot / Better Uptime** — add `https://your-subdomain.example.com/health/ready` as an HTTP keyword monitor, keyword `"status":"ok"`, interval 5 minutes.

---

## Backup & Restore

### Enable backups in `config/pas.yaml`

```yaml
backup:
  enabled: true
  path: /backups
  schedule: '0 3 * * *'   # 3 AM daily
  retention_count: 7        # keep 7 most recent archives
```

Backups run on the configured cron schedule. The backup mechanism archives:
- `data/` — all user and app data (markdown files, YAML)
- `config/` — `pas.yaml` and any supporting config files

Each archive is a `.tar.gz` file named with a timestamp. When `retention_count` is reached, the oldest archive is deleted before writing the new one.

### Manual backup

```bash
tar -czf /backups/pas-manual-$(date +%Y%m%d-%H%M%S).tar.gz data/ config/
```

### Restore from backup

1. **Stop PAS** (launchd: `launchctl unload ~/Library/LaunchAgents/com.pas.server.plist`, Docker: `docker stop pas`)

2. **Extract the archive:**
   ```bash
   tar xzf /backups/pas-2026-04-14-030001.tar.gz -C /restore-staging/
   ```

3. **Replace data and config:**
   ```bash
   rm -rf data/ config/
   cp -r /restore-staging/data .
   cp -r /restore-staging/config .
   ```

4. **Restart PAS.**

### Docker volume paths

When running in Docker with the recommended volume mounts, the backup path inside the container is `/backups`, which maps to the host path you mounted (e.g., `/srv/pas/backups`). Run restores on the host by accessing that directory directly — no need to enter the container.

---

## Logging

PAS uses [Pino](https://getpino.io/) for structured logging. In production (`NODE_ENV=production`), logs are emitted as newline-delimited JSON to stdout. In development, logs are pretty-printed.

### Pipe stdout to a file (native)

```bash
node dist/core/src/main.js >> ~/Library/Logs/pas/pas.log 2>&1
```

The launchd plist handles this via `StandardOutPath` and `StandardErrorPath`.

### Log rotation with logrotate (Linux)

Create `/etc/logrotate.d/pas`:

```
/var/log/pas/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
```

### Docker logging driver

By default Docker captures stdout/stderr. View logs with:

```bash
docker logs pas --tail 100 -f
```

For long-running production use, switch to the `json-file` driver with size limits in `docker run`:

```bash
docker run ... --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 pas:latest
```

Or in Docker Compose:

```yaml
services:
  pas:
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
```

---

## Common Troubleshooting

### Bot not responding

1. Check that the process is running:
   ```bash
   curl http://localhost:3000/health/live
   ```
2. Check the readiness probe for Telegram connectivity:
   ```bash
   curl http://localhost:3000/health/ready
   ```
3. If using **webhook mode** (`WEBHOOK_URL` is set): verify the tunnel or reverse proxy is up and the URL is reachable from the internet. Telegram requires HTTPS.
4. If using **polling mode** (no `WEBHOOK_URL`): check the logs for Telegram polling errors — usually an invalid token or network issue.
5. Verify `TELEGRAM_BOT_TOKEN` is correct and the bot has not been revoked.

### LLM errors

1. Check API keys in `.env` — `ANTHROPIC_API_KEY` is required; others are optional.
2. Check the readiness probe's `checks` array:
   ```bash
   curl http://localhost:3000/health/ready | jq .checks
   ```
3. Check logs for specific error messages (rate limits, quota exhaustion, invalid key).
4. If using Ollama: verify `OLLAMA_URL` is reachable and the model is pulled (`ollama list`).

### Disk full

The `data/` directory grows as users add data. No automatic pruning happens outside of backup rotation.

1. Check current usage:
   ```bash
   du -sh data/
   du -sh data/users/*/
   ```
2. Check backup archives:
   ```bash
   du -sh /backups/
   ls -lh /backups/
   ```
3. Reduce `retention_count` in `config/pas.yaml` to keep fewer backup archives.
4. Identify large app data directories and archive or delete old entries manually.

### Health endpoint returns 503

1. Call the endpoint and inspect the `checks` array:
   ```bash
   curl http://localhost:3000/health/ready
   ```
2. **`telegram` check failing** — Telegram bot is disconnected. Check token validity and network access to `api.telegram.org`.
3. **`filesystem` check failing** — `DATA_DIR` is not readable or writable. Check that the directory exists, permissions are correct, and the disk is not full.

### Backup failures

1. Verify `tar` is installed:
   ```bash
   which tar && tar --version
   ```
2. Verify the backup path exists and is writable by the PAS process:
   ```bash
   ls -la /backups
   ```
3. Check logs around the configured backup schedule time (default 3 AM) for error messages.
4. In Docker: confirm `/backups` is a mounted volume, not an ephemeral container path.

### GUI can't log in

1. Verify `GUI_AUTH_TOKEN` is set correctly in `.env`.
2. If the server is behind a reverse proxy (Cloudflare tunnel, nginx): set `TRUST_PROXY=true` so the `Secure` cookie attribute works correctly over HTTPS.
3. If `NODE_ENV=production` or `GUI_SECURE_COOKIES=true`, the auth cookie is `Secure` — it will not be sent over plain HTTP. Access the GUI over HTTPS, or unset those variables for local development.
4. Clear browser cookies for the GUI domain and try again — a stale `pas_auth` cookie from a previous session can block login.

---

## Updating

1. **Pull latest changes:**
   ```bash
   git pull
   ```

2. **Install any new dependencies:**
   ```bash
   pnpm install
   ```

3. **Rebuild:**
   ```bash
   pnpm build
   ```

4. **Restart the server:**

   - **launchd:**
     ```bash
     launchctl unload ~/Library/LaunchAgents/com.pas.server.plist
     launchctl load ~/Library/LaunchAgents/com.pas.server.plist
     ```

   - **Docker:**
     ```bash
     docker build -t pas:latest .
     docker stop pas && docker rm pas
     # re-run docker run command from DEPLOYMENT.md
     ```

5. **Verify after restart:**
   ```bash
   curl http://localhost:3000/health/ready
   ```
