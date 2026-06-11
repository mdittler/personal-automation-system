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
