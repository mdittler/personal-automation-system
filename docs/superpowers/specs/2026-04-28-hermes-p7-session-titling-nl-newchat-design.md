# Hermes P7 — Session Auto-Titling + Natural-Language /newchat

**Date:** 2026-04-28  
**Status:** Approved for implementation  
**Phase:** Hermes P7  
**Builds on:** P3 (ChatSessionStore, /newchat built-in), P4 (memory snapshot / prefix-cache invariant), P5 (SQLite transcript index)

---

## Context

Sessions created by Hermes P3 all carry `title: null` in their frontmatter. With P5's FTS5 search index operational, sessions are now queryable — but untitled sessions show as blank in any recall or future session-list UI. Additionally, the P3 `/newchat` command was intentionally limited to exact-match dispatch: natural phrasings like "start over", "wipe the slate", or "begin again" fall through to the chatbot instead of ending the session.

P7 closes both gaps with three tightly scoped features:

1. **Session auto-titling** — fast-tier LLM generates a 3–7 word title after the first exchange, fire-and-forget.
2. **Manual `/title` override** — user can read or set the active session title at any time.
3. **Natural-language /newchat** — keyword-gated pre-filter + fast-tier LLM classifier intercepts reset-intent phrasings before the normal intent classifier, with high-confidence auto-dispatch and grey-zone inline-button confirmation.

Critical invariant carried forward from P4: **REQ-CONV-MEMORY-012** — Layer 1+2 of the system prompt must remain byte-stable for prefix caching. P7 writes only to the `title` field in session frontmatter (semantic preservation: all other decoded fields and transcript turns are unchanged). No P7 code path touches `memory_snapshot`, `started_at`, `model`, `token_counts`, or turns. Tests must compare decoded metadata and turns, not raw file bytes, since YAML re-encoding does not guarantee byte-for-byte identical output.

---

## Architecture & Data Flow

### Auto-titling (Chunk A)

Current `handle-message.ts` ordering: `telegram.send` → `appendExchange`. The auto-title hook fires after `appendExchange` succeeds to guarantee the transcript exists. Latency impact is zero because the Telegram reply has already been sent.

```
handle-message.ts
  ├─ ensureActiveSession → { sessionId, isNew }
  ├─ loadRecentTurns    → turns (length === 0 when isNew on first exchange)
  ├─ build prompt → LLM → assistantText
  ├─ telegram.send(assistantText)              ← reply sent first (preserves zero latency)
  ├─ appendExchange(userTurn, assistantTurn)   ← transcript persisted here
  └─ if (isNew && turns.length === 0):
       void titleAfterFirstExchange({          ← unawaited, after appendExchange
           userId, householdId, sessionKey, sessionId,   ← explicit, no ALS
           userContent, assistantContent, deps
       })
```

`titleAfterFirstExchange` orchestrator (in `conversation-titling/auto-title-hook.ts`):
```
generateTitle(turns, deps.llm)   → string | null
  └─ on null or error: return (title stays null)
TitleService.applyTitle(userId, sessionId, title, { skipIfTitled: true })
  ├─ chatSessions.setTitle(userId, sessionId, ...)  → frontmatter update (title field only)
  └─ chatTranscriptIndex.updateTitle(...)           → SQLite row update
```

All errors caught and logged as warn; never propagated to caller.

### Manual /title (Chunk A)

```
Router: parsed.command === '/title'
  → dispatchConversationCommand('title', args, ctx)
  → conversation-service.handleTitle(args, ctx)
      ├─ no active session → telegram.send('No active conversation yet.')
      ├─ no args → telegram.send(`Current title: ${title ?? '(none)'}`)
      └─ with args → TitleService.applyTitle(userId, sessionId, argsJoined, { skipIfTitled: false })
                     + telegram.send('Title updated.')
```

### Natural-language /newchat (Chunk B)

Insertion point in `routeMessage`: **between wizard intercept and parsed-command match**, free-text only (`parsed === null`).

```
routeMessage (free text path)
  1. sessionControlPreFilter(text)
       ├─ requires ≥1 keyword from reset vocabulary (word-boundary for single words;
       │   literal substring for multi-word phrases)
       ├─ min length 4 chars, no slash prefix, must contain alphabetic chars
       └─ skip: fall through to normal routing
  2. classifySessionControlIntent(text, { llm, logger })
       → { intent: 'newchat' | 'none', confidence: number }
       fail modes → { intent: 'none', confidence: 0 } (fall-through)
  3. confidence ≥ 0.85  → dispatchNewChat(ctx); return
  4. 0.60 ≤ conf < 0.85 → sendInlineConfirmation(ctx); return
                            (store pending state: userId, sessionKey, msgId, expiresAt, callbackId)
  5. confidence < 0.60  → fall through to IntentClassifier
```

**Grey-zone confirmation:**
- Buttons: "Start new chat" | "Keep current chat"
- Callback data format: `sc:<id>:start` / `sc:<id>:keep` so handlers can parse action from callback data without a store lookup for the action type
- TTL: 60 seconds. After expiry, `answerCallbackQuery` is still called (to stop the Telegram spinner), plus a chat reply: "That session control prompt has expired. Type /newchat to start a new chat."
- Wrong-user callback: call `answerCallbackQuery` (stops spinner) but send no chat message
- "Start new chat" → call `conversationService.handleNewChat([], ctx)` within `requestContext.run(...)` (since `dispatchConversationCommand` is private to Router; compose-runtime wires this at startup)
- "Keep current chat" → `answerCallbackQuery` + reply "OK, keeping your current conversation." (no re-dispatch)
- After confirm or cancel: edit the original message to remove the inline keyboard buttons (needs message ID stored in pending state)
- Pending state lives in `PendingSessionControlStore` (purpose-built in-memory TTL map, not `PendingVerificationStore`)

---

## Component & File Map

### New files

| File | Purpose |
|---|---|
| `core/src/services/conversation-titling/title-generator.ts` | `generateTitle(turns, deps): Promise<string \| null>` — fenced LLM call, sanitized output |
| `core/src/services/conversation-titling/title-service.ts` | `TitleService` — `applyTitle(userId, sessionId, title, opts)` wrapping setTitle + updateTitle |
| `core/src/services/conversation-titling/auto-title-hook.ts` | `titleAfterFirstExchange(params)` — fire-and-forget orchestrator, explicit params, no ALS |
| `core/src/services/conversation-titling/index.ts` | Barrel export |
| `core/src/services/conversation-retrieval/session-control-classifier.ts` | `sessionControlPreFilter` + `classifySessionControlIntent` |
| `core/src/services/conversation-retrieval/pending-session-control-store.ts` | In-memory TTL map with injectable clock + rng for grey-zone pending state |

### Modified files

| File | Change | Chunk |
|---|---|---|
| `core/src/services/conversation-session/chat-session-store.ts` | Add `setTitle` to interface and impl; extend all test mocks | A |
| `core/src/services/conversation/conversation-service.ts` | Add `handleTitle(args, ctx)` | A |
| `core/src/services/conversation/handle-message.ts` | Schedule auto-title hook after `appendExchange`; explicit params; no ALS | A |
| `core/src/services/chat-transcript-index/*` | Add `updateTitle(userId, sessionId, title): Promise<{ updated: boolean }>` | A |
| `core/src/services/router/index.ts` | Add `/title` to `handleCommand` + `BUILTIN_COMMAND_NAMES` + help text + dispatch union. Insert NL /newchat hook (Chunk B). | A+B |
| `core/src/compose-runtime.ts` | Construct + inject TitleService (Chunk A). Register NL /newchat grey-zone callback handler (Chunk B). | A+B |
| `docs/urs.md` | REQ-CONV-TITLE-001..008, REQ-CONV-NEWCHAT-001..008 | A+B |
| `docs/USER_GUIDE.md` | Document `/title` command (if file exists) | A |
| `core/docs/help/commands-and-routing.md` | Document `/title` + NL /newchat (if file exists) | A+B |
| `docs/implementation-phases.md` | Add Hermes P7 row | end |
| `docs/open-items.md` | Close P7 line; carry-forward already added | end |
| `CLAUDE.md` | P7 status update | end |

---

## Detailed Contracts

### `generateTitle`

**Input:** first user turn content + first assistant turn content (both treated as untrusted).

**Prompt approach:**
- System prompt instructs: return JSON `{"title": "..."}`, 3–7 words, plain words only, no quotes, no Markdown, no pronouns, present tense, or `{"title": null}` if unable to summarize.
- Turns fenced inside `<conversation>` tags, with `<`, `>`, and control chars stripped before insertion.
- LLM tier: `fast`. `temperature: 0`. `maxTokens: 60`.

**Output sanitization:** strip backticks, `#`, `*`, `_`, `>`, control chars; single-line; trim; truncate to 80 chars. Reject if: empty after sanitization, all punctuation, contains `{` or `}`, contains only digits, matches UUID/ID pattern. Return `null` on rejection — no heuristic fallback by design.

### `ChatSessionStore.setTitle`

Signature: `setTitle(userId: string, sessionId: string, title: string, opts?: { skipIfTitled?: boolean }): Promise<{ updated: boolean }>`

Uses `withFileLock('conversation-session-transcript:${userId}:${sessionId}', ...)` — same lock as `appendExchange` and `endActive`.

| State | Behavior |
|---|---|
| Session file missing | `{ updated: false }` + log warn |
| Corrupt YAML frontmatter | `{ updated: false }` + log warn |
| `skipIfTitled: true` + non-null existing title | `{ updated: false }` (no write) |
| Empty / whitespace-only title | `{ updated: false }` (reject) |
| Title > 80 chars | Truncate to 80 chars, then write |
| Title with newlines / control chars | Strip to single line, trim, then write |
| Normal write | Updates `title` field only; all other decoded frontmatter fields and turns preserved |

### `chatTranscriptIndex.updateTitle`

Signature: `updateTitle(userId: string, sessionId: string, title: string): Promise<{ updated: boolean }>`

SQL: `UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?`. Returns `{ updated: false }` if row not found (no throw, no logging — caller logs).

### `TitleService.applyTitle`

Signature: `applyTitle(userId: string, sessionId: string, title: string, opts?: { skipIfTitled?: boolean }): Promise<void>`

Calls `setTitle` then `updateTitle`. If `setTitle` returns `{ updated: false }`, skips `updateTitle`. If `updateTitle` returns `{ updated: false }`, logs warn (TitleService owns the logging for this step, not updateTitle). Errors from either step caught, logged as warn, not propagated.

### `classifySessionControlIntent`

**Input:** free-text message (already passed keyword pre-filter).

**Output:** `{ intent: 'newchat' | 'none', confidence: number }` — safe default `{ intent: 'none', confidence: 0 }` on any failure (LLM error, JSON parse error, missing fields).

**Prompt:** system instructs — return JSON `{"intent": "newchat"|"none", "confidence": 0.0–1.0}`. Intent is "newchat" only when the user clearly wants to end the current conversation and start fresh, not just change topic or use a reset-vocabulary word in another context.

LLM tier: `fast`. `temperature: 0`. `maxTokens: 80`.

**Thresholds:**
- `confidence ≥ 0.85` → auto-dispatch (high)
- `0.60 ≤ confidence < 0.85` → grey-zone confirmation
- `confidence < 0.60` → fall-through

### `sessionControlPreFilter`

**Reset vocabulary:**

Multi-word phrases (literal substring match on lowercased message):
`start over`, `new chat`, `new conversation`, `new session`, `clear history`, `begin again`, `fresh start`, `clean slate`, `forget this`, `forget context`, `forget our conversation`

Single words (word-boundary match, e.g. `\breset\b`, to avoid `preset`, `restart`):
`reset`, `restart`, `wipe`, `erase`

**Skip conditions:**
- Starts with `/`
- Length < 4 chars
- No alphabetic characters
- No vocabulary entry matches

**Test cases:**

| Input | Pre-filter result | Reason |
|---|---|---|
| `"let's start over"` | proceed | `start over` phrase match |
| `"wipe the slate"` | proceed | `wipe` word-boundary match |
| `"start a new meal plan"` | skip | no phrase/word match (`start over` not present; `new` alone not a keyword) |
| `"new chat model"` | proceed | `new chat` phrase match → LLM decides intent is 'none' |
| `"let's begin the recipe"` | skip | no match |
| `"let's begin again with the grocery list"` | proceed | `begin again` phrase match → LLM returns low confidence |
| `"don't forget milk"` | skip | `forget` alone not in vocabulary; only `forget this` / `forget context` / `forget our conversation` |
| `"let's chat about dinner"` | skip | no match |
| `"preset my alarm"` | skip | `reset` word-boundary check rejects substring-only match |

### `PendingSessionControlStore`

Injectable clock and rng for testability (avoids real 61-second tests, deterministic callback IDs in unit tests).

```typescript
interface PendingSessionControl {
    userId: string;
    sessionKey: string;
    messageId: number;   // Telegram message ID to edit buttons away after action
    expiresAt: number;   // clock.now() + 60_000
}

// Callback data format:
// confirm → "sc:<callbackId>:start"
// cancel  → "sc:<callbackId>:keep"
```

In-memory `Map<callbackId, PendingSessionControl>`. Entries swept lazily on read. Not persisted (process restart clears all pending state — acceptable since TTL is 60s).

`originalMessage` is not stored (cancelled path sends generic reply without replaying the user's message).

---

## URS Requirements

### REQ-CONV-TITLE-001..008

| ID | Requirement |
|---|---|
| REQ-CONV-TITLE-001 | Auto-title fires after the first user+assistant exchange via fire-and-forget; zero latency added to the chat reply. |
| REQ-CONV-TITLE-002 | Auto-title is scheduled only after `appendExchange` succeeds; it never runs before transcript persistence. |
| REQ-CONV-TITLE-003 | Auto-title uses a fast-tier LLM call with untrusted content fenced and sanitized; `temperature: 0`. |
| REQ-CONV-TITLE-004 | Generated titles are 3–7 words, plain text, no Markdown or control chars, max 80 chars; null on LLM failure or sanitization rejection. |
| REQ-CONV-TITLE-005 | `setTitle(skipIfTitled: true)` is a no-op if `title` is already non-null; manual `/title` always uses `skipIfTitled: false`. |
| REQ-CONV-TITLE-006 | `/title <text>` sets the active session title; `/title` (no args) replies with the current title or "(none)"; both reply "No active conversation yet." when no session is active. |
| REQ-CONV-TITLE-007 | All title writes change only the `title` field; all other decoded frontmatter fields and transcript turns are semantically preserved (REQ-CONV-MEMORY-012 maintained). |
| REQ-CONV-TITLE-008 | The chat-transcript-index SQLite row is updated with the new title on every successful `setTitle`; index-update failures are logged by TitleService and not propagated. |

### REQ-CONV-NEWCHAT-001..008

| ID | Requirement |
|---|---|
| REQ-CONV-NEWCHAT-001 | The NL /newchat classifier runs only on free text; slash commands bypass it entirely. |
| REQ-CONV-NEWCHAT-002 | A vocabulary pre-filter gates the LLM call; single-word entries use word-boundary matching; multi-word entries use literal phrase substring matching. Messages with no match never trigger an LLM call. |
| REQ-CONV-NEWCHAT-003 | The classifier calls a fast-tier LLM returning JSON `{ intent, confidence }`; any failure produces safe-default `{ intent: 'none', confidence: 0 }`. |
| REQ-CONV-NEWCHAT-004 | `confidence ≥ 0.85` dispatches `handleNewChat` immediately. |
| REQ-CONV-NEWCHAT-005 | `0.60 ≤ confidence < 0.85` sends an inline Telegram confirmation with "Start new chat" and "Keep current chat" buttons. |
| REQ-CONV-NEWCHAT-006 | `confidence < 0.60` falls through to the normal intent classifier without sending any response. |
| REQ-CONV-NEWCHAT-007 | Grey-zone pending state has a 60-second TTL; `answerCallbackQuery` is always called on callback (stops spinner); expired and wrong-user callbacks send no chat message. Buttons are removed from the original message after any action. |
| REQ-CONV-NEWCHAT-008 | The classifier insertion point is before `IntentClassifier.classify`; it never prevents slash-command, photo, or other existing routing. |

---

## Implementation Chunks

### Chunk A — Auto-titling + manual /title
1. `title-generator.ts` — LLM call, fencing, sanitization, edge cases
2. `title-service.ts` — `TitleService.applyTitle`
3. `auto-title-hook.ts` — fire-and-forget orchestrator (explicit params, no ALS)
4. `ChatSessionStore.setTitle` — frontmatter-only, all edge cases + mock updates
5. `chatTranscriptIndex.updateTitle` — SQLite update (no logger; caller logs)
6. `handle-message.ts` — schedule hook after `appendExchange`, when `isNew && turns.length === 0`
7. `conversation-service.ts` — `handleTitle` (incl. no-active-session path)
8. `router/index.ts` — `/title` in `handleCommand`, `BUILTIN_COMMAND_NAMES`, help text, dispatch union (incl. `/title@BotName` suffix handling, consistent with `/ask`/`/notes`)
9. `compose-runtime.ts` — construct and inject TitleService
10. URS REQ-CONV-TITLE-001..008
11. Tests: unit (all `setTitle` edge cases + race condition + /title@PASBot suffix) + persona (end-to-end auto-title + manual override)

### Chunk B — Natural-language /newchat
1. `session-control-classifier.ts` — pre-filter (word-boundary single / phrase multi) + LLM classifier
2. `pending-session-control-store.ts` — TTL map with injectable clock + rng
3. `router/index.ts` — NL /newchat hook insertion
4. `compose-runtime.ts` — grey-zone callback registration; wire `conversationService.handleNewChat` under `requestContext.run` (avoids private `dispatchConversationCommand`)
5. URS REQ-CONV-NEWCHAT-001..008
6. Tests: unit (pre-filter vocabulary table + word-boundary + negative cases, classifier fail-closed, TTL expiry, wrong-user `answerCallbackQuery`) + persona (above-threshold dispatch, grey-zone confirm/cancel, expiry message)

---

## Verification

End-to-end test pass: `pnpm test` — zero failures.

Manual smoke test (dev mode):
1. Send first message → wait 1–2s → check transcript file: `title:` field non-null
2. `/title` → replies with current title
3. `/title My Custom Title` → overrides; send another message to verify auto-title does not overwrite
4. Type "let's start over" → high-confidence dispatch → "Started a new conversation."
5. Type "begin a new meal plan" → no session-control intercept; routes normally to food handler
6. Type "wipe the slate" → grey-zone → buttons shown → confirm → session ended; or cancel → "OK, keeping your current conversation."
7. Grey-zone: wait 61s, click button → "That session control prompt has expired."
8. Verify buttons removed from message after confirm/cancel

Index-drift check after each title-writing step:
```bash
# Check title column directly in SQLite
sqlite3 data/system/chat-state.db "SELECT id, title FROM sessions WHERE user_id = '<userId>' ORDER BY started_at DESC LIMIT 5;"
```

---

## Carry-forward (deferred from original P7 UX bucket)

The following items from the original P7 spec (`docs/hermes-agent-adoption-review.md` L363–369) are deferred and tracked in `docs/open-items.md` as "Hermes P7 carry-forward — UX polish bucket":

- Streaming responses (Telegram edit-message, `StreamingConfig`)
- Typing indicator during LLM calls
- UTF-16-aware message truncation
- Clarify tool with structured choice schema
