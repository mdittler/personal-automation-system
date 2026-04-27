# Plan: /edit Handler LLM Rate-Limit Parity

**Date:** 2026-04-27
**Status:** Planning only — no implementation yet
**Priority:** Low (no user-visible bug; operator cost-cap discrepancy only)

---

## Problem

`handle-edit.ts` uses `systemLlm` (system-tier, `SystemLLMGuard`) for its LLM proposals, while `handle-message.ts` and `handle-ask.ts` use the per-conversation `conversationLLMGuard` (per-app rate limit + monthly cost cap). This means:

- `/edit` LLM calls are attributed to the system guard, not the per-user conversation guard.
- Operators who set a tight `conversationMonthlyCostCap` for the chatbot will not see `/edit` calls against that cap.
- Per-user cost tracking via `AsyncLocalStorage` still works (the userId propagates), but the *cap* that is enforced is the system cap, not the conversation cap.

This is not a bug — the system guard does enforce limits — but the discrepancy can surprise operator cost-cap tuning and makes cost attribution in the LLM usage log inconsistent with the other two handlers.

## Why Deferred

This was explicitly noted during P1 Chunk C (see `docs/open-items.md`, "Hermes P1 Chunk C residual — `/edit` LLM rate-limit parity") as out of scope for that chunk. It was also out of scope for P2 (Hermes P2 was about broad data visibility, not handler guard wiring). Neither phase had a motivation to touch `EditServiceImpl`'s constructor.

## What Needs To Be Done

1. **Add `conversationLLMGuard` as an optional dep to `EditServiceImpl`** — `EditServiceImpl` currently accepts `{ systemLlm, ... }`. Add `{ conversationGuard?: LLMGuard }` to its options.

2. **Plumb the guard through `ConversationService`** — `ConversationService` already holds `conversationLLMGuard`. When constructing `EditServiceImpl`, pass the guard through.

3. **Update `handle-edit.ts`** — Use `conversationGuard.wrap(llm)` (or equivalent) for the LLM call that generates edit proposals, falling back to `systemLlm` when no guard is wired (for backward compat in tests).

4. **Update tests** — Add a test asserting that the edit LLM call consumes from the conversation guard when wired, not the system guard.

5. **Verify cost attribution** — Confirm LLM usage log shows `chatbot` (or the conversation app id) for `/edit` calls post-refactor.

## Estimated Scope

Small refactor: 1–2 files changed (`EditServiceImpl`, `ConversationService` wiring), ~3 new tests, no schema or config changes.

## Trigger

Implement when an operator reports unexpected cost-cap behavior for `/edit`, or when next touching `EditServiceImpl` for another reason.

## References

- `core/src/services/conversation/handle-edit.ts` — current handler using `systemLlm`
- `core/src/services/conversation/index.ts` — `ConversationService` holding `conversationLLMGuard`
- `docs/open-items.md` — "Hermes P1 Chunk C residual — `/edit` LLM rate-limit parity"
