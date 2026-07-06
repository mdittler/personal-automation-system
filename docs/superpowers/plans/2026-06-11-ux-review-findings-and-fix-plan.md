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

---
---

# Audit Roadmap (2026-07-06)

Remaining audit areas, ordered by priority against the open-source goal. Areas 1–3 should complete before the repo goes public; 4–6 can follow. Each completed audit appends its findings as a new pass in this document.

| # | Area | Why | Status |
|---|---|---|---|
| 1 | **Security & trust-boundary audit** — repo hygiene (secrets/PII in tree + history), API/GUI auth surfaces, installer trust model, network exposure | Threat model changes completely when the repo and install surface go public; history scrubbing is irreversible after publication | **Done — Fourth-Pass Review below** |
| 2 | **Fresh-install reality check** — clean-VM walkthrough of README Quick Start + DEPLOYMENT.md (clone → configure → first Telegram message), including the launchd/Docker paths | Docs have never been executed by a non-author on a non-author machine; first-run failure is the #1 cause of abandoned OSS evaluations. (Passing observation from pass 4: the launchd plist in DEPLOYMENT.md references `dist/core/src/main.js`, which does not match the actual build layout — likely one of several stale spots.) | **Done — Fifth-Pass Review below** |
| 3 | **Privacy / data-flow statement** — document exactly what leaves the machine (Anthropic API receives transcripts/prompts on standard tier; n8n webhooks; nothing else) and under which settings | "Local-first" is the pitch; users will ask precisely this. Complements the existing secret-redaction proposal (code half) in open-items | **Done — Sixth-Pass Review below** |
| 4 | **Backup/restore drill** — rehearse a full restore: markdown tree + `chat-state.db` + YAML indexes + vault symlinks; document ordering/consistency assumptions | BackupService exists but restore has never been exercised; recovery claims are untested | **Done — Seventh-Pass Review below** |
| 5 | **Long-horizon resource audit** — project `data/` growth over years (transcripts, photos, `change-log.jsonl`, regression cache, SQLite WAL); define retention policies beyond P5's opt-in session prune | System is designed to run indefinitely; unbounded growth is a slow failure | **Done — Eighth-Pass Review below** |
| 6 | **Dependency / supply-chain pass** — `pnpm audit`, outdated majors, pinning policy, lockfile hygiene | Routine, but becomes public-facing hygiene the moment other households run this lockfile | **Done — Ninth-Pass Review below. Roadmap complete.** |

Already covered elsewhere: test-suite quality (staged review queued in `docs/test-review-roadmap.md`); GUI accessibility (partially, M7 + Batch 2); user-facing docs accuracy (USER_GUIDE) folds naturally into area 2.

---
---

# Fourth-Pass Review (2026-07-06): Security & Trust-Boundary Audit

Audit of area #1 from the roadmap above, performed against the `pas-security-posture` checklist plus the open-source threat model (public repo; strangers running instances; strangers publishing apps). Method: verified the documented posture claims against code, swept the working tree and full git history (1,241 commits) for secrets and personal data, and reviewed the four externally-reachable surfaces (Telegram webhook, GUI, REST API, app installer). No code changed.

**Headline:** the implemented security engineering is genuinely strong — every posture claim I tested held up (see "Verified strong" below). The open-source risks are not in the auth code; they are (a) personal data already in tracked files and history, (b) an install-time UX that implies a containment boundary the runtime doesn't have, and (c) a deployment doc that publishes the GUI to the internet as a side effect of webhook setup.

## Repo hygiene (pre-publication — irreversible once public)

### SEC-1. Operator PII is in tracked files and throughout git history
The good news first, because it's the part that usually goes wrong: `data/`, `.env`, and `config/pas.yaml` are correctly gitignored, contain the only real credentials, and — verified across all 1,241 commits — **were never committed**. `.env.example` and `pas.yaml.example` are placeholder-only. No API-token-shaped strings (`sk-ant-*`, Telegram bot-token pattern) exist anywhere in history.

What is tracked: the operator's real Telegram user ID (`8187111554`) appears in **8 files at HEAD** — 4 test files (`auth-set-password.test.ts`, `migration-backup.test.ts`, `invite-name-validation.test.ts`, `user-manager.test.ts`) and 4 spec/plan docs (2026-03-31 food H3, 2026-04-08 invite design, both 2026-05-18 identity docs) — and consequently in a large fraction of history. Real first/last names appear in several docs and tests. A Telegram user ID is a low-sensitivity identifier (it enables spam/lookup correlation, not account access), but in a public repo it durably and searchably links the operator's real identity to this deployment, and the spec docs carry real household context around it.

**Fix (decide before publication):**
1. *Tree scrub (cheap, do regardless):* replace the real ID with a fixture ID in the 4 tests and 4 docs; sweep `docs/superpowers/` for household/family specifics (the food specs were written from real household requirements).
2. *History (decision):* either publish a **fresh-history public repo** from the scrubbed tree (recommended — simplest, loses public history but the private repo keeps it), or `git filter-repo` the existing history (invasive, breaks all clones/PR references), or accept the ID in history as low-sensitivity (defensible, but combine with 1 so it at least leaves HEAD). Fresh-history also moots any *future* discovery of something else in the 1,241 commits.

### SEC-2. No secret-scanning gate
Nothing prevents the *next* commit from including a token — protection today is convention plus the gitignore. One incident after the repo is public means key rotation + history surgery under time pressure.

**Fix:** add gitleaks (or equivalent) to the existing pre-push hook chain (`.claude/hooks/` already runs Biome there, so the pattern exists) and as a CI job before publication.

## Trust model & install surface

### SEC-3. The install permission summary implies enforcement that doesn't exist
`pnpm install-app` prints an Android-style grant screen — "Services: …, Data access: …, External APIs: …" (`core/src/cli/install-app.ts:63-93`) — then asks "Proceed with installation?". But apps run **in-process**: regardless of declarations, an installed app can read `process.env` (bot token, Anthropic key, `GUI_AUTH_TOKEN`), use `node:fs` against the entire data directory, and exfiltrate over unrestricted network I/O. The declared-services model is real *defense in depth for honest apps* (undeclared services are `undefined`; `ScopedDataStore` blocks traversal for code that uses it), and `CREATING_AN_APP.md:1230` states the trust model honestly — but the one place a user makes the actual trust decision shows a permission list with **no trust warning at all**. For the current install base (you) this is fine; for open source it's the difference between informed and misled consent.

**Fix:** add a plain-language warning to the CLI confirm step ("This app will run with the same access as PAS itself — including your bot token, API keys, and all household data. The list above is what it *declares*, not a sandbox. Only install from authors you trust."); mirror it in the "Sharing Your App" / README install sections. Cheap, and it makes the honest docs stance visible at the moment of decision.

### SEC-4. The static analyzer stops accidents, not adversaries — calibrate expectations before a community exists
`static-analyzer.ts` regex-scans import/require specifiers for 6 banned modules (LLM SDKs, `child_process`). It does not model dynamic construction (`import(['node:child','process'].join('_'))`), `eval`, or `new Function`, and it doesn't restrict `fs`/network at all — by design, and the docs say so. Two calibration points for the OSS roadmap: (a) the **container isolation** proposal in `docs/open-items.md` currently triggers on "community forms and multi-tenant security requirements harden" — that trigger should move earlier, to *"before publicizing `install-app` as a way to run third-party apps"*, because the first community app arrives before a community forms; (b) meanwhile, SEC-3's honest warning is the mitigation. Don't invest in strengthening the regex — it cannot win, and implying it can is worse than saying it can't.

## Network exposure

### SEC-5. The documented Cloudflare tunnel publishes the GUI and API to the internet
`DEPLOYMENT.md:189-198` routes the tunnel ingress to the **whole service** (`service: http://localhost:3000`) — so following the webhook setup verbatim also exposes `/gui` (a public login page for your household) and `/api/*` to the internet, without the doc mentioning it. The surfaces are not naked (password auth + per-user/per-IP login limits + CSRF + secure cookies + timing-safe compares all verified), but internet-facing-by-default should be a documented choice, not a side effect.

**Fix (docs-only):** show a path-scoped ingress in DEPLOYMENT.md (route only `/webhook/*` through the tunnel; keep GUI/API LAN-only) as the default, with the full-service ingress as an explicit opt-in paired with a recommendation for Cloudflare Access in front of `/gui`. One YAML block plus two sentences.

## Verified strong (for the record)

Claims from the security posture tested against code and confirmed — future audits can skip these: **API auth** (`core/src/api/auth.ts`): timing-safe legacy-token compare, IP rate limit *before* auth, legacy path disabled when `API_TOKEN` empty, per-user `pas_*` keys verified via scrypt with user/household **rehydrated from live services at verify time** (revoked/removed users fail closed). **GUI auth** (`core/src/gui/auth.ts`): signed cookie `{userId, sessionVersion, issuedAt}`, sessionVersion invalidation, sliding 24h session, `httpOnly` + `sameSite: strict` + production `secure` flags on all set/clear paths, per-userId and per-IP login limiters, timing-safe comparisons, legacy `GUI_AUTH_TOKEN` gated to exactly-one-admin installs. **Telegram webhook**: `X-Telegram-Bot-Api-Secret-Token` always enforced — secret comes from env or is derived from the bot token (`compose-runtime.ts:1619`, `bootstrap.ts:43`), timing-safe. **Callback queries** (`compose-runtime.ts:1438+`): registration guard before any dispatch, app-toggle re-check on verification callbacks, nonces on session-control confirmations, buttons are DM-scoped so cross-user tapping isn't reachable. **Path handling**: `SAFE_SEGMENT` + resolve-within + null-byte rejection in `data-store/paths.ts`. **Secrets layout**: 0600 key files, scrypt hashing, `pas_<keyId>_<secret>` format never sent to LLMs.

## Recommended sequencing

1. **Now (docs + config, no code):** SEC-5 deployment-doc ingress fix; SEC-1 tree scrub of the 8 files.
2. **Before the repo goes public (blocking):** SEC-1 history decision (fresh-history repo recommended); SEC-2 secret-scan gate; SEC-3 CLI trust warning (one string + test).
3. **Before promoting third-party app installs (can be post-launch):** SEC-4 container-isolation trigger re-scope in open-items.
4. Then proceed down the roadmap: area 2 (fresh-install check) naturally validates the SEC-5 doc fix.

---
---

# Fifth-Pass Review (2026-07-06): Fresh-Install Reality Check

Audit of area #2 from the roadmap. Method: traced every step of the README Quick Start and DEPLOYMENT.md (First-Run Checklist, Docker, Cloudflare Tunnel, launchd) against the code that actually executes, and **ran the production three-phase boot sequence against a pristine data directory with the verbatim example config** (scratchpad simulation of `loadSystemConfig` transitional → `runHouseholdMigration` → `loadSystemConfig` strict — the exact sequence in `compose-runtime.ts:281-300`). No code changed.

**Headline:** a fresh install following the Quick Start verbatim **crashes at first boot** — not from a missing prerequisite or a stale doc, but from a real bug: the household migration's fresh-install branch never writes `household_id` into `pas.yaml`, and the strict config load then rejects every user. Every fresh clone since D5a hits this. Beyond that, the native (non-Docker) production path is doubly broken — the documented entrypoint file doesn't exist, and even the correct entrypoint can't serve the GUI because `pnpm build` doesn't copy view assets into `dist`. The dev path (`pnpm dev`) and the Docker path are solid once the config bug is cleared; most remaining findings are doc drift concentrated in DEPLOYMENT.md.

## Blockers

### INST-1. Fresh install crashes at boot with the example config (reproduced)
`config/pas.yaml.example` (and DEPLOYMENT.md's "Minimal `config/pas.yaml`") define users with no `household_id` — the field appears nowhere in either file. On first boot, the three-phase sequence runs: transitional load flags `migrationNeeded`, `runHouseholdMigration` takes the fresh-install branch (`core/src/services/household/migration.ts:194-202`) which **only writes the marker file** — unlike the legacy-data path, it neither rewrites `pas.yaml` to add `household_id: default` nor creates `data/system/households.yaml`. Phase 3 strict load then throws:

```
ConfigValidationError: Strict mode: the following users are missing householdId: <id>.
Run the household migration or load with mode='transitional'.
```

The suggested remedy is a dead end — the migration already ran and the marker blocks it from ever running again. Reproduced end-to-end with the verbatim example config; also verified that manually adding `household_id: default` gets past strict load, but that leaves `households.yaml` absent, so `HouseholdService` initializes with zero households and every user references a household that doesn't exist (`getHousehold` returns null; several mutation paths throw `Household "default" not found`) — half-configured, untested territory.

**Fix:** make the fresh-install branch do the same bootstrap as the migration path — create `data/system/households.yaml` with the `default` household (admins from config) and rewrite `pas.yaml` to add `household_id: default` to each user — then add `household_id: default` to `pas.yaml.example` and the DEPLOYMENT.md minimal config anyway, with a comment, so the config file and reality match from the start. Add a first-boot integration test that boots from `pas.yaml.example` + empty data dir (this is the test that would have caught it).

### INST-2. The documented native production entrypoint doesn't exist — and native production is broken regardless
Three docs tell the user to run `node dist/core/src/main.js`: DEPLOYMENT.md:96 (First-Run Checklist step 4), the launchd plist at DEPLOYMENT.md:230 (which also points at a stale repo directory name, `Projects/personal-assistant`), and OPERATIONS.md:121. No `main.js`/`main.ts` exists anywhere; the real compiled entrypoint is `core/dist/bootstrap.js` (what the Dockerfile runs). Worse, fixing the path isn't enough: `pnpm build` (plain `tsc --build`) does **not** emit `gui/views/` or `gui/public/` into `core/dist` — the Dockerfile hand-copies them (`Dockerfile:65-67`) — and `guiDir` resolves relative to the compiled file (`core/src/server/index.ts:28-29`), so a native `node core/dist/bootstrap.js` run points `@fastify/static` and the Eta view root at directories that don't exist. Today the only working run modes are `pnpm dev` (tsx, resolves from `src/`) and Docker.

**Fix:** add an asset-copy step to the core build (views, public; the manifest schema JSON already gets emitted), then correct the three doc references to `node core/dist/bootstrap.js` and fix the plist's repo path. Alternatively, if native-production isn't a supported mode, say so explicitly in DEPLOYMENT.md and make launchd wrap `pnpm dev` (which is what `start-pas.command` already does).

### INST-3. DEPLOYMENT.md's tunnel section sets a webhook URL that 404s every Telegram update
DEPLOYMENT.md:201 says `WEBHOOK_URL=https://your-subdomain.example.com` — no path. `bootstrap.ts:50` registers that raw value with Telegram via `setWebhook`, but the only inbound route is `POST /webhook/telegram` (`core/src/server/webhook.ts:24`). Result: webhook registered at `/`, every update 404s, the bot is silently dead (and polling is off because `WEBHOOK_URL` is set). README:170 and `.env.example:73` show the correct full URL including `/webhook/telegram`; DEPLOYMENT.md is the odd one out — and it's the doc the SEC-5 rewrite touches, so fix both in the same edit.

### INST-4. README's "Production with Cloudflare Tunnel" path can't work — `CLOUDFLARE_TUNNEL_TOKEN` is consumed by nothing
README:166-173 instructs: set `WEBHOOK_URL`, set `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, run Docker Compose, "traffic goes through the tunnel." But `docker-compose.yml` has **no cloudflared service**, and the token env var is parsed into config (`core/src/services/config/index.ts:180,268` → `config.cloudflare.tunnelToken`) and then **never read by anything**. Following the section verbatim yields: no ports exposed (by design) + no tunnel process + webhook mode forced = a container Telegram cannot reach. The user must independently know to run `cloudflared` themselves (DEPLOYMENT.md's native flow does this properly — via a credentials file, which doesn't use the token env var either).

**Fix:** either add a `cloudflared` service to `docker-compose.yml` that actually consumes `CLOUDFLARE_TUNNEL_TOKEN` (remotely-managed tunnel, `TUNNEL_TOKEN` env), or rewrite the README section to point at DEPLOYMENT.md's `cloudflared tunnel run` flow and delete the dead env var from `.env.example` and the config schema.

## Important

### INST-5. Docker Compose couples every install to Ollama — and ships it empty
`docker-compose.yml` gives `core` a hard `depends_on: ollama: service_healthy` and unconditionally overrides `OLLAMA_URL=http://ollama:11434`. Consequences: (a) an Anthropic-only user still downloads the multi-GB Ollama image and waits for its healthcheck before PAS starts; (b) for an Ollama-only user (no cloud keys — the local-first pitch), the fresh `ollama-models` volume contains **no models**, nothing in the Docker path says to run `docker exec pas-ollama ollama pull llama3.2:3b` (only OPERATIONS.md:193's troubleshooting hints at `ollama list`), and the LLM service has no cross-provider fallback — so the first message fails. Mitigating: when a cloud key is present, `pickFastTier` prefers cloud providers, so the empty Ollama is merely dead weight, not a failure.

**Fix:** put `ollama` behind a compose profile (`--profile ollama`), drop the unconditional `OLLAMA_URL` override (respect `.env`), and add a "pull your model" step to the Docker section of README/DEPLOYMENT.

### INST-6. DEPLOYMENT.md sends users to the wrong GUI URL
First-Run Checklist step 5: "Open the management GUI at `http://localhost:3000`" — all GUI routes are registered under the `/gui` prefix (`core/src/gui/index.ts:346`) and there is no root route or redirect, so `/` returns 404 with no pointer. README:90 says `/gui` correctly. **Fix:** correct the doc; optionally add a one-line `GET /` → `302 /gui` redirect for first-run friendliness (one route, no auth implications).

### INST-7. Prerequisite drift in DEPLOYMENT.md
DEPLOYMENT.md:6 says "pnpm 9+"; `package.json` declares `engines.pnpm: >=10` and `packageManager: pnpm@10.30.3`, so pnpm 9 fails at `pnpm install` with an engine error. README says 10+ correctly. Same doc also labels `GUI_AUTH_TOKEN` "Legacy" in the env table while the config loader hard-requires it (`core/src/services/config/index.ts:157` — no default), even for installs that will only ever use password login; a fresh installer must generate a token they may never use. Cosmetic mismatch worth resolving in whichever direction is intended (give it a default of empty + keep the exactly-one-admin gate, or keep it required and drop the "Legacy" framing from the table).

## Minor

### INST-8. Windows dev install path likely fails at the `prepare` hook
`package.json` `prepare` runs `bash .claude/hooks/install-git-hooks.sh` on every `pnpm install`. The script guards gracefully against non-git contexts (`|| exit 0`) but not against **bash not existing** — on a Windows machine without Git Bash on PATH, the lifecycle script fails and `pnpm install` errors out. DEPLOYMENT.md:8 says "Windows is supported for development," and `start-pas.bat` exists for exactly that audience. Unverified on a real Windows box (flagged as likely, not confirmed). **Fix:** wrap `prepare` in a node one-liner that no-ops when bash is unavailable, or document Git Bash as a Windows prerequisite.

## Verified accurate (for the record)

Steps executed or traced that hold up — future audits can skip these. **Quick Start command set:** every script in README's Available Scripts table exists in `package.json` with matching semantics. **Env plumbing:** `.env` is loaded by the config service itself (dotenv — no manual export needed); envalid produces clear missing-var errors naming `TELEGRAM_BOT_TOKEN`/`GUI_AUTH_TOKEN`; `ANTHROPIC_API_KEY` is genuinely optional as README claims, with a helpful "No LLM providers available" error listing all alternatives when nothing is configured. **`.env.example`** documents every variable the config schema reads, with correct defaults (including the full webhook URL with path). **`pas.yaml.example`** parses clean (modulo INST-1's missing `household_id`) and its inline comments match implemented behavior spot-checked (routing verification defaults, regression budget). **Build/dev:** `pnpm dev` works pre-build — the app loader falls back `dist/index.js` → `src/index.ts` (`core/src/services/app-registry/loader.ts:78-82`) and tsx resolves TS; README's build-then-dev ordering is still right since apps import `@pas/core`'s compiled exports. **Health endpoints:** `/health`, `/health/live`, `/health/ready` all exist, matching both the Dockerfile HEALTHCHECK (`/health/ready`) and the compose healthcheck (`/health`). **Docker runtime image:** coherent — correct entrypoint, hand-copied view assets, schema JSON emitted by tsc; compose's "no exposed ports" claim matches the file. **Upgrade-path migration docs:** DEPLOYMENT.md's Household Migration section accurately describes `migration.ts` behavior for installs with existing data (backup-first, marker, `pas.yaml` rewrite — it's only the *fresh* branch that's incomplete). **First-contact UX:** USER_GUIDE's getting-started flow matches the invite/registration implementation. (Cross-ref: README advertises "License: MIT" but the repo has no LICENSE file — already filed as DOC-2.)

## Recommended sequencing

1. **Now (the bug):** INST-1 fresh-install migration fix + example-config `household_id` + first-boot test — this is the single highest-leverage pre-publication item found by any pass so far: it is the first thing every evaluator hits.
2. **Now (docs-only batch):** INST-2 entrypoint references, INST-3 webhook URL, INST-6 GUI URL, INST-7 prereq drift — one DEPLOYMENT.md/OPERATIONS.md editing session, naturally combined with the SEC-5 ingress rewrite of the same file.
3. **Before publicizing the Docker path:** INST-2 build asset-copy step (or explicit "Docker/dev only" stance); INST-4 tunnel decision (add cloudflared service vs rewrite section); INST-5 compose decoupling + model-pull step.
4. **Opportunistic:** INST-8 Windows prepare guard.
5. A true clean-VM run (fresh macOS/Linux user account, no author dotfiles) remains worth one hour after INST-1..3 land — this pass traced code, not machine state, so PATH/permissions/corepack surprises are still unprobed.

---
---

# Sixth-Pass Review (2026-07-06): Privacy / Data-Flow Audit

Audit of area #3 from the roadmap. Method: swept every outbound network call site in `core/` and `apps/` — all `fetch()` callers, all HTTP-capable SDK imports (`@anthropic-ai/sdk`, `@google/genai`, `openai`, grammY), all subprocess spawns — and verified the payload contents at each site; then checked all user-facing docs for an existing privacy statement. No code changed.

**Headline:** the local-first claim holds up in code. The **only hardcoded external endpoint in the entire codebase is `api.telegram.org`**; there is no telemetry, no update checks, no analytics, and every other outbound flow is gated on explicit configuration. The gaps are documentation-shaped: nothing user-facing says what *does* leave the machine (PRIV-1 — the deliverable this audit was scoped to produce the content for), the tier→provider auto-assignment can silently change *which vendor* receives conversation text (PRIV-2), and the config templates advertise three integrations that have no consuming code at all (PRIV-4).

## The verified data-flow map

This is the content for the user-facing statement (PRIV-1). Every line was traced to its call site.

**Always on (inherent to a Telegram bot):**
- **Telegram Bot API** — every message, photo, and button interaction transits Telegram's servers, both directions (grammY; photo bytes are fetched back from `api.telegram.org/file/bot<token>/…`, `core/src/services/telegram/message-adapter.ts:66-67`). There is no PAS without this flow.

**When a cloud LLM provider is configured (the Quick Start default is Anthropic):**
- **Every chatbot turn** sends the assembled prompt to the standard-tier provider: the six-layer context — durable memory snapshot, app/system context, recalled data-file excerpts, recalled session excerpts, up to 20 turns of live history — plus the user's message. This is the largest and most sensitive flow: *anything stored in PAS data files can surface in a prompt via recall*.
- **Fast-tier classifiers** (routing intent, recall classification, session control, multi-intent segmentation, route verification) send the user's message text — and, for recall, candidate transcript excerpts — on nearly every free-text message.
- **Photos**: routing classification uses *caption text only* (`core/src/services/router/photo-classifier.ts:5`), but the handling app then sends the **image bytes** as a base64 vision request (receipts, cookbook pages, fridge/pantry photos → `anthropic-provider.ts:59-63` multimodal path).
- **Alerts & reports**: fuzzy (LLM) alert conditions and LLM summaries send the *contents of the watched data files* to the provider (`alert-executor.ts` `generateSummary(rawData…)`).
- **Regression suite** (explicit `pnpm test:regression` runs only): fixture data, including receipt fixture images, to the models under test.
- **Admin GUI model pages**: Anthropic `models.list` (`model-catalog.ts:134`) — metadata only, no user data.

**Only when explicitly configured (all default-off):**
- **Outbound webhooks** (`webhooks:` in pas.yaml): metadata-only payloads — event name, timestamp, IDs/paths/counts, **no file contents** (`webhooks/index.ts:102-106`; emission sites verified: `data:changed` carries the data *path*, `alert:fired`/`report:completed` carry IDs and counts). Note the path itself can reveal user id / app / filename.
- **n8n dispatch** (`n8n.dispatch_url`): `{type, id, action}` only (`n8n/index.ts:19-23`).
- **Alert `webhook` action**: the exception to "metadata only" — posts up to **1MB of the watched file's raw contents** (`{data}` template, `alert-executor.ts:212-222`) to the operator-configured URL. Deliberate and operator-authored, but the statement must name it.
- **LAN-local by nature**: Ollama / llama.cpp (prompt content stays on the local network), Chromecast casting (`cast.py`), n8n when self-hosted. The GUI dashboard's only outbound fetch is a health ping to the configured `OLLAMA_URL` (`dashboard.ts:57`).

**Never leaves the machine:** canonical markdown/YAML data, transcripts, SQLite/FTS indexes, cost tracking, model journal, shadow-classifier telemetry, logs, Piper TTS synthesis, ffmpeg transcoding.

**Fully-local mode is real:** with no cloud keys and `OLLAMA_URL` (or a llama-cpp provider) set, all LLM traffic stays on-LAN — the config loader explicitly supports this ("No LLM providers available" error lists the local options). Telegram remains the one unavoidable cloud dependency.

## Findings

### PRIV-1. No user-facing data-flow statement exists — the map above is the missing content
"Local-first" is the first line of the README and appears throughout the docs, but no README section, USER_GUIDE, DEPLOYMENT, or OPERATIONS text says what leaves the machine and when — the question every privacy-conscious evaluator of a "local-first" system asks first. **Fix (docs-only):** publish the map above as `docs/PRIVACY.md` (or a README "What leaves your machine" section), including the fully-local recipe and the Telegram caveat. This is the documentation half of the existing secret-redaction proposal in open-items; the statement should plainly say *"anything you store in PAS can be recalled into LLM prompts"* until the code half ships.

### PRIV-2. Tier auto-assignment silently changes which vendor receives conversation text
`pickFastTier` prefers Google > OpenAI > Anthropic (`core/src/services/config/index.ts`): merely adding `GOOGLE_AI_API_KEY` to `.env` reroutes every fast-tier call — user messages and recalled transcript excerpts — to Google, with no notice to the operator. Provider data-use policies differ materially (training-use terms vary by vendor and tier of service); which key you add determines whose terms govern your household's conversation fragments. **Fix:** the statement must explain that the tier→provider mapping decides who sees the text and link each provider's data-use terms; additionally, log the resolved tier→provider map at startup so a config change that silently reroutes data is at least visible in the boot log.

### PRIV-3. Data files can carry secrets into prompts (cross-ref, code half already filed)
The recalled-data fence, alert summaries, and report sections all move data-file contents into LLM prompts. Users who paste an API key or password into a note will ship it to their LLM provider. The **secret redaction pass** proposal already tracked in open-items is the code fix; until it ships, PRIV-1's statement is the mitigation (say it, don't imply it can't happen).

### PRIV-4. Config templates advertise three integrations with zero consuming code
`.env.example` documents `GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN` and `OPENWEATHERMAP_API_KEY`; `pas.yaml.example` documents `food.usda_fdc_api_key` ("quick-meal macro cross-check"). **No code reads any of them**: no manifest declares `external_apis`, nothing calls `services.secrets.get`, and no USDA/weather/calendar client exists in `core/` or `apps/`. Good for privacy, bad for auditability — an evaluator tracing these flows finds dead ends, and the data-flow statement can't honestly be exhaustive while the templates imply flows that don't exist. **Fix:** remove them from the templates (or mark "reserved — not yet implemented"), and drop the USDA mention from CLAUDE.md's pas.yaml description if removed.

## Verified strong (for the record)

No telemetry, crash reporting, update checks, or analytics anywhere in `core/` or `apps/`. Single hardcoded external host (`api.telegram.org`). Webhook and n8n payloads are metadata-only by construction, HMAC-signed when a secret is set, rate-limited per URL, `http(s)`-scheme-validated. All derived stores (SQLite, cost cache, telemetry logs) are local files under `data/`. Per-user API keys (`pas_*`) are never included in LLM prompts (verified in the fourth pass). The `services.secrets` indirection means apps never read `process.env` for external keys *through the sanctioned path* (the in-process caveat from SEC-3 still applies to malicious apps).

## Recommended sequencing

1. **Now (docs-only):** PRIV-1 — write `docs/PRIVACY.md` from the map above; link it from README's local-first pitch. Fold in PRIV-2's provider-terms explanation and the fully-local recipe. One writing session, no code.
2. **Same session:** PRIV-4 template cleanup (delete or annotate the three dead integration surfaces).
3. **Small code follow-up (optional but cheap):** PRIV-2's startup log line for the resolved tier→provider map.
4. **Unchanged:** PRIV-3's code half stays as the existing secret-redaction proposal in open-items.

---
---

# Seventh-Pass Review (2026-07-06): Backup / Restore Drill

Audit of area #4 from the roadmap. Method: reviewed `BackupService`, its bootstrap wiring, and the OPERATIONS.md restore procedure — then **actually rehearsed the restore** in an isolated scratchpad against the live 16MB data tree: created an archive with the exact tar invocation `BackupService.createBackup()` uses, extracted it, verified file/symlink fidelity, checked SQLite integrity, and exercised the worst case (derived index deleted, rebuilt from restored transcripts). No repo code changed; the live system was untouched except one remediated side effect noted in BKP-3.

**Headline:** the mechanism works — the drill succeeded end-to-end, including the worst-case index rebuild. The real risks are operational, not mechanical: **backups are off by default and off on the only production deployment** (the live `pas.yaml` has no `backup:` section — BackupService has never run in production), the restore doc is missing the steps that make a restore actually complete (index rebuild, `.env`, installed apps), and the recovery tooling has a flag-default footgun that the drill itself tripped over.

## Drill results (executed, not inferred)

| Step | Result |
|---|---|
| Archive with BackupService's exact tar shape (`tar -czf … -C <parent> data -C <parent> config`) | ✅ 2.2MB archive from the 16MB live tree, exit 0 |
| Extract to staging | ✅ 1,015/1,015 files, 6/6 symlinks restored *as symlinks* (tar does not follow them — no data duplication) |
| Restored `chat-state.db` (+ `-wal` + `-shm`, all captured) | ✅ `PRAGMA integrity_check` = ok |
| Worst case: derived DB deleted, rebuilt from restored markdown via `chat-index-rebuild --data <restored> --db <restored>` | ✅ 2 sessions / 144 turns indexed, integrity ok |
| Vault symlink self-heal | ✅ `VaultService.rebuildAll()` runs unconditionally at boot (`compose-runtime.ts:1063`) — dangling absolute links are recreated on first start |

Ordering/consistency assumptions confirmed: the household-migration marker lives *inside* `data/system/`, so a restore does not re-trigger the migration; markdown transcripts are the canonical store and the SQLite index is genuinely reconstructible from them.

## Findings

### BKP-1. Backups are off by default — and off in production
`backup.enabled` defaults to `false` and the live `config/pas.yaml` has no `backup:` section, so the scheduled backup has **never run** on the real deployment. The only backup that has ever executed is the one-shot pre-migration copy from D5a. For a system holding years of household data, the current protection is whatever the host machine's own backup regime is. **Fix (config-only, do today):** add the four-line `backup:` block to the live config. For the open-source audience, consider flipping the default to `enabled: true` when the platform supports it (tar present, non-Windows) — an opt-out backup is the safer default for non-expert operators.

### BKP-2. The restore doc stops before the restore is actually complete
OPERATIONS.md's procedure (stop → extract → replace `data/`+`config/` → restart) worked in the drill, but it omits: **(a)** the archive filename pattern is stale (`pas-2026-04-14-030001.tar.gz` vs actual `pas-backup-<ISO-with-T>.tar.gz`); **(b)** the staging dir must exist before `tar -C` into it; **(c)** what the archive does *not* contain — `.env` (all secrets), the codebase itself, and **installed third-party apps** (`install-app` clones into the repo's `apps/`, outside the `data`+`config` scope) — so a bare-machine restore needs repo clone + `.env` recreation + app re-installs, none of which is stated; **(d)** the post-restore `pnpm chat-index-rebuild` step for the derived index (with both `--data` and `--db` if restoring to a staging path); **(e)** a note that vault symlinks carry absolute paths and self-heal on first boot. **Fix:** one editing session on OPERATIONS.md § Backup & Restore adding a "what's in / not in the archive" table and the missing steps.

### BKP-3. `chat-index-rebuild`'s `--data` and `--db` defaults don't travel together (footgun, tripped during the drill)
Passing only `--data <restored>` reindexes from the restored transcripts but writes to the **live** DB (`--db` independently defaults to `<cwd>/data/system/chat-state.db`, `scripts/chat-index-rebuild.ts:30-36`). The drill hit exactly this; it was harmless (the index stores session/user/household IDs and content, no absolute paths, and the restored transcripts were minutes-old copies of the live ones — the live DB was re-rebuilt from live data immediately after as remediation). But in the reverse recovery scenario — inspecting an *old* backup while the live system exists — the same invocation silently overwrites the live index with stale content. **Fix:** derive the default DB path from `--data` when it's provided (or refuse/warn when the data root and db root differ); one-line doc note meanwhile.

### BKP-4. Live-tree consistency assumptions are real but undocumented
`createBackup()` tars the live tree with no quiescing or snapshot. Two consequences to document rather than fix: **(a)** `chat-state.db` runs in WAL mode (`schema.ts:63`; the live WAL was 1.7MB — 10× the DB itself), so an archive taken mid-write can capture a torn db/wal pair — acceptable *only because* the index is derived and rebuildable, which is why BKP-2(d)'s rebuild step belongs in the restore doc; **(b)** behavior under concurrent writes differs by platform: GNU tar (Linux/Docker) exits non-zero on "file changed as we read it", making `createBackup()` delete the partial archive and throw — that night's backup simply doesn't happen — while macOS bsdtar tolerates it. Failure *is* surfaced (the scheduler's job-failure notifier Telegrams the admin, URS-SCH-005) — but the notifier's **consecutive-failure auto-disable** applies to `system-backup` like any job: a transient week of failures silently turns backups off until manually re-enabled. **Fix:** exempt `system-backup` from auto-disable (or add a "days since last successful backup" line to `/gui` dashboard / a periodic report).

### BKP-5. No guard against `backup.path` inside the data directory (minor)
The default (`<dataDir>/../backups`) is safe, but a user-set `path:` under `data/` makes every archive include all previous archives — geometric growth. One `resolve()`-prefix check at config load.

### BKP-6. Docker backup path untested (minor)
In the container, `BackupService` shells to Alpine's busybox tar; the multi-`-C` invocation should work on busybox but has never been exercised there, and the flow assumes the `/backups` volume mount from DEPLOYMENT.md exists. Verify once when touching the Docker path (pairs with INST-5's compose work).

## Verified strong (for the record)

Retention rotation is correct (lexicographic sort of ISO-timestamped names = chronological; oldest-first deletion honors `retention_count`). Partial archives are deleted on tar failure before rethrow, so a failed run can't poison the retention window. Output is stat-verified nonzero. Symlinks are archived as links, not followed. Windows is an explicit logged no-op matching the docs. The migration marker, model journal, cost cache, and all YAML indexes live under `data/` and are therefore in scope. Scheduled-job failures notify the admin over Telegram with rate limiting (URS-SCH-005).

## Recommended sequencing

1. **Today (operator, config-only):** BKP-1 — enable backups on the live deployment.
2. **One docs session:** BKP-2 restore-doc completion (+ BKP-4's assumptions written down); pairs naturally with the INST-2/3/6/7 DEPLOYMENT/OPERATIONS batch.
3. **Small code batch (pre-open-source, not blocking):** BKP-3 flag coupling, BKP-4 auto-disable exemption, BKP-5 path guard.
4. **Fold into Docker work:** BKP-6 busybox-tar verification alongside INST-5.

---
---

# Eighth-Pass Review (2026-07-06): Long-Horizon Resource Audit

Audit of area #5 from the roadmap. Method: measured every growth surface in the live `data/` tree (deployed 2026-03-10, actively written through 2026-06-15 — a 97-day observation window), traced each store's writer and reader in code, and inventoried every retention mechanism that exists. Projections extrapolate the *observed* single-user rates; multi-user households scale the per-user stores roughly linearly. No code changed.

**Headline:** disk space is a non-issue — at observed rates the canonical data tree grows on the order of **tens of MB per year**, and two feared growth surfaces turned out not to exist (no photos are ever persisted to disk; the FTS index is derived and pruneable). The real long-horizon risks are different: **the production log file has no rotation and lives inside the backup scope** (RES-1), several append-forever files are **read whole** by code that runs at boot or per-GUI-view, so cost grows linearly with age even though bytes don't matter (RES-2, RES-5), and per-run history files accumulate **file-count** rather than bytes (RES-3). One telemetry class (the shadow-classifier log) demonstrated a 40MB/yr appetite while it was enabled (RES-4).

## Measured inventory (97-day window, single user)

| Store | Size today | Rate (observed) | Retention mechanism | Unbounded? |
|---|---|---|---|---|
| Chat transcripts (`sessions/*.md`) | 60KB (2 sessions, 144 turns) | ~0.2MB/yr at this usage | **P5 opt-in prune** (`sessions.auto_prune`, default off) + `chat-index-prune` | Yes, by design (canonical) |
| `chat-state.db` (+WAL/SHM) | 232KB | derived — tracks transcripts | Rebuildable (`chat-index-rebuild`); WAL auto-checkpoints, flushed on shutdown | No (derived) |
| `change-log.jsonl` | 334KB / 2,052 lines | **~1.0MB/yr** | None — append-forever | **Yes** |
| `llm-usage.md` | 320KB / 3,391 rows | **~1.0MB/yr** | None — append-forever | **Yes** |
| Shadow-classifier log | 6.1MB archived + 4KB live | **~40MB/yr while enabled** (Mar 10–May 5) | Per-entry truncation only; the one archive was manual | **Yes, when enabled** |
| Report/alert history | 140KB, 9 run-files | 1 file per run — an hourly alert would add **~8,760 files/yr** | None (MAX_REPORTS/MAX_ALERTS cap *definitions*, not history) | **Yes (file count)** |
| `daily-diff/` | 100KB, 23 files | ~365 small files/yr | None | Yes (slow) |
| Regression cache | 4.4MB / 78 files | grows per model ever tried | None — no eviction | **Yes** |
| `pas.log` (production only) | n/a locally (dev mode = stdout only) | est. 10–100MB/yr at info level | **None — single file, no rotation** | **Yes** |
| Model journal | 12KB | bounded | Monthly archive rotation (`model-journal-archive/<slug>/YYYY-MM.md`) ✅ | No |
| Vaults | 0B (symlinks) | — | Rebuilt at boot ✅ | No |
| Receipt/recipe photos | **0 bytes — never persisted** | — | Processed in-memory; only extracted text is stored | No |
| Backups | outside `data/` by default | retention_count × archive size | Rolling retention ✅ (when enabled — see BKP-1) | No |

**Three-year projection at observed usage:** canonical tree ≈ 20–60MB; with regression experimentation and one telemetry campaign ≈ 100–250MB; production `pas.log` is the wildcard (potentially larger than everything else combined). A 32GB Mac Mini will not notice any of this for a decade. The findings below are therefore about *cost-of-reading* and *operability*, not disk exhaustion.

## Findings

### RES-1. Production log file: no rotation, and it lives inside the backup scope
`createLogger` in production adds a pino file transport to a **single file**, `data/system/logs/pas.log` (`core/src/services/logger/index.ts:59-66`) — no size cap, no rotation, no retention. Two compounding effects: (a) it grows without bound for the life of the deployment; (b) it sits inside `data/`, so **every nightly backup archives the entire log history again** — the tar.gz series inflates with redundant log bytes. The current live deployment runs `pnpm dev` (pretty stdout, no file transport), which is why this hasn't bitten yet — it bites exactly when someone deploys "properly." **Fix:** add rotation (e.g. `pino-roll` size/date-based with a keep-count) *or* move logs out of `data/` (launchd already redirects stdout to `~/Library/Logs/pas/`); either alone fixes the backup inflation.

### RES-2. `llm-usage.md` is append-forever *and* read whole in hot paths
The cost tracker's rebuild path reads the **entire** usage log (`cost-tracker.ts:234`, triggered when the monthly cache needs reconstruction at boot) and the GUI usage page reads the whole file per view (`readUsage()`, `cost-tracker.ts:512`). At ~1MB/yr the bytes are trivial, but the pattern is linear-with-age on a file that never resets — after some years, boot-time rebuild and every `/gui/llm-usage` render pay for the full deployment history. **Fix:** monthly rotation using the model-journal pattern that already exists (`llm-usage/YYYY-MM.md`); `rebuildFromLog` only ever cares about the current month anyway, and the GUI defaults to recent months with older files loaded on demand.

### RES-3. Report/alert history: one file per run, forever — a file-count problem, not a byte problem
Every report run and alert fire writes a timestamped markdown file under `data/system/report-history/<id>/` (`reports/index.ts:461-469`, `alerts/index.ts:662-670`) with no retention of any kind. An hourly alert generates ~8,760 files/yr, indefinitely. Mitigating factors verified: `FileIndexService` scans only `users/spaces/households/collaborations` — **not** `data/system` — so the in-memory index and boot walk don't inflate (`file-index/index.ts:42`), and vaults don't expose system dirs. The pain arrives via directory listings (GUI history views, backup tar walks, Obsidian if someone points it at `data/` wholesale). **Fix:** per-target retention — keep last N run-files (N≈100), with an optional monthly-digest archive for the rest, consistent with the "archive, don't delete" principle.

### RES-4. Telemetry logs have per-entry caps but no file rotation — and one of them demonstrated a 40MB/yr appetite
The shadow-classifier log grew to **6.1MB in eight weeks** while shadow mode was active (Mar 10–May 5); its one archive (`shadow-classifier-log.archive-2026-05-05.md`) was a manual intervention, not code — no `archive-` writer exists anywhere in `core/` or `apps/`. `route-verification-log.md` and `session-control-log.md` follow the same pattern (per-entry `MAX_MSG` truncation, no file-level rotation); their observed rates are tiny, but they share the failure mode: any future telemetry campaign (new classifier shadow run, T-track migration validation) re-creates the 6MB/8wk situation with no automatic relief. **Fix:** a shared size-triggered rotate-to-archive helper (the model-journal archive naming convention is the precedent) applied to the three telemetry logs; cheap and closes the class.

### RES-5. `change-log.jsonl` is append-forever and read whole by the daily diff
~1MB/yr, no rotation, and `daily-diff/collector.ts:28` does `readFile` of the entire file (daily cron + `/changes` API). Same shape as RES-2, a decade from mattering at current rates — but a busy multi-user household with chatty apps multiplies the write rate, and the whole-file read runs *daily*. **Fix:** monthly rotation (`change-log/YYYY-MM.jsonl`); the collector only wants a 24-hour window and would read at most two monthly files.

### RES-6. Regression cache never evicts — entries for abandoned models persist forever
4.4MB across 78 files today; the cache key is model-ID-aware by design (good for comparisons), which means every model ever tried in `--model-matrix` experiments leaves its result set on disk permanently — no eviction, no age-out, nothing in `regression/src/runner/cache.ts`. **Fix (low priority):** an age-based sweep or a `/gui/regression` "clear caches for models not in the current tier map" button.

### RES-7. Retention posture is implicit, not documented (observation)
The system's actual policy today is: transcripts pruneable (opt-in), model journal rotated, backups rotated — **everything else append-forever**, in line with the "history never deleted" principle. That's a defensible stance for a local-first system, but it's written down nowhere; an operator asking "what grows and what can I safely delete?" has no answer short of reading code. **Fix (docs):** a short "Data growth & retention" section in OPERATIONS.md — essentially the measured-inventory table above plus which stores are safe to prune/rotate — folded into the same OPERATIONS.md session as BKP-2.

## Verified strong (for the record)

**No photos are ever written to disk** — receipt/recipe/pantry images are processed in-memory and only extracted text persists (0 image files in a 4-month-old deployment; also independently good for the privacy posture). **FTS index is genuinely derived** — rebuildable and pruneable (`chat-index-rebuild`/`chat-index-prune`), WAL auto-checkpoints and is flushed on shutdown (`compose-runtime.ts:1750`). **FileIndexService is scoped** to user-data trees, so system-dir file growth cannot inflate the in-memory index or boot scan. **Model journal rotation** works and is the reusable pattern for RES-2/4/5. **P5 transcript prune** exists with sane bounds (1–3650 days) and honest destructive-operation warnings. **Backup retention** rotates correctly (verified in the seventh pass). **MAX_REPORTS/MAX_ALERTS** cap definition counts. **Vaults are zero-byte** symlink trees.

## Recommended sequencing

1. **Fold into the existing OPERATIONS.md session** (with BKP-2/INST batch): RES-7 retention documentation — zero code, closes the "what grows?" question for operators.
2. **One small code batch, pre-open-source:** RES-1 log rotation (highest leverage — it's the wildcard store and poisons backups), RES-2 + RES-5 monthly rotation via the model-journal pattern, RES-4 shared telemetry rotate-to-archive helper.
3. **Post-launch, low priority:** RES-3 history retention (keep-last-N), RES-6 regression-cache sweep.
4. Re-measure the table above after a year of multi-user operation; the single-user rates here are the baseline.

---
---

# Ninth-Pass Review (2026-07-06): Dependency / Supply-Chain Audit

Audit of area #6 — the final area on the roadmap. Method: ran `pnpm audit` (full advisory review, not just the count), `pnpm -r outdated` across all workspaces, and inspected the pinning/lockfile/install-script posture (`package.json` manifests, `pnpm-workspace.yaml`, Dockerfile, hook chain, CI presence). No code changed.

**Headline:** the *structural* hygiene is genuinely good — one lockfile, no stray npm/yarn artifacts, no git/URL dependencies, a lean 34-direct-dependency tree, pinned `packageManager`, `--frozen-lockfile` in Docker, and pnpm 10's install-script allowlist blocking postinstall scripts for everything except three vetted native packages. What's missing is *cadence and automation*: the lockfile hasn't been refreshed since ~May, which is the entire reason **35 known vulnerabilities (2 critical, 13 high, 19 moderate, 1 low)** have accumulated — nearly all of them patched upstream within the semver ranges the manifests already allow — and there is no CI, no scheduled audit, and no automated update flow to prevent the same drift from recurring after publication.

## Findings

### DEP-1. 35 known vulnerabilities, most fixable by a single in-range update
Current advisory state (2026-07-06):

| Package (version) | Sev. | Reaches production? | Patched in | Notes |
|---|---|---|---|---|
| `fastify` 5.7.4 | **1 high**, 2 mod | **Yes — the HTTP server** | ≥5.8.5 | High: body schema validation bypass via leading space in Content-Type; moderates include `X-Forwarded-*` spoofing — directly relevant to the documented `TRUST_PROXY`/tunnel deployment |
| `@fastify/static` 9.0.0 | 2 mod | **Yes — serves `/gui/public`** | ≥9.1.1 | Path traversal in directory listing + route-guard bypass via encoded separators |
| `fast-uri` 3.1.0 (via `ajv`) | 2 high | Yes (manifest/schema validation) | ≥3.1.2 | Percent-encoding traversal/host confusion |
| `protobufjs` 7.5.4 (via `@google/genai`) | **1 critical**, 4 high, 5 mod | Yes — provider imports are **static**, so the tree loads in every install even with no Google key | ≥7.6.3 | Critical is arbitrary code execution in generated-code paths; practical exploitability here is low (client talks to Google's own API), but it's in the loaded tree |
| `ws` 8.19.0 (via `@google/genai`) | 1 high, 1 mod | Yes | ≥8.21.0 | DoS + memory disclosure |
| `yaml` 2.8.2 | 1 mod | Yes (config/data parsing) | ≥2.8.3 | Stack overflow on deeply nested collections |
| `brace-expansion`, `@protobufjs/utf8` | 4 mod | Yes (transitive) | patch bumps | DoS-class |
| `vitest` 3.2.4 | **1 critical** | Dev only (UI server) | ≥3.2.6 | Plus `vite` (3 high/2 mod), `picomatch` (1 high/1 mod), `postcss` (1 mod) — all dev-tree |
| `esbuild` 0.27.3 (via `tsx`) | 1 low | See DEP-5 | ≥0.28.1 | Dev-server-on-Windows scenario |

Nearly everything lands within existing caret ranges — **one `pnpm update -r` + full test run clears the bulk**, including both fastify GUI-surface issues and the vitest critical. The exception: protobufjs ≥7.6.3 requires `@google/genai` 2.x (current manifest allows 1.x) or a `pnpm.overrides` pin. The root cause is not policy but cadence — the lockfile has simply not been refreshed since the last dependency-touching phase.

### DEP-2. No CI exists — no automated tests, lint, audit, or anything else
`.github/workflows` does not exist. Every quality gate (tsc, Biome, the test suite) runs only in local git hooks, which forks and PR contributors won't have. Nothing anywhere runs `pnpm audit` — today's 35-advisory state was invisible until this pass. For a public repo this is the single highest-leverage gap: a fork PR gets zero checks, and the README's quality claims are unverifiable. **Fix:** one GitHub Actions workflow — install (frozen lockfile), build, lint, test, `pnpm audit --prod --audit-level=high` as a soft gate, plus the SEC-2 gitleaks job already queued. This closes SEC-2 and DEP-2 in the same file.

### DEP-3. No automated update flow and no fresh-package protection
No Renovate/Dependabot config, and pnpm's `minimumReleaseAge` is unset. Given the 2025–26 wave of npm account-takeover attacks (malicious versions typically caught within days of publish), `minimumReleaseAge` (e.g. 4–7 days) in `pnpm-workspace.yaml` is a one-line control that makes the update cadence from DEP-1's fix safe to automate. **Fix:** add `minimumReleaseAge`, then a Renovate config (grouped weekly PRs, majors separated) so the DEP-1 situation cannot silently recur.

### DEP-4. Major-version backlog — needs an upgrade ledger, not a blanket bump
Majors currently behind: `@anthropic-ai/sdk` 0.78 → 0.110 (**32 minor versions behind — notable for an LLM-centric product**: new model IDs, pricing metadata, and API features accrue there), `@google/genai` 1 → 2 (carries the protobufjs fix — do this one), `zod` 3 → 4 (core + food, real migration), `better-sqlite3` 11 → 12 (native module, Node-version coupling), `@fastify/view` 11 → 12, `emittery` 1 → 2, and the dev toolchain (`vitest` 3 → 4, `@biomejs/biome` 1.9 → 2.5, `typescript` 5 → 6 — each a config-migration session). None are urgent except as noted; the failure mode to avoid is doing them accidentally inside an unrelated `pnpm update`. **Fix:** record them (this table is the ledger), pin update automation to exclude majors, and schedule the Anthropic SDK + `@google/genai` bumps first.

### DEP-5. The dev/prod dependency boundary is blurred while tsx is the production runtime
`tsx` is a devDependency, but per INST-2 the only working non-Docker run mode is `pnpm dev` (tsx watch) — the current live deployment runs on it. Until INST-2 lands, dev-tree advisories (esbuild et al.) are effectively production advisories for native installs, and `pnpm install --prod` cannot produce a runnable native deployment. No action beyond what INST-2 already prescribes — recorded here so the audit trail explains why "dev-only" is not fully reassuring today. (Docker is unaffected: the image prunes to prod deps and runs compiled JS.)

## Verified strong (for the record)

**Install-script allowlist:** pnpm 10 blocks lifecycle scripts by default and `onlyBuiltDependencies` permits exactly three vetted native builds (`@biomejs/biome`, `better-sqlite3`, `esbuild`) — a strong default against install-time supply-chain attacks. **Lockfile hygiene:** single `pnpm-lock.yaml`, no stray `package-lock.json`/`yarn.lock`, Docker builds with `--frozen-lockfile`, `packageManager` pinned to an exact pnpm version with engines enforcement. **Tree discipline:** 34 unique direct dependencies across all six workspace manifests, no git/URL/file dependencies, no deprecated-registry sources. **Update mechanics:** caret ranges + committed lockfile is the right shape — the manifests already permit every non-major security fix identified above.

## Recommended sequencing

1. **Now (one session, pre-publication):** DEP-1 — `pnpm update -r`, bump `@google/genai` to 2.x (or add a protobufjs override), run the full suite, confirm `pnpm audit` is clean. This also de-risks the README the moment the repo is public.
2. **Pre-publication (pairs with SEC-2):** DEP-2 — GitHub Actions workflow with build/lint/test/audit + gitleaks.
3. **Same week:** DEP-3 — `minimumReleaseAge` + Renovate config so the drift never re-accumulates.
4. **Scheduled, not urgent:** DEP-4 ledger — Anthropic SDK and `@google/genai` majors first; toolchain majors as standalone sessions.
5. DEP-5 resolves itself when INST-2 lands.

---

**This completes the audit roadmap.** All six areas are done: security & trust boundary (pass 4), fresh-install reality (pass 5), privacy/data-flow (pass 6), backup/restore (pass 7), long-horizon resources (pass 8), and dependency/supply-chain (pass 9). Cross-cutting priority order for the fix work lives in `docs/open-items.md`; the single highest-leverage items surfaced by the whole audit series are INST-1 (fresh-install boot crash), SEC-1 (PII scrub + history decision), DEP-1/DEP-2 (update + CI), and BKP-1 (enable backups in production).
