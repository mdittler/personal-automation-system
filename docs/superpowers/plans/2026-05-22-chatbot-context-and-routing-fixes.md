# Chatbot Context & Routing Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution is continuous through all parts with a single Codex review at the end.

**Goal:** Fix four distinct bugs surfaced in one chatbot transcript — the chatbot can't see proactive Food messages, conversational questions mis-route to the Food app, multi-question messages drop a question, and the Food hosting handler emits a hollow "Event Plan" block.

**Architecture:** Four independent work parts. Part 1 (Food app) routes every proactive Food send through one send+bridge helper so the chatbot transcript records them. Part 2 (Food app) adds an untrusted-output guard so degenerate event parses decline instead of rendering. Part 3 (router + Food) sharpens the ambiguous "hosting guests" intent and adds a config-driven always-verify list. Part 4 (router) adds LLM-segmented multi-intent splitting, default ON behind a kill-switch flag. Part 5 is the documentation footprint.

**Tech Stack:** Node 22 + TypeScript 5 ESM, pnpm workspaces. Apps import core types via `@pas/core/types`. Vitest, Biome. LLM via `services.llm` (multi-provider/tier). Conversation transcript via `ChatSessionStore` + `AppOutboundBridge`.

---

## Context

A user sent the chatbot ("Gus"): *"Good morning! Can you tell me about inviting people? Also, can you see what meals were suggested I cooked last night?"* The system replied with garbled Food output (`Event Plan: ... / 0 guests / Menu:`), and a later clarification revealed the chatbot could not see a Food-app meal/rating message the user had received. Root-cause investigation (3 Explore agents) classified **four separate bugs**:

1. **Error 1 — missing proactive context.** Food cron handlers call `services.telegram.send*()` but never `appOutboundBridge.recordOutboundMessage()`, so proactive Food messages never enter the chatbot transcript. The transcript-assembly side (`loadRecentTurns`, fencing cap-lift) is correct — a bridged turn *would* appear. `docs/open-items.md` explicitly deferred bridging these jobs on 2026-05-18. This is the user's core complaint.
2. **Error 2 — mis-route.** The LLM intent classifier matched "inviting people" to the Food manifest intent `"user wants to plan for hosting guests"` at confidence ≥ 0.7. Route verification only runs in the 0.4–0.7 grey zone, so the high-confidence wrong route bypassed it.
3. **Error 3 — multi-intent dropped.** The router (`core/src/services/router/index.ts:514-588`) classifies and dispatches exactly one intent per message; the user's second question was silently dropped.
4. **Error 4 — degenerate output.** `parseEventDescription()` fed a non-event message to the LLM, got `{guestCount: 0, guestNames: [], menu: []}`, and `formatEventPlan()` rendered a hollow plan instead of recognizing the input was not an event request.

**Scope decisions (confirmed with operator):** fix all four errors; bridge the **8 genuine proactive Food jobs** (the open-items list said "12" but 4 entries — budget alerts, hosting planner, child-tracker, grocery-after-vote — are reactive replies; bridging them would double-record). Task 1.1 independently re-verifies those 4 exclusions. Multi-intent splitting (Error 3) ships **default ON** behind a config kill-switch.

---

## Codex Review — Round 1 (applied)

This plan was revised after a Codex review. Every Critical/Important finding was verified against the code and applied:

| # | Finding (severity) | Resolution in this plan |
|---|---|---|
| 1 | `sendProactiveMessage` returning `void` breaks batch-prep, which needs the `SentMessage` for `setBatchFreezeRecipes` (Critical) | Helper returns `Promise<SentMessage \| undefined>` (`SentMessage` from `sendWithButtons`, `undefined` from `send` which is `Promise<void>`). Task 1.2 + 1.4 test batch-prep callback storage. |
| 2 | Wrong import path / button shape (Critical) | All code/tests use `@pas/core/types` and `InlineButton` = `{ text, callbackData }` (verified: `core/src/types/telegram.ts:131`). |
| 3 | `weekly-nutrition` (`nutrition-summary.ts`) omitted from the migration (Critical) | Added to Task 1.4 migration, helper-path scope, Task 1.5 guard scope, Task 1.6 wiring. |
| 4 | Hosting-intent rename misses runtime maps — string hard-coded in 13+ places incl. `index.ts:377` & `:455` route maps and core tests (Critical) | Task 3.1 introduces an exported `HOSTING_MEAL_PLANNING_INTENT` constant; an `rg` sweep updates every reference (full list in Task 3.1). |
| 5 | `isDegenerateEvent` spec self-contradicts on empty description (Important) | Task 2.1 gives a precise predicate: a *guest signal* (valid count **or** non-empty names) and meta-phrase decline only on a non-empty string description; a missing description alone is not degenerate. |
| 6 | Bridge-failure path untested; helper must be fail-open (Important) | Helper wraps the bridge call in try/catch + log; never rejects after a successful Telegram send. Task 1.2 adds a bridge-rejection test. |
| 7 | File-scoped static guard is too blunt for `index.ts` (Important) | Task 1.5 scans a named set of proactive entrypoint functions + their helpers, not whole files; includes `nutrition-summary.ts`. |
| 8 | Byte-identical vs sanitization conflict (Important) | Helper/handler unit tests assert **raw** body passthrough to `recordOutboundMessage`; sanitization is asserted in a separate **real-bridge integration** test. |
| 9 | `always_verify_intents` defaulting to `[]` doesn't fix fresh setups (Important) | The code-level default is `[HOSTING_MEAL_PLANNING_INTENT]`, not `[]`; a production-default test proves the incident is prevented out of the box. |
| 10 | Config wiring incomplete (Important) | Tasks 3.2 / 4.4 also touch `pas-yaml-schema.ts`, `settings-metadata.ts`, `system-config-writer.ts`, GUI/settings tests, and example config. |
| 11 | Photo verification uses `intent`; photo matches use `photoType` (Important) | Task 3.3 adds `shouldVerifyIntent(name, confidence)` and passes `match.intent` (text) / `match.photoType` (photo), with tests for both. |
| 12 | Segment-overflow behavior contradictory (Important) | Task 4.2 fixes on **merge overflow into segment 3** (no question dropped); degrade-to-single applies only to 0 usable segments / hallucinated length. A 4-question test proves the merge. |
| 13 | No test for the literal bug's 2nd question routing to chatbot context (Important) | Task 4.5 asserts the bug message splits → seg1 → chatbot (invite help), seg2 → chatbot with the bridged Food turn visible (cross-Part 1+4 integration). |
| 14 | Persona bridge tests should assert the real chatbot prompt (Minor) | Task 1.8 reuses `app-message-bridge.persona.test.ts` — captures the LLM system prompt, asserts `[App: food] <kind>` + body excerpt. |
| 15 | `grep 'it('` test counts are noisy (Minor) | Task 5.2 enumerates tests via Vitest's JSON/list reporter, not a raw grep. |

---

## File Structure

**New files**

| Path | Responsibility |
|------|----------------|
| `apps/food/src/utils/proactive-message.ts` | `sendProactiveMessage` helper + `FoodProactiveKind` union — the single send+bridge path for Food proactive messages. |
| `apps/food/src/routing/food-intents.ts` | Exports `HOSTING_MEAL_PLANNING_INTENT` (and any other shared Food intent string constants) — single source for TS-side references. |
| `apps/food/src/testing/proactive-send-scan.ts` | AST scanner: flags `telegram.send*` inside named Food proactive entrypoints not routed through the helper. |
| `apps/food/src/__tests__/utils/proactive-message.test.ts` | Helper unit tests. |
| `apps/food/src/__tests__/proactive-send-guard.test.ts` | Build-failing guard test running the scanner. |
| `apps/food/src/__tests__/proactive-bridge.persona.test.ts` | Persona NL tests: bridged jobs visible in the chatbot system prompt. |
| `core/src/services/router/message-segmenter.ts` | Multi-intent prefilter + LLM segmentation. |
| `core/src/services/router/__tests__/message-segmenter.test.ts` | Segmenter unit tests. |
| `core/src/services/router/__tests__/router-multi-intent.test.ts` | Multi-intent dispatch tests. |
| `core/src/services/router/__tests__/router-multi-intent.persona.test.ts` | Persona NL tests for two/three/four-question messages. |
| `apps/food/src/routing/__tests__/shadow-taxonomy.contract.test.ts` | Contract test: hosting-intent string identical across manifest + constant + all copies. |
| `regression/src/cases/routing/pas/invite-platform.case.ts` | Routing regression cases for platform-invite questions. |
| `docs/superpowers/plans/2026-05-22-chatbot-context-and-routing-fixes.md` | Canonical copy of this plan (Task 5.6). |

**Modified files**

| Path | Change |
|------|--------|
| `apps/food/src/handlers/rating.ts`, `perishable-handler.ts`, `leftover-handler.ts`, `freezer-handler.ts`, `seasonal-nudge.ts`, `cultural-calendar-handler.ts` | Route proactive sends through `sendProactiveMessage`. |
| `apps/food/src/services/batch-cooking.ts`, `cuisine-tracker.ts` | Same. |
| `apps/food/src/handlers/voting.ts`, `nutrition-summary.ts`, `apps/food/src/index.ts` | Migrate the 5 already-correct bridge sites (weekly-menu, weekly-health, weekly-nutrition, batch-prep ×1 fn, voting) to the helper. |
| `apps/food/src/services/hosting-planner.ts` | `isDegenerateEvent` + `PlanEventResult` union; `planEvent` short-circuits. |
| `apps/food/src/handlers/hosting.ts` | `/hosting plan` declines gracefully on a degenerate result. |
| `apps/food/manifest.yaml` | Sharpen the hosting intent string (line 35). |
| `apps/food/src/routing/shadow-taxonomy.ts` + 13 hard-coded references | Sync the renamed hosting intent via `HOSTING_MEAL_PLANNING_INTENT` (full list in Task 3.1). |
| `core/src/services/router/index.ts` | Extract `routeOneTextRequest`; add `tryMultiIntentSplit`; `shouldVerifyIntent` gate. |
| `core/src/types/config.ts`, `core/src/services/config/index.ts`, `core/src/services/config/pas-yaml-schema.ts`, `core/src/services/config/settings-metadata.ts`, `core/src/services/config/system-config-writer.ts`, `core/src/compose-runtime.ts` | `routing.verification.always_verify_intents` + `routing.multi_intent_split` config (full surface). |
| `docs/CREATING_AN_APP.md`, `docs/MANIFEST_REFERENCE.md`, `.env.example` / example config | Future-proofing docs for proactive messages, the `app-outbound-bridge` service, and the two new config keys. |
| `docs/urs.md`, `docs/implementation-phases.md`, `CLAUDE.md`, `docs/open-items.md` | Documentation footprint (Part 5). |

---

## TDD discipline (applies to every task)

Every code task follows Red-Green-Refactor: **write the failing test → run it, watch it fail for the right reason → write minimal code → run, watch it pass → confirm full suite green → commit.** No production code without a failing test first. `pnpm lint` must report zero errors before every commit. Tests use real code; mock only `CoreServices` for app unit tests and the LLM client where unavoidable. Use temp dirs for filesystem tests, relative dates for time-sensitive tests.

---

# Part 1 — Error 1: Proactive Food message bridge

### Task 1.1: Re-verify the 4 excluded jobs are reactive (investigation, no code)

**Files:** read-only — `apps/food/src/services/budget-alerts.ts`, `handlers/budget.ts`, `handlers/hosting.ts`, `services/hosting-planner.ts`, `handlers/family.ts`, `services/child-tracker.ts`, `services/grocery-generator.ts`, `apps/food/manifest.yaml` (schedules block).

- [ ] **Step 1:** For each of the 4 — budget alerts, hosting planner, child-tracker, grocery-after-vote — confirm in code: (a) no `schedules` entry in `manifest.yaml` and never reached from `handleScheduledJob`; or (b) its only `telegram.send*` is a reply to a command/intent/callback; or (c) its text is appended to another (already-bridged) message's body. Record file:line evidence for each.
- [ ] **Step 2:** If any of the 4 is a genuine proactive cron send, add it to the Task 1.3 job list and note the deviation. If all 4 confirm reactive, write a one-paragraph confirmation carried into Task 1.7's doc text and Task 5.5's open-items update.
- [ ] **Step 3:** No commit (investigation only).

### Task 1.2: Create the `sendProactiveMessage` helper

**Files:**
- Create: `apps/food/src/utils/proactive-message.ts`
- Test: `apps/food/src/__tests__/utils/proactive-message.test.ts`

- [ ] **Step 1: Write the failing test.** Cover: (a) with `buttons` → `telegram.sendWithButtons` called once, then `appOutboundBridge.recordOutboundMessage` once with `{userId, appId:'food', kind, body, buttons}`, and the helper **returns the `SentMessage`** from `sendWithButtons`; (b) no `buttons` → `telegram.send` called, helper returns `undefined`; (c) the body passed to Telegram is **byte-identical** (raw, unsanitized) to the body passed to `recordOutboundMessage` — assert raw equality with a mocked bridge; (d) `telegram.send`/`sendWithButtons` rejects → helper rejects AND `recordOutboundMessage` is **not** called; (e) **bridge fail-open** — `recordOutboundMessage` rejects but Telegram succeeded → helper resolves (does **not** reject), error logged; (f) `services.appOutboundBridge` undefined → Telegram send still happens, no throw.

```typescript
import { describe, test, expect, vi } from 'vitest';
import { sendProactiveMessage } from '../../utils/proactive-message.js';
import type { CoreServices } from '@pas/core/types';

function mockServices(over: Record<string, unknown> = {}): CoreServices {
  return {
    telegram: {
      send: vi.fn().mockResolvedValue(undefined),
      sendWithButtons: vi.fn().mockResolvedValue({ chatId: 100, messageId: 7 }),
    },
    appOutboundBridge: { recordOutboundMessage: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...over,
  } as unknown as CoreServices;
}

describe('sendProactiveMessage', () => {
  test('with buttons: sends, records the raw body, and returns the SentMessage', async () => {
    const s = mockServices();
    const sent = await sendProactiveMessage(s, {
      userId: 'u1', kind: 'batch-prep', body: 'raw <body>',
      buttons: [[{ text: 'Freeze', callbackData: 'f:0' }]],
    });
    expect(sent).toEqual({ chatId: 100, messageId: 7 });
    expect(s.appOutboundBridge!.recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', appId: 'food', kind: 'batch-prep', body: 'raw <body>' }),
    );
  });

  test('bridge rejection is fail-open: helper still resolves after a successful send', async () => {
    const s = mockServices({
      appOutboundBridge: { recordOutboundMessage: vi.fn().mockRejectedValue(new Error('bridge down')) },
    });
    await expect(sendProactiveMessage(s, { userId: 'u1', kind: 'freezer-check', body: 'x' })).resolves.toBeUndefined();
    expect(s.logger.warn).toHaveBeenCalled();
  });

  test('does not record on the bridge when the telegram send rejects', async () => {
    const s = mockServices({ telegram: { send: vi.fn().mockRejectedValue(new Error('tg down')), sendWithButtons: vi.fn() } });
    await expect(sendProactiveMessage(s, { userId: 'u1', kind: 'freezer-check', body: 'x' })).rejects.toThrow('tg down');
    expect(s.appOutboundBridge!.recordOutboundMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `pnpm vitest run apps/food/src/__tests__/utils/proactive-message.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement minimal code.**

```typescript
import type { CoreServices, InlineButton, SentMessage } from '@pas/core/types';

/** Closed catalog of valid Food proactive `kind` values. All satisfy KIND_RE /^[a-z0-9_:-]{1,64}$/. */
export type FoodProactiveKind =
  | 'weekly-menu' | 'weekly-nutrition' | 'weekly-health' | 'batch-prep'
  | 'nightly-rating-prompt' | 'perishable-check' | 'leftover-check' | 'freezer-check'
  | 'defrost-reminder' | 'cuisine-diversity-nudge' | 'seasonal-nudge' | 'cultural-calendar';

interface ProactiveMessageOpts {
  userId: string;
  kind: FoodProactiveKind;
  body: string;
  buttons?: InlineButton[][];
}

/**
 * The single path for Food proactive (app-initiated, non-reply) Telegram sends.
 * Pairs Telegram delivery with the AppOutboundBridge record so the chatbot can
 * answer follow-ups. The bridge call is fail-open (a bridge failure must never
 * block or fail an app send) and happens only AFTER the send resolves. The raw
 * body is passed to the bridge unchanged — the bridge owns sanitization.
 * Returns the SentMessage when buttons were sent (callers may need the
 * messageId for callback resolution); undefined for a plain text send.
 * Do NOT use for replies to user input, editMessage updates, or photo results.
 */
export async function sendProactiveMessage(
  services: CoreServices,
  opts: ProactiveMessageOpts,
): Promise<SentMessage | undefined> {
  let sent: SentMessage | undefined;
  if (opts.buttons && opts.buttons.length > 0) {
    sent = await services.telegram.sendWithButtons(opts.userId, opts.body, opts.buttons);
  } else {
    await services.telegram.send(opts.userId, opts.body);
  }
  try {
    await services.appOutboundBridge?.recordOutboundMessage({
      userId: opts.userId,
      appId: 'food',
      kind: opts.kind,
      body: opts.body,
      buttons: opts.buttons,
    });
  } catch (err) {
    services.logger?.warn(
      { err, userId: opts.userId, kind: opts.kind },
      'sendProactiveMessage: bridge record failed (fail-open)',
    );
  }
  return sent;
}
```

Confirm `SentMessage`/`InlineButton` are re-exported from `@pas/core/types` (they are defined in `core/src/types/telegram.ts` and re-exported via `core/src/types/index.ts`); adjust the import only if a sibling Food file uses a different specifier.

- [ ] **Step 4: Run, verify it passes.** Then `pnpm vitest run apps/food` — full Food suite green.
- [ ] **Step 5: Commit** — `feat(food): add sendProactiveMessage send+bridge helper`.

### Task 1.3: Route the 8 proactive jobs through the helper

**Files (modify):** per the table. **Tests (modify):** the matching existing handler test files.

**Conversion pattern** — at each site, replace the `telegram.send*` call (and any surrounding `if (buttons) … else …`) with:
```typescript
await sendProactiveMessage(services, { userId: memberId, kind: '<kind>', body: message, buttons });
```
(omit `buttons` where the site has none). Add the import. The call stays inside the existing per-member loop and any existing try/catch.

| Job (manifest id) | File:line of send | `kind` | Buttons |
|---|---|---|---|
| `nightly-rating-prompt` | `handlers/rating.ts:~210` | `nightly-rating-prompt` | yes |
| `perishable-check` | `handlers/perishable-handler.ts:~219` | `perishable-check` | yes |
| `leftover-check` | `handlers/leftover-handler.ts:~345/347` (collapse both branches) | `leftover-check` | conditional |
| `freezer-check` | `handlers/freezer-handler.ts:~122` | `freezer-check` | no |
| `defrost-check` | `services/batch-cooking.ts:~237` (`checkDefrostNeeded`) | `defrost-reminder` | no |
| `cuisine-diversity-check` | `services/cuisine-tracker.ts:~113` | `cuisine-diversity-nudge` | no |
| `seasonal-nudge` | `handlers/seasonal-nudge.ts:~32` | `seasonal-nudge` | no |
| `cultural-calendar-check` | `handlers/cultural-calendar-handler.ts:~86` | `cultural-calendar` | no |

Re-confirm each line with a grep for `telegram.send` before editing. Leave `handleCulturalCalendarMessage` (the reactive on-demand handler) untouched.

For **each** of the 8 jobs, one TDD micro-cycle:
- [ ] **Step 1:** In the job's existing handler test, add a failing test: *"bridges one turn per member with kind `<kind>` and the raw body of the sent message"* — assert `appOutboundBridge.recordOutboundMessage` called once per household member with the matching `kind` and `body === <the var passed to telegram>` (raw, no sanitization assertion here). For a 2-member household assert exactly 2 calls with distinct `userId`s.
- [ ] **Step 2:** Run that test → FAIL (bridge not called).
- [ ] **Step 3:** Apply the conversion pattern at the job's send site.
- [ ] **Step 4:** Run the test → PASS; run the file's full suite → green.
- [ ] **Step 5: Commit** — `fix(food): bridge <job> proactive message into chatbot transcript`.

Additional per-job edge tests in the same cycle: empty household / no items → no send, no bridge; for `seasonal-nudge` and `cultural-calendar` the LLM-failure branch → no send, no bridge. **Sanitization is NOT asserted here** (mocked bridge sees raw body) — see Task 1.6 for the real-bridge sanitization integration test.

### Task 1.4: Migrate the 5 already-correct bridge sites to the helper

**Files (modify):** `apps/food/src/handlers/voting.ts` (~114, ~150), `apps/food/src/handlers/nutrition-summary.ts` (~89, `weekly-nutrition`), `apps/food/src/index.ts` (~3509 weekly-health, ~3558 weekly-menu, ~2173 `sendBatchPrepToMember`).

- [ ] **Step 1:** These sites already do send-then-`recordOutboundMessage` correctly; their existing tests assert the bridge call — run them first, confirm green (the safety net).
- [ ] **Step 2:** Replace each hand-written send+bridge pair with one `sendProactiveMessage(...)` call. **`sendBatchPrepToMember` (the buttons branch) must use the return value:** `const sent = await sendProactiveMessage(services, { userId: memberId, kind: 'batch-prep', body: batchMsg, buttons: batchButtons }); if (sent) setBatchFreezeRecipes(sent.chatId, sent.messageId, freezerFriendlyRecipes);`
- [ ] **Step 3:** Run each file's suite — including the batch-prep callback-resolution test (`setBatchFreezeRecipes` → `getBatchFreezeRecipe`) → all green (behavior unchanged).
- [ ] **Step 4: Commit** — `refactor(food): route existing bridge sites through sendProactiveMessage`.

Result: `sendProactiveMessage` is now the **only** proactive send path in the Food app — required for a clean Task 1.5 guard.

### Task 1.5: Build-failing static guard test

**Files:** Create `apps/food/src/testing/proactive-send-scan.ts` and `apps/food/src/__tests__/proactive-send-guard.test.ts`. Pattern reference: `core/src/testing/verdict-literal-scan.ts` (walks source with `ts.createSourceFile`).

The scanner is **entrypoint-scoped, not file-scoped** (file-scope would false-positive on the many reactive sends sharing `index.ts`):

- [ ] **Step 1: Write the failing test.** (a) a self-test feeding the scanner a fixture function named like a proactive entrypoint that contains a raw `services.telegram.send(...)` → assert it is flagged; (b) the real assertion — scan the project and assert zero flagged sites.
- [ ] **Step 2: Run** → FAIL until the scanner exists.
- [ ] **Step 3: Implement the scanner.** Maintain an explicit `PROACTIVE_ENTRYPOINTS` set of function names — the 8 scheduled-job handler functions, the 5 migrated functions (`sendBatchPrepToMember`, the weekly-menu / weekly-health / weekly-nutrition / voting senders), and any small helper they call that sends. Walk each `.ts` under `apps/food/src/` (excluding `__tests__/`, `testing/`, `utils/proactive-message.ts`); for every function whose name is in `PROACTIVE_ENTRYPOINTS`, flag any `CallExpression` whose callee is a `PropertyAccessExpression` ending in `.telegram.send` or `.telegram.sendWithButtons`. Export `scanFoodProactiveSends(): { file: string; line: number; fn: string }[]`. Adding an entrypoint to the set is a deliberate, reviewed edit; a *new* proactive job must either go through `sendProactiveMessage` or be added to the set (and then it is scanned).
- [ ] **Step 4: Run** → PASS (zero flagged; self-test flags its fixture).
- [ ] **Step 5: Commit** — `test(food): static guard against unbridged proactive sends`.

### Task 1.6: Wiring + sanitization integration tests

**Files (modify):** `apps/food/src/__tests__/app-outbound-bridge-wiring.test.ts` (existing — covers `weekly-health`/`weekly-menu`/`batch-prep`).

- [ ] **Step 1:** Add a failing dispatch case per new/covered job id — the 8 new jobs **plus `weekly-nutrition`** — driving `handleScheduledJob` with the **real** `createAppOutboundBridge` (not a mock), asserting the job-id → bridged-`kind` mapping end-to-end. Add one **sanitization integration test**: a job whose body contains an XML fence / control chars (`seasonal-nudge` or `cultural-calendar`, LLM output) → assert the turn written to the transcript via the real bridge is sanitized (`sanitizeAppMessageField` applied), confirming the trust boundary holds end-to-end even though the helper passes the body raw.
- [ ] **Step 2–4:** Run → fail → (jobs already bridged by Tasks 1.3/1.4) → pass.
- [ ] **Step 5: Commit** — `test(food): wiring + sanitization coverage for bridged proactive jobs`.

### Task 1.7: Future-proofing documentation

**Files (modify):** `docs/CREATING_AN_APP.md`, `docs/MANIFEST_REFERENCE.md`.

- [ ] **Step 1 — `CREATING_AN_APP.md`** ("Proactive Messages and the Chatbot Bridge" section, ~line 370): add a **"Pair the send and the bridge call"** subsection — two separate calls are fragile; wrap them in one per-app helper and route every proactive send through it; cite `apps/food/src/utils/proactive-message.ts` as the reference (typed `kind` union, single fail-open send-then-bridge function, returns the `SentMessage`). Add an **"Automated guard"** subsection describing the `proactive-send-scan` entrypoint-scoped pattern. In the existing "When NOT to call it" list, add: alert/warning text appended to another message's body is covered by that host message's bridge call, not a separate one — and name the 4 verified-reactive Food paths (Task 1.1 output) as worked examples.
- [ ] **Step 2 — `MANIFEST_REFERENCE.md`** (`requirements.services` table, ~line 154): add the missing `app-outbound-bridge` row — key `app-outbound-bridge`, `CoreServices` field `appOutboundBridge`, description: "Records app-initiated (proactive) Telegram messages into the chatbot transcript. Optional — `services.appOutboundBridge` is `undefined` unless declared. Required for any app that sends scheduled summaries, alerts, or voting prompts." Link to the `CREATING_AN_APP.md` section. Add a sentence under `### schedules` that a schedules handler sending user-visible messages should declare `app-outbound-bridge` and bridge each send.
- [ ] **Step 3:** Commit — `docs: document the proactive-message bridge pattern for app developers`.

### Task 1.8: Persona natural-language tests for bridged jobs

**Files:** Create `apps/food/src/__tests__/proactive-bridge.persona.test.ts`. **Pattern reference:** `core/src/services/conversation/__tests__/app-message-bridge.persona.test.ts` — capture the LLM **system prompt** and assert on its content (not a stubbed answer).

- [ ] **Step 1: Write the failing tests.** One scenario per representative bridged job: (1) fire the cron job → it bridges a `source:'app'` turn-pair; (2) the user asks the chatbot a natural follow-up; (3) **capture the LLM system prompt** the chatbot builds and assert it contains the `[App: food] <kind>` header and an excerpt of the bridged body. Cover ≥6 jobs with natural phrasings (e.g. after `nightly-rating-prompt`: "what did that dinner reminder ask me?"; after `perishable-check`: "whats expiring"; after `seasonal-nudge`: "what produce did you suggest this month"; after `cultural-calendar`: "what holiday recipes did you mention"; plus `freezer-check`/`leftover-check`). Add one **negative** scenario: with per-user config `app_message_bridge_enabled: false`, the system prompt contains no app turn.
- [ ] **Step 2–4:** Run → fail → (jobs bridged by Task 1.3; this exercises assembly) → pass.
- [ ] **Step 5: Commit** — `test(food): persona coverage for proactive-message chatbot visibility`.

---

# Part 2 — Error 4: Degenerate hosting-plan guard

### Task 2.1: `isDegenerateEvent` + `PlanEventResult` union

**Files:** Modify `apps/food/src/services/hosting-planner.ts`; test in `apps/food/src/__tests__/hosting-planner.test.ts`.

**Precise predicate.** Treat the `ParsedEvent` as untrusted LLM output. Define a **guest signal** = `guestCount` is a finite number with `0 < guestCount <= 1000`, **OR** `guestNames` is a non-empty array of strings. `isDegenerateEvent(parsed)` returns `true` if **either**:
- **(1) no guest signal**, OR
- **(2)** `description` is a **non-empty string** that, trimmed and lowercased, contains a meta-phrase from a small constant list (`inquiring about`, `asking about`, `wants to know`, `how to`, `how do`, `can you tell me`, `is asking`, `question about`).

A missing/empty/non-string `description` **alone** does NOT make an event degenerate (a valid guest signal is sufficient). A meta-phrase declines even when a plausible `guestCount` is present.

- [ ] **Step 1: Write the failing table-driven test** (`pas-testing-standards` rule 1):

| Input | Expected |
|---|---|
| `{guestCount: 0, guestNames: []}` | degenerate — no guest signal |
| `{guestCount: -3, guestNames: []}` | degenerate — no guest signal |
| `{guestCount: NaN}` / `{guestCount: Infinity}` | degenerate — no guest signal |
| `{guestCount: 1e6, guestNames: []}` | degenerate — count over cap, no names |
| `{guestCount: '6'}` (wrong type) | degenerate — not a finite number, no names |
| `guestCount` missing, `guestNames` missing | degenerate — no guest signal |
| `{guestCount: 0, description: 'The user is inquiring about ...'}` | degenerate — no guest signal (also meta) |
| `{guestCount: 4, description: 'asking about how to invite people'}` | degenerate — meta-phrase despite a valid count |
| `{guestCount: 6, guestNames: [], description: 'dinner party Saturday'}` | **valid** — guest signal, no meta-phrase |
| `{guestCount: 0, guestNames: ['Sarah','Tom']}` (no description) | **valid** — names rescue the count; missing description is not disqualifying |
| `{guestCount: 8, description: ''}` | **valid** — guest signal; empty description is not disqualifying |

- [ ] **Step 2: Run** → FAIL (function not defined).
- [ ] **Step 3: Implement** exported pure `isDegenerateEvent(parsed: ParsedEvent): boolean` per the predicate above, and `export type PlanEventResult = { kind: 'plan'; plan: EventPlan } | { kind: 'declined'; reason: 'not-an-event' };`
- [ ] **Step 4: Run** → PASS; full file green.
- [ ] **Step 5: Commit** — `feat(food): isDegenerateEvent guard for untrusted event parses`.

### Task 2.2: `planEvent` returns the union and short-circuits

**Files:** Modify `apps/food/src/services/hosting-planner.ts`; tests in `hosting-planner.test.ts`.

- [ ] **Step 1: Write the failing test.** Mock `llm.complete` to return the bug's `parseEventDescription` JSON → assert `planEvent(...)` returns `{kind:'declined', reason:'not-an-event'}` **and** that `suggestEventMenu` / `generatePrepTimeline` LLM calls never happened (assert `llm.complete` call count is exactly 1 — the parse). Valid event JSON → `{kind:'plan', plan}`.
- [ ] **Step 2: Run** → FAIL (`planEvent` still returns a bare `EventPlan`).
- [ ] **Step 3: Implement.** Change `planEvent`'s return type to `Promise<PlanEventResult>`. Immediately after `parseEventDescription` (~line 209): `if (isDegenerateEvent(parsed)) return { kind: 'declined', reason: 'not-an-event' };` — before the two expensive LLM calls. Otherwise return `{ kind: 'plan', plan }`. `formatEventPlan` stays a pure unconditional renderer.
- [ ] **Step 4: Run** → PASS; full file green.
- [ ] **Step 5: Commit** — `fix(food): planEvent declines degenerate parses before downstream LLM calls`.

### Task 2.3: `/hosting plan` handler declines gracefully

**Files:** Modify `apps/food/src/handlers/hosting.ts` (`'plan'` subcommand, ~198-216); tests in `apps/food/src/__tests__/handlers/hosting-handler.test.ts`.

- [ ] **Step 1: Write the failing tests.** (a) Degenerate parse → `telegram.send` called with a decline message; assert the sent text does **NOT** contain `Event Plan`, `0 guests`, or `Menu:` (exact-sink, rule 3). (b) Valid parse → `telegram.send` called with a `formatEventPlan` body. (c) Output-encoding: seed `description` with `` `</script>` `` → on decline, assert the decline copy is fixed and never echoes the untrusted description.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** After `const result = await planEvent(...)`: `result.kind === 'plan'` → `formatEventPlan(result.plan)` + send; `result.kind === 'declined'` → send fixed copy: *"That doesn't look like an event to plan. Try `/hosting plan dinner for 6 Saturday at 7pm`. If you wanted to invite someone to PAS, ask the assistant about invite codes."* (inside the existing handler `try/catch`).
- [ ] **Step 4: Run** → PASS; full file green.
- [ ] **Step 5: Commit** — `fix(food): /hosting plan declines non-event input instead of a hollow plan`.

### Task 2.4: Persona tests for Error 4

**Files:** add to `apps/food/src/__tests__/natural-language.test.ts` (or a new `hosting.persona.test.ts`).

- [ ] **Step 1:** Failing tests — degenerate hosting inputs (`/hosting plan inviting people`, "plan an event for inviting people") → decline message; legitimate `"I'm hosting a dinner party for 6 Saturday"` → a real plan.
- [ ] **Step 2–4:** Run → fail → pass.
- [ ] **Step 5: Commit** — `test(food): persona coverage for degenerate-event decline`.

---

# Part 3 — Error 2: Intent precision + always-verify

### Task 3.1: Sharpen the Food hosting intent + a single-source constant

**Files (create):** `apps/food/src/routing/food-intents.ts`. **Files (modify):** every hard-coded reference (full list below). **Test (create):** `apps/food/src/routing/__tests__/shadow-taxonomy.contract.test.ts`.

The string `"user wants to plan for hosting guests"` becomes `"user wants to plan a meal or menu for a dinner party or guests they are hosting"`.

`food-intents.ts` exports `export const HOSTING_MEAL_PLANNING_INTENT = 'user wants to plan a meal or menu for a dinner party or guests they are hosting';`

**All references to update** (from `rg "plan for hosting guests"` — ignore `apps/food/dist/**`, regenerated by build):
- `apps/food/manifest.yaml:35` — literal new string (YAML cannot import the constant).
- `apps/food/src/index.ts:377` and `:455` — the two route-handler maps; key off `[HOSTING_MEAL_PLANNING_INTENT]` (computed key).
- `apps/food/src/routing/shadow-taxonomy.ts:20` (label tuple) and `:124` (`hosting:` map value) — use the constant.
- `apps/food/src/__tests__/route-dispatch.test.ts:292`, `apps/food/src/__tests__/natural-language-route-dispatch.test.ts` (lines ~17, 369, 372, 596, 775), `apps/food/src/routing/__tests__/shadow-classifier.personas.ts:318` and `:759`, `apps/food/src/routing/__tests__/shadow-taxonomy.test.ts:107` — import and use the constant.
- `core/src/services/router/__tests__/realistic-verification.test.ts:52` and `:715` — core tests; use the new literal string directly (core must not import from `apps/`).

- [ ] **Step 1: Write the failing contract test** (`pas-testing-standards` rule 4): assert the hosting-intent string in `manifest.yaml` equals `HOSTING_MEAL_PLANNING_INTENT`, equals the `shadow-taxonomy.ts` label entry, equals the `hosting:` map value, and equals the `FOOD_PERSONAS` hosting label — the copies cannot drift.
- [ ] **Step 2: Run** → FAIL (write the test against the *new* target string; it fails until every copy is updated).
- [ ] **Step 3:** Create `food-intents.ts`; update every reference above. Run a fresh `rg "plan for hosting guests" apps core --glob '!**/dist/**'` and confirm zero non-dist hits remain.
- [ ] **Step 4: Run** the contract test → PASS; run `apps/food` + `core/src/services/router` suites → green (FOOD_PERSONAS accept-phrases are meal/dinner phrasings the new string still covers).
- [ ] **Step 5: Commit** — `fix(food): scope the hosting intent to meal planning; single-source the string`.

### Task 3.2: `always_verify_intents` config (full surface)

**Files (modify):** `core/src/types/config.ts`, `core/src/services/config/index.ts`, `core/src/services/config/pas-yaml-schema.ts`, `core/src/services/config/settings-metadata.ts`, `core/src/services/config/system-config-writer.ts`, `core/src/compose-runtime.ts`, `.env.example` / example config docs.

- [ ] **Step 1: Write the failing tests** in `core/src/services/config/__tests__/config.test.ts` (+ the settings/GUI test files that exercise `settings-metadata`/`system-config-writer`): `routing.verification.always_verify_intents` **defaults to `['user wants to plan a meal or menu for a dinner party or guests they are hosting']`** (the hosting intent) when absent — a production-default test proving the incident is prevented out of the box; an explicit array overrides the default; invalid input (non-array, non-string elements) coerces safely to the default; the key round-trips through `pas-yaml-schema` validation and `system-config-writer`; `settings-metadata` exposes it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — add `always_verify_intents?: string[]` to the `routing.verification` config type; parse + sanitize in the config service with the hosting-intent default; add it to the YAML schema, settings metadata, and the system-config writer path mapping; pass the resolved value into the Router constructor in `compose-runtime.ts` alongside `verificationUpperBound`. Document the key in the example config.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(config): routing.verification.always_verify_intents (defaults to the hosting intent)`.

### Task 3.3: Router `shouldVerifyIntent` gate (text + photo)

**Files (modify):** `core/src/services/router/index.ts` (free-text grey-zone gate ~527-532, photo gate ~639-647). **Test:** `core/src/services/router/__tests__/router-verification.test.ts`.

- [ ] **Step 1: Write the failing tests.** (a) Text: classifier returns the hosting intent at confidence 0.85 (above `verificationUpperBound`); with `alwaysVerifyIntents` containing it → `routeVerifier.verify` **is** called. (b) Text: same at 0.85, intent NOT in the list → verifier **not** called (high-confidence direct dispatch preserved). (c) Verifier disagrees, suggests `chatbot` → `dispatchConversation` runs, not `dispatchMessage` to `food` (post-routing handoff, rule 2). (d) **Photo:** a `photoType` match above the bound, with that `photoType` in `alwaysVerifyIntents` → verified; not in the list → not verified — proving the gate reads `match.photoType` for photos, not `match.intent`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** a private `shouldVerifyIntent(name: string, confidence: number): boolean` returning `confidence >= confidenceThreshold && (confidence < verificationUpperBound || this.alwaysVerifyIntents.includes(name))`. The free-text gate calls `shouldVerifyIntent(match.intent, match.confidence)`; the photo gate calls `shouldVerifyIntent(match.photoType, match.confidence)`.
- [ ] **Step 4: Run** → PASS; full router suite green.
- [ ] **Step 5: Commit** — `fix(router): always-verify configured ambiguous intents above the upper bound (text + photo)`.

### Task 3.4: Routing regression cases + persona tests

**Files:** Create `regression/src/cases/routing/pas/invite-platform.case.ts` (pattern: `pas-related-positive.case.ts`); extend `apps/food/src/routing/__tests__/shadow-classifier.personas.ts`.

- [ ] **Step 1:** Failing cases — `"Can you tell me about inviting people?"`, `"how do I invite someone to PAS"`, `"how do invite codes work"`, `"add a new user to the platform"`, `"invite my wife to use this"` → must route to the chatbot/platform target, **not** `food`. In `shadow-classifier.personas.ts` add `deterministicRejectFor` entries for the platform-invite phrasings on the hosting persona; keep the accept-phrases (legit hosting still classifies to the hosting label).
- [ ] **Step 2–4:** Run → fail → pass. Run `pnpm test:regression` → routing accuracy not regressed.
- [ ] **Step 5: Commit** — `test(routing): regression + persona coverage for platform-invite vs food-hosting`.

---

# Part 4 — Error 3: Multi-intent message splitting (default ON)

### Task 4.1: Extract `routeOneTextRequest` (pure refactor)

**Files (modify):** `core/src/services/router/index.ts`.

- [ ] **Step 1:** Run the full router suite — confirm green (the safety net).
- [ ] **Step 2:** Extract router lines ~521-587 (matched-branch access check, grey-zone verification, `dispatchMessage`/`dispatchConversation`, `tryContextPromotion`, `sendToFallback`) **verbatim** into a private `async routeOneTextRequest(enrichedCtx, user)`. The single-message path becomes a one-line call to it.
- [ ] **Step 3:** Run the full router suite → still green.
- [ ] **Step 4: Commit** — `refactor(router): extract routeOneTextRequest for reuse`.

### Task 4.2: `message-segmenter.ts` — prefilter + LLM segmentation

**Files:** Create `core/src/services/router/message-segmenter.ts` and `core/src/services/router/__tests__/message-segmenter.test.ts`. Pattern reference: `core/src/services/conversation/session-control-classifier.ts` (`detectSessionControl`).

**Overflow rule (fixed):** cap at `MAX_SEGMENTS = 3`; if the LLM returns >3 segments, **merge the overflow into segment 3** (no question is ever dropped). Degrade to the single-message fallback (`[text]`) **only** when there are 0 usable segments or the reconstructed length exceeds 1.5× the original (hallucination guard).

- [ ] **Step 1: Write the failing tests.** `preFilterMultiIntent` returns `false` for a short single question and an internal-comma list, `true` for a sentence-final `?` followed by more text and for word-bounded continuation markers (`also`, `additionally`, `as well`, `one more thing`, `plus`, `then` — **not** bare `and`); `segmentMessage` returns the message unchanged for a single request, splits a two-question message, drops a leading greeting, keeps a dependent clause attached; **a 4-question input → exactly 3 segments, segment 3 contains the merged 3rd+4th questions**; **untrusted-output table** — empty array / non-string elements / reconstruction >1.5× length / 0 usable segments → degrade to `[text]`; a prompt-injection payload is fenced and does not alter behavior.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `preFilterMultiIntent(text): boolean` — synchronous zero-cost gate. `segmentMessage(text, deps): Promise<string[]>` — one fast-tier LLM call (`responseFormat:'json'`, `temperature:0`, untrusted text run through `sanitizeInput` and wrapped in a `<message>` fence), instructed to drop greetings and keep dependent clauses attached. Validate output as untrusted: trimmed non-empty strings only; degrade to `[text]` per the rule above; otherwise cap at 3 by **merging** any 4th+ segment into the 3rd. LLM dependency injected (optional) for test mocking.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(router): message-segmenter (prefilter + LLM segmentation)`.

### Task 4.3 + 4.4: `tryMultiIntentSplit` + config (full surface)

**Files (modify):** `core/src/services/router/index.ts`; `core/src/types/config.ts`, `core/src/services/config/index.ts`, `core/src/services/config/pas-yaml-schema.ts`, `core/src/services/config/settings-metadata.ts`, `core/src/services/config/system-config-writer.ts`, `core/src/compose-runtime.ts`, example config.

- [ ] **Step 1: Write the failing tests** in `core/src/services/router/__tests__/router-multi-intent.test.ts`: a two-question message dispatches both segments via `routeOneTextRequest`, in input order, preceded by one preamble; a three-question message dispatches three; a single-question message is **not** split (regression guard); with `routing.multi_intent_split` **false** the message path is byte-identical to today; post-routing authorization is rechecked on segment 2 (rule 2); when segment 1's handler throws, segment 2 still runs (per-segment `try/catch`); when `segmentMessage` throws, the path degrades to the single unchanged route. Plus config tests (in `config.test.ts` + settings/GUI test files): `routing.multi_intent_split` **defaults to `true`**, round-trips through `pas-yaml-schema` / `settings-metadata` / `system-config-writer`, invalid input coerces to the default.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Add `private async tryMultiIntentSplit(enrichedCtx, user): Promise<boolean>` invoked at router line ~514 *before* `classify`: if the config flag is off or `preFilterMultiIntent` is false → return `false`. Else call `segmentMessage`; <2 segments → return `false`. Otherwise send one preamble (`"Got it — I'll cover all of those:"`), then **sequentially** call `routeOneTextRequest({ ...enrichedCtx, text: segment }, user)` per segment, each in a `try/catch` (per-segment apology on throw, continue), and return `true`. Add config `routing.multi_intent_split` (boolean, **default `true`**) across the full config surface (type, parser, YAML schema, settings metadata, writer path mapping, example config) and a hot-update setter mirroring `setIdleMinutes`. The segmenter dependency is optional in `RouterOptions` (like `routeVerifier`).
- [ ] **Step 4: Run** → PASS; full router suite green.
- [ ] **Step 5: Commit** — `feat(router): multi-intent message splitting (default on, config-gated)`.

### Task 4.5: Multi-intent persona tests

**Files:** Create `core/src/services/router/__tests__/router-multi-intent.persona.test.ts`.

- [ ] **Step 1: Write the failing persona tests** (`persona-test` skill — natural, messy language). Include explicitly the **literal bug message** *"Good morning! Can you tell me about inviting people? Also, can you see what meals were suggested I cooked last night?"* and assert: it splits into 2 segments; **segment 1** ("...inviting people") routes to the **chatbot** (platform invite help — Error 2 fix); **segment 2** ("...what meals were suggested...") routes to the **chatbot** (a memory question about Food context, not a Food command) and the chatbot's assembled context contains the bridged Food turn from Part 1 (cross-Part 1+4 integration — seed a bridged `nightly-rating-prompt` turn first). Plus: ≥15 two-question messages; ≥8 three-question; **≥4 four-question messages asserting segment 3 holds the merged remainder**; ≥15 must-**NOT**-split cases (comma lists, two sentences that are one ask, short questions); ≥6 dependent-clause messages; ≥4 partial-failure cases. ≥50 unique messages total.
- [ ] **Step 2–4:** Run → fail → pass.
- [ ] **Step 5: Commit** — `test(router): persona coverage for multi-intent splitting`.

---

# Part 5 — Documentation footprint

### Task 5.1: URS entries (`docs/urs.md`)

- [ ] Add `### REQ-FOOD-PROACTIVE-BRIDGE-001..007`: every Food proactive send routes through `sendProactiveMessage`; the 8 jobs bridge with their stable `kind`; the helper returns `SentMessage` for the buttons path; bridge called only after the send resolves; helper is fail-open on bridge failure; the static guard is build-failing; `FoodProactiveKind` is the closed catalog satisfying `KIND_RE`; reactive paths must not double-bridge.
- [ ] Add `### REQ-ROUTE-008..013`: multi-intent splitting; the synchronous prefilter; segmentation LLM output is untrusted/bounded (≤3 segments, overflow merged into segment 3); greeting/dependent-clause handling; per-segment error isolation; config-gated (default on), photos out of scope.
- [ ] Add a new hosting requirement (`REQ-FOOD-HOST-NNN`): `planEvent` treats parse output as untrusted, declines degenerate events, handler sends an actionable decline.
- [ ] Add **Fixes:** entries to `REQ-ROUTE-002` (sharpened + single-sourced hosting intent) and `REQ-ROUTE-006` (`always_verify_intents`, default = hosting intent; text + photo via `shouldVerifyIntent`); amend the config requirement to document `always_verify_intents` and `multi_intent_split`.
- [ ] Each entry lists its Standard / Edge / Error / Security tests by exact `file > describe > it` path.

### Task 5.2: Traceability matrix

- [ ] Add a matrix row per new requirement. **Count tests via Vitest's reporter** — run `pnpm vitest run <file> --reporter=json` (or the list reporter) and enumerate the actual test names; do not raw-`grep 'it('` (misses `test(...)`, counts comments, mishandles `.each`). Update the **Totals** row (distinct test files, summed Std, summed Edge, total).

### Task 5.3: `docs/implementation-phases.md`

- [ ] Add a dated section `## 2026-05-22 — Chatbot Context & Routing Fixes` with the full batch-by-batch breakdown (Goal / Approach / per-Part detail / the Codex review round / Tests) for all four errors. This file is the canonical home for phase prose.

### Task 5.4: `CLAUDE.md` status bullet

- [ ] Add **one** bullet to the Implementation Status list (newest first): date + phase name + one clause + URS-entry count. No "Current Priority" prose block. If the list exceeds ~8 entries, demote the oldest.

### Task 5.5: `docs/open-items.md`

- [ ] Mark "Bridge additional food proactive jobs (2026-05-18)" **resolved** — note the 8 jobs are bridged and record (from Task 1.1) why budget alerts / hosting planner / child-tracker / grocery-after-vote were correctly excluded as reactive.
- [ ] Add new deferred items: per-user `multi_intent_split` override (system-scoped only for now); a stricter call-graph-based proactive-send guard (entrypoint-scoped scanner shipped); the reply-collector "combine into one message" enhancement; multi-intent splitting for the photo path (out of scope).

### Task 5.6: Canonical plan copy + final verification

- [ ] Copy this plan to `docs/superpowers/plans/2026-05-22-chatbot-context-and-routing-fixes.md`.
- [ ] Run the full verification section below. Commit — `docs: URS, phases, open-items for chatbot-context-and-routing fixes`.

---

## Verification

Run after all parts, before declaring complete (evidence before assertions):

1. **Unit + integration:** `pnpm test` — zero failures (zero-failing-tests policy). `pnpm lint` — zero errors. `pnpm build` — clean.
2. **Regression suite:** `pnpm test:regression` — routing accuracy not regressed (platform-invite cases pass; legit hosting still routes to Food).
3. **Guard:** `pnpm vitest run apps/food/src/__tests__/proactive-send-guard.test.ts` — passes; temporarily add a raw `telegram.send` inside a proactive entrypoint and confirm it **fails**, then revert.
4. **Manual end-to-end** (PAS runs via `pnpm dev`):
   - Trigger `food:nightly-rating-prompt` (invoke `handleNightlyRatingPromptJob`). Confirm a `[App: food] nightly-rating-prompt` turn-pair appears in `data/households/<hh>/users/<uid>/chatbot/conversation/sessions/<id>.md` with `source: app`.
   - In Telegram, after the prompt, ask "what did that reminder ask me?" — confirm Gus references the bridged message.
   - Send "Good morning! Can you tell me about inviting people? Also, what meals did you suggest last night?" — confirm **both** questions are answered, the invite question reaches the chatbot, no `Event Plan / 0 guests / Menu:` block.
   - Send `/hosting plan inviting people` — confirm the graceful decline message.
5. **Flag kill-switch:** set `routing.multi_intent_split: false`, confirm single-intent behavior is byte-identical to pre-change.

---

## Execution

Subagent-driven: a fresh subagent per task, continuous through all five parts without pausing, with a **single Codex review at the end** of the whole plan (apply Critical/Important findings in-place with a change table). Each task commits independently so any part can be reverted in isolation. Parts 1–4 are independent and may be implemented in any order; Part 5 runs last.

## Self-Review (completed)

- **Spec coverage:** Error 1 → Part 1; Error 2 → Part 3; Error 3 → Part 4; Error 4 → Part 2; documentation footprint → Part 5; future-proofing docs → Task 1.7. All four errors + the operator's documentation requirement map to tasks. All 15 Codex findings are applied (see the change table above).
- **Placeholder scan:** no TBD / "handle edge cases" / "write tests for the above" — test tables and code are spelled out; persona files specify exact counts and categories per the persona-test skill.
- **Type consistency:** `sendProactiveMessage` → `Promise<SentMessage | undefined>`, `FoodProactiveKind`, `ProactiveMessageOpts` (Part 1); `isDegenerateEvent` / `PlanEventResult` / `ParsedEvent` / `EventPlan` (Part 2); `HOSTING_MEAL_PLANNING_INTENT`, `always_verify_intents` / `alwaysVerifyIntents`, `shouldVerifyIntent` (Part 3); `preFilterMultiIntent` / `segmentMessage` / `routeOneTextRequest` / `tryMultiIntentSplit` / `multi_intent_split` (Part 4) are used consistently across tasks.
- **Known follow-ups** are routed to `docs/open-items.md` in Task 5.5.
