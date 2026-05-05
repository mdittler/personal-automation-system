# Hermes P6.next — NL Temporal Precision Broadening + Mid-Session Snapshot Rebuild

| Field | Value |
|-------|-------|
| **Phase ID** | Hermes P6.next |
| **Plan** | `C:\Users\matth\.claude\plans\idempotent-munching-canyon.md` |
| **Status** | In progress |
| **Date** | 2026-05-05 |

---

## Context

Hermes P6 (2026-05-05) shipped typed memory (`ContextEntryKind` enum, `.kinds.yaml` sidecar, `<memory-kind-set>` tag) and structured temporal recall (`TimeAnchor` discriminated union, `parseRecallVerdict`, `localDayToUtcRange` DST-correct UTC range, `<session-search>` temporal attrs). Two carry-forwards remain:

1. **`docs/open-items.md` line 18** — NL temporal precision: The recall classifier prompt has 3 dynamic NL examples. Real users say a much wider variety of things ("last Friday", "earlier this month", "the day before yesterday", "in May", "a couple weeks ago"). No prompt coverage on this surface; the classifier must guess.

2. **`docs/open-items.md` line 104** — Mid-session snapshot rebuild: `MemorySnapshot` is frozen at session-mint by `ensureActiveSession`. When a user adjusts a preference mid-session via `<memory-kind-set>` or direct ContextStore writes, the change does not take effect until next session. No UX surface for refreshing the active snapshot in place.

This phase closes both items in two independently-shippable chunks.

---

## Architecture

### Track A — NL Temporal Precision (prompt-only)

```
 chat user message ──▶ recall classifier (P6)  ◀── extend buildExamples
                       buildClassifierPrompt()       (prompt-only; LLM
                       └── <phrasing reference>       authority unchanged)
                           block (10+ NL forms
                           with computed dates)
                                   │
                                   ▼
                           TimeAnchor (a/w/null)
                                   │
                                   ▼
                         timeAnchorToFilters
                                   │
                                   ▼
                             FTS5 search
```

The classifier LLM is the sole authority for interpreting NL phrases into `TimeAnchor` values. The `<phrasing reference>` block is an instructional aide — it computes concrete example dates from `today` so the LLM can ground relative phrases. No deterministic backstop is added.

### Track B — Mid-Session Snapshot Rebuild

```
 /refreshmemory ──▶ Router built-in dispatch
                    (mirrors /recall, /title)
                           │
                           ▼
                    handleRefreshMemory
                     - reuse buildSnapshot
                       callback from handle-msg
                     - pass expectedSessionId
                     - send to ctx.userId
                           │
                           ▼
                    ChatSessionStore
                     rebuildMemorySnapshot()
                      1. index lock + CAS read
                      2. release index lock
                      3. buildSnapshot() (outside locks)
                      4. transcript lock
                      5. RE-READ index, CAS recheck
                      6. always-persist write
```

---

## Design Decisions

### 1. Classifier remains LLM-authority; prompt-only expansion

No deterministic backstop is added. The classifier prompt is expanded with a `<phrasing reference>` block listing ≥10 NL relative-date forms with computed example dates derived from `today`. This guides the LLM without hard-coding resolution logic. Accuracy remains non-deterministic and is NOT a CI gate.

**Rationale:** Adding a deterministic fallback creates a two-system problem — disagreements between the LLM interpretation and the deterministic resolver would require arbitration logic. Prompt-only keeps a single authority (the LLM) while dramatically improving coverage.

### 2. 365d cap unchanged

`validateTimeAnchor` 365-day cap and the pre-existing 3 NL examples remain unchanged. The new `<phrasing reference>` block is an additive extension.

**Rationale:** Relaxing the cap requires a separate design around data volume, performance, and user expectations. Tracked as a separate carry-forward.

### 3. Telegram slash command only

`/refreshmemory` is exposed as a Telegram slash command built-in. No GUI button, no `<rebuild-memory/>` LLM self-issued tag.

**Rationale:** Telegram is where users interact. The GUI ContextStore page and LLM tag add surface area without a clear incremental use case; deferred as carry-forwards.

### 4. Double-CAS: re-read active index under transcript lock before write

`rebuildMemorySnapshot` acquires the active-sessions index lock, reads the active session, releases the lock, builds the snapshot (outside locks), then acquires the transcript lock, re-reads the index, and verifies the active session matches before writing. If the session ended between initial read and write, the rebuild aborts.

**Rationale:** Without the re-read under transcript lock, a race exists where an idle-reset fires between the initial CAS check and the write, causing the new snapshot to be written to a session that is now ended. The double-read closes this window.

### 5. Always-persist on successful rebuild

`rebuildMemorySnapshot` always writes the frontmatter on success, even when the new snapshot content is byte-identical to the existing one. `built_at` always reflects the rebuild time.

**Rationale:** "No-op on equal" optimizations are subtle correctness risks. Always writing simplifies the invariant: after a successful call, `built_at` is always fresh. Disk cost is one `*.md` write per command invocation — negligible.

### 6. Reuse `buildSnapshot` callback pattern from `handleMessage`/`handleAsk`

`handleRefreshMemory` builds the snapshot using the same callback shape as `handle-message.ts:143-156` and `handle-ask.ts:168-180`, gating `pinnedKeys` on `flush_memory_on_idle_reset` via `resolveUserBool`.

**Rationale:** Using a different callback would drift from the session-mint snapshot policy. The gate on `flush_memory_on_idle_reset` is the canonical policy point; it must be identical for mint and mid-session rebuild to produce consistent snapshots.

### 7. `NoActiveSessionError` lives in `conversation-session/errors.ts`

The new error class is added alongside `InvalidSessionKeyError` and `CorruptTranscriptError`, not in the broader `types/` namespace.

**Rationale:** The error is raised and caught within the `conversation-session` subsystem. Placing it in the subsystem's error module follows the established pattern and keeps the error domain-local.

---

## File Map

### Modified — Chunk A

| File | Change |
|------|--------|
| `core/src/services/conversation-retrieval/recall-classifier.ts` | Add private helpers (`findLastWeekday`, `firstOfMonth`, `firstOfPriorMonth`); extend `buildExamples(today)` with `<phrasing reference>` block of ≥10 NL forms with computed dates |

### New — Chunk A

| File | Purpose |
|------|---------|
| `core/src/services/conversation-retrieval/__tests__/build-classifier-prompt-nl.test.ts` | Primary coverage: frozen clock; exact `YYYY-MM-DD` assertions for every new phrasing; boundary edge cases |
| `core/src/services/conversation-retrieval/__tests__/recall-classifier-sanitize.test.ts` | Documents `sanitizeInput` backtick collapse + truncation; explicitly documents that XML neutralization is NOT current behavior |
| `core/src/services/conversation/__tests__/recall-temporal-nl.persona.test.ts` | Secondary integration (~15 scenarios); stubbed LLM; verifies `timeAnchorToFilters` produces correct UTC bounds for NL-derived anchors |

### Modified — Chunk B

| File | Change |
|------|--------|
| `core/src/services/conversation-session/chat-session-store.ts` | Add `rebuildMemorySnapshot(ctx, opts)` to interface + implementation |
| `core/src/services/conversation-session/errors.ts` | Add `NoActiveSessionError` |
| `core/src/services/router/index.ts` | Add `/refreshmemory` + `/refresh-memory` to built-in dispatch chain; update help text and help filter list |
| `core/src/services/conversation/index.ts` | Add `'refresh-memory'` case to `dispatchConversationCommand`; export new handler |
| `docs/MANIFEST_REFERENCE.md` | One bullet under "Built-in commands" |
| All typed `ChatSessionStore` mocks | Add stub `rebuildMemorySnapshot` method (mock-update sweep) |

### New — Chunk B

| File | Purpose |
|------|---------|
| `core/src/services/conversation/handle-refresh-memory.ts` | Handler: locate active session, build snapshot via reused callback, call `store.rebuildMemorySnapshot`, send confirmation |
| `core/src/services/conversation-session/__tests__/rebuild-memory-snapshot.test.ts` | Unit tests: happy path, no-active-session, CAS recheck, always-persist, concurrent, field-preservation |
| `core/src/services/conversation-session/__tests__/rebuild-memory-snapshot.integration.test.ts` | Real `mkdtemp` + real stores; field preservation after ContextStore mutation |
| `core/src/services/conversation/__tests__/refresh-memory.persona.test.ts` | ≥50 scenarios PR1–PR11 |
| `core/src/services/router/__tests__/router-refresh-memory.test.ts` | Router built-in regression (mirrors router-recall.test.ts) |

---

## URS Coverage

| ID | Title | Status |
|----|-------|--------|
| REQ-CONV-TEMPORAL-007 | Classifier prompt SHALL include `<phrasing reference>` block with ≥10 NL forms + computed dates from `today` | Planned |
| REQ-CONV-TEMPORAL-008 | `buildExamples` helpers (`findLastWeekday`, `firstOfMonth`, `firstOfPriorMonth`) SHALL be deterministic functions of `today` | Planned |
| REQ-CONV-TEMPORAL-009 | The rendered prompt SHALL fit within ≤4000 chars (no context-length regression) | Planned |
| REQ-CONV-TEMPORAL-010 | Pre-existing classifier examples and `validateTimeAnchor` 365d cap SHALL remain unchanged (regression guard) | Planned |
| REQ-CONV-TEMPORAL-011 | When `today` is weekday W, `findLastWeekday(today, W)` SHALL return `today - 7d` (not `today`) | Planned |
| REQ-CONV-TEMPORAL-012 | "in [month]" SHALL produce: current-month → window from 1st to today; prior month → full prior month; future if same year → wrap to prior year | Planned |
| REQ-CONV-MEMORY-013 | `/refreshmemory` and `/refresh-memory` SHALL be Router built-ins dispatching to `handleRefreshMemory` | Planned |
| REQ-CONV-MEMORY-014 | `/refreshmemory@<botname>` and `/refresh-memory@<botname>` (Telegram suffix) SHALL dispatch correctly | Planned |
| REQ-CONV-MEMORY-015 | `handleRefreshMemory` with no active session SHALL respond `"No active session to refresh."` | Planned |
| REQ-CONV-MEMORY-016 | `rebuildMemorySnapshot` SHALL accept `expectedSessionId` and abort if the active session changes between command receipt and write | Planned |
| REQ-CONV-MEMORY-017 | `rebuildMemorySnapshot` SHALL re-read the active-sessions index after acquiring the transcript lock and verify match before writing | Planned |
| REQ-CONV-MEMORY-018 | `handleRefreshMemory` SHALL build the snapshot via the same `buildSnapshot` callback pattern as `handleMessage`/`handleAsk`, gating `pinnedKeys` on `flush_memory_on_idle_reset` | Planned |
| REQ-CONV-MEMORY-019 | On `buildSnapshot()` throw, the existing `memory_snapshot` SHALL be preserved; user receives `"Memory refresh deferred — try again later."` | Planned |
| REQ-CONV-MEMORY-020 | A successful rebuild SHALL always persist (`built_at` reflects rebuild time, even when snapshot content is identical to prior) | Planned |
| REQ-CONV-MEMORY-021 | The handler SHALL send confirmation via `telegram.send(ctx.userId, ...)` (NOT `chatId`) | Planned |
| REQ-CONV-MEMORY-022 | REQ-CONV-MEMORY-012 (prefix-cache stability) is amended: "Layer 1+2 SHALL remain byte-stable across turns **between explicit `/refreshmemory` events**." | Planned |

---

## Open Carry-Forwards

The following items were explicitly considered and deferred:

- **365d cap relaxation** (`chat.recall.max_window_days`) — Requires a separate design around data volume, query performance, and user expectations.
- **Deterministic NL backstop** — A server-side phrase→date resolver would require arbitration logic with the LLM path. Deferred until there is evidence the LLM alone is insufficient.
- **GUI rebuild button on `/gui/context`** — Surface exists but the motivating use case is the Telegram workflow. Add when a GUI-centric user path is defined.
- **`<rebuild-memory/>` LLM self-issued tag** — LLM self-initiated rebuilds require a trust model for when the LLM should trigger expensive operations. Deferred.
- **Cross-user household recall ranges** — P5 carry-forward; separate phase.
- **`sanitizeInput` XML-tag neutralization** — The sanitizer currently does NOT neutralize XML-like tags. If a future phase requires this, it is a new requirement, not a bugfix.
