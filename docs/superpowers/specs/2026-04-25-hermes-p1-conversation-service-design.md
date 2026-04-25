# Hermes P1 — Conversation Service Design

**Date:** 2026-04-25  
**Status:** Approved — implementation in progress (Chunk A started)  
**Plan:** `C:\Users\matth\.claude\plans\i-d-like-to-start-keen-liskov.md`

## Problem Statement

`apps/chatbot/src/index.ts` (1432 LOC) acts as infrastructure, not an app:
- The router hard-codes a fallback reference to it in `compose-runtime.ts` (lines 545-548, 803-810, 844-898)
- Its data access is locked to `data/users/<id>/chatbot/`, making it data-blind
- The app/infrastructure boundary is a lie that prevents ConversationService from being a first-class core service

## Architectural Decision

Extract all helpers from `apps/chatbot/src/index.ts` into `core/src/services/conversation/` with explicit dependency injection (no module-scoped `services` closure). The chatbot app becomes a thin shim in Chunk A, then is retired entirely in Chunk D.

## Service Layout

```
core/src/services/conversation/
├── index.ts               — ConversationService class + DI options (Chunk B)
├── handle-message.ts      — Free-text dispatch (lines 215-317 of chatbot)
├── handle-ask.ts          — /ask handler (lines 418-532)
├── handle-edit.ts         — /edit handler (lines 323-406)
├── handle-notes.ts        — NEW /notes command (Chunk C)
├── prompt-builder.ts      — buildAppAwareSystemPrompt, buildSystemPrompt (lines 538-692)
├── system-data.ts         — categorizeQuestion, gatherSystemData, formatUptime, CATEGORY_KEYWORDS (lines 138-209, 698-896)
├── data-query-context.ts  — formatDataQueryContext, formatInteractionContextSummary, extractRecentFilePaths (lines 914-1004)
├── pas-classifier.ts      — classifyPASMessage, isPasRelevant, PAS_KEYWORDS, PASClassification (lines 81-136, 1009-1217)
├── user-context.ts        — buildUserContext (lines 1088-1107)
├── telegram-format.ts     — splitTelegramMessage, stripMarkdown, sendSplitResponse (lines 1120-1188)
├── control-tags.ts        — processModelSwitchTags, SWITCH_MODEL_TAG_REGEX (lines 76-82, 1229-1301)
├── daily-notes.ts         — appendDailyNote, toDateString, formatTime (lines 1365-1418)
├── app-data.ts            — getEnabledAppInfos, searchKnowledge, formatAppMetadata, gatherContext (lines 1316-1400)
├── auto-detect.ts         — getAutoDetectSetting (lines 1304-1313)
├── pending-edits.ts       — pendingEdits Map singleton (line 51)
├── manifest.ts            — CONVERSATION_USER_CONFIG, CONVERSATION_LLM_SAFEGUARDS, CONVERSATION_DATA_SCOPES
├── settings-resolver.ts   — resolveUserBool, coerceUserConfigValue (Chunk C)
└── __tests__/             — Tests for each module
```

## Key Design Decisions

### DI Contract
Every helper function receives its dependencies as explicit parameters. No function closes over a module-level `services` variable. This enables unit testing without importing the full service graph.

```ts
// Before (module-scoped closure)
export async function appendDailyNote(ctx: MessageContext) {
  const store = services.data.forUser(ctx.userId);  // implicit dep
}

// After (explicit DI)
export async function appendDailyNote(
  ctx: MessageContext,
  deps: { data: DataService; logger: Logger; timezone: string }
) {
  const store = deps.data.forUser(ctx.userId);
}
```

### Command Contract
`AppModule.handleCommand` receives the command name **without** a leading slash. The router strips `/` at `core/src/services/router/index.ts:511`. The chatbot currently compares `command === '/edit'` — this is normalized to `command === 'edit'` in Chunk A.

### Chatbot Shim (Chunk A)
`apps/chatbot/src/index.ts` shrinks to ~250 LOC: a thin module that captures `services` in `init()` and threads them through to the imported helpers.

### Module-Scoped `pendingEdits` Map
The pending edit proposals Map is moved to `core/src/services/conversation/pending-edits.ts` as an exported singleton. All callers import from the same module path, preserving the single-Map-instance invariant.

### Data Scopes (Chunk B)
`CONVERSATION_DATA_SCOPES` in `manifest.ts` declares `history.json` and `daily-notes/` as core-owned scopes. This is required before Chunk D deletes the chatbot manifest, or `DataStoreServiceImpl` will reject reads.

### `CoreServices.conversation` — NOT added
`ConversationService` is router-private. Apps that need conversational capabilities already have `llm`, `telegram`, `appMetadata`. Adding `conversation` to `CoreServices` would require apps to declare it as a service, expanding the attack surface without a concrete need.

## Chunks

| Chunk | Goal | Risk |
|---|---|---|
| A | Extract helpers + command contract normalization | Low — refactor only, chatbot still wired |
| B | Dispatch to ConversationService directly; remove notes-mode routing | Medium-high — router rewiring |
| C | /ask, /edit, /notes as built-ins; daily-notes opt-in toggle | Medium — new behavior |
| D | Delete apps/chatbot/; virtual registry entry | Low — cleanup |

## URS Entries

| ID | Requirement |
|---|---|
| REQ-CONV-001 | Conversation helper modules in `core/src/services/conversation/` use explicit DI |
| REQ-CONV-002 | `pendingEdits` map in `core/src/services/conversation/pending-edits.ts`; semantics preserved |
| REQ-CONV-003 | `ConversationService` class orchestrates free-text dispatch (Chunk B) |
| REQ-CONV-004 | Router dispatches free text to ConversationService (Chunk B) |
| REQ-CONV-005 | `requestContext.run({ userId, householdId })` at every router → ConversationService boundary (Chunk B) |
| REQ-CONV-006 | `/ask`, `/edit`, `/notes` are core built-in router commands (Chunk C) |
| REQ-CONV-007 | Daily-note logging is per-user opt-in, default OFF (Chunk C) |
| REQ-CONV-008 | Three-way toggle: slash command, GUI, `<config-set>` tag (Chunk C) |
| REQ-CONV-009 | `<config-set>` LLM tag with allowlist + intent-regex (Chunk C) |
| REQ-CONV-010 | `chat.log_to_notes` is a NEW config key; legacy `fallback` key logs startup warning (Chunk C) |
| REQ-CONV-011 | `'chatbot'` removed from `PROTECTED_APPS` (Chunk D) |
| REQ-CONV-012 | `apps/chatbot/` deleted; registry no longer loads real chatbot app (Chunk D) |
| REQ-CONV-013 | Virtual `'chatbot'` registry entry preserves GUI config GET/POST (Chunk D) |
| REQ-CONV-014 | ConversationService LLM access wrapped by LLMGuard with chatbot manifest's prior values (Chunk B) |
| REQ-CONV-015 | `data/users/<id>/chatbot/history.json` path stable across migration (Chunk B) |
| REQ-CONV-016 | `/help` lists conversation commands once (Chunk C) |
| REQ-CONV-017 | `AppModule.handleCommand` receives command without leading slash; chatbot normalized |
| REQ-CONV-018 | Legacy `defaults.fallback` key produces startup warning (Chunk B) |
| REQ-CONV-019 | Shared `coerceUserConfigValue` used by GUI POST and `<config-set>` (Chunk C) |
| REQ-CONV-020 | LLM-error response copy conditional on whether `appendDailyNote` actually wrote (Chunk C) |
| REQ-CONV-021 | Deprecated `fallback` field removed from `SystemConfig` type (Chunk D) |

## Security Considerations

- `<config-set>` tag: allowlist + intent-regex + per-user-only scope prevent injection attacks (Chunk C)
- `sendSplitResponse` must not introduce Telegram MarkdownV2 injection via user content
- `processModelSwitchTags`: admin gate + intent regex prevent model switching by non-admins or stray LLM output

## Deferred to P2–P5

- `ConversationRetrievalService` (FTS5 search over conversation history)
- Session persistence and memory snapshot
- `CoreServices.conversation` field for apps that legitimately need it
- Per-space ConversationService dispatch
