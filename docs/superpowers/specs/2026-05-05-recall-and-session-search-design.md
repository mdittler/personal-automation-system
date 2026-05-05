# Recall Command + Session-Search Pseudo-Tool Design

**Date:** 2026-05-05  
**Phase:** Hermes P5 Carry-Forwards  
**Status:** Implemented

---

## Context

Hermes P5 (2026-04-28) shipped SQLite + FTS5 transcript search with a recall classifier that auto-injects matching past sessions into Layer 5 of the system prompt (`<memory-context label="recalled-session">`). Two carry-forwards were tracked in `docs/open-items.md`:

1. **LLM-visible session_search tool** — let the model decide when to search past transcripts, instead of the host running a classifier and injecting results unconditionally.
2. **`/recall <query>` slash command** — a user-facing command for explicit, on-demand transcript search.

Both ship together in this phase. They are independent but share testing, URS, and docs surface.

---

## Architecture

```
┌─────────────────┐
│ Telegram msg    │
└────────┬────────┘
         ↓
┌─────────────────────────┐
│ Router.routeMessage     │
│  - parseCommand (trims) │
│  - if /recall → ─────┐  │
│    dispatch('recall') │  │
└──────┬────────────────┘  │
       │                    ↓
       │    ┌──────────────────────────┐
       │    │ handleRecall             │
       │    │  1. join args → query    │
       │    │  2. buildUntrustedQuery  │
       │    │  3. searchSessions       │
       │    │     (no excludeSessionIds│
       │    │      — user intent)      │
       │    │  4. formatRecallReply    │
       │    │  5. sendSplitResponse    │
       │    └──────────────────────────┘
       │
       └─→ if free text or /ask:
             ┌──────────────────────────────────────────────┐
             │ handle-message.ts / handle-ask.ts            │
             │  1. runRecallPipeline (Layer 5 auto-inject)  │
             │  2. build system prompt                       │
             │  3. if intent regex matches AND tool enabled │
             │     → append SESSION_SEARCH_INSTRUCTION_BLOCK│
             │  4. LLM call #1                               │
             │  5. extractSessionSearchTag(response):        │
             │       │                                       │
             │       ├─ no tag → strip any shape, continue  │
             │       │                                       │
             │       └─ tag present:                         │
             │         a. searchSessions (excludes current)  │
             │         b. buildToolContinuationPrompt        │
             │         c. LLM call #2                         │
             │         d. stripSessionSearchTags (cap)        │
             │  6. existing post-processors                  │
             │     (journal / switch-model / config-set)    │
             │  7. sendSplitResponse                         │
             └──────────────────────────────────────────────┘
```

**Key invariant:** `stripSessionSearchTags(text)` is applied at every exit point. No raw `<session-search…>` ever reaches `sendSplitResponse`.

---

## Design Decisions

### 1. Tag-based pseudo-tool rather than native tool calling

`LLMService.complete` returns `Promise<string>` (text-in/text-out). There is no native tool-call infrastructure today. A tag-based approach delivers value now without blocking on a multi-phase infra refactor.

**Limitations inherited until LLM Enhancement #8 ships:**
- Tag escape edge cases when user/transcript content contains literal `<session-search>` text
- Reliability ceiling — every model upgrade requires re-validating tag adherence
- No parallel tool calls
- Freeform attribute parsing vs. JSON-schema validation
- Prompt-section bloat as more tools accumulate
- Token waste from "I'll search for that" prose preceding the tag

A future phase (LLM Enhancement #8) will migrate to native tool calling — most likely via Vercel AI SDK — and convert existing tag patterns at that time.

### 2. Full 23-char session id displayed in `/recall` output

The full `YYYYMMDD_HHMMSS_<8hex>` format is shown to users (not just the 8-hex suffix). Rationale: the full id is the canonical identifier (per `SESSION_ID_RE`); the 8-hex alone is ambiguous across dates. It's also how ids appear elsewhere in the system (transcript frontmatter, SQLite index).

### 3. FTS5 highlights: strip, don't render

FTS5 `snippet()` wraps matched terms in `[` / `]` markers. These could collide with Telegram Markdown or user-typed content.

**Decision:** Strip term-aware — for each `queryTerm`, replace `[<term>]` (case-insensitive) with `<term>`. Leave other brackets untouched. This preserves user-typed `[not a highlight]` because "not a highlight" is not a query term. No blanket `[` / `]` stripping.

### 4. Current-session asymmetry between `/recall` and pseudo-tool

- **`/recall`** — does NOT pass `excludeSessionIds`. The user is explicitly searching; including the current session is correct.
- **`<session-search>` pseudo-tool** — passes `excludeSessionIds: [ensuredSessionId]`. The model is searching mid-conversation; the current session would bias results toward content the model already has in context.

Both behaviors are documented in the URS (REQ-CONV-RECALL-009 and REQ-CONV-TOOL-SEARCH-005).

### 5. Single re-prompt per turn (recursion cap)

If the second LLM response emits another `<session-search>` tag, `stripSessionSearchTags` removes it. The tag is never re-parsed. This is a hard cap — no recursive search loops.

### 6. Tool runs before existing post-processors

The re-prompt driver runs after the first LLM call's error-handling block and before `extractJournalEntries`, `processModelSwitchTags`, and `processConfigSetTags`. This means:
- Journal/switch-model/config-set tags in the **second** response are processed correctly.
- Tags in the first partial response are discarded when the second response replaces it.

### 7. Auto-injection is additive; not replaced

`runRecallPipeline` continues to run before the first LLM call and injects Layer 5 fenced results when its classifier returns `shouldRecall: true`. The `<session-search>` tool is an additional path. When both fire on the same turn, the model has auto-injected results in the system prompt and can additionally query for more specific terms.

---

## File Map

### New files

| File | Purpose |
|------|---------|
| `core/src/services/conversation/handle-recall.ts` | `/recall` command handler |
| `core/src/services/conversation/prompt-assembly/recall-reply.ts` | Hit formatting for `/recall` |
| `core/src/services/conversation/control-tags/session-search-instruction.ts` | Instruction block constants + intent regexes |
| `core/src/services/conversation/control-tags/session-search-tag.ts` | Tag parser + stripper |
| `core/src/services/conversation/prompt-assembly/tool-continuation-prompt.ts` | Continuation prompt builder |

### Modified files

| File | Change |
|------|--------|
| `core/src/services/router/index.ts` | `/recall` dispatch, `BUILTIN_COMMAND_NAMES`, help text |
| `core/src/services/conversation/conversation-service.ts` | `handleRecall` method |
| `core/src/services/conversation/handle-message.ts` | Instruction block injection + re-prompt driver |
| `core/src/services/conversation/handle-ask.ts` | Same changes |
| `core/src/services/conversation/manifest.ts` | `session_search_tool_enabled` config key |
| `core/src/services/conversation/control-tags.ts` | `ALLOWED_CONFIG_KEYS`, `INTENT_GATES`, `confirmationFor` extension |

---

## URS Coverage

- REQ-CONV-RECALL-001..009 — `/recall` command
- REQ-CONV-TOOL-SEARCH-001..012 — `<session-search>` pseudo-tool

See `docs/urs.md` Track C for full requirement text and test traceability.

---

## Open Carry-Forwards

These remain in `docs/open-items.md`:

- Cross-user household search (still deferred)
- Temporal precision in recall classifier ("last Tuesday")
- FTS5 snippet window/marker tuning
- LLM Enhancement #8 — native tool-call infrastructure (the strategic migration away from tag-based patterns)
