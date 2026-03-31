# User Acceptance Testing Checklist

Practical end-to-end verification that PAS works as expected. Walk through sequentially — later sections depend on earlier ones.

**Date tested:** 2026-03-20 (Sections 1-11), 2026-03-25 (Sections 13, 19, 20), 2026-03-30 (Sections 15, 21)
**Tester:** Matt
**Environment:** Local

---

## 1. Prerequisites

Before starting, ensure:

- [x] `.env` is configured with valid `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, and `GUI_AUTH_TOKEN`
- [x] `config/pas.yaml` exists with your Telegram user ID registered
- [x] Dependencies installed: `pnpm install`
- [x] Build succeeds: `pnpm build` (no errors)
- [x] Tests pass: `pnpm test` (2156 tests, 0 failures)

---

## 2. Startup & Health

Start the system with `pnpm dev`.

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 2.1 | Run `pnpm dev` | Logs show: server started on port 3100, Telegram bot connected (polling or webhook), apps loaded (echo, notes, chatbot). If `API_TOKEN` is set, also shows "API endpoints registered" | ✅ |
| 2.2 | Visit `http://localhost:3100/health` in browser | Returns JSON with `{"status":"ok"}` | ✅ |
| 2.3 | Check console for errors | No ERROR-level log lines during startup | ✅ |

---

## 3. GUI Access

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 3.1 | Visit `http://localhost:3100/gui` | Redirected to login page | ✅ |
| 3.2 | Enter wrong token, submit | Login rejected, stays on login page | ✅ |
| 3.3 | Enter correct `GUI_AUTH_TOKEN`, submit | Redirected to dashboard; see navigation links: Dashboard, Apps, Scheduler, Reports, Alerts, Spaces, Logs, Data, Config, LLM Usage | ✅ |
| 3.4 | Click "Apps" in nav | See list of apps: echo, notes, chatbot | ✅ |

---

## 4. Telegram Bot Basics

Open your Telegram chat with the bot.

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 4.1 | Send `/start` | Bot replies: "Welcome to PAS! Type /help to see available commands." | ✅ |
| 4.2 | Send `/help` | Bot replies with command list including `/echo`, `/note`, `/notes`, `/summarize`, `/ask`, and `/space` commands | ✅ |
| 4.3 | Send `/nonexistent` | Bot replies: "Unknown command: /nonexistent. Type /help for available commands." | ✅ |
| 4.4 | Send `/echo Hello World` | Bot replies: "Hello World" | ✅ |

---

## 5. Notes App

Tests data storage + LLM integration.

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 5.1 | Send `/note Buy groceries` | Bot confirms note saved | ✅ |
| 5.2 | Send `/note Call dentist` | Bot confirms note saved | ✅ |
| 5.3 | Send `/note Fix the leaky faucet` | Bot confirms note saved | ✅ |
| 5.4 | Send `/notes` | Bot shows recent notes including all three above, with timestamps | ✅ |
| 5.5 | Send `/summarize` | Bot responds with an AI-generated summary of today's notes (confirms LLM is working) | ✅ |
| 5.6 | Verify data file exists | In GUI Data Browser (or filesystem), check `data/users/<your-id>/notes/daily-notes/` contains today's date file | ✅ |

---

## 6. Chatbot Fallback

Tests that free-text messages go to the chatbot (not notes-only fallback).

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 6.1 | Send "What's the capital of France?" | Bot responds conversationally (mentions Paris), not just "Noted" | ✅ |
| 6.2 | Send "Tell me more about it" | Bot responds with follow-up about Paris (shows conversation history is working) | ✅ |
| 6.3 | Send "Remember that my favorite color is blue" | Bot saves as note ("remember" triggers notes intent) or acknowledges conversationally | ✅ | Routed to notes — acceptable since "remember" is a note-taking trigger word |
| 6.4 | Wait a moment, then send "What's my favorite color?" | Bot mentions blue (shows conversation history recall) | ✅ |
| 6.5 | Check daily notes file | `data/users/<your-id>/chatbot/daily-notes/` contains today's file with the messages logged | ✅ |

---

## 7. /ask Command (App Awareness & System Introspection)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 7.1 | Send `/ask` (no args) | Bot shows static intro text with example questions | ✅ |
| 7.2 | Send `/ask What apps are installed?` | Bot lists installed apps (echo, notes, chatbot) with descriptions | ✅ |
| 7.3 | Send `/ask How do I save a note?` | Bot explains `/note` command (shows knowledge base working) | ✅ |
| 7.4 | Send `/ask What model is being used?` | Bot shows current model tier assignments (shows system introspection) | ✅ |
| 7.5 | Send `/ask How much has the LLM cost this month?` | Bot shows cost information (may be $0.xx if just started) | ✅ |
| 7.6 | Send `/ask What scheduled jobs are running?` | Bot describes any registered cron jobs | ✅ |

---

## 8. App Management (GUI)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 8.1 | Go to GUI > Apps | See echo, notes, chatbot listed with toggle states | ✅ |
| 8.2 | Disable the echo app for your user | Toggle shows disabled | ✅ |
| 8.3 | In Telegram, send `/echo test` | Bot replies "Unknown command" (echo is disabled) | ✅ |
| 8.4 | Re-enable echo app in GUI | Toggle shows enabled | ✅ |
| 8.5 | Send `/echo test` again | Bot replies "test" (echo working again) | ✅ |

---

## 9. User Config (GUI)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 9.1 | Go to GUI > Apps > notes config for your user | See `notes_per_page` setting with default value 10 | ✅ |
| 9.2 | Change `notes_per_page` to 5, save | Config saved successfully | ✅ |
| 9.3 | Go to GUI > Apps > chatbot config for your user | See `auto_detect_pas` setting (boolean, default false) | ✅ |
| 9.4 | Toggle `auto_detect_pas` to true, save | Config saved successfully | ✅ |
| 9.5 | In Telegram, send "How does PAS routing work?" | Bot responds with PAS-specific answer including app info (auto-detect triggered) | ✅ |
| 9.6 | Reset `auto_detect_pas` to false if desired | Config saved | ✅ |

---

## 10. LLM & Model Management (GUI)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 10.1 | Go to GUI > LLM | See current tier assignments (fast, standard, reasoning) with provider and model | ✅ |
| 10.2 | See usage statistics | Cost, token counts for recent usage shown (may be small if just started) | ✅ |
| 10.3 | See available models list | Models load (htmx lazy-load); shows Anthropic models at minimum | ✅ |
| 10.4 | Check per-model breakdown | Table shows models that have been used with token/cost details | ✅ |
| 10.5 | (Optional) Switch fast tier to a different model via Set button | Tier assignment updates, page refreshes showing new assignment | ✅ |

---

## 11. Scheduler (GUI)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 11.1 | Go to GUI > Scheduler | See list of registered cron jobs (may be empty if no reports/alerts yet) | ✅ |
| 11.2 | If jobs exist: verify human-readable schedule | Cron expressions shown as readable text (e.g., "At 02:00 AM") alongside raw cron | ✅ |
| 11.3 | If jobs exist: verify next run time | "Next Run" column shows a future date with relative countdown (e.g., "in 8h 15m") | ✅ |

---

## 12. Context Store

Tests that per-user context/preferences are stored and used by the chatbot. Context is per-user at `data/users/<userId>/context/`, with shared system context at `data/system/context/` as fallback.

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 12.1 | Go to GUI > Context | See context management page with your user listed | ☐ |
| 12.2 | Click "+ Add Entry" for your user, create key `preferences` with content `- Prefers metric units` | Entry saved, appears in list | ☐ |
| 12.3 | Send `/ask What do you know about my preferences?` | Bot mentions metric units preference (context store indexed and used) | ☐ |
| 12.4 | Send "What's the temperature like at 30 degrees?" | If auto-detect is on, bot may reference metric preference | ☐ |
| 12.5 | In GUI > Context, edit the entry to add `- Favorite color is blue` | Entry updated | ☐ |
| 12.6 | Send "What's my favorite color?" | Bot mentions blue (context store used by chatbot) | ☐ |

---

## 13. Shared Spaces

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 13.1 | Send `/space create family Family Shared Space` | Bot confirms space "family" created | ✅ |
| 13.2 | Send `/space family` | Bot confirms you entered the "family" space; subsequent responses show `[Family Shared Space]` tag | ✅ |
| 13.3 | Send `/note Shared grocery item` | Note saved (check that it went to `data/spaces/family/notes/` not your personal dir) | ⚠️ | Note went to personal dir — notes app is not space-aware (by design: apps adopt spaces individually) |
| 13.4 | Send `/space off` | Bot confirms you exited the space | ✅ |
| 13.5 | Send `/note Personal note` | Note saved to personal directory (not space) | ✅ |
| 13.6 | Go to GUI > Spaces | See "family" space listed with your user as member | ✅ |

**If you have a second registered user:**

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 13.7 | Send `/space invite family OtherUserName` | Bot confirms user invited | ☐ |
| 13.8 | From other user: send `/space family` | Other user enters the space | ☐ |
| 13.9 | Send `/space members family` | Both users listed as members | ☐ |
| 13.10 | Send `/space kick family OtherUserName` | User removed from space | ☐ |

**Cleanup:**

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 13.11 | Send `/space delete family` | Space deleted, data remains on disk | ✅ |

---

## 14. Reports

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 14.1 | Go to GUI > Reports > Create New | Report creation form loads with user checkboxes, app/user dropdowns in sections, cron preset buttons | ✅ |
| 14.2 | Create a report: name "Test Report", schedule `0 * * * *` (hourly), add one "custom" section with static text "Hello from test report" | Report saved, appears in list | ✅ |
| 14.3 | Click "Preview" on the report | Preview shows formatted report content including "Hello from test report" | ✅ |
| 14.4 | Add an "app-data" section: select app and user from dropdowns, path `daily-notes/{today}.md` | Section added, saved | ✅ |
| 14.5 | Preview again | Preview shows both custom text and today's notes content | ✅ |
| 14.6 | Toggle report off (disable) | Report shows as disabled in list | ✅ |
| 14.7 | Delete the test report | Report removed from list | ✅ |

---

## 15. Alerts

### 15a. Alert CRUD

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 15.1 | Go to GUI > Alerts > Create New | Alert creation form loads with user checkboxes, app/user dropdowns, report dropdown, frequency picker | ✅ |
| 15.2 | Create an alert: name "Test Alert", schedule `*/5 * * * *`, data source using dropdowns for app/user, path to existing file, condition type "deterministic", condition "not empty", action: `telegram_message` with message "Alert fired!" | Alert saved, appears in list | ✅ |
| 15.3 | Click "Test" on the alert | Test evaluates condition and shows result (should show condition met if file exists with content) | ✅ |
| 15.4 | Toggle alert off | Alert shows as disabled | ✅ |
| 15.5 | Delete the test alert | Alert removed from list | ✅ |

### 15b. Action type dynamic switching

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 15.6 | Create new alert, click "Add Action" with "Send a Telegram message" selected | Fieldset appears with message input and AI summary checkbox | ✅ |
| 15.7 | Change the action type dropdown to "Call a webhook URL" | Fields swap: message input disappears, webhook URL input + include data checkbox + payload format hint appear | ✅ |
| 15.8 | Change dropdown to "Announce on speaker" | Fields swap to "What to say" input + "Speaker (optional)" input | ✅ |
| 15.9 | Change dropdown to "Save to a file" | Fields swap to app select + user select + file path + content textarea + write mode | ✅ |
| 15.10 | Change dropdown to "Run a report" | Fields swap to report dropdown | ✅ |
| 15.11 | Change dropdown to "Send a message to an app" | Fields swap to message input + user select | ✅ |
| 15.12 | Change dropdown back to "Send a Telegram message" | Fields swap back to message input + AI summary checkbox | ✅ |

### 15c. Existing actions preserve values on page load

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 15.13 | Save alert with a Telegram action (message: "Test {alert_name}") | Alert saved | ✅ |
| 15.14 | Reload the edit page | Message field pre-filled with "Test {alert_name}" | ✅ |
| 15.15 | Save alert with a webhook action (URL filled, include_data checked) | Alert saved | ✅ |
| 15.16 | Reload the edit page | URL field pre-filled, include data checkbox checked | ✅ |
| 15.17 | On the edit page, change existing action's type dropdown | Fields swap to new type (old values cleared — expected behavior) | ✅ |

### 15d. n8n webhook integration

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 15.18 | With `n8n.dispatch_url` configured in pas.yaml, add a webhook action | "Use n8n webhook URL" button appears below URL field, payload format hint shown | ☐ | Skipped — no n8n dispatch URL configured |
| 15.19 | Click "Use n8n webhook URL" button | URL field populated with the configured dispatch URL | ☐ | Skipped |
| 15.20 | With no `n8n.dispatch_url` configured, add a webhook action | No "Use n8n" button shown; placeholder shows generic "https://n8n.example.com/webhook/..." | ✅ |

### 15e. Multiple actions

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 15.21 | Add a Telegram action, then add a Webhook action | Both fieldsets render independently with correct fields | ✅ |
| 15.22 | Change type of first action while second remains unchanged | Only the changed action's fields swap; second action untouched | ✅ |
| 15.23 | Remove the first action, second action still works | Second fieldset remains, fields intact, form submits correctly | ✅ |

---

## 16. Data Browser (GUI)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 16.1 | Go to GUI > Data | See data categories: User Data, Shared Data, System Data, Model Notes | ✅ |
| 16.2 | Click into User Data > your user ID | See app directories (notes, chatbot, echo, context) | ✅ |
| 16.3 | Navigate into notes > daily-notes | See today's notes file | ✅ |
| 16.4 | Click a file to view contents | File contents displayed | ✅ |
| 16.5 | Check System Data section | See system files (monthly-costs, model-selection, etc.) | ✅ |

---

## 17. Multi-User (if applicable)

Only if you have a second Telegram user registered in `pas.yaml`.

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 17.1 | Second user sends `/start` | Bot responds with welcome message | ☐ |
| 17.2 | Second user sends `/note Their note` | Note saved to their own directory (`data/users/<their-id>/notes/`) | ☐ |
| 17.3 | First user sends `/notes` | Only sees first user's notes, not second user's | ☐ |
| 17.4 | In GUI, toggle echo off for second user only | Second user can't use `/echo`, first user still can | ☐ |

**Unregistered user test:**

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 17.5 | Have an unregistered Telegram user message the bot | No response (user guard blocks it); check logs for "unregistered user" warning with their user ID | ☐ |

---

## 18. Docker Deployment (optional)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 18.1 | Run `docker compose build` | Image builds successfully | ☐ |
| 18.2 | Run `docker compose up` | Container starts, logs show same startup as local | ☐ |
| 18.3 | Visit `http://localhost:3100/health` | Health check passes | ☐ |
| 18.4 | GUI login works | Can log in with `GUI_AUTH_TOKEN` | ☐ |
| 18.5 | Telegram bot responds to `/start` | Bot is functional from Docker | ☐ |
| 18.6 | Run `docker compose down` | Clean shutdown, no errors | ☐ |

---

## 19. External Data API (n8n Integration)

Requires `API_TOKEN` set in `.env`. If empty, the API is disabled (skip this section).

**Prerequisites:**
- [x] Set `API_TOKEN` in `.env` to a strong random string
- [x] Restart PAS (`pnpm dev`)
- [x] Confirm startup log shows "API endpoints registered" (not "API_TOKEN not set, API disabled")

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 19.1 | `curl http://localhost:3100/api/data` (no auth) | Returns 401: `"Missing or invalid Authorization header."` | ✅ |
| 19.2 | `curl -X POST http://localhost:3100/api/data -H "Authorization: Bearer wrong-token" -H "Content-Type: application/json" -d "{}"` | Returns 401: `"Invalid API token."` | ✅ |
| 19.3 | Write a file via API: `curl -X POST http://localhost:3100/api/data -H "Authorization: Bearer <your-token>" -H "Content-Type: application/json" -d '{"userId":"<your-id>","appId":"test-api","path":"hello.md","content":"# Hello from API\n"}'` | Returns 200: `{"ok":true,"path":"hello.md","mode":"write"}` | ✅ |
| 19.4 | Verify file was created | Check `data/users/<your-id>/test-api/hello.md` exists with content "# Hello from API" (via GUI Data Browser or filesystem) | ✅ |
| 19.5 | Append to the file: same curl but with `"mode":"append","content":"- Appended line\n"` | Returns 200 with `"mode":"append"` | ✅ |
| 19.6 | Verify append worked | File now contains both the header and the appended line | ✅ |
| 19.7 | Send a message via API: `curl -X POST http://localhost:3100/api/messages -H "Authorization: Bearer <your-token>" -H "Content-Type: application/json" -d '{"userId":"<your-id>","text":"Hello from n8n"}'` | Returns 200: `{"ok":true,"dispatched":true}` | ✅ |
| 19.8 | Check Telegram | Bot sent a response to your DM (chatbot processed "Hello from n8n") | ✅ | Bot responded to "Hello from API test" via DM |
| 19.9 | Test invalid appId: `"appId":"INVALID"` | Returns 400: `"Invalid appId format."` | ✅ |
| 19.10 | Test unregistered userId: `"userId":"nobody"` | Returns 403: `"Unregistered user."` | ✅ |

**Space-scoped write (if spaces exist):**

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 19.11 | Write with `"spaceId":"family"` (must be a space you're a member of) | Returns 200; file written to `data/spaces/family/test-api/` | ⏭️ | Skipped — space deleted before API test. 19.12 (nonexistent space rejection) covers the auth path |
| 19.12 | Write with `"spaceId":"nonexistent"` | Returns 403: `"Not a member of the requested space."` | ✅ |

---

## 20. Obsidian Frontmatter

Tests that generated markdown files include YAML frontmatter for Obsidian vault compatibility.

**Prerequisites:**
- [x] Have some existing data from earlier UAT sections (notes, chatbot messages, etc.)

### 20a. Migration (one-time, for existing data files)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 20.1 | Run `pnpm migrate-frontmatter --dry-run` | Shows count of files that would be migrated, skipped, and unrecognized — no files modified | ✅ | 13 would migrate, 13 skipped, 16 unrecognized (vault symlinks + non-standard files) |
| 20.2 | Run `pnpm migrate-frontmatter` | Shows count of files migrated; existing files now have frontmatter prepended | ✅ | 13 migrated, 24 skipped, 5 unrecognized |
| 20.3 | Run `pnpm migrate-frontmatter` again | Shows 0 migrated, all skipped (idempotent — doesn't double-add frontmatter) | ✅ | 0 migrated, 37 skipped — idempotent confirmed |
| 20.4 | Check a migrated daily notes file | File starts with `---\ntitle: Daily Notes - ...\ndate: ...\ntags:\n  - pas/daily-note\n...\n---\n` followed by original content | ✅ | Verified 2026-03-19.md has correct frontmatter |

### 20b. New files get frontmatter automatically

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 20.5 | Send `/note Frontmatter test` in Telegram | Bot confirms note saved | ✅ |
| 20.6 | Check today's notes file (`data/users/<your-id>/notes/daily-notes/<today>.md`) | If newly created: file starts with `---` frontmatter block containing `title`, `date`, `tags: [pas/daily-note, pas/notes]`, `type: daily-note`. Note content follows after `---` | ✅ | Verified: correct frontmatter with title, date, tags, type, user, source |
| 20.7 | Send another `/note Second note` | Bot confirms saved | ✅ |
| 20.8 | Check the same file | Frontmatter appears only once at top; both notes appended below it (no duplicate frontmatter) | ✅ | Single frontmatter block, 4 notes appended below |
| 20.9 | Send a free-text message (chatbot fallback) | Bot responds conversationally | ✅ | "What's the weather like today?" — bot responded conversationally |
| 20.10 | Check chatbot daily notes file (`data/users/<your-id>/chatbot/daily-notes/<today>.md`) | Has frontmatter with `tags: [pas/daily-note, pas/chatbot]` and `source: pas-chatbot` | ✅ | Verified: correct tags and source |

### 20c. Readers strip frontmatter correctly

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 20.11 | Send `/notes` | Shows note list without any YAML frontmatter lines — just the notes with timestamps | ✅ |
| 20.12 | Send `/summarize` | AI summary describes note content, does not mention or summarize the frontmatter YAML | ✅ |

### 20d. Obsidian vault (optional — only if Obsidian is installed)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 20.13 | Open `data/` folder as an Obsidian vault | Obsidian opens and indexes the files | ☐ |
| 20.14 | Open a daily notes file in Obsidian | Frontmatter renders as a "Properties" panel at top (title, date, tags, type, source) — not raw YAML | ☐ |
| 20.15 | Search for tag `pas/daily-note` in Obsidian | All daily notes files appear in search results | ☐ |
| 20.16 | Search for tag `pas/report` | Report history files appear (if any reports have been run) | ☐ |

---

## 21. n8n Execution APIs (Phase 26)

Requires `API_TOKEN` set in `.env` and n8n running on port 5678. Tests the higher-level execution APIs designed for n8n orchestration.

**Prerequisites:**
- [x] n8n running at `http://localhost:5678`
- [x] `n8n.dispatch_url` configured in `pas.yaml` as `http://localhost:5678/webhook/pas-dispatch`
- [x] Outbound webhooks configured for `data:changed`, `alert:fired`, `report:completed` events
- [x] At least one report exists (e.g., "daily-summary")

### 21a. Schedule listing

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.1 | `GET /api/schedules` | Returns list of registered cron jobs with human-readable descriptions, next/last run times in ISO 8601 | ✅ | Returned daily-diff (2am) and daily-summary (9am) jobs |

### 21b. Report APIs

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.2 | `GET /api/reports` | Returns list of report definitions with id, name, schedule, delivery, sections | ✅ | Returned daily-summary report |
| 21.3 | `GET /api/reports/daily-summary` | Returns single report definition | ✅ |
| 21.4 | `POST /api/reports/daily-summary/run` (no body) | Runs report, returns markdown content and metadata | ✅ | Returned formatted report with "No changes in this period" |
| 21.5 | `POST /api/reports/daily-summary/deliver` with `{"content":"Test delivery"}` | Sends content to report's delivery users via Telegram, returns delivered/total count | ✅ | `{"ok":true,"delivered":1,"total":1}` — message received in Telegram |
| 21.6 | `GET /api/reports/nonexistent` | Returns 404: `"Report not found."` | ✅ |

### 21c. Alert APIs

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.7 | `GET /api/alerts` | Returns list of alert definitions (empty if none created) | ✅ | Returned `[]` |
| 21.8 | `POST /api/alerts/nonexistent/evaluate` | Returns 404: `"Alert not found."` | ✅ |

### 21d. Change log API

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.9 | `GET /api/changes?limit=3` | Returns recent change log entries with since timestamp and count | ✅ | Returned 0 entries (no changes since last period) |

### 21e. LLM proxy API

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.10 | `POST /api/llm/complete` with `{"prompt":"Say hello in 3 words","tier":"fast","maxTokens":50}` | Returns AI-generated text with tier info | ✅ | Returned `"Hello, how are you?"` |

### 21f. Telegram send API

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.11 | `POST /api/telegram/send` with `{"userId":"<your-id>","message":"Test from API"}` | Returns `{"ok":true,"sent":true}`, message appears in Telegram | ✅ |
| 21.12 | `POST /api/telegram/send` with `{"userId":"nobody","message":"test"}` | Returns 403: `"Unregistered user."` | ✅ |

### 21g. Data events (webhook trigger)

| # | Action | Expected Result | Pass? |
|---|--------|-----------------|-------|
| 21.13 | `POST /api/data` write a file | Returns 200; `data:changed` event emitted (outbound webhook to n8n fired if configured) | ✅ | File written; webhook delivery logged (n8n may not have a matching workflow yet, but PAS side works) |

---

## Results Summary

| Section | Items | Passed | Failed | Skipped |
|---------|-------|--------|--------|---------|
| 2. Startup & Health | 3 | 3 | 0 | 0 |
| 3. GUI Access | 4 | 4 | 0 | 0 |
| 4. Telegram Basics | 4 | 4 | 0 | 0 |
| 5. Notes App | 6 | 6 | 0 | 0 |
| 6. Chatbot Fallback | 5 | 5 | 0 | 0 |
| 7. /ask Command | 6 | 6 | 0 | 0 |
| 8. App Management | 5 | 5 | 0 | 0 |
| 9. User Config | 6 | 6 | 0 | 0 |
| 10. LLM Management | 5 | 5 | 0 | 0 |
| 11. Scheduler | 3 | 3 | 0 | 0 |
| 12. Context Store | 6 | | | |
| 13. Shared Spaces | 11 | 5 | 0 | 6 | 13.3 known limitation (notes not space-aware); 13.7-13.10 skipped (no 2nd user) |
| 14. Reports | 7 | 7 | 0 | 0 |
| 15. Alerts | 23 | 19 | 0 | 2 | 15.18-15.19 skipped (no n8n dispatch URL configured) |
| 16. Data Browser | 5 | | | |
| 17. Multi-User | 5 | 0 | 0 | 5 | Skipped — no second Telegram user registered |
| 18. Docker | 6 | 0 | 0 | 6 | Skipped — Docker not installed; test on N100 deployment |
| 19. External Data API | 12 | 10 | 0 | 1 | 19.11 skipped (space deleted before test) |
| 20. Obsidian Frontmatter | 16 | 12 | 0 | 4 | 20.13-20.16 skipped (Obsidian not tested) |
| 21. n8n Execution APIs | 13 | 13 | 0 | 0 |
| **Total** | **156** | **113** | **0** | **19** |

## Issues Found

| # | Section | Description | Severity | Fixed? |
|---|---------|-------------|----------|--------|
| 1 | 2.3 | htmx.min.js missing from public assets — broke all htmx features | Critical | Yes |
| 2 | 2.3 | Login password input missing `autocomplete` attribute | Low | Yes |
| 3 | 2.2 | Health endpoint test used wrong URL (`/heatlh` typo, not a code issue) | N/A | N/A |
| 4 | 14/15 | Report/alert forms used raw text inputs for user IDs, app IDs — replaced with dropdowns | Medium | Yes |
| 5 | 14/15 | Cron schedule input was raw text only — added preset buttons and live description | Medium | Yes |
| 6 | Logs | Dev mode log page showed terse unhelpful message — added explanation | Low | Yes |
| 7 | 6.3-6.5 | Notes app `"remember that"` intent too broad — LLM classifier matched "Remember that my favorite color is blue" to notes instead of chatbot fallback. Changed to `"add to my notes"` | Medium | Yes |
| 8 | 13.3 | Notes app not space-aware — `/note` in a shared space writes to personal dir, not `data/spaces/`. By design (apps adopt spaces individually), but confusing UX. Notes app needs `ctx.spaceId` support | Low | No — design limitation |
| 9 | 13.2 | Space mode indicator could be more prominent — not immediately obvious you're in a shared space | Low | No — UX feedback |
| 10 | 15 | Action type dropdown didn't swap fields on change — no `onchange` handler on action type `<select>`. Switching type left old fields in place | Medium | Yes — refactored to JS-driven `buildActionFields()` + `rebuildActionFields()` |
| 11 | 15 | Webhook action had no n8n integration guidance — plain text URL input with no connection to configured dispatch URL | Low | Yes — added "Use n8n webhook URL" button (when configured) + payload format hint |
| 12 | 3.3 | Nav tabs overflowed to 2 rows at medium viewport widths (~1200-1400px) | Medium | Yes — raised icon-only breakpoint from 1200px to 1400px, changed nav `flex-wrap` to `nowrap` |
