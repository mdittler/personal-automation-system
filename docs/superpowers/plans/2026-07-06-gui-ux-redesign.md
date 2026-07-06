# GUI UX Redesign for Nontechnical Users — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution is continuous through all batches with a single Codex review at the end.

**Goal:** Reorganize the management GUI around user tasks for nontechnical users (both personas), fold in the eight UX Hardening Batch 2 fixes, surface four backend features that have no UI today, and add metric charts — with zero backend contract changes and zero failing tests throughout.

**Architecture:** Seven batches, each an independently shippable vertical slice. Batch 1 lands shared cross-cutting patterns (labels, errors, spinners, confirmations, nav regroup). Batch 2 replaces the dashboard with a three-zone Home fed by new permission-scoped JSON metrics endpoints and vendored Chart.js. Batches 3–4 replace the report/alert mega-forms with htmx step wizards that submit the **exact existing POST field contracts**. Batch 5 turns Users into a Household hub with a guided invite flow. Batch 6 adds the four new surfaces (Conversations, Backups, Activity, AI-usage charts). Batch 7 is the documentation footprint.

**Tech Stack:** Node 22 + TypeScript 5 ESM, pnpm workspaces. Fastify + Eta + htmx + Pico CSS, all assets vendored under `core/src/gui/public/`. Vitest, Biome. New vendored asset: Chart.js UMD.

**Spec:** `docs/superpowers/specs/2026-07-06-gui-ux-redesign-design.md` (approved 2026-07-06).

---

## Context

The GUI works but is organized around system internals (cron strings, enum values, filesystem paths, ops stats). The intended users — household members AND the admin — are nontechnical, and the system will be shared publicly, so unknown users on unknown devices (desktop + phone both first-class) must be able to complete every workflow. A 2026-06-11 UX audit verified 8 GUI-specific defects (I4–I8, M3, M4, M7) queued as "UX Hardening Batch 2"; this phase absorbs them. Four backend capabilities have no UI: conversation transcripts (SQLite FTS index), backups (BackupService), daily change digests (`data/system/daily-diff/`), and time-series LLM cost data (`data/system/llm-usage.md`).

### Grounded contracts (verified 2026-07-06 — do not re-derive, but re-verify line numbers before editing)

| Contract | Location | Fact |
|---|---|---|
| Alert POST fields | `core/src/gui/routes/alerts.ts:390-470` | `name`, `description`, `schedule`, `cooldown`, `delivery` (comma-sep), `trigger_type` (`scheduled`\|`event`), `trigger_event_name`, `condition_type` (`deterministic`\|`fuzzy`), `condition_expression`, numbered `ds_{app_id,scope,space_id,user_id,path}_{i}` (i<20), numbered `action_type_{i}` + per-type config fields (`action_message_{i}`, `action_report_id_{i}`, `action_webhook_url_{i}`, `action_wd_*_{i}`, `action_audio_*_{i}`, `action_dispatch_*_{i}`), `enabled`, `id` |
| Report POST fields | `core/src/gui/routes/reports.ts:359` area | `name`, `description`, `schedule`, `delivery`, `enabled`, `id`, `llm_enabled`, `llm_prompt`, `llm_tier`, `llm_max_tokens`, numbered `section_type_{i}` + per-type section fields |
| Deterministic condition grammar | `core/src/services/condition-evaluator/evaluator.ts` `evaluateDeterministic` | EXACTLY: `empty`/`is empty`, `not empty`/`is not empty`, `contains "X"`, `not contains "X"`, `line count > N`, `line count < N`. Anything else logs a warning and returns false. |
| Cron helpers | `core/src/utils/cron-describe.ts` | `describeCron(expr)`, `getNextRun(expr, tz): Date\|null`, `formatRelativeTime(date)` already exist — reuse, never reimplement. |
| Cost log | `data/system/llm-usage.md`, parsed by `parseUsageMarkdown` in `core/src/gui/routes/llm-usage.ts` | Markdown table rows: timestamp, provider, model, inputTokens, outputTokens, cost, app, user. |
| Transcript index | `core/src/services/chat-transcript-index/chat-transcript-index.ts` | `ChatTranscriptIndex` interface: `searchSessions(InternalSearchFilters)`, `getSessionMeta(id)`, `getMessageCount(id)`. No list-sessions / list-messages methods yet (additive methods needed — additive is allowed; breaking is not). |
| BackupService | `core/src/services/backup/index.ts` | `createBackup(): Promise<string>` (archive path, `''` on failure), `cleanupOldBackups()`. Constructed in `bootstrap.ts:68-84` ONLY when `config.backup.enabled` — GUI wiring must handle the disabled case. |
| InviteService | `core/src/services/invite/index.ts:91` | `createInvite(name, createdBy, opts?: {householdId?, role?: 'admin'\|'member'\|'child', initialSpaces?, enabledApps?}): Promise<string>`; `listInvites()`, `cleanup()`. |
| Change log | `core/src/services/daily-diff/collector.ts` | `collectChanges(logPath, since): Promise<DailyChanges>` groups JSONL entries `byApp[app][user]` — per-user scoping is available. Daily digests at `data/system/daily-diff/*.md`. |
| View locals | `core/src/gui/view-locals.ts` | Every template gets `it.currentUser`, `it.isPlatformAdmin`, `it.isHouseholdAdmin`, `it.csrfToken`. Registration order: auth → csrf → view-locals → routes. |
| Users page guard | `core/src/gui/routes/users.ts:40` | `/users` is `platformAdminOnly` today; Batch 5 deliberately opens a read-only member view (spec §1). |
| Sidebar/nav | `core/src/gui/views/layout.eta:50-143` | Static `<li>` list, admin items behind `it.isPlatformAdmin`. |

### Rules that bind every batch

- **Zero failing tests** after every task (`pnpm test`); **zero Biome errors** (`pnpm lint`).
- **No breaking backend changes.** Additive service methods are allowed (e.g., new read-only queries on the transcript index); changing existing signatures, POST field contracts, or data formats is not.
- **Responsive requirements** (spec §5) apply to every template touched: single-column stacking at ~375px, ≥44px touch targets, no hover-only affordances, charts responsive.
- **Voice** (spec §5): sentence case, verb-first buttons, no raw enums/exceptions, errors say what happened + what to do.
- **Security** (`pas-security-posture`): all new POSTs behind CSRF; scoping derived from `request.user`, never from query params alone; all rendered user/stored content escaped (Eta `<%= %>`, never `<%~ %>` for untrusted data).
- Subagents implementing template changes MUST verify rendering with the route tests (every routed view has a test that renders it), not by eye.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `core/src/gui/utils/humanize.ts` | `humanizeLabel()` — single source for enum/system-string → plain-language labels (M3) + nav label map. |
| `core/src/gui/utils/error-fragment.ts` | `sendErrorFragment(reply, status, title, hint)` — styled htmx error partial helper (I5). |
| `core/src/gui/views/partials/error-fragment.eta` | The styled error markup. |
| `core/src/gui/utils/schedule-presets.ts` | Preset list, `presetToCron()`, `cronToPresetId()`, next-run preview via `cron-describe`. |
| `core/src/gui/utils/describe-automation.ts` | `describeReport(def)` / `describeAlert(def)` — the human-readable review sentences. |
| `core/src/gui/utils/rule-builder.ts` | Deterministic-grammar picker ↔ expression string mapping (exactly the 6 patterns). |
| `core/src/gui/routes/metrics.ts` | `GET /gui/api/metrics/llm-daily`, `GET /gui/api/metrics/activity-daily` — permission-scoped JSON for charts. |
| `core/src/gui/routes/report-wizard.ts` | Report wizard step engine (GET entry + POST step advance + final submit renders hidden-field contract form). |
| `core/src/gui/routes/alert-wizard.ts` | Alert wizard step engine. |
| `core/src/gui/routes/sessions.ts` | Conversations list/search/detail (read-only). |
| `core/src/gui/routes/backups.ts` | Backups status/list/“Back up now” (admin). |
| `core/src/gui/routes/activity.ts` | Activity digest feed (scoped). |
| `core/src/gui/views/home.eta` | New three-zone Home (replaces dashboard.eta usage; dashboard.eta deleted after cutover). |
| `core/src/gui/views/report-wizard.eta` + `core/src/gui/views/partials/report-wizard-step-{1..4}.eta` | Report wizard shell + step fragments. |
| `core/src/gui/views/alert-wizard.eta` + `core/src/gui/views/partials/alert-wizard-step-{1..5}.eta` | Alert wizard shell + step fragments. |
| `core/src/gui/views/sessions.eta`, `core/src/gui/views/session-detail.eta` | Conversations pages. |
| `core/src/gui/views/backups.eta` | Backups page. |
| `core/src/gui/views/activity.eta` | Activity page. |
| `core/src/gui/public/chart.umd.min.js` | Vendored Chart.js (version + provenance in `public/README.md`). |
| `core/src/gui/charts/registry.ts` | **Declarative chart registry** — one descriptor per chart (id, title, page, endpoint, type, series, height). The ONLY file to touch to add/revise/remove a chart. |
| `core/src/gui/public/pas-charts.js` | Shared client helper: finds `[data-pas-chart]` slots, fetches the descriptor's endpoint, instantiates Chart.js. Chart-agnostic; never edited per-chart. |
| `docs/GUI_CHARTS.md` | How-to recipe for adding/revising/removing charts (written for future Claude sessions and humans). |
| `core/src/gui/charts/__tests__/registry.test.ts` | Registry contract test — every descriptor references a real endpoint + supported type. |
| `core/src/services/chat-transcript-index/list-queries.ts` | Additive read-only queries: `listSessionsForUser`, `listMessagesForSession`, `countMessagesByDay`. |
| Tests | `core/src/gui/__tests__/{humanize,error-fragment,nav-regroup,home,metrics,report-wizard,alert-wizard,household,sessions,backups,activity}.test.ts`, `core/src/gui/utils/__tests__/{schedule-presets,describe-automation,rule-builder}.test.ts`, `core/src/services/chat-transcript-index/__tests__/list-queries.test.ts` |

**Modified files (headline changes)**

| Path | Change |
|---|---|
| `core/src/gui/views/layout.eta` | Nav regroup + humanized labels + global htmx loading indicator + error toast region. |
| `core/src/gui/views/login.eta`, `core/src/gui/auth.ts` | I4 expiry reason (`?reason=expired\|invalid`), I7 rate-limit recovery wording. |
| `core/src/gui/views/{settings,alerts,reports,users,spaces,data,app-detail}.eta` | M3 labels, M4 confirmations, M7 aria-labels, I6 indicators — as touched per batch. |
| `core/src/gui/routes/dashboard.ts` | Becomes the Home route (attention banners + glance metrics + activity snippet). |
| `core/src/gui/routes/{reports,alerts}.ts` | Add wizard entry links; list pages render `describeReport/Alert` sentence. **POST contracts untouched.** |
| `core/src/gui/routes/users.ts` | Household hub: member-visible read-only view; invite flow (admin); guard change is explicit + tested. |
| `core/src/gui/index.ts` | Register new route modules; thread new deps (`chatTranscriptIndex`, `backup` config/service, `changeLogPath`, `inviteService`). |
| `core/src/bootstrap.ts` | Pass the new deps into `registerGuiRoutes` (BackupService instance when enabled; `config.backup` always). |
| `core/src/gui/public/README.md` | Chart.js provenance. |
| `docs/urs.md`, `docs/implementation-phases.md`, `docs/open-items.md`, `CLAUDE.md` | Batch 7 documentation footprint. |

---

## Batch 1 — Nav regroup + cross-cutting patterns (I4, I5, I6, I7, M3, M4, M7)

### Task 1.1: `humanizeLabel` utility

**Files:**
- Create: `core/src/gui/utils/humanize.ts`
- Test: `core/src/gui/utils/__tests__/humanize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { humanizeLabel } from '../humanize.js';

describe('humanizeLabel', () => {
	it('maps known system strings to plain language', () => {
		expect(humanizeLabel('deterministic')).toBe('Exact rule');
		expect(humanizeLabel('fuzzy')).toBe('AI judgment');
		expect(humanizeLabel('telegram_message')).toBe('Send a Telegram message');
		expect(humanizeLabel('run_report')).toBe('Run a report');
		expect(humanizeLabel('webhook')).toBe('Call a webhook');
		expect(humanizeLabel('write_data')).toBe('Write to a data file');
		expect(humanizeLabel('audio')).toBe('Play a sound');
		expect(humanizeLabel('dispatch_message')).toBe('Send a message as the user');
		expect(humanizeLabel('scheduled')).toBe('On a schedule');
		expect(humanizeLabel('event')).toBe('When something happens');
	});
	it('falls back to title-cased words for unknown snake_case values', () => {
		expect(humanizeLabel('some_unknown_value')).toBe('Some unknown value');
	});
	it('never returns an empty string', () => {
		expect(humanizeLabel('')).toBe('');
		expect(humanizeLabel('x')).toBe('X');
	});
});
```

- [ ] **Step 2: Run it, verify FAIL** — `pnpm vitest run core/src/gui/utils/__tests__/humanize.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
/** Single source for system-string → plain-language labels (audit M3). */
const LABELS: Record<string, string> = {
	deterministic: 'Exact rule',
	fuzzy: 'AI judgment',
	telegram_message: 'Send a Telegram message',
	run_report: 'Run a report',
	webhook: 'Call a webhook',
	write_data: 'Write to a data file',
	audio: 'Play a sound',
	dispatch_message: 'Send a message as the user',
	scheduled: 'On a schedule',
	event: 'When something happens',
	changes: 'Recent changes',
	'app-data': 'App data',
	context: 'Saved context',
	custom: 'Custom text',
};

export function humanizeLabel(value: string): string {
	if (!value) return '';
	const known = LABELS[value];
	if (known) return known;
	const words = value.replace(/[_-]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
```

- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: Sweep templates for raw enums.** `rg -n "condition\?.type|conditionType|action\.type|trigger\?.type|section\.type" core/src/gui/views core/src/gui/routes` — every place a raw enum reaches a template local, wrap with `humanizeLabel()` in the **route** (templates stay logic-light). Known sites: alerts list (`conditionType`), alert-edit action labels, report-edit section labels. Update the corresponding existing tests' fixtures if they asserted raw strings.
- [ ] **Step 6: `pnpm test` (full suite) + `pnpm lint` → green. Commit:** `feat(gui): humanizeLabel utility; no raw enum labels in templates (M3)`

### Task 1.2: Styled htmx error fragment (I5)

**Files:**
- Create: `core/src/gui/utils/error-fragment.ts`, `core/src/gui/views/partials/error-fragment.eta`
- Modify: `core/src/gui/views/layout.eta` (toast region + `htmx:responseError` handler)
- Test: `core/src/gui/__tests__/error-fragment.test.ts`

- [ ] **Step 1: Failing test** — a route test that triggers a known htmx-error path (use an existing settings validation failure) and asserts the response is `text/html` containing `class="pas-error-card"`, the plain-language title, and NO raw stack/exception text.

```ts
// core/src/gui/__tests__/error-fragment.test.ts — reuse buildTestServer from auth-test-helpers.ts
it('returns a styled fragment, not plain text, on htmx validation failure', async () => {
	const res = await server.inject({
		method: 'POST',
		url: '/gui/settings', // pick the smallest existing failing-validation POST; adjust per actual route
		headers: { 'hx-request': 'true', cookie, 'x-csrf-token': csrf },
		payload: { /* invalid payload for that route */ },
	});
	expect(res.statusCode).toBeGreaterThanOrEqual(400);
	expect(res.headers['content-type']).toContain('text/html');
	expect(res.body).toContain('pas-error-card');
	expect(res.body).not.toMatch(/Error:|at .*\.ts:\d+/);
});
```

- [ ] **Step 2: Implement helper + partial**

```ts
// core/src/gui/utils/error-fragment.ts
import type { FastifyReply } from 'fastify';

/** Render the shared styled error fragment for htmx responses (audit I5). */
export async function sendErrorFragment(
	reply: FastifyReply,
	status: number,
	title: string,
	hint?: string,
): Promise<FastifyReply> {
	reply.status(status);
	return reply.viewAsync('partials/error-fragment', { title, hint });
}
```

```html
<!-- core/src/gui/views/partials/error-fragment.eta -->
<div class="pas-error-card" role="alert">
  <strong><%= it.title %></strong>
  <% if (it.hint) { %><p><%= it.hint %></p><% } %>
</div>
```

Add `.pas-error-card` styles to `core/src/gui/public/pas.css` (bordered card, danger tint, works in dark theme).

- [ ] **Step 3: Sweep htmx endpoints returning `reply.status(4xx).send('plain text')`.** `rg -n "\.send\('" core/src/gui/routes` — replace user-facing plain-text error sends on htmx-capable routes with `sendErrorFragment(...)` using plain-language `title`/`hint` ("Couldn't save the alert. The name is required."). Full-page POST redirect flows keep their existing behavior.
- [ ] **Step 4: Layout toast region:** add `<div id="pas-toast" aria-live="polite"></div>` to `layout.eta` and a small script: on `htmx:responseError`, if the response body contains `pas-error-card`, insert it into `#pas-toast` (replacing previous content, auto-dismiss after 8s); else insert a generic styled "Something went wrong — try again" card. This guarantees NO unstyled failure, even for network errors.
- [ ] **Step 5: Tests pass, full suite, lint. Commit:** `feat(gui): shared styled error fragment for all htmx failures (I5)`

### Task 1.3: Global loading indicators + disabled submits (I6)

**Files:**
- Modify: `core/src/gui/views/layout.eta`, `core/src/gui/public/pas.css`
- Test: `core/src/gui/__tests__/nav-regroup.test.ts` (asserts markup presence; created in Task 1.5, so here assert in an existing layout-rendering test)

- [ ] **Step 1:** In `layout.eta`, set `hx-indicator` defaulting via `htmx.config` script (`htmx.config.includeIndicatorStyles = false`) and add a delegated listener: on `htmx:beforeRequest` disable the triggering submit button + add `aria-busy="true"`; on `htmx:afterRequest` re-enable. Add a `.htmx-request .pas-spinner` CSS spinner and append `<span class="pas-spinner" aria-hidden="true"></span>` styling hooks in `pas.css`. Non-htmx full-page form posts: add a `submit` listener that sets `aria-busy` + disables the button (do NOT disable before the form serializes — use `setTimeout(0)`).
- [ ] **Step 2:** Assert via an existing rendered-page test that the layout script includes `htmx:beforeRequest` wiring (string assertion is acceptable for layout plumbing).
- [ ] **Step 3: Full suite + lint. Commit:** `feat(gui): global loading indicators and disabled submits during requests (I6)`

### Task 1.4: Login page explanations (I4, I7)

**Files:**
- Modify: `core/src/gui/auth.ts`, `core/src/gui/views/login.eta`
- Test: extend `core/src/gui/__tests__/auth.test.ts` (or a new `login-reasons.test.ts` if that file is already long)

- [ ] **Step 1: Failing tests:**

```ts
it('redirects to /gui/login?reason=expired when the session cookie is expired', async () => { /* age a valid cookie past 24h (fake timers or issuedAt manipulation), GET /gui/, expect 302 to /gui/login?reason=expired */ });
it('login page explains the expiry reason', async () => { /* GET /gui/login?reason=expired → body contains "You were signed out because your session expired" */ });
it('rate-limit response names the wait time and recovery step', async () => { /* exceed the login rate limit, expect message matching /wait .* minutes? and try again/i */ });
```

- [ ] **Step 2:** In `auth.ts`, where an invalid/expired cookie triggers the login redirect, append `?reason=expired` (expired) / `?reason=invalid` (bad signature / sessionVersion mismatch — wording: "You were signed out because your password was changed or the server restarted"). In `login.eta`, render a quiet info card per `reason` (escape everything; unknown reasons render nothing). Update the rate-limit handler's message to include the actual window ("Too many attempts. Wait 15 minutes and try again." — read the real window from the limiter config, don't hardcode if it's configurable).
- [ ] **Step 3: Tests pass, full suite, lint. Commit:** `feat(gui): login page explains sign-outs and rate limits (I4, I7)`

### Task 1.5: Nav regroup + relabels + M4 confirmations + M7 aria-labels

**Files:**
- Modify: `core/src/gui/views/layout.eta`, `core/src/gui/views/{settings,users,data}.eta` (aria/confirm sweeps)
- Test: `core/src/gui/__tests__/nav-regroup.test.ts`

- [ ] **Step 1: Failing test:**

```ts
describe('nav regroup', () => {
	it('shows plain-language sections to an admin', async () => {
		const body = await getRendered('/gui/', adminCookie);
		for (const label of ['Home', 'Automations', 'People and sharing', 'Your data', 'System', 'Reports', 'Alerts', 'Household', 'Shared spaces', 'Files', 'AI usage']) {
			expect(body).toContain(label);
		}
		expect(body).not.toContain('>LLM<'); // old label gone
	});
	it('hides the System section items from a non-admin member', async () => {
		const body = await getRendered('/gui/', memberCookie);
		for (const admin of ['Apps', 'Scheduler', 'Logs', 'Regression', 'Context', 'Backups']) expect(body).not.toContain(`>${admin}<`);
		expect(body).toContain('Household'); // member sees read-only entry (route change in Batch 5; nav link may 403 until then — assert link only after Batch 5, so in THIS batch keep Household admin-gated in nav and flip in Task 5.2)
	});
});
```

- [ ] **Step 2:** Rewrite the sidebar `<ul>` per spec §1: section headers (non-interactive `<li class="nav-section-label">`), items per the spec table. Labels via `humanizeLabel`-style constants (nav labels live in the template — they're static). **Keep every existing route href unchanged.** Add `aria-label` to the icon-only theme/hamburger buttons; sweep `role="radiogroup"` scope selectors in `data.eta`/`settings.eta` for missing `aria-label` (M7); apply `data-confirm-delete="Are you sure? This resets …"` to reset/destructive forms found via `rg -n "[Rr]eset" core/src/gui/views` (M4).
- [ ] **Step 3: Tests pass. Run the FULL suite — nav changes touch every rendered-page assertion; fix any test that asserted old labels.** Lint. **Commit:** `feat(gui): task-oriented nav regroup, confirmations, aria-labels (M4, M7)`

### Batch 1 gate
- [ ] `pnpm test` → zero failures; `pnpm lint` → zero errors.
- [ ] Responsive check: layout at 375px — sidebar overlay works, section labels wrap, touch targets ≥44px.

---

## Batch 2 — Home page + metrics endpoints + Chart.js

### Task 2.1: Vendor Chart.js

**Files:**
- Create: `core/src/gui/public/chart.umd.min.js`
- Modify: `core/src/gui/public/README.md`

- [ ] **Step 1:** Download Chart.js v4 UMD (`https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js`), save to `core/src/gui/public/chart.umd.min.js`. Record exact version + source URL + SHA256 in `public/README.md` (match the existing htmx/pico provenance entries).
- [ ] **Step 2:** Confirm the static-asset route serves it: existing public-asset handling in `gui/index.ts` (same mechanism as `htmx.min.js`). Add a route test asserting `GET /gui/public/chart.umd.min.js` → 200, `content-type` includes `javascript`.
- [ ] **Step 3: Commit:** `feat(gui): vendor Chart.js v4 UMD (local-first charts)`

### Task 2.2: Metrics JSON endpoints

**Files:**
- Create: `core/src/gui/routes/metrics.ts`
- Modify: `core/src/gui/index.ts` (register; thread `dataDir`, transcript index, alert service)
- Test: `core/src/gui/__tests__/metrics.test.ts`

- [ ] **Step 1: Failing tests (write all four):**

```ts
describe('GET /gui/api/metrics/llm-daily', () => {
	it('requires auth', async () => { /* no cookie → 302 or 401 per existing auth behavior */ });
	it('returns per-day cost/token totals for the requesting member, own rows only', async () => {
		// seed data/system/llm-usage.md (temp dataDir) with rows for user A and user B across 3 days
		// as member A: expect days array, each { date, cost, inputTokens, outputTokens }, totals exclude B's rows
	});
	it('returns all users aggregated for a platform admin, with per-user breakdown', async () => {});
	it('handles a missing usage file with an empty series, not an error', async () => {});
});
```

- [ ] **Step 2: Implement.** Reuse `parseUsageMarkdown` — **export it from `llm-usage.ts`** (it is file-local today; exporting is additive). Aggregate rows by `timestamp.slice(0,10)`; scope: `request.user.isPlatformAdmin ? all : rows.filter(r => r.user === request.user.userId)`. Window: last 30 days (`?days=30`, clamp 1–90). Response shape:

```ts
interface LlmDailyResponse {
	days: Array<{ date: string; cost: number; inputTokens: number; outputTokens: number }>;
	perUser?: Array<{ user: string; cost: number }>; // admin only
	perApp: Array<{ app: string; cost: number }>;
}
```

- [ ] **Step 3:** `GET /gui/api/metrics/activity-daily` — per-day message counts from the transcript index (uses `countMessagesByDay` added in Task 2.3 — implement 2.3 first if convenient, order within the batch is 2.3 → 2.2 acceptable) + per-day alert firings (parse alert-history data the same way the existing `alert-history` route does — reuse its loader function, exporting it if file-local). Same scoping rules. Same test categories (auth, member scope, admin, empty). Response shape (keys MUST match the Task 2.5 registry series keys):

```ts
interface ActivityDailyResponse {
	days: Array<{ date: string; messages: number; alertFirings: number }>;
}
```
- [ ] **Step 4: Full suite + lint. Commit:** `feat(gui): permission-scoped metrics endpoints for charts`

### Task 2.3: Additive transcript-index queries

**Files:**
- Create: `core/src/services/chat-transcript-index/list-queries.ts`
- Modify: `core/src/services/chat-transcript-index/chat-transcript-index.ts` (interface + impl delegate), `core/src/services/chat-transcript-index/index.ts` (exports)
- Test: `core/src/services/chat-transcript-index/__tests__/list-queries.test.ts`

- [ ] **Step 1: Failing tests:** seed an index (same helper pattern as existing tests in that dir) with 2 users × several sessions/messages; assert:

```ts
listSessionsForUser(db, { userId: 'a', limit: 20, offset: 0 })
// → sessions ordered by started_at DESC, only user a's, each { id, title, startedAt, endedAt, messageCount }
listMessagesForSession(db, sessionId)
// → ordered by timestamp ASC, each { role, text, timestamp }
countMessagesByDay(db, { userId: 'a', sinceIso })
// → [{ date: 'YYYY-MM-DD', count }] only user a's; with userId omitted → all users (admin path)
```

- [ ] **Step 2: Implement** as read-only prepared statements in `list-queries.ts`; add the three methods to the `ChatTranscriptIndex` interface + `ChatTranscriptIndexImpl` (delegating). **Additive only — no existing method changes.**
- [ ] **Step 3: Full suite + lint. Commit:** `feat(transcript-index): additive read-only list/count queries for GUI`

### Task 2.4: Home route + template

**Files:**
- Modify: `core/src/gui/routes/dashboard.ts` (rename internals to Home; route stays `/gui/`), `core/src/gui/index.ts` + `core/src/bootstrap.ts` (thread `config.backup`, optional BackupService, CostTracker, transcript index)
- Create: `core/src/gui/views/home.eta`; Delete: `core/src/gui/views/dashboard.eta` (after tests cut over)
- Test: rewrite `core/src/gui/__tests__/routes.test.ts` dashboard assertions → `home.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
describe('GET /gui/ (home)', () => {
	it('shows a backup warning banner to an admin when backups are disabled', async () => { /* config.backup.enabled=false → body contains "isn't being backed up" and the pas.yaml snippet hint link */ });
	it('shows "All systems normal" when nothing needs attention', async () => {});
	it('hides system-health banners from members but shows their own glance metrics', async () => {});
	it('renders glance cards: AI spend this month, messages this week, active alerts, next report', async () => { /* seed usage file + index + one enabled report with schedule; assert formatted values, e.g. next run via getNextRun/formatRelativeTime */ });
	it('escapes user-controlled names in the recent-activity list', async () => { /* change-log entry with <script> in path → escaped */ });
});
```

- [ ] **Step 2: Implement route assembly.** Attention banners (each independently try/caught — a failing probe renders no banner, never a 500): backup disabled/stale (stat newest archive in `config.backup.path` when enabled), provider disconnected (reuse the existing `ollamaStatus` probe already in `dashboard.ts`), spend vs household cap (CostTracker `getMonthlyHouseholdCost` vs cap from config — reuse llm-usage.ts's approach), failed apps (registry load errors — reuse apps route's source). Glance: month cost from usage log (member-scoped), messages this week via `countMessagesByDay`, active alerts via AlertService list (member-scoped), next report via ReportService list + `getNextRun`. Activity snippet: `collectChanges(join(dataDir,'system','change-log.jsonl'), sevenDaysAgo)` → last 5 entries, humanized ("pantry.md updated" → app + file basename, no full paths). **Re-home the removed ops content:** config table → `/gui/config` (exists), users table → `/gui/users`, uptime/cron → `/gui/scheduler` (add a small uptime line there).
- [ ] **Step 3: Template `home.eta`:** three zones; the charts zone renders registry slots only (Task 2.5): `<% for (const c of it.charts) { %><div data-pas-chart="<%= c.id %>" ...></div><% } %>` — the route passes `charts: chartsForPage('home')`. No per-chart markup or JS in the template. Chart assets load only when `it.charts.length > 0` (layout includes `chart.umd.min.js` + `pas-charts.js` conditionally).
- [ ] **Step 4: Cut over tests, delete `dashboard.eta`, full suite, lint. Commit:** `feat(gui): three-zone Home replaces ops dashboard`

### Task 2.5: Declarative chart registry (charts must be trivially Claude-editable)

**Operator requirement (2026-07-06):** the operator will iterate on which graphs exist and how they look, via Claude. Therefore adding/revising/removing a chart must touch exactly ONE registry entry — never template markup, never client JS.

**Files:**
- Create: `core/src/gui/charts/registry.ts`, `core/src/gui/public/pas-charts.js`, `docs/GUI_CHARTS.md`
- Modify: `core/src/gui/views/home.eta` (render slots from registry — see Task 2.4 step 3), `core/src/gui/views/layout.eta` (conditional asset include)
- Test: `core/src/gui/charts/__tests__/registry.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { CHARTS, chartsForPage, SUPPORTED_TYPES } from '../registry.js';

it('every descriptor is complete and points at a known endpoint + supported type', () => {
	const knownEndpoints = ['/gui/api/metrics/llm-daily', '/gui/api/metrics/activity-daily'];
	for (const c of CHARTS) {
		expect(c.id).toMatch(/^[a-z0-9-]+$/);
		expect(c.title.length).toBeGreaterThan(0);
		expect(knownEndpoints).toContain(c.endpoint);
		expect(SUPPORTED_TYPES).toContain(c.type);
		expect(c.series.length).toBeGreaterThan(0);
	}
});
it('ids are unique and chartsForPage filters by page', () => {});
```

- [ ] **Step 2: Implement the registry:**

```ts
// core/src/gui/charts/registry.ts
// ── HOW TO EDIT CHARTS ─────────────────────────────────────────────
// Add a chart:    add one ChartDescriptor to CHARTS. Done.
// Remove a chart: delete its entry. Done.
// Revise a chart: edit its fields. Done.
// New data need:  add a metrics endpoint in routes/metrics.ts first,
//                 then reference it here and in the registry test's
//                 knownEndpoints list. Full recipe: docs/GUI_CHARTS.md
// ───────────────────────────────────────────────────────────────────
export const SUPPORTED_TYPES = ['line', 'bar'] as const;

export interface ChartDescriptor {
	id: string;                    // kebab-case, unique
	page: 'home' | 'llm';          // which GUI page renders it
	title: string;                 // plain language, sentence case
	endpoint: string;              // /gui/api/metrics/* (permission-scoped server-side)
	type: (typeof SUPPORTED_TYPES)[number];
	series: Array<{ key: string; label: string }>; // fields of the endpoint's `days[]` rows to plot
	height?: number;               // px, default 240 (180 on phones — handled by pas-charts.js)
}

export const CHARTS: ChartDescriptor[] = [
	{ id: 'ai-spend-daily', page: 'home', title: 'AI spend, last 30 days', endpoint: '/gui/api/metrics/llm-daily', type: 'line', series: [{ key: 'cost', label: 'Spend ($)' }] },
	{ id: 'activity-daily', page: 'home', title: 'Messages and alerts by day', endpoint: '/gui/api/metrics/activity-daily', type: 'bar', series: [{ key: 'messages', label: 'Messages' }, { key: 'alertFirings', label: 'Alerts fired' }] },
	{ id: 'ai-tokens-daily', page: 'llm', title: 'Tokens by day', endpoint: '/gui/api/metrics/llm-daily', type: 'bar', series: [{ key: 'inputTokens', label: 'Input' }, { key: 'outputTokens', label: 'Output' }] },
];

export function chartsForPage(page: ChartDescriptor['page']): ChartDescriptor[] {
	return CHARTS.filter((c) => c.page === page);
}
```

- [ ] **Step 3: Implement `pas-charts.js`** (vanilla, no build step): on DOMContentLoaded, for each `[data-pas-chart]` slot read `data-endpoint`, `data-type`, `data-series` (JSON), `data-title`, `data-height`; fetch the endpoint; build the Chart.js config (labels = `days[].date`, one dataset per series key); `responsive: true, maintainAspectRatio: false`; container height from descriptor with the phone breakpoint. Fetch failure → render a quiet inline "Couldn't load this chart" note (never a broken canvas). Slots are emitted by templates from the registry (route passes `chartsForPage(page)`; template writes the data-attributes with `<%= %>` escaping).
- [ ] **Step 4: Write `docs/GUI_CHARTS.md`:** the three recipes (add/revise/remove), the descriptor field reference, how to add a new metrics endpoint (route + scoping rule + test + registry test's knownEndpoints), and the rule that per-chart markup/JS is forbidden. Keep it under a page — it's a recipe card, not an essay.
- [ ] **Step 5: Green (registry test + rendered-slot assertions in home tests), full suite, lint. Commit:** `feat(gui): declarative chart registry — charts editable in one place`

*(Task 6.4's AI-usage charts reuse this: add `page: 'llm'` descriptors — already seeded above — and render slots in `llm-usage.eta` via `chartsForPage('llm')`.)*

### Batch 2 gate
- [ ] Full suite + lint green; manual responsive check of Home at 375px + desktop; charts legible, banners stack.
- [ ] Chart-editability check: adding a dummy descriptor to the registry makes it render on Home with NO other file touched (then remove it).

---

## Batch 3 — Report wizard

### Task 3.1: Schedule presets utility

**Files:**
- Create: `core/src/gui/utils/schedule-presets.ts`
- Test: `core/src/gui/utils/__tests__/schedule-presets.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { PRESETS, presetToCron, cronToPresetId, nextRunPreview } from '../schedule-presets.js';

it('maps every preset to a valid cron accepted by getNextRun', () => {
	for (const p of PRESETS) {
		const cron = presetToCron(p.id, { hour: 7, minute: 0, weekday: 1 });
		expect(getNextRun(cron, 'America/New_York')).not.toBeNull();
	}
});
it('round-trips: cronToPresetId(presetToCron(x)) === x for parameterized presets', () => { /* daily/weekly/hourly with several hour/weekday params */ });
it('returns null presetId for a cron that matches no preset (custom)', () => {
	expect(cronToPresetId('*/7 3 * * 2')).toBeNull();
});
it('nextRunPreview renders a human sentence', () => {
	expect(nextRunPreview('0 7 * * *', 'America/New_York')).toMatch(/^Next run: /);
});
```

- [ ] **Step 2: Implement.**

```ts
import { describeCron, formatRelativeTime, getNextRun } from '../../utils/cron-describe.js';

export interface SchedulePreset { id: string; label: string; needsTime?: boolean; needsWeekday?: boolean }
export const PRESETS: SchedulePreset[] = [
	{ id: 'daily', label: 'Every day at…', needsTime: true },
	{ id: 'weekly', label: 'Weekly on…', needsTime: true, needsWeekday: true },
	{ id: 'hourly', label: 'Every hour' },
	{ id: 'weekdays', label: 'Weekday mornings', needsTime: true },
];
export function presetToCron(id: string, opts: { hour?: number; minute?: number; weekday?: number }): string { /* 'daily' → `${m} ${h} * * *`; 'weekly' → `${m} ${h} * * ${weekday}`; 'hourly' → '0 * * * *'; 'weekdays' → `${m} ${h} * * 1-5` */ }
export function cronToPresetId(cron: string): { id: string; hour?: number; minute?: number; weekday?: number } | null { /* regex the four shapes above; anything else → null (renders as Advanced/custom) */ }
export function nextRunPreview(cron: string, tz: string): string {
	const next = getNextRun(cron, tz);
	return next ? `Next run: ${formatRelativeTime(next)} (${describeCron(cron)})` : 'That schedule isn’t valid yet.';
}
```

(Write the real bodies — the comments above are the required behavior, and the tests pin them.)

- [ ] **Step 3: Pass, full suite, lint. Commit:** `feat(gui): schedule presets with real next-run preview`

### Task 3.2: `describeReport` review sentence

**Files:**
- Create: `core/src/gui/utils/describe-automation.ts`
- Test: `core/src/gui/utils/__tests__/describe-automation.test.ts`

- [ ] **Step 1: Failing test:** given a `ReportDefinition`-shaped object (import the real type from `core/src/services/reports`) with schedule `0 7 * * *`, two sections, llm summary enabled → sentence like `Every day at 7:00 AM, build a report with Recent changes and App data, add an AI summary, and send it to you on Telegram.` Assert stable phrasing with `describeCron` output embedded; assert names/sections are escaped by the TEMPLATE (the util returns plain text; templates render with `<%= %>`).
- [ ] **Step 2: Implement** `describeReport(def): string` and (stub for Batch 4) `describeAlert(def): string` — deterministic string assembly from the definition + `describeCron` + `humanizeLabel` for section/action types. No LLM involvement.
- [ ] **Step 3:** Render the sentence on the reports LIST page (route passes `description: describeReport(r)` per row). Update list tests. **Commit:** `feat(gui): human-readable report descriptions`

### Task 3.3: Report wizard route + steps

**Files:**
- Create: `core/src/gui/routes/report-wizard.ts`, `core/src/gui/views/report-wizard.eta`, `core/src/gui/views/partials/report-wizard-step-{1..4}.eta`
- Modify: `core/src/gui/index.ts` (register), `core/src/gui/views/reports.eta` ("Set up a report" button → `/gui/reports/new`)
- Test: `core/src/gui/__tests__/report-wizard.test.ts`

**Architecture (same engine reused by the alert wizard):** `GET /gui/reports/new` renders the shell + step 1. Each step is a `<form hx-post="/gui/reports/new/step" hx-target="#wizard-body">` carrying `step` + all prior fields as hidden inputs (server echoes them forward — values survive every validation error; this is the I8 fix pattern). The POST handler validates the current step server-side; on error re-renders the same step with an inline styled error + all values; on success renders the next step. The **final** step (Review) renders the human sentence + a plain `<form method="post" action="/gui/reports">` whose hidden fields are EXACTLY the existing contract (`name`, `schedule`, `section_type_0…`, `llm_*`, `delivery`, `enabled`) — the existing create handler is the only writer. Edit mode: `GET /gui/reports/:id/edit-wizard` prefills step 1 from the definition (`cronToPresetId` for the schedule; unmapped cron → Advanced field prefilled).

- [ ] **Step 1: Failing tests (write all):**

```ts
it('step flow: valid step-1 POST returns step 2 with step-1 values as hidden fields', async () => {});
it('invalid step POST re-renders the SAME step with values intact and a styled error', async () => {});
it('review step renders hidden fields matching the existing POST contract', async () => {
	// walk the wizard to review; parse hidden inputs; expect keys: name, schedule, delivery, enabled,
	// llm_enabled?, section_type_0, … and values matching what was entered
});
it('CONTRACT: submitting the review form creates a report identical to one created via the legacy form fields', async () => {
	// POST /gui/reports twice: once with wizard-produced fields, once with hand-built legacy fields
	// for the same logical report; fetch both via ReportService and expect deep-equal definitions (minus id/timestamps)
});
it('requires auth + CSRF on every wizard POST', async () => {});
it('edit-wizard prefills from an existing definition, including custom cron → Advanced', async () => {});
```

- [ ] **Step 2: Implement route + step templates.** Step 1 (what to include): checkbox cards for the four section types (labels via `humanizeLabel`, one-line plain descriptions); per-section config inputs appear inline when checked (no JS state — a `<details>` per card). Step 2 (when): preset radio cards + time/weekday selects; htmx `hx-get="/gui/reports/new/preview"` on change → returns `nextRunPreview` text; Advanced `<details>` with raw cron input. Step 3 (delivery + AI summary): delivery checkboxes; AI summary toggle with tier select (labels via `humanizeLabel`), prompt under Advanced. Step 4 (review): `describeReport` sentence + contract hidden fields + Save. All templates: single-column, ≥44px targets, `<%= %>` escaping everywhere.
- [ ] **Step 3: All tests pass; full suite; lint. Commit:** `feat(gui): guided report wizard submitting the existing contract`

### Batch 3 gate
- [ ] Contract test green (wizard ≡ legacy form). Responsive check of all four steps at 375px. Legacy `report-edit.eta` stays reachable from the list page's "Advanced edit" link (unchanged) — the wizard is the default path.

---

## Batch 4 — Alert wizard

### Task 4.1: Rule-builder mapping (deterministic grammar)

**Files:**
- Create: `core/src/gui/utils/rule-builder.ts`
- Test: `core/src/gui/utils/__tests__/rule-builder.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { RULE_PATTERNS, buildExpression, parseExpression } from '../rule-builder.js';

it('emits exactly the six expressions evaluateDeterministic recognizes', () => {
	expect(buildExpression({ pattern: 'is_empty' })).toBe('is empty');
	expect(buildExpression({ pattern: 'not_empty' })).toBe('is not empty');
	expect(buildExpression({ pattern: 'contains', text: 'milk' })).toBe('contains "milk"');
	expect(buildExpression({ pattern: 'not_contains', text: 'milk' })).toBe('not contains "milk"');
	expect(buildExpression({ pattern: 'more_lines', n: 10 })).toBe('line count > 10');
	expect(buildExpression({ pattern: 'fewer_lines', n: 3 })).toBe('line count < 3');
});
it('round-trips every pattern through parseExpression', () => {});
it('rejects unquotable text (embedded double quote) with a friendly error', () => {});
it('parseExpression returns null for anything else (renders as Advanced)', () => {
	expect(parseExpression('some legacy free text')).toBeNull();
});
```

- [ ] **Step 2: Implement** (six-entry pattern table with plain labels: "is empty", "has anything in it", "mentions…", "doesn't mention…", "has more than … lines", "has fewer than … lines"). `buildExpression` validates (`contains` text non-empty, no `"` character; N integer ≥ 0).
- [ ] **Step 3: Pass, full suite, lint. Commit:** `feat(gui): rule builder mapped 1:1 to the deterministic grammar`

### Task 4.2: `describeAlert` sentence

**Files:**
- Modify: `core/src/gui/utils/describe-automation.ts` (+ its test)

- [ ] **Step 1: Failing test:** scheduled deterministic alert → `Every day at 7:00 AM, check Pantry items; if it mentions "expired", send you a Telegram message. Won't repeat within 4 hours.`; event-triggered fuzzy alert → `When data changes, check …; if the AI judges "anything about to spoil", …`. Data-source label: app id + file basename via `humanizeLabel`, never a full path.
- [ ] **Step 2: Implement; render on alerts list page (like Task 3.2). Commit:** `feat(gui): human-readable alert descriptions`

### Task 4.3: Alert wizard route + steps

**Files:**
- Create: `core/src/gui/routes/alert-wizard.ts`, `core/src/gui/views/alert-wizard.eta`, `core/src/gui/views/partials/alert-wizard-step-{1..5}.eta`
- Modify: `core/src/gui/index.ts`, `core/src/gui/views/alerts.eta` ("Set up an alert" → `/gui/alerts/new`)
- Test: `core/src/gui/__tests__/alert-wizard.test.ts`

Same engine as Task 3.3. Steps: 1 What to watch (data-source picker from `FileIndexService.getEntries()` filtered to the user's own + shared + member-space scopes — friendly name = app + basename; multiple sources allowed; emits `ds_*_{i}` fields), 2 When (`trigger_type` cards: schedule presets reused from Task 3.1, or "when data changes" → `trigger_type=event` + `trigger_event_name=data:changed` matching what the existing form offers — verify the exact event name(s) the current alert-edit template offers and mirror them), 3 Condition (mode cards → `condition_type`; rule builder from 4.1 or free-text fuzzy; Advanced raw expression), 4 What happens (action picker cards emitting `action_type_{i}` + per-type config fields per the grounded contract; template-variable insert buttons append `{data}`/`{summary}`/`{alert_name}`/`{date}` into the focused textarea — plain JS, progressive enhancement, typing them manually always works; cooldown field "Don't repeat this alert for … hours" → `cooldown` in the contract's expected unit — **verify the unit** in `parseCooldown` before implementing), 5 Review (`describeAlert` + contract hidden fields).

- [ ] **Step 1: Failing tests:** same shape as 3.3 — step flow, value persistence on error, review hidden-field contract enumeration (including numbered `ds_*_0` and `action_*_0`), **the CONTRACT deep-equal test** (wizard-created alert ≡ legacy-form-created alert via AlertService), auth + CSRF, edit-wizard prefill (legacy expression that `parseExpression` can't map → Advanced textarea prefilled, mode preselected correctly), data-source scoping test (member sees only own/shared/space entries — assert a foreign user's file is NOT offered and a forged `ds_user_id_0` for another user is rejected server-side per existing route validation — check what the existing POST handler enforces and mirror it in the wizard's validate step; if the existing handler does NOT enforce it, enforce in the wizard AND note it for the Codex review as a possible pre-existing gap).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: All green, full suite, lint. Commit:** `feat(gui): guided alert wizard submitting the existing contract (retires I8)`

### Batch 4 gate
- [ ] Contract tests green for both wizards; legacy `alert-edit.eta` reachable via "Advanced edit"; responsive check all five steps.

---

## Batch 5 — Household & sharing hub

### Task 5.1: Invite flow (admin)

**Files:**
- Modify: `core/src/gui/routes/users.ts`, `core/src/gui/views/users.eta` (rename view file to `household.eta`), `core/src/gui/index.ts` (thread `inviteService`), `core/src/bootstrap.ts`
- Test: `core/src/gui/__tests__/household.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
it('admin can create an invite and sees copy-paste instructions with the code', async () => {
	// POST /gui/users/invite {name, role} → redirect/fragment containing the code and "Send this to them in Telegram"
});
it('invite POST requires platform admin + CSRF', async () => {});
it('member list shows display names, plain roles, and enabled apps as friendly labels', async () => {});
it('pending invites are listed with expiry, and can be revoked (if InviteService supports revoke — verify; if not, show expiry only)', async () => {});
```

- [ ] **Step 2: Implement.** `POST /gui/users/invite` → `inviteService.createInvite(name, adminUserId, { role })` → render an instruction card: the code, the exact Telegram message to send (`/start <code>` — **verify the actual redemption command** the router expects before hardcoding wording; check `redeem-and-register` / router `/start` handling), and a "Then set their password below (optional)" pointer to the existing reset-password flow. `listInvites()` renders pending codes. Member cards: name (id in `<small>`, per the 2026-05-18 identity-clarity convention), role via `humanizeLabel`, apps list.
- [ ] **Step 3: Green, full suite, lint. Commit:** `feat(gui): guided invite flow in the Household hub`

### Task 5.2: Member read-only Household view (deliberate guard change)

**Files:**
- Modify: `core/src/gui/routes/users.ts` (guard), `core/src/gui/views/layout.eta` (nav: Household visible to members now)
- Test: extend `core/src/gui/__tests__/household.test.ts` + **`core/src/gui/__tests__/admin-route-guards.test.ts`** (this test asserts `/users` is admin-only today — update it to assert the NEW contract deliberately)

- [ ] **Step 1: Failing tests:**

```ts
it('member GET /gui/users → 200 read-only: sees own household members, NO invite form, NO role controls, NO other households', async () => {});
it('member POST to any /gui/users mutation → 403', async () => {});
it('member sees only users in their own household (seed two households, assert isolation)', async () => {});
```

- [ ] **Step 2: Implement:** GET guard becomes authenticated-only; route branches on `isPlatformAdmin` — member path resolves their household via HouseholdService and passes only those members with no mutation affordances; ALL mutation POSTs keep `platformAdminOnly`. Flip the nav item for members (Task 1.5 left it admin-gated).
- [ ] **Step 3: Green (including the updated guard test — the diff there is the reviewable artifact of the access-control change), full suite, lint. Commit:** `feat(gui): read-only Household view for members (deliberate guard change, household-scoped)`

### Task 5.3: Spaces plain-language reframe

**Files:**
- Modify: `core/src/gui/views/{spaces,space-edit}.eta`, `core/src/gui/routes/spaces.ts` (pass humanized locals only)
- Test: update `core/src/gui/__tests__/` space-related render assertions

- [ ] **Step 1:** Reframe copy: page intro ("Things you share with others"), per-space card shows members + which apps' data it covers (both already in the space definition), create/join flows get one-line explanations. No service changes. Update render tests for new copy anchor strings.
- [ ] **Step 2: Green, full suite, lint. Commit:** `feat(gui): plain-language spaces pages`

### Batch 5 gate
- [ ] Guard-change tests green; two-household isolation test green; responsive check.

---

## Batch 6 — New surfaces

### Task 6.1: Conversations (`/gui/sessions`)

**Files:**
- Create: `core/src/gui/routes/sessions.ts`, `core/src/gui/views/sessions.eta`, `core/src/gui/views/session-detail.eta`
- Modify: `core/src/gui/index.ts` + `core/src/bootstrap.ts` (thread the transcript index)
- Test: `core/src/gui/__tests__/sessions.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
it('lists only the requesting member’s sessions (title, date, turn count)', async () => {});
it('admin also sees ONLY their own sessions (privacy: transcripts are personal — admins get no cross-user read)', async () => {});
it('search returns FTS matches scoped to the user', async () => {});
it('detail view renders messages read-only with all content HTML-escaped', async () => { /* seed message text with <script> */ });
it('detail view 404s for another user’s session id (no existence leak: same 404 as unknown id)', async () => {});
```

**Privacy decision locked here:** the spec says "non-admins see only their own"; for admins we choose own-only too (chat transcripts are personal; the D2 open item's "Non-admins see only their own sessions" sets a floor, not an admin entitlement). If the operator wants admin cross-user access later, that's a deliberate follow-up — record in open-items during Batch 7.

- [ ] **Step 2: Implement** with `listSessionsForUser` / `listMessagesForSession` (Task 2.3) and `searchSessions` (existing) with `userId: request.user.userId` always. Pagination via `limit/offset` (default 20). Search box is a GET form (`?q=`), terms sanitized the way `fts-query.ts` expects (reuse its sanitizer — export if file-local).
- [ ] **Step 3: Green, full suite, lint. Commit:** `feat(gui): read-only Conversations browser with search (implements D2)`

### Task 6.2: Backups (`/gui/backups`, admin)

**Files:**
- Create: `core/src/gui/routes/backups.ts`, `core/src/gui/views/backups.eta`
- Modify: `core/src/gui/index.ts`, `core/src/bootstrap.ts` (construct BackupService for the GUI even when the cron is disabled? NO — see step 2), `core/src/gui/__tests__/admin-route-guards.test.ts` (add `/gui/backups`)
- Test: `core/src/gui/__tests__/backups.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
it('admin-only (member → 403), listed in the admin guard test', async () => {});
it('disabled state: shows the exact pas.yaml snippet and no Back up now button', async () => {});
it('enabled state: lists archives (name, size, date) newest first and shows last-backup freshness', async () => {});
it('POST /gui/backups/run creates a backup via BackupService and reports the archive name; CSRF required', async () => { /* inject a fake _execFileAsync via the service's test seam */ });
it('backup failure renders a styled error, not a 500', async () => {});
```

- [ ] **Step 2: Implement.** Wiring: `bootstrap.ts` currently constructs BackupService only when `config.backup.enabled`. Keep that; pass to the GUI `{ backupConfig: config.backup, backupService: backupService | undefined }`. Disabled page renders the snippet (`backup:\n  enabled: true\n  path: …`, values from the typed config defaults — check `core/src/types/config.ts` for the real field names before writing the snippet) + restart note. Enabled page: `readdir` the backup path for `*.tar.gz` (name/mtime/size via `stat`), freshness = newest mtime vs schedule expectation; `POST /run` → `createBackup()` (it returns `''` on failure → styled error via `sendErrorFragment`). Home banner (Batch 2) already links here.
- [ ] **Step 3: Green, full suite, lint. Commit:** `feat(gui): backups status page with Back up now (BKP-1 surfacing)`

### Task 6.3: Activity (`/gui/activity`)

**Files:**
- Create: `core/src/gui/routes/activity.ts`, `core/src/gui/views/activity.eta`
- Modify: `core/src/gui/index.ts` (thread `changeLogPath` = `join(dataDir,'system','change-log.jsonl')` — **verify the exact path bootstrap uses for ChangeLog before hardcoding**)
- Test: `core/src/gui/__tests__/activity.test.ts`

- [ ] **Step 1: Failing tests:** member sees only entries where `entry.user` is them or their shared/space scopes (mirror how `collectChanges` groups `byApp[app][user]`; verify what `user` contains for shared-scope writes and scope accordingly — inspect `ChangeLogEntry` type first); admin sees all; entries humanized (app + basename + verb, no full paths); day-grouped; empty state is an invitation not an apology; escaping test for hostile path strings.
- [ ] **Step 2: Implement** using `collectChanges(logPath, since)` with `?days=7` (clamp 1–30). Render grouped by day, then app.
- [ ] **Step 3: Green, full suite, lint. Commit:** `feat(gui): activity feed from the change log`

### Task 6.4: AI usage page upgrade

**Files:**
- Modify: `core/src/gui/routes/llm-usage.ts` (member-scoped variant + chart data locals), `core/src/gui/views/llm-usage.eta`
- Test: extend `core/src/gui/__tests__/llm-usage.test.ts`

- [ ] **Step 1: Failing tests:** member GET `/gui/llm` → 200 with ONLY their own usage (today the page is admin-oriented — **check the current guard**; if admin-only, this is another deliberate guard change: member-scoped read-only variant, tier/model mutation POSTs stay admin-only — assert both); page renders registry chart slots for `chartsForPage('llm')` (no hand-written canvases); plain-language app line ("The food app used $1.20 this month").
- [ ] **Step 2: Implement:** member branch reuses the Task 2.2 scoping; admin keeps existing tables + gains the registry-driven charts (Task 2.5); per-app sentences from the existing breakdown data + `humanizeLabel`.
- [ ] **Step 3: Green, full suite, lint. Commit:** `feat(gui): AI usage charts + member-scoped view`

### Batch 6 gate
- [ ] Admin-guard test file reflects every new admin route; privacy tests green; responsive check of all four new pages.

---

## Batch 7 — Documentation footprint

### Task 7.1: URS entries + traceability

- [ ] Invoke `pas-urs-workflow`. Add requirement entries covering: nav regroup + label policy, error-fragment guarantee, loading indicators, login reasons, confirmations, aria (REQ-GUI-UX-001…), Home zones + attention banners + metrics endpoints + scoping (REQ-GUI-HOME-…), both wizards incl. contract preservation + preset round-trip + rule-builder grammar fidelity (REQ-GUI-WIZARD-…), Household hub incl. the two deliberate guard changes (REQ-GUI-HOUSEHOLD-…), Conversations privacy model, Backups, Activity scoping, AI-usage member view (REQ-GUI-SURFACE-…), the declarative chart registry + one-entry editability guarantee (REQ-GUI-CHARTS-…), responsive requirements (one umbrella entry). Map every entry to its test file in the traceability matrix.

### Task 7.2: implementation-phases.md + CLAUDE.md + open-items

- [ ] Full batch-by-batch write-up in `docs/implementation-phases.md` (dated section, newest first).
- [ ] ONE status bullet in CLAUDE.md per the anti-bloat rule; demote the oldest bullet if the list exceeds ~8.
- [ ] `docs/open-items.md`: mark this phase's Confirmed Phases entry complete/moved; UX Hardening Batch 2 line updated (shipped here); D2 entry closed (shipped); ADD new entries: “Admin cross-user Conversations access (deliberate own-only decision 2026-07-06 — revisit only on operator request)”; any gap found by the Task 4.3 data-source enforcement check.

### Task 7.3: Final verification

- [ ] `pnpm test` — full suite, zero failures. `pnpm lint` — zero errors. `pnpm build` — clean.
- [ ] Manual responsive pass: every redesigned/new page at ~375px and desktop (spec §6 acceptance).
- [ ] Commit: `docs(gui-ux): URS, traceability, phase history, open-items reconciliation`

---

## Self-review (performed while writing)

- **Spec coverage:** §1 nav → Task 1.5; §2 Home → 2.4 (+2.1–2.3); §3 wizards → 3.1–3.3, 4.1–4.3 (cooldown in 4.3 step 4; presets 3.1; grammar fidelity 4.1; review sentence 3.2/4.2; contract tests in 3.3/4.3); §4 Household/spaces/Conversations/Backups/Activity/AI usage → 5.1–5.3, 6.1–6.4; §5 cross-cutting → Batch 1 + per-template rules; §6 correctness → contract tests, guard-test updates, per-batch gates, 7.3; §7 batching → this structure. Responsive → per-batch gates + 7.3.
- **Placeholders:** Task 3.1 step 2 and 5.1/6.x contain "verify X before implementing" directives — these are deliberate grounding checks against drift (line numbers move), each with a stated fallback, not unresolved design. No TBDs.
- **Type consistency:** `humanizeLabel`, `sendErrorFragment`, `presetToCron/cronToPresetId/nextRunPreview`, `describeReport/describeAlert`, `buildExpression/parseExpression`, `listSessionsForUser/listMessagesForSession/countMessagesByDay` — names used consistently across tasks.
- **Known judgment calls surfaced for Codex review:** (a) admin own-only Conversations privacy decision (6.1); (b) member-visible Household guard change (5.2) and possible member AI-usage guard change (6.4); (c) exporting file-local helpers (`parseUsageMarkdown`, fts sanitizer, alert-history loader) instead of duplicating; (d) wizard hidden-field echo pattern vs server-side draft state (chose stateless echo).
