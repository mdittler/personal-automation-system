# Open Items

All outstanding work, deferred phases, corrections, and proposals in one place.
User manual actions are tracked separately in `user_actions.md`.

---

## Confirmed Phases (need planning before implementation)

These are greenlit but not yet planned. Each needs a spec/plan before coding.

- ~~**Hermes P1 Chunk C**~~ ✓ Complete (2026-04-26) — `/ask`, `/edit`, `/notes` Router built-ins; daily-notes opt-in (`chat.log_to_notes`, default OFF); `<config-set>` LLM tag (allowlist + intent-regex); `coerceUserConfigValue` shared coercion; `/help` dedup. REQ-CONV-006/007/008/009/010/016/019/020 implemented.
- ~~**Hermes P2 Chunks B–E**~~ ✓ Complete (2026-04-27) — ConversationRetrievalService full implementation. Chunk B: `ReportService.listForUser` + `AlertService.listForUser` scoped APIs. Chunk C: compose all readers + `buildContextSnapshot` with partial-failure tolerance. Chunk D: wired into `handleMessage`/`handleAsk` + persona tests. Chunk E: URS finalization + docs. REQ-CONV-RETRIEVAL-001 through 016 implemented. Spec: `docs/superpowers/specs/2026-04-27-hermes-p2-conversation-retrieval-design.md`.
- ~~**Hermes P3**~~ ✓ Complete (2026-04-27) — Session persistence: manual `/newchat` and `/reset`. `ChatSessionStore` with per-session markdown transcripts (`YYYYMMDD_HHMMSS_<8hex>`), `active-sessions.yaml` index under `withFileLock`, legacy `history.json` migration (one `source: legacy-import` session), `expectedSessionId` in-flight race guard. REQ-CONV-SESSION-001 through 014 implemented. Plan: `docs/superpowers/plans/can-you-start-on-wondrous-bentley.md`.
- ~~**Hermes P4**~~ ✓ Complete (2026-04-28) — Durable-memory snapshot + fenced recall. `MemorySnapshot` frozen at session-mint time via `ensureActiveSession` (before prompt assembly); persisted in session frontmatter (`memory_snapshot:`). `buildMemoryContextBlock` / `sanitizeContextContent` fence utility. Layer 2 snapshot in prompt before per-turn context; Layer 4 fenced wrapper for recalled `searchData` results. Per-turn ContextStore re-injection removed from `gatherContext`. REQ-CONV-MEMORY-001 through 012 implemented. Spec: `docs/superpowers/specs/2026-04-28-hermes-p4-memory-snapshot-design.md`. Plan: `docs/superpowers/plans/can-you-start-on-shimmying-mountain.md`.
- **Hermes P5 — SQLite + FTS5 transcript search** — Full-text search across session transcripts. Prerequisite: P3 session persistence (now complete). `requestContext.sessionId` provides the stable foreign key. Requires designing the import path from `.md` transcripts into SQLite and a `/search` command or `/ask`-integrated recall.
- **Hermes P7 — Auto-titling + natural-language /newchat intent** — Session auto-title generation. Natural-language phrasings (`start over`, `wipe context`, `begin again`) routed to `handleNewChat` via intent classification rather than literal regex — documented as out-of-scope in P3 persona tests (I.3).
- **Hermes P8 — Auto-reset, idle timeout, active-work protection** — Auto-reset after N hours idle; daily reset; pre-reset memory-save turn; active-work protection warning. Deferred from P3 per `feedback_no_autoreset_before_recall.md` (reset without recall makes chat feel more forgetful). Implement after P5 FTS5 recall is available.
- **LLM Enhancement #3** — Entity/slot extraction: grocery items, quantities, stores, days, portions via `llm.extractStructured`. Extends Enhancement #2's classifier-only approach to structured extraction across Food handlers. Plan: `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`.
- **LLM Enhancements #4–#7** — DataQuery keyword gate removal, chatbot system-data categorization, knowledge reranker, photo caption confidence routing. Same plan.
- **Phase H12c** — Alcohol + Meal Quality Signals. Deferred pending H12a stabilization.
- **Phase 27C** — CrossAppDataService + LinkResolver: read-only cross-app file access. Deferred until a concrete use case requires it.

---

## Planned Review Work

Cross-cutting review work that should happen in staged sessions before any cleanup or backfill implementation begins.

- **Staged test/spec coverage review** — Review-only effort to assess whether repo-local tests cover intended behavior, use meaningful assertions, avoid brittle or over-mocked patterns, and identify obsolete or superseded tests. Run this across multiple sessions by stage using `docs/test-review-roadmap.md`.

---

## Deferred Infrastructure Work

Confirmed gaps that need to be addressed; timing depends on which phase picks them up.

- **D5a §1 — `forShared(scope)` path segment** — `forShared()` ignores its scope argument. Fixing requires migrating ~30+ food callsites + existing shared files. Target: D5c or later. Search `forShared(` in `core/` and `apps/`.
- **D5a §4 — Collaboration space UX** — `kind: 'collaboration'` is fully modeled but no production code creates one. Add `SpaceService.createCollaboration()`, admin command `/collab create`, GUI screen. Do NOT weaken isolation tests. Target: post-D5c.
- **One-off task user scope** — `OneOffTask` has no `user_scope` field; all tasks run as `userScope: 'system'`. Apps needing per-user one-off tasks need the schema extended + bootstrap wiring.
- **Per-space scheduled jobs** — Space-scoped apps have no way to register scheduled jobs that run per-space. Needs scheduler support. (From `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`.)
- **Review Phase 7 residual — broader active-space food migration** — Phase 7 only made recipe/receipt/grocery photo writes and interaction records space-aware. Follow `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md` to extend active-space behavior to pantry photos, callback-space plumbing, the major shared-data interactive message/callback flows in `apps/food/src/index.ts`, and cross-scope read/write reconciliation. Keep scheduled jobs shared-only until per-space scheduler support exists. This follow-up should add higher-level regressions proving those flows write to `spaces/<spaceId>/food/...` when a space is active and still fall back to shared when none is active. Depends in part on the separate `forShared(scope)` selector bug above.
- **Route-first allowlist: 'save a recipe'** — Add `'user wants to save a recipe'` back to Food's `ROUTE_HANDLERS` once `handleEditRecipe` is declared as a manifest intent. Currently omitted because phrases like "edit the lasagna recipe" misclassify as save-intent; the overlap disappears once both intents are manifest-declared with distinct descriptions. (Enhancement #2 A.1)
- **Route-first allowlist: 'search for a recipe'** — Add `'user wants to search for a recipe'` back to `ROUTE_HANDLERS` once `handleRecipePhotoRetrieval` is declared as a manifest intent. Same root cause as above. (Enhancement #2 A.1)
- **Route-first allowlist expansion (A.2)** — Cover additional manifest intents (pantry, grocery, leftovers, nutrition) after auditing each for regex-branch collision. Needs design decisions on ambiguous multi-sub-intent cases first. (Enhancement #2 A.2)
- **Per-handler `is*Intent` classifiers** — `apps/food/src/handlers/{budget,hosting,cultural-calendar-handler,health,nutrition,family}.ts` + `apps/food/src/services/price-store.ts` still use local regex predicates. Most will be bypassed automatically as their manifest intents enter the allowlist; the remainder serve non-manifest sub-intents and stay as fallback.
- **Chatbot `MODEL_SWITCH_INTENT_REGEX` route-first conversion** — `apps/chatbot/src/index.ts:81`. Apply the same route-first pattern used in Enhancement #2 Food handlers: prefer `ctx.route` intent metadata when available, fall back to the existing regex. Straightforward follow-up.
- **Hermes P1 Chunk C residual — `/edit` LLM rate-limit parity** — `EditServiceImpl` uses `systemLlm` (system-tier guard), not `conversationLLMGuard`. Free-text and `/ask` go through the per-app conversation guard; `/edit`'s LLM proposals use the system guard instead. Not a bug, but the discrepancy could surprise operator cost-cap tuning. Rewiring `EditServiceImpl` to accept a conversation-scoped guard is a separate refactor; revisit if the discrepancy surfaces in real cost-cap behavior.
- **Enhancement #2 production flip** — Change `routing_primary: shadow` in `config/pas.yaml` once `pnpm analyze-shadow-log` shows ≥95% agreement over ≥1 week of real usage. No code change needed; this is an operational config decision.
- **D2a non-target food write sites** — FileIndex enrichment was intentionally scoped to the primary food stores. The following are indexed by path/title only and will not surface well in NL queries: freezer, leftovers, waste log, budget history, quick meals, guests, family profiles, ingredient cache. Enrich in a follow-up phase if D2b NL querying reveals gaps. (See `docs/superpowers/specs/2026-04-13-d2a-file-index-foundation-design.md` line 163)
- **I-1 — `collaboration-data` phantom failures in buildContextSnapshot** — When `anyDataQuerySelected` is true but `deps.dataQuery` is absent, the failure list can include DataQuery scope categories that were never selected (e.g., `collaboration-data` when only `user-app-data` was selected). This causes the prompt to emit "some data unavailable this turn" spuriously. Fix: filter the failure list to only categories present in `selected`. File: `core/src/services/conversation-retrieval/conversation-retrieval-service.ts` lines ~320–326.
- **I-2 — `dataQueryResult` budget accounts by JSON size not formatted string size** — `charsUsed` is incremented by `JSON.stringify(snapshot.dataQueryResult).length` but the result is later formatted by `formatDataQueryContext()` into Markdown, which differs in size. Secondary safety nets (per-category 6K cap, prompt-builder 12K cap) prevent overflow, but the accounting is imprecise. Fix: use formatted string size, or at minimum document the imprecision. File: `core/src/services/conversation-retrieval/conversation-retrieval-service.ts` lines ~416–418.
- **M-3 — reports/alerts budget sizing uses full JSON not rendered size** — The budget loop calls `JSON.stringify(r)` to size each report/alert entry, but the prompt-builder only renders `r.name + r.schedule`, which is far smaller. This causes overly conservative truncation that wastes context budget without risk of overflow. File: `core/src/services/conversation-retrieval/conversation-retrieval-service.ts` lines ~423–438.
- **M-4 — `chooseSources` always adds `system-info` in ask mode** — `source-selection.ts` unconditionally includes `system-info` for every `/ask` call, but `buildSystemDataBlock` returns `''` when the question contains no relevant keywords, making the fetch a no-op. Let keyword matching gate `system-info` in ask mode too, removing the always-on fetch. File: `core/src/services/conversation-retrieval/source-selection.ts` lines ~46–50.

---

## Unfinished Corrections

Known issues or cleanup items that should be addressed in a near-term session.

- **Energy/mood field removal** — Remove `energyLevel` and `mood` from `HealthDailyMetricsPayload` and the correlator table columns (`energy_1_10`, `mood_1_10`). The `isHealthCorrelationIntent` biometric exclusion regex already excludes these terms. Do this when next touching the health correlator.
- **`isPasRelevant()` deprecation** — Function is deprecated (not removed) in `apps/chatbot/src/index.ts`. Its backward-compat tests remain. Remove the function and its tests once confirmed no callers remain.
- **Stage 3 review follow-up — downstream user cleanup policy** — Decide whether `UserMutationService.removeUser()` should also scrub downstream shared state such as space memberships, active-space records, and household admin references. The smaller rollback/sync fixes from Stage 3 are complete; this broader cross-service cleanup question remains open.
- **Finding 21 — broader Telegram Markdown normalization** — Inline handler messages, budget reporter, household, hosting planner, and cook-mode all send dynamic content without escaping. Phase F9 deferred these to Finding 21. (See `docs/superpowers/specs/2026-04-11-f9-telegram-markdown-escaping-design.md` line 69.)
- **Provider integration tests** — `GoogleProvider`, `OpenAICompatibleProvider`, and `OllamaProvider` lack dedicated integration tests (REQ-LLM-021). Blocked on API keys being available. Once keys exist, add tests alongside `AnthropicProvider`'s test pattern.
- **D5c-review — `revokeLastCheckCommit()` not request-specific under concurrency** — `HouseholdLLMLimiter.revokeLastCheckCommit()` calls `rl.revokeLastCommit(householdId!)` which pops the *last* timestamp. Under concurrent callers at the same `await` point (currently not possible since `reserveEstimated` is sync), rollback could revoke the wrong slot. Low risk today; fix if `reserveEstimated` is ever made async. Consider returning a per-commit handle from `check()` instead of popping last.
- **D5c Chunk E — rewire `multi-household-isolation.integration.test.ts` to composeRuntime.** The existing 717-line integration test hand-wires ~11 services at the data-layer slice with no LLM/Router path. Rewiring to `composeRuntime()` would drag it through the full service graph with no current motivation. Defer until a future food-app phase expands the test's scope to require LLM.
- **D5c Chunk E — `composeRuntime({ config })` configPath footgun.** When `config` is overridden but `configPath` is not, `UserMutationService` defaults to the real `config/pas.yaml` and will write-back on invite redemption or user mutation. Current test callers (smoke + load-test) always pass `seed.configPath`, so no one is burned today. Future fix: either require `configPath` when `config` is provided, or derive a temp path automatically. See comment at `compose-runtime.ts` line 182.
- **Stage 6 residual — CLI direct-run heuristic** — `core/src/cli/install-app.ts` and `uninstall-app.ts` still decide whether to auto-run by checking whether `process.argv[1]` contains the script name. The runner-level tests now cover command behavior directly, but the entrypoint heuristic itself remains string-based. Tighten this only if a future packaging/runtime environment makes the current check unreliable.
- **Hermes P1 Chunk A: simplify pass pending** — Chunk B and C have been simplified; Chunk A has not yet received a `/simplify` pass. Run `git diff <chunk-a-start>^..<chunk-a-end>` to scope the diff, then run the three-agent simplify review (reuse, quality, efficiency).
- **Hermes P2: collaboration-data wiring** — `SOURCE_POLICY` declares the `collaboration-data` category but `buildContextSnapshot` returns an empty array for it (the underlying cross-household `SpaceService.isMember` query is not implemented). Wire when a concrete collaboration use-case is defined. (Noted in P2 Chunk A; survived through Chunk C.)
- ~~**Hermes P2: ContextStore double-read**~~ ✓ Fixed in P4 (2026-04-28) — `gatherContext` no longer fetches ContextStore entries. Durable memory comes only from the session snapshot; volatile context (apps, system data) is still gathered per-turn.
- **Snapshot interactionContext unused in prompt-builder:** `buildContextSnapshot` fetches `interactionContext` entries but `buildAppAwareSystemPrompt` doesn't render them (the interaction data from `gatherContext`/the classifier path is used instead). This creates redundant I/O. Consider either (a) removing interaction-context from the snapshot fan-out in `free-text` mode until prompt-builder consumes it, or (b) rendering it in a prompt block. Deferred post-P2.
- **Hermes P3: group-chat session isolation** — `buildSessionKey()` accepts `scope: 'group'`; `dispatchConversation` never sets it in P3. Wire when PAS handles Telegram group chats with separate per-group session contexts.
- **Hermes P3: token-counter integration** — `token_counts` in session frontmatter is `{input: 0, output: 0}` in P3. Populate when LLM cost-tracking is threaded through conversation turns (CostTracker → ConversationService). Frontmatter round-trip and preservation are tested (F.2 test).
- **Hermes P5+: session retention / auto-prune** — Sessions are kept forever in P3. Add opt-in retention (prune sessions older than N days) in P5 or later, co-designed with the FTS5 index invalidation strategy.
- **Hermes P6: typed `kind:` filter on `buildMemorySnapshot`** — P4 freezes all `listForUser(userId)` entries (user-scoped only). P6 will add typed categories (`kind: user-preference`, `communication-preference`, `environment-fact`, `project-convention`, `household-policy`) to `ContextEntry` frontmatter. When that lands, narrow `buildMemorySnapshot` input to durable-kind entries only. See REQ-CONV-MEMORY-004 for the intentional P4 adaptation note.
- **Hermes P6: system durable context inclusion in snapshot** — `listForUser` is user-scoped only (per `context-store.ts`). If shared system durable memory should be visible in the snapshot, P6 introduces a new API (e.g., `listDurableForUser` merging system + user with user precedence). Deferred to keep P4 scope contained.
- **Hermes P6: sanitizer threat-regex hardening** — P4 strips nested backtick fences and neutralizes a small allowlist of role-like tags. Future hardening: port `tools/memory_tool.py:65-102` threat-scan regexes (HTML-tag injection patterns, prompt-injection signatures). Defer to P6 alongside typed-memory work.
- **Hermes P4: snapshot character-budget tuning** — 4000-char budget is a starting estimate. Revisit after a month of real use; track `entry_count` and truncation rate via the persisted `memory_snapshot.status` field. Adjust if users with large ContextStore collections see truncation frequently.
- **Hermes P5: `searchSessions` fenced wrapping** — P5's transcript search hits should reuse `buildMemoryContextBlock` with `label: 'recalled-session'` and `marker: '... (recalled session truncated)'`. Add the wrapper when implementing `ConversationRetrievalService.searchSessions`.
- **Hermes P6+: mid-session snapshot-rebuild command** — No UX surface for rebuilding the active session's frozen snapshot mid-session. Out of scope for P4; revisit if users report preference changes not taking effect within a session.
- **Hermes P4: snapshot build inside session index lock** — `ensureActiveSession` invokes `buildSnapshot` (which reads ContextStore) while holding the per-user `active-sessions.yaml` file lock. This serializes filesystem reads with any concurrent session operations on the same user. Fix: build snapshot outside the lock, double-check that no session was minted concurrently, then reacquire the lock and mint. Low urgency for single-user deployments.
- **Hermes P4: real end-to-end freeze integration test** — The persona tests use mocked `ChatSessionStore`; they verify prompt injection but not the ContextStore → `buildMemorySnapshot` → `ensureActiveSession` → prompt path with real file I/O. Add one integration test with real temp-backed stores: set a preference, assert the next session's prompt contains it, mutate mid-session, assert the active prompt unchanged, `/newchat` to verify the new snapshot picks up the mutation.
- **Hermes P4: `<memory-context>` scope — app knowledge not wrapped** — Only durable `MemorySnapshot` (Layer 2) and DataQuery `searchData` results (Layer 4) are wrapped in `<memory-context>` blocks. App knowledge/metadata rendered by `buildAppAwareSystemPrompt` appears in legacy fenced sections outside this wrapper. Decide in P5/P6 whether to extend fenced wrapping to all retrieved background content.

---

## Food App Enhancements

Feature work identified in phase specs but deferred.

- **Waste reporting** — `/waste` command with monthly summary of wasted items and estimated cost. (H6 spec)
- **Meal plan awareness** — Suggest meals based on leftovers and freezer inventory. (H6 spec)
- **Nutrition tracking for waste** — Attribute nutritional/cost loss to wasted food entries. (H6 spec)
- **H5b — Cook mode: timer integration** — Extract timer durations from recipe steps, surface "Set timer" Telegram buttons, wire into one-off scheduler, send notification callback on expiry. (Deferred from H5a)
- **H5b — Cook mode: TTS / Chromecast output** — Hands-free cooking via audio output: device selection, non-blocking per-step TTS, `tts_device_name` + `auto_advance_timer` + `cook_mode_timeout_hours` config fields. Voice input for step advancement is out of scope until a voice-input service exists. (Deferred from H5a)
- **H5b — Cook mode: contextual food questions** — While a cook session is active, inject user dietary preferences, allergies, family profile, and active recipe context into the chatbot prompt so in-cooking questions ("can I substitute X?") are context-aware. (Deferred from H5a)

---

## Proposals (unconfirmed — implement when triggered)

Ideas that are not yet approved. Each has a stated trigger condition.

- **Fitness/Health app** — Subjective signals (energy, mood, wearables) belong in a dedicated app. Food's `HealthDailyMetricsPayload` intentionally omits these; a future fitness app should emit `health:daily-metrics` events.
- **Full Telegram data access audit** — Each new app phase should verify read + correct NL intents for all stored data. Several food stores still lack this (price store, receipt items, health metrics).
- **App registry/marketplace** — Static JSON index + GUI browse page. Trigger: 10+ apps exist.
- **App signing** — Cryptographic verification for reviewed apps. Trigger: community review process established.
- **Container isolation** — Trigger: community forms and multi-tenant security requirements harden.
- **Smart freeze suitability** — Warn when foods that don't freeze well are being frozen. (H6 spec.)
- **Batch expiry estimation** — Estimate multiple pantry items in one LLM call instead of per-item. (H6 spec.)
- **Agentic loops** — 6 agent proposals (Routing-Learning, Data Steward, Receipt/OCR QA, Household Planning, Ops, App Onboarding). See `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`.
- **Hermes: tool registry with AST-gated discovery** — Auto-discover tools via AST analysis so runtime registration matches declared exports. Trigger: PAS gains a plug-in tool system. (See `docs/hermes-agent-adoption-review.md`)
- **Hermes: channel adapter ABC + PLATFORM_HINTS** — Clean abstraction for multi-channel messaging (max length, markdown support, reaction support). Trigger: a second messaging channel is added beyond Telegram. (See `docs/hermes-agent-adoption-review.md`)
- **Hermes: secret redaction with import-time flag snapshot** — Scrub known secret-shaped strings from any string sent externally or logged. Trigger: conversation transcripts ever leave the local machine. (See `docs/hermes-agent-adoption-review.md`)
- **Shadow-primary persona sweep (collapsed-bucket overlap)** — Before flipping `routing_primary: shadow` in production, run targeted integration tests for the high-risk many-to-one bucket overlap phrases: freezer-vs-pantry (`add soup to the freezer` vs `add soup to the pantry`), leftover-view-vs-add (`show me my leftovers` vs `just finished the leftover chili`), grocery-generate-vs-view, edit-vs-save recipe, recipe-photo-vs-search, meal-plan generate-vs-view-vs-swap. Each phrase pair verifies the correct sub-dispatch closure fires. NOT one test per FOOD_PERSONAS persona — target the overlap boundaries only. Trigger: ≥95% telemetry agreement reached and production flip is being prepared.

---

## Accepted Risks (no action needed)

Documented decisions to live with known imperfections.

- **D40** — `getActiveSpace()` fire-and-forget persist. Acceptable: self-healing on next request.
- **D42** — Conversation history anti-instruction framing removed. Accepted: continuity > theoretical injection risk.
- **Callback space semantics — originating scope** — Inline keyboard callbacks resolve space context at tap-time, not button-generation-time. Encoding the originating scope into every callback data string is a large change with low practical impact (buttons are tapped promptly). Accepted as designed.

