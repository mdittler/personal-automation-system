# PAS Deployment Guide

## Prerequisites

- **Node.js 22 LTS** — `node --version` should show `v22.x.x`
- **pnpm 9+** — `npm install -g pnpm@latest` if not installed
- **System tar** — required for backup; present by default on macOS and most Linux distros
- **macOS or Linux** — Windows is supported for development only; production deployments target macOS (Mac Mini) or Linux (Docker)

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values before starting the server.

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Required | Bot token from [@BotFather](https://t.me/BotFather) |
| `ANTHROPIC_API_KEY` | Required | Anthropic API key for Claude (fast/standard/reasoning tiers) |
| `GUI_AUTH_TOKEN` | Required | Password for the management GUI |
| `GOOGLE_AI_API_KEY` | Optional | Google Gemini API key |
| `OPENAI_API_KEY` | Optional | OpenAI-compatible API key (also used for Together, etc.) |
| `GROQ_API_KEY` | Optional | Groq API key |
| `DATA_DIR` | Optional | Data directory path. Default: `./data` |
| `PORT` | Optional | HTTP server port. Default: `3000` |
| `NODE_ENV` | Optional | Set to `production` to enable secure cookies |
| `TRUST_PROXY` | Optional | Set to `true` when behind a reverse proxy (nginx, Cloudflare tunnel) |
| `WEBHOOK_URL` | Optional | Public HTTPS URL for Telegram webhook mode. Omit to use polling |
| `TELEGRAM_WEBHOOK_SECRET` | Optional | Secret token to validate incoming Telegram webhook requests |
| `GUI_SECURE_COOKIES` | Optional | Set to `true` to force secure cookies without `NODE_ENV=production` |
| `OLLAMA_URL` | Optional | Ollama base URL for local LLM (e.g. `http://localhost:11434`) |

---

## Configuration

The main configuration file is `config/pas.yaml`. It controls:

- **Users** — list of registered users with Telegram IDs and admin flags
- **LLM providers** — model assignments for `fast`, `standard`, and `reasoning` tiers
- **Backup** — enable scheduled backups, set the backup path and retention count

Minimal `config/pas.yaml` to get started:

```yaml
users:
  - id: "your_telegram_user_id"
    name: "Your Name"
    is_admin: true
    enabled_apps: ["*"]   # ["*"] = all apps

llm:
  tiers:
    fast:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    standard:
      provider: anthropic
      model: claude-sonnet-4-20250514

backup:
  enabled: true
  path: /backups
  schedule: '0 3 * * *'
  retention_count: 7
```

---

## First-Run Checklist

1. **Copy and fill environment file:**
   ```bash
   cp .env.example .env
   # Edit .env with your tokens
   ```

2. **Create the config file:**
   ```bash
   cp config/pas.example.yaml config/pas.yaml
   # Edit config/pas.yaml — add your Telegram user ID under users
   ```

3. **Install dependencies and build:**
   ```bash
   pnpm install
   pnpm build
   ```

4. **Start the server:**
   ```bash
   pnpm dev        # development (hot reload)
   # or
   node dist/core/src/main.js   # production build
   ```

5. **Register via Telegram:**
   - Open the management GUI at `http://localhost:3000`
   - Log in with `GUI_AUTH_TOKEN`
   - Create an invite code under **Users → Invite Codes**
   - Message your bot: `/register <invite_code>`

6. **Verify health:**
   ```bash
   curl http://localhost:3000/health/ready
   ```

---

## Docker Setup

### Build the image

```bash
docker build -t pas:latest .
```

### Run with volumes

```bash
docker run -d \
  --name pas \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /srv/pas/data:/app/data \
  -v /srv/pas/config:/app/config \
  -v /srv/pas/backups:/backups \
  --env-file .env \
  -e NODE_ENV=production \
  pas:latest
```

Volume mounts:

| Host path | Container path | Purpose |
|---|---|---|
| `/srv/pas/data` | `/app/data` | All user and app data |
| `/srv/pas/config` | `/app/config` | `pas.yaml` and related config |
| `/srv/pas/backups` | `/backups` | Backup archives |

The `Dockerfile` includes a `HEALTHCHECK` that calls `GET /health/ready`. Docker will mark the container unhealthy if the readiness probe fails. Check status with:

```bash
docker inspect --format='{{.State.Health.Status}}' pas
```

### Docker Compose (optional)

```yaml
services:
  pas:
    image: pas:latest
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /srv/pas/data:/app/data
      - /srv/pas/config:/app/config
      - /srv/pas/backups:/backups
    env_file: .env
    environment:
      NODE_ENV: production
```

---

## Cloudflare Tunnel (Optional)

Use a Cloudflare tunnel to expose PAS to the internet without opening firewall ports. Required if you want Telegram webhook mode instead of polling.

1. **Install cloudflared:**
   ```bash
   brew install cloudflared       # macOS
   # or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
   ```

2. **Create and configure tunnel:**
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create pas
   cloudflared tunnel route dns pas your-subdomain.example.com
   ```

3. **Create tunnel config** at `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: pas
   credentials-file: /Users/yourname/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: your-subdomain.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```

4. **Set environment variables:**
   ```bash
   WEBHOOK_URL=https://your-subdomain.example.com
   TRUST_PROXY=true
   ```

5. **Start the tunnel:**
   ```bash
   cloudflared tunnel run pas
   ```

---

## Native Mac Mini (launchd)

Use a launchd plist to start PAS automatically on login.

1. **Create the plist** at `~/Library/LaunchAgents/com.pas.server.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.pas.server</string>

     <key>ProgramArguments</key>
     <array>
       <string>/usr/local/bin/node</string>
       <string>/Users/yourname/Projects/personal-assistant/dist/core/src/main.js</string>
     </array>

     <key>WorkingDirectory</key>
     <string>/Users/yourname/Projects/personal-assistant</string>

     <key>EnvironmentVariables</key>
     <dict>
       <key>NODE_ENV</key>
       <string>production</string>
       <key>TELEGRAM_BOT_TOKEN</key>
       <string>your_token_here</string>
       <key>ANTHROPIC_API_KEY</key>
       <string>your_key_here</string>
       <key>GUI_AUTH_TOKEN</key>
       <string>your_password_here</string>
     </dict>

     <key>StandardOutPath</key>
     <string>/Users/yourname/Library/Logs/pas/stdout.log</string>

     <key>StandardErrorPath</key>
     <string>/Users/yourname/Library/Logs/pas/stderr.log</string>

     <key>RunAtLoad</key>
     <true/>

     <key>KeepAlive</key>
     <true/>
   </dict>
   </plist>
   ```

   Replace `/usr/local/bin/node` with the output of `which node`. Replace paths and tokens with your actual values. Store secrets in environment variables or use a `.env` file loaded by a wrapper script rather than hardcoding them in the plist.

2. **Create log directory:**
   ```bash
   mkdir -p ~/Library/Logs/pas
   ```

3. **Load the agent:**
   ```bash
   launchctl load ~/Library/LaunchAgents/com.pas.server.plist
   ```

4. **Check status:**
   ```bash
   launchctl list | grep com.pas
   ```

5. **Unload (stop autostart):**
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.pas.server.plist
   ```

6. **Restart after config change:**
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.pas.server.plist
   launchctl load ~/Library/LaunchAgents/com.pas.server.plist
   ```

---

## Household Migration (D5a)

Starting with D5a, PAS organises data under per-household directories. On the **first boot after upgrading**, the system automatically migrates existing data to the new layout.

### What the migration does

- Moves `data/users/<uid>/` → `data/households/default/users/<uid>/`
- Moves `data/users/shared/` → `data/households/default/shared/`
- Moves `data/spaces/<id>/` → `data/households/default/spaces/<id>/`
- Creates `data/system/households.yaml` with a single `default` household
- Rewrites `config/pas.yaml` to add `household_id: default` to every user entry
- Writes a migration marker at `data/system/.household-migration-v1` so the migration never runs twice
- Creates a full backup at `<parent-of-data-dir>/data-backup-pre-household-migration-<timestamp>/` before moving anything

### Normal first-boot flow

The migration runs automatically. Log output will show:

```
Starting household migration — creating backup first
Backup created successfully
Moving user and space directories into household scope
...
Household migration complete: users=N spaces=M marker=...
```

Once the marker file exists, subsequent restarts skip the migration entirely.

### If startup fails with HouseholdMigrationError

The marker is **not written** on failure, so the migration will retry on the next startup. To recover manually:

1. Stop PAS.
2. Locate the backup: `ls <parent-of-data-dir>/data-backup-pre-household-migration-*/` (the directory created just before the failure).
3. Restore the backup to `data/`:
   ```bash
   rm -rf data
   cp -r data-backup-pre-household-migration-<timestamp>/ data/
   ```
4. Fix the underlying cause (check disk space, file permissions, etc.) and restart.

### GUI / API access in D5a

The management GUI (`/`) and REST API (`/api/`) use a single bearer token (`GUI_AUTH_TOKEN` / `API_TOKEN`). Access is system-owner-only — there is no per-household authentication in D5a. Per-household GUI and API auth is planned for D5b.
