# GUI UX Redesign for Nontechnical Users — Design

**Date:** 2026-07-06
**Status:** Approved (brainstorming dialogue, 2026-07-06)
**Supersedes/absorbs:** UX Hardening Batch 2 (findings I4, I5, I6, I7, I8, M3, M4, M7 from `docs/superpowers/plans/2026-06-11-ux-review-findings-and-fix-plan.md`) and open item D2 (GUI conversation-sessions page).

## Goal

Reorganize the management GUI around what a nontechnical person is trying to do, rather than around the system's internals. Both personas — platform admin and household member — are nontechnical. Every workflow should be completable without knowing what a cron expression, an enum value, or a filesystem path is. All existing functionality must keep working: **no backend contract changes, zero failing tests throughout.**

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Relation to queued UX Hardening Batch 2 | Fold Batch 2's eight verified GUI fixes into this phase (one coherent phase; same templates touched). Batch 2 is retired as a separate phase. |
| Audience | Both personas (admin and member) are nontechnical. |
| Priority workflows | All four: Reports & Alerts creation, Dashboard/orientation, People & household admin, Data browsing & settings — **plus** surfacing backend functionality that has no UI today, and adding useful metrics with graphs. |
| Charts | Vendor a small chart library (Chart.js UMD build) alongside the existing vendored `htmx.min.js`/`pico.min.css`. No CDN; local-first preserved. |
| Device | **Truly both** (amended 2026-07-06 after initial "desktop first" answer): the system is intended to be shared, and how others will use it is unknown — every redesigned flow must be first-class on both desktop and phone. See "Responsive requirements" in §5. |
| Approach | B — task-oriented restructure. Keep the stack (Fastify + Eta + htmx + Pico CSS) and all backend services/route contracts; reorganize presentation. (A "polish in place" and C "full rebuild" were considered and rejected: A doesn't streamline workflows; C has unacceptable correctness risk.) |

## Non-goals

- **No SPA / framework change.** The GUI stays server-rendered Eta + htmx.
- **No backend service or data-format changes.** Wizards and new pages are presentation over existing services and POST handler contracts.
- **No restore-from-GUI button.** Backup restore remains a documented manual procedure (too destructive for a web action). The Backups page links to the procedure.
- **No config-file editing from the GUI.** Where a fix requires `pas.yaml` changes (e.g., enabling backups), the GUI shows exact copy-paste instructions instead.
- **No URL/route renames.** Existing paths (`/gui/reports`, `/gui/alerts`, …) are stable; only labels, grouping, and additive new routes change.

## 1. Navigation and information architecture

Sidebar regroups into plain-language sections. URLs unchanged; admin-only items remain gated by `isPlatformAdmin` exactly as today.

| Section | Items (route) | Visibility |
|---|---|---|
| — | Home (`/gui/`) | all |
| Automations | Reports (`/gui/reports`), Alerts (`/gui/alerts`) | all |
| People and sharing | Household (`/gui/users`, relabeled + extended), Shared spaces (`/gui/spaces`) | Household: all — members get a read-only view (a deliberate change from today's admin-only page); management actions stay admin-gated. Spaces: all |
| Your data | Files (`/gui/data`), Conversations (`/gui/sessions`, **new**), Activity (`/gui/activity`, **new**, scoped per user) | all |
| System | Apps (`/gui/apps`), Scheduler (`/gui/scheduler`), AI usage (`/gui/llm`), Backups (`/gui/backups`, **new**), Logs (`/gui/logs`), Regression (`/gui/regression`), Context (`/gui/context`) | admin (AI usage: all, scoped to own usage for members) |
| — | Settings (`/gui/settings`), Account (`/gui/account`) | all |

Labels are humanized ("LLM" → "AI usage"; "Users" → "Household"; "Data" → "Files"). The label-humanization helper (§5, M3) is the single source for these strings.

## 2. Home page

Replaces the ops-stats dashboard (uptime, cron count, raw config table). Three zones; admins see system-wide data, members see the same layout scoped to their own data with system-health items hidden.

1. **Needs attention** — conditional banner cards rendered only when true:
   - Backups disabled in config, or last backup failed/stale (BackupService + `config.backup`) — admin only.
   - LLM provider (Ollama/remote) unreachable — admin only.
   - Monthly AI spend approaching the household cap (CostTracker).
   - An app failed to load at startup — admin only.
   - When nothing needs attention: a quiet "All systems normal."
2. **At a glance** — metric cards in plain words: AI spend this month (cost log), messages this week (chat-transcript SQLite index), active alerts count, next scheduled report with human time ("Weekly meal plan — tomorrow 7:00 AM").
3. **Activity** — two Chart.js charts: AI spend by day (last 30 days) and message/alert-firing counts by day; plus a recent-changes list from the daily-diff change log, linking to the Activity page.

The removed ops details (uptime, cron jobs, config table, registered-users table) move to the System pages where they belong (Scheduler, Apps, Household); nothing is deleted.

## 3. Guided creation flows (Reports and Alerts)

Both creation/edit flows become short guided steps: server-rendered htmx fragments, each step a `<form>` POSTing to a validate-and-render-next-step endpoint, carrying prior values as named hidden fields (server round-trip, no client state to lose — this **replaces** the JS-synced hidden-input pattern, fixing audit I8).

Steps:

1. **What to watch / what to include** — data selection by friendly names sourced from FileIndexService (app + file descriptions), never raw paths. Reports: pick section types with plain descriptions (changes / app data / context / custom).
2. **When** — schedule presets ("Every morning at 7", "Weekly on Sunday", "Every hour", "When data changes" for event-triggered alerts) that generate the cron string; a live "Next run: …" preview computed by the same cron parser the scheduler uses. Raw cron editing under an "Advanced" disclosure.
3. **Condition** (alerts only) — two modes:
   - *Build a rule*: structured picker over the engine's actual deterministic grammar (six patterns: is empty / is not empty / contains "…" / doesn't contain "…" / has more than N lines / has fewer than N lines), rendered in plain language. No new grammar is invented; the picker emits exactly the expression strings `evaluateDeterministic` recognizes.
   - *Describe it in your own words*: free text mapping to the fuzzy/LLM condition type. Judgment-style conditions ("anything expiring within 2 days") belong here, and the mode card says so.
4. **What happens** — alert actions as picker cards with plain names ("Send me a Telegram message", "Run a report", "Call a webhook", "Write to a file", "Play a sound", "Dispatch a message"); template variables (`{data}`, `{summary}`, `{alert_name}`, `{date}`) offered as insert buttons with one-line plain-language explanations; cooldown as a plain field ("Don't repeat this alert for … hours") with a sensible default. Reports: delivery + optional AI summary (tier picker with plain labels, prompt under Advanced).
5. **Review** — a generated human-readable sentence describing the automation ("Every morning at 7, check Pantry items; if any item expires within 2 days, send you a Telegram message"). The same sentence renders on the list pages as the item's description line.

**Contract preservation:** the final step submits to the existing create/update handlers with the exact field contract the current forms use (`name`, `schedule`, `condition_type`, `condition_expression`, `trigger_type`, `cooldown`, `delivery`, actions, report sections, `llm_*`). Contract tests assert wizard output equals current-form payload shape. Editing prefills the same steps.

## 4. People & sharing hub, and newly surfaced features

### Household (`/gui/users`, relabeled)
- Member cards: display name first, plain-language role, per-member app access.
- **Invite someone** guided flow: generate code via InviteService → copy-paste instruction card ("Send this to them in Telegram: message @bot `/start <code>`") → optional follow-up to set their GUI password (audit O3's GUI-side mitigation: admin does it in one guided place instead of out-of-band improvisation).
- Password set/reset absorbed here (existing credentials routes).
- Non-admin: read-only view of their own household.

### Shared spaces (`/gui/spaces`)
- Plain-language reframing: per-space membership and which apps' data it covers; guided create/join. No SpaceService changes.

### Conversations (`/gui/sessions`) — new, implements open item D2
- Per-user session list (title, date, turn count), read-only transcript view, full-text search via the existing chat-transcript SQLite FTS index. Non-admins see only their own sessions. No edit/delete.

### Backups (`/gui/backups`) — new, admin only
- Status card: enabled?, last backup time/size, retention count; list of archives; **Back up now** button (POST, CSRF, admin-gated) calling BackupService.
- When disabled (current production state, audit BKP-1): the page and the Home attention banner show the exact `pas.yaml` snippet to enable.
- Restore: link to the documented manual procedure only.

### Activity (`/gui/activity`) — new
- Friendly feed of daily-diff change summaries (`data/system/daily-diff/`), scoped: members see their own/shared changes, admins see all.

### AI usage (`/gui/llm`, relabeled)
- Adds Chart.js time-series (spend/tokens by day) and breakdowns by person and app with plain-language framing; household cap progress. Members see own usage; admins see all. Data source: the existing cost log already parsed by `llm-usage.ts`.

## 5. Cross-cutting patterns (absorbs UX Hardening Batch 2)

| Audit finding | Resolution in this design |
|---|---|
| I4 session-expiry login page unexplained | Login page states why you were signed out and what to do. |
| I5 unstyled htmx error responses | One shared error-fragment partial; all htmx endpoints return it on failure; styled inline. |
| I6 no spinner/disabled state | Global htmx loading indicator + auto-disabled submit buttons during requests. |
| I7 rate-limit message lacks guidance | Message states the wait time and recovery step. |
| I8 JS-synced hidden inputs lose state | Eliminated by wizard architecture (server-rendered steps, named fields). |
| M3 raw enum labels | Single label-humanization helper (`humanizeLabel`) used by all templates; no raw enum/system string reaches the screen. |
| M4 missing reset confirmations | Existing `data-confirm-delete` confirmation pattern applied to all destructive/reset actions. |
| M7 missing aria-labels | aria-labels on scope radio groups and icon-only buttons; keyboard focus order verified per redesigned page. |

**Charts implementation:** Chart.js UMD build vendored at `core/src/gui/public/chart.umd.min.js` (matches existing vendored-asset pattern; version + provenance documented in `core/src/gui/public/README.md`). Charts read small JSON endpoints under `/gui/api/metrics/*` — server-computed, permission-scoped (user/household), unit-tested. Chart layer is presentation-only.

**Voice:** sentence case, verb-first buttons, no raw exception strings, errors say what happened + what to do, empty states invite rather than apologize.

**Responsive requirements** (every redesigned or new page — the system will be shared and the audience's devices are unknown):
- Single-column layout at narrow viewports: metric cards stack, wizard steps are one column, tables that can't fit collapse to stacked label/value rows or scroll horizontally without breaking the page.
- Touch targets ≥ 44×44 px for all interactive elements (buttons, step navigation, picker cards, chart legend toggles).
- Charts resize with the viewport (Chart.js responsive mode) and remain legible at ~375 px width; where a chart is too dense for phones, show a simplified variant, not a clipped one.
- The existing hamburger/overlay sidebar remains the mobile navigation; new nav sections must work within it.
- No hover-only affordances: anything revealed on hover must also be reachable by tap/focus.

## 6. Correctness strategy

- **Zero failing tests policy holds after every batch.** The existing GUI suite (30+ test files: auth, CSRF, admin guards, escaping, settings concurrency) must stay green.
- **Contract tests** for both wizards: final submission payload shape equals what the current forms produce, verified against the existing handler expectations.
- **Schedule presets**: unit tests for preset→cron mapping and next-run preview (uses the scheduler's own parser — no second cron implementation).
- **New routes** each get tests per `pas-testing-standards`: auth guard, admin/user scoping, CSRF on POSTs, output escaping (transcript content, user-supplied names), error paths.
- **Responsive verification**: each batch's acceptance includes a manual check of its redesigned pages at a phone viewport (~375 px) and desktop — layout integrity, touch-target size, chart legibility per the §5 responsive requirements. (Server-rendered markup keeps this a check of CSS/markup, not a JS test-infrastructure investment.)
- **Security posture** (per `pas-security-posture` skill): transcript viewer HTML-escapes all stored content; metrics endpoints derive scope from the session, never from query params alone; backup trigger admin-gated + CSRF; no new path handling accepts user-supplied paths.
- **Docs:** URS entries + traceability matrix per `pas-urs-workflow`; phase write-up in `docs/implementation-phases.md`; one-line CLAUDE.md status bullet; `docs/open-items.md` updated (retire Batch 2 and D2 as absorbed here).

## 7. Phasing

Seven batches, each an independently shippable vertical slice (code + tests + docs), ordered so shared patterns land first:

1. **Nav regroup + cross-cutting patterns** — sidebar sections/labels, error fragment, loading indicators, confirmations, `humanizeLabel`, aria fixes, login-page messages (I4, I5, I6, I7, M3, M4, M7).
2. **Home page** — attention banners, metric cards, `/gui/api/metrics/*` endpoints, Chart.js vendoring, activity snippet.
3. **Report wizard** (I8 pattern retired for reports).
4. **Alert wizard** (I8 fully retired).
5. **Household & sharing hub** — invite flow, password management absorption, spaces reframing.
6. **New surfaces** — Conversations, Backups, Activity, AI-usage charts.
7. **URS/docs/traceability sweep** — plus open-items reconciliation.

Codex review at end of implementation per standard cadence; subagent-driven batch execution.

## Out-of-scope follow-ons (already tracked in `docs/open-items.md`)

- Quiet hours / vacation pause for proactive messages (N1 layers 2–3).
- Per-household settings inheritance UX.
- Food household ← platform household unification (O2 layer 3).
- Collaboration space UX (D5a §4).
