# UX Review Findings & Fix Plan (2026-06-11)

A UX-focused review of the three user-facing surfaces — Telegram routing/replies, chatbot conversation flow, and the management GUI — identifying issues that impact end-user experience, with per-issue fix recommendations. All file:line references were verified against the code as of commit `da2d8a9` (main, 2026-06-11).

**Status:** Findings recorded; fixes queued as the **UX Hardening Phase** in `docs/open-items.md` (Confirmed Phases). Each batch below is implemented in that phase with tests per `pas-testing-standards`, URS entries per `pas-urs-workflow`, and traceability-matrix updates.

---

## Critical — silent message loss

### C1. Multi-intent buffer flush failure drops replies silently
`core/src/services/router/index.ts:677-684`. When `buffer.flushPending()` throws, the error is logged ("partial reply may be lost") and the user receives nothing for one or more of their questions — no error, no retry hint.

**Fix:** in the catch, call `await this.trySend(enrichedCtx.userId, "Sorry — part of my reply didn't go through. Please ask again.")`. `trySend` is already error-safe so this cannot re-throw. Test: stub `inner.send` to reject on flush and assert the recovery send. If the transport itself is down the recovery send also fails — acceptable; the target is partial/transient failures (e.g., one oversized/malformed combined chunk).

### C2. Multi-intent preamble send failure swallowed
`core/src/services/router/index.ts:648` via `trySend` (~:1934). If the "Got it — I'll cover all of those:" preamble fails, the user gets no acknowledgment while segments process (segment replies may still arrive later, independently).

**Fix:** minimal — keep best-effort behavior but add a comment + test documenting that segment replies flush independently of preamble failure. Optionally have `trySend` return a success boolean here and log at warn level. Lower priority than C1.

---

## Important

### I1. Raw `appId` in user-facing denial messages, unescaped for Markdown
`core/src/services/router/index.ts:710` (also ~:820, :962, :1793): `` `You don't have access to the ${match.appId} app.` `` — technical id instead of `manifest.app.name`, and not passed through `escapeMarkdown()` (ids containing `_`/`*` can break Telegram Markdown parsing and fail the send).

**Fix:** add a private `appDisplayName(appId): string` helper on Router returning `escapeMarkdown(this.apps.get(appId)?.manifest.app.name ?? appId)`; use at all four sites. Reuses existing `escapeMarkdown` (already used at :956, :1260). Test: app with `_` in id and a distinct manifest name renders the friendly name, escaped.

### I2. No typing indicator during LLM operations
No `sendChatAction` exists anywhere in `core/src` (grep-verified). Classification → grey-zone verification → reply generation can run multiple seconds with zero feedback; the bot appears unresponsive.

**Fix:** add optional `sendChatAction?(userId, action: 'typing'): Promise<void>` to `TelegramService` (`core/src/types/telegram.ts:150-173`); implement in the Telegram adapter (`api.sendChatAction`); `BufferingTelegramProxy` and `ContextAwareTelegramService` pass it through (never buffered). Call fire-and-forget (`.catch(() => {})`) at the top of `routeOneTextRequest` and before conversation-fallback LLM calls. Telegram shows "typing…" ~5s per emission; the conversation handler can re-emit before its main completion call.

### I3. Vague per-segment failure apology
`core/src/services/router/index.ts:670` — static `"(I couldn't handle that part — sorry.)"` gives no clue which question failed.

**Fix:** `` await buffer.send(userId, `(I couldn't handle "${escapeMarkdown(truncate(segment, 60))}" — sorry.)`) `` so the user knows which question to re-ask.

### I4. Session-expiry login page gives no explanation
`core/src/gui/views/login.eta:20-22` handles only `reason=password-required`, but `core/src/gui/auth.ts` also redirects with `expired` (:422), `user-removed` (:429), `session-invalidated` (:437), `household-missing` (:450). A user logged out mid-edit sees a bare login page and may assume their submission failed or the system broke.

**Fix:** map reasons → friendly banner text in the login route handler (single `reasonMessage` var passed to the template; avoids four template branches):
- `expired` → "Your session expired — please log in again."
- `session-invalidated` → "Your password was changed — please log in again."
- `user-removed` → "This account is no longer active — contact your admin."
- `household-missing` → "Your account isn't assigned to a household — contact your admin."

Test: render the login route with each reason query param, assert the banner.

### I5. htmx error responses are unstyled plain text
`core/src/gui/routes/users.ts:68-69, 112-113, 145-146` return bare strings (`'Invalid user ID format'`) into htmx targets with no error styling — easy to miss, looks broken. Pattern likely exists elsewhere; sweep all GUI routes returning `.send('<string>')` with 4xx status.

**Fix:** shared `errorFragment(message: string): string` helper in `core/src/gui/` returning `<div class="alert-banner alert-banner-error">${escapeHtml(message)}</div>`; use in all htmx-target error paths. Test: 400 response body contains `alert-banner-error`.

### I6. No spinner/disabled state on long-running GUI actions
`core/src/gui/views/alert-edit.eta:263` ("Test Condition"); same for report Run and regression Run buttons. Users can't tell whether their click registered.

**Fix:** htmx built-ins — `hx-disabled-elt="this"` plus `hx-indicator` pointing at a small inline "Working…" span next to each long-running button. Pure template change.

### I7. Login rate-limit message gives no recovery guidance
`core/src/gui/auth.ts:242-246, 280-285` — "Too many login attempts" with no lockout duration or next step.

**Fix:** append the lockout window derived from limiter config (e.g., "Too many login attempts. Please wait about N minutes and try again."). Keep account-enumeration safety — same message shape for both limiter branches.

### I8. JS-synced hidden inputs can lose form state on validation re-render
`core/src/gui/views/alert-edit.eta:62, 76` — `schedule`/`delivery` hidden fields depend on client-side JS sync; a validation-failure re-render can blank them, forcing re-selection.

**Fix:** on validation failure, re-render from the *submitted body*. The route already rebuilds `alert` for re-render at `core/src/gui/routes/alerts.ts:174-183` — verify `schedule`/`delivery` are sourced from `request.body`, not the stored alert; patch if not. No template change needed if the route is fixed.

### I9. Proactive app messages consume the 20-turn history budget
`core/src/services/app-outbound-bridge/index.ts:100-111` — each bridged proactive message adds 2 turns (`source: 'app'`); the window is applied naively at `core/src/services/conversation-session/chat-session-store.ts:513` (`turns.slice(-maxTurns)`). Frequent proactive messages evict real user exchanges, making the bot forget recent conversation.

**Fix:** count only non-`app` turns toward `maxTurns` while retaining interleaved `app` turns inside the kept span; cap total at e.g. `maxTurns + 6` against runaway proactive volume. Tests: interleaved app turns keep all user exchanges; runaway app turns capped.

### I10. Session-search re-prompt failure can discard a valid first response
`core/src/services/conversation/handle-message.ts:367-372` — fallback `beforeTag.trim() || 'I was unable to search past conversations. Please try again.'` replaces the whole response; when the first LLM response was tag-only, all context is lost.

**Fix:** when search fails and `beforeTag` is empty, reply "I couldn't search past conversations just now — ask me again, or rephrase without needing history." and log the discarded tag; when `beforeTag` is non-empty, append "(I couldn't check past conversations.)" instead of replacing.

---

## Minor

### M1. Empty/whitespace LLM response causes failed empty send
`core/src/services/conversation/telegram-format.ts:24` early-returns `[text]` *before* the trim/filter, so `""` → attempted empty send → Telegram rejects → the retry at :95 is *unguarded* and throws up the stack.

**Fix:** at the top of `splitTelegramMessage`, `if (!text.trim()) return [];`. In `sendSplitResponse`, if `parts.length === 0`, send "I came back with an empty reply — please try again." Wrap the :95 retry in try/catch with a log.

### M2. Silent photo download failure
`core/src/services/telegram/message-adapter.ts:60-86` returns `null` on download failure with only a log; the user's photo vanishes.

**Fix:** the router photo dispatch detects `null` and sends "I couldn't download your photo — please try sending it again."

### M3. Raw enum values as GUI labels
`core/src/gui/views/app-detail.eta:85` (`read`/`write`) and `:129` (raw config option values in dropdowns).

**Fix:** label helpers (`read` → "Read-only", `write` → "Read & Write"); allow manifests to optionally declare option labels, falling back to title-cased values.

### M4. Missing confirmations on Reset actions
"Reset Password" (`core/src/gui/views/users.eta:75`) and settings "Reset" (`core/src/gui/routes/settings.ts:147-151`) act immediately.

**Fix:** `hx-confirm` attributes matching the existing pattern at `users.eta:73`.

### M5. `/ask` capabilities undiscoverable from `/help`
`core/src/services/router/command-catalog.ts:155` — catalog entry doesn't mention system status, costs, or model queries.

**Fix:** expand the description: "Ask PAS about apps, commands, costs, or system status (try /ask with no arguments for examples)". The doc-coverage gate (`getEffectiveCommandCatalog`) must stay green.

### M6. `household-cost-cap` message doesn't name the admin relationship
`core/src/utils/llm-errors.ts:32-33`.

**Fix:** "…or when your household admin raises the limit."

### M7. Missing aria-labels on scope radio groups
`core/src/gui/views/alert-edit.eta:162-182`.

**Fix:** `aria-label` per radio including the data-source index.

---

## Debunked / by design (no action)

- **Alert form action "XSS"** — `<%= it.alert.id %>` in `alert-edit.eta:26` is safe: Eta v3 defaults to `autoEscape: true` (`new Eta()` at `core/src/server/index.ts:57`), so `<%= %>` HTML-escapes.
- **`MAX_SEGMENTS` merge-overflow** (`core/src/services/router/message-segmenter.ts:300-304`) — merges overflow segments rather than dropping questions; correct by design (REQ-ROUTE family).

## Positive patterns (for the record)

- `classifyLLMError` (`core/src/utils/llm-errors.ts`) maps every LLM failure mode to actionable plain-English messages with retryability flags.
- Every app dispatch boundary in Router is error-isolated with friendly fallbacks; no stack traces reach users.
- GUI: CSRF auto-injection via `htmx:configRequest`, `hx-confirm` on user removal, alert-form re-render preserves input on validation failure, sliding-session cookie policy upgrades on every request.

---

## UX Hardening Phase — batching

Three batches, one surface each; each batch is a complete vertical slice (code + tests + URS + docs):

| Batch | Surface | Issues | Primary files |
|---|---|---|---|
| 1 | Telegram/Router | C1, C2, I1, I2, I3, M1, M2 | `core/src/services/router/index.ts`, `core/src/services/conversation/telegram-format.ts`, `core/src/services/telegram/message-adapter.ts`, `core/src/types/telegram.ts` |
| 2 | Management GUI | I4, I5, I6, I7, I8, M3, M4, M7 | `core/src/gui/views/*.eta`, `core/src/gui/routes/{users,alerts,settings}.ts`, `core/src/gui/auth.ts` |
| 3 | Conversation | I9, I10, M5, M6 | `core/src/services/app-outbound-bridge/index.ts`, `core/src/services/conversation-session/chat-session-store.ts`, `core/src/services/conversation/handle-message.ts`, `core/src/services/router/command-catalog.ts`, `core/src/utils/llm-errors.ts` |

Phase requirements: tests per `pas-testing-standards` (especially error-handling and edge categories), URS entries per `pas-urs-workflow`, traceability-matrix updates, and the standard spec/plan before coding (this document serves as the findings input to that plan).

---
---

# Second-Pass UX Review (2026-07-06)

A follow-up audit covering surfaces the 2026-06-11 review did not reach: onboarding and first contact, the food app's household model, notification hygiene, and command discoverability. All file:line references verified against `main` (`6b4c72f`) on 2026-07-06.

These findings are **additive** — none duplicate C1–C2 / I1–I10 / M1–M7 above, and none restate items already tracked in `docs/open-items.md` (cross-references are noted where a related entry exists). They are **not yet queued** in the UX Hardening Phase batches; see "Batching amendment" at the end of this section.

The lens for this pass: PAS's stated intent is that a household member's *entire* relationship with the system happens through one Telegram bot. The first review audited how the system behaves once a conversation is flowing; this pass audits the edges — the first five minutes, the second user, the quiet failure of a promise made during setup, and the daily ambient message load.

---

## Broken promises — the system tells the user something untrue

### B1. Onboarding digest opt-in is write-only — the promised daily digest never arrives
`core/src/services/onboarding/first-run-wizard.ts:107-117` asks every new user "Would you like a daily digest message each morning…?" and persists the answer to `data/system/onboarding.yaml` (`savePreference`, :86-103). **Nothing in the codebase reads `digestPreference` back** (grep-verified: the only references are inside the wizard itself). A user who taps "Yes, send me a daily digest" gets confirmation ("You're all set…") and then never receives a digest. The wizard's own header comment (:14) says "No report is created for unset preferences" — implying a report *is* created for `yes`, which is not implemented. This is the worst kind of UX bug: a commitment made during first contact, silently broken, with no error anywhere.

**Fix (choose one):**
1. *Implement the promise* — on `digest-yes`, create a per-user daily Report via `ReportService` (a `changes` + `app-data` section report scheduled each morning) and delete it on later opt-out. Test: redeem invite → tap Yes → assert a report exists for the user with a morning cron.
2. *Stop making the promise* — remove the digest question from the wizard until the feature exists, replacing it with something the system can honor (e.g., pointing at `/help`).

Option 1 is preferred: the ReportService machinery already exists; this is wiring, not new infrastructure. Related (not duplicate): `docs/open-items.md` → "Settings — Notifications section content" proposal, whose trigger ("user requests a notification preference toggle") this finding effectively satisfies.

### B2. Welcome message promises "set reminders" — no reminder capability exists
`core/src/services/onboarding/first-run-wizard.ts:145`: *"You can ask me to track groceries, set reminders, manage recipes, and more."* There is no user-facing reminder feature: no `/remind` command, no reminder intent, and Alerts are GUI-only. A new user's likely first message ("remind me to take out the trash at 7") lands in the chatbot fallback, which cannot schedule anything. First interaction → first failure.

**Fix:** short term, reword the welcome to capabilities that exist ("track groceries, plan meals, manage recipes, answer questions about your household"). Longer term, a lightweight `/remind` (or NL reminder intent backed by the one-off scheduler) is a natural, high-value addition — note that `docs/open-items.md` → "One-off task user scope" (OneOffTask has no `user_scope`) is a prerequisite for per-user reminders.

### B3. `location` defaults to "Raleigh, NC" for every install
`apps/food/manifest.yaml:352-358` — the seasonal-produce/regional-recipe location defaults to a specific city (evidently the original developer's). Any other household silently gets Raleigh-seasonal suggestions with no signal that a setting is wrong. A default that is *plausibly correct-looking but wrong* is worse than an empty one.

**Fix:** default to `""`; when unset, the seasonal-nudge and cultural-calendar handlers either skip location-dependent content or append a one-time "Tell me your city (Settings → Food → Location) for seasonal suggestions" hint. Test: unset location produces no Raleigh-specific produce.

---

## Onboarding & first contact

### O1. Telegram's Start button is a dead end for unregistered users
The universal first interaction with any Telegram bot is tapping **Start**, which sends `/start` with no arguments. For an unregistered user this skips the invite-redemption branch (`core/src/services/router/index.ts:502-513` requires non-empty `rawArgs`) and falls through to the authorization gate (:516-521): **"You are not authorized to use this bot."** The invited family member who taps Start before pasting their code hits a hard wall with no mention that invite codes exist or how to use one.

**Fix:** special-case unregistered `/start` (no args): "Welcome to PAS! This bot is invite-only. If someone gave you an invite code, send: `/start <code>`." Keep the generic unauthorized message for plain free text from strangers if enumeration-hostility is a concern — the `/start` reply reveals nothing beyond what the inviter already tells the invitee. Bonus: `/invite`'s output (:1639-1642) currently instructs the invitee to *type* `/start <code>`; also include a Telegram deep link (`https://t.me/<bot_username>?start=<code>`, bot username via `getMe`) so the invitee just taps a link and registration is automatic. Test: unregistered `/start` (no args) gets the invite-hint reply; deep-link `/start <code>` still redeems.

### O2. The second household member is told to *create* a household that already exists
The food app maintains its **own** household concept (`apps/food/src/services/household.ts` → `data/users/shared/food/household.yaml`, join codes, `/household join`) that is entirely separate from the platform `HouseholdService` (`data/households/`, populated at invite redemption — `core/src/services/invite/redeem-and-register.ts:75`). Consequences for a freshly invited user:

- They are already in the *platform* household, but any food command (`/grocery`, `/mealplan`, …) replies **"Set up a household first with /household create <name>"** (`apps/food/src/index.ts:356` + ~15 sibling sites) — steering the *second* member to create a competing household instead of joining the existing one. The message never mentions `/household join`.
- Full food onboarding requires a *second* out-of-band code exchange (the food join code) after the invite code — pure friction, and the system already knows which platform household they belong to.

**Fix (layered):**
1. *Message fix (small):* when a food household already exists, the guard message becomes "Ask <creator> for the join code, then send `/household join <code>`" — the household file knows its creator. When none exists, keep the create hint.
2. *Auto-join (better):* on invite redemption, if the redeemer's platform household maps to an existing food household, add them as a member automatically (the trust decision was already made by the admin issuing the invite). The `/household` command remains for edge cases.
3. *Unification (strategic, needs design):* food's household should derive membership from `HouseholdService` rather than keeping a parallel roster — the food app predates the platform household work (D5a–D5c) and was never reconciled. Two membership rosters *will* drift (member removed from platform but still in food household = data access via shared scope). This also has a security-hygiene angle, not just UX.

Test (for 2): redeem invite in a household with an existing food household → `/grocery` works immediately.

### O3. No self-service GUI password bootstrap — admin must set and share passwords out-of-band
GUI login requires a password (`core/src/gui/auth.ts`), but a new user cannot set one: `POST /account/password` (`core/src/gui/routes/credentials.ts:51`) requires being logged in, and the only other path is the admin reset form (:115-205). So GUI onboarding is: admin sets a password for the user, then transmits it over some other channel. For a system whose identity backbone *is* Telegram, the natural bridge is missing.

**Fix:** a Telegram-delivered one-time login code — e.g., `/gui` (or a "Get GUI access" line in `/help`) makes the bot reply with the GUI URL plus a short-lived single-use code; the login page accepts it and immediately forces password creation via the existing `/account` flow (which already handles the no-current-password case, `credentials.ts:88-95`). This reuses InviteService's code-generation patterns and CredentialService's `hasCredentials`. Test: code is single-use, expires, and the session it mints requires setting a password before other pages.

---

## Discoverability

### D1. The bot never publishes its command menu to Telegram (`setMyCommands`)
Grep-verified: no `setMyCommands` call anywhere in `core/` or `apps/`. Users get no native "/" autocomplete, no command menu button, no inline hints — discovery is entirely via `/help` text. This is a disproportionate gap given the investment already made: `getEffectiveCommandCatalog` (`core/src/services/router/command-catalog.ts:170`) exists precisely to enumerate per-user effective commands with descriptions, and W1 built a doc-coverage gate guaranteeing every command has one.

**Fix:** at startup (and on app install/uninstall/toggle), call `setMyCommands` with the catalog. Telegram supports per-chat command scopes (`BotCommandScopeChat`), so admin-only commands (`/invite`) can appear only for admins, mirroring the catalog's `adminOnly` filtering. Telegram caps descriptions at 256 chars and command count at 100 — the catalog is well within both. Test: catalog → `setMyCommands` payload mapping (names lowercase, no leading slash in API payload, admin scoping).

### D2. Conversation sessions have titles, lineage, and full-text search — but no GUI surface
The session stack is rich (auto-titles, parent lineage, FTS5 search, per-session markdown transcripts), yet the GUI (`core/src/gui/views/`) has no Conversations/Sessions page — users can only reach history through Telegram (`/recall`, `/title`) or by opening the Obsidian vault. An operator debugging "why did the bot say that yesterday" or a user wanting to reread a recipe discussion has no browsable surface.

**Fix (modest):** a read-only `/gui/sessions` page: list sessions (title, date, turn count) for the logged-in user with a transcript view, reusing the existing SQLite index + FTS5 for search. Non-admins see only their own sessions (same scoping rule as the rest of the GUI). Defer edit/delete — read-only is most of the value.

---

## Notification hygiene

### N1. Up to four proactive messages a day with no opt-out, no quiet hours, no vacation mode
The food app ships 12 scheduled jobs (`apps/food/manifest.yaml:88-148`); on a typical day a household member can receive perishable-check (9am), leftover-check (10am), defrost-check (7pm), and the nightly rating prompt (8pm) — Sundays add weekly-plan generation, nutrition summary, and cuisine-diversity on top. Only **two** of the twelve have user toggles (`seasonal_nudges` :359, `cultural_calendar` :455). There is no per-job opt-out for the daily nudges, no quiet-hours window, and no "pause everything, we're on vacation" switch — the only escape hatch is disabling the entire food app. For an ambient household assistant, notification fatigue is the #1 long-term churn risk: the moment users mute the bot in Telegram, every surface of the system goes dark.

**Fix (layered):**
1. Per-job boolean toggles for the remaining proactive jobs (perishable/leftover/defrost/rating/freezer/cuisine-diversity), following the existing `seasonal_nudges` pattern — pure manifest + handler-guard work, and it gives the Settings page's placeholder "Notifications" section (`docs/open-items.md` → Proposals) its content.
2. A core-level per-user quiet-hours window (e.g., `notifications.quiet_hours: "22:00-08:00"`) enforced in `sendProactiveMessage`/`AppOutboundBridge` — proactive messages inside the window are dropped or deferred until the window opens; user-initiated replies are never affected.
3. A `/pause <days>` command (or `pause_until` setting) suppressing all proactive output — the vacation case.

Layer 1 is a natural UX-Hardening-sized batch; 2–3 need a small design note (defer vs drop, per-user vs per-household). Test: job fires inside quiet hours → nothing sent (or queued-then-sent, per design).

### N2. Meal-plan voting closes silently — non-voters are never nudged
`apps/food/src/handlers/voting.ts:205-221`: an hourly cron finalizes the plan when the voting window (default 12h, `manifest.yaml:299-305`) expires. Members who haven't voted get no "voting closes soon" reminder — their first signal is the finalized plan they had no say in. For the household-collaboration flow that voting exists to serve, a single reminder at ~75% of the window (only to members who haven't voted, only if at least one other member has) would materially raise participation without meaningful noise.

**Fix:** in the hourly finalize check, when `elapsed >= 0.75 * window` and unvoted members exist, send each a one-time "Voting on this week's meal plan closes in ~N hours" (tracked via a `reminderSent` flag on the plan). Test: reminder fires once, only to non-voters, never after finalization.

---

## Conversational state resilience

### S1. Multi-step flows expire silently mid-conversation
The guided flows (targets `targets-flow.ts:39`, quick-meal `quick-meal-flow.ts:54`, guest-add, first-run wizard) hold in-process pending state with a 10-minute TTL. When the TTL lapses (user got distracted, or the process restarted), the user's next reply — "450" for their calorie target — falls through to normal routing and lands in the chatbot as free text, which will earnestly try to interpret a bare number with no context. The flow doesn't fail; it *evaporates*, and the system responds as if the conversation never happened.

**Fix (cheap):** the flows already refresh their TTL on each interaction (`touch()`), so mid-flow expiry mostly means restart or long abandonment. Two mitigations: (a) when a pending flow is found *expired* at lookup time (the `Date.now() > expiresAt` branch that currently just deletes), reply once with "That <flow name> setup timed out — send /nutrition targets to start again" instead of silently deleting; (b) accepted-tradeoff restart amnesia stays (documented in `first-run-wizard.ts:10-16`), but (a) covers the user-visible half of it whenever the reply arrives after expiry. Test: reply after TTL → timeout notice, not a chatbot response to "450".

---

## Debunked / verified-fine in this pass (for the record)

- **Stale perishable-alert buttons** — `perishable-handler.ts` guards index-based callbacks with a name-mismatch check before acting; stale taps are handled. No action.
- **Grocery clear → pantry hand-off** — the clear flow's "Add to pantry?" follow-up with 5-min TTL and single-slot shopping follow-up are code-documented accepted tradeoffs appropriate for a single household. No action.
- **`/settings` reply size** — goes through `sendSplitResponse`, so long category listings split correctly. No action.
- **Multi-step flow cancel affordances** — targets/quick-meal/guest flows all offer Cancel buttons and accept "cancel" as text at every step. Good pattern; no action.

---

## Roadmap review — recommendations on the queued phases

Reviewing `docs/open-items.md`'s phase sequence and the completed work with a UX lens:

1. **Sequence the UX Hardening Phase (plus the findings above) ahead of the chatbot-primary T-track.** The T-track (T1a→T6b) is ~15 sessions before users feel anything; the hardening items are 1-session batches with immediate daily-use payoff. None of the above conflicts with the T-track: the onboarding, notification, and discoverability findings live in surfaces (invite flow, cron handlers, Telegram menu, GUI) the T-track explicitly keeps. Verified non-overlap: none of C1–C2/I1–I10/M1–M7 or B/O/D/N/S touch the components T6b deletes (IntentClassifier, RouteVerifier, grey-zone).
2. **D1 (`setMyCommands`) belongs in UX Hardening Batch 1** (Telegram/Router surface) — it is the natural completion of W1's command-catalog investment, and Batch 1 already touches `TelegramService` for I2's `sendChatAction`.
3. **Add a Batch 4 — "Onboarding & first contact" (B1, B2, O1, O2 fix-levels 1–2, O3)** and a **Batch 5 — "Notification hygiene" (N1 layer 1, N2, B3, S1)** to the UX Hardening Phase. O2 layer 3 (household unification) and N1 layers 2–3 (quiet hours/vacation) need short design notes first — queue them as their own follow-on items in `open-items.md` rather than inflating the hardening phase.
4. **B1 resolves an existing proposal's trigger:** the "Settings — Notifications section content" proposal has been waiting for "a user requests a notification preference toggle"; the broken digest promise plus N1 is that demand. Fold the Notifications-section content into Batch 5.
5. **O2 layer 3 (food household ← platform household) should be scheduled before T5.food.*** — the T5 migration will re-encode food's household assumptions into tool definitions; unifying the household model first avoids migrating a known-drifting design.
6. **The Hermes P7 UX-polish carry-forward** (streaming, typing indicator, UTF-16 truncation, clarify tool) still lists the typing indicator, which is I2 in this document (already noted in open-items as "implement once, here"). When Batch 1 lands, prune item 2 from the P7 bucket so it doesn't get double-implemented.
7. **Completed-work observation:** the 2026-05-22/24 routing phases (multi-intent split, reply collector, proactive bridge) are strong *conversation-flow* work, and this pass found nothing new to flag there — the remaining UX debt is concentrated at the *edges* (first contact, second user, ambient noise), which no queued phase currently owns. Batches 4–5 close that gap.

## Batching amendment (proposed)

| Batch | Surface | Issues | Primary files |
|---|---|---|---|
| 1 (amended) | Telegram/Router | C1, C2, I1, I2, I3, M1, M2, **D1** | + `core/src/services/telegram/bot.ts`, `core/src/services/router/command-catalog.ts` |
| 4 (new) | Onboarding & first contact | B1, B2, O1, O2 (1–2), O3 | `core/src/services/onboarding/first-run-wizard.ts`, `core/src/services/router/index.ts`, `core/src/services/invite/redeem-and-register.ts`, `apps/food/src/index.ts`, `apps/food/src/services/household.ts`, `core/src/gui/routes/credentials.ts` |
| 5 (new) | Notification hygiene & polish | N1 (layer 1), N2, B3, S1 | `apps/food/manifest.yaml`, `apps/food/src/handlers/{perishable-handler,leftover-handler,freezer-handler,defrost-check,rating,voting}.ts`, `apps/food/src/handlers/{targets-flow,quick-meal-flow}.ts` |
| — (design-first follow-ons) | | O2 (3), N1 (2–3), D2 | tracked individually in `docs/open-items.md` |

Batches 2 and 3 are unchanged. Same phase requirements as the first pass: tests per `pas-testing-standards`, URS entries per `pas-urs-workflow`, traceability-matrix updates, spec/plan before coding.

---
---

# Third-Pass Review (2026-07-06): App-Developer Documentation & Response Latency

Two targeted reviews driven by the project's open-source ambition (PAS as a base infrastructure layer others build apps on, in the spirit of OpenClaw / hermes-agent) and by observed response slowness. All file:line references verified against `main` on 2026-07-06. No code was changed; this section is findings + recommendations only.

---

## Part A — App-developer documentation audit (open-source readiness)

**Scope reviewed:** `docs/CREATING_AN_APP.md` (1,244 lines), `docs/MANIFEST_REFERENCE.md` (394 lines), `README.md` "Creating Apps", the scaffold CLI (`core/src/cli/scaffold-app.ts`), the installer (`core/src/cli/install-app.ts` + `core/src/services/app-installer/`), the app loader (`core/src/services/app-registry/loader.ts`), the manifest schema (`core/src/schemas/app-manifest.schema.json`), and the testing exports (`core/src/testing/`).

**Verdict:** The guides are unusually good — comprehensive, example-driven, and largely verified accurate against the code (see "Verified accurate" below). A developer working **inside a clone of this repo** can genuinely scaffold, build, test, and ship an app from these docs alone. But the **standalone/third-party path — the one that matters for open source — is currently aspirational**: its first step is impossible as written, the install loop has never been exercised end-to-end by an outsider, and the repo is missing open-source table stakes. Grouped as *blockers* (must fix before inviting contributors), *important* (will burn the first real contributor), and *minor*.

### Blockers

#### DOC-1. `@pas/core` is unpublished — the standalone-repo path's first step is impossible
`docs/CREATING_AN_APP.md:25` instructs standalone developers to "Add `@pas/core` as a dev dependency" — but `core/package.json:4` is `"private": true` and the package has never been published to npm (or any registry). There is also no documented `git:`/`file:` workaround, and none would work cleanly anyway (`@pas/core` is a subdirectory of the monorepo; git dependencies can't target subdirectory packages without extra tooling). **Every subsequent standalone instruction (types, `@pas/core/testing` mocks, tsconfig) silently depends on this impossible step.**

**Fix (decide one, then rewrite the "Standalone app repo" section around it):**
1. *Publish `@pas/core` to npm* (or GitHub Packages) with semver discipline — the real fix if third-party apps are the goal. Requires an API-surface commitment: the `exports` map in `core/package.json` becomes a public contract.
2. *Interim:* declare fork-and-clone the only supported dev path ("develop your app inside `apps/` of a PAS checkout; publish the app subdirectory as its own repo when ready") and delete the standalone-bootstrap instructions until 1 lands. Honest and zero-effort.

#### DOC-2. No LICENSE, no CONTRIBUTING.md
The repo root has neither. Without a LICENSE, the project legally cannot be used, modified, or contributed to regardless of intent — this blocks open-sourcing entirely. (Ironic detail: the manifest schema *does* have a `license` field for apps, `MANIFEST_REFERENCE.md:19`, and the docs recommend SPDX identifiers to app authors.) CONTRIBUTING.md matters here more than in most projects because the contribution bar is unusual — URS entries, traceability matrix, zero-failing-tests, Biome zero-errors — and none of that is discoverable by an outsider (it lives in CLAUDE.md and plugin skills, which are assistant-facing).

**Fix:** pick a license (the Credits table in `docs/open-items.md` shows all upstream influences are Apache-2.0/MIT — no copyleft constraint); write a CONTRIBUTING.md that distills the workflow (build/test/lint commands, URS expectations for app PRs vs core PRs, the zero-failing-tests policy) for humans. Also add a `SECURITY.md` note on the in-process trust model (apps run unsandboxed — `CREATING_AN_APP.md:1230` documents this well, but a vulnerability-reporting contact belongs at the repo root).

#### DOC-3. The install loop is untested end-to-end and its docs/CLI misstate what it does
Three compounding gaps in `pnpm install-app <git-url>`:
- The CLI prints "The app will be cloned, validated, and its dependencies installed" (`core/src/cli/install-app.ts:150`) — **it never installs dependencies.** The installer clones to a temp dir, validates, and copies into `apps/` (`core/src/services/app-installer/index.ts:343`; the plan function's own doc comment at `:404` says "without … running pnpm install").
- The success message says only "Restart PAS to load the new app" (`install-app.ts:191`). The actual contract: the copied app is now a pnpm workspace member, so the operator must run `pnpm install` (link `@pas/core` + deps) and `pnpm build` (produce `dist/`) before restart. Neither the CLI nor `CREATING_AN_APP.md`'s "Sharing Your App" section (:1205-1219) mentions either step.
- The loader tries `dist/index.js` first and falls back to `src/index.ts` (`core/src/services/app-registry/loader.ts:78-82`). The `.ts` fallback only works under the dev runner (`pnpm dev` = tsx); a production instance running compiled JS cannot import an app that ships only TypeScript. So a shared app repo that doesn't commit `dist/` *appears* to work in dev and breaks in production — the worst kind of contributor experience. The docs' "Required files" list (:1209) doesn't mention `dist/` or the build step at all.

**Fix:** document the real contract in "Sharing Your App" (post-install: `pnpm install && pnpm build`, restart; app repos should `.gitignore` `dist/` and rely on the operator build — or commit `dist/`, but pick one and say so); fix the CLI's two misleading lines; and add the missing end-to-end smoke test — scaffold an app into a temp git repo, `install-app` it into a scratch checkout, build, boot, and assert the app routes a message. That test is the only thing that will keep this path honest as the platform evolves.

#### DOC-4. The canonical manifest example declares `/notes` — a reserved built-in that fails install
`MANIFEST_REFERENCE.md`'s "Complete Example" (:367) and `CREATING_AN_APP.md`'s help.md example (:88) both use `/notes` as an app command. `/notes` is in `BUILTIN_COMMAND_NAMES` (`core/src/services/router/command-catalog.ts:22`) — the *same reference doc* says 30 lines earlier that "An app **cannot** declare a command name that collides with a built-in" (:315), and this exact collision is why the real Notes app was renamed to `/listnotes` in the W1 phase (`apps/notes/manifest.yaml:23`). A contributor copying the canonical example ships a shadowed command. Stale since W1 (2026-05-18).

**Fix:** update both examples to `/listnotes` (matching the real app); add the built-in list cross-reference next to the Complete Example. Consider a doc-accuracy test that runs `detectCommandShadowing` over fenced YAML blocks in the two docs — the machinery already exists.

### Important

#### DOC-5. Core schema hard-codes app-specific settings categories — third-party apps can't extend it
`user_config.category` is an enum of `["personal", "food", "notes", "memory-sessions", "notifications", "system", "dangerous"]` (`app-manifest.schema.json:483-491`, documented at `MANIFEST_REFERENCE.md:273`). Two in-tree app names (`food`, `notes`) are baked into core infrastructure, and a third-party weather app has no legitimate category — it must masquerade under an existing one or fail validation. This is exactly the kind of core/app coupling the platform otherwise avoids carefully.

**Fix:** loosen to a pattern-validated free string (`^[a-z][a-z0-9-]*$`) with the GUI settings page grouping unknown categories under the app's display name; or auto-namespace app categories (`<appId>` as implicit category). Needs a small design decision; flagged now because it's a schema change that gets more expensive after third-party manifests exist.

#### DOC-6. No canonical out-of-tree example app
All three example apps live in-tree and predate the installer. Nobody — including the maintainer — has ever developed a PAS app the way the docs tell outsiders to. An out-of-tree `pas-example-app` repo (echo-level scope: one command, one intent, one data write, one test) would serve triple duty: the copyable template the docs point at, the fixture for DOC-3's install smoke test, and the proof that the standalone path works at all. Until it exists, every claim in the "Standalone app repo" and "Sharing Your App" sections is untested.

#### DOC-7. No drift guard on the developer docs
The docs are hand-maintained and have already drifted where reality moved (DOC-3, DOC-4). The project has a proven pattern for exactly this — the W1 command-catalog doc-coverage gate fails the build when a command lacks documentation. Cheap equivalents here: assert `MANIFEST_REFERENCE.md`'s service-ID table matches the schema's service enum; assert the fenced minimal manifest in `CREATING_AN_APP.md` validates against the JSON Schema; assert scaffold output passes `pnpm build && pnpm test` (the scaffold templates are themselves docs that can rot).

### Minor

- **DOC-8.** `CREATING_AN_APP.md:346-366` teaches apps to hand-roll a `splitMessage` helper and points at the production `splitTelegramMessage` "for reference" — but that function isn't in `core/package.json`'s `exports` map, so apps *can't* import it. Export it (e.g. `@pas/core/utils/telegram-format`) and replace the 20-line snippet with an import. Every app duplicating message-splitting logic will duplicate its edge-case bugs (cf. first-pass finding M1).
- **DOC-9.** The events examples disagree on what `subscribes[].handler` is: `CREATING_AN_APP.md:1171` uses a function name (`handleDataReady`), `MANIFEST_REFERENCE.md:144` and the food manifest use a file path (`dist/handlers/on-event.js`). Both docs correctly note the field is non-functional metadata, but a metadata field with two contradictory shapes in the docs will produce inconsistent third-party manifests. Pick the file-path convention (matches `schedules[].handler`) and align the examples.
- **DOC-10.** `README.md` has no "so you want to contribute an app" pointer above the fold — the Creating Apps section is buried below Quick Start/secrets/users. For an infrastructure-first open-source pitch, the README's job is to route two audiences (operators vs app developers) in the first screenful.

### Verified accurate (for the record)

Spot-checked against code and found correct — worth stating so future doc reviews don't re-litigate them: the `AppModule` interface and all handler signatures incl. `HandlerResult` fallback semantics (`core/src/types/app-module.ts:58-110`); `MessageContext`/`PhotoContext`/`CallbackContext` shapes; the `PhotoSummary` transcript contract; the AppOutboundBridge contract, ordering rule, and guard description (matches the 2026-05-24 Strategy-B scanner); scheduler `scheduleOnce`/`cancelOnce` signatures and the `user_scope: all` per-user dispatch semantics; `classify`/`extractStructured`/`getModelForTier` signatures; the always-provided services list; secrets/`external_apis` behavior; banned-imports list; the testing helpers (`createMockCoreServices`, `createMockScopedStore`, `createTestMessageContext`, `createTestPhotoContext` all exist at the documented import paths); scaffold output (help.md + docs/requirements.md + docs/urs.md as documented); and the honest "regression suite has no per-app extension API yet" caveat with its open-items cross-reference.

---

## Part B — Response latency review (quality-first, local-first)

**Context:** operator reports responses are "a bit slow sometimes"; quality explicitly outranks speed; local-first is a constraint, not a preference. Current live tier assignment (`data/system/model-selection.yaml`): **fast = `ollama/gemma4:31b` (local), standard/reasoning = `claude-sonnet-4-6` (API)**. The 31B fast-tier choice is deliberate — it's what clears the REQ-REG-011 routing-accuracy gate (0.9811; the 26B plateaued at 0.9057) — so "use a smaller model" is not on the table without regression evidence. The findings below are ordered by (impact × quality-safety): L1–L2 are free wins with zero quality impact; L3–L5 are measurable-first; L6–L7 are perception and strategy.

### The anatomy of a slow reply

A single free-text message can traverse, **sequentially**: (1) session-control classifier — fast tier, though a keyword prefilter skips the LLM for most messages (`session-control-classifier.ts:143`); (2) multi-intent segmenter — fast tier, also prefilter-gated (`message-segmenter.ts:234`); (3) intent classification — `llm.classify` is hard-pinned to the fast tier (`core/src/services/llm/index.ts:14`), i.e. a local 31B call on **every** free-text message; (4) route verification for grey-zone/always-verify intents — **`tier: 'standard'`, a cloud API round-trip inside the routing hot path** (`route-verifier.ts:230`); then on the chatbot-fallback path (5) the recall classifier (fast tier, `handle-message.ts:187`) followed by (6) the PAS classifier (fast tier, `handle-message.ts:202`) — two *independent* local-LLM calls run back-to-back — then (7) the main standard-tier completion over a large assembled prompt. Worst case: three to four sequential local 31B inferences plus one or two cloud calls before the user sees anything. The deterministic prefilters (session-control keywords, multi-intent gate, `PLATFORM_INVITE_RE`) are already doing good latency work — the remaining cost is structural.

### L1. No `keep_alive` on the Ollama provider — idle-then-slow is almost certainly cold model reloads
Grep-verified: `keep_alive` appears nowhere in `core/src/services/llm/providers/ollama-provider.ts` (or any provider). Ollama's default keeps a model loaded for **5 minutes**; after any ≥5-minute quiet period — which describes most household-bot usage — the next message pays a full ~18GB 31B model load before inference even starts (tens of seconds on a Mac Mini). This matches the "sometimes slow" symptom precisely: first message after a lull is painful, follow-ups are fine. **Zero quality trade-off.**

**Recommendation:** pass `keep_alive: -1` (or a long duration, e.g. `'24h'`) in the Ollama request options, ideally as a `pas.yaml` knob. Verify the diagnosis first with `ollama ps` after 6 idle minutes, or by timing message-1 vs message-2. With 32GB and only one local model in the tier map, permanent residency is affordable; revisit if a second local model ever shares the box.

### L2. Recall classifier and PAS classifier run sequentially but are independent
`handle-message.ts:187-206`: `runRecallPipeline(ctx.text, …)` completes before `classifyPASMessage(ctx.text, …)` starts. Neither consumes the other's output (recall feeds the prompt's recalled-sessions layer; PAS classification gates snapshot/data-query construction). Running them in `Promise.all` removes one full local-inference from the critical path of every auto-detect fallback message. **Zero quality trade-off** — same calls, same inputs, same outputs. (Note the file already uses this pattern for its five I/O preloads at :131-184, so this is stylistically at home.) One caveat for the implementing session: confirm the local serving layer actually executes two requests concurrently (Ollama with default `OLLAMA_NUM_PARALLEL` may queue them — in which case the win comes from pairing this with L4's llama.cpp `--parallel` slots).

### L3. "Fast tier" is one global knob, but its consumers have different accuracy needs
`classify()`/`extractStructured()` always use the fast tier, and the fast tier must be a 31B because *one* consumer — food-shadow routing — needs 0.95+ accuracy. Every other fast-tier consumer (segmenter, session-control, recall classifier, PAS classifier, title generator, idle-flush summarizer) inherits 31B latency whether or not a smaller model would pass *their* regression buckets. The regression suite already has per-bucket evidence machinery (recall bucket, session-control cases, `--model-matrix`) — what's missing is a way to *act* on per-use-case evidence, e.g. a `llm.purpose_models` override map (`recall_classifier: ollama/gemma4:12b`) consulted before the tier default.

**Recommendation:** measure first — run the recall + session-control + chatbot buckets under 12B/9B candidates. If a smaller model passes a bucket at parity, the per-purpose override is a small, quality-gated design (each override must cite a green regression run). If nothing passes, this finding dies and the 31B stays everywhere — quality wins by rule. This also dovetails with the existing **cascading-models proposal** (tier-0 + escalation, `docs/open-items.md` Proposals), which is the same idea generalized.

### L4. Local prompt-prefix caching is being left on the table
The classifier prompts are dominated by long static prefixes (few-shot examples, fenced instructions) with a short variable tail — the ideal shape for prefix caching. Ollama's request-level reuse is opportunistic; **llama.cpp server** offers explicit slot-based prefix caching plus `--parallel` decode slots, and PAS already has a llama.cpp provider (`core/src/services/llm/providers/llama-cpp-provider.ts`, `docs/INSTALL_LLAMA_CPP.md`, `scripts/smoke-llama-cpp-provider.ts`) — the integration work is done. Serving gemma4:31b via llama.cpp server with persistent slots would cut per-classifier prefill substantially and make L2's parallelization real. **Zero quality trade-off** (same weights, same outputs); the cost is operational setup, which the install doc already covers.

### L5. Route verification is a cloud round-trip inside the routing hot path
`route-verifier.ts:230` uses `tier: 'standard'` — every grey-zone or always-verify classification blocks on an Anthropic API call before dispatch. Verification exists to *double-check the fast tier with a stronger opinion*, so this is a deliberate quality choice — but it's worth measuring: (a) how often verification actually fires in practice (the verification logger already records this), and (b) whether the 31B verifying its own grey zone with a different prompt shape passes the routing bucket. If (b) holds, the hot path goes fully local. If not, keep Sonnet and accept the latency — but then L6 (feedback during the wait) matters more. Note the strategic horizon too: T6b deletes the verifier entirely.

### L6. Perceived latency is the cheapest lever and is already specced
With a quality-first model policy, the real floor is seconds — so *feedback during the wait* carries disproportionate weight. Both halves are already in the backlog: the typing indicator is **I2** (UX Hardening Batch 1) and streaming-via-edit-message is Hermes P7 carry-forward item 1 (`StreamingConfig`, `docs/open-items.md`). Recommendation: treat I2 as the priority item within Batch 1, and pull streaming forward to immediately after the UX Hardening phase — streaming turns the standard-tier completion (the longest single wait) from a blank gap into visible progress, which users reliably experience as "faster" at identical wall-clock time.

### L7. The strategic fix is already on the roadmap — the classifier chain dies in T-track
Every structural latency cost above (L2, L3, L5) is an artifact of the deterministic-router-first architecture: classify, verify, split, then answer. Chatbot-primary (T1–T6b) replaces the chain with **one** tool-calling completion; T6b deletes the intent classifier, verifier, and grey-zone entirely. No new architecture is needed for latency — the decision is sequencing. L1/L2/L4 are worth doing now because they're free; L3/L5 should be pursued only if their regression evidence is green *and* the T-track remains distant, because they invest in components scheduled for deletion.

### Summary table

| # | Fix | Quality impact | Effort | Notes |
|---|---|---|---|---|
| L1 | Ollama `keep_alive` knob | none | XS | Likely the "sometimes slow"; verify with `ollama ps` |
| L2 | Parallelize recall + PAS classifiers | none | XS | Pair with L4 for real concurrency |
| L4 | Serve 31B via llama.cpp server (prefix cache, parallel slots) | none | S (ops) | Provider + install doc already exist |
| L6 | Typing indicator (I2) now; streaming next | none (perception) | S | Both already specced |
| L5 | Measure verification frequency; test local verification | gated on regression | S | Component dies in T6b |
| L3 | Per-purpose model overrides for non-routing classifiers | gated on regression | M | Overlaps cascading-models proposal |
| L7 | T-track collapses the classifier chain | positive | (roadmap) | Sequencing decision, not new work |
