# n8n Integration Guide

## Overview

PAS is the brain — it owns scheduling, data, users, and the Telegram bot. n8n is the invisible execution engine — it handles multi-step workflows, external API calls, and data transformations that PAS dispatches to it.

Users interact exclusively with PAS (Telegram bot + GUI). They never need to know n8n exists. PAS defines *what* runs and *when*; n8n defines *how* complex workflows execute.

> **App developers:** If you're building a PAS app and want to understand how your data integrates with n8n, see the "External Integration & n8n" section in [`docs/CREATING_AN_APP.md`](CREATING_AN_APP.md).

## Architecture

```
User <-> Telegram Bot <-> PAS (scheduling, data, LLM, GUI)
                           |
                           |  webhook dispatch (optional)
                           v
                         n8n (workflow execution)
                           |
                           |  API callbacks
                           v
                         PAS API (/api/*)
```

PAS retains full control of scheduling. Report and alert cron jobs are defined in the PAS GUI, stored in PAS config, and fired by PAS's CronManager. When `n8n.dispatch_url` is configured, cron triggers send a webhook to n8n instead of executing internally. n8n runs the workflow and calls PAS API endpoints to read data, run LLM completions, and send Telegram messages.

If the dispatch webhook fails (n8n is down, network error), PAS falls back to internal execution automatically. The user never notices.

## Configuration

### pas.yaml

```yaml
# n8n dispatch (optional — empty = internal execution)
n8n:
  dispatch_url: http://localhost:5678/webhook/pas-dispatch
```

### .env

```bash
# Required for any API access (n8n or otherwise)
API_TOKEN=your-secure-random-token

# Optional — notify n8n when events happen
# Configure in pas.yaml webhooks section instead
```

### Outbound Webhooks (pas.yaml)

Webhooks push event notifications to n8n without polling:

```yaml
webhooks:
  - id: n8n-alerts
    url: http://localhost:5678/webhook/pas-alerts
    events: ["alert:fired"]
    secret: "your-hmac-secret"
  - id: n8n-reports
    url: http://localhost:5678/webhook/pas-reports
    events: ["report:completed"]
  - id: n8n-data
    url: http://localhost:5678/webhook/pas-data
    events: ["data:changed"]
```

When a `secret` is set, PAS signs the payload with HMAC-SHA256 and includes the signature in the `X-PAS-Signature: sha256=<hex>` header. Webhooks are fire-and-forget with a 5-second timeout, rate-limited to 10 deliveries per minute per URL.

**Well-known events:**

| Event | Emitted when | Payload data |
|-------|-------------|--------------|
| `alert:fired` | Alert condition met and actions executed | `{ alertId }` |
| `report:completed` | Report run and delivered (non-preview) | `{ reportId }` |
| `data:changed` | Any DataStore write, append, or archive | `{ operation, appId, userId, path, spaceId? }` |

Webhook payload format:

```json
{
  "event": "alert:fired",
  "timestamp": "2026-03-19T14:30:00.000Z",
  "data": { "alertId": "low-inventory" }
}
```

## Dispatch Flow

When `n8n.dispatch_url` is configured, PAS cron triggers follow this sequence:

1. **Cron fires** in PAS (CronManager)
2. PAS POSTs a dispatch payload to n8n:
   ```json
   { "type": "report", "id": "daily-summary", "action": "run" }
   ```
3. **n8n receives** the webhook and executes a workflow
4. n8n calls **PAS API endpoints** (`POST /api/reports/:id/run`, `POST /api/llm/complete`, etc.)
5. n8n sends results via `POST /api/telegram/send` or `POST /api/reports/:id/deliver`
6. If step 2 fails (timeout, 5xx, network error), PAS **falls back to internal execution** transparently

### Dispatch Payload

```json
{
  "type": "report" | "alert",
  "id": "the-definition-id",
  "action": "run" | "evaluate"
}
```

## Authentication

All API endpoints require a Bearer token:

```
Authorization: Bearer <API_TOKEN>
```

The token is set via the `API_TOKEN` environment variable. When empty, the entire API is disabled.

Rate limit: 100 requests per 60 seconds per IP address. Timing-safe token comparison prevents timing attacks.

## API Reference

Base URL: `http://localhost:3100/api`

All endpoints return JSON with `{ ok: true, ... }` on success or `{ ok: false, error: "..." }` on failure.

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/reports` | List all report definitions |
| GET | `/reports/:id` | Get a single report definition |
| POST | `/reports/:id/run` | Execute report: collect data, format, save to history, deliver |
| POST | `/reports/:id/deliver` | Send pre-built content to delivery users via Telegram |

**Run a report:**

```bash
curl -X POST http://localhost:3100/api/reports/daily-summary/run \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"preview": false}'
```

Response: `{ "ok": true, "result": { ... } }`

With `"preview": true`, the report is collected and formatted but not saved to history or delivered.

**Deliver custom content:**

```bash
curl -X POST http://localhost:3100/api/reports/daily-summary/deliver \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Custom Report\nGenerated by n8n", "userIds": ["123456"]}'
```

If `userIds` is omitted, the report's configured delivery list is used. Max content length: 50,000 characters.

### Alerts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/alerts` | List all alert definitions |
| GET | `/alerts/:id` | Get a single alert definition |
| POST | `/alerts/:id/evaluate` | Evaluate condition, execute actions if met |
| POST | `/alerts/:id/fire` | Evaluate and execute (same as evaluate without preview) |

**Evaluate an alert:**

```bash
curl -X POST http://localhost:3100/api/alerts/low-inventory/evaluate \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"preview": true}'
```

Response: `{ "ok": true, "result": { "conditionMet": true, "actionsExecuted": 0 } }`

With `"preview": true`, the condition is checked but actions are not executed.

### Changes (Change Log)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/changes` | List change log entries |

Query parameters:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | ISO 8601 | 24 hours ago | Start of time window |
| `appFilter` | string | (none) | Filter by app ID |
| `limit` | number | 500 | Max entries (capped at 5000) |

```bash
curl "http://localhost:3100/api/changes?since=2026-03-19T00:00:00Z&appFilter=notes&limit=50" \
  -H "Authorization: Bearer $API_TOKEN"
```

Response: `{ "ok": true, "since": "...", "count": 12, "entries": [...] }`

### LLM

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/llm/complete` | Run an LLM completion through PAS infrastructure |

All completions go through PAS's cost tracking, model selection, and safeguards.

```bash
curl -X POST http://localhost:3100/api/llm/complete \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Summarize this text: ...",
    "tier": "fast",
    "systemPrompt": "You are a helpful assistant.",
    "maxTokens": 500,
    "temperature": 0.7
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | yes | The prompt text (max 100,000 chars) |
| `tier` | string | no | `fast`, `standard`, or `reasoning` (default: `fast`) |
| `systemPrompt` | string | no | System prompt (max 10,000 chars) |
| `maxTokens` | number | no | Max output tokens |
| `temperature` | number | no | 0 to 2 |

Response: `{ "ok": true, "text": "The summary is...", "tier": "fast" }`

Returns 429 if rate limit or cost cap is hit.

### Telegram

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/telegram/send` | Send a message to a registered user via the PAS bot |

```bash
curl -X POST http://localhost:3100/api/telegram/send \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": "123456", "message": "Your workflow completed."}'
```

Max message length: 4,096 characters. User must be registered in `pas.yaml`.

### Data (Read/Write)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/data` | Write or append to a scoped data file |
| GET | `/data` | Read a file or list a directory |

**Write data:**

```bash
curl -X POST http://localhost:3100/api/data \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123456",
    "appId": "notes",
    "path": "daily-notes/2026-03-19.md",
    "content": "# Notes\nFrom n8n workflow",
    "mode": "append"
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | yes | Registered user ID |
| `appId` | string | yes | App ID (`^[a-z][a-z0-9-]*$`) |
| `path` | string | yes | File path within the app scope |
| `content` | string | yes | File content |
| `mode` | string | no | `write` (default) or `append` |
| `spaceId` | string | no | Write to a shared space instead of user scope |

**Read data:**

```bash
curl "http://localhost:3100/api/data?userId=123456&appId=notes&path=daily-notes/2026-03-19.md" \
  -H "Authorization: Bearer $API_TOKEN"
```

File response: `{ "ok": true, "type": "file", "path": "...", "content": "..." }`

Directory response: `{ "ok": true, "type": "directory", "path": ".", "entries": [{"name": "file.md", "isDirectory": false}] }`

Not found: `{ "ok": true, "type": "not_found", "path": "..." }`

Max file size: 1MB (returns 413 if exceeded).

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/messages` | Dispatch a text message through PAS's router |

The message is classified and routed to apps just as if the user typed it in Telegram. Responses are sent to the user's Telegram DM.

```bash
curl -X POST http://localhost:3100/api/messages \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": "123456", "text": "/note Buy milk"}'
```

Max text length: 4,096 characters. Supports commands (`/note ...`) and free-text messages.

### Schedules

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/schedules` | List all registered cron jobs |

```bash
curl http://localhost:3100/api/schedules \
  -H "Authorization: Bearer $API_TOKEN"
```

Response:

```json
{
  "ok": true,
  "jobs": [
    {
      "key": "report:daily-summary",
      "appId": "reports",
      "jobId": "daily-summary",
      "description": "Daily summary report",
      "cron": "0 21 * * *",
      "humanSchedule": "At 09:00 PM, every day",
      "nextRun": "2026-03-19T21:00:00.000Z",
      "lastRunAt": "2026-03-18T21:00:02.123Z"
    }
  ]
}
```

## Integration Levels

### Level 1: Simple Dispatch

PAS fires a cron trigger, n8n receives it, and calls a single PAS API endpoint.

Example: "Run the daily summary report at 9 PM"

1. PAS cron fires at 21:00
2. PAS dispatches `{ "type": "report", "id": "daily-summary", "action": "run" }` to n8n
3. n8n workflow calls `POST /api/reports/daily-summary/run`
4. PAS collects data, formats, delivers via Telegram

This is equivalent to internal execution but gives you n8n's logging and error handling.

### Level 2: Enrichment Workflows

n8n adds external data, transforms content, or orchestrates multi-step processes between the dispatch and the final delivery.

Example: "Daily summary with weather and calendar"

1. PAS cron fires at 21:00
2. PAS dispatches to n8n
3. n8n workflow:
   - Calls `GET /api/changes?since=...` to get today's changes
   - Calls a weather API for the forecast
   - Calls Google Calendar API for tomorrow's events
   - Calls `POST /api/llm/complete` with all data for an AI summary
   - Calls `POST /api/telegram/send` to deliver the enriched report
4. User receives a single combined message in Telegram

Another example: "Write external data into PAS"

1. n8n runs on a schedule (or triggered by a PAS webhook)
2. n8n calls an external API (bank transactions, fitness data, etc.)
3. n8n transforms the data
4. n8n calls `POST /api/data` to write it into PAS storage
5. PAS alerts can then evaluate conditions against the new data

## n8n Workflow Setup

### Step 1: Create the Receiver Workflow

1. In n8n, create a new workflow
2. Add a **Webhook** trigger node
   - Method: POST
   - Path: `pas-dispatch`
   - Authentication: None (PAS handles auth, n8n is on the local network)
3. Add a **Switch** node on `{{ $json.type }}`
   - Case `report` -> report handler branch
   - Case `alert` -> alert handler branch

### Step 2: Add API Call Nodes

For each branch, add an **HTTP Request** node:

- Method: POST
- URL: `http://localhost:3100/api/reports/{{ $json.id }}/run`
- Authentication: Header Auth
  - Name: `Authorization`
  - Value: `Bearer your-api-token`
- Content Type: JSON

### Step 3: Configure PAS

In `pas.yaml`:

```yaml
n8n:
  dispatch_url: http://localhost:5678/webhook/pas-dispatch
```

Set the API token in `.env`:

```bash
API_TOKEN=your-secure-random-token
```

### Step 4: Test

1. Trigger a report manually from the PAS GUI (or via API)
2. Check the n8n execution log for the incoming webhook
3. Verify the API callback succeeded
4. Confirm the Telegram message was delivered

### Tips

- Use n8n's **Error Trigger** node to get notified when workflows fail
- PAS's internal fallback means a broken n8n workflow degrades gracefully, not catastrophically
- Keep API tokens in n8n credentials, not hardcoded in nodes
- For event-driven workflows (not dispatch), use outbound webhooks in `pas.yaml` instead of polling
