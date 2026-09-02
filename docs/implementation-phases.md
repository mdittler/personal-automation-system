# PAS Infrastructure — Implementation Phases

| Field | Value |
|---|---|
| **Purpose** | Detailed phase-by-phase implementation guide for the PAS infrastructure |
| **Status** | Phases 0–28, D1–D4 complete (except 27A-Vaults, 27B, 27C planned) |
| **Last Updated** | 2026-04-27 |

---

## Phase Summary

| Phase | Name | Status | Files | Description |
|-------|------|--------|-------|-------------|
| 0 | Project Scaffolding | **Complete** | ~15 | Monorepo, toolchain, build pipeline |
| 1 | Type System + Manifest Schema | **Complete** | ~16 | All interfaces, JSON Schema for manifests |
| 2 | DataStore, Config, Logger | **Complete** | ~13 | File-based storage, config loading, Pino logging |
| 3 | Event Bus, Scheduler, Condition Evaluator | **Complete** | ~13 | Plumbing services for coordination |
| 4 | LLM Service | **Complete** | ~9 | Ollama + Claude dual-backend |
| 5 | Telegram Gateway, Router, App Registry | **Complete** | ~26 | Message pipeline, app loading |
| 6 | Echo App + E2E Integration | **Complete** | ~10 | First working app, full round-trip |
| 7 | Context Store, Audio, Daily Diff | **Complete** | ~15 | Remaining services |
| 8 | Management GUI | **Complete** | ~19 | htmx web dashboard |
| 9 | Docker, Multi-User, Production Hardening | **Complete** | ~12 | Deployable system |
| 10 | Multi-provider LLM types + provider clients | **Complete** | ~20 | Provider abstraction layer |
| 11 | Multi-provider config + model discovery | **Complete** | ~12 | Config, model catalog, pricing |
| 12 | LLM service rewrite for multi-provider | **Complete** | ~8 | Service rewrite, backward compat |
| 13 | Per-app LLM safeguards | **Complete** | ~8 | Rate limits, cost caps, audit |
| 14 | GUI updates for multi-provider | **Complete** | ~6 | Model management UI |
| 15 | Integration, migration, documentation | **Complete** | ~5 | Final multi-provider polish |
| 16 | Chatbot fallback app | **Complete** | ~8 | Full conversational AI as default handler |
| 17 | App packaging + install CLI | **Complete** | ~10 | `pas install`, static analysis, compat checks |
| 18 | Chatbot app awareness | **Complete** | ~12 | /ask command, auto-detect, app metadata + knowledge base |
| 19 | App developer documentation | **Complete** | ~3 | How to build, test, share a PAS app |
| 20 | Scheduler GUI improvements | **Complete** | ~5 | Human-readable cron, next/last run times |
| 21 | Scheduled reports system | **Complete** | ~14 | Configurable reports with data collection, LLM summary, Telegram delivery |
| 22 | Conditional alerts system | **Complete** | ~12 | Scheduled condition evaluation with typed action execution |
| 23 | Shared data spaces | **Complete** | ~10 | Named spaces, membership, active space, GUI |
| 24 | External data API | **Complete** | ~6 | POST /api/data, POST /api/messages for n8n |
| 25 | n8n integration improvements | **Complete** | ~6 | GET /api/data, GET /api/schedules, outbound webhooks |
| 26 | n8n dispatch pattern | **Complete** | ~12 | API endpoints for reports/alerts/changes/LLM/telegram, dispatch mode |
| 27A | Obsidian cross-app linking | **Complete** | ~5 | Conventions, utilities, Dataview fields, chatbot data awareness |
| 27A-Vaults | VaultService | **Planned** | ~4 | Per-user Obsidian vaults with symlinks for personal, shared, and space data |
| 28 | Route Verification | **Complete** | ~10 | Grey-zone LLM verification, inline buttons, verification log |
| 27B | FileIndexService | **Superseded by D2a** | ~6 | Superseded by Phase D2a FileIndexService (scope-aware, event-driven, richer metadata) |
| 27C | CrossAppDataService | **Planned** | ~8 | Read-only cross-app file access + wiki-link resolution |
| R1 | Security: Access Control | **Complete** | ~8 | Route-verifier app access check (F1), atomic invite redemption (F2) |
| R2 | Security: Chatbot LLM Trust | **Complete** | ~6 | Model-switch admin+intent gating (F4), history anti-instruction framing (F5), system data admin gating (F6) |
| R3 | Security: Data Boundaries | **Complete** | ~8 | Manifest scope enforcement (F3), scope path normalization (F7), context store path containment (F8) |
| F9 | Security: Telegram Markdown Escaping | **Complete** | ~11 | Shared `escapeMarkdown` utility in core; applied to 8 food formatters, echo/notes apps, reports (`formatReportForTelegram`), and alerts; router/verifier migrated from MarkdownV2 to legacy set |
| R4 | Security: LLM Routing & Cost Caps | **Complete** | ~8 | F10 (unknown model pricing), F11 (optional Anthropic key), F12 (stale tier selections), F13 (cost cap cache miss), F14 (API attribution) |
| R5 | Security: Food Photo/Vision | **Complete** | ~12 | F15 (household guard), F16 (strict vision classification), F17 (caption injection hardening), F18 (canonical ingredient names), F19 (grocery-photo atomic writes), F20 (malformed LLM output guards), F21 (photo handler Markdown escaping) |
| R6 | Security: Async/Scheduling/Events | **Complete** | ~6 | F31 (one-off resolver), F32 (promise queue poisoning), F33 (job failure notifier), F34 (event bus handler map), F35 (in-flight shutdown drain) |
| R7 | Test Gap Audit: Notifier Resilience | **Complete** | ~4 | Notifier exception resilience in CronManager/OneOffManager; EventBus.clearAll(), CostTracker queue, 30s drain timeout, stopping flag isolation |
| CR6 | Arithmetic/Date/Cost/Schedule Calculations | **Complete** | ~14 | F22 (parseInt), F23 (DST-safe addDays), F24 (timezone todayDate), F25 (ISO week 53), F26 (boundary-week budget), F27 (cost estimate validation), F28 (price store guard), F29 (shelf-life caps), F30 (dead config cleanup) |
| CR8 | Remaining Review Findings | **Complete** | ~8 | F37 (condition-eval), F38 (install prompt), F39 (dead register-app), F40 (duplicate app IDs), F41 (GUI XSS safeJsonForScript), F42 ({date} token alias) |
| R1-post | R1 Post-Review Hardening | **Complete** | ~6 | H1 (resolveCallback access check), H2 (claimAndRedeem idempotency + rollback), L1-L6, M1-M3 |
| CR9 | Test Coverage Gaps (Review Phases 9+10) | **Complete** | ~5 | 14 test gaps from review Phases 9-10: 5 new tests (Gaps 4, 6, 8, 12+13, 14) + 9 already covered |
| D1 | Chatbot Context & Conversation Quality | **Complete** | ~8 | LLM classifier replaces keyword list, user context injection, message splitting, 2048 token cap |
| D2a | File Index Foundation | **Complete** | ~14 | FileIndexService in-memory index, scope normalization fix, food app frontmatter enrichment |
| D2b | NL Data Query Service | **Complete** | ~10 | DataQueryService + chatbot wiring, YES_DATA classifier, realpath hardening, /ask LLM classifier |
| D2c | Interaction Context & /edit | **Complete** | ~18 | InteractionContextService, context-aware routing, food interaction recording, EditService, /edit command |
| D3 | Security Hardening | **Complete** | ~12 | Secure cookie (auth+CSRF), inline JS→data-attributes, target validation, CSRF in spaces forms, Docker dep gap, cookie reissue upgrade |
| D4 | Concurrency & Ops | **Complete** | ~40 | Central FileMutex (withFileLock/withMultiFileLock), 6 food store lock wrappers + 28 RMW call sites, EditService PathLock migrated to FileMutex, archivePurchased same-day merge, /health/live + /health/ready endpoints with 4 checks, BackupService (tar.gz, rolling retention), deployment docs |
| D5a | Per-Household Data Boundary Hardening | **Complete** | ~20 | EditService household guard, resolveScopedDataDir path containment, DataStore + Scheduler scope enforcement, household-aware ContextStore/FallbackHandler/VaultService, API + GUI data-browser household filtering, multi-household isolation tests |
| D5b | Per-Household GUI + REST API Auth | **Complete** | ~22 | CredentialService (scrypt, sessionVersion), AuthenticatedActor shape, per-user GUI login + cookie, ApiKeyService + API Bearer auth, GUI admin gating + household route filtering, API resource-kind gates, credential/API key UI, Telegram first-run wizard |
| D6 | InteractionContextService Disk Persistence | **Complete** | ~6 | Disk persistence for InteractionContextService, bootstrap wiring, drain-flush guarantee, load validation + sort-on-load |
| D5c | Per-Household LLM Governance + Ops + Load Test | **Complete** | ~40 | Household cost ledger (9th column), shared household rate limiter, per-household cost caps + reservations, ops dashboard, 40-user load test with bootstrap composeRuntime refactor. Plan: `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md` |
| Hermes P1 | ConversationService — core service extraction | **Complete** | ~80 | Extracted chatbot into `core/src/services/conversation/`; retired apps/chatbot; ConversationService first-class in bootstrap. Chunks A–D.4. Spec: `docs/superpowers/specs/2026-04-25-hermes-p1-conversation-service-design.md` |
| Hermes P2 | ConversationRetrievalService — broad data visibility | **Complete** | ~30 | Source Policy allowlist, ConversationRetrievalService skeleton + DI wiring, scoped ReportService/AlertService APIs, compose all readers + buildContextSnapshot, handler wiring + persona tests, URS finalization. Chunks A–E. Spec: `docs/superpowers/specs/2026-04-27-hermes-p2-conversation-retrieval-design.md` |
| Hermes P3 | Session persistence — manual /newchat and /reset | **Complete** | ~70 | Explicit per-session transcript files (`YYYYMMDD_HHMMSS_<8hex>.md`) under `chatbot/conversation/sessions/`. Tracers A–K: manifest scope, session-key/id/codec pure helpers, session-index with file mutex, Router peekActive + sessionId binding, ChatSessionStore appendExchange + endActive with locked race semantics, legacy history.json migration, ConversationService swap (replaces ConversationHistory), Router /newchat /reset built-ins + /help dedup, full compose-runtime wiring + conversation-history deletion, persona + production integration tests, URS REQ-CONV-SESSION-001..014. Post-merge simplify pass: `resolveOrDefaultSessionKey` helper (DRY 3-call-site fallback), `buildFrontmatter` optional `startedAt` (DRY inline object), `.legacy-checked` sentinel (O(1) re-entry guard) + upgrade-compat scan (prevent duplicate import for pre-sentinel P3 users), dead `setActive` barrel export removed, stale `conversation-history` module imports in 3 test files fixed. Plan: `docs/superpowers/plans/can-you-start-on-wondrous-bentley.md` |
| Hermes P4 | Durable-memory snapshot + fenced recall | **Complete** | ~35 | `MemorySnapshot` frozen at session-mint via `ensureActiveSession` (before prompt assembly); persisted in session frontmatter (`memory_snapshot:` YAML, snake_case on disk / camelCase in TS). `buildMemoryContextBlock` + `sanitizeContextContent` fence utility (nested backtick collapse, role-tag neutralization). Layer 2: snapshot injected before `appendUserContextSection` inside `<memory-context label="durable-memory">` (tags outside fence). Layer 4: recalled `searchData` results wrapped in `<memory-context label="recalled-data">`. Per-turn ContextStore re-injection removed from `gatherContext`. `ensureActiveSession` replaces `ctx.sessionId` as `appendExchange` race guard. URS REQ-CONV-MEMORY-001..012. Chunks 0–F. Post-merge: simplify pass (byte-identical test bug, task-reference comments) + Codex corrections (`ensureActiveSession` fail-open, empty-session rollback on LLM failure, budget enforcement ≤4000 chars, `entryCount` = included count, sanitizer zero-width + case-insensitive tags). Plan: `docs/superpowers/plans/can-you-start-on-shimmying-mountain.md`. Spec: `docs/superpowers/specs/2026-04-28-hermes-p4-memory-snapshot-design.md` |
| Hermes P5 | SQLite + FTS5 transcript search | **Complete** | ~50 | Derived `data/system/chat-state.db` (sessions + messages + messages_fts FTS5 virtual table, PRAGMA user_version migrations, WAL + jittered retry). `ChatTranscriptIndex` read/write API: `upsertSession`, `appendMessage`, `endSession`, `deleteSession`, `searchSessions`, `listExpiredSessions`, `close()`. Live indexer hook in `ChatSessionStore` (awaited best-effort). Two-stage recall pipeline: sync `recallPreFilter` + fast-tier LLM `classifyRecallIntent` → `buildUntrustedQuery` FTS5 sanitizer → `searchSessions` → Layer 5 `<memory-context label="recalled-session">` injected before conversation history. Rebuild CLI (`pnpm chat-index-rebuild`) walks both household + legacy layouts; deletes DB before re-indexing (stale-session reconciliation). Opt-in retention: `auto_prune`, `retention_days` (1–3650); prune deletes `.md` + DB rows + sweeps `active-sessions.yaml` with user-scoped `Map<userId, Set<sessionId>>`. URS REQ-CONV-SEARCH-001..014. Chunks 0–H. Post-merge: Codex corrections (stale rebuild reconciliation, path-derived ownership authority, Layer 5 ordering before history, user-scoped prune sweep, lint gate clean). Plan: `docs/superpowers/plans/can-you-start-on-greedy-sunrise.md`. Spec: `docs/superpowers/specs/2026-04-28-hermes-p5-transcript-search-design.md` |
| Hermes P7 | Session auto-titling + NL /newchat classifier | **Complete** | ~35 | Session auto-titling (Chunk A): `TitleService` + `TitleGenerator` + `AutoTitleHook`; auto-title after first exchange (fire-and-forget); `/title` command (display/set); `skipIfTitled` guard; Markdown-canonical + SQLite-derived writes; title sanitization (control chars, whitespace collapse, 80-char truncation). NL /newchat (Chunk B): `SessionControlClassifier` keyword pre-filter (16 phrases) + fast-tier LLM; `PendingSessionControlStore` TTL store (5-minute expiry); grey-zone inline Telegram buttons (`sc:yes`/`sc:no`); opt-in at Router level. URS REQ-CONV-TITLE-001..008 + REQ-CONV-NEWCHAT-001..008. |
| Hermes P8a | Idle auto-reset — last_activity_at + runIdleResetHook + Router placement | **Complete** | ~40 | `last_activity_at` written to frontmatter on mint (= `started_at`) and bumped on every `appendExchange` (not bumped for already-ended sessions). `IdleDetector` computes elapsed time. `runIdleResetHook` ends idle session (reason `'idle'`), sends Telegram notice, returns `IdleResetState`. Router calls hook at `routeMessage` + `routePhoto` entry points (before routing). NL double-message guard suppresses `/newchat`/`/reset` when idle reset fires. `auto_reset_idle_minutes` user config. `endActive` CAS fix (index lock across get+verify+clear). `endActive` safe ordering (clearIndex only after transcript `ended_at` write succeeds). `formatDuration` rewritten with day/hour/minute parts. `IdleResetState` moved to `types/conversation-session.ts`. URS REQ-CONV-IDLE-001..010. |
| Hermes P8b | Memory flush on idle reset — SessionSummarizer + flushMemoryToContextStore + ContextStore integration | **Complete** | ~35 | Per-user opt-in toggle (`flush_memory_on_idle_reset`, default OFF) via `CONVERSATION_USER_CONFIG` + GUI + `<config-set>` LLM tag. `SessionSummarizer` (fast tier, `maxTokens=400`, `temperature=0`, tail 60 turns, 12k-char cap, JSON envelope, sanitization). `flushMemoryToContextStore` writes under rolling key `recent-session-summary`. CAS-first ordering (endActive before summarize); 8-second `Promise.race`/`AbortController` timeout; full fail-open. Disable cleanup: toggle-off deletes prior summary. `buildMemorySnapshot` extended with `pinnedKeys` (default `['recent-session-summary']`) guaranteeing inclusion in Layer 2 despite budget truncation. Bypass symbol (`CONTEXT_INTERNAL_BYPASS`) captured in compose-runtime closures. URS REQ-CONV-FLUSH-001..012. |
| Hermes P8c | Parent-session lineage — `parent_session_id` stamped on idle-reset successor sessions | **Complete** | ~25 | When `runIdleResetHook` ends a session, the next mint (via `ensureActiveSession` OR `appendExchange` cold-mint) stamps `parent_session_id` on the successor pointing to the ended session. `validateParentSessionId` enforces `SESSION_ID_RE` — malformed strings warn, non-strings silently coerce to null. Both `handleMessage` and `handleAsk` forward `idleResetState.endedSessionId` as `parentSessionId`. SQLite schema v1→v2: PRAGMA-checked idempotent ALTER TABLE + btree index `sessions_parent_session` for lineage walks. `SessionRowInput` makes `parent_session_id` optional input for back-compat. `chat-index-rebuild` propagates from frontmatter with format validation. URS REQ-CONV-LINEAGE-001..006. Post-merge Codex corrections (2026-05-04): P1 — `routePhoto` now captures `runIdleResetHook` return value; `dispatchPhoto` accepts `parentSessionId` param and forwards it to `appendExchange` cold-mint (photo post-idle-reset lineage); P2 — `appendExchange` calls in `handleMessage` and `handleAsk` now include `parentSessionId` conditional spread on the fail-open path (when `ensureActiveSession` rejects); P3 — `upsertSession` switched from `INSERT OR REPLACE` to `INSERT ... ON CONFLICT(id) DO UPDATE SET` excluding `parent_session_id` from SET clause — enforces set-once invariant at the SQLite layer (REQ-CONV-LINEAGE-007) and eliminates CASCADE-delete FTS orphan risk. |
| Hermes P9 | Photo Memory Bridge — session-aware photo transcript bridge + receipt date integrity | **Complete** | ~30 | Photo handlers return `{ photoSummary }` shape; `dispatchPhoto` resolves active session and calls `chatSessions.appendExchange`; `formatConversationHistory` exempts photo-summary turns from default truncation cap (2000-char whitelist, spoof-resistant); chatbot prompt updated with `PHOTO_SUMMARY_GUIDANCE`; `sanitizePhotoField` strips control chars + bidi + XML fence tags; receipt date integrity (`isValidReceiptDate`, `capturedAt` sort authority, `rawExtractedDate` persistence). URS REQ-CONV-PHOTO-001..005, REQ-FOOD-RECEIPT-001..002. Plan: `docs/superpowers/plans/2026-04-29-hermes-p9-photo-memory-bridge.md`. |
| Hermes P5 carry-forwards | `/recall` command + `<session-search>` pseudo-tool | **Complete** | ~170 | Closes P5 deferred items. `/recall <query>` — Router built-in (bypasses AppToggleStore); `handleRecall` → `searchSessions` (no `excludeSessionIds`; current session included by design); `formatRecallReply` (term-aware FTS5 highlight stripping, `escapeMarkdown`, full 23-char session id, per-hit 1500-char cap, `sendSplitResponse`). `<session-search query="..."/>` pseudo-tool — `SESSION_SEARCH_INSTRUCTION_BLOCK` injected into system prompt when intent regex matches AND `session_search_tool_enabled` config is on AND `hasSessionSearch()` is true; `extractSessionSearchTag` / `stripSessionSearchTags` at every exit path; single re-prompt loop: `buildToolContinuationPrompt` (fences userMessage + assistantPreTag via `buildMemoryContextBlock`, search results via `buildMemoryContextBlock`); second LLM call runs before existing post-processors; recursion cap (second-response tags stripped); `sessionSearchAllowed` gate prevents execution when intent regex didn't match (injection-prevention). `session_search_tool_enabled` user config key in `CONVERSATION_USER_CONFIG`, `ALLOWED_CONFIG_KEYS`, `INTENT_GATES`, `confirmationFor`. Codex corrections: P1 — intent-regex gate reused for execution (not just injection); continuation-prompt inputs fenced; P2 — try/catch narrowed to `searchSessions` only; empty-beforeTag fallback; integration test T2 made deterministic; P3 — `const retrieval` captured before Promise.all in both handlers; Minor — session-id backtick escape. URS REQ-CONV-RECALL-001..009, REQ-CONV-TOOL-SEARCH-001..012. 416 test files / 9306 tests. Plan: `docs/superpowers/plans/can-you-start-p5-steady-sketch.md`. Spec: `docs/superpowers/specs/2026-05-05-recall-and-session-search-design.md`. |

### Dependency Graph

```
Phase 0: Scaffolding
    │
Phase 1: Types + Manifest Schema
    │
    ├─────────────────┐
    │                 │
Phase 2: DataStore    Phase 4: LLM Service   ← can parallelize
    │                 │
    └────────┬────────┘
             │
Phase 3: EventBus + Scheduler + Condition Evaluator
             │
Phase 5: Telegram + Router + App Registry
             │
Phase 6: Echo App + E2E Tests
             │
    ┌────────┼────────┐
    │        │        │
Phase 7   Phase 8  Phase 9               ← can parallelize
Audio/Ctx   GUI    Docker/Users
```

---

## Phase 0: Project Scaffolding — COMPLETE

**Goal:** Monorepo structure, toolchain, and build pipeline.

**What was built:**

| File | Purpose |
|------|---------|
| `package.json` | Root workspace, pnpm scripts (build, lint, test, dev, scaffold-app) |
| `pnpm-workspace.yaml` | Declares `core/` and `apps/*` as workspace members |
| `tsconfig.base.json` | Strict TS 5, ESM, Node16 module resolution, composite |
| `biome.json` | Lint + format: tabs, single quotes, semicolons, trailing commas |
| `vitest.config.ts` | Root vitest config with `test.projects` |
| `.gitignore` | node_modules, dist, data/, .env |
| `.nvmrc` | Pins Node 22 |
| `.env.example` | All env vars documented |
| `CLAUDE.md` | Architecture decisions and conventions |
| `user_actions.md` | User action items tracker |
| `core/package.json` | `@pas/core` package |
| `core/tsconfig.json` | Extends base, `@core/*` path alias |
| `core/vitest.config.ts` | Core test config with alias resolution |
| `core/src/index.ts` | Barrel export placeholder |

**Verification:** `pnpm build` + `pnpm lint` + `pnpm test` all pass.

---

## Phase 1: Type System + Manifest Schema

**Goal:** Define every TypeScript interface and the JSON Schema for `manifest.yaml`. No runtime code — only types and one validation utility. Every subsequent phase imports from here.

**Depends on:** Phase 0

### Files to Create

```
core/src/types/
  index.ts                      # barrel re-export of all type modules
  app-module.ts                 # AppModule interface, CoreServices interface
  manifest.ts                   # AppManifest type (mirrors manifest.yaml structure)
  telegram.ts                   # MessageContext, PhotoContext, TelegramService interface
  llm.ts                        # LLMService interface (complete, classify, extractStructured)
  data-store.ts                 # DataStoreService, UserDataStore, SharedDataStore interfaces
  scheduler.ts                  # SchedulerService interface, ScheduledJob, OneOffTask
  condition.ts                  # ConditionEvaluatorService, Rule, RuleStatus
  events.ts                     # EventBusService interface
  audio.ts                      # AudioService interface (speak, tts)
  context-store.ts              # ContextStoreService interface (get, search)
  config.ts                     # AppConfigService interface, SystemConfig type
  users.ts                      # UserManager types, RegisteredUser

core/src/schemas/
  app-manifest.schema.json      # JSON Schema Draft 2020-12 for manifest.yaml
  validate-manifest.ts          # Ajv wrapper: validateManifest(obj) → result

core/src/schemas/__tests__/
  validate-manifest.test.ts     # tests with valid + invalid manifest fixtures
```

### Type Definitions (detailed)

#### `app-module.ts` — The Core Contract

This is the most critical file. It defines what every app must implement and what services they receive.

```typescript
// AppModule — what every app exports from index.ts
export interface AppModule {
  init(services: CoreServices): Promise<void>;
  handleMessage(ctx: MessageContext): Promise<void>;
  handlePhoto?(ctx: PhotoContext): Promise<void>;
  handleCommand?(command: string, args: string[], ctx: MessageContext): Promise<void>;
  shutdown?(): Promise<void>;
}

// CoreServices — what apps receive in init()
// Apps only get the services they declared in requirements.services
export interface CoreServices {
  telegram: TelegramService;
  llm: LLMService;
  data: DataStoreService;
  scheduler: SchedulerService;
  conditionEvaluator: ConditionEvaluatorService;
  audio: AudioService;
  eventBus: EventBusService;
  contextStore: ContextStoreService;
  config: AppConfigService;
  logger: AppLogger;
}
```

#### `telegram.ts` — Telegram Types

```typescript
export interface MessageContext {
  userId: string;
  text: string;
  timestamp: Date;
  chatId: number;
  messageId: number;
}

export interface PhotoContext {
  userId: string;
  photo: Buffer;
  caption?: string;
  mimeType: string;
  timestamp: Date;
  chatId: number;
  messageId: number;
}

export interface TelegramService {
  send(userId: string, message: string): Promise<void>;
  sendPhoto(userId: string, photo: Buffer, caption?: string): Promise<void>;
  sendOptions(userId: string, prompt: string, options: string[]): Promise<string>;
}
```

#### `llm.ts` — LLM Service Types

```typescript
export type LLMProvider = 'local' | 'claude';

export interface LLMCompletionOptions {
  model?: LLMProvider;
  temperature?: number;
  maxTokens?: number;
}

export interface ClassifyResult {
  category: string;
  confidence: number;
}

export interface LLMService {
  complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
  classify(text: string, categories: string[]): Promise<ClassifyResult>;
  extractStructured<T>(text: string, schema: object): Promise<T>;
}
```

#### `data-store.ts` — Data Store Types

```typescript
export interface UserDataStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(directory: string): Promise<string[]>;
  archive(path: string): Promise<void>;
}

// SharedDataStore has the same interface
export type SharedDataStore = UserDataStore;

export interface DataStoreService {
  forUser(userId: string): UserDataStore;
  forShared(scope: string): SharedDataStore;
}
```

#### `scheduler.ts` — Scheduler Types

```typescript
export interface ScheduledJob {
  id: string;
  appId: string;
  cron: string;
  handler: string;
  description: string;
  userScope: 'all' | 'shared' | 'system';
}

export interface OneOffTask {
  id: string;
  appId: string;
  jobId: string;
  runAt: Date;
  handler: string;
  createdAt: Date;
}

export interface SchedulerService {
  scheduleOnce(appId: string, jobId: string, runAt: Date, handler: string): Promise<void>;
  cancelOnce(appId: string, jobId: string): Promise<void>;
}
```

#### `condition.ts` — Condition Evaluator Types

```typescript
export interface Rule {
  id: string;
  condition: string;
  dataSources: string[];
  action: string;
  cooldown: string;         // e.g. "48 hours", "24 hours"
  cooldownMs: number;       // parsed milliseconds
  lastFired: Date | null;
  isFuzzy: boolean;         // true if rule ID has "fuzzy:" prefix
}

export interface RuleStatus {
  id: string;
  lastFired: Date | null;
  cooldownRemaining: number;  // ms until rule can fire again, 0 if ready
  isActive: boolean;
}

export interface ConditionEvaluatorService {
  evaluate(ruleId: string): Promise<boolean>;
  getRuleStatus(ruleId: string): Promise<RuleStatus>;
}
```

#### `events.ts` — Event Bus Types

```typescript
export interface EventBusService {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
  off(event: string, handler: (payload: unknown) => void | Promise<void>): void;
}
```

#### `audio.ts` — Audio Service Types

```typescript
export interface AudioService {
  speak(text: string, device?: string): Promise<void>;
  tts(text: string): Promise<Buffer>;
}
```

#### `context-store.ts` — Context Store Types

```typescript
export interface ContextEntry {
  key: string;
  content: string;
  lastUpdated: Date;
}

export interface ContextStoreService {
  get(key: string): Promise<string | null>;
  search(query: string): Promise<ContextEntry[]>;
}
```

#### `config.ts` — Config Types

```typescript
export interface SystemConfig {
  port: number;
  dataDir: string;
  logLevel: string;
  telegram: {
    botToken: string;
  };
  ollama: {
    url: string;
    model: string;
  };
  claude: {
    apiKey: string;
    model: string;
  };
  gui: {
    authToken: string;
  };
  cloudflare: {
    tunnelToken?: string;
  };
  users: RegisteredUser[];
}

export interface AppConfigService {
  get<T>(key: string): Promise<T>;
  getAll(): Promise<Record<string, unknown>>;
}
```

#### `users.ts` — User Types

```typescript
export interface RegisteredUser {
  id: string;                   // Telegram user ID
  name: string;                 // display name
  isAdmin: boolean;
  enabledApps: string[];        // app IDs enabled for this user
  sharedScopes: string[];       // shared scope IDs this user can access
}
```

#### `manifest.ts` — Manifest Types

This type must mirror the full manifest.yaml schema from PAS-APP-SPEC-001 Section 3.1:

```typescript
export interface AppManifest {
  app: {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    repository?: string;
  };
  capabilities?: {
    messages?: {
      intents?: string[];
      commands?: ManifestCommand[];
      accepts_photos?: boolean;
      photo_intents?: string[];
    };
    schedules?: ManifestSchedule[];
    rules?: {
      files?: string[];
    };
    events?: {
      emits?: ManifestEventEmit[];
      subscribes?: ManifestEventSubscribe[];
    };
  };
  requirements?: {
    services?: string[];
    external_apis?: ManifestExternalApi[];
    data?: {
      user_scopes?: ManifestDataScope[];
      shared_scopes?: ManifestDataScope[];
      context_reads?: string[];
    };
    integrations?: ManifestIntegration[];
  };
  user_config?: ManifestUserConfig[];
}

export interface ManifestCommand {
  name: string;
  description: string;
  args?: string[];
}

export interface ManifestSchedule {
  id: string;
  description: string;
  cron: string;
  handler: string;
  user_scope: 'all' | 'shared' | 'system';
}

export interface ManifestEventEmit {
  id: string;
  description: string;
  payload?: object;       // JSON Schema
}

export interface ManifestEventSubscribe {
  event: string;
  handler: string;
  required?: boolean;
}

export interface ManifestExternalApi {
  id: string;
  description: string;
  required: boolean;
  env_var: string;
  fallback_behavior?: string;
}

export interface ManifestDataScope {
  path: string;
  access: 'read' | 'write' | 'read-write';
  description: string;
}

export interface ManifestIntegration {
  app: string;
  description: string;
  required: boolean;      // must always be false per spec
}

export interface ManifestUserConfig {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  default: unknown;
  description: string;
  options?: string[];     // only for type: 'select'
}
```

### Manifest JSON Schema

`core/src/schemas/app-manifest.schema.json` — JSON Schema Draft 2020-12 that validates manifest.yaml files. Must enforce:

- `app.id`: required, string, pattern `^[a-z][a-z0-9-]*$`
- `app.name`: required, string, non-empty
- `app.version`: required, string, semver pattern
- `app.description`: required, string
- `app.author`: required, string
- All nested objects under `capabilities`, `requirements`, `user_config` match the types above
- `requirements.integrations[].required` must be `false`
- `capabilities.messages.commands[].name` must start with `/`
- `capabilities.schedules[].cron` must be a valid 5-field cron expression (validated by pattern)
- `user_config[].type` must be one of: `string`, `number`, `boolean`, `select`
- `user_config[].options` required only when `type` is `select`

### Manifest Validation

`core/src/schemas/validate-manifest.ts`:
- Install `ajv` and `ajv-formats` as dependencies of `@pas/core`
- Load the JSON Schema
- Export `validateManifest(data: unknown): { valid: true; manifest: AppManifest } | { valid: false; errors: string[] }`
- Errors should be human-readable strings, not raw Ajv error objects

### Tests

`core/src/schemas/__tests__/validate-manifest.test.ts`:
- Test with the echo app manifest from PAS-APP-SPEC-001 Section 13 (valid)
- Test with a full-featured manifest using all fields (valid)
- Test missing required fields: no `app.id`, no `app.name`, no `app.version`
- Test invalid patterns: bad semver, command not starting with `/`, invalid cron
- Test `integrations[].required: true` is rejected
- Test `user_config` with `type: 'select'` but no `options` is rejected

### Verification

- `pnpm build` compiles all types cleanly
- `pnpm test` passes manifest validation tests
- `pnpm lint` passes
- Importing `CoreServices` and implementing a mock satisfies the TypeScript compiler

---

## Phase 2: DataStore, Config, Logger

**Goal:** Three foundational services that almost everything else depends on: file-based data storage with scoping, system/app config loading, and structured logging.

**Depends on:** Phase 1 (types for DataStoreService, AppConfigService)

### Files to Create

```
core/src/services/
  data-store/
    index.ts                    # DataStoreService implementation
    scoped-store.ts             # UserDataStore/SharedDataStore impl
    change-log.ts               # tracks file modifications with timestamps
    paths.ts                    # path resolution + traversal protection

  config/
    index.ts                    # loads SystemConfig from config/pas.yaml + .env
    app-config-service.ts       # AppConfigService impl

  logger/
    index.ts                    # Pino logger setup, file transport

core/src/utils/
  file.ts                      # ensureDir, atomicWrite
  date.ts                      # date formatting for archives, timestamps
  yaml.ts                      # thin wrappers around `yaml` package

core/src/services/data-store/__tests__/
  scoped-store.test.ts          # all operations, scoping, path traversal rejection
  change-log.test.ts            # modification tracking tests
```

### New Dependencies

Add to `core/package.json` dependencies:
- `pino` ^9.x — structured logging
- `pino-pretty` ^13.x — dev-mode formatting
- `yaml` ^2.x — YAML parsing
- `dotenv` ^16.x — .env loading
- `envalid` ^8.x — env var validation

### Data Directory Structure

Per the URS (URS-DS-002):
```
data/
  users/
    <user_id>/
      <app_id>/
        *.md                    # per-user app data
    shared/
      <app_id>/
        *.md                    # shared app data
  system/
    logs/                       # Pino file transport destination
    llm-usage.md                # Claude API cost tracking
    scheduled-jobs.yaml         # one-off scheduler persistence
    context/                    # context store files
    rules/                      # system-level condition rules
    daily-diff/                 # daily change summaries
```

### Implementation Details

**DataStoreService (`index.ts`):**
- Constructor takes `dataDir` (from config) and an app's `manifest.data` scopes
- `forUser(userId)` → returns `ScopedStore` bound to `data/users/<userId>/<appId>/`
- `forShared(scope)` → returns `ScopedStore` bound to `data/users/shared/<appId>/`
- Validates that requested paths are within the app's declared scopes

**ScopedStore (`scoped-store.ts`):**
- `read(path)` — reads file, returns content string (empty string if file doesn't exist)
- `write(path, content)` — atomic write (write to `.tmp`, rename)
- `append(path, content)` — appends, creates file if missing
- `exists(path)` — returns boolean
- `list(directory)` — returns filenames in directory
- `archive(path)` — moves content to dated archive (preserves history per URS-DS-006)
- All operations log to change log

**Change Log (`change-log.ts`):**
- Tracks: timestamp, operation (read/write/append/archive), file path, app ID, user ID
- Written to `data/system/change-log.jsonl` (one JSON line per entry)
- Used by daily diff (Phase 7) to generate summaries (URS-DIFF-003)

**Path Resolution (`paths.ts`):**
- Resolves relative paths to absolute within the data directory
- **Path traversal protection:** resolved path must be under the expected scope directory
- Validates path against app's declared scopes from manifest

**Config (`config/index.ts`):**
- Loads `.env` via `dotenv`
- Validates required env vars via `envalid` (fails fast with clear messages)
- Loads `config/pas.yaml` for user config, shared scopes, app enablement
- Merges into `SystemConfig` type
- Exports a singleton config object

**Logger (`logger/index.ts`):**
- Creates Pino logger instance
- Dev mode: `pino-pretty` to stdout
- Production: JSON to stdout + file transport to `data/system/logs/`
- Child loggers per service/app: `logger.child({ service: 'router' })`

### Config File

Create `config/pas.yaml.example`:
```yaml
# PAS System Configuration
# Copy to config/pas.yaml and edit

users:
  - id: "123456789"            # Telegram user ID
    name: "Your Name"
    is_admin: true
    enabled_apps: ["*"]        # "*" = all apps
    shared_scopes: ["grocery", "family"]

  - id: "987654321"
    name: "Partner"
    is_admin: false
    enabled_apps: ["grocery", "family", "briefings"]
    shared_scopes: ["grocery", "family"]

# Default settings
defaults:
  log_level: info
  timezone: America/New_York
```

### Verification

- Unit tests for every DataStore method using temp directories
- Path traversal attacks rejected (e.g., `../../etc/passwd`)
- Scope enforcement: app can't access undeclared paths
- Change log records all write/append/archive operations
- Config loads from `.env` + `pas.yaml` fixture
- Logger outputs structured JSON

---

## Phase 3: Event Bus, Scheduler, Condition Evaluator

**Goal:** Three plumbing services for app coordination, timed execution, and rule-based alerting.

**Depends on:** Phase 1 (types), Phase 2 (DataStore for rule files + one-off YAML, Logger)

### Files to Create

```
core/src/services/
  event-bus/
    index.ts                    # Emittery wrapper, typed event map

  scheduler/
    index.ts                    # SchedulerService: manages cron + one-off jobs
    cron-manager.ts             # node-cron wrapper, reads schedules from manifests
    oneoff-manager.ts           # one-off jobs stored in data/system/scheduled-jobs.yaml
    task-runner.ts              # executes handler with try/catch isolation

  condition-evaluator/
    index.ts                    # ConditionEvaluatorService implementation
    rule-parser.ts              # parses markdown rule files
    evaluator.ts                # deterministic + fuzzy checks
    cooldown-tracker.ts         # cooldown window management

core/src/services/event-bus/__tests__/
  event-bus.test.ts

core/src/services/scheduler/__tests__/
  cron-manager.test.ts
  oneoff-manager.test.ts

core/src/services/condition-evaluator/__tests__/
  rule-parser.test.ts
  evaluator.test.ts
```

### New Dependencies

Add to `core/package.json`:
- `emittery` ^1.x — typed async event emitter
- `node-cron` ^3.x — cron expression parsing and scheduling

### Implementation Details

**Event Bus (`event-bus/index.ts`):**
- Wraps Emittery with typed event names
- `emit(event, payload)` — fire-and-forget, subscriber failures don't affect emitter (URS-EVT-003)
- `on(event, handler)` — register handler
- `off(event, handler)` — unregister
- Logs all emitted events for debugging (URS-EVT-004)
- Event subscriptions auto-wired from manifests at startup (URS-EVT-002)

**Scheduler (`scheduler/index.ts`):**
- `registerFromManifest(manifest)` — reads `capabilities.schedules[]`, sets up cron jobs
- `scheduleOnce(appId, jobId, runAt, handler)` — dynamic one-off scheduling
- `cancelOnce(appId, jobId)` — cancel pending one-off
- `start()` / `stop()` — lifecycle management

**Cron Manager (`scheduler/cron-manager.ts`):**
- Uses `node-cron` for standard 5-field cron (URS-SCH-002)
- Each job wrapped in task-runner for isolation
- Logs start time, end time, success/failure (URS-SCH-004)

**One-Off Manager (`scheduler/oneoff-manager.ts`):**
- Stores pending one-off tasks in `data/system/scheduled-jobs.yaml`
- Checks on 1-minute interval (per tech spec)
- Fires matching tasks, removes from YAML after execution
- Survives restarts by reading YAML on startup

**Task Runner (`scheduler/task-runner.ts`):**
- Wraps handler execution in try/catch
- On failure: logs error, sends Telegram notification to admin (URS-SCH-005)
- Failed jobs don't prevent other jobs from running

**Condition Evaluator (`condition-evaluator/index.ts`):**
- Runs on configurable schedule (default: every 15 minutes for deterministic, URS-CE-003)
- LLM holistic scan: once or twice daily via Claude API (URS-CE-006)
- `evaluate(ruleId)` — programmatic check
- `getRuleStatus(ruleId)` — last fired, cooldown remaining

**Rule Parser (`condition-evaluator/rule-parser.ts`):**
- Parses markdown rule files in this format (from PAS-APP-SPEC-001 Section 7):
  ```markdown
  ## rule-id
  - **Condition:** human-readable expression
  - **Data:** `path/to/data.md`
  - **Action:** Send Telegram message: "..."
  - **Cooldown:** 48 hours
  - **Last fired:** 2026-02-25T18:00:00Z
  ```
- `fuzzy:` prefix on rule ID → `isFuzzy: true` (uses local LLM)
- Returns `Rule[]` typed objects

**Evaluator (`condition-evaluator/evaluator.ts`):**
- Deterministic checks: reads data from DataStore, compares against condition
- Fuzzy checks: delegates condition text + data to LLM for interpretation
- Respects cooldowns: rule won't fire if within cooldown window (URS-CE-007)
- Updates `Last fired` timestamp in the rule file after firing

**Cooldown Tracker (`condition-evaluator/cooldown-tracker.ts`):**
- Parses cooldown strings ("48 hours", "24 hours", "7 days")
- Tracks last-fired timestamps
- `canFire(ruleId)` → boolean

### Verification

- Event bus: emit/subscribe/unsubscribe with typed events, subscriber failures isolated
- Scheduler: cron registration fires at expected times (vitest fake timers), one-off scheduling YAML round-trip
- Rule parser: handles all rule variants (deterministic, fuzzy, never-fired)
- Evaluator: deterministic conditions pass/fail correctly, cooldowns respected
- Task runner: failures logged, other tasks unaffected

### Completion Notes

**Status:** Complete (2026-02-27)

**Dependencies installed:**
- `emittery` ^1.1.0 — typed async event emitter
- `node-cron` ^4.2.1 — cron scheduling (v4, not v3 from original plan)

**Notable decisions:**
- Used `cron.createTask()` instead of `cron.schedule()` — node-cron v4 removed the `scheduled: false` option; `createTask()` creates tasks without auto-starting
- Removed `@types/node-cron` — v4 ships its own TypeScript definitions
- Event bus wraps each handler in try/catch for subscriber isolation (URS-EVT-003)
- One-off manager persists tasks to YAML and checks on 1-minute interval
- Condition evaluator supports 6 deterministic patterns: `not empty`, `is empty`, `contains "X"`, `not contains "X"`, `line count > N`, `line count < N`
- Fuzzy conditions (`fuzzy:` prefix) delegate to LLM — tested but LLM service not yet available (Phase 4)

**Test coverage:** 40 new tests (97 total across all phases)

---

## Phase 4: LLM Service

**Goal:** Dual-backend LLM service (Ollama local + Claude API remote) with classify, complete, extractStructured.

**Depends on:** Phase 1 (types), Phase 2 (config for API keys, logger)

**Note:** Phase 4 and Phase 2 are independent (both only depend on Phase 1) and CAN be built in parallel.

### Files to Create

```
core/src/services/
  llm/
    index.ts                    # LLMService impl, routes to correct backend
    ollama-client.ts            # Ollama REST API client (uses `ollama` npm package)
    claude-client.ts            # @anthropic-ai/sdk wrapper
    classify.ts                 # classify(text, categories) → always local model
    extract-structured.ts       # extractStructured(text, schema) → always local
    prompt-templates.ts         # reusable prompt builders
    cost-tracker.ts             # logs Claude API calls to data/system/llm-usage.md
    retry.ts                    # configurable retry with backoff

core/src/services/llm/__tests__/
  llm-service.test.ts           # tests with mocked HTTP
  classify.test.ts
  cost-tracker.test.ts
```

### New Dependencies

Add to `core/package.json`:
- `ollama` ^0.5.x — official Ollama npm client
- `@anthropic-ai/sdk` ^0.39.x — official Anthropic TypeScript SDK

### Implementation Details

**LLMService (`llm/index.ts`):**
- `complete(prompt, options?)` — routes to Ollama or Claude based on `options.model`
- Default model: `local` (Ollama)
- `classify(text, categories)` — **always** uses local model (URS-LLM-003)
- `extractStructured(text, schema)` — **always** uses local model
- Handles connection failures gracefully (URS-LLM-004)

**Ollama Client (`llm/ollama-client.ts`):**
- Uses `ollama` npm package
- Connects to URL from config (`OLLAMA_URL`, default `http://ollama:11434`)
- Model from config (`OLLAMA_MODEL`, default `llama3.2:3b`)
- Timeout handling

**Claude Client (`llm/claude-client.ts`):**
- Uses `@anthropic-ai/sdk`
- API key from config (`ANTHROPIC_API_KEY`)
- Model from config (`CLAUDE_MODEL`, default `claude-sonnet-4-20250514`)
- Apps can request `claude-opus-4-6` for max reasoning
- Logs every call to cost tracker (URS-LLM-005)

**Classify (`llm/classify.ts`):**
- Builds a classification prompt: given text and categories, asks LLM to pick one
- Parses response to extract category and confidence score
- Returns `ClassifyResult { category, confidence }`

**Extract Structured (`llm/extract-structured.ts`):**
- Builds a structured extraction prompt with JSON schema
- Asks LLM to return JSON matching the schema
- Parses and validates response

**Cost Tracker (`llm/cost-tracker.ts`):**
- Logs each Claude API call: timestamp, model, input tokens, output tokens, estimated cost
- Appends to `data/system/llm-usage.md` in a table format
- Daily totals available for management GUI

**Retry (`llm/retry.ts`):**
- Configurable max retries and backoff
- **Ollama failure does NOT silently fall back to Claude** (URS-LLM-004)
- Fails with a clear error message

### Verification

- Unit tests with mocked HTTP responses for both backends
- Classification: given text and categories, returns correct category
- Structured extraction: returns parsed object matching schema
- Retry: simulated failure retries correctly, no silent fallback
- Cost tracker: writes entries to llm-usage.md

### Completion Notes

**Status:** Complete (2026-02-27)

**Dependencies installed:**
- `ollama` ^0.6.3 — official Ollama npm client
- `@anthropic-ai/sdk` ^0.78.0 — official Anthropic TypeScript SDK

**Files created:**
- `llm/retry.ts` — configurable retry with exponential backoff
- `llm/prompt-templates.ts` — prompt builders for classify and extract
- `llm/cost-tracker.ts` — logs Claude API calls to `data/system/llm-usage.md` (markdown table)
- `llm/ollama-client.ts` — wraps `ollama` package, connects to configurable URL/model
- `llm/claude-client.ts` — wraps `@anthropic-ai/sdk`, logs every call to cost tracker
- `llm/classify.ts` — text classification with JSON parsing + text-matching fallback
- `llm/extract-structured.ts` — structured extraction with JSON/code-block parsing
- `llm/index.ts` — LLMServiceImpl routing to Ollama (default) or Claude

**Notable decisions:**
- Ollama failure does NOT fall back to Claude — throws with clear error (URS-LLM-004)
- classify() and extractStructured() always use local Ollama (URS-LLM-003)
- Classification response parser has 3-tier fallback: JSON parsing → text matching → first category
- Cost tracker writes markdown table to `data/system/llm-usage.md` with per-model pricing
- Retry utility is generic (`withRetry<T>()`) and reusable across both clients
- Both clients are mockable — tests use `vi.mock()` for clean unit testing

**Test coverage:** 35 new tests (160 total across all phases)

---

## Phase 5: Telegram Gateway, Router, App Registry — COMPLETE

**Goal:** Connect user input to app handlers. The central nervous system of the platform.

**Status:** Complete — 26 new files (15 source + 11 tests), 97 new tests (257 total), all passing.

**Depends on:** Phase 1 (types), Phase 2 (DataStore, Config, Logger), Phase 3 (EventBus, Scheduler), Phase 4 (LLM for classification)

### Files to Create

```
core/src/services/
  telegram/
    index.ts                    # TelegramService: send, sendPhoto, sendOptions
    bot.ts                      # grammY Bot setup, webhook mode
    message-adapter.ts          # grammY context → MessageContext / PhotoContext

  router/
    index.ts                    # Router: classifies and dispatches messages
    command-parser.ts           # detects /commands, matches against registry
    intent-classifier.ts        # uses LLMService.classify() for free text
    photo-classifier.ts         # classifies photo type via LLM
    fallback.ts                 # unrecognized → append to daily notes (URS-RT-005)

  app-registry/
    index.ts                    # AppRegistry: discovers, validates, loads apps
    loader.ts                   # scans apps/*/manifest.yaml, dynamic imports
    manifest-cache.ts           # in-memory cache of loaded manifests

core/src/server/
  index.ts                      # Fastify server setup
  webhook.ts                    # POST /webhook/telegram route
  health.ts                     # GET /health route

core/src/bootstrap.ts           # main() — wires all services, starts server

core/src/services/router/__tests__/
  command-parser.test.ts
  intent-classifier.test.ts
  router.test.ts

core/src/services/app-registry/__tests__/
  loader.test.ts
  registry.test.ts
```

### New Dependencies

Add to `core/package.json`:
- `fastify` ^5.x — web framework
- `grammy` ^1.x — Telegram bot framework
- `chokidar` ^4.x — file watching for app directory hot-reload

### Implementation Details

**Telegram Service (`telegram/index.ts`):**
- `send(userId, message)` — sends text via grammY bot API (supports Telegram Markdown)
- `sendPhoto(userId, photo, caption?)` — sends photo buffer with optional caption
- `sendOptions(userId, prompt, options[])` — sends inline keyboard, returns selected option
- All methods resolve `userId` to Telegram chat ID

**Bot (`telegram/bot.ts`):**
- Creates grammY `Bot` instance with bot token from config
- Configures webhook mode (not polling — we're behind Cloudflare Tunnel)
- Middleware pipeline: message → adapter → router → app

**Message Adapter (`telegram/message-adapter.ts`):**
- Converts grammY's `Context` object to `MessageContext` or `PhotoContext`
- Extracts: userId, text/photo, caption, timestamp, chatId, messageId

**Router (`router/index.ts`):**
- Priority order (URS-RT-002):
  1. Explicit `/command` → exact match against registered commands
  2. Photo messages → classify type, match `photo_intents`
  3. Free text → LLM classification against all apps' `intents`
  4. Fallback → append to daily notes
- Command/intent tables auto-generated from manifests (URS-RT-003)
- Uses ONLY local LLM for classification (URS-RT-006)
- Configurable confidence threshold for fallback (URS-RT-004)

**Command Parser (`router/command-parser.ts`):**
- Detects messages starting with `/`
- Parses command name and arguments
- Looks up command in registry (O(1) map lookup)
- Rejects unknown commands with helpful message

**Intent Classifier (`router/intent-classifier.ts`):**
- Builds category list from all apps' `intents`
- Calls `LLMService.classify(text, categories)`
- Returns matched app ID + confidence

**Photo Classifier (`router/photo-classifier.ts`):**
- Classifies photo type using LLM
- Matches against registered `photo_intents`
- Falls back if no match

**Fallback (`router/fallback.ts`):**
- Timestamps the message
- Appends to `data/users/<userId>/daily-notes/<date>.md`
- Sends user a brief acknowledgment (URS-RT-005 — no message silently discarded)

**App Registry (`app-registry/index.ts`):**
- `loadAll()` — scans `apps/*/manifest.yaml`, validates, loads
- `getApp(appId)` — returns loaded AppModule
- `getManifests()` — returns all cached manifests
- `getCommandMap()` — maps `/command` → appId
- `getIntentCategories()` — returns all apps' intents for classification

**Loader (`app-registry/loader.ts`):**
- Scans `apps/` directory for subdirs with `manifest.yaml`
- Validates each manifest via `validateManifest()`
- Invalid manifests: logged and skipped (URS-NF-014)
- Dynamic imports app module: `import(appPath)`
- Builds scoped `CoreServices` (only declared services)
- Calls `app.init(scopedServices)`

**Fastify Server (`server/index.ts`):**
- Creates Fastify instance with Pino logger
- Registers webhook route and health check
- Will later host GUI routes (Phase 8)

**Bootstrap (`bootstrap.ts`):**
- `main()` function — the composition root
- Creates all service instances in dependency order:
  1. Logger
  2. Config
  3. DataStore
  4. EventBus
  5. LLM Service
  6. Scheduler
  7. Condition Evaluator
  8. Context Store (stub until Phase 7)
  9. Audio Service (stub until Phase 7)
  10. Telegram Service
  11. Router
  12. App Registry → loads all apps
  13. Fastify Server → starts listening
- Registers graceful shutdown (SIGTERM/SIGINT)

### Verification

- Command parser: `/echo hello` dispatches to echo app
- Intent classifier: "add milk" with grocery intents → routes correctly (mocked LLM)
- Router: full message flow from webhook to app handler
- App registry: loads valid apps, skips invalid, calls init
- Fallback: unrecognized message appended to daily notes
- Fastify health check returns 200
- Integration test: simulated webhook payload → echo app → response

---

## Phase 6: Echo App + E2E Integration

**Goal:** First working app proving the full pipeline. Also creates reusable test utilities.

**Depends on:** All of Phases 0–5

### Files to Create

```
apps/echo/
  manifest.yaml                 # from PAS-APP-SPEC-001 Section 13
  index.ts                      # AppModule implementation
  package.json                  # @pas/echo
  README.md
  tsconfig.json
  tests/
    echo.test.ts                # unit test with mock CoreServices

core/src/testing/
  mock-services.ts              # reusable mock CoreServices factory
  test-helpers.ts               # simulateTelegramMessage, createTestRegistry
```

### Echo App Details (from PAS-APP-SPEC-001 Section 13)

**manifest.yaml:**
```yaml
app:
  id: echo
  name: "Echo"
  version: "1.0.0"
  description: "Echoes your messages back. A minimal example app."
  author: "PAS Team"

capabilities:
  messages:
    intents:
      - "echo"
      - "repeat"
    commands:
      - name: /echo
        description: "Echo back your message"
        args: ["message"]

requirements:
  services:
    - telegram
    - data-store
  data:
    user_scopes:
      - path: "log.md"
        access: read-write
        description: "Message echo log"
```

**index.ts:**
- `init(services)` — stores services reference
- `handleMessage(ctx)` — echoes text back, appends to log
- `handleCommand('/echo', args, ctx)` — echoes args back

### E2E Test Flow

1. Create all services (real DataStore on temp dir, mocked Telegram/LLM)
2. Load echo app via app registry
3. Simulate incoming Telegram webhook
4. Assert: router classifies → routes to echo → echo calls `telegram.send()`
5. Assert: `data/users/<testUser>/echo/log.md` contains the message

### Mock Services Factory

`core/src/testing/mock-services.ts` — reusable by all future app tests:
- Creates mock implementations of every CoreService
- Uses vitest `vi.fn()` for all methods
- Configurable overrides for specific behaviors
- DataStore backed by real temp filesystem for integration tests

### Verification

- Echo unit tests pass with mock services
- Full E2E test: webhook → router → echo → response + data file written
- Mock services factory type-checks against CoreServices interface
- `pnpm build && pnpm lint && pnpm test` all pass

---

## Phase 7: Context Store, Audio, Daily Diff ✅

**Status:** Complete

**Goal:** Build the remaining three services.

**Depends on:** Phase 2 (DataStore), Phase 3 (Scheduler, EventBus), Phase 4 (LLM for summarizer)

### Files to Create

```
core/src/services/
  context-store/
    index.ts                    # ContextStoreService: get(key), search(query)
    store.ts                    # reads markdown files from data/system/context/

  audio/
    index.ts                    # AudioService: speak(text, device?), tts(text)
    piper-tts.ts                # spawns Piper TTS subprocess → WAV
    ffmpeg.ts                   # WAV → MP3 conversion
    chromecast.ts               # spawns pychromecast Python script

  daily-diff/
    index.ts                    # generates nightly change summary
    collector.ts                # reads DataStore change log
    summarizer.ts               # optional LLM summary

scripts/
  cast.py                       # Python script for pychromecast playback

core/src/services/context-store/__tests__/
  context-store.test.ts

core/src/services/audio/__tests__/
  audio-service.test.ts

core/src/services/daily-diff/__tests__/
  collector.test.ts
```

### Implementation Details

**Context Store (`context-store/store.ts`):**
- Organized as markdown files by topic in `data/system/context/`:
  - `food-preferences.md`
  - `pantry-staples.md`
  - `fitness-context.md`
  - `schedule-patterns.md`
  - `interest-profiles.md`
- `get(key)` — reads file matching key name, returns content or null
- `search(query)` — searches across all context files for matching content
- Read-only for all apps except the memory app (URS-CTX-003)
- Files are user-editable plain markdown (URS-CTX-004)

**Audio Service (`audio/index.ts`):**
- `tts(text)` → spawns Piper TTS, returns audio Buffer
- `speak(text, device?)` → tts + ffmpeg WAV→MP3 + cast to Chromecast
- Best-effort, non-blocking (URS-AUD-004)
- Graceful degradation: logs failure, doesn't retry or block

**Piper TTS (`audio/piper-tts.ts`):**
- Spawns Piper binary via `child_process.execFile`
- Default voice: `en_US-lessac-medium`
- Output: WAV file to temp directory

**FFmpeg (`audio/ffmpeg.ts`):**
- Converts WAV → MP3 via `child_process.execFile('ffmpeg', ...)`
- Required because Chromecast prefers MP3

**Chromecast (`audio/chromecast.ts`):**
- Spawns `scripts/cast.py` via `child_process.execFile`
- Passes audio file path and target device name
- Python script handles device discovery and playback

**Daily Diff (`daily-diff/index.ts`):**
- Scheduled cron job (default: runs nightly)
- `collector` reads change log (from Phase 2) for last 24 hours
- Groups changes by app and user
- `summarizer` optionally sends to Claude for natural language summary
- Writes summary to `data/system/daily-diff/<date>.md`
- Available for briefing apps to include in reports (URS-DIFF-002)

### Verification

- Context store: get by key, search by query, null for missing keys
- Audio: mock subprocess calls, verify correct Piper/ffmpeg/cast arguments
- Daily diff: collector finds changed files from fixture change log

---

## Phase 8: Management GUI ✅

**Goal:** Web dashboard for system administration using htmx + Pico CSS.

**Depends on:** Phase 5 (Fastify server, AppRegistry), Phase 2 (Config), Phase 3 (Scheduler)

### Files to Create

```
core/src/gui/
  index.ts                      # registers all GUI routes on Fastify
  auth.ts                       # GUI_AUTH_TOKEN middleware, cookie-based

  routes/
    dashboard.ts                # GET / — system overview
    apps.ts                     # GET/POST /apps — list, enable/disable per user
    scheduler.ts                # GET /scheduler — job history, status
    logs.ts                     # GET /logs — log viewer (htmx auto-refresh)
    config.ts                   # GET/POST /config — system + app config
    llm-usage.ts                # GET /llm — Claude API cost tracking

  views/
    layout.eta                  # base HTML: Pico CSS, htmx, nav
    login.eta                   # token entry page
    dashboard.eta               # overview partial
    apps-list.eta               # app list partial
    app-detail.eta              # single app detail
    scheduler.eta               # scheduler view
    logs.eta                    # log viewer
    config.eta                  # config editor

  public/
    htmx.min.js                 # htmx 2.x served locally
    pico.min.css                # Pico CSS 2.x served locally
```

### New Dependencies

Add to `core/package.json`:
- `@fastify/view` ^10.x — server-side template rendering
- `@fastify/static` ^8.x — static file serving
- `@fastify/cookie` ^11.x — auth cookie management
- `eta` ^3.x — template engine

### Implementation Details

**Auth (`gui/auth.ts`):**
- `GUI_AUTH_TOKEN` env var is the shared secret
- Login page (`/login`) accepts the token
- On valid token: sets HTTP-only cookie
- Middleware validates cookie on every request
- Invalid/missing → redirect to login

**Dashboard (`routes/dashboard.ts`):**
- System uptime
- Number of loaded apps (total, enabled, disabled)
- Last message received timestamp
- Recent scheduler job results
- Ollama status (connected/disconnected)
- LLM usage summary (today's Claude API cost)

**Apps (`routes/apps.ts`):**
- List all registered apps with: name, description, version, status
- Per-user enable/disable toggle (`hx-post` with htmx swap)
- App detail page: full manifest info, config options, data files

**Scheduler (`routes/scheduler.ts`):**
- List all cron jobs with: app, schedule, last run, next run, status
- List pending one-off tasks
- Job execution history (last N runs)

**Logs (`routes/logs.ts`):**
- Recent log entries (read from Pino log file)
- Auto-refresh via `hx-trigger="every 5s"` (htmx polling)
- Filter by level (info, warn, error)

**Config (`routes/config.ts`):**
- View/edit system config values
- View/edit per-user app config values
- Form submission via `hx-post`

**LLM Usage (`routes/llm-usage.ts`):**
- Read from `data/system/llm-usage.md`
- Show daily/weekly/monthly Claude API costs
- Token usage breakdown by app

**Views (Eta templates):**
- `layout.eta` — base HTML with `<head>` (Pico CSS, htmx), `<nav>`, content slot
- Each page is a partial rendered into the layout
- htmx attributes on interactive elements for partial page updates
- No client-side JavaScript beyond htmx

### Verification

- Auth: rejects wrong token, accepts correct token, sets cookie
- Each route returns 200 with valid HTML
- Dashboard renders real data from loaded services
- App toggle via htmx works
- Log viewer auto-refreshes

---

## Phase 9: Docker, Multi-User, Production Hardening

**Goal:** Deployable via `docker compose up`. Multi-user support. Error isolation.

**Depends on:** All previous phases

### Files to Create

```
Dockerfile                      # multi-stage Node 22 Alpine + Python 3.11 + ffmpeg + Piper
docker-compose.yml              # core + ollama containers
docker-compose.dev.yml          # dev overrides (source mount, tsx watch)
.dockerignore

config/
  pas.yaml                      # default system config (copy of example)

core/src/services/
  user-manager/
    index.ts                    # user registration, lookup, validation
    user-guard.ts               # rejects unregistered Telegram users

core/src/middleware/
  error-handler.ts              # global error boundary
  rate-limiter.ts               # per-user rate limiting
  shutdown.ts                   # graceful shutdown handler

core/src/services/user-manager/__tests__/
  user-guard.test.ts
```

### Implementation Details

**Dockerfile (multi-stage):**
```dockerfile
# Stage 1: Build
FROM node:22-alpine AS build
# Install pnpm, copy source, pnpm install, tsc --build

# Stage 2: Runtime
FROM node:22-alpine
# Install Python 3.11, pychromecast, zeroconf, piper-tts, ffmpeg
# Copy built output + production node_modules from stage 1
# CMD ["node", "core/dist/bootstrap.js"]
```

**docker-compose.yml:**
```yaml
services:
  core:
    build: .
    ports: []                   # no ports exposed (Cloudflare Tunnel)
    volumes:
      - ./data:/app/data        # persistent data
    env_file: .env
    depends_on:
      ollama:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s

  ollama:
    image: ollama/ollama
    volumes:
      - ollama-models:/root/.ollama
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:11434"]
      interval: 30s
      timeout: 5s

volumes:
  ollama-models:
```

**User Manager (`user-manager/index.ts`):**
- Reads registered users from `config/pas.yaml`
- `getUser(telegramId)` → RegisteredUser or null
- `isRegistered(telegramId)` → boolean
- `getUserApps(telegramId)` → enabled app IDs
- `getSharedScopes(telegramId)` → shared scope IDs

**User Guard (`user-manager/user-guard.ts`):**
- Middleware in the Telegram message pipeline
- Checks if sender's Telegram ID is in registered users
- Unregistered: sends configurable rejection message (URS-GW-006)
- Registered but app not enabled: sends "this feature isn't enabled for you"

**Error Handler (`middleware/error-handler.ts`):**
- Global uncaught exception / unhandled rejection handlers
- App-level errors caught and logged — never crash the system (URS-NF-013)
- Sends user a "something went wrong" message on app errors

**Rate Limiter (`middleware/rate-limiter.ts`):**
- Per-user in-memory rate limiting
- Configurable messages per minute
- Excess messages get a "please slow down" response

**Graceful Shutdown (`middleware/shutdown.ts`):**
- SIGTERM/SIGINT handlers
- Stop accepting new webhooks
- Wait for in-flight handlers to complete
- Save scheduler one-off tasks to YAML
- Flush logger
- Close Fastify server
- Call `shutdown()` on all loaded apps

### Security Hardening (from Phase 5 review)

The following security items were identified during Phase 5 code review and are deferred to this phase:

**LLM Prompt Injection Hardening:**
- Router passes raw user text to `llm.classify()` for intent classification
- A crafted message could potentially trick the local LLM into misclassifying intents
- Impact is limited (wrong routing, not data exfiltration) since app handlers are error-isolated
- Mitigation: sanitize/truncate user input before classification; verify the classify prompt structure resists injection; add input length limits

**Rate Limiting on Webhook Endpoint:**
- The webhook endpoint has no rate limiting — an attacker who discovers the URL could flood it
- Currently mitigated by Cloudflare Tunnel (external access control)
- Implement per-IP and per-user rate limiting in `middleware/rate-limiter.ts`

**Markdown Injection in Error Messages:**
- Router embeds user-controlled text (e.g. `parsed.command`) in Markdown-formatted messages
- Telegram handles parse errors gracefully (falls back to plain text), so not exploitable
- Consider escaping Markdown special characters in user-facing error messages

**Config Validation:**
- No validation that `config.users` contains valid Telegram user IDs or that `enabledApps` references valid app IDs
- Add startup validation that warns about invalid or stale user config entries

**Phase 7 Security Items (from Phase 7 review):**
- Daily diff summarizer: sanitize/escape appId, userId, file paths before interpolating into LLM prompt (currently system-controlled data, low risk)
- Daily diff collector: consider streaming readline for large change log files instead of loading entire file into memory
- Audio service: validate Chromecast device names (alphanumeric + spaces only)

**Phase 8 Security Items (from Phase 8 review):**

*CSRF Protection (HIGH):*
- GUI POST routes (`/gui/apps/:appId/toggle`, `/gui/config/:appId/:userId`, `/gui/login`, `/gui/logout`) lack CSRF token validation
- An attacker could trigger state-changing actions if admin visits a malicious page while logged in
- Implement CSRF tokens: generate in GET requests, include as hidden form field, validate in POST handlers
- Consider `@fastify/csrf-protection` plugin or custom double-submit cookie pattern

*Rate Limiting on Login (HIGH):*
- `/gui/login` POST has no rate limiting — brute-force attacks on the auth token are possible
- Token comparison uses `timingSafeEqual` (good), but unlimited attempts negate this
- Add rate limiting: 5 attempts per IP per 15 minutes via `@fastify/rate-limit` or custom middleware

*Large Log File Handling (MEDIUM):*
- `logs.ts` reads the entire log file into memory with `readFile()` before processing
- Production log files could grow very large, causing memory pressure
- Implement streaming readline (read from end of file) or file size cap with rotation awareness

*Config POST Input Validation (MEDIUM):*
- `/gui/config/:appId/:userId` accepts arbitrary key-value pairs without validating against the app manifest's `user_config` schema
- Body cast as `Record<string, string>` but manifest may define numeric/boolean types
- Validate submitted keys exist in manifest `user_config` definitions; coerce types to match `type` field

*YAML Key Injection (LOW):*
- `AppToggleStore.setEnabled()` and `AppConfigServiceImpl.setAll()` use userId/appId as YAML keys without validation
- If these contain YAML special characters (`:`, `|`, `>`), file structure could be corrupted
- Both values come from system config (admin-controlled) and manifest (developer-controlled), so risk is low
- Consider allowlist validation: `^[a-z0-9-]+$` for appId, `^[0-9]+$` for userId

*AppConfigService Per-Request Instantiation (LOW):*
- Config GET and POST routes create new `AppConfigServiceImpl` instances per request
- This works but is wasteful; consider caching or reusing instances from bootstrap

*Prompt Injection via Log Display (LOW):*
- Log messages from apps are displayed in the GUI log viewer
- If an app logs user-controlled content (e.g., Telegram message text), that content appears in the admin GUI
- Eta templates auto-escape `<%= %>` output and htmx partials use `escapeHtml()`, so HTML/JS injection is mitigated
- Monitor for any future raw output (`<%~ %>`) additions in log-related templates

**Phase 8 Feature Gaps (deferred — not blocking):**
- Dashboard: "Last message received timestamp" not implemented (router doesn't track this)
- Dashboard: "Today's Claude API cost" summary not on dashboard (available on LLM page)
- Scheduler: Cron job "last run / next run / status" not shown (scheduler doesn't track execution history)
- Scheduler: "Job execution history (last N runs)" not implemented (no history store)

### Verification

- `docker compose build` succeeds
- `docker compose up` starts core + ollama, health checks pass
- User guard: authorized user processed, unauthorized rejected
- Error handler: app exception logged, user gets error message, system stays up
- Rate limiter: rapid messages throttled
- Graceful shutdown: SIGTERM → one-off tasks saved, clean exit
- LLM classify input sanitization: overly long or adversarial inputs handled gracefully

---

## Post-Infrastructure Phases

Phases 10-15 implement multi-provider LLM support. See `.claude/plans/jiggly-jingling-liskov.md` for detailed plans.

Phases 16-18 add the chatbot fallback and app sharing foundation. See `docs/app-sharing-vision.md` for the full design.

---

## Phase 16: Chatbot Fallback App — **Complete**

**Goal:** Replace the daily-notes-only fallback with a full conversational AI chatbot.

**Depends on:** Phase 13 (LLM cost safeguards — chatbot needs cost caps to prevent runaway spending)

**Files created:**
- `apps/chatbot/manifest.yaml` — app manifest (no intents, llm+context-store+data-store services)
- `apps/chatbot/package.json` — app package
- `apps/chatbot/tsconfig.json` — TypeScript config
- `apps/chatbot/vitest.config.ts` — test config
- `apps/chatbot/src/index.ts` — chatbot app module (handleMessage, buildSystemPrompt, sanitizeInput)
- `apps/chatbot/src/conversation-history.ts` — per-user conversation history manager
- `apps/chatbot/src/__tests__/chatbot.test.ts` — 28 tests
- `apps/chatbot/src/__tests__/conversation-history.test.ts` — 14 tests

**Files modified:**
- `core/src/types/config.ts` — added `fallback` field to SystemConfig
- `core/src/services/config/index.ts` — parse `defaults.fallback` from pas.yaml
- `core/src/services/router/index.ts` — chatbot dispatch in fallback path
- `core/src/bootstrap.ts` — wire chatbot app to router
- `config/pas.yaml` — added `fallback: chatbot` default

**Key changes:**
- New built-in app: `apps/chatbot/` — implements `AppModule`, manifest declares `llm` + `context-store` + `data-store`
- Router fallback (step 4) routes to chatbot app instead of daily notes
- Chatbot uses `LLMService` standard tier + `ContextStore` for personalized responses
- Per-user conversation history (JSON, max 20 turns) for continuity
- Prompt sanitization for all user content (D9 resolved)
- Graceful degradation to "Noted" message on LLM failure
- Can discuss any topic (full general-purpose AI, not scoped to installed apps)
- Daily notes append preserved as side effect
- `pas.yaml` config: `defaults.fallback: chatbot | notes` (default: `chatbot`)

**Verification:**
- `pnpm build` — compiles without errors
- `pnpm lint` — Biome passes
- `pnpm test` — 809 tests pass across 67 test files (51 new)
- Send a message that doesn't match any app → chatbot responds conversationally
- Chatbot has access to context store (knows user preferences)
- Message still appears in daily notes
- Cost cap limits chatbot spending
- `fallback: notes` config reverts to old behavior

---

## Phase 17: App Packaging Standard + Install CLI

**Goal:** Enable apps to be distributed as standalone git repos and installed via CLI with validation.

**Depends on:** None (can parallelize with Phase 16)

**Key changes:**
- Define `pas_core_version` in `core/package.json` — the CoreServices API version
- Add manifest v2 fields: `pas_core_version` (semver range), `license`, `tags`, `category`, `homepage`
- Update manifest JSON Schema for new fields
- Implement `pas install <git-url>` CLI command:
  1. Clone repo into `apps/`
  2. Validate manifest against schema
  3. Check `pas_core_version` compatibility
  4. Static analysis: scan for banned imports (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama`, `child_process`)
  5. Show permission summary (services, data scopes, external APIs)
  6. Install npm dependencies
  7. Register in app registry
- Clear error messages for all failure modes (see `docs/app-sharing-vision.md` for format)

**Verification:**
- Install a valid app from git URL → succeeds, app loads
- Install app with banned import → fails with specific error pointing to file:line
- Install app requiring newer CoreServices → fails with compatibility error
- Install app with invalid manifest → fails with schema validation error

---

## Phase 18: Chatbot App Awareness — COMPLETE

**Goal:** Make the chatbot PAS-aware via `/ask` command, auto-detect, and knowledge base.

**Depends on:** Phase 16 (chatbot fallback app)

**What was built:**

| File | Purpose |
|------|---------|
| `core/src/types/app-metadata.ts` | AppInfo, CommandInfo, AppMetadataService interfaces |
| `core/src/types/app-knowledge.ts` | KnowledgeEntry, AppKnowledgeBaseService interfaces |
| `core/src/services/app-metadata/index.ts` | Read-only manifest metadata service |
| `core/src/services/app-knowledge/index.ts` | App docs + infra docs knowledge base |
| `core/docs/help/getting-started.md` | What PAS is, how to interact |
| `core/docs/help/commands-and-routing.md` | Commands, intents, fallback |
| `core/docs/help/scheduling.md` | Cron and one-off scheduling |
| `core/docs/help/data-storage.md` | Data store, scopes |
| `core/docs/help/context-store.md` | Context store usage |
| `apps/chatbot/manifest.yaml` | Updated: /ask command, new services, user_config |
| `apps/chatbot/src/index.ts` | Updated: handleCommand, app-aware prompts, auto-detect |

**Key changes:**
- `/ask` command with static intro (no LLM cost) or app-aware LLM response
- Per-user `auto_detect_pas` config (default: off) — keyword heuristics, no LLM cost for detection
- `AppMetadataService` — lazy reads from AppRegistry, filters by AppToggleStore
- `AppKnowledgeBase` — indexes `help.md`, `docs/*.md` from apps + `core/docs/help/` infra docs
- CoreServices extended with `appMetadata` and `appKnowledge`, wired via service factory
- `AppConfigService.getAll()` updated to accept optional `userId` parameter

**Verification:**
- `/ask` with no args → static intro, no LLM call
- `/ask what apps are installed?` → LLM response with app metadata
- `/ask how does scheduling work?` → response using infra docs
- General message → normal chatbot (no app metadata in prompt)
- Enable auto-detect → PAS question gets app-aware response
- 61 new tests across 3 test files; 962 total tests passing

---

## Phase 19: App Developer Documentation — COMPLETE

**Goal:** Documentation for friends to build and share PAS apps.

**Depends on:** Phase 17 (needs packaging standard defined)

**Deliverables:**
- `docs/CREATING_AN_APP.md` — step-by-step guide: scaffold, implement, test, share
- `docs/MANIFEST_REFERENCE.md` — complete manifest field reference with types, constraints, examples
- `core/src/cli/scaffold-app.ts` — CLI to generate app skeletons from templates
- `core/src/cli/templates/app/` — template files (manifest, package.json, tsconfig, source, test)
- `apps/notes/` — example app demonstrating commands, intents, data storage, LLM, user config

**Files created:**
- `core/src/cli/scaffold-app.ts`
- `core/src/cli/templates/app/manifest.yaml`
- `core/src/cli/templates/app/package.json`
- `core/src/cli/templates/app/tsconfig.json`
- `core/src/cli/templates/app/src/index.ts`
- `core/src/cli/templates/app/src/__tests__/app.test.ts`
- `core/src/cli/__tests__/scaffold-app.test.ts`
- `apps/notes/manifest.yaml`
- `apps/notes/package.json`
- `apps/notes/tsconfig.json`
- `apps/notes/src/index.ts`
- `apps/notes/__tests__/notes.test.ts`
- `docs/CREATING_AN_APP.md`
- `docs/MANIFEST_REFERENCE.md`

**Tests:** 27 new tests across 2 test files (15 scaffold, 12 notes)

**Verification:**
- `pnpm scaffold-app --name=my-app` generates valid app in `apps/my-app/`
- Generated manifest passes JSON Schema validation
- Notes app builds and all tests pass
- All 992 tests pass across 76 test files

---

## Phase 21: Scheduled Reports System

**Status:** Complete
**Dependencies:** Phase 20 (independent, can run in parallel)

### Overview

Configurable, user-defined scheduled reports that aggregate data from multiple sources, optionally summarize via LLM, and deliver via Telegram. Infrastructure-level service (not an app).

### Key Components

- **Report definitions** stored as YAML files in `data/system/reports/{report-id}.yaml`
- **Section types:** changes (from change log), app-data (file contents), context (store entries), custom (static text)
- **Date tokens:** `{today}`, `{yesterday}` resolved at runtime using system timezone
- **LLM summarization** with `sanitizeInput()` + anti-instruction framing, via SystemLLMGuard
- **CronManager integration** — dynamic register/unregister on report CRUD
- **Report history** saved to `data/system/report-history/{report-id}/{date}_{timestamp}.md`
- **GUI** — htmx-based list, create/edit form with section builder, preview, history viewer

### Files created
- `core/src/types/report.ts` — types and constants
- `core/src/services/reports/index.ts` — ReportService (CRUD, run, cron lifecycle)
- `core/src/services/reports/report-validator.ts` — validation logic
- `core/src/services/reports/report-formatter.ts` — markdown assembly
- `core/src/services/reports/section-collector.ts` — per-type data gathering
- `core/src/services/reports/__tests__/report-service.test.ts`
- `core/src/services/reports/__tests__/report-validator.test.ts`
- `core/src/services/reports/__tests__/section-collector.test.ts`
- `core/src/services/reports/__tests__/report-formatter.test.ts`
- `core/src/gui/routes/reports.ts` — GUI routes
- `core/src/gui/views/reports.eta` — list page
- `core/src/gui/views/report-edit.eta` — create/edit form
- `core/src/gui/views/report-history.eta` — history viewer
- `core/src/gui/__tests__/reports.test.ts`

### Files modified
- `core/src/services/scheduler/cron-manager.ts` — added `unregister()` method
- `core/src/services/scheduler/__tests__/cron-manager.test.ts` — 4 new tests
- `core/src/bootstrap.ts` — create ReportService, call `init()`, pass to GUI
- `core/src/gui/index.ts` — add ReportService/UserManager to GuiOptions, register routes
- `core/src/gui/views/layout.eta` — "Reports" nav link

### Tests
130 new tests across 5 new test files + 1 modified:
- `report-validator.test.ts` (39 tests)
- `section-collector.test.ts` (21 tests)
- `report-formatter.test.ts` (11 tests)
- `report-service.test.ts` (30 tests)
- `reports.test.ts` (25 GUI tests)
- `cron-manager.test.ts` (+4 tests)

### Verification
- `pnpm build` — no type errors
- `pnpm test` — all 1345 tests pass across 87 test files

---

## Phase 22: Conditional Alerts System

**Status:** Complete
**Dependencies:** Phase 21 (for `run_report` action type)

### Overview

Infrastructure-level conditional alert system. Users define alerts via the GUI with conditions (deterministic or fuzzy/LLM), schedules, cooldowns, and typed actions (send Telegram message, run a report). The system evaluates conditions on a cron schedule and fires actions when conditions are met.

### Key Components

- **Alert definitions** stored as YAML files in `data/system/alerts/{alert-id}.yaml`
- **Condition types:** deterministic (exact checks: empty, contains, line count) and fuzzy (LLM-interpreted)
- **Action types:** `telegram_message` (send to delivery users) and `run_report` (trigger a report by ID)
- **Cooldown tracking** reuses `canFire()` and `parseCooldown()` from condition-evaluator
- **Date token support** in data source paths (`{today}`, `{yesterday}`) via `resolveDateTokens()`
- **CronManager integration** — dynamic register/unregister on alert CRUD
- **Alert history** saved to `data/system/alert-history/{id}/{date}_{timestamp}.md`
- **GUI** — htmx-based list, create/edit form with dynamic data source and action builders, toggle, test/preview, history viewer

### Files created
- `core/src/types/alert.ts` — types and constants
- `core/src/services/alerts/index.ts` — AlertService (CRUD, evaluate, cron lifecycle)
- `core/src/services/alerts/alert-validator.ts` — validation logic
- `core/src/services/alerts/alert-executor.ts` — action execution (telegram, run_report)
- `core/src/services/alerts/__tests__/alert-service.test.ts`
- `core/src/services/alerts/__tests__/alert-validator.test.ts`
- `core/src/services/alerts/__tests__/alert-executor.test.ts`
- `core/src/gui/routes/alerts.ts` — GUI routes
- `core/src/gui/views/alerts.eta` — list page
- `core/src/gui/views/alert-edit.eta` — create/edit form
- `core/src/gui/views/alert-history.eta` — history viewer
- `core/src/gui/__tests__/alerts.test.ts`

### Files modified
- `core/src/services/condition-evaluator/evaluator.ts` — exported `evaluateDeterministic` and `evaluateFuzzy`
- `core/src/services/condition-evaluator/index.ts` — re-exported evaluator functions and `EvaluatorDeps` type
- `core/src/bootstrap.ts` — create AlertService, call `init()`, pass to GUI
- `core/src/gui/index.ts` — add AlertService to GuiOptions, register routes
- `core/src/gui/views/layout.eta` — "Alerts" nav link

### Tests
104 new tests across 4 new test files:
- `alert-validator.test.ts` (40 tests)
- `alert-executor.test.ts` (11 tests)
- `alert-service.test.ts` (31 tests)
- `alerts.test.ts` (22 GUI tests)

### Verification
- `pnpm build` — no type errors
- `pnpm test` — all 1452 tests pass across 91 test files

---

## Phase 26: n8n Dispatch Pattern

### Goal
Expose PAS's report execution, alert evaluation, change log, LLM, and Telegram delivery as API endpoints for external orchestration. Add a dispatch mode where PAS cron triggers fire webhooks to n8n instead of executing internally, with automatic fallback.

### Phase 26A — API Foundation

**New API endpoints:**
- `GET /api/reports` — list all report definitions
- `GET /api/reports/:id` — get single report definition
- `POST /api/reports/:id/run` — execute report (collect, format, save, deliver)
- `POST /api/reports/:id/deliver` — send content to delivery users via Telegram
- `GET /api/alerts` — list all alert definitions
- `GET /api/alerts/:id` — get single alert definition
- `POST /api/alerts/:id/evaluate` — evaluate condition and execute actions if met
- `POST /api/alerts/:id/fire` — force-execute actions
- `GET /api/changes` — change log entries (with since, appFilter, limit params)
- `POST /api/llm/complete` — LLM proxy through PAS (cost tracking, safeguards)
- `POST /api/telegram/send` — send message via PAS's Telegram bot

**New files:**
- `core/src/api/routes/reports-api.ts`
- `core/src/api/routes/alerts-api.ts`
- `core/src/api/routes/changes.ts`
- `core/src/api/routes/llm.ts`
- `core/src/api/routes/telegram.ts`

**Changed files:**
- `core/src/api/index.ts` — extended ApiOptions, registered new routes
- `core/src/bootstrap.ts` — passes new services to API options

### Phase 26B — n8n Dispatch Mode

**Config:** `n8n.dispatch_url` in pas.yaml (empty = internal execution, backward compat)

**Dispatch flow:** Cron fires → check dispatch_url → if set, POST `{ type, id, action }` to n8n → if fails, run internally

**New files:**
- `core/src/services/n8n/index.ts` — N8nDispatcher service

**Changed files:**
- `core/src/types/config.ts` — `n8n.dispatchUrl` field on SystemConfig
- `core/src/services/config/index.ts` — parse `n8n.dispatch_url` from pas.yaml
- `core/src/services/reports/index.ts` — cron handler dispatches when configured
- `core/src/services/alerts/index.ts` — cron handler dispatches when configured
- `core/src/bootstrap.ts` — creates N8nDispatcher, passes to services, daily-diff dispatch
- `config/pas.yaml.example` — n8n section

### Phase 26C — Documentation

**New files:**
- `docs/n8n-integration.md` — architecture, API reference, setup guide

**Changed files:**
- `CLAUDE.md` — architecture decisions, key file paths, change log
- `docs/implementation-phases.md` — Phase 26 entries

### Tests
86 new tests across 7 new test files:
- `reports-api.test.ts` (22 tests)
- `alerts-api.test.ts` (16 tests)
- `changes.test.ts` (9 tests)
- `llm.test.ts` (14 tests)
- `telegram.test.ts` (9 tests)
- `n8n-dispatcher.test.ts` (9 tests)
- `n8n-dispatch-integration.test.ts` (7 tests)

### Verification
- `pnpm build` — no type errors
- `pnpm test` — all 1907 tests pass across 116 test files

---

## Phase 27A-Vaults — VaultService (Per-User Obsidian Vaults)

**Status:** Planned
**Depends on:** Phase 27A (conventions), Phase 23 (shared data spaces)

### Goal

Create per-user Obsidian vault directories at `data/vaults/<userId>/` that unify personal, shared, and space data via symlinks. Users open `data/vaults/<userId>/` as their Obsidian vault root and see all their accessible data in one place.

### Vault Structure

```
data/vaults/<userId>/
  <appId>/                    → symlink to data/users/<userId>/<appId>/
  _shared/<appId>/            → symlink to data/users/shared/<appId>/
  _spaces/<spaceId>/<appId>/  → symlink to data/spaces/<spaceId>/<appId>/
```

- Personal data: `<appId>/` symlinks to per-user app directories
- Shared data: `_shared/<appId>/` symlinks to global shared directories
- Space data: `_spaces/<spaceId>/<appId>/` symlinks to space directories (membership-gated)

The `_shared/` and `_spaces/` prefixes use underscores, which cannot collide with app IDs (pattern: `^[a-z][a-z0-9-]*$`).

### Wiki-Link Conventions

| Scope | Format | Example |
|-------|--------|---------|
| Personal | `[[<appId>/<path>]]` | `[[notes/daily/2026-03-19]]` |
| Shared | `[[_shared/<appId>/<path>]]` | `[[_shared/grocery/lists/weekly]]` |
| Space | `[[_spaces/<spaceId>/<appId>/<path>]]` | `[[_spaces/family/meal-planner/plans/week-12]]` |

### New Files

- `core/src/services/vault/index.ts` — VaultService: create/rebuild per-user vault symlink trees
- `core/src/services/vault/__tests__/vault.test.ts` — unit tests

### Changed Files

- `core/src/bootstrap.ts` — wire VaultService, call on startup and space membership changes
- `core/src/types/app-module.ts` — add `vault` to CoreServices (if exposed to apps)
- `core/src/services/spaces/index.ts` — trigger vault rebuild on membership changes
- `docs/CREATING_AN_APP.md` — vault root updated, space wiki-link conventions added
- `core/docs/help/spaces.md` — Obsidian vault integration section added
- `CLAUDE.md` — architecture decisions, key file paths, change log

### Key Decisions

- **Symlinks, not copies** — zero storage overhead, changes visible instantly in Obsidian
- **Membership-gated** — only spaces where the user is a member get `_spaces/` symlinks
- **Rebuild on change** — vault rebuilt when apps are registered, spaces are created/deleted, or membership changes
- **Platform note** — symlinks on Windows may require Developer Mode or elevated privileges

### Verification

- `pnpm build` — no type errors
- `pnpm test` — all tests pass
- Manual: open `data/vaults/<userId>/` as Obsidian vault, verify cross-scope wiki-links resolve

---

## Phase 28 — Route Verification (Grey-Zone Disambiguation)

**Status:** Complete
**Depends on:** Phase 5 (Router), Phase 10 (Multi-provider LLM)

### Goal

Add a post-classification verification step for grey-zone messages (confidence 0.4–0.7). A second LLM call (standard tier) with full app descriptions verifies the classifier's routing decision. On disagreement, inline Telegram buttons let the user choose the correct app. The message is held indefinitely until the user responds.

### New Files

- `core/src/services/router/route-verifier.ts` — RouteVerifier service: LLM verification, button presentation, callback resolution
- `core/src/services/router/pending-verification-store.ts` — In-memory Map of pending verifications (lost on restart — acceptable)
- `core/src/services/router/verification-logger.ts` — Appends verification events to `data/system/route-verification-log.md`
- `core/src/services/router/__tests__/route-verifier.test.ts` — RouteVerifier unit tests (29 tests)
- `core/src/services/router/__tests__/pending-verification-store.test.ts` — PendingVerificationStore tests (10 tests)
- `core/src/services/router/__tests__/verification-logger.test.ts` — VerificationLogger tests (8 tests)
- `core/src/services/router/__tests__/router-verification.test.ts` — Router integration tests (8 tests)

### Changed Files

- `core/src/types/config.ts` — Added `RoutingVerificationConfig` interface, optional `routing` on SystemConfig
- `core/src/services/config/index.ts` — Parse `routing.verification` from YAML, default enabled, clamp upper_bound
- `core/src/services/llm/prompt-templates.ts` — Added `buildVerificationPrompt()` with sanitized inputs
- `core/src/services/router/index.ts` — Grey-zone check in `routeMessage()` and `routePhoto()`
- `core/src/bootstrap.ts` — Wire verification services, `rv:` callback handler
- `config/pas.yaml.example` — Route verification config section
- `config/pas.yaml.example` — Route verification config section
- `CLAUDE.md` — Route verification architecture decision, key file paths

### Key Decisions

- **Enabled by default** — verification runs without explicit config; disable with `routing.verification.enabled: false`
- **Standard tier** for verification — needs better reasoning than fast-tier classifier
- **Hold indefinitely** — no timeout; message waits until user taps inline button
- **Graceful degradation** — LLM failure falls back to classifier's pick
- **appId validation** — verifier's suggested appId checked against registry; hallucinated IDs fall back to classifier
- **Button deduplication** — no duplicate buttons when classifier and verifier suggest same app; chatbot excluded from buttons
- **In-memory pending store** — lost on restart (acceptable for grey-zone messages)
- **Verification log** — markdown file with YAML frontmatter for Obsidian compatibility
- **Photo support** — photos saved to `data/system/route-verification/photos/` for log references
- **Prompt injection defense** — all user text, app descriptions, and intent strings sanitized via `sanitizeInput()`

### URS Requirements

- REQ-ROUTE-006: Route verification (22 standard tests, 24 edge case tests)

### Verification

- `pnpm build` — no type errors
- `pnpm test` — all tests pass (4200+ tests)
- `pnpm lint` — no new lint errors
- Manual: send ambiguous Telegram message → buttons appear → tap → routed correctly → log entry written

---

## Phase 29 — Invite Code Registration & User Management GUI

**Status:** Complete
**Depends on:** Phase 9 (User Manager), Phase 21 (Management GUI)

### Goal

Replace manual Telegram-ID-based user registration with admin-generated invite codes. Add a GUI page for managing user app access, shared scopes, and user removal. Support runtime user mutations that persist to pas.yaml.

### New Files

- `core/src/services/invite/index.ts` — InviteService: create, validate, redeem, cleanup invite codes. YAML-backed storage
- `core/src/services/config/config-writer.ts` — `syncUsersToConfig()`: atomic user array sync to pas.yaml preserving other sections
- `core/src/services/user-manager/user-mutation-service.ts` — UserMutationService: coordinates UserManager mutations + config sync
- `core/src/gui/routes/users.ts` — GUI routes for user list, app toggles, group editing, user removal
- `core/src/gui/views/users.eta` — User management page template
- `core/src/services/invite/__tests__/index.test.ts` — InviteService unit tests (28 tests)
- `core/src/services/invite/__tests__/integration.test.ts` — Full flow integration tests (3 tests)
- `core/src/services/config/__tests__/config-writer.test.ts` — ConfigWriter tests (5 tests)
- `core/src/services/user-manager/__tests__/user-mutation-service.test.ts` — UserMutationService tests (19 tests)
- `core/src/services/router/__tests__/invite-command.test.ts` — Router /invite and /start tests (12 tests)

### Changed Files

- `core/src/services/user-manager/index.ts` — Added addUser, removeUser, updateUserApps, updateUserSharedScopes methods
- `core/src/services/user-manager/user-guard.ts` — Added raw invite code detection for unregistered users
- `core/src/services/user-manager/__tests__/user-guard.test.ts` — Added 9 invite code detection tests
- `core/src/services/router/index.ts` — Added /invite command, /start code redemption, invite help section
- `core/src/bootstrap.ts` — Wire InviteService, UserMutationService; pass to UserGuard, Router, GUI
- `core/src/gui/index.ts` — Register user routes
- `core/src/gui/views/layout.eta` — Added Users nav item
- `CLAUDE.md` — Updated implementation status, key file paths

### Key Decisions

- **Invite codes over Telegram ID** — users don't need to find their Telegram ID
- **8-char hex codes** — `crypto.randomBytes(4)`, single-use, 24h expiry
- **Dual redemption paths** — `/start <code>` (Telegram deep link) and raw code detection in UserGuard
- **Runtime mutations + config sync** — changes persist immediately to pas.yaml via atomic writes
- **Last-admin guard** — prevents removing the sole admin user
- **Freeform groups** — shared scopes are user-defined tags, not predefined selections
- **GUI uses htmx** — inline checkbox toggles, form submissions, row deletion without page reload

### URS Requirements

- REQ-USER-005: Invite code generation and validation (4 standard, 5 edge case, 3 security tests)
- REQ-USER-006: Invite code redemption (2 standard, 8 edge case, 2 security tests)
- REQ-USER-007: Runtime user mutations with config sync (6 standard, 6 edge case tests)
- REQ-USER-008: GUI user management (3 standard, 3 edge case tests)

### Verification

- `pnpm build` — no type errors
- `pnpm test` — all tests pass
- `pnpm lint` — no new lint errors
- Manual: `/invite <name>` → code generated → new user sends `/start <code>` → registered and welcomed
- Manual: `/gui/users` → toggle app checkboxes → edit groups → remove user → all changes persist

---

## Phase 30: Per-User Config Runtime Propagation

**Date:** 2026-04-09  **Status:** Complete  **Unblocks:** H11.x (nutrition/hosting per-user config)

### Motivation

`AppConfigServiceImpl.setUserId()` was never called in production — every `services.config.get(key)` silently returned the manifest default, making per-user overrides saved via the GUI config editor unreachable at handler runtime. The fix generalizes the existing `llmContext` AsyncLocalStorage into a unified `requestContext` consumed by both LLM cost attribution and config lookups.

### Files Touched

- **New:** `core/src/services/context/request-context.ts` + tests — unified request-scoped ALS (`{userId?: string}`)
- **New:** `core/src/services/scheduler/per-user-dispatch.ts` + tests — wraps `user_scope: all` jobs in a per-user request context
- **New:** `core/src/services/config/__tests__/per-user-runtime.integration.test.ts` — end-to-end regression test
- **Deleted:** `core/src/services/llm/llm-context.ts` (replaced by request-context)
- **Modified:** `core/src/services/config/app-config-service.ts` — reads `getCurrentUserId()` from requestContext; removed vestigial `setUserId` field/method
- **Modified:** `core/src/bootstrap.ts` — every dispatch site (message/photo/verification/callback) now wraps in `requestContext.run`; cron registration delegates to `buildScheduledJobHandler`
- **Modified:** `core/src/api/routes/messages.ts`, `core/src/services/alerts/alert-executor.ts`, `core/src/services/llm/providers/base-provider.ts` — import path updates
- **Modified:** `core/src/types/app-module.ts` — extended `handleScheduledJob` signature to `(jobId, userId?)`
- **Modified:** `apps/food/src/index.ts` — accepts new optional `userId` parameter (H11.x will wire up the `weekly-nutrition-summary` branch)
- **Modified:** `apps/food/src/handlers/nutrition-summary.ts` — migrated to single-user contract (filters to targeted household member, delegates iteration to scheduler)
- **Docs:** `docs/MANIFEST_REFERENCE.md`, `docs/CREATING_AN_APP.md`, `docs/urs.md`, `apps/food/docs/urs.md`, `CLAUDE.md`

### Verification

- `pnpm build` — clean
- `pnpm test` — 4709 tests across 192 files, all green
- `per-user-runtime.integration.test.ts` is the canonical regression: write via `setAll('alice', {...})`, read via `requestContext.run({userId:'alice'}, () => config.get(...))`, asserts override returned; `bob` (no override) gets default; outside any `requestContext.run` scope also returns default

### Consequences

- Every `user_config` key across every app is now meaningfully per-user at runtime — no app code changes required
- The former `llmContext` export no longer exists; any future `core/src/` code needing the current user's id should import `getCurrentUserId` from `core/src/services/context/request-context.ts`
- `user_scope: all` scheduled jobs are now invoked once per registered user; app handlers filtering by their own household/membership criteria should early-return for users they don't own

---

## Phase D1: Chatbot Context & Conversation Quality

**Date:** 2026-04-13  **Status:** Complete  **Part of:** Deployment Readiness Roadmap (D1–D6)

### Motivation

User testing revealed the chatbot felt disconnected — it didn't know who it was talking to, couldn't recognize PAS-related questions reliably (a 66+ keyword list was brittle), and hit Telegram's message limit on detailed answers.

### Changes

| Area | Change |
|------|--------|
| PAS classification | Replaced `PAS_KEYWORDS` static list with `classifyPASMessage()` — compact fast-tier LLM call. Extensible `PASClassification { pasRelated, dataQueryCandidate? }` object for D2 wiring. Fail-open on error. |
| User context | Added `buildUserContext()` — injects `ctx.spaceName` and enabled app list into both basic and app-aware system prompts. |
| Message splitting | Added `splitTelegramMessage()` — splits at paragraph → line → hard chunk, keeping parts under 3800 chars. Applied to both `handleMessage()` and `handleCommand()`. |
| Token cap | Raised `maxTokens` from 1024 → 2048 in both response paths. |
| Default config | `auto_detect_pas` default changed from `false` → `true` in `manifest.yaml`. |
| Security | Sanitized user text and app names before classifier LLM injection (consistent with all other LLM call sites). Sanitized `ctx.spaceName` and app names in `buildUserContext()`. |

### Files Touched

- **Modified:** `apps/chatbot/src/index.ts` — `classifyPASMessage()`, `buildUserContext()`, `splitTelegramMessage()` added and wired into `handleMessage()` / `handleCommand()`. `isPasRelevant()` deprecated (not removed). (Removed entirely 2026-05-06 — see "Open-Items Cleanup Batches" entry.)
- **Modified:** `apps/chatbot/manifest.yaml` — `auto_detect_pas` default: `false` → `true`.
- **New:** `apps/chatbot/src/__tests__/pas-classifier.test.ts` — 14 tests for classifier (happy, edge, error, security).
- **New:** `apps/chatbot/src/__tests__/user-context.test.ts` — 7 tests for user context (happy, edge, security).
- **New:** `apps/chatbot/src/__tests__/message-splitter.test.ts` — 8 tests for message splitting.
- **Modified:** `apps/chatbot/src/__tests__/chatbot.test.ts` — updated auto-detect integration tests for two-LLM-call flow; added classifier fail-open, user context in prompts, /ask context tests.
- **Modified:** `docs/urs.md` — REQ-CHATBOT-005/006/010 updated; REQ-CHATBOT-012–015 added; traceability matrix updated.
- **Modified:** `docs/implementation-phases.md` — this entry.
- **Modified:** `CLAUDE.md` — D1 status updated to Complete.

### Verification

- `pnpm test` — 202 chatbot tests across 5 files, 5900+ total tests, all green
- `pnpm lint` — clean

### Consequences

- Auto-detect now uses a fast-tier LLM call per non-PAS message (adds one LLM call when `auto_detect_pas` is true and message is general). Cost is minimal (maxTokens: 5).
- `isPasRelevant()` is deprecated. Its tests remain for backward compat. Remove in a future cleanup once no callers remain. (Removed entirely 2026-05-06 — see "Open-Items Cleanup Batches" entry.)
- `dataQueryCandidate` field on `PASClassification` is the D2 hook — currently always `undefined`.

---

## Phase D2a: File Index Foundation

**Date:** 2026-04-13  **Status:** Complete  **Part of:** Deployment Readiness Roadmap (D2)

### Motivation

NL data access (D2b) requires knowing what files exist, who owns them, and what metadata they carry — without scanning the filesystem on every query. D2a builds the in-memory index that D2b will query.

### Changes

| Area | Change |
|------|--------|
| FileIndexService | New `core/src/services/file-index/index.ts` — in-memory index rebuilt at startup from all registered app manifest scopes. Subscribes to `data:changed` EventBus events to stay current. Exposes `query({ appId?, scope?, tag?, dateAfter?, dateBefore?, limit? })` and `getByPath()`. |
| EntryParser | New `core/src/services/file-index/entry-parser.ts` — extracts metadata from file paths (appId, scope, owner type + id) and YAML frontmatter (title, type, tags, entity_keys, wiki-links, dates, relationships, aliases, summary). |
| Scope normalization | Fixed `findMatchingScope()` in `core/src/services/data-store/paths.ts` — virtual POSIX normalization (`posix.normalize`) prevents Windows path separator bypass. Null-byte rejection added. |
| Food frontmatter enrichment | All food app write sites now include `type`, `app: 'food'`, and where applicable `entity_keys` in YAML frontmatter: recipe-store, meal-plan-store, grocery-store, pantry-store, price-store, receipt handlers, health-store, cultural-calendar. |
| Bootstrap wiring | `FileIndexService` instantiated and started in `core/src/bootstrap.ts`; injected into `CoreServices` as `fileIndex`. |

### Post-Review Fixes (D2a-review)

| Finding | Fix |
|---------|-----|
| Empty-scopes bug | Apps with no declared manifest scopes now index zero files instead of potentially indexing everything |
| Payload validation | `data:changed` handler validates `operation` enum, applies `SAFE_SEGMENT` to `appId`/`userId`/`spaceId`, and `posix.normalize` to path before indexing |
| `reindexByPath()` safety | Same SAFE_SEGMENT + normalize guards applied to the manual reindex path |
| Untrusted data annotation | `FileIndexEntry` fields (title, tags, summary, entity_keys) documented as user-controlled; callers must sanitize before including in LLM prompts |
| Recipe entity_keys cap | Capped at title + first 5 ingredients to avoid unbounded index entries |

### Files Touched

- **New:** `core/src/services/file-index/index.ts` — FileIndexService
- **New:** `core/src/services/file-index/entry-parser.ts` — metadata extractor
- **New:** `core/src/services/file-index/types.ts` — FileIndexEntry, FileIndexQuery types
- **Modified:** `core/src/services/data-store/paths.ts` — scope normalization fix in `findMatchingScope()`
- **Modified:** `core/src/bootstrap.ts` — FileIndexService wiring
- **Modified:** `core/src/types/app-module.ts` — `fileIndex` field on CoreServices
- **Modified:** `apps/food/src/services/recipe-store.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/services/meal-plan-store.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/services/grocery-store.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/services/pantry-store.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/services/price-store.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/services/health-store.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/services/cultural-calendar.ts` — frontmatter enrichment
- **Modified:** `apps/food/src/handlers/receipt-handler.ts` — frontmatter enrichment
- **New:** `core/src/services/file-index/__tests__/file-index.test.ts` — FileIndexService tests
- **New:** `core/src/services/file-index/__tests__/entry-parser.test.ts` — EntryParser tests
- **Modified:** `core/src/services/data-store/__tests__/paths.test.ts` — scope normalization regression tests
- **Modified:** `docs/urs.md` — REQ-DATAIDX-001–005 added; traceability matrix updated
- **Modified:** `docs/implementation-phases.md` — this entry
- **Modified:** `CLAUDE.md` — D2a status updated to Complete

### Verification

- `pnpm test` — 6023 tests across 241 test files, all green
- `pnpm lint` — clean

### Consequences

- `FileIndexEntry` fields are user-controlled data (from file content). D2b must sanitize before passing to LLM prompts.
- `dataQueryCandidate` on `PASClassification` (from D1) is the hook for D2b wiring — currently unused.
- Phase 27B (original FileIndexService plan) is fully superseded by this implementation.

---

## Phase D2b: DataQueryService + Chatbot Wiring

**Date:** 2026-04-13  **Status:** Complete  **Part of:** Deployment Readiness Roadmap (D2)

### Motivation

With the FileIndexService providing a metadata index of all user data files (D2a), D2b adds the natural language query layer: a DataQueryService that uses LLM file selection + content retrieval, and chatbot wiring that routes YES_DATA-classified questions to that service.

### Changes

| Area | Change |
|------|--------|
| DataQueryService | New `core/src/services/data-query/index.ts` — accepts a NL question + userId, queries FileIndexService for candidate files, calls fast-tier LLM to select relevant IDs (validated against pre-authorized set), reads file content with realpath path containment, returns results. |
| DataQuery types | New `core/src/types/data-query.ts` — `DataQueryResult`, `DataQueryFile` types. |
| Chatbot wiring | `apps/chatbot/src/index.ts` — `handleMessage()` calls DataQueryService when classifier returns `YES_DATA`; `dataContext` injected into system prompt via `formatDataQueryContext()` with `sanitizeInput()`. |
| /ask classifier | `/ask` command now uses `classifyPASMessage()` (LLM classifier) instead of keyword matching, consistent with the `handleMessage` path. |
| Category suppression | When `dataContext` is present and question doesn't mention AI keywords, `llm` and `costs` categories are suppressed from `gatherSystemData()` to avoid injecting irrelevant model pricing alongside grocery data. |
| Bootstrap wiring | DataQueryService instantiated in `core/src/bootstrap.ts` with lazy facade — safe to call during init, gracefully returns empty result if service not yet initialized. |
| Manifest schema | `core/src/schemas/app-manifest.schema.json` — `data-query` added to valid `requirements` service names. |

### End-of-Phase Review Fixes

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S1 | Medium | Unsanitized `dataContext` in system prompt (backtick fence escape) | `sanitizeInput(dataContext, MAX_DATA_CONTEXT_CHARS)` with 12 000-char cap |
| S2 | Medium | Fallback regex `\b\d+\b` extracted numbers from negative/float prose | Tightened to `(?<![-.\d])\b\d+\b(?!\.\d)` — rejects `-1`, `0.5` |
| S3 | Medium | `resolve()+lstat()` missed symlink parent directories | Replaced with `realpath()` containment — resolves entire path chain including parent dirs |
| S4 | Low | LLM/costs system data injected for grocery price queries | Suppress `llm`/`costs` categories when `dataContext` present and no AI keywords in question |
| S5 | Low | Lazy facade `dataQueryServiceImpl!` crashes if called during `init()` | Graceful null check — returns `{ files: [], empty: true }` |
| L1 | Low | Stale "future update" comment in `gatherUserDataOverview()` | Updated to reflect active NL query support |
| L2 | Low | Stale "reserved for D2" in `PASClassification` JSDoc | Updated to describe active `YES_DATA` behavior |

### Files Touched

- **New:** `core/src/services/data-query/index.ts` — DataQueryService
- **New:** `core/src/types/data-query.ts` — DataQueryResult, DataQueryFile types
- **New:** `core/src/services/data-query/__tests__/data-query.test.ts` — DataQueryService unit tests
- **New:** `apps/chatbot/src/__tests__/data-query-wiring.test.ts` — chatbot wiring integration tests
- **Modified:** `core/src/bootstrap.ts` — DataQueryService lazy facade + graceful bootstrap guard
- **Modified:** `core/src/types/app-module.ts` — `dataQuery` field on CoreServices
- **Modified:** `core/src/schemas/app-manifest.schema.json` — `data-query` added to valid service names
- **Modified:** `apps/chatbot/src/index.ts` — YES_DATA routing, dataContext injection, category suppression, /ask classifier
- **Modified:** `apps/chatbot/src/__tests__/chatbot.test.ts` — updated for classifier call ordering
- **Modified:** `apps/chatbot/src/__tests__/user-persona.test.ts` — updated for classifier call count
- **Modified:** `core/src/services/data-query/__tests__/data-query.test.ts` — regex, symlink, malformed JSON tests strengthened
- **Modified:** `core/src/schemas/__tests__/validate-manifest.test.ts` — data-query added to valid services test
- **Modified:** `docs/urs.md` — REQ-DATAQUERY-001–004, REQ-CHATBOT-016–017 added; traceability matrix updated
- **Modified:** `docs/uat-checklist.md` — Section 23 added
- **Modified:** `docs/implementation-phases.md` — this entry
- **Modified:** `CLAUDE.md` — D2b status updated to Complete

### Verification

- `pnpm test` — 6103 tests across 243 test files, all green
- `pnpm build` — clean

### Consequences

- DataQueryService is now the canonical NL data access layer. Apps wishing to expose data to NL queries must write YAML frontmatter (type, app, entity_keys) — food app does this as of D2a.
- `dataQueryCandidate` on `PASClassification` is now fully wired and active.
- D2c (Data Modification via `/edit`) is the next phase.

---

## Phase D5c: Per-Household LLM Governance + Ops + Load Test

**Status:** Planned — plan ready at `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`

**Goal:** Per-household resource governance so no single household monopolizes LLM bandwidth or cost, plus operational visibility and a load-test proving correctness at 40 concurrent users.

**6 chunks (one per session + review):**

| Chunk | Description |
|---|---|
| 0 | Semantics decisions: household-wide vs per-app rate limit, exemption policy, overshoot policy. Docs + URS only. |
| A | Fix 3 remaining ALS dispatch gaps (bootstrap Telegram + onboard paths + GUI context routes). |
| B | CostTracker household dimension: 9th column in llm-usage.md, `households:` map in monthly-costs.yaml, cost reservations. |
| C | `HouseholdLLMLimiter` (shared, cross-app, injected from bootstrap) + `RateLimiter` peek/commit API + config/schema/error surface. |
| D | Ops dashboard: extend `/gui/llm` with Per-Household Breakdown + live metrics via htmx. |
| E | `composeRuntime()` bootstrap refactor + `scripts/load-test.ts` (40 users × 8 households). |

**Depends on:** D5a (ALS householdId propagation is mostly there), D5b (HouseholdService + auth infrastructure).
**Deferred from this phase:** D5a §1 (forShared scope migration), D5a §4 (collaboration space UX).

---

## Review Phase 5 Remediation

**Date:** 2026-04-24  **Status:** Complete  **Part of:** Staged test/spec coverage review

### Motivation

The Stage 5 review found two real runtime gaps and two test-quality gaps:

- `/edit` was not using recent interaction context during file discovery, even though `DataQueryService` already supported `recentFilePaths`.
- Guard reservation sizing supported model-aware pricing internally, but `composeRuntime()` was not wiring live pricing/tier inputs into the app, system, or API guards.
- The strongest evidence for some D2c wiring was still source-scan based instead of behavior-level composed-runtime coverage.
- Several chatbot prompt tests were still overly coupled to exact prompt copy.

### Changes

| Area | Change |
|------|--------|
| EditService wiring | `EditServiceImpl` now accepts the shared `InteractionContextService`, flattens `getRecent(userId)` file paths in newest-first order, dedupes by first occurrence, and forwards `recentFilePaths` into `DataQueryService.query(...)` when available. |
| Guard pricing | `composeRuntime()` now injects a live `PriceLookup` that reads the current `ModelSelector` tier assignment on every call, converts model pricing from per-million to per-1k, and treats Ollama as zero-cost. |
| Guard tier estimation | `LLMGuard` and `SystemLLMGuard` now estimate `complete()` reservations with the effective per-call tier (`options.tier` when present, otherwise the guard default); `classify()` and `extractStructured()` remain fast-tier estimates. |
| Behavioral coverage | `compose-runtime.smoke.integration.test.ts` now proves live fast-vs-standard reservation sizing, proves app-owned chatbot calls reserve priced amounts rather than the flat fallback, and proves `/edit` cannot be steered into another user's file via poisoned recent-context hints. |
| Prompt-test hardening | Shared semantic helpers now live at `apps/chatbot/src/__tests__/helpers/prompt-assertions.ts`, and the high-churn PAS/basic/system-data prompt assertions now use those helpers across the main chatbot suites. |
| Docs / traceability | Stage 5 findings, open items, URS traceability, and the UAT checklist were updated to reflect the remediation and the new runtime evidence. |

### Files Touched

- **Modified:** `core/src/services/edit/index.ts`
- **Modified:** `core/src/services/llm/llm-guard.ts`
- **Modified:** `core/src/services/llm/system-llm-guard.ts`
- **Modified:** `core/src/compose-runtime.ts`
- **Modified:** `core/src/services/edit/__tests__/edit.test.ts`
- **Modified:** `core/src/services/llm/__tests__/llm-guard.test.ts`
- **Modified:** `core/src/services/llm/__tests__/system-llm-guard.test.ts`
- **Modified:** `core/src/__tests__/compose-runtime.smoke.integration.test.ts`
- **New:** `apps/chatbot/src/__tests__/helpers/prompt-assertions.ts`
- **Modified:** `apps/chatbot/src/__tests__/chatbot.test.ts`
- **Modified:** `apps/chatbot/src/__tests__/natural-language.test.ts`
- **Modified:** `apps/chatbot/src/__tests__/user-persona.test.ts`
- **Modified:** `docs/test-review-stage-5-findings.md`
- **Modified:** `docs/open-items.md`
- **Modified:** `docs/urs.md`
- **Modified:** `docs/uat-checklist.md`
- **Modified:** `docs/implementation-phases.md`

### Verification

- Targeted Stage 5 suites: `pnpm test core/src/services/edit/__tests__/edit.test.ts core/src/services/llm/__tests__/llm-guard.test.ts core/src/services/llm/__tests__/system-llm-guard.test.ts core/src/__tests__/compose-runtime.smoke.integration.test.ts apps/chatbot/src/__tests__/chatbot.test.ts apps/chatbot/src/__tests__/natural-language.test.ts apps/chatbot/src/__tests__/user-persona.test.ts`
- Full `pnpm test` passed: 314 files, 7694 passed, 10 skipped
- `pnpm build` passed cleanly

---
---

## Review Phase 6 Remediation

**Date:** 2026-04-25  **Status:** Complete  **Part of:** Staged test/spec coverage review

### Motivation

The Stage 6 review found three contract gaps still open in the current tree:

- packaged apps could declare compiled entrypoints, but the loader still preferred source-only fallback paths
- `install-app` still coupled permission review to the commit path instead of exposing a true review-then-commit boundary
- schema fixtures, bundled manifests, and runtime scope enforcement were no longer pinned together by a shared contract test

### Changes

| Area | Change |
|------|--------|
| Loader/runtime packaging | `AppLoader.importModule()` now resolves safe local `package.json.main`, then `dist/index.js`, before the existing source fallbacks. Unsafe `main` values (absolute paths, traversal attempts, unsupported extensions, missing targets) are ignored non-fatally with debug logging. |
| Compiled-app coverage | `loader.test.ts` now covers safe `main`, `dist/index.js`, traversal/absolute-path `main`, and unsupported-extension fallback. `registry.test.ts` now loads a full compiled fixture where `src/index.ts` is intentionally broken but `dist/index.js` still loads through `loadAll()`. |
| Installer planning boundary | `planInstallApp()` now performs clone, validation, compatibility checks, static analysis, and permission-summary generation without copying into `apps/` or running `pnpm install`. It returns a `PreparedInstall` with `commit()` and idempotent `dispose()`. The legacy `installApp()` wrapper now does `plan -> commit -> dispose` internally. |
| CLI runners | `install-app.ts` and `uninstall-app.ts` now expose runner-style entrypoints so tests can assert real command behavior. `install-app` now prints the permission summary before prompting, cancels cleanly without commit, and still supports `--yes`. `uninstall-app` now verifies runner-level success, failure, and restart guidance. |
| Manifest/scope contract | `validate-manifest.test.ts` fixtures now use app-root-relative paths. New bundled-manifest and runtime-scope contract tests verify first-party manifests validate cleanly, emit no scope-prefix warnings, and enforce accept/reject scope behavior for echo, notes, and chatbot. |
| Bundled manifest cleanup | `apps/food/manifest.yaml` now uses `options` instead of the invalid `enum` field for the `routing_primary` `user_config` entry, so the bundled-manifest sweep passes against the live schema. |
| Docs / traceability | Stage 6 findings, URS traceability, codebase review findings, and the UAT checklist were updated to reflect the remediation and the new behavioral evidence. |

### Files Touched

- **Modified:** `core/src/services/app-registry/loader.ts`
- **Modified:** `core/src/services/app-registry/__tests__/loader.test.ts`
- **Modified:** `core/src/services/app-registry/__tests__/registry.test.ts`
- **Modified:** `core/src/services/app-installer/index.ts`
- **Modified:** `core/src/services/app-installer/__tests__/installer.test.ts`
- **Modified:** `core/src/cli/install-app.ts`
- **Modified:** `core/src/cli/uninstall-app.ts`
- **Modified:** `core/src/cli/__tests__/install-app.test.ts`
- **Modified:** `core/src/cli/__tests__/uninstall-app.test.ts`
- **Modified:** `core/src/schemas/__tests__/validate-manifest.test.ts`
- **New:** `core/src/schemas/__tests__/bundled-manifests.test.ts`
- **New:** `core/src/services/data-store/__tests__/manifest-scope-contract.test.ts`
- **Modified:** `apps/food/manifest.yaml`
- **Modified:** `docs/test-review-stage-6-findings.md`
- **Modified:** `docs/urs.md`
- **Modified:** `docs/codebase-review-findings.md`
- **Modified:** `docs/implementation-phases.md`
- **Modified:** `docs/uat-checklist.md`

### Verification

- Targeted Stage 6 suites passed for loader/registry, installer, install/uninstall runners, manifest validation, bundled-manifest sweep, and runtime scope contracts
- Full `pnpm test` passed
- `pnpm build` passed cleanly

---
---

## Review Phase 7 Remediation

**Date:** 2026-04-25  **Status:** Complete  **Part of:** Staged test/spec coverage review

### Motivation

The Stage 7 review found three remaining food-foundation gaps:

- the targeted space-aware food photo/store seam was still implemented and tested as shared-only
- the broad route-level integration suites collapsed shared and user stores onto the same mock, hiding scope-boundary mistakes
- the food app still lacked a manifest/runtime contract test proving shared and user scope declarations matched real store enforcement

This remediation was deliberately kept narrow. It closes the Stage 7 review findings without attempting the broader active-space food migration for pantry photos, callback-space plumbing, or non-photo shared-data flows.

### Changes

| Area | Change |
|------|--------|
| Photo context + router | `PhotoContext` now carries optional `spaceId` / `spaceName`, and router photo dispatch now enriches those fields from the caller's active space before handing the request to apps. |
| Food store resolution | `apps/food/src/utils/household-guard.ts` now exposes `resolveFoodStore(...)`, which checks food-household membership from shared `household.yaml` first and then resolves either the shared store or the active-space store. |
| Photo writes + interaction records | The food photo handler now routes recipe, receipt, and grocery photo writes plus interaction records through the resolved store, producing `users/shared/food/...` paths in shared mode and `spaces/<spaceId>/food/...` paths in active-space mode. |
| Test hardening | `route-dispatch.test.ts` and `shadow-primary.integration.test.ts` now use distinct shared and user stores, with regressions that fail if nutrition-target reads cross the scope boundary. |
| Manifest/runtime contract | New `manifest-runtime-contract.test.ts` validates `apps/food/manifest.yaml`, asserts zero `warnScopePathPrefix()` warnings, and proves representative accept/reject path behavior with real `DataStoreServiceImpl` enforcement. |
| Deferred scope | Pantry-photo space-awareness, callback-space plumbing, non-photo shared-data active-space migration, and cross-scope read reconciliation were explicitly deferred and documented as follow-up work rather than being partially folded into this review pass. |

### Files Touched

- **Modified:** `core/src/types/telegram.ts`
- **Modified:** `core/src/services/router/index.ts`
- **Modified:** `core/src/services/router/__tests__/router.test.ts`
- **Modified:** `apps/food/src/utils/household-guard.ts`
- **Modified:** `apps/food/src/handlers/photo.ts`
- **Modified:** `apps/food/src/__tests__/household-guard.test.ts`
- **Modified:** `apps/food/src/__tests__/photo-handler.test.ts`
- **Modified:** `apps/food/src/__tests__/interaction-recording.test.ts`
- **Modified:** `apps/food/src/__tests__/route-dispatch.test.ts`
- **Modified:** `apps/food/src/__tests__/shadow-primary.integration.test.ts`
- **New:** `apps/food/src/__tests__/manifest-runtime-contract.test.ts`
- **Modified:** `docs/test-review-stage-7-findings.md`
- **Modified:** `apps/food/docs/urs.md`
- **Modified:** `docs/implementation-phases.md`
- **Modified:** `docs/uat-checklist.md`
- **Modified:** `docs/open-items.md`

### Verification

- Targeted Phase 7 suites passed: 7 files, 162 tests
- Full `pnpm test` hit an unrelated timeout in `core/src/services/reports/__tests__/report-service.test.ts` during concurrent Hermes work and was left out of scope for this remediation
- `pnpm build` passed cleanly

### Consequences

- Food photo flows now have a protected active-space write seam without claiming a full food-app active-space migration.
- The review docs now explicitly distinguish what Phase 7 fixed from what remains deferred, reducing the chance of treating pantry photos or callback/message shared-data flows as already migrated.
- The lingering `forShared(scope)` selector limitation remains separately tracked in `docs/open-items.md` and is called out by the new manifest/runtime contract test rather than being silently masked.

---
---

## Phase LLM Enhancement #2 Chunk B: Food Shadow Classifier

**Date:** 2026-04-22  **Status:** Complete  **Part of:** LLM Enhancement Opportunities Plan (item #2)

### Motivation

Food's `handleMessage` uses a long ordered regex cascade for routing. Chunk B adds a shadow observation layer: a fast-tier LLM classifier runs alongside (never replacing) the regex cascade, logs its result, and computes an agreement verdict. The data from shadow mode will inform whether the LLM can safely replace the cascade in a later chunk.

### Changes

| Area | Change |
|------|--------|
| Shadow taxonomy | New `apps/food/src/routing/shadow-taxonomy.ts` — `FOOD_SHADOW_LABELS` (27-label set from manifest + 'none'), `buildLabelsFromManifest()`, `REGEX_TO_MANIFEST_MAP` (cascade key → manifest intent), `INTENTIONALLY_UNMAPPED_LABELS`, `isValidShadowLabel()`, `normalizeRegexLabel()` |
| Shadow logger | New `apps/food/src/routing/shadow-logger.ts` — `FoodShadowLogger` writes per-user markdown log entries with YAML frontmatter, code-point-safe truncation, concurrent-write mutex, anti-injection escaping |
| Shadow classifier | New `apps/food/src/routing/shadow-classifier.ts` — `FoodShadowClassifier` (fast-tier LLM call, per-call sample rate, 9-category error degrade, never throws), `buildShadowClassifierPrompt()`, `parseShadowResponse()` |
| Persona dataset | New `apps/food/src/routing/__tests__/shadow-classifier.personas.ts` — 27-persona curated spec with `deterministicRejectFor` (provable regex-cascade routes for B.3 integration tests) and `advisoryNearMisses` (LLM-dependent near-misses) |
| Tests | New `shadow-taxonomy.test.ts` (66 tests), `shadow-logger.test.ts` (18), `shadow-classifier.test.ts` (118), `shadow-classifier.persona.test.ts` (37) |
| URS | `docs/urs.md` — REQ-LLM-032 (taxonomy + logger) and REQ-LLM-033 (classifier + personas) added; matrix updated |

### End-of-Phase Review Fixes (Codex P1/P2/M1–M4)

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| P1 | Important | `rejectFor` did not distinguish deterministic routes from LLM-dependent near-misses; "eggs are $3.50 at Costco" was a price-update (write) phrase in the price-query accept array | Split into `deterministicRejectFor` + `advisoryNearMisses`; moved 3 non-deterministic entries; replaced price-update phrase with query phrasing |
| P2 | Important | Duplicate 27-row `PERSONA_TABLE` in `shadow-classifier.test.ts` superseded by persona dataset smoke tests | Deleted the taxonomy/plumbing spec block (28 tests removed) |
| P2 | Important | Stale `REGEX_TO_MANIFEST_MAP` docblock claimed "(route-dispatched) maps to 'none'" but the key is intentionally absent | Removed the two stale docblock lines |
| M1 | Minor | 2 error paths in `classifyLLMError` untested: `LLMCostCapError + scope:reservation-exceeded` and `status:429` | Added 2 tests; updated comment to document all reachable paths |
| M2 | Minor | Fence-strip lines in `parseShadowResponse` had no explanation | Added inline comments explaining why fences are stripped defensively |
| M3 | Minor | `sanitizeInput` had `maxLength = 2000` default (different from `MAX_INPUT_CODE_UNITS = 1000`) — dead-code drift risk | Dropped the default; function always called with explicit value |
| M4 | Minor | `classify()` passed original `userText` to `buildShadowClassifierPrompt` after early-exit trim — double-trim silently skipped | Changed to pass `trimmed` |

### Files Touched

- **New:** `apps/food/src/routing/shadow-taxonomy.ts`
- **New:** `apps/food/src/routing/shadow-logger.ts`
- **New:** `apps/food/src/routing/shadow-classifier.ts`
- **New:** `apps/food/src/routing/__tests__/shadow-taxonomy.test.ts`
- **New:** `apps/food/src/routing/__tests__/shadow-logger.test.ts`
- **New:** `apps/food/src/routing/__tests__/shadow-classifier.test.ts`
- **New:** `apps/food/src/routing/__tests__/shadow-classifier.personas.ts`
- **New:** `apps/food/src/routing/__tests__/shadow-classifier.persona.test.ts`
- **Modified:** `docs/urs.md` — REQ-LLM-032 + REQ-LLM-033 added; traceability matrix updated
- **Modified:** `CLAUDE.md` — Chunk B status updated to Complete
- **Modified:** `docs/implementation-phases.md` — this entry

### Verification

- `pnpm test` — 7503 tests across 304 test files, all green
- `pnpm lint` — clean

### Consequences

- The shadow classifier runs in observe-only mode; Food routing behavior is unchanged.
- `FOOD_PERSONAS.deterministicRejectFor` entries are ready to drive B.3 integration tests that assert the regex cascade routes each phrase to `correctLabel`, not `persona.label`.
- Chunk C (B.3 wiring into `handleMessage` + shadow logger call + verdict computation) is the next phase.

---

## Phase LLM Enhancement #2 Chunk C: Shadow Classifier Integration

**Date:** 2026-04-22  **Status:** Complete  **Part of:** LLM Enhancement Opportunities Plan (item #2)

### Motivation

Chunks A and B shipped route-first dispatch and the shadow classifier infrastructure. Chunk C wires the classifier into `handleMessage` in shadow-only (observe) mode: it runs concurrently with the regex cascade, logs an agreement verdict to `shadow-classifier-log.md`, and has zero effect on user-visible routing. This produces the telemetry needed before the eventual Chunk D switchover.

### Changes

| Area | Change |
|------|--------|
| Verdict helper | New `apps/food/src/routing/shadow-verdict.ts` — `computeVerdict(regexWinnerLabel, shadow)` pure function mapping `(FoodShadowLabel, ShadowResult)` → `ShadowVerdict` |
| Integration shim | New `apps/food/src/routing/shadow-integration.ts` — `startShadow()`, `finalizeShadow()`, `initShadowDeps()`, test seams `__setShadowDepsForTests` / `__clearShadowDepsForTests` / `__flushShadowForTests` |
| `handleMessage` wiring | `apps/food/src/index.ts` — `regexWinner` mutable variable set per branch; all early-exit gates substitute synthetic promises; try/finally on regex cascade calls `finalizeShadow`; `shadow_sample_rate` read per-message from `services.config`; `init()` constructs default `FoodShadowClassifier` + `FoodShadowLogger` |
| Shadow classifier fix | `apps/food/src/routing/shadow-classifier.ts` — changed `Logger` (pino) → `AppLogger` (@pas/core/types); updated `warn()` to string-first form |
| Manifest | `apps/food/manifest.yaml` — added `shadow_sample_rate: number` (default 1) to `user_config` |
| Tests | New `shadow-verdict.test.ts` (10 unit), `shadow-integration.test.ts` (12 integration + 1 Layer 4 persona); `route-dispatch.test.ts` Group 4b extended (+4 gate-ordering guards); `shadow-classifier.test.ts` updated for `AppLogger` |
| Test pollution fixes | `app.test.ts`, `contextual-food-question.test.ts`, `natural-language.test.ts`, `natural-language-h11.test.ts`, `natural-language-h11z.test.ts` — added `__clearShadowDepsForTests()` in `beforeEach` to prevent module-level shadow state from consuming LLM stubs |
| URS | `docs/urs.md` — REQ-LLM-034 added; traceability matrix updated |

### Files Touched

- **New:** `apps/food/src/routing/shadow-verdict.ts`
- **New:** `apps/food/src/routing/__tests__/shadow-verdict.test.ts`
- **New:** `apps/food/src/routing/shadow-integration.ts`
- **New:** `apps/food/src/__tests__/shadow-integration.test.ts`
- **Modified:** `apps/food/src/index.ts` — shadow pipeline wired into `handleMessage`
- **Modified:** `apps/food/src/routing/shadow-classifier.ts` — AppLogger fix
- **Modified:** `apps/food/src/routing/__tests__/shadow-classifier.test.ts` — AppLogger update
- **Modified:** `apps/food/manifest.yaml` — `shadow_sample_rate` user_config entry
- **Modified:** `apps/food/src/__tests__/route-dispatch.test.ts` — Group 4b (4 new tests)
- **Modified:** `apps/food/src/__tests__/app.test.ts` — shadow pollution fix
- **Modified:** `apps/food/src/__tests__/contextual-food-question.test.ts` — shadow pollution fix
- **Modified:** `apps/food/src/__tests__/natural-language.test.ts` — shadow pollution fix
- **Modified:** `apps/food/src/__tests__/natural-language-h11.test.ts` — shadow pollution fix
- **Modified:** `apps/food/src/__tests__/natural-language-h11z.test.ts` — shadow pollution fix
- **Modified:** `docs/urs.md` — REQ-LLM-034 added; traceability matrix updated
- **Modified:** `CLAUDE.md` — Chunk C status updated to Complete
- **Modified:** `docs/implementation-phases.md` — this entry

### Verification

- `pnpm test` — 7529 tests across 306 test files, all green (+26 new tests)
- `pnpm lint` — clean

### Consequences

- The shadow classifier now writes one log entry per inbound text message to `data/system/food/shadow-classifier-log.md`.
- All early-exit gates (empty text, number-select, cook-mode, pending flows, Chunk A route-dispatch) produce `skipped-*` entries rather than silence, giving Chunk D a complete traffic picture.
- `shadow_sample_rate` config (default 1) can be set to 0 via GUI to halt classifier calls without restart.
- Chunk D (switchover: promote shadow classifier to primary router once ≥95% agreement over ≥1 week) is the final remaining step for LLM Enhancement #2.

---

## Phase Hermes P1 Chunk B: Wire ConversationService into Router

**Branch:** `hermes-p1-chunk-b` | **Status:** Complete | **Tests added:** ~15

### Goal

Replace the router's "dispatch to chatbot app" fallback with a direct call to a new `ConversationService` class in core. Preserves per-user disable via `AppToggleStore`, household-aware data paths via `DataStoreServiceImpl`, and the route-verifier `rv:<pendingId>:<chosenAppId>` callback. Additive-only — `chatbotApp`/`fallbackMode` are preserved for Chunks B–C back-compat; removal is Chunk D.

### Key files

- **Created:** `core/src/services/conversation/conversation-service.ts` — `ConversationService` class; owns `ConversationHistory({ maxTurns: 20 })`; `ConversationServiceDeps = Omit<HandleMessageDeps, 'history'>`
- **Created:** `core/src/services/conversation/__tests__/conversation-service.test.ts` — 4 unit tests (ALS delegation, stable history, LLMRateLimitError surface, concurrency)
- **Created:** `core/src/services/conversation/__tests__/dispatch.integration.test.ts` — 3 integration tests (telegram send fires, household-aware history path, per-user disable gate)
- **Created:** `core/src/services/data-store/__tests__/conversation-scope-contract.test.ts` — 1 contract test (CONVERSATION_DATA_SCOPES accepted/traversal rejected)
- **Modified:** `core/src/services/conversation/index.ts` — exports for ConversationService + ConversationServiceDeps
- **Modified:** `core/src/services/router/index.ts` — `conversationService?` option + field + `dispatchConversation()` helper; fallback branches prefer conversationService when wired
- **Modified:** `core/src/services/router/__tests__/router.test.ts` — 4 new cases (preferred, fallback, disable, error isolation)
- **Modified:** `core/src/services/router/__tests__/router-verification.test.ts` — 1 new case (verifier picks chatbot → conversationService, testing-standards rule #2)
- **Modified:** `core/src/types/config.ts` — `@deprecated` on `fallback`; new `_legacyKeys?` field (Removed in D.4)
- **Modified:** `core/src/services/config/index.ts` — populates `_legacyKeys.defaultsFallback` (Removed in D.4)
- **Modified:** `core/src/compose-runtime.ts` — constructs ConversationService with dedicated LLMGuard + DataStore + AppConfigService; passes to Router; rv:chatbot callback prefers conversationService; deprecation warning on `_legacyKeys.defaultsFallback` (Removed in D.4)
- **Modified:** `core/src/__tests__/compose-runtime.smoke.integration.test.ts` — 1 new case (ConversationService wired into Router)
- **Modified:** `docs/urs.md` — REQ-CONV-003/004/005/014/015 + traceability matrix
- **Modified:** `docs/open-items.md` — Chunk D entries (chatbot deletion, SystemConfig cleanup, Router cleanup, SystemInfoService cleanup)

### Verification

- `pnpm -r test` — all tests green, zero failures
- `pnpm -r build` — clean
- All 80 chatbot app tests still pass (shim unchanged)
- Notes-mode back-compat tests still pass (router-spaces.test.ts, context-promotion.test.ts)

### Consequences

- Free-text fallback dispatch no longer routes through the chatbot app module; it calls `ConversationService.handleMessage` directly via `Router.dispatchConversation`.
- The chatbot app remains loaded for `/ask` and `/edit` commands; full removal is Chunk D.
- A dedicated `LLMGuard` (60 req/hr, $15/mo cap) wraps ConversationService — rate limit errors surface as friendly replies.
- Conversation history writes to `data/households/<hh>/users/<userId>/chatbot/history.json` when household service is wired (always in production).

---

## Phase Hermes P1 Chunk C: ConversationService — Daily Notes, AppConfig, Cleanup

**Branch:** `hermes-p1-chunk-c` | **Status:** Complete | **Tests added:** ~20

### Goal

Wire daily-notes opt-in, AppConfigService, and model-journal tag extraction into `ConversationService`. Retire the `chatbot` keyword from the app system prompt. Add per-user `log_to_notes` override resolution. REQ-CONV-014 (daily-notes) and REQ-CONV-010 (`chat.log_to_notes` config field) implemented here.

### Key files

- **Modified:** `core/src/services/conversation/conversation-service.ts` — `appendDailyNote`, `resolveUserBool`, `chatLogToNotesDefault` wired
- **Modified:** `core/src/services/conversation/__tests__/daily-notes.test.ts` — 4 cases
- **Modified:** `core/src/services/conversation/__tests__/system-data.test.ts` — system-data emission tests
- **Modified:** `docs/urs.md` — REQ-CONV-014, REQ-CONV-010 entries

---

## Phase Hermes P1 Chunk D.1: Virtual Chatbot Registry Entry

**Branch:** `hermes-p1-chunk-d1` | **Status:** Complete | **Tests added:** 5

### Goal

Register a virtual `'chatbot'` app entry in `AppRegistry` so app-aware code (toggle store, GUI config) can treat ConversationService as a first-class app without loading a real app module (REQ-CONV-013).

### Key files

- **Modified:** `core/src/services/app-registry/index.ts` — `registerVirtual()` + `buildVirtualChatbotApp()`; `VIRTUAL_CHATBOT_PATH` constant exported
- **Modified:** `core/src/compose-runtime.ts` — `registerVirtual()` called immediately after `loadAll()`
- **Modified:** `core/src/services/conversation/__tests__/virtual-app-tripwire.integration.test.ts` — 5 new tests
- **Modified:** `docs/urs.md` — REQ-CONV-013

---

## Phase Hermes P1 Chunk D.2: Test Migration

**Branch:** `hermes-p1-chunk-d2` | **Status:** Complete | **Tests added:** 0 (migration only — ~5,455 LOC moved)

### Goal

Migrate all 12 chatbot test files from `apps/chatbot/src/__tests__/` to `core/src/services/conversation/__tests__/`. No new coverage; test infrastructure aligned with core.

### Key files

- **Deleted:** all 12 test files under `apps/chatbot/src/__tests__/`
- **Created:** 8 split target files in `core/src/services/conversation/__tests__/` (conversation-service, prompt-builder, handle-ask, auto-detect, pas-classifier, control-tags, model-journal, system-data)

---

## Phase Hermes P1 Chunk D.3: Delete Chatbot App Source

**Branch:** `hermes-p1-chunk-d3` | **Status:** Complete | **Tests added:** 5

### Goal

Delete `apps/chatbot/src/` source files. Remove `chatbotApp` and `fallbackMode` from `RouterOptions` and the `Router` class. Remove `'chatbot'` from `PROTECTED_APPS`. Rewrite `manifest-parity.test.ts` as a full virtual-manifest contract test.

### Key files

- **Deleted:** all source files under `apps/chatbot/src/`
- **Modified:** `core/src/services/router/index.ts` — `chatbotApp`/`fallbackMode` removed; `sendToFallback` simplified (config.fallback branch deferred to D.4)
- **Modified:** `core/src/schemas/__tests__/manifest-parity.test.ts` — rewritten as virtual-manifest contract test
- **Modified:** `docs/urs.md` — REQ-CONV-011/012/013/021, REQ-INSTALL-007

---

## Phase Hermes P1 Chunk D.4: Final Legacy Fallback Cleanup

**Branch:** `hermes-p1-chunk-d4` | **Status:** Complete | **Tests added:** 0 (deletions only)

### Goal

Remove the last legacy fallback surface: `SystemConfig.fallback`, `SystemConfig._legacyKeys`, `SystemInfoService.fallbackMode`, the `defaults.fallback` config parser and zod schema entry, the startup deprecation warning, the `Fallback mode:` line in conversation system-data, and the router's `config.fallback === 'notes'` branch. **Hermes P1 is complete.**

### Key files (source)

- **Modified:** `core/src/types/config.ts` — deleted `fallback` and `_legacyKeys` fields
- **Modified:** `core/src/types/system-info.ts` — deleted `fallbackMode` from `SystemStatusInfo`
- **Modified:** `core/src/services/system-info/index.ts` — removed `fallbackMode` option/field/constructor/return
- **Modified:** `core/src/services/conversation/system-data.ts` — removed `'fallback'` keyword + `Fallback mode:` line
- **Modified:** `core/src/services/router/index.ts` — removed `config.fallback === 'notes'` branch from `sendToFallback()`
- **Modified:** `core/src/compose-runtime.ts` — removed `fallbackMode` arg + deprecation warning block
- **Modified:** `core/src/services/config/index.ts` — removed `fallback` field + `_legacyKeys` assignment
- **Modified:** `core/src/services/config/pas-yaml-schema.ts` — removed `fallback` from `defaults` schema

### Verification

- `pnpm -r build` — clean
- `pnpm -r test` — 4284 tests, 0 failures

---

## Hermes P1: Status Complete

**Hermes P1 (Chunks A → B → C → D.1 → D.2 → D.3 → D.4) is complete as of 2026-04-27.**

ConversationService is now a first-class core service. The chatbot app source is deleted. All legacy `fallback`/`_legacyKeys` surface is removed. Phases P2–P5 (ConversationRetrievalService, session persistence, memory snapshot, FTS5 search) remain deferred per `docs/open-items.md`.

---

## Hermes P4: Durable-Memory Snapshot + Fenced Recall — COMPLETE

**Hermes P4 (Chunks 0 → A → B → C → D → E → F) is complete as of 2026-04-28.**

### What was built

Two concerns addressed in one phase:

**Prompt-prefix stability (Layer 2)** — every turn previously rebuilt the system prompt from scratch including live ContextStore entries, invalidating the LLM's prefix cache on every turn. P4 freezes durable ContextStore entries into a `MemorySnapshot` at session-mint time (`ensureActiveSession`), persists it in session frontmatter, and injects it as Layer 2 — between the static base prompt and per-turn user-context — via a `<memory-context label="durable-memory">` fenced block. The per-turn `gatherContext` ContextStore read is removed entirely.

**Fenced recall wrapper (Layers 2 + 4)** — recalled content now lands inside a `<memory-context>` block with sanitized payload (nested backtick collapse, role-tag neutralization), framing tags outside the code fence. This signals to the LLM that the content is reference data, not a new instruction source.

### Files added / modified

| Path | Change |
|------|--------|
| `core/src/services/prompt-assembly/memory-context.ts` (new) | `buildMemoryContextBlock`, `sanitizeContextContent`, `toFrontmatter`, `parseMemorySnapshotFrontmatter` |
| `core/src/types/conversation-session.ts` | `MemorySnapshot` interface |
| `core/src/services/conversation-retrieval/conversation-retrieval-service.ts` | `buildMemorySnapshot()` method |
| `core/src/services/conversation-session/chat-session-store.ts` | `ensureActiveSession`, `peekSnapshot`, `memory_snapshot` frontmatter field |
| `core/src/services/conversation/prompt-builder.ts` | Layer 2 injection, Layer 4 fenced wrapping, options-object API, removed per-turn durable injection |
| `core/src/services/conversation/app-data.ts` | `gatherContext` returns `[]` — ContextStore no longer read per-turn |
| `core/src/services/conversation/handle-message.ts` | `ensureActiveSession` replaces `gatherContext`; snapshot threaded to prompt builders |
| `core/src/services/conversation/handle-ask.ts` | Mirror of handle-message wiring |
| `docs/urs.md` | REQ-CONV-MEMORY-001..012 + traceability matrix |
| `docs/superpowers/specs/2026-04-28-hermes-p4-memory-snapshot-design.md` (new) | Design spec |
| `docs/open-items.md` | P4 complete, P6 deferrals logged |

### Key architectural decisions

| Decision | Choice |
|----------|--------|
| Snapshot persistence | Session frontmatter `memory_snapshot:` (snake_case YAML; camelCase TS via mapping helpers) |
| Snapshot input source | All `ContextStore.listForUser(userId)` entries (alphabetical sort; typed-kind filter deferred to P6) |
| Snapshot mint timing | Inside `ensureActiveSession`, before any prompt assembly — first turn sees Layer 2 |
| Failure mode | `status: 'degraded'` when retrieval wired and `buildMemorySnapshot` throws; no field when retrieval absent |
| Per-turn injection | Removed — `gatherContext` returns `[]`; durable memory enters only via the frozen snapshot |
| Layer 2 insertion | After static base prompt, before `appendUserContextSection` — maximizes prefix-cache stability |
| Race guard | `ensuredSessionId` from `ensureActiveSession` replaces `ctx.sessionId` as `expectedSessionId` in `appendExchange` |
| Fenced wrapper format | Tags outside code fence; sanitized payload inside — framing reads as instruction, payload reads as data |

### Verification

- `pnpm test` — 362 test files / 8401+ tests / 0 failures
- Persona test: `memory-snapshot.persona.test.ts` — freeze semantic, mid-session mutation isolation, new-session snapshot rebuild (7 tests)
- Prefix-cache stability: two consecutive turns with identical snapshot produce byte-identical Layer 2 block

---

## Hermes P5: SQLite + FTS5 Transcript Search — COMPLETE

**Hermes P5 (Chunks 0 → A → B → C → D → E → F → G → H) is complete as of 2026-04-28.**

### What was built

Full-text search across chat session transcripts, auto-injected as recalled context on every conversational turn.

**SQLite + FTS5 derived index** — `data/system/chat-state.db` holds three tables: `sessions` (per-session metadata), `messages` (per-turn content), and `messages_fts` (FTS5 virtual table with triggers for insert/delete/update). PRAGMA initialization (`WAL`, `foreign_keys`, `busy_timeout=5000`, `synchronous=NORMAL`) on every connection. Schema migrations via `PRAGMA user_version`. Jittered retry (`withSqliteRetry`, 15 attempts, 20–150ms backoff). WAL checkpoint every 50 writes.

**Local-first invariant** — Markdown transcripts are canonical; SQLite is always derived. `pnpm chat-index-rebuild` walks both legacy (`data/users/<userId>/chatbot/…`) and household (`data/households/<hhId>/users/<userId>/chatbot/…`) layouts, decodes transcripts via `transcript-codec.decode`, and rebuilds the DB from scratch (prior DB deleted, stale sessions cannot persist).

**Live indexer hook** — `ChatSessionStore.appendExchange` and `endActive` call `index.upsertSession` / `index.appendMessage` / `index.endSession` awaited best-effort inside a try/catch; transcript writes win, DB failures are logged.

**Two-stage recall pipeline** — on every free-text turn and `/ask`:
1. Sync `recallPreFilter` (no LLM call for `/commands`, greetings, short messages)
2. Fast-tier LLM `classifyRecallIntent` → `{shouldRecall, query, timeWindow}` (output validated as untrusted; malformed → no-recall)
3. `buildUntrustedQuery` sanitizer (operator stripping, zero-width removal, term-list output)
4. `searchSessions({userId, householdId, queryTerms, excludeSessionIds:[activeSession], startedAfter?})`
5. Layer 5 `<memory-context label="recalled-session">` injected before conversation history in both `buildSystemPrompt` and `buildAppAwareSystemPrompt`

**Opt-in retention** — `chat.sessions.auto_prune: false` (default), `chat.sessions.retention_days: 90`. Prune deletes `.md` file (canonical), DB rows, and sweeps `active-sessions.yaml` via `Map<userId, Set<sessionId>>` (user-scoped to prevent cross-user contamination). Active sessions (no `ended_at`) are never pruned.

### Files added / modified

| Path | Change |
|------|--------|
| `core/src/services/chat-transcript-index/` (new dir) | `index.ts`, `chat-transcript-index.ts`, `schema.ts`, `retry.ts`, `fts-query.ts`, `types.ts`, `rebuild.ts`, `prune.ts` + `__tests__/` |
| `core/src/services/conversation/recall-pipeline.ts` (new) | `recallPreFilter`, recall orchestration helper |
| `core/src/services/conversation/prompt-assembly/recalled-sessions.ts` (new) | `formatRecalledSessions`, `wrapInRecalledFence` |
| `core/src/services/conversation/prompt-builder.ts` | Layer 5 block before history; `recalledSessions?` option |
| `core/src/services/conversation/handle-message.ts` | Recall pipeline before PAS classifier |
| `core/src/services/conversation/handle-ask.ts` | Mirror of handle-message recall wiring |
| `core/src/services/conversation-retrieval/conversation-retrieval-service.ts` | `searchSessions` method (user-scoped, no caller-supplied userId) |
| `core/src/services/conversation-retrieval/source-policy.ts` | `conversation-transcripts` allowed category |
| `core/src/services/conversation-session/chat-session-store.ts` | Live indexer hook (`upsertSession`, `appendMessage`, `endSession`) |
| `core/src/services/conversation-retrieval/recall-classifier.ts` (new) | Fast-tier LLM classifier + untrusted-output coercion |
| `core/src/runtime/compose-runtime.ts` | `ChatTranscriptIndex` instantiation + migrations + `close()` in `dispose()` |
| `core/src/types/config.ts` | `chat.sessions.auto_prune`, `chat.sessions.retention_days` |
| `scripts/chat-index-rebuild.ts` (new) | `pnpm chat-index-rebuild` CLI |
| `scripts/chat-index-prune.ts` (new) | `pnpm chat-index-prune` CLI |
| `docs/urs.md` | REQ-CONV-SEARCH-001..014 + traceability matrix |
| `docs/superpowers/specs/2026-04-28-hermes-p5-transcript-search-design.md` (new) | Design spec |
| `docs/open-items.md` | P5 complete, carry-forward items logged |

### Key architectural decisions

| Decision | Choice |
|----------|--------|
| Index scope | System-scoped (`data/system/chat-state.db`); `user_id`/`household_id` columns gate every query |
| Ownership authority | Path-derived `userId`/`householdId` are authoritative; frontmatter mismatches → warn + skip |
| Search auth | Strictly user-scoped — `searchSessions` reads userId from `requestContext`, no caller param; same-household cross-user forbidden |
| Recall invocation | Every free-text turn + `/ask`, independent of `auto_detect_pas` |
| Prompt layer | Layer 5 — before conversation history, after durable-memory snapshot (Layer 2) |
| Classifier failure | Log + treat as `shouldRecall=false`; turn proceeds |
| Prune scope | Only `ended_at IS NOT NULL AND ended_at < cutoff`; active sessions never pruned |
| Prune canonical deletion | Deletes `.md` file; rebuild cannot restore pruned sessions |
| Windows lifecycle | `close()` called in `dispose()` releases SQLite file lock before temp-dir cleanup |

### Verification

- `pnpm test` — 376 test files / 8593 tests / 0 failures
- Persona test: `transcript-recall.persona.test.ts` — 16 scenarios (S1–S16): recall positive, no-recall, auth boundary, active-session dedupe, legacy import, hostile content sanitization, prune respects retention
- Integration test: `transcript-recall.integration.test.ts` — 5 cases via `composeRuntime({dataDir})` (T1–T3)
- Rebuild parity: delete DB → rebuild → search returns same hits; corrupt transcript skipped
- Post-merge Codex corrections: stale rebuild reconciliation, path-derived ownership authority, Layer 5 ordering before history, user-scoped prune sweep, lint gate clean (0 blocking errors)

---

## Hermes P7 Chunk A — Session Auto-Titling (2026-04-28)

**Delivered**: Automatic LLM-generated session titles + manual `/title` command.

- `title-generator.ts`: fast-tier LLM call with 3–7 word validation, no-Markdown, no-quotes constraint
- `title-service.ts`: `applyTitle` writes Markdown frontmatter (canonical) then SQLite (derived, failure-tolerant); `skipIfTitled` guard
- `auto-title-hook.ts`: `runTitleAfterFirstExchange` — fires after first exchange, non-blocking, skips if session already titled
- `handle-message.ts` / `handle-ask.ts`: fire-and-forget auto-title after first successful reply
- `ConversationService.handleTitle`: `/title` display (shows current or "(none)") and `/title <phrase>` manual set
- `ChatTranscriptIndex.updateTitle`: derives SQLite update from Markdown canonical write
- `ChatSessionStore.setTitle`: sanitizes (control chars stripped, whitespace collapsed, truncated at 80 chars), rejects empty
- Router: `/title` command wired as built-in alongside `/newchat`, `/reset`
- `compose-runtime.ts`: `TitleService` instantiated and injected into `handleMessage`, `handleAsk`, `handleTitle`
- 8 URS requirements: REQ-CONV-TITLE-001 through REQ-CONV-TITLE-008
- Tests: persona test (`auto-titling.persona.test.ts`), `handle-message-auto-title.test.ts`, `handle-ask-auto-title.test.ts`, `title-generator.test.ts`, `title-service.test.ts`, `chat-session-store.setTitle.test.ts`, `conversation-service.test.ts`

---

## Hermes P7 Chunk B — NL /newchat Classifier (2026-04-28)

**Delivered**: Natural-language session-reset detection for free-text messages.

- `session-control-classifier.ts`: synchronous keyword pre-filter (16 phrases) + fast-tier LLM two-stage pipeline
- `pending-session-control-store.ts`: in-memory TTL store for grey-zone pending confirmations (5-minute expiry)
- `Router` extended with `sessionControlClassifier` + `pendingSessionControl` opt-in hook
- `compose-runtime.ts`: `sc:yes` / `sc:no` callback query handlers wired
- 8 URS requirements: REQ-CONV-NEWCHAT-001 through REQ-CONV-NEWCHAT-008
- Tests: 8 router tests + 4 callback integration tests + 17 classifier unit tests + 10 store unit tests

---

## Food Receipt/Price TDD Batches 0–6 + Post-TDD Simplify Pass (2026-05-05)

**Delivered**: Bug closure for receipt/price query handlers + chatbot+DataQuery generalization.

**Batches 0–6** (`ecc6c2b`–`6b7d04a` on `hermes-receipt-tdd`):
- Batch 0: `receipt-query.ts` service isolation, `formatReceiptDetails` 4096-char length guard, `isValidPriceEntry` warning on malformed price entries, shadow taxonomy expansion
- Batch 1: Receipt date validator (`isValidReceiptDate`, calendar-strict, 90-day window) + `capturedAt` as sort authority
- Batch 2: Receipt summary integrity — hallucination counter-instruction injected into `formatReceiptDetails` prompt
- Batch 3: `HandlerResult` void contract — food `handleMessage` yields `{handled:false}` to chatbot fallback for unhandled free-text (RC1); 16 existing tests updated
- Batch 4: Regex tightening (`EXPLICIT_RECEIPT_RE`, `PRICE_LOOKUP_EXCLUDE_RE`, `STORE_SPENDING_RE`, `ITEM_STOPWORDS`) + DataQuery verb expansion to cover receipt/price/spending phrasings (RC2–RC6)
- Batch 5: Chatbot+DataQuery generalization (RC7) — PAS classifier pre-filter for price/receipt/spending intent, `formatDataAnswer` shared utility in `core/src/utils/`, chatbot path handles these questions when no deterministic match fires
- Batch 6: Codex polish — `formatReceiptDetails` guard confirmed at 4096 chars, `isValidPriceEntry` warning confirmed on rejection path

**Post-TDD simplify pass** (commits `2fb70c1`, `f40ed7a`, `0689d44`, `67a0378`, `7457987`):
- `HandlerResult = void | {handled:boolean}` — unblocked `pnpm -r build` (echo + notes apps return `Promise<void>`)
- Compile-time regression test in `core/src/types/__tests__/handler-result.test.ts`
- 5 pre-existing TS errors in `apps/food/src/services/price-store.ts` fixed
- Stale RED/GREEN/RC# comments stripped from 7 test files
- 4 inline `requireHousehold` + `telegram.send` blocks collapsed to `requireHouseholdOrMessage(ctx)`
- Gate/executor split: `handleReceiptQueryIfIntent` / `handlePriceLookupIfIntent` / `handleStoreSpendingIfIntent` replaced by `isXIntent()` + `executeX()` returning `ExecuteOutcome`; `force` param removed
- `writeSeedData(dataDir, householdId)` — fixed household-scope path (`data/households/<id>/shared/food/`); seeded data now actually read at runtime
- `TestCaseMeta` interface + `meta` field on all 10 `iterate-prompts.ts` TEST_CASES (stable IDs, bucket, oracleKind, expectedRoute, seedPointer, coversFiles) for Chunk-C migration to `regression/fixtures/`
- Both untracked regression/settings specs committed; Bucket 2 v0-corpus paragraph updated in persona-regression-suite-design.md
- Two new `docs/open-items.md` entries: deterministic-filter chain inversion (Confirmed Phases) + `formatCheapestPriceAnswer` unit-price metadata (Unfinished Corrections)
- Codex corrections: corpus spec line range + IDs corrected, route-dispatch.test.ts stale comment stripped, `CaseResult` carries `meta`

**Tests**: 409 files / 9136 passing / 10 skipped / 1 todo.

---

## Hermes P6 — Typed Memory + Temporal Recall (2026-05-05)

**Delivered**: Typed `ContextEntry` kinds, sidecar persistence, `listDurableForUser`, threat-scan hardening, `<memory-kind-set>` LLM tag, `RecallVerdict` / `TimeAnchor` discriminated union, DST-correct UTC temporal range conversion, pipeline message-timestamp filtering, and `<session-search>` any-order attribute parser with `after`/`before` temporal filter support.

**Chunk A — ContextEntryKind enum + kinds-sidecar.ts codec**
- `ContextEntryKind` string literal union in `core/src/types/context-store.ts`: `user-preference`, `communication-preference`, `environment-fact`, `project-convention`, `household-policy`, `untyped`; `DURABLE_KINDS` excludes `untyped`
- `kinds-sidecar.ts`: `loadKindsMap` + `setKind`; sidecar at `<context-dir>/.kinds.yaml`; fail-open (corrupt/missing → empty map + warn); invalid kind values skipped + warned
- `listForUser` now decorates returned `ContextEntry` objects with `kind` from sidecar; absent entries → `untyped`
- URS REQ-CONV-KIND-001, REQ-CONV-KIND-002

**Chunk B — ContextStore.save(opts) + threat-scan.ts**
- `ContextStoreService.save(userId, key, content, opts?)` extended with `opts.kind?: ContextEntryKind`; sidecar written atomically after `.md` write
- `threat-scan.ts` validates content before any write; rejects script tags, iframe, prompt-injection patterns; throws `ContextStoreThreatError` with `pattern` field
- URS REQ-CONV-KIND-003

**Chunk C — listDurableForUser + SystemConfig.chat.memory.strict_durable_kinds**
- `listDurableForUser(userId, opts?)` merges `data/system/context/` + `data/users/<userId>/context/`, user wins on key collision, filters to `DURABLE_KINDS`; respects household scoping
- `SystemConfig.chat.memory.strict_durable_kinds` boolean (default `false`); when `true`, `buildMemorySnapshot` uses `listDurableForUser` instead of `listForUser`
- URS REQ-CONV-KIND-004

**Chunk D — buildMemorySnapshot narrowing**
- `buildMemorySnapshot` respects `strict_durable_kinds` config flag; when enabled, only durable-kind entries enter the 4000-char budget window
- `pinnedKeys` carried forward from P8b (`['recent-session-summary']`) still included regardless of kind filtering
- URS REQ-CONV-MEMORY-004 adaptation note updated

**Chunk E — `<memory-kind-set>` control tag**
- `memory-kind-set.ts` in `control-tags/`: `MEMORY_KIND_INTENT_REGEX` + `MEMORY_KIND_SET_TAG_REGEX` + `processMemoryKindSetTags`
- Self-closing form `<memory-kind-set key="..." kind="..."/>` only; unknown key/kind → rejected; tag stripped from final response
- Gated by intent regex requiring memory-management phrasing before injection into system prompt
- URS REQ-CONV-KIND-005

**Chunk F — RecallVerdict TimeAnchor + parseRecallVerdict**
- `TimeAnchor` discriminated union: `null` | `{type:'absolute'; on:string}` | `{type:'window'; after?:string; before?:string}`
- `parseRecallVerdict(raw, opts)` validates LLM JSON; `RECALL_SAFE_DEFAULT` (`shouldRecall:false`) on any violation; future dates rejected; spans > `maxWindowDays` (365) rejected; `after > before` rejected
- `isCalendarStrict(s)` validates YYYY-MM-DD including calendar correctness (rejects Feb 30 etc.)
- URS REQ-CONV-TEMPORAL-001

**Chunk G — Pipeline + message-timestamp filtering**
- `timeAnchorToFilters(anchor, tz)` in `recall-pipeline.ts`: converts `TimeAnchor` to `{messageAfter?, messageBefore?}` UTC bounds using `localDayToUtcRange`
- `localDayToUtcRange(date, tz)` in `core/src/utils/temporal.ts`: DST-correct binary-search via `Intl.DateTimeFormat`; returns `{startUtc, endUtcExclusive}`
- `runRecallPipeline` passes `messageAfter`/`messageBefore` to `searchSessions`; null anchor → no window (legacy 14-day window removed)
- URS REQ-CONV-TEMPORAL-002, REQ-CONV-TEMPORAL-003

**Chunk H — `<session-search>` attr parser + /recall reply formatting**
- `session-search-tag.ts` replaced fixed-order regex with `TAG_OUTER + ATTR_RE` any-order attribute parser; `after`/`before` attrs added to `SessionSearchTagResult`; unknown/duplicate attrs → `rejectAll`; calendar-invalid or after>before → `rejectAll`
- `SESSION_SEARCH_INSTRUCTION_BLOCK` updated with `after`/`before` documentation and examples
- `buildToolContinuationPrompt` surfaces applied filters in result fence label: `session-search-result query="..." after="..." before="..."`; `escapeAttrValue` helper for XML attribute safety
- `handle-message.ts` + `handle-ask.ts`: destructure `after`/`before` from tag; convert to UTC via `localDayToUtcRange`; pass to `searchSessions` and continuation prompt
- `formatTurnTimestamp(iso)` in `recall-reply.ts`: `DOW_ABBR` lookup + `'Tue 2026-04-28 14:32 UTC'` format; `formatRecallReply` now prefixes each turn with `> _<ts> — <Role>_:`
- URS REQ-CONV-TEMPORAL-004, REQ-CONV-TEMPORAL-005, REQ-CONV-TEMPORAL-006

**Tests**: 432 test files / 9590 tests passing / 10 skipped / 1 todo (net +284 tests / +16 test files vs P5 carry-forwards baseline). New test files: `session-search-tag.attr.test.ts` (42 tests), `recall-reply.test.ts` (20 tests), `recall-temporal.persona.test.ts` (34 tests), `kinds-sidecar.test.ts` (9), `context-entry-decoration.test.ts` (7), `context-store-save.integration.test.ts` (15), `list-durable-for-user.test.ts` (12), `memory-kind-set.test.ts` (25), `recall-pipeline.translate.test.ts` (11), `parse-recall-verdict.test.ts` (31), `recall-classifier.test.ts` (22), `temporal.test.ts` (15), plus `recall-temporal.persona.test.ts`.

**URS requirements**: REQ-CONV-KIND-001..005, REQ-CONV-TEMPORAL-001..006 (11 new requirements).

---

## Hermes P6.next — NL Temporal Precision Broadening + Mid-Session Snapshot Rebuild (2026-05-05)

**Delivered**: Extended recall classifier prompt with a `<phrasing reference>` block of 10+ computed NL relative-date examples; new `/refreshmemory` and `/refresh-memory` built-in commands for mid-session memory snapshot rebuild with double-CAS safety.

**Chunk A — NL Temporal Precision Broadening (prompt-only)**
- `recall-classifier.ts`: added `findLastWeekday`, `firstOfMonth`, `firstOfPriorMonth` date helpers; `buildExamples(today)` appends `<phrasing reference>` block with 10 NL forms and exact computed dates
- No changes to `parseRecallVerdict`, `validateTimeAnchor`, 365d cap, or `sanitizeInput`
- URS REQ-CONV-TEMPORAL-007..012

**Chunk B — Mid-Session Snapshot Rebuild**
- `conversation-session/errors.ts`: `NoActiveSessionError` + `SessionCasMismatchError`
- `chat-session-store.ts`: `rebuildMemorySnapshot(ctx, opts)` on interface + `DefaultChatSessionStore`; double-CAS with `withMultiFileLock([index, transcript])` (alphabetical order prevents deadlock vs `endActive`); `buildSnapshot()` called outside all locks; always-persist policy
- `handle-refresh-memory.ts`: new handler; reuses `buildSnapshot` callback pattern from `handle-message.ts`/`handle-ask.ts`; gates `pinnedKeys` on `flush_memory_on_idle_reset`; all sends to `ctx.userId`
- `conversation-service.ts`: `handleRefreshMemory` method wired to core handler
- `router/index.ts`: `/refreshmemory` + `/refresh-memory` in built-in chain, help text, `BUILTIN_COMMAND_NAMES`
- Mock-update sweep: all typed `ChatSessionStore` mocks in test files updated with `rebuildMemorySnapshot` stub
- URS REQ-CONV-MEMORY-013..022

**Tests**: 440 test files / 9758 tests passing / 10 skipped / 1 todo (net +168 tests / +8 test files vs P6 baseline). New test files: `build-classifier-prompt-nl.test.ts` (11 tests), `recall-classifier-sanitize.test.ts` (3 tests), `recall-temporal-nl.persona.test.ts` (15 tests), `rebuild-memory-snapshot.test.ts` (18 tests), `rebuild-memory-snapshot.integration.test.ts` (3 tests), `refresh-memory.persona.test.ts` (29 tests), `router-refresh-memory.test.ts` (21 tests).

**URS requirements**: REQ-CONV-TEMPORAL-007..012, REQ-CONV-MEMORY-013..022 (16 new requirements). REQ-CONV-MEMORY-012 amended by REQ-CONV-MEMORY-022.

---

## Unified Settings Surface — Chunks A + E + F (2026-05-05)

**Delivered**: `SettingsRegistry` composing chatbot virtual manifest + installed app manifests; `SettingsWriter` for coerced per-app writes with 3-layer NL safety; `SettingsReader` injecting a per-turn settings catalog and trusted `<config-set>` instruction block into the chatbot prompt.

- `core/src/services/settings/settings-registry.ts`: `SettingsRegistry` with `register()`, `getAll()`, `getByAppKey()`, `getNlSafeQualifiedKeys()`; qualified key format `appId.key`
- `core/src/services/settings/settings-writer.ts`: `SettingsWriter` with `write(req)`; NL safety gate (adminOnly/dangerous/hidden/non-nlSafe/non-per-user blocked); per-app `AppConfigService` routing; `coerceUserConfigValue` shared coercion
- `core/src/services/settings/settings-reader.ts`: `SettingsReader` with `buildSettingsCatalog()` + `buildConfigSetInstruction()`; split into `memory-context` (catalog) vs plain text (trusted instruction block); `'settings'` source in `ConversationRetrievalService`
- `core/src/services/conversation/manifest.ts`: `CONVERSATION_USER_CONFIG` virtual manifest — chatbot's own settings (14 entries: `log_to_notes`, `flush_memory_on_idle_reset`, `auto_reset_idle_minutes`, etc.)
- Food manifest: 12 nlSafe keys, 2 hidden pseudo-fields, 3 adminOnly+dangerous shadow controls; `nlIntentRegex` on all writable keys
- PAS classifier: `settingsCandidate` flag gates settings injection in free-text mode; default-on in `/ask`
- Legacy `CONFIG_SET_INSTRUCTION_BLOCK` gated on `!settingsTrustedInjected`
- `compose-runtime.ts`: `settingsRegistry`, `settingsWriter`, `appConfigByAppId` wired; `settingsReader` constructed and injected into retrieval service

**Tests**: 452 test files / 10,054 tests passing. New test files: `settings-registry.test.ts`, `settings-writer.test.ts`, `settings-reader.test.ts`, `settings-reader-integration.test.ts`, `settings-nl-safety.test.ts`, `settings-manifest-parity.test.ts`, food manifest parity tests.

**URS requirements**: REQ-SETTINGS-001, 006, 007, 008, 011, 012 (6 new requirements).

---

## Unified Settings Surface — Chunk B: /gui/settings page (2026-05-06)

**Delivered**: Single `/gui/settings` web UI page exposing all per-user settings in collapsible category accordions, with a page-level Save (PRG pattern) and per-row Reset (htmx outerHTML swap). `SettingsWriter` extended with batch validation and atomic per-app persistence.

**API extensions:**
- `core/src/services/settings/settings-writer.ts`: `validate(req)` (pure, synchronous), `writeBatch(items)` (validation-atomic, per-app-atomic persist, cross-app best-effort), `registerPostWriteHook(qKey, fn)`, `runHooksForKey(qKey, ctx)`; `write()` now fires post-write hooks; `writeBatch` rejects mixed-userId batches
- `core/src/services/config/app-config-service.ts`: `removeOverride(userId, key)` — locked single-key removal via `withFileLock`; idempotent
- `core/src/types/config.ts`: `AppConfigService` interface extended with `removeOverride`
- `core/src/services/settings/categories.ts`: new module — shared `CATEGORY_ORDER` + `CATEGORY_LABELS`

**Routes and views:**
- `core/src/gui/routes/settings.ts`: `registerSettingsRoutes` — `GET /settings` (full accordion render), `POST /settings` (validate-atomic + per-app-atomic save, diff against current effective values), `POST /settings/:appId/:key/reset` (locked removal + hook fire + partial HTML response)
- `core/src/gui/views/settings.eta`: single `<form>` wrapping `<details>` accordions; `personal` open by default; correct widgets per type (checkbox+hidden for boolean, number, text, select)
- `core/src/gui/views/partials/setting-row.eta`: per-row partial reused by reset response (layout disabled)
- `core/src/gui/views/layout.eta`: "Settings" nav link added
- `core/src/gui/index.ts`: `GuiOptions` extended; `registerSettingsRoutes` mounted at `/gui`

**Wiring:**
- `core/src/compose-runtime.ts`: `settingsRegistry`, `settingsWriter`, `appConfigByAppId` forwarded to `registerGuiRoutes`; `flush_memory_on_idle_reset` post-write hook registered (true→false triggers `disableFlushAndCleanup`)

**Post-merge simplify pass (Codex corrections):**
- rawValues preserved for ALL submitted fields on validation re-render (not just invalid ones)
- Partial failures redirect with `?partial=1`, not `?saved=1`; success banner gated on `!it.partial`
- `writeBatch` rejects mixed-userId batches with explicit error
- `write()` fires post-write hooks (parity with `writeBatch` + reset path)
- Concurrency tests: YAML validity proven by direct file read + `yaml.parse`; exact value assertions

**Tests**: 458 test files / 10,159 tests passing. New test files: `settings-writer-batch.test.ts` (Slice 0), `app-config-service-remove.test.ts` (Slice 0), `settings.test.ts` (Slices 1–5, 8), `settings.security.test.ts` (Slice 6), `settings.concurrency.test.ts` (Slice 7), `settings.integration.test.ts` (Slice 9).

**URS requirements**: REQ-SETTINGS-002, 003, 004, 005, 014, 015, 016, 017, 018, 019, 020 (11 new requirements).

---

## Open-Items Cleanup Batches (2026-05-06)

Reference index for the smaller pending items in `docs/open-items.md`, grouped by file area so several can be closed in a single session. Sizes follow the S/M/L/XL key in `~/.claude/projects/.../memory/project_pending_item_sizes.md`.

### Batch 1 — GUI cleanup (`core/src/gui/`) — **closed 2026-05-06**

- `app-detail.eta` select-as-text bug — added `else if (def.type === 'select')` branch matching the `/gui/settings` widget pattern (`routes/settings.ts:89-97`). Coercion at `coerce-user-config.ts:68-84` was already correct; render-side fix only.
- `routes/config.ts` → SettingsWriter migration — `chatbot.flush_memory_on_idle_reset` now writes through `SettingsWriter.writeBatch({ source: 'admin-confirmed' })`; the post-write hook registered at `compose-runtime.ts:1044-1051` is the single source of truth. `disableFlushAndCleanup` plumbing removed from `ConfigOptions`, `gui/index.ts`, and `compose-runtime.ts`. Mixed-body chatbot writes batched into one `updateOverrides` call (latent `setAll` vs. `updateOverrides` data-loss bug fixed). CL: `batch1-gui-cleanup`.

### Batch 2 — Chatbot cleanup (`core/src/services/conversation/`)
- `isPasRelevant()` removal — deprecated keyword heuristic, zero production callers; delete function + tests + URS entries
- *Originally bundled here:* `MODEL_SWITCH_INTENT_REGEX` route-first conversion. **Descoped after Codex review (2026-05-06)** — see `docs/open-items.md` for the multi-component design surface (router classifier-branch chatbot special case, `handleMessage` switch processing, prompt-builder route-aware instructions, manifest parity test). Will be planned as its own phase.

### Batch 3 — Conversation router built-ins + recall config ✓ Complete (2026-05-07)

Three items from `docs/open-items.md` (lines 19, 33, 136) closed in a single branch (`codex/batch3-router-recall-cleanup`). Zero behavior change for default-configured installs. 13 new URS requirements (REQ-CONV-FLUSH-013..018, REQ-CONV-NEWCHAT-009..012, REQ-CONV-TEMPORAL-013..015). Post-merge Codex corrections (`fix(batch3)` commit): P2-1 — stale-callback `logConfirmation(expired-or-stale)` in compose-runtime; P2-2 — `outcome='failed'` (not `'confirmed'`) when `handleNewChat` throws; P2-3 — grey-zone confirmation rate scoped to grey-zone entryIds via Set; P3-4 — Message field JSON-decoded in log parser (strips surrounding quotes); P3-5 — `safeForLog` replaces opening `<script>`/`<style>` tags; P3-6 — REQ-CONV-NEWCHAT-009 URS narrowed to successful invocations; P3-7 — persona test docblock reworded; P3-8 — `maxWindowDays` NL prompt interpolation test added. 467 test files / 10,324 tests passing.

**Item 3 — P6.next 365d cap relaxation (REQ-CONV-TEMPORAL-013..015)**
`chat.recall.max_window_days` zod-validated config key (`[1, 3650]`, default 365). Threads through `RecallPipelineDeps` → `ClassifyRecallDeps` → `buildClassifierPrompt(today, maxWindowDays)` → `parseRecallVerdict`. All existing 365-day tests still pass; new tests cover rejection boundary, prompt interpolation, and the loader default.
- **New files:** `core/src/services/config/__tests__/pas-yaml-schema.test.ts` (7 new rejection cases + 2 default tests)
- **Modified:** `core/src/services/config/pas-yaml-schema.ts`, `core/src/types/config.ts`, `core/src/services/config/index.ts`, `core/src/services/conversation-retrieval/recall-classifier.ts`, `core/src/services/conversation/recall-pipeline.ts`, `core/src/services/conversation/handle-message.ts`, `core/src/services/conversation/handle-ask.ts`, `core/src/services/conversation/conversation-service.ts`

**Item 2 — P7 SessionControlClassifier telemetry (REQ-CONV-NEWCHAT-009..012)**
`SessionControlLogger` markdown structured log (mirrors `FoodShadowLogger`). Two-event design: classification entries (zone, entryId, latency, sanitized message ≤200 code points; `</script>`, backticks, bidi controls stripped) + confirmation entries (linked by entryId, elapsedMs from `createdAtMs`). Pre-generated `entryId` for grey-zone ensures the log entry and `PendingSessionControlStore` entry share the same nonce. Fail-open (errors → `logger.warn`). `pnpm analyze-session-control-log` CLI with round-trip parser test. `handleSessionControlCallback` extracted from inline `compose-runtime.ts` sc:yes/sc:no block for unit testability; `createdAtMs: number` added to `PendingSessionControlEntry`.
- **New files:** `session-control-logger.ts`, `handle-session-control-callback.ts`, `scripts/analyze-session-control-log.ts`, plus corresponding test files
- **Modified:** `compose-runtime.ts` (instantiate logger, extract callback), `router/index.ts` (telemetry in `handleSessionControlHook`), `pending-session-control-store.ts` (`createdAtMs`)

**Item 1 — P8b `/flushmemory` Router built-in (REQ-CONV-FLUSH-013..018)**
`/flushmemory` and `/flush-memory` Router built-ins following the `/refreshmemory` pattern. `handleFlushMemory`: reads active session turns → races summarizer against 8-second `Promise.race` + `AbortController` → late-resolve guard (`if (timedOut || controller.signal.aborted) return { status: 'failed' }`) prevents writing after timeout. `flushMemoryToContextStore` return type widened from `'written' | 'failed'` to `{ status: 'written'; persistedLength: number } | { status: 'failed' }` for accurate `Memory flushed: N chars saved.` reply. Manifest shadowing prevented via `BUILTIN_COMMAND_NAMES`. 22 Router tests + 17 handler unit tests + 14 persona tests.
- **New files:** `handle-flush-memory.ts`, `router/__tests__/router-flush-memory.test.ts`, `__tests__/flush-memory.persona.test.ts`
- **Modified:** `memory-flush.ts` (widen return type), `idle-reset-hook.ts` (update call site), `conversation-service.ts` (shim + ConversationServiceDeps), `conversation/index.ts` (barrel), `router/index.ts` (dispatch + BUILTIN_COMMAND_NAMES + help text), `compose-runtime.ts` (pass summarizer + flushSave)

### Batch 4 — Food micro-fixes (`apps/food/`) ✓ Complete (2026-05-07)

Two items from `docs/open-items.md` closed in a single branch (`codex/batch4-food-micro-fixes`). 2 new URS requirements (REQ-FOOD-PRICE-002, REQ-FOOD-HEALTH-NEG-001). Post-Codex corrections also applied (see below). Zero behavior change for Item 2 outside of added runtime stripping.

**Item 1 — `formatCheapestPriceAnswer` wording (REQ-FOOD-PRICE-002)**
Changed `"… is cheapest for …"` to `"Lowest saved package price for {item}: {name} at {price} at {store}[ (updated {date})]."` at `apps/food/src/services/receipt-query.ts:377`. Honest stopgap acknowledging that the comparison is package-level, not unit-level. Unit-price normalization (path b) remains as a separate open item.
- **Modified:** `apps/food/src/services/receipt-query.ts` (one line), `apps/food/src/__tests__/receipt-prompt-loop.test.ts` (strengthened P1 + added P2/P3/P4; `assertCheapestBlueberryReply` helper extracted from P2–P4 in simplify pass)
- **Extended:** `apps/food/src/services/__tests__/receipt-query.test.ts` (11 unit tests U1–U11: exact wording, sort correctness, single-store, no-updatedAt suffix, old-wording regression guard, single-line guard, empty-state, no-match, markdown escape ×3)

**Item 2 — Energy/mood field removal closure (REQ-FOOD-HEALTH-NEG-001)**
`energyLevel` and `mood` were already removed from `HealthDailyMetricsPayload.metrics` before this batch. Compile-time regression guard in build-included source file + runtime stripping in subscriber added (see Codex corrections below).
- **New files:** `apps/food/src/events/health-metric-guards.ts` (type assertion included in `pnpm build`), `apps/food/src/__tests__/health-payload-shape.test.ts` (2 tests)
- **Extended:** `apps/food/src/__tests__/events-subscribers.test.ts` (1 new test for runtime stripping)

**Carry-forward build fix — `PasYamlConfig.recall` type (Batch 3)**
`core/src/services/config/index.ts` was missing the `recall?: { max_window_days?: number }` field in the `PasYamlConfig` YAML-shape interface. This caused `pnpm build` to fail on `chat?.recall?.max_window_days` (TS2339). Added in this branch as a Batch 3 carry-forward; the config access was correct, only the raw-YAML shape type was incomplete.

**Post-Codex corrections**
- **C1 (P1):** Moved type assertion from `health-payload-shape.test.ts` (excluded by tsconfig) to `health-metric-guards.ts` (build-included source file). `pnpm build` now actually enforces REQ-FOOD-HEALTH-NEG-001 at compile time.
- **C2 (P1):** Switched assertion conditional from `ForbiddenKeys extends keyof metrics ? never : true` to `Extract<keyof metrics, ForbiddenKeys> extends never ? true : never`. The `Extract<...>` form catches single-key reintroductions; the previous form only caught when the full union was present simultaneously.
- **C3 (P2):** Added runtime metric key stripping in `apps/food/src/events/subscribers.ts` before `upsertDailyHealth` — `Object.fromEntries(...filter(...))` removes `energyLevel` and `mood` regardless of caller type discipline.
- **C4 (process):** Documented `PasYamlConfig.recall` fix as Batch 3 carry-forward in this phase note.

### Batch 5 — P4 freeze integration coverage + `interactionContext` cleanup ✓ Complete (2026-05-07)

Two items from `docs/open-items.md` closed in a single branch (`codex/batch5-test-coverage`). Item 1 adds integration coverage; Item 2 removes production dead code. 1 new test file (`memory-snapshot-freeze.integration.test.ts`), 9 integration scenarios (F1–F9), 2 regression-guard tests. URS REQ-CONV-MEMORY-{001, 002, 005, 006, 007, 009, 010, 011} and REQ-CONV-RETRIEVAL-014 extended with integration test references.

**Item 1 — P4 freeze integration test**
`core/src/services/conversation/__tests__/memory-snapshot-freeze.integration.test.ts` — 9 scenarios covering all 7 testing-standards categories:
- **F1** (happy path + state transition, REQ-CONV-MEMORY-001/007/010/011): `composeRuntime` + `RecordingStubProvider`; seed `temperature-pref = Celsius`; turn 1 block contains Celsius; mutate to Fahrenheit; turn 2 still frozen (Fahrenheit absent from whole prompt); `/newchat`; turn 3 block contains Fahrenheit. Exact oracle via `extractDurableMemoryBlock` helper scoped to Layer 2 payload.
- **F2** (edge — empty store, REQ-CONV-MEMORY-005): no durable entries → `extractDurableMemoryBlock` returns `null`.
- **F3** (state transition — remove mid-session, REQ-CONV-MEMORY-001/010): seed → turn 1 → `contextStore.remove` → turn 2 in same session → block still contains original entry (frozen).
- **F4** (state transition — `/reset` parity, REQ-CONV-MEMORY-001): seed → mutate → `/reset` → turn 2 block contains mutated value.
- **F5** (persistence round-trip, REQ-CONV-MEMORY-002): after turn 1, read active transcript YAML frontmatter via `active-sessions.yaml` index (deterministic lookup by chatId); assert `status=ok`, `entry_count ≥ 1`, `built_at` ISO parseable; assert block payload contains the seeded key+value; cross-check `memory_snapshot.content` appears in block (round-trip invariant).
- **F6** (error handling — fail-open, REQ-CONV-MEMORY-005/006): monkeypatch `listDurableForUser` to throw; `routeMessage`; `extractDurableMemoryBlock` returns `null`; frontmatter `memory_snapshot.status=degraded`; telegram reply still sent.
- **F7** (security — fence/bidi, REQ-CONV-MEMORY-009): seed entry containing `</memory-context>` + bidi RLO `‮`; block payload contains `&lt;/memory-context>` (escaped); `‮` absent; exactly one outer block.
- **F8** (concurrency, REQ-CONV-MEMORY-001): `Promise.all([routeMessage(turn1), routeMessage(turn2)])`; both prompts have a durable-memory block; both payloads byte-identical.
- **F9** (user isolation, REQ-CONV-MEMORY-001): two users; seed `A-MARKER` for user A, `B-MARKER` for user B; A's block contains only A-MARKER; B's block contains only B-MARKER.

**Item 2 — `interactionContext` snapshot fetch removal**
- **Modified:** `core/src/services/conversation-retrieval/conversation-retrieval-service.ts` — removed `interactionContext?` field from `ConversationContextSnapshot` type, removed `interaction-context` fan-out task (lines 481–489), removed `case 'interaction-context':` assignment (lines 646–654). `ConversationRetrievalServiceDeps.interactionContext` and `getRecentInteractions()` retained for REQ-CONV-RETRIEVAL-007.
- **Modified:** `core/src/services/conversation-retrieval/source-selection.ts` — removed `selected.add('interaction-context')` at line 27; comment updated to "two cheap scoped readers".
- **Modified:** `core/src/services/conversation-retrieval/__tests__/conversation-retrieval-service.test.ts` — removed `interactionContext: { getRecent: vi.fn() }` wiring from `buildContextSnapshot` test cases; removed `expect(snapshot.interactionContext).toBeDefined()`; added 2 regression-guard tests; updated stale "3 cheap readers" test title to "2 cheap readers".
- **Modified:** `core/src/services/conversation-retrieval/__tests__/conversation-retrieval-service.integration.test.ts` — removed `interactionContext wired: snapshot.interactionContext includes recent entries` test.
- **Modified:** `core/src/services/conversation-retrieval/__tests__/source-selection.test.ts` — updated always-included set assertion to expect `context-store` + `app-metadata` only.

470 test files / 10,368 tests passing (full suite).

### Standalone single-file changes
- P1 Chunk A simplify pass — scope via `git diff` to Chunk A files only
- D5c-review `revokeLastCheckCommit` concurrency note — comment or convert to per-commit handle (low urgency)

**Recommended order:** Batch 2 (`isPasRelevant` only — lowest risk) → Batch 1 (GUI) → Batch 3 (conversation commands). Batches 4 and 5 in any order. The deferred MODEL_SWITCH_INTENT_REGEX route-first conversion is its own future phase.

## Receipt Parser Robustness PR1 + PR2 + Persona Regression Chunk A.2 (2026-05-15)

Three closely-related phases landed on 2026-05-15 in sequence: PR1 (parser hardening), Chunk A.2 (5 receipt fixtures + multisetRows operative), then PR2 (transcription oracle layered on top). PR1 and PR2 each have their own detail block in CLAUDE.md (Current and Previous Priority); the Chunk A.2 architecture detail is captured here.

### Persona Regression Suite Chunk A.2 — 5 receipt fixtures + multisetRows oracle (complete, 2026-05-15)

**5 receipt regression fixtures** (4 hand-verified real photographs: `costco-long`, `trader-joes-{correction,long,short}`; 1 synthetic `expired-90d` rendered via Python+Pillow), wired into `runSuite` dispatch.

**New `multisetRows` operative on the structural oracle** — row-level multi-field correlation preserving duplicate counts. Compares `(string, number)` tuple arrays via two-pointer merge-with-tolerance over sorted lists. Two "PE GRANOLA $10.99" lines can't collapse to one; a parser can't pass with wrong `(quantity, unitPrice)` by emitting the right `totalPrice`. Replaces `setEquality`/`keyedScalars` for receipt line items, which collapsed same-name duplicates via Set/Map semantics. Single-tuple multiset case is just a one-`valueField` `multisetRows` entry — the prior `multisets` operative was strictly subsumed and is removed.

**Receipt-bucket cache key salted with today+timezone** via shared `bucketCacheSalt` helper (`computeCacheKey.extraSalt`). Used by both `runSuite()` and `emitCaseList()` so the GUI's `currentCacheKey` agrees with the real dispatch cache file. Same-day reruns hit cache; date rollover invalidates so the `isValidReceiptDate` rejection branch re-exercises.

**Receipt-bucket dispatch arm in `runSuite`** (was a no-op skip in B.1). `RunSuiteOptions` gained `receiptLlm` + `timezone`; `buildProductionDeps` returns both; `buildDryRunDeps` uses a throwing stub.

**`ReceiptSidecar` schema additions:** optional `rejectedDate` (rejection-mode asserts `rawExtractedDate` preservation per REQ-FOOD-RECEIPT-INTEGRITY) + per-line `quantity`/`unitPrice` (`multisetRows` `valueFields` added when present).

**Other:** `AppLogger` widened to accept pino's standard `(obj, msg, ...)` overload — unblocks root `pnpm build`, which was failing on an unrelated `photo.ts` caller using the canonical pino pattern. Receipt cases consolidated to `buildCases()` index (5 files → 1, matches the food-personas pattern). `todayInTimezone` extracted to `shared/cache-key.ts` (3 duplicate copies removed across the regression workspace).

**New tests:** 12 `multisetRows` operative cases in `structural-oracle.test.ts`; 7 receipt-runner cases (rejectedDate, multiset duplicates, qty/unit-price); 4 cache-key `extraSalt` cases; 24 fixture-shape contract tests in new `receipt-cases.shape.test.ts`; 6 orchestrator dispatch cases (happy path, missing-dep throw, dry-run no-op, cache hit, date-salt invalidation via `vi.setSystemTime`, routing-keeps-no-salt sanity guard) in new `orchestrator-receipt-dispatch.test.ts`. Regression workspace: 470 tests passing (33 files). Codex review (in-plan, 10 items) applied before implementation. URS traceability updated for REQ-REG-004/006/008/010.

**Deferred:** future-dated receipt fixture (operator declined — real-world risk negligible); operator may re-photograph the cropped trader-joes long/short to expose the printed date for sidecar date assertion.

### Receipt Parser Robustness PR2 — Transcription Oracle (complete, branch `food/receipt-transcription-oracle`, 2026-05-15)
**Goal:** Regression-suite-side second line of defense for receipt parsing. The existing `structural` oracle ALREADY catches the primary self-consistent-inflation bug shape today (proven via `regression/src/__tests__/structural-catches-inflation.characterization.test.ts`); PR2 adds an independent **transcription oracle** for drift resistance + confidence tiers.

**Approach:** Six TDD batches in `food/receipt-transcription-oracle` worktree, one commit each.

**Batch 0/0a — Worktree + yaml dependency + characterization test** confirming the structural oracle already catches drop-and-inflate today.

**Batch 1 — Transcription schema + loader:** `ReceiptTranscription` type, `TranscriptionLineItem` (with optional `quantity`/`unitPrice`, `confidence: 'high'|'low'` defaulting to 'high'), `loadTranscription(path)` with schema validation, 64 KiB cap, optional `.sha256` sidecar verification.

**Batch 2 — Transcription oracle:** `regression/src/oracles/transcription.ts runTranscriptionOracle` with find-first-satisfying-row multiset matching (mirrors structural multisetRows); case-insensitive + whitespace-collapsed name comparison (transcription only — structural is strict byte-equal); $0.01 absolute money tolerance on subtotal/tax/total (no percentage chain, no validateReceiptIntegrity fallback); `confidence: high` items mandatory; `confidence: low` items optional; hallucinations always fail.

**Batch 3 — Wire oracle into receipt-runner:** `RunResult.oracleVerdicts[]` carries labeled entries (`'structural'` and `'transcription'`); case verdict is set-based AND of both; rejection-mode cases (`expectRejection: true`) skip transcription; missing/SHA-mismatched transcription file fails closed with `verdict: 'error'`.

**Batch 4 — Author 4 transcription YAML fixtures:** `costco-long`, `trader-joes-correction`, `trader-joes-long`, `trader-joes-short` derived from existing `.true.md` narratives; SHA256 sidecars; `buildCases` propagates `transcriptionFixture` through `LoadedCase`.

**Batch 5 — 15 adversarial-persona integration scenarios:** drift resistance (drop-and-inflate), full self-consistent fudge, hallucinations, name variations (lowercase + whitespace expanded → structural strict-byte fails even though transcription would pass; documented divergence), duplicate preservation/dedupe, discount-line dropping, aggregate fudging (subtotal/tax off).

**Batch 6 — URS + docs:** 11 new REQ-FOOD-RECEIPT-TRANSCRIPTION entries (001..011) with full traceability matrix rows; parser-blindness accepted-risk entry in `docs/open-items.md` marked closed (Codex review #1 finding: structural alone is sufficient for the bug shape; PR2's distinct value is drift resistance + confidence tiers).

**The parser positive regression test at `apps/food/src/services/__tests__/receipt-parser.test.ts:275` is preserved** — the parser still accepts self-consistent inflation as clean; the regression suite is what catches it.

**Codex review rounds 1, 2, 3** applied in-plan. Regression workspace: 605 tests / 38 files. Closes the parser-blindness accepted-risk entry.

### Receipt Parser Robustness PR1 (complete, branch `worktree-food+receipt-robustness`, 2026-05-15)
**Goal:** Operator reported a real-world Costco-receipt failure: parser dropped the last line item AND inflated an earlier item's price so the printed total still tied out. PR1 layers defense — anti-reconciliation prompt, generous maxTokens, `finishReason` plumbed through all four providers, deterministic post-parse integrity check, single-shot continuation, user-readable Telegram warning. PR2 (transcription oracle in the regression suite) is implemented (branch `food/receipt-transcription-oracle`) and provides regression-suite drift resistance — preventing silent `.expected.json` regeneration when the LLM fudges `unitPrice`/`totalPrice`/`subtotal` self-consistently — plus per-line confidence tiers. PR2's value over the existing structural oracle is operator-authored ground truth (`.transcription.yaml`) anchored to physical receipts, so a buggy parser output cannot be silently baselined.

**Approach:** Six TDD batches in `food/receipt-robustness` worktree, one commit each. Plan: `~/.claude/plans/yea-lets-start-a-foamy-pnueli.md`.

**Batch 1 — `finishReason` plumbing:** new `LLMFinishReason` type + required field on `LLMCompletionResult`; per-provider mapping (Anthropic stop_reason, OpenAI choices[0].finish_reason, Google candidates[0].finishReason, Ollama done_reason with `eval_count >= maxTokens` fallback for older SDKs); unknown → 'other'; new `LLMService.completeWithMeta` (text + finishReason + usage); `complete()` unchanged for backward compat; `LLMGuard` + `SystemLLMGuard` implement the new method; stub-llm-provider + mock-services + every existing test fixture updated.

**Batch 2 — Prompt + maxTokens + line-item normalization:** anti-reconciliation block appended to `buildReceiptPrompt` (don't adjust prices, omit unreadable items, emit total as printed, negative totals are real); parser switched to `completeWithMeta` with `maxTokens: 8192`; `isValidReceiptLineItem` accepts negative `totalPrice` (discount/coupon/return lines); `normalizeReceiptLineItem` defaults missing quantity to 1 and unitPrice to null.

**Batch 3 — Post-parse integrity check:** `ReceiptVerificationWarning` enum (`sum_mismatch`, `line_arithmetic_mismatch`, `output_truncated`, `continuation_unresolved`); `validateReceiptIntegrity` with reference chain `subtotal → total-tax → total` (strict 1% tolerance for first two, loose 2% for `total` fallback); per-line `|q·u − total| > $0.50` check skipped when `unitPrice` is null; boundary tests at exactly $1, $1.01, $2-on-$1000; explicit documented-limitation test confirming the parser CANNOT detect self-consistent inflation (PR2's domain).

**Batch 4 — Persist warnings + Telegram warning:** receipt YAML body (NOT the Obsidian frontmatter block, which is search/index shape) gains `verification_warnings:` array only when non-empty; Telegram confirmation appends `⚠️ I could not fully verify every line item on this receipt. Please double-check it.` (user-readable; raw codes never shown to user, logged at warn level instead with userId + receiptId).

**Batch 5 — Continuation pass:** on first `finishReason === 'length'`, fires exactly one continuation call with the photo and the items already parsed; multiset merge by `(lowercased-name, totalPrice-cents)` preserves duplicates at different prices and dedupes accidental re-listings; successful continuation that resolves sum mismatch strips both `output_truncated` and `continuation_unresolved`; failed/unresolved continuation emits both; single-retry cap means at most two LLM calls per receipt.

**Batch 6 — URS + docs:** 13 new REQ-FOOD-RECEIPT-INTEGRITY entries (001..013) with full traceability matrix rows; three accepted-risks entries in `docs/open-items.md` (single-shot continuation cap, self-consistent inflation parser blindness, Ollama heuristic false positives transparently resolved by continuation).

**Tests:** 11,536 root tests pass (+36 from this phase across `core/src/services/llm/__tests__/providers/`, `core/src/services/llm/__tests__/llm-service.test.ts`, `apps/food/src/utils/__tests__/photo-validators.test.ts`, `apps/food/src/services/__tests__/receipt-parser.test.ts`, `apps/food/src/__tests__/photo-handler.test.ts`).

---

## Archived from CLAUDE.md

The following Previous Priority blocks moved here from CLAUDE.md during slimming passes (initial pass 2026-05-15; subsequent entries appended as later phases are demoted). Content is reproduced verbatim from CLAUDE.md at archive time; check git history on the originating files for the canonical record.

### Regression GUI Rework v2 — Model-Performance-First Surface (complete, branch `regression/gui-rework-v2`, 2026-05-13)
**Goal:** Replace the single long `/gui/regression` page with a model-performance-first surface: four sub-tabs (Overview / Trends / Compare / Run), a per-tier model leaderboard with auto-generated LLM weakness summaries, server-rendered SVG charts for performance-over-time + cost-vs-accuracy, and `<select>` model pickers sourced from the live `ModelCatalog`. The original case table moves to a Compare tab — still findable, no longer the focus.

**Approach:** 5 chunks (Pre-A → D), 20 new URS requirements (REQ-REG-GUI-V2-001..020). Continuous batch execution per the established cadence — single end-of-phase Codex review.

**Persistence model:** New `RunManifest` JSON written atomically by the regression subprocess at terminal summary when `--run-id=<uuid>` is set (gated; the GUI POST handler always passes its registry UUID, pure CLI invocations skip the manifest). Manifests live at `data/system/regression-runs/<runId>.json` with strict-validated shape: `{runId, startedAt, completedAt, modelIds, judgeOverrideApplied, bucketsRequested, caseResults: {caseId, bucket, cacheKey, evaluatedTier, verdict, source, costUsd, timestamp}[], summary}`. Per-case `evaluatedTier: 'fast'|'standard'|'reasoning'|'mixed'|'unknown'` added to `RunResult` (optional, legacy-tolerant); each case-runner sets it (routing/recall → 'fast', chatbot/receipt → 'standard'). Weakness summaries persisted as structured JSON at `data/system/regression-summaries/<runId>/<tier>.json` with `{status, summary, failureCategories: [{label, count, exampleCaseIds}], llmRawOutput}`.

**Code surfaces:**
- `core/src/utils/atomic-write.ts` (NEW shared helper; cache + manifests both use it)
- `core/src/types/regression.ts` — added `EvaluatedTier`, `RunManifest`, `ManifestCaseResult`, `getEvaluatedTier`
- `core/src/gui/services/regression/run-history-store.ts` (NEW; strict validator, `list`/`getById`/`latestPerTierAndModel`)
- `core/src/gui/services/regression/leaderboard-aggregator.ts` (NEW; per-(tier, model) rows with pinning support)
- `core/src/gui/services/regression/weakness-summarizer.ts` (NEW; standard-tier LLM call with empty-retry, idempotent cache, structured JSON output)
- `core/src/gui/services/regression/chart-svg.ts` + `model-palette.ts` (NEW; pure SVG line + scatter rendering; deterministic 8-slot palette via djb2 hash)
- `core/src/gui/services/regression/trend-aggregator.ts` (NEW; series + scatter data composition)
- `core/src/gui/routes/regression.ts` — refactored `GET /` to dispatch on `?view=`, added legacy `?bucket=` 302 redirect, added `GET /runs/:runId/summary` (200/202/400/404), `POST /runs/:runId/summary` with `?force=true`, server-side composition of `tier_*`/`judge` form fields, live-catalog re-validation at submit time
- `core/src/gui/views/regression.eta` — refactored to shell + 4 tab partials (`partials/regression-tab-{overview,trends,compare,run}.eta`) + `partials/regression-weakness-summary.eta`
- `core/src/gui/views/partials/regression-live.eta` — added polling loop for weakness summaries after SSE `complete`
- `regression/src/runner/args.ts` + `index.ts` + `manifest-writer.ts` — `--run-id=<uuid>` flag, atomic manifest write at terminal summary
- `regression/src/runner/case-runners/*.ts` — each case-runner sets `evaluatedTier` per case

**Codex review applied (round 1):** 18 items reviewed against code evidence. Key applied corrections — (1) subprocess receives registry UUID via `--run-id=<uuid>` so manifest filename matches SSE runId; (2) weakness summary moved from SSE event to polled `GET /summary` (SSE channel closes on terminal events); (3) `caseResults[]` carries per-case rows (cache hits AND fresh, source-distinguished) instead of just `caseIds`; (4) `evaluatedTier` per case for tier attribution (User Addition C); (5) no `judgeModelId` field (regression-guard typecheck preserved — `judgeOverrideApplied: boolean` flag instead, judge override lands in `modelIds.standard`); (6) route options extended with `modelCatalog` + `modelSelector` + `runHistoryStore` + `weaknessSummarizer`; (7) server-side composition of `tier_*` + `judge` form fields (tier_* takes precedence over legacy `modelMatrix`); (8) cluster-fallback dropped (was contradictory) — pre-rework cache entries don't appear in leaderboard (documented breaking change); (9) `POST /summary` idempotent by default, `?force=true` regenerates; (10) structured JSON summary persistence; (11) tokens render as `—`, cost always authoritative; (12) caseId added to Compare filter chips; (13) auth/CSRF tests enumerate every new route; (14) shared `atomic-write` helper extracted; (15) legacy `?bucket=` 302 redirects to `?view=compare&bucket=`. **User additions applied:** (A) dropdowns sourced from live `ModelCatalog`; current-tier model rendered disabled when missing from catalog; POST re-validates at submit time; (B) every leaderboard row shows `completedAt`; (C) Overview is three tier-grouped tables (Fast / Standard / Reasoning); same model can appear in multiple tier tables with distinct metrics.

**Codex review applied (round 2 — same day):** 9 items, all evidence-verified. (P0) **TDZ bug fix** — `runFactory(onEvent, signal, runId)` now receives the canonical registry UUID as a third argument; the previous closure-capture of an outer `runId` was in temporal dead zone because the factory is invoked inside `createRun()` before its return value lands. (P1) **Auto-summarize wired up** — `runRegistry.onTerminal(hook)` exposes a terminal-event subscription; `registerRegressionRoutes` registers a handler that, on `complete`/`gate-failed` only, loads the manifest, walks every tier with at least one `evaluatedTier` result, and invokes `weaknessSummarizer.summarize` sequentially (fire-and-forget). `failed` and `cancelled` are skipped (no usable manifest). Client `regression-live.eta` now polls on both `complete` AND `gate-failed`. (P1) **POST validation fails closed** — `validateModelsAgainstLiveCatalog` previously fell back to "fail open" on catalog-fetch error; now returns "catalog unavailable" with 400 so an unavailable model cannot be submitted when freshness cannot be proven. (P2) **Cross-run history view** — `?view=compare&caseId=<x>` now renders every cached `RunResult` for the case across every model snapshot (sorted desc by timestamp), matching the drilldown link's promise; model/verdict filter chips apply post-expansion. (P2) **`tierModelKeys()` filtered by evaluated tier** — `latestPerTierAndModel()` no longer keys fast/standard/reasoning from `modelIds` directly; a routing-only run now yields just `fast:<model>` rather than a phantom `standard:<unused>` entry. (P2) **Gate badge scope** — `gateStatus` is set only when a row has at least one routing-bucket case, computed on the routing-only pass rate; non-routing rows display "—". (P2) **CSRF field rename** — `name="csrf"` → `name="_csrf"` in `regression-tab-run.eta` for parity with the rest of the GUI. (P3) **Summary docstring** — clarified that `weakness-summarizer.ts` uses a local fence/strip sanitizer (no conversation-stack imports), functionally equivalent to `sanitizeContextContent` but kept local for unit-test isolation. (P3) **Strict `RunSummary` validation** — `isValidRunSummary` now checks every counter is a non-negative integer, costs are finite non-negative numbers, and `routingAccuracy` is `null` OR in `[0, 1]`. **Round-2 tests:** new file `regression-codex-followup.test.ts` with 11 tests covering each of P0/P1/P2/P3 against real fixtures (auto-summarize after fake terminal event, fail-closed catalog, cross-run history rendering, summary validation rejecting malformed counters).

**Tests:** root core suite 7237 passing + 1 todo; regression workspace 384 passing. ~145 new tests in this phase across both rounds.

### Regression GUI model-override surface (complete, branch `regression/gui-model-override`, 2026-05-13)
**Goal:** Adds `modelMatrix` and `judgeModel` text inputs to the `/gui/regression` admin form so operators can compare routing models from the web UI rather than CLI-only invocations. Closes the carry-forward from the stronger-routing-model sweep that landed earlier the same day.

**Approach:** TDD across 9 batches. New shared parser module at `core/src/services/regression/model-spec.ts` exports `parseModelRef`, `parseModelMatrixValue`, `parseJudgeModelValue`, `normalizeOptionalModelSpec`, and `MAX_MODEL_SPEC_CHARS` — used by both the regression CLI (`regression/src/runner/args.ts`) and the GUI POST handler (`core/src/gui/routes/regression.ts`) as the single source of truth (REQ-REG-GUI-OV-003). The parser tightens semantics over the original CLI parser: provider/model character classes via regex, rejection of shell metachars (`;$\`<>&|()'"\\`), traversal sequences (`..`), control characters, HTML payloads, and oversized inputs (256-char cap).

**Code surfaces:** `core/src/services/regression/model-spec.ts` (NEW shared parser); `regression/src/runner/args.ts` (imports from shared); `core/src/gui/services/regression/subprocess.ts` (`validateSpawnArgs` re-validates via shared parser — defense in depth); `core/src/gui/routes/regression.ts` (POST handler normalizes body fields via `normalizeOptionalModelSpec`, parses via shared parser, appends `--model-matrix=` / `--judge-model=` to spawn args after `--bucket=` / `--rerun=`); `core/src/gui/views/partials/regression-summary-bar.eta` (two `<label>`-wrapped `<input>` elements with `aria-label`, placeholder, `autocomplete="off"`; client `fdToBody()` captures arbitrary text fields so no JS change needed — server normalizes empty strings).

**10 new URS REQs** (REQ-REG-GUI-OV-001..010): operator surface (001), tightened parser (002), single-source-of-truth contract (003), spawn allowlist re-validation (004), empty/non-string handling (005), backwards-compat (006), distinct model IDs → distinct cache rows (007, narrowed — see Out of Scope), accessible UI labels (008), auth/CSRF posture unchanged (009), XSS framing for JSON response (010).

**Test inventory (6 touched test files):**
- `core/src/services/regression/__tests__/model-spec.test.ts` (NEW, 56 tests) — `parseModelRef` (27), `parseModelMatrixValue` (12), `parseJudgeModelValue` (4), `normalizeOptionalModelSpec` (13). Covers happy path, edge, security categories per `pas-testing-standards`.
- `core/src/gui/services/regression/__tests__/subprocess.test.ts` (+17 tests) — allowlist accepts/rejects new flags with full security coverage.
- `core/src/gui/__tests__/regression-routes-write.test.ts` (+27 tests) — POST handler validation, type-safe body normalization, contract tests asserting parser/POST parity, operator persona scenario (multi-step run-two-models-back-to-back).
- `core/src/gui/__tests__/regression-routes.test.ts` (+7 tests) — UI rendering with accessibility assertions, history view rendering distinct models for one case.
- `core/src/gui/__tests__/regression-integration.test.ts` (+7 tests) — `spawnRegression` end-to-end with fake CLI, plus real-CLI `--list` smoke tests asserting cache-key changes under override flags.
- `regression/src/__tests__/cache.test.ts` (+2 tests) — distinct modelIds → distinct cache files for one case.

**Out of scope (deferred, tracked in open-items.md):**
- **Cache key should include provider, not just model name.** `TierModelSnapshot` stores model strings only; two providers with the same model name would collide. GUI-OV-7 was narrowed to "distinct model IDs" for this phase; the schema migration is deferred.
- Model picker dropdown sourced from `ModelCatalog` — free-text input matches CLI ergonomics.
- Per-bucket model override — CLI applies overrides globally per run; GUI mirrors that.
- Model-aware estimator — existing flat per-bucket constants kept.
- CSS polish — minimal classes added; visual refinement in a UX-focused follow-on.

**Tests:** 11,241 root + 348 regression workspace tests pass. **Codex review applied** (15 items reviewed, ~12 ruled in/partially): tightened parser with regex allowlists (item 1), security fixtures use legitimate provider/model shape with embedded metachars (item 2), split Batch 4 into POST-args-construction + separate real-CLI integration (item 3), regression-side cache-store tests for distinct modelIds (item 4), full matrix coverage + judgeModel precedence tests (item 5), correct auth expectations 403 vs 302 (item 6), `normalizeOptionalModelSpec` for non-string body values (item 7), MAX_MODEL_SPEC_CHARS in shared module (item 8), reject comma-only / duplicate tiers / mixed positional+named (item 9), narrowed GUI-OV-7 to model-ID-only (item 10, partial), dropped client-side `fdToBody` capture tests (item 11, partial), reframed XSS test for JSON response (item 12), accessible `<label>` + aria-label (item 13), added URS/traceability section (item 15).

### Stronger-Routing-Model Sweep (complete, branch `regression/stronger-routing-models`, 2026-05-13)
**Goal:** After Chunk C left REQ-REG-011 routing accuracy at 0.8962 under `gemma4:e4b`, step up the routing model rather than prompt-harden a weak local model. Decision tree: Gemma 4 26B → Gemma 4 31B → Claude Haiku 4.5; halt at first ≥0.95.

**Outcome:** **Gemma 4 31B clears the 0.95 gate at 0.9811 per-input routing accuracy (33/36 cases pass).** Gemma 4 26B plateaued at 0.9057 (semantic mispicks); attempts to prompt-harden made things worse (v3 PRECISION block regressed to 0.7642). Haiku 4.5 surprised at 0.9151 — Haiku over-generalizes cultural-recipe inputs (Thanksgiving/Christmas/Eid/Lunar New Year) to generic recipe search. Sonnet 4.6 sweep declined by operator.

**Code changes on this branch (apply to every model — help Claude, not just Gemma):**
- `apps/food/src/routing/shadow-classifier.ts buildShadowClassifierPrompt` — added CRITICAL RULE + FORBIDDEN modifications block forbidding paraphrasing/prefix-additions/pluralization/punctuation-changes. Closes 26B's `user wants to ask about ...` paraphrase mode (+10pt under 26B).
- `core/src/services/conversation/session-control-classifier.ts classifySessionControl` — added `responseFormat: 'json'` (real bug — was missing from Batch 1 JSON-mode plumbing; recovered 14/15 prior session-control fails under Gemma).
- `core/src/services/conversation/pas-classifier.ts` prefilter restructure:
  - `DATA_QUERY_PREFILTER` widened with `(?:what's|what is) (in )?my pantry`, `what did I (eat|have)`, `how many (recipes|meals|notes|alerts|reports) (do I have|have I) (saved|stored|created)`.
  - `SYSTEM_DATA_KEYWORDS_RE` trimmed to true PAS-internal data lookups (`system logs|scheduled alerts|model journal`).
  - **NEW** `PAS_META_RE` returns `{pasRelated:true}` only (no `dataQueryCandidate`) for app meta-questions (`installed apps`, `what apps i have`, `how to install/uninstall/add/remove app`). DataQueryService can't return the apps list, so flagging these as data queries dispatched a no-op search.
  - `SETTINGS_KEYWORDS_RE` widened for `(toggle|enable|disable|configure) auto-detect [pas]` and `how (do i|to) configure auto-detect`.
- `core/src/services/conversation/__tests__/pas-classifier.test.ts` — split SYSTEM_DATA describe block; new PAS_META_RE describe block with 4 test cases. 40 → 43 PAS unit tests; 123 shadow-classifier tests + 30 session-control tests all pass.

**Findings docs (one per model):**
- `docs/superpowers/plans/findings/2026-05-13-chunk-c-routing-gemma-26b.md` — 0.9057 best (v4 = paraphrase fix + session-control JSON), blocked on semantic adjacency.
- `docs/superpowers/plans/findings/2026-05-13-chunk-c-routing-gemma-31b.md` — **0.9811 ✅**, only 3 residual fails: "just had some leftover chicken" → log-leftovers; "show me my macros" → macro-targets; "what does Hermes do" → not-PAS. All three are fixture/semantic edge cases.
- `docs/superpowers/plans/findings/2026-05-13-chunk-c-routing-haiku-4-5.md` — 0.9151, 4/4 holiday-or-cultural-recipe inputs route to "search for a recipe", plus 2 unparseable outputs.

**Open follow-on (tracked separately in open-items.md):** "Regression GUI `--model-matrix` / `--judge-model` override surface" — the sweep ran CLI-only because the GUI's spawn allowlist doesn't accept tier-override flags. Adding GUI controls would let operators compare models via the standard drilldown UI.

**Cost:** Gemma sweeps free (local); Gemma 26B chatbot runs $0.078 (Sonnet 4.6 judge); Haiku sweep $0.236; total ~$0.31.

### Chunk C Codex Correction Phase (complete, merged 2026-05-12)
**Codex review of the Chunk C verification surfaced three real defects:** (1) `--judge-model` / `--model-matrix` overrides were silently dropped by `ModelSelector.load()` overwriting the constructor's tier defaults with persisted YAML; (2) Ollama provider lacked `format: 'json'` plumbing through `LLMCompletionOptions`, causing all 27 food-shadow Gemma cases and 3 of 5 recall failures to return empty raw output; (3) the findings doc had factual errors (judge model attributed to Gemma 26b when cache showed claude-sonnet-4-6, missing 5th chatbot failure entry). Correction phase batches: **Batch 0** — `ModelSelector.applyTransientOverride` called AFTER `load()` and before `reconcile()`; `reconcile()` throws on missing provider for frozen tiers; new `--no-cache` CLI flag. **Batch 1** — `responseFormat?: 'json'` on `LLMCompletionOptions` plumbed through Ollama (`format: 'json'`), Google (`responseMimeType`), OpenAI-compatible (`response_format`), Anthropic (no-op). **Batch 2** — food-shadow + recall classifiers set `responseFormat: 'json'` and retry once on empty output (hard cap 2 calls; empty-only retry guard from simplify pass; same-prompt + repair suffix preserves label list / user message). **Batch 3** — evidenced prompt hardening: recall vague-temporal guidance + 2 negative few-shots; PAS deterministic prefilters (settings keywords + system-data keywords) + 9 input→output examples; session-control `META_QUESTION_RE` prefilter for "what does /newchat do?" + 3 few-shots; food `extractPriceItem` cheapest pattern broadened. **Batch 4** — findings doc Corrections #1/#2/#3 callout; `open-items.md` entries marked "being addressed"; CLAUDE.md updated. **Batch 5 (executed 2026-05-12)** — fresh-evidence re-run with `--no-cache` against local Gemma. Routing 0%→89.62% accuracy (food-shadow 0/27 errors → 27/27 non-`parse-failed`; 18 pass, 9 honest Gemma label-mismatches). Recall 20/25→24/25 (one residual `parse-failed` on `recall-true-yesterday` kept open per Codex 2026-05-12). Chatbot override verified (`modelIds.standard: gemma4:26b` on 10/10 fresh cache files). **Codex P0/P1 post-review correction (2026-05-12):** regression typecheck fix (`noCache` on fallback CliOptions in cli-main.ts:53 + index.ts:333); rubric oracle gains `responseFormat: 'json'` + `tryParseJsonStripFences` reuse + 2 regression-guard tests; chatbot bucket re-run 0/10→3/10 pass, 7 errors now Gemma 26b token-repetition loops (model-quality residual, not framework). Plan: `~/.claude/plans/consider-this-feedback-from-tingly-globe.md`. Re-introduction of `expectedHandler` on chatbot fixtures is gated on Router instrumentation surfacing per-dispatch handler ids through `RuntimeServices`. Chunk A.2 (5 hand-curated receipt fixtures) still blocked on operator photo delivery. **Codex P2/P3 post-review correction (2026-05-12):** (P2-Critical) `cli-main.ts` exit path swapped from `process.exit(exitCode)` to `process.stdout.write('', () => process.exit(exitCode))` — POSIX pipe writes are async and `process.exit()` was reported to truncate `--list` NDJSON under load; (P2-Important) `ModelSelector.load()` V1 → V2 migration path now skips clobber for tiers in `transientOverrides` AND defers `save()` while any override is active (was clobbering the override's model with `v1.standard` and persisting the override to V2 YAML — `--judge-model` could survive `load()` but the persisted file would be wrong); +2 regression tests in `model-selector.test.ts`; (P2-Important) findings doc retracts the previous "Costco-21-items resolved" claim — the cache shows a 2-item diff view, not the rubric-required 5+ items; the Gemma 26b judge-error was masking a real food-handler defect (separate `open-items.md` entry added); (P2-Important) `open-items.md` line 17 + rubric-prompt-hardening entry reconciled to current Gemma evidence (routing 32/36 = 89.62%, recall 24/25, chatbot 3/10 pass + 7 error, ~346 regression-workspace tests); (P3-Minor) new direct unit tests for `core/src/utils/json-strip-fences.ts` (22 cases — fenced/unfenced, scalars/arrays/objects, malformed, trailing prose, Gemma token-repetition degenerate input). Plan: this conversation's review summary.

### Regression GUI Polish — SSE Reconnect + Manifest Default + Doc Supersession (complete, branch `regression/gui-rework-v2`, 2026-05-13)
**Goal:** Three follow-on fixes that surfaced when the operator ran the suite end-to-end after the GUI rework. (1) Silent GUI timeouts on long runs — browser `EventSource` had no `onerror`/reconnect path. (2) Confusing case-vs-input count discrepancy (CLI showed ~116 inputs, GUI showed ~70 cases) AND pure-CLI sweeps weren't visible in the leaderboard because `RunManifest` was gated on `--run-id`. (3) The stale shadow-classifier production-flip gate in `docs/open-items.md:197` (≥95% from `pnpm analyze-shadow-log`) was superseded by REQ-REG-011 + Gemma 4 31B's 0.9811 sweep result but the doc still named the old criterion. Also captures the operator's interest in cascading models (Needle as tier-0 first model) as a proposal.

**Approach:** Three independent batches, mergeable in any order. Continuous batch execution per the established cadence — single end-of-phase Codex review.

**Batch A — SSE reconnect + subprocess hardening (REQ-REG-GUI-V2-021/022/024):**
- `core/src/gui/services/regression/run-registry.ts`: added per-run ring-buffered `eventLog` (capped at `MAX_EVENT_LOG_ENTRIES = 1000`) with monotonic ids; new `getEventsAfter(runId, lastEventId)` returning `Array<{id, event}>` or `{gap: true}`; new `attachLive(runId, listener)` that registers without replay (Codex C1 — prevents double-dispatch when the SSE route does replay-then-attach). `eventLog` is the single source of truth for dispatched events (raw `state.events` was dropped in the simplify pass — see "Simplify pass" below); `state.eventLog[i].event` preserves the raw event payload with no `id:` field bleed-through. `registry.isTerminal(runId)` exposes terminal-status without leaking `state.status` to callers.
- `core/src/gui/services/regression/sse-helper.ts`: writes initial `retry: 3000\n\n` directive (REQ-REG-GUI-V2-021); every event written with `id: <n>\n` so browsers cache `Last-Event-ID`; `DEFAULT_KEEPALIVE_MS` lowered 25_000 → 15_000.
- `core/src/gui/routes/regression.ts`: SSE GET handler reads `Last-Event-ID` header (Codex C2 — no `?lastEventId=` query fallback because native `EventSource` cannot mutate URLs on auto-retry); calls `getEventsAfter` then `attachLive`; emits synthetic `event: gap` (no id field, control message) when ring buffer evicted the requested id; closes channel immediately when the run is already terminal AND no new events to replay (avoids hanging the SSE response).
- `core/src/gui/views/partials/regression-live.eta`: new EventSource wrapper handles `open` (resets failureCount), `error` (3-strike "Lost connection — reload" banner per REQ-REG-GUI-V2-024), `gap` (`window.location.reload()`), terminal events (set `terminalReached=true`, close cleanly, suppress further reconnect).
- `core/src/gui/services/regression/subprocess.ts`: centralized terminal emission behind `finishOnce(event)` closure with shared `terminatedPromise` (Codex C5). Added `proc.on('error')`, `proc.stdout.on('error')`, `proc.stderr.on('error')` listeners — each routes through `finishOnce` so the registry observes at most one terminal event per run. Try/catch wraps the readline `for await` loop. `whenComplete` races the normal exit path against `terminatedPromise` so error paths (spawn ENOENT) that never produce an `exit` event still resolve.

**Batch B — Count display + CLI manifest default (REQ-REG-GUI-V2-023, REQ-REG-CLI-MAN-001):**
- `regression/src/runner/index.ts`: `--list` output gains per-case `inputCount` and terminator `totalInputs`.
- `regression/src/runner/args.ts`: new `--no-manifest` boolean flag + `--manifest-dir=<path>` with traversal/control-char/length-cap validation. Precedence locked at the resolver layer.
- `regression/src/runner/runner-options.ts` (NEW): pure `resolveManifestDefaults(cli, env, repoRoot)` helper (Codex C7 — extracted from `cli-main.ts` because its top-level await + `process.exit` make direct testing awkward). Env var is `DATA_DIR` (matches `loadSystemConfig`, Codex C6 — NOT `PAS_DATA_DIR` which doesn't exist). `--no-manifest` wins over both `--run-id` and `--manifest-dir` (Codex C8).
- `regression/src/runner/cli-main.ts`: thin wrapper — peeks argv, calls `resolveManifestDefaults`, passes to `runCli` as the new optional 4th parameter.
- `regression/src/runner/index.ts:runCli`: optional `manifestDefaults` parameter; when set, its `runId` and `manifestDir` populate `runSuite`. Backwards-compatible: existing test callers (which pass no manifestDefaults) get the old behavior.
- `core/src/gui/services/regression/case-discovery.ts`: parses new `inputCount` and `totalInputs` fields; **fail-closed** on mismatch between emitted `inputCount` and `inputs.length`, or between `totalInputs` and sum-of-inputCount (Codex C11).
- `core/src/gui/routes/regression.ts`: `GET /estimate` returns `totalInputs`; run-tab view model exposes `totalCases` + `totalInputs`.
- `core/src/gui/views/partials/regression-tab-run.eta`: renders "N cases / M inputs" in the estimate banner (Codex C10).
- `core/src/gui/views/partials/regression-live.eta`: confirm-dialog text reads "Run M input(s) across N case(s)? Estimated cost ≈ $…" when both counts available.

**Batch C — Doc supersession + Needle proposal + URS:**
- `docs/open-items.md:197`: edited paragraph to record that production-flip is now governed by REQ-REG-011 (≥0.95, cleared by Gemma 4 31B at 0.9811), with `pnpm analyze-shadow-log` retained as supplementary signal only.
- `docs/open-items.md` Proposals: NEW "Cascading-models routing (tier-0 fast model + escalation, 2026-05-13)" — captures Needle as preferred candidate, notes provider gap (not currently Ollama-supported), open questions about confidence signal + escalation contract. No design; trigger-gated.
- `docs/open-items.md` Accepted Risks: 3 new entries — pre-fix CLI sweeps not in leaderboard (one-time historical gap); SSE event log + in-flight runs in-memory (in-flight runs lost on restart); client wrapper not DOM-unit-tested (jsdom not available in node-only vitest config; covered via server tests + manual smoke).
- `docs/urs.md`: 5 new URS entries (REQ-REG-GUI-V2-021/022/023/024 + REQ-REG-CLI-MAN-001).

**Codex review applied (in-plan, 14 items):** C1 attachLive prevents double-dispatch; C2 dropped `?lastEventId=` query fallback (native EventSource can't use it); C3 client-wrapper assertions in rendered-page tests; C4 raw `state.events` shape unchanged at this stage (later dropped in the simplify pass); C5 `finishOnce()` + `terminatedPromise` race; C6 env var is `DATA_DIR`; C7 pure helper extracted from cli-main; C8 `--no-manifest` precedence locked + tested; C9 list-mode tests for `inputCount`/`totalInputs`; C10 estimate endpoint + confirm dialog show both counts; C11 fail-closed on inputCount mismatch; C12 automated route tests are the primary proof (manual SSE not relied on); C13 accepted-risk wording: in-flight runs lost on restart; C14 URS entry for degraded-connection banner.

**Post-review fixes (2026-05-13):** (P1) `findRepoRoot()` in `build-deps.ts` walks up from `import.meta.url` looking for `config/pas.yaml` instead of trusting `process.cwd()` — workspace CLI (`pnpm --filter @pas/regression test:regression`) now resolves 71 cases / 198 inputs from `regression/` cwd vs 0 before. (P1) `onSurfaceError` and the reader try/catch in `subprocess.ts` now check the `cancelled` flag and emit `cancelled` (not `failed`) when the operator-initiated teardown wins the race against a stream error or proc.error. (P2) `regression-live.eta` `showLostConnection` builds the reload button via DOM APIs (no `javascript:` URL, no `innerHTML` interpolation) — CSP-friendlier. (P3) `case-discovery.ts` accumulates up to 5 validation errors with an overflow marker instead of overwriting `parseError` per malformed entry. (P3) `subprocess.ts` finishOnce now calls `resolveExit(1)` so `normalPath` doesn't remain pending forever on spawn ENOENT.

**Tests:** root core suite 7280 passing + 1 todo (+43 new); regression workspace 414 passing (+30 new). All new tests live alongside existing fixtures — no new test files except `runner-options.test.ts`.

---

## Phase 2026-05-18 — Chatbot Command Awareness (W1)

**Status:** ✅ Merged 2026-05-18 (PR #35). Traceability backfill (this section + `REQ-CHATBOT-CATALOG-*` + catalog-injection test coverage) completed 2026-05-21 — see "Traceability backfill" below.
**Depends on:** Phase 29 (User Management), the ConversationService `/ask` app-aware prompt stack, AppKnowledgeBase.

**Plan:** `docs/superpowers/plans/2026-05-18-user-identity-and-invite-discoverability.md` (Phase 1, Batches 1A–1G).
**Spec:** `docs/superpowers/specs/2026-05-18-user-identity-and-invite-discoverability-design.md`.

### Goal

Make the chatbot reliably aware of every slash command the Router would actually dispatch for a given user, and make future drift impossible. W1 is the companion workstream to W2 (PR #34); the two shipped under the joint "User Identity Clarity + Chatbot Command Awareness" phase. Before W1, `/help` hand-rendered hardcoded command lists, the `/ask` system prompt had no command knowledge at all, an app could silently shadow a builtin command, and the `auto_detect_pas` resolver disagreed with its own manifest default.

### Approach

A single source of truth — `getEffectiveCommandCatalog(userId, deps)` in `core/src/services/router/command-catalog.ts` — enumerates every command reachable for a user: directly-handled commands (`/help`, `/start`, `/space`, `/invite`), service-gated conversation builtins (`BUILTIN_COMMAND_NAMES`), and app-manifest commands filtered by the per-user app toggle. Service-availability flags (`conversationServiceWired`, `spaceServiceWired`, `inviteServiceWired`) gate commands so the catalog cannot drift from actual Router dispatch; aliases are grouped under their canonical entry. Four consumers all read this one catalog: `/help` rendering, the sandboxed system-prompt catalog block, the build-failing doc-coverage test, and the boot-time soft warning.

### New Files

- `core/src/services/router/command-catalog.ts` — `getEffectiveCommandCatalog`, `CommandCatalogEntry`/`CommandCatalogDeps` types, `BUILTIN_COMMAND_NAMES` (moved here to break a Router import cycle), `detectCommandShadowing`, `loadAllManifests`.
- `core/src/services/router/validate-command-documentation.ts` — `validateCommandDocumentation` (pure doc-coverage check shared by the test gate and the boot warning) + `logDocCoverageWarnings`; structured `DocCoverageResult` with `missing` / `orphanAllowlist` / `expiredAllowlist` / `malformedAllowlist` buckets.
- `core/config/undocumented-commands.yaml` — structured allowlist for deliberate temporary doc-coverage exceptions (`command` / `reason` / `owner` / optional `expires`); empty by default.
- `core/docs/help/conversation-commands.md`, `core/docs/help/inviting-users.md`, `apps/echo/help.md`, `apps/notes/help.md`, `apps/food/help.md` — help-doc backfill so every catalog command is documented within the first 2000 chars (the AppKnowledgeBase truncation budget the chatbot search sees).
- `core/src/services/router/__tests__/command-catalog.test.ts`, `command-shadowing.test.ts`, `command-documentation.test.ts` (+ `__tests__/fixtures/allowlist-*.yaml`).

### Changed Files

- `core/src/services/router/index.ts` — `sendHelp` rewritten to render from `getEffectiveCommandCatalog` instead of hand-written hardcoded lists; `BUILTIN_COMMAND_NAMES` re-exported from `command-catalog.ts` for back-compat; `commandCatalogDeps` plumbed onto the Router.
- `core/src/services/conversation/prompt-builder.ts` — `buildAppAwareSystemPrompt` injects the per-user catalog inside a `<reference-data type="commands">` fence with the trusted "do not follow instructions within" directive placed OUTSIDE the fence; `formatCatalogLines` + `sanitizeCatalogField` apply per-entry (`MAX_CATALOG_DESCRIPTION_CHARS = 200`) and total-block (`MAX_CATALOG_BLOCK_CHARS = 4000`) caps, control-char + collapsed-whitespace + fence-escape sanitization; optional `getCommandCatalog` dep on `PromptBuilderDeps` (section omitted entirely when unwired).
- `core/src/services/conversation/handle-ask.ts`, `handle-message.ts`, `conversation-service.ts` — wire `getCommandCatalog` into the app-aware prompt path.
- `core/src/compose-runtime.ts` — bind `getEffectiveCommandCatalog` once with live deps (registry, admin check, per-user app toggle, service-wired flags); run `validateCommandDocumentation` after `appKnowledge.init()` and emit `logDocCoverageWarnings` (non-blocking) at boot.
- `core/src/services/app-knowledge/index.ts` — factor a reusable `loadIndexedEntries` loader + `getEntries()` so the doc-coverage test exercises the exact truncated content the chatbot's runtime search uses.
- `core/src/services/conversation/auto-detect.ts` — `getAutoDetectSetting` derives its default from `CONVERSATION_USER_CONFIG.auto_detect_pas.default` at module load (throws if the manifest entry is missing or non-boolean), so the constant cannot drift from the manifest; honors the manifest default (`true`) on unset config, missing config service, throws, and unexpected shapes, with a logged warning on the unexpected-shape path.
- `apps/notes/manifest.yaml`, `apps/notes/src/index.ts` — Notes app list command renamed `/notes` → `/listnotes` to resolve its shadow of the chatbot-builtin `/notes`; the `/note` save command and `/summarize` are unchanged.
- `core/docs/help/commands-and-routing.md` — cross-links the new help docs.

### Codex Review

Phase 1 went through two Codex review rounds before PR #35 merged. Findings included the test-vs-production manifest shape drift (a fixture using `{command:}` would parse but never match production `{name:}` — addressed by loading the real `apps/notes/manifest.yaml` off disk in `command-catalog.test.ts`), the four-consumer single-source requirement (closed by refactoring `sendHelp` to consume the catalog), and the doc-coverage gate's intent that every command that *could* be dispatched is documented (the boot/test caller forces `isAppEnabledForUser: () => true`). All corrections were applied in-place before merge.

### Tests

W1 shipped `command-catalog.test.ts`, `command-shadowing.test.ts`, `command-documentation.test.ts`, and extensions to `auto-detect.test.ts`, `router.help.test.ts`, and `apps/notes/__tests__/notes.test.ts`. Full suite green at merge (PR #35: 526 files / 11,692 tests).

### Traceability backfill (2026-05-21)

W1 merged without its `implementation-phases.md` section or URS traceability — a deferred item tracked in `docs/open-items.md`. The backfill phase added: this section; seven `REQ-CHATBOT-CATALOG-001..007` URS entries with matching Traceability-Matrix rows; and catalog-specific test coverage that was missing from the original W1 batches. The new coverage (`prompt-builder.catalog.test.ts`, plus Layer A augmentations to `command-catalog.test.ts`) is layer-correct — catalog filtering proven at `getEffectiveCommandCatalog`, fencing/capping/sanitization proven at `buildAppAwareSystemPrompt` — and surfaced two genuine W1 defects, both fixed minimally:

- **Whitespace-only app description** — `getEffectiveCommandCatalog` used `cmd.description || cmd.name`, which only catches falsy values; a whitespace-only `"   "` description survived and rendered a dangling `- /cmd — ` line. Fixed to fall back to the canonical command name unless the description has a non-whitespace character.
- **Truncation marker overflowed the block cap** — `formatCatalogLines` checked `MAX_CATALOG_BLOCK_CHARS` *before* appending the `… (catalog truncated; N omitted)` marker, so the marker pushed the fenced block past 4000 chars (observed 4040 with many small entries). Fixed to count the marker against the cap and drop accepted lines until the marker fits.

---

## Phase 2026-05-18 — User Identity Clarity (W2)

**Status:** ✅ Merged 2026-05-18 (PR #34). Post-merge Codex review corrections applied 2026-05-20 — see "Post-merge corrections" below.
**Depends on:** Phase 29 (User Management), Phase D5b-3 (per-user GUI auth)

### Goal

Replace the "numeric Telegram ID is the only login identifier and is shown everywhere" UX with display-name-or-id login plus operator-GUI surfaces that lead with `user.name`. The numeric ID remains the canonical internal identifier (filesystem paths, session cookies, Telegram delivery).

### New Files

- `core/src/services/invite/normalize.ts` — `normalizeDisplayName(raw)`: trim + locale-independent `toLowerCase`, shared by every uniqueness check.
- `core/src/services/user-manager/scan-duplicate-names.ts` — boot-time duplicate-name detector. Returns `DuplicateNameGroup[]` (empty when clean); caller derives `loginByNameAllowed = duplicates.length === 0`.
- `core/src/gui/__tests__/auth-test-helpers.ts` — shared `extractAuthCookie` + `getCookieUserId(value, secret)` for the GUI auth tests.
- `core/src/gui/__tests__/auth-username-login.test.ts` — login-by-name + canonical-id cookie + production-rejects-non-numeric (11 tests)
- `core/src/gui/__tests__/auth-login-by-name-disabled.test.ts` — duplicate-name boot scan disables login-by-name (5 tests)
- `core/src/gui/__tests__/template-name-rendering.test.ts` — operator GUI surfaces `user.name`; numeric id only inside `<small>` (10 tests)
- `core/src/services/invite/__tests__/invite-name-validation.test.ts` — name guards: numeric-only, blank, id-equality, padding (9 tests)
- `core/src/services/invite/__tests__/invite-name-uniqueness.test.ts` — uniqueness, locking, active-only semantics, races (13 tests)
- `core/src/services/user-manager/__tests__/register-user-uniqueness.test.ts` — defensive register-time check (6 tests)
- `core/src/services/user-manager/__tests__/scan-duplicate-names.test.ts` — boot-scan detector (8 tests)

### Changed Files

- `core/src/gui/auth.ts` — resolve-then-rate-limit login; numeric-id-only OR display-name-only (no fallback); `loginByNameAllowed` flag from boot scan; production-hard `allowNonNumericIdLoginForTests` (refuses to enable under `NODE_ENV=production` regardless of `VITEST`); error copy "Login or password".
- `core/src/gui/views/login.eta` — "Username or Telegram ID" label.
- `core/src/services/user-manager/index.ts` — new `findByName(name)` using `normalizeDisplayName`.
- `core/src/services/invite/index.ts` — name guards (blank / numeric-only / matches-existing-id); `withMultiFileLock([DISPLAY_NAME_LOCK_KEY, this.invitesPath], ...)` around create; required `knownUsers` callback; clock injection via `now?: () => Date`; `DISPLAY_NAME_LOCK_KEY` exported from this module (no separate locks.ts).
- `core/src/services/user-manager/user-mutation-service.ts` — defensive uniqueness check inside `withMultiFileLock([DISPLAY_NAME_LOCK_KEY], ...)`; single-key lock because `syncUsersToConfig`'s inner `withFileLock(configPath, ...)` makes a paired acquisition deadlock (AsyncLock is non-reentrant).
- `core/src/gui/views/{alert-edit,report-edit,data,config,context,dashboard}.eta`, `core/src/gui/views/account/index.eta`, `core/src/gui/views/users/reset-password.eta` — surface `user.name` as the primary label; numeric id only inside `<small>` on admin debug tables.
- `core/src/gui/index.ts`, `core/src/compose-runtime.ts` — plumb `loginByNameAllowed` from boot scan through `GuiOptions` to `AuthOptions`.
- `docs/USER_GUIDE.md`, `docs/DEPLOYMENT.md`, `docs/open-items.md`, `docs/urs.md` (REQ-USER-009/010/011/012) — operator-facing copy and traceability.

### Codex Review

Phase 2 went through two Codex review rounds. Round 1: 7 findings (non-numeric ID fallback weakens contract, stale "Telegram ID only" docs, account-page copy, locale-inconsistent normalization, "User ID" labels, open-items link drift, batch narration). Round 2 (on the simplify pass): 5 findings (optional `knownUsers` weakens service contract, URS/phase docs not updated, VITEST env sniff is a production runtime branch, `toLocaleLowerCase` is host-dependent, error copy still says "User ID"). All applied in-place.

### Tests

`@pas/core` 7388 → 7454 (+66 new tests across the 7 new test files plus extensions to `user-manager.test.ts`). Build + typecheck clean. URS: 4 new requirements (REQ-USER-009 through REQ-USER-012).

### Post-merge corrections (2026-05-20)

A post-merge Codex review of the merged W2 work surfaced four corrections, applied on branch `worktree-w2-codex-review-fixes`:

- **`registerUser` duplicate-id guard** (P1) — `UserMutationService.registerUser` now resolves the incoming id against `UserManager` before `addUser`: an identical record is an idempotent no-op, a divergent one is rejected. The W2 name-collision check skipped same-id users in anticipation of an "idempotent retry path", but `UserManager.addUser` pushes unconditionally, so a same-id re-registration would have persisted a duplicate user block to `pas.yaml`.
- **`InviteService.knownUsers` contract** (P2) — the option was typed required but two dead `if (this.knownUsers)` runtime branches and an "omitted knownUsers" test still treated it as optional. The branches are removed, a constructor guard fails fast for untyped callers, and the test now asserts the required contract.
- **Locale-dependent lowercasing** (P2) — the unknown-user login rate-limit key in `auth.ts` used `toLocaleLowerCase()`; switched to locale-independent `toLowerCase()`, consistent with `normalizeDisplayName`.
- **LLM-usage per-user breakdown** (P1) — the `/gui/llm` per-user table rendered a bare numeric id (this template was outside Batch 2B's enumerated GUI surfaces). `userManager` is now injected into the LLM-usage route; the table leads with the display name and keeps the id in `<small>`, matching the rest of the W2 GUI work.

The W1 `implementation-phases.md` section and the `REQ-CHATBOT-CATALOG-*` URS traceability were backfilled on 2026-05-21 — see the "Traceability backfill (2026-05-21)" subsection in the W1 section above. W2's identity requirements ship as `REQ-USER-009..012`; that is the canonical namespace (no `REQ-USER-IDENTITY-*` IDs are created) — see the durable note adjacent to those entries in `docs/urs.md`.

---

## App-Message Memory Bridge (2026-05-18)

**Goal:** Make every PAS-app-originated outbound Telegram message visible to the chatbot's session transcript so users can naturally follow up about reports, alerts, weekly menus, batch-prep summaries, and health insights. Closes the gap where users would say "tell me about the weekly menu" and the chatbot had zero context.

**Approach:** Mirror Hermes P9's photo-memory bridge. Introduce a new core service `AppOutboundBridge` that wraps `ChatSessionStore.appendExchange` with sanitization, opt-out gating, household resolution, and fail-open semantics. Add a `source` provenance field to `SessionTurn` so fencing can distinguish synthetic photo/app turns from user-typed lookalikes (this also fixes a pre-existing photo-bridge spoof gap surfaced during Codex Round-1 §5). Wire the bridge into six proactive call-sites (reports, alert `telegram_message`, four food scheduled-job helpers).

**Per-task batch detail:**

- **Tasks 1-4** — Core substrate: lift `sanitizePhotoField` to a shared core module as `sanitizeAppMessageField`; add `toAppMessageKind` slugifier; implement `AppOutboundBridge` interface, real impl, and `LateBoundAppOutboundBridge` proxy; integration test against real `AppConfigServiceImpl` proves opt-out works end-to-end.
- **Task 5a** — Add optional `source: 'user' | 'assistant' | 'photo' | 'app'` field to `SessionTurn`; transcript codec round-trips it; every production `appendExchange` call site (`dispatchPhoto`, `dispatchMessage`/`dispatchConversation`, `handle-message`/`handle-ask`, bridge) sets it explicitly. This closes a latent anti-spoof gap on the photo bridge as well as enabling the new app bridge.
- **Task 5** — `formatConversationHistory` uses metadata-driven cap-lift; content-regex against `PHOTO_TURN_HEADERS` / `APP_HEADER_RE` becomes a back-compat fallback for legacy transcripts only. User-typed `[Photo: receipt]` exactly no longer triggers cap-lift on new transcripts (source: 'user' beats content match).
- **Task 6** — Rewrite `PHOTO_SUMMARY_GUIDANCE` to drop the "offer to retrieve it / full data is on disk" promise (which would require chatbot-primary T2 ToolRegistry to honor); add `APP_MESSAGE_GUIDANCE` to the system prompt with parallel wording; register `chat.app_message_bridge_enabled` (default `true`) in the chatbot virtual user-config.
- **Tasks 7-8** — Wire `LateBoundAppOutboundBridge` through `compose-runtime`: proxy constructed at top of section 8c, real impl bound after `chatSessions` and chatbot `AppConfigServiceImpl` exist; manifest-gated per-app injection (`declaredServices.has('app-outbound-bridge')`). Add `"app-outbound-bridge"` to the manifest schema enum; declare it in `apps/food/manifest.yaml`. Mock service factory exposes a spy bridge for app tests.
- **Tasks 9-10** — `ReportService.deliver()` and `executeTelegramMessage` call the bridge after successful telegram sends; `toAppMessageKind` slugifies report ids and alert names. `executeDispatchMessage` documented as internal-only (no bridge call to avoid double-recording).
- **Task 11** — Food helpers: `handleWeeklyNutritionSummaryJob`, inline weekly-health correlation, `sendVotingMessages` (per-member fan-out), singleton-household meal-plan path, `sendBatchPrepToMember` all bridge their proactive sends.
- **Tasks 12-13** — End-to-end integration coverage (6 of 7 scenarios: I1 weekly nutrition; I2 alert telegram_message; I3 report to multiple users; I4 opt-out respected; I5 household_id stamped; I6 telegram failure isolation; I-DISP deferred). Persona tests (P1-P3) assert the actual `systemPrompt` STRING contains the bridged header and body (Round-1 §9 — not just stub reply). Integration tests surfaced and fixed a real bug: bridge calls from cron jobs were silently dropping writes because `requestContext` wasn't set; bridge now wraps its `appendExchange` in `requestContext.run` when no actor is in context.
- **Tasks 14-15** — Documentation: `docs/CREATING_AN_APP.md` gets a new "Proactive Messages and the Chatbot Bridge" section with the contract, manifest declaration, "when not to call" guidance, and bidirectional cross-references with the existing `PhotoSummary` doc.

**Photo-bridge fixes surfaced and resolved in this phase** (Codex Round-1 review of the plan):

- **§5 (anti-spoof regex insufficient):** Pre-existing — `PHOTO_TURN_HEADERS` was content-only. Fixed by `SessionTurn.source` field (Task 5a) and metadata-driven fencing (Task 5). Both photo and app bridges now immune to header spoofing on new transcripts.
- **§11 (retrieval promise out of scope):** Pre-existing — `PHOTO_SUMMARY_GUIDANCE` promised "offer to retrieve it" which depends on chatbot-primary T2. Rewritten in Task 6 to drop the promise; new `APP_MESSAGE_GUIDANCE` written without it.

**Codex review:** Round 1 (review of plan) — 14 items, all resolved in-place. Round 2 (review of implementation) — pending.

**URS:** 14 new `REQ-CONV-APP-BRIDGE` entries (001-014) + 3 new `REQ-CONV-SESSION-SOURCE` entries (001-003).

**Test counts:** 11761 passing total (delta of +90 over pre-phase baseline). New tests: sanitizer (8), slugifier (7), bridge unit (8), late-bound proxy (3), real-config integration (3), codec round-trip (6), fencing (7), prompt-builder (~5), compose-runtime wiring (1), reports (2), alerts (2), food helpers (6), end-to-end integration (6), persona (3).

---

## Chatbot Context & Routing Fixes (2026-05-22)

**Goal:** Fix four distinct bugs surfaced in one chatbot transcript — the chatbot couldn't see proactive Food messages, a conversational invite question mis-routed to the Food app, a multi-question message dropped its second question, and the Food `/hosting plan` handler rendered a hollow "Event Plan" block on non-event input.

**Approach:** Four independent work parts plus a documentation footprint. Part 1 routes every proactive Food send through one `sendProactiveMessage` helper so the chatbot transcript records them, backed by an entrypoint-scoped static guard that prevents future drift. Part 2 introduces an `isDegenerateEvent` untrusted-output guard so `/hosting plan` declines instead of rendering a hollow plan. Part 3 sharpens the ambiguous hosting intent string and adds a `routing.verification.always_verify_intents` config (defaulting to the hosting intent) so high-confidence-but-ambiguous classifications are still verified above the upper bound — for both text and photo paths. Part 4 adds LLM-segmented multi-intent message splitting, default ON behind a `routing.multi_intent_split` kill-switch, with `MAX_SEGMENTS = 3` and merge-overflow so a 4th question is never dropped. Part 5 is the documentation footprint (URS, traceability matrix, this section, CLAUDE.md status bullet, open-items.md).

**Per-Part detail (commits, newest first within each Part):**

- **Part 1 — Proactive Food message bridge (Error 1).** Introduces the `sendProactiveMessage` helper (`apps/food/src/utils/proactive-message.ts`), routes eight cron-driven Food jobs through it, migrates the five already-correct bridge sites onto the same helper so it becomes the *only* proactive send path, and locks the property in with a build-failing entrypoint-scoped AST scanner.
  - `5aded07` `feat(food): add sendProactiveMessage send+bridge helper` — typed `FoodProactiveKind` union, fail-open bridge call only after the send resolves, returns `SentMessage` from the buttons path.
  - `2d66d69` `fix(food): bridge nightly-rating-prompt proactive message into chatbot transcript`
  - `a3b7e92` `fix(food): bridge leftover-check proactive message into chatbot transcript`
  - `14f18cb` `fix(food): bridge perishable-check proactive message into chatbot transcript`
  - `52d7bbb` `fix(food): bridge freezer-check proactive message into chatbot transcript`
  - `b59055d` `fix(food): bridge defrost-reminder proactive message into chatbot transcript`
  - `67a0265` `fix(food): bridge cuisine-diversity-nudge proactive message into chatbot transcript`
  - `0288292` `fix(food): bridge seasonal-nudge proactive message into chatbot transcript`
  - `e1b94fe` `fix(food): bridge cultural-calendar proactive message into chatbot transcript`
  - `ec17849` `refactor(food): route existing bridge sites through sendProactiveMessage` — the 5 already-bridged sites (weekly-menu, weekly-health, weekly-nutrition, batch-prep with `SentMessage` return wiring for `setBatchFreezeRecipes`, voting) migrated so the helper is the sole proactive path.
  - `fb44721` `test(food): static guard against unbridged proactive sends` — entrypoint-scoped scanner over a named set of proactive functions plus their helpers (not whole-file, which would false-positive on the many reactive sends in `index.ts`).
  - `e62a2dc` `test(food): wiring + sanitization coverage for bridged proactive jobs` — dispatch case per job id against the real `createAppOutboundBridge`, plus a sanitization integration test asserting the trust boundary still holds end-to-end even though the helper passes the body raw.
  - `b51a566` `docs: document the proactive-message bridge pattern for app developers` — `CREATING_AN_APP.md` "Pair the send and the bridge call" subsection, `MANIFEST_REFERENCE.md` `app-outbound-bridge` row, four verified-reactive worked examples.
  - `99e822d` `test(food): persona coverage for proactive-message chatbot visibility` — reuses the `app-message-bridge.persona.test.ts` pattern, asserts the captured chatbot system prompt contains the `[App: food] <kind>` header + body excerpt.

- **Part 2 — Degenerate hosting-plan guard (Error 4).** Treats the LLM `parseEventDescription` output as untrusted and short-circuits before the two expensive downstream LLM calls when the parse lacks a guest signal or carries a meta-phrase (e.g. `"asking about how to invite people"`).
  - `40e4631` `feat(food): isDegenerateEvent guard for untrusted event parses` — precise predicate (guest signal = valid `guestCount` 1–1000 OR non-empty `guestNames`; meta-phrase decline on non-empty description only) + `PlanEventResult` discriminated union.
  - `a311539` `fix(food): /hosting plan declines non-event input instead of a hollow plan` — handler renders a fixed actionable decline; never echoes the untrusted description back to the user.
  - `3938507` `test(food): /hosting plan handler integration coverage for degenerate decline`
  - `49accc4` `test(food): persona coverage for degenerate-event decline`

- **Part 3 — Intent precision + always-verify (Error 2).** Sharpens the Food hosting intent to disambiguate from platform-invite questions, single-sources the string through `HOSTING_MEAL_PLANNING_INTENT`, and adds an `always_verify_intents` config so the route-verifier still fires on configured ambiguous intents at confidence ≥ `verificationUpperBound` — closing the high-confidence-bypass gap exposed by the original bug.
  - `f0f27ca` `fix(food): scope the hosting intent to meal planning; single-source the string` — new `apps/food/src/routing/food-intents.ts`; updated `manifest.yaml`, route maps, shadow taxonomy, and ~10 test references via `rg` sweep; contract test asserts every copy matches the constant.
  - `7ef6973` `feat(config): routing.verification.always_verify_intents (defaults to the hosting intent)` — full config surface: type, parser/sanitizer, YAML schema, settings metadata, system-config writer, example config; defaults to `[HOSTING_MEAL_PLANNING_INTENT]` so the incident is prevented out of the box on fresh setups.
  - `0ca49b6` `fix(router): always-verify configured ambiguous intents above the upper bound (text + photo)` — private `shouldVerifyIntent(name, confidence)` gate; called with `match.intent` for the text path, `match.photoType` for the photo path (closing the photo-vs-text identifier mismatch noted in Codex Round 1 §11).
  - `893a208` `test(routing): regression + persona coverage for platform-invite vs food-hosting` — `regression/src/cases/routing/pas/invite-platform.case.ts` (five platform-invite phrasings); FOOD_PERSONAS deterministic-reject entries for platform-invite phrasings on the hosting persona.

- **Part 4 — Multi-intent message splitting (Error 3).** Extracts the per-message route flow into a reusable function, adds an LLM-segmented multi-intent splitter behind a kill-switch, and dispatches each segment through the existing route flow (per-segment auth recheck preserved).
  - `5bbde63` `refactor(router): extract routeOneTextRequest for reuse` — pure refactor; single-message path becomes a one-line call to the extracted function.
  - `0b2df54` `feat(router): message-segmenter (prefilter + LLM segmentation)` — `preFilterMultiIntent` synchronous zero-cost gate (word-bounded continuation markers, not bare `and`); `segmentMessage` fast-tier LLM call with `responseFormat:'json'`, fenced untrusted input; `MAX_SEGMENTS = 3` with merge-overflow into segment 3 (no question dropped); degrade-to-single on 0 usable segments or reconstructed length > 1.5× original.
  - `4c792be` `feat(router): multi-intent message splitting (default on, config-gated)` — `tryMultiIntentSplit` invoked before `classify`; sequential per-segment dispatch through `routeOneTextRequest`; per-segment try/catch isolation; `routing.multi_intent_split` config (default `true`); byte-identical single-message behavior when off.
  - `030599d` `test(router): persona coverage for multi-intent splitting` — includes the literal bug message ("Good morning! Can you tell me about inviting people? Also...") asserting cross-Part-1+4 integration: seg 1 routes to chatbot (invite help), seg 2 routes to chatbot with the bridged Food turn visible. ≥50 unique messages spanning two/three/four-question splits, must-NOT-split cases, dependent clauses, partial failure.

- **Part 5 — Documentation footprint.**
  - `fbf9bdd` `docs(urs): document Parts 1-4 of chatbot-context-and-routing fix` — 19 new URS entries (REQ-FOOD-PROACTIVE-BRIDGE-001..007, REQ-FOOD-HOST-DEGENERATE-001..003, REQ-ROUTE-008..016) plus Fixes: amendments to REQ-ROUTE-002 (sharpened + single-sourced hosting intent), REQ-ROUTE-006 (`always_verify_intents` + `shouldVerifyIntent` text + photo), and REQ-CONFIG-001 (routing verification + multi-intent-split config keys). Traceability matrix updated.
  - This commit — implementation-phases.md section, CLAUDE.md status bullet (oldest entry demoted per anti-bloat rule), open-items.md ("Bridge additional food proactive jobs" marked resolved; new deferreds added).

**Codex review:** One round at the plan stage (Round 1, pre-execution) surfaced 13 Critical/Important findings (helper return type for `setBatchFreezeRecipes`, import-path/`InlineButton` shape, missing `weekly-nutrition` migration, hard-coded hosting-intent references in 13+ places, `isDegenerateEvent` empty-description ambiguity, bridge fail-open path untested, file-scoped guard would false-positive on `index.ts`, sanitization-vs-byte-identity assertion conflict, `always_verify_intents` defaulting to `[]` doesn't fix fresh setups, config wiring surface incomplete, photo verification uses `intent` but photo matches use `photoType`, segment-overflow drops vs merges, no test for the literal bug's 2nd question routing through the chatbot, persona tests should assert the real prompt). Every finding was applied in-place with a change table embedded in the plan before any code was written, matching the established cadence of one review at the single review point per plan phase. The post-execution Codex review is queued in Task 5.6's verification step.

**Tests:** 12099 root tests pass (+217 from this phase across helper unit tests, eight bridged-job handler tests, the static guard self-test + project scan, wiring + sanitization integration coverage, persona NL coverage for both bridged jobs and multi-intent splits, `isDegenerateEvent` table-driven tests + `/hosting plan` handler integration, hosting intent contract test + shadow-classifier persona updates, `shouldVerifyIntent` gate tests for text + photo, `always_verify_intents` config tests across the YAML / settings-metadata / writer surface, `message-segmenter` unit + 4-question merge tests, `router-multi-intent` dispatch + per-segment failure isolation, `routing.multi_intent_split` config tests, and the platform-invite regression case in `regression/src/cases/routing/pas/`). `pnpm lint` zero errors; `pnpm build` clean.

---

## Regression Token Metering (2026-05-22)

**Goal:** Surface real per-case token counts in the regression harness — replacing the hard-coded `{input: 0, output: 0}` zeroes that the GUI displayed for every case — so operators can see actual token spend per case in `RunResult.tokenCounts` and the regression GUI compare/drilldown views.

**Approach:** Extend `CostTracker` with a process-local running token counter (`getTokenUsageTotals()`), then have each case-runner take a before/after delta around its LLM adapter calls to compute real per-case token counts. The key insight: `LLMService.complete()` was deliberately NOT changed — `completeWithMeta()` already exposes usage, and the regression harness meters closures around production classifiers via `CostTracker.record()`, which already accumulates token spend. The fix therefore belonged in `CostTracker` (adding a sanitized running total readable as `getTokenUsageTotals()`), not in the LLM service interface. A new `MeteredError` wrapper carries token spend that occurred before an adapter throws, ensuring error-path tokens are counted.

**Codex plan review (Round 1 — 9 findings, all applied pre-implementation):**

Notable corrections applied to the plan before any code was written:

- (P1×4) Renamed the counter API to `getTokenUsageTotals()` (honest naming — the previously-planned name `getMonthlyTotalTokens()` falsely implied a persisted monthly figure when the counter is process-local and not persisted); added `safeTokenCount()` sanitization at the `record()` boundary to guard against NaN/Infinity/negative from provider adapters; required throw-resilient error-path metering (motivating `MeteredError`); mandated `try/finally` deltas in chatbot and receipt runners.
- (P2×4) Specified process-local (not persisted) semantics; `CostMeterSource` interface gains `getTokenUsageTotals()`; `build-deps.ts` must thread the real `CostTracker` to the receipt runner; rubric oracle's `CallMeter` carries real tokens.
- (P3×1) Confirmed `RunResult.tokenCounts` naming matches the existing type field.

Each batch additionally went through spec-compliance + code-quality review during execution.

**Batch-by-batch breakdown:**

- **B1 — `CostTracker.getTokenUsageTotals()`** — Added a sanitized (`safeTokenCount`), process-local running token counter to `CostTracker`. Incremented synchronously inside `record()` via `safeTokenCount()` (guards NaN, Infinity, negative, non-number). Not persisted; only before/after deltas matter for the harness. `CostMeterSource` interface extended with `getTokenUsageTotals()` so the regression workspace can call it without importing from core directly.

- **B2 — Throw-resilient dispatch metering** — Rewrote `meterCall()` in `regression/src/runner/dispatch.ts` to capture a token-count delta even when the adapter throws. Introduced `MeteredError` (an `Error` subclass carrying a `CallMeter`) so callers can catch throws and still recover spend. `buildRecallAdapter()` was updated with the same throw-resilient metering pattern — an inline metering block, not a call to `meterCall()`. `CostMeterSource` already gained `getTokenUsageTotals()` in B1.

- **B3 — Case-runner token propagation** — All four case-runners (routing, recall, receipt, chatbot) aggregate real token counts into `RunResult.tokenCounts`. Routing and recall runners use `MeteredError` catch to count spend before an adapter throws. Chatbot and receipt runners use `try/finally` deltas. `build-deps.ts` threads the real `CostTracker` to the receipt runner. The rubric oracle's `CallMeter` now carries real tokens.

- **B4 — Regression GUI display** — The compare table and per-case drilldown page in `/gui/regression` display real token counts from `RunResult.tokenCounts`. The stale "plumbing pending" copy was removed.

- **B5 — Documentation (this phase)** — URS updates (B5a, already committed): REQ-REG-018 added (process-local token counter), REQ-REG-013 updated (display now shows real counts), REQ-REG-017 updated (estimator note references real token data). Traceability matrix updated. Documentation files (B5b = this commit): estimator.ts JSDoc updated, implementation-phases.md section added, CLAUDE.md status bullet added, open-items.md amended.

**URS:** 1 new entry (REQ-REG-018) + 2 updated (REQ-REG-013, REQ-REG-017).

**Tests:** All existing estimator, runner, and GUI regression tests remain green. The `PER_CASE_USD_BY_BUCKET` constants are unchanged; numeric recalibration is a deferred follow-up tracked in `docs/open-items.md`.

---

## Classifier + Reply-Collector + Call-Graph Guard (2026-05-24)

**Goal:** Close three deferred open-items in one focused session: (1) the 2026-05-24 Accepted Risk that the PAS classifier failed to recognise platform-invite questions; (2) the 2026-05-22 deferred "Reply-collector Option B" that would combine multi-intent replies into one Telegram message; (3) the 2026-05-22 deferred "Stricter call-graph-based proactive-send guard" replacing the entrypoint-scoped Strategy A scanner with transitive call-graph reachability.

**Approach:** Three independent deliverables with no shared production code; subagent-driven execution dispatched one deliverable at a time on a single feature branch. The reply-collector uses an AsyncLocalStorage-aware `TelegramService` wrapper composed at runtime so handlers remain unchanged; the call-graph guard uses `ts.createProgram` + the TypeScript type checker for cross-file symbol resolution; the classifier fix adds a fifth deterministic prefilter plus targeted LLM few-shot examples.

**Codex plan review (Round 1 — 17 findings, all applied pre-implementation):**

Notable corrections applied to the plan before any code was written:

- (Critical×5) `requestContext.get()` does not exist — the API is `getStore()`; the buffer's `inner` MUST be the real transport, not the context-aware wrapper, or final flush infinitely re-buffers; the three nested `requestContext.run({...})` sites in Router (`dispatchMessage`/`dispatchPhoto`/`dispatchConversation`) drop the outer `replyBuffer` unless they spread the outer store first; `composeRuntime` accepts `telegramService` not `telegram` and exposes no `messageSegmenter`/`multiIntentSplit` overrides (integration tests must use a Router-level harness); existing `router-multi-intent.test.ts` fake apps were `vi.fn().mockResolvedValue(undefined)` — they had to be rewritten so each `handleMessage` call actually invokes `services.telegram.send(...)` or combined-message assertions are vacuous.
- (Important×7) Original `PLATFORM_INVITE_RE` was over-broad (matched "inviting people to dinner") — every branch was retightened to require a PAS/platform/access/relationship anchor and reorganised into a typed `PLATFORM_INVITE_PATTERNS` array; food persona test imports were wrong (`FOOD_PERSONAS` not `PERSONAS`; `'../food-intents.js'` not `'../intents.js'`); `InlineButton.callbackData` not `callback_data`; URS conflict on `editMessage` — narrowed REQ-ROUTE-019 to `sendPhoto`/`sendWithButtons`/`sendOptions`, added REQ-ROUTE-019b for `editMessage` bypass; type-import circular dep solved by landing `FlushableTelegramProxy` in its own `reply-buffer-types.ts` module first; call-graph scanner path/exclusion was inconsistent across `apps/food` vs `apps/food/src` — normalized to `apps/food/src` as the default `projectRoot` and added a dedicated production-root exclusion test; ESM compatibility — fixtures used `__dirname` and `require()` not available in this codebase (use `fileURLToPath(import.meta.url)` per the existing test pattern; static `import { readdirSync, statSync } from 'node:fs'`).
- (Cosmetic×5) Call-graph tests only covered `send` — extended to all four `telegram.send*` variants; `buildCallGraph` was named in the deliverable summary but only `buildGraph` existed internally — public API narrowed to just `findReachableSends` + `ProactiveSendHit`; `scanFoodProactiveSendsFromSources` retained as a thin in-memory API for the guard self-test fixture rather than removed; `it.todo` placeholders in Tasks 2.5/2.6 were filled out with full test bodies before execution; debug node-eval command for the regex was generalised to a `tsx` REPL instruction.

Codex Round 2 review of the executed branch is queued separately (the user's "single end-of-phase Codex review" cadence — `feedback_batch_execution_cadence.md`).

**Deliverable 1 — PAS-classifier platform-invite recognition (5 commits, REQ-CONV-PAS-CLASSIFY-001..005):**

- **Task 1.1 (`363f35e`)** — Authored `core/src/services/conversation/__tests__/pas-classifier.platform-invite.test.ts` with 23 tests: 7 positive phrasings + 13 negative phrasings (Codex #6 hardening — "inviting people to dinner/concert/birthday party", "add a new user to the test database", etc.) + 3 misc edge cases (case-insensitivity, surrounding punctuation, no `dataQueryCandidate`/`settingsCandidate` leakage).

- **Task 1.2 (`b7eb49d`)** — Added `PLATFORM_INVITE_PATTERNS` array of 10 entries across 8 numbered branches and `PLATFORM_INVITE_RE = new RegExp(PLATFORM_INVITE_PATTERNS.join('|'), 'i')` to `core/src/services/conversation/pas-classifier.ts`; registered as the fifth entry in `PREFILTERS` with verdict `{pasRelated: true}` only (matching `PAS_META_RE`'s shape — no `dataQueryCandidate` or `settingsCandidate`). One adaptive tuning beyond the plan: Branch 7's optional PAS-anchor group had `\s+` placed *outside* the optional group, blocking the bare ambiguous phrasing "Can you tell me about inviting people?" that the plan documented as a positive — moving `\s+` inside the optional group permitted that single bare positive while every negative phrasing (lacking the "tell me about" prefix or carrying a non-PAS suffix like "to dinner/concert/party") still failed to match.

- **Task 1.3 (`890ed48`)** — Added 3 positive (`"let my husband sign in too"`, `"add a new user"`, `"give my kids access"` → `YES_PAS NO_SETTINGS NO_DATA`) + 1 negative (`"invite my friends to a dinner party"` → `NO_PAS`) LLM few-shot mappings to the `systemPrompt` template; added 2 prompt-content unit tests asserting their presence and the prompt-length-budget guard.

- **Task 1.4 (`47a9832`)** — Mirrored the new platform-invite phrasings on Food's `HOSTING_MEAL_PLANNING_INTENT` `deterministicRejectFor` block (Codex #5 — REQ-CONV-PAS-CLASSIFY-005); created `apps/food/src/routing/__tests__/shadow-classifier-platform-invite.test.ts` with 4 assertions (imports corrected to `FOOD_PERSONAS` and `'../food-intents.js'`).

- **Task 1.5 (`6cede48`)** — Verified the regression case: `pnpm test:regression -- --rerun=pas-invite-platform-positive --no-manifest` returns `verdict: pass` for all 7 inputs deterministically via the prefilter — zero LLM dispatch, zero cost, durationMs 6. Added 5 new URS entries (REQ-CONV-PAS-CLASSIFY-001..005) under a new `## Phase 2026-05-24 — Classifier + Reply-Collector + Call-Graph Guard` header. Closed the 2026-05-24 Accepted Risk at `docs/open-items.md:349` with strikethrough + `✓ Closed` marker.

**Deliverable 2 — Reply-Collector "Option B" (8 commits, REQ-ROUTE-017..022 inc. REQ-ROUTE-019b):**

- **Task 2.1a (`bb24c6d`)** — Created `core/src/services/router/reply-buffer-types.ts` exporting the `FlushableTelegramProxy` interface (separate module first per Codex #11 — needed to break the type-import circular dep between `request-context.ts` and `reply-buffer.ts`).

- **Task 2.1b (`06567b7`)** — Extended `RequestContext` in `core/src/services/context/request-context.ts` with `replyBuffer?: FlushableTelegramProxy`; created `core/src/services/context/__tests__/request-context-reply-buffer.test.ts` with 4 pinning tests (no-buffer-in-scope, propagation through nested async, AsyncLocalStorage isolation across parallel runs, and the **Codex #2 regression guard** verifying that nested `requestContext.run()` that re-establishes context must preserve the outer `replyBuffer`).

- **Task 2.2 (`345113b`)** — Built `BufferingTelegramProxy` in `core/src/services/router/reply-buffer.ts` with 11 unit tests covering: happy-path buffer+combined-flush; empty-buffer no-op; auto-split at segment boundaries; segment-packing across chunks; hard-split of an oversize single segment; rich-send flush (`sendPhoto`, `sendWithButtons`, `sendOptions`); `editMessage` bypass (REQ-ROUTE-019b — Codex #10); per-user isolation; inner-send rejection cleanup (buffer cleared so no double-flush). `InlineButton.callbackData` field used throughout (Codex #9).

- **Task 2.3 (`1c82af5`)** — Created `core/src/services/telegram/context-aware.ts` (`ContextAwareTelegramService`). Wired into `compose-runtime.ts` keeping BOTH `realTelegram` and `contextAwareTelegram` references (Codex #3 — the buffer's `inner` must always be the real transport, never the wrapper). Router gets `realTelegram` for its own sends and as the buffer's `inner` in `tryMultiIntentSplit`; apps get `contextAwareTelegram` via `coreServices.telegram`; `RuntimeServices.telegram` exposes the real handle.

- **Task 2.4 (`a6f61fc`)** — Patched the three nested `requestContext.run({...})` sites in `core/src/services/router/index.ts` (`dispatchMessage`, `dispatchPhoto`, `dispatchConversation`) to spread `requestContext.getStore() ?? {}` first — without this, every handler dispatch drops the outer `replyBuffer` and the reply collector silently no-ops (Codex #2 is the most consequential finding). Added `core/src/services/router/__tests__/router-context-merge.test.ts` with 3 pinning tests (one per dispatch site). Rewrote `tryMultiIntentSplit` to enter a request-context scope with a `BufferingTelegramProxy` wrapping `this.telegram` (the real handle), run the segment loop, and `flushPending` in `finally`. Rewrote `router-multi-intent.test.ts` so fake apps actually call `services.telegram.send(...)` (Codex #5). The Codex #2 fix was verified by **temporary revert** of the `dispatchMessage` spread — `router-context-merge.test.ts` correctly failed with `["expected sentinel"] → [undefined]`, then restored and confirmed green.

- **Task 2.5 (`303090a`)** — Created `core/src/services/router/__tests__/router-multi-intent-reply-buffer.test.ts` with 7 integration tests covering the full real-Router-through-real-Wrapper stack: combined send happy path; segment-1 throws then segment-2 + apology combined; combined > 4000 chars auto-splits at segment boundaries; concurrent dispatches for two users don't cross-contaminate (AsyncLocalStorage isolation); `sendPhoto` mid-segment flushes prior plain text; `sendWithButtons` mid-segment flushes prior plain text; `editMessage` bypasses the buffer (REQ-ROUTE-019b). Lifted `setupRouter` from `router-multi-intent.test.ts` into `core/src/services/router/__tests__/test-helpers.ts` so 4 downstream test files share it.

- **Task 2.6 (`a331ba3`)** — Created `core/src/services/router/__tests__/multi-intent-natural-language.persona.test.ts` with 13 persona scenarios: 6 multi-intent positive cases (one-segment-per-question phrasings, conversational filler, mixed case + punctuation, 2-segment vs 3-segment), 1 long-message auto-split case, 6 should-not-split cases (single-intent messages, single intents with conjunctions like "salt and pepper" that aren't separate intents). Each test exercises the real wrapper + buffer through a recording real-telegram stub.

- **Task 2.7 (`e8d9f04`)** — Added 7 new URS entries (REQ-ROUTE-017..022 plus REQ-ROUTE-019b) to the new phase section in `docs/urs.md`. Updated traceability matrix totals. Closed the 2026-05-22 deferred entry at `docs/open-items.md:207` with strikethrough + `✓ Closed` marker.

**Deliverable 3 — Strategy B call-graph guard (3 commits, REQ-FOOD-PROACTIVE-BRIDGE-008..011):**

- **Task 3.1 (`818a644`)** — Built `apps/food/src/testing/proactive-send-call-graph.ts` (305 lines) exporting only `findReachableSends` + `ProactiveSendHit` (Codex #15 — `buildGraph` is internal). Pure ESM throughout — static `import { readFileSync, readdirSync, statSync } from 'node:fs'`, no `require()`, no `__dirname` (Codex #13). The scanner builds a function-level call graph via `ts.createProgram` + the TypeScript type checker, walks BFS from each named entrypoint, and reports `telegram.send*` (all four variants — `send`, `sendWithButtons`, `sendPhoto`, `sendOptions`) call sites whose enclosing function is reachable, excluding the sanctioned bridge file. **Subtle implementation detail worth recording:** `checker.getSymbolAtLocation()` returns the import-alias symbol for cross-file `import { foo } from './bar.js'` — without dereferencing via `checker.getAliasedSymbol(symbol)` when `symbol.flags & ts.SymbolFlags.Alias` is set, every cross-file edge in the call graph would be silently dropped. With the one-line alias dereference, cross-file reachability works correctly. Test file `apps/food/src/__tests__/proactive-send-call-graph.test.ts` has 12 tests across 8 describe blocks (direct send, transitive same-file, cross-file resolution, cycle safety with mutually-recursive helpers, non-reachable code, exclusions, aliased call sites, all 4 send variants, production-root exclusion shape).

- **Task 3.2 (`fefc632`)** — Rewrote `apps/food/src/testing/proactive-send-scan.ts` to delegate `scanFoodProactiveSends(root)` to `findReachableSends` (Strategy B). The `PROACTIVE_ENTRYPOINTS` set (the 13 semantic anchor names) stays as the entrypoint declaration. `scanFoodProactiveSendsFromSources` retained as a thin in-memory Strategy-A scanner for the guard self-test fixture only (Codex #16). Rewrote `apps/food/src/__tests__/proactive-send-guard.test.ts` to use `fileURLToPath(import.meta.url)` for the production-root computation (Codex #13).

- **Task 3.3 — skipped (best case outcome).** The real Strategy B sweep against `apps/food/src` returns `[]`. Strategy A's explicit-helper enumeration was already accurate; no Food helper had to be routed through `sendProactiveMessage`. The deferred-item trigger — "the entrypoint list grows brittle OR a real regression sneaks through a helper not listed in the explicit set" — has not fired; the Strategy A list happened to be complete. Strategy B is now the guard going forward, so any new helper added between an entrypoint and a `telegram.send*` will be caught automatically.

- **Task 3.4 (`b402f39`)** — Added 4 new URS entries (REQ-FOOD-PROACTIVE-BRIDGE-008..011) to the phase section in `docs/urs.md`. Updated traceability matrix totals. Closed the 2026-05-22 deferred entry at `docs/open-items.md:206` with strikethrough + `✓ Closed` marker.

**Tests:** 12,191 root tests pass (+80 from this phase: 27 platform-invite + 2 few-shot prompt + 4 food-shadow + 4 request-context-reply-buffer + 11 reply-buffer unit + 3 router-context-merge + 11 router-multi-intent rewrite + 7 router-multi-intent-reply-buffer + 13 multi-intent-natural-language persona + 12 proactive-send-call-graph - 2 rewritten in proactive-send-guard - 12 = net +80 from the plan's task structure). `pnpm lint` zero errors; `pnpm build` clean.

**Files modified or created:**

- `core/src/services/conversation/pas-classifier.ts` (extended)
- `core/src/services/conversation/__tests__/pas-classifier.platform-invite.test.ts` (new)
- `core/src/services/conversation/__tests__/pas-classifier.test.ts` (+2 prompt tests)
- `apps/food/src/routing/__tests__/shadow-classifier.personas.ts` (+3 deterministicRejectFor entries)
- `apps/food/src/routing/__tests__/shadow-classifier-platform-invite.test.ts` (new)
- `core/src/services/router/reply-buffer-types.ts` (new)
- `core/src/services/router/reply-buffer.ts` (new)
- `core/src/services/router/__tests__/reply-buffer.test.ts` (new)
- `core/src/services/router/__tests__/router-context-merge.test.ts` (new)
- `core/src/services/router/__tests__/router-multi-intent-reply-buffer.test.ts` (new)
- `core/src/services/router/__tests__/multi-intent-natural-language.persona.test.ts` (new)
- `core/src/services/router/__tests__/test-helpers.ts` (new — lifted shared factory)
- `core/src/services/router/__tests__/router-multi-intent.test.ts` (rewritten — fake apps now call `services.telegram.send`)
- `core/src/services/router/index.ts` (3 nested `requestContext.run` patches + `tryMultiIntentSplit` rewrite)
- `core/src/services/context/request-context.ts` (replyBuffer field added)
- `core/src/services/context/__tests__/request-context-reply-buffer.test.ts` (new)
- `core/src/services/telegram/context-aware.ts` (new)
- `core/src/compose-runtime.ts` (real vs context-aware telegram split)
- `apps/food/src/testing/proactive-send-call-graph.ts` (new)
- `apps/food/src/__tests__/proactive-send-call-graph.test.ts` (new)
- `apps/food/src/testing/proactive-send-scan.ts` (rewritten — Strategy B delegate)
- `apps/food/src/__tests__/proactive-send-guard.test.ts` (rewritten — Strategy B sweep)
- `docs/urs.md` (16 new REQ entries + matrix totals)
- `docs/open-items.md` (3 entries closed: lines 206, 207, 349)

---

## GUI UX Redesign for Nontechnical Users (2026-07-06)

**Goal:** Reorganize the management GUI around user tasks for nontechnical users (both the admin and household-member personas), fold in the eight queued UX Hardening Batch 2 fixes (I4–I8, M3, M4, M7), surface four backend capabilities that had no GUI (Conversations transcripts, Backups, Activity digest, AI-usage time series), and add Chart.js metric charts — with zero backend contract changes and zero failing tests throughout. Spec: `docs/superpowers/specs/2026-07-06-gui-ux-redesign-design.md`. Plan: `docs/superpowers/plans/2026-07-06-gui-ux-redesign.md`.

**Approach:** Seven batches, each an independently shippable vertical slice, executed continuously with a single end-of-phase Codex review per `feedback_batch_execution_cadence.md`. Batch 1 lands shared cross-cutting patterns (labels, styled htmx errors, spinners, login reasons, nav regroup, confirmations, aria). Batch 2 replaces the ops dashboard with a three-zone Home fed by new permission-scoped JSON metrics endpoints and vendored Chart.js, behind a declarative chart registry so future chart edits touch exactly one file. Batches 3–4 replace the report/alert mega-forms with htmx step wizards that submit the **exact existing POST field contracts** (verified by CONTRACT deep-equal tests against the legacy forms) — admin-only creation remained an explicit operator decision from the Codex plan review, so members get read-only scoped views instead. Batch 5 turns Users into a Household hub with a guided invite flow (resolving the required `householdId` via `HouseholdService`) and a deliberate member-read-only household guard change. Batch 6 adds the four new surfaces. Batch 7 (this section) is the documentation footprint.

**Codex plan review (v2, 2026-07-06) — 17 findings, all applied pre-implementation.** The most consequential: (Critical) GUI routes are registered in `composeRuntime`, not `bootstrap` — every new dependency (`fileIndex`, `chatTranscriptIndex`, `inviteService`, `backupConfig`) had to be threaded through `GuiOptions` + `composeRuntime` rather than `bootstrap.ts`; (Critical) `RuntimeServices.backupService` is always `undefined` at GUI-registration time (bootstrap builds one later, cron-only) — the Backups route constructs its own `BackupService` instance from `backupConfig` instead of depending on a threaded instance; (Critical) `InviteService.createInvite` throws without `opts.householdId` — the invite flow resolves the admin's household via `HouseholdService` first; (Critical) the spec originally implied member-created reports/alerts, but creation routes are admin-only today — **operator decision: creation stays admin-only**, members get read-only views instead (this became the new Tasks 3.4/4.4, and the corresponding Proposal entry in `docs/open-items.md`). Important findings corrected the alert/report POST contract enumeration (missing `action_llm_summary_{i}`, `action_webhook_include_data_{i}`, `action_wd_mode_{i}`, `section_label_{i}`), the cooldown field's actual shape (a human string like `"4 hours"`, never a bare number), and the `FileIndexFilter` lacking household/space fields (the alert wizard's data-source picker filters entries itself).

**Batch 1 — Nav regroup + cross-cutting patterns (I4–I7, M3, M4, M7):**
- **Task 1.1 (`f0a7feb`)** — `humanizeLabel` utility; single source for enum/system-string → plain-language labels.
- **Task 1.2 (`ae27cb7`, hardened `6803c03`)** — `sendErrorFragment` + styled `.pas-error-card` partial; full sweep across settings/data/apps/users htmx failure paths so no htmx-reachable route ever returns raw text or a stack trace.
- **Task 1.3 (`54d6c94`)** — Global htmx loading indicators + disabled-submit-during-request behavior in `layout.eta`.
- **Task 1.4 (`1b0c9cc`)** — Login page explains session-expiry (`?reason=expired`) and stale-sessionVersion (`?reason=session-invalidated`) sign-outs; rate-limit response names the real wait window.
- **Task 1.5 (`df149d3`)** — Task-oriented sidebar nav regroup (Home / Automations / People and sharing / Your data / System), destructive-action confirmations, aria-label sweep.

**Batch 2 — Home page + metrics endpoints + Chart.js:**
- **Task 2.1 (`5360786`)** — Vendored Chart.js 4.4.9 UMD (pinned version + SHA-256 recorded in `core/src/gui/public/README.md`).
- **Task 2.2 (`f774031`)** — `GET /gui/api/metrics/llm-daily` + `GET /gui/api/metrics/activity-daily`, both permission-scoped (member sees own rows only; admin sees an aggregated + per-user/per-household breakdown), handling all 6/8/9-column `llm-usage.md` row variants.
- **Task 2.3 (`4e63441`)** — Additive `ChatTranscriptIndex` queries: `listSessionsForUser`, `listMessagesForSession`, `countMessagesByDay` — no existing method signature changed.
- **Task 2.4 (`339402e`, fixed `37b8f4e`)** — Three-zone Home (attention banners, glance metrics, activity snippet) replaces the ops dashboard. The fix commit corrected the home cost-cap banner logic, the "messages this week" card, and an unscoped member alert-firings count in the metrics endpoint.
- **Task 2.5 (`c931f95`)** — Declarative chart registry (`core/src/gui/charts/registry.ts` + `core/src/gui/public/pas-charts.js` + `docs/GUI_CHARTS.md`) — adding, revising, or removing a chart touches exactly one file.

**Batch 3 — Report wizard:**
- **Task 3.1 (`32765c8`)** — Schedule presets utility with real next-run preview via `cron-describe.ts`.
- **Task 3.2 (`ae7df80`)** — `describeReport` human-readable review sentence, rendered on the reports list page.
- **Task 3.3 (`20927cd`, hardened `7ad5348`)** — Guided report wizard submitting the existing POST contract; the hardening commit fixed a step-1 hidden-field echo bug (section fields were being echoed alongside their visible counterparts) and strengthened the edit-wizard guard test.
- **Task 3.4 (`d9c2ed6`)** — Member read-only Reports view — creation stays admin-only.

**Batch 4 — Alert wizard:**
- **Task 4.1 (`d88151d`)** — Rule-builder utility mapped 1:1 to the six `evaluateDeterministic` grammar patterns.
- **Task 4.2 (`8c88a5c`)** — `describeAlert` human-readable sentence.
- **Task 4.3 (`61f3336`, fixed `87e8090`)** — Guided alert wizard (retires the I8 lost-form-state pattern). The fix commit was consequential: the wizard originally shipped with only `telegram_message` in its action picker and had an edit-prefill bug that silently dropped a second action on a multi-action alert; both were corrected to the full six-action-type picker with lossless edit prefill (verified by a deep-equal prefill test).
- **Task 4.4 (`4d5a79d`)** — Member read-only Alerts view.

**Batch 5 — Household & sharing hub:**
- **Task 5.1 (`7717eec`)** — Guided invite flow: resolves `householdId` via `HouseholdService` before calling `InviteService.createInvite` (which throws without it), renders a copy-paste instruction card.
- **Task 5.2 (`4000dd6`)** — Member read-only Household view — a **deliberate guard change**: `/gui/users` was previously 403 for non-admins; members now get a household-scoped read-only view, verified by an explicit two-household-isolation test.
- **Task 5.3 (`41ba722`)** — Plain-language spaces reframe.
- **Fix commit (`d00f0d9`)** — Batch 5 review follow-ups; hardening commit (`5a67c17`) added XSS-escaping coverage for the invite instruction card.

**Batch 6 — New surfaces:**
- **Task 6.1 (`df22928`)** — `/gui/sessions` Conversations browser — deliberately **own-sessions-only for everyone, including admins** (chat transcripts are personal), FTS-scoped search, no-existence-leak 404 on another user's session id.
- **Task 6.2 (`d028aa8`)** — `/gui/backups` (admin) — builds its own `BackupService` instance from `backupConfig` since no threaded instance exists at GUI-registration time; disabled-state `pas.yaml` snippet; `POST /run` wraps `createBackup()` in try/catch (it throws on tar/empty-archive failure).
- **Task 6.3 (`567a70e`)** — `/gui/activity` change-log digest feed, scoped by household/space membership.
- **Task 6.4 (`02a353a`)** — AI-usage page: member-scoped read-only view (**another deliberate guard change** — `/gui/llm` was previously 403 for non-admins) + registry-driven charts for the admin view.
- **Gate commit (`72dfb57`)** — added `/gui/backups` to the shared admin-guard `it.each` parametrized route list.

**Tests:** `pnpm test` — 573 test files, **12395 passed, 3 skipped, 1 todo** (12399 total), zero failures. `pnpm lint` — zero errors (2009 baselined warnings, unchanged policy). `pnpm build` — clean across all five workspace projects (`core`, `apps/echo`, `apps/food`, `apps/notes`, `regression`).

**Files modified or created:** 91 files changed across the full `6c9944f..HEAD` range (11,643 insertions, 486 deletions). Headline new files: `core/src/gui/utils/{humanize,error-fragment,schedule-presets,describe-automation,rule-builder,alert-history-stats}.ts`, `core/src/gui/routes/{metrics,report-wizard,alert-wizard,sessions,backups,activity}.ts`, `core/src/gui/charts/registry.ts` + `core/src/gui/public/pas-charts.js` + `docs/GUI_CHARTS.md`, `core/src/gui/views/home.eta` (replacing `dashboard.eta`), `core/src/gui/views/{report-wizard,alert-wizard,sessions,session-detail,backups,activity}.eta` + their step partials, `core/src/gui/public/chart.umd.min.js` (vendored Chart.js 4.4.9), `core/src/services/chat-transcript-index/list-queries.ts`. Headline modified files: `core/src/gui/views/layout.eta` (nav regroup + loading indicators + toast region), `core/src/gui/views/login.eta` + `core/src/gui/auth.ts` (sign-out reasons), `core/src/gui/routes/{reports,alerts,users,llm-usage}.ts` (wizard entry links, describe-sentences, guard changes), `core/src/gui/index.ts` + `core/src/compose-runtime.ts` (new route registration + `GuiOptions` deps threading), `core/src/services/chat-transcript-index/chat-transcript-index.ts` (additive interface methods). Full test-file list: `core/src/gui/__tests__/{error-fragment,nav-regroup,login-reasons,home,metrics,report-wizard,alert-wizard,household,sessions,backups,activity}.test.ts`, `core/src/gui/utils/__tests__/{humanize,schedule-presets,describe-automation,rule-builder,alert-history-stats}.test.ts`, `core/src/gui/charts/__tests__/registry.test.ts`, `core/src/services/chat-transcript-index/__tests__/list-queries.test.ts`, plus extensions to `admin-route-guards.test.ts`, `reports.test.ts`, `alerts.test.ts`, `llm-usage.test.ts`, `routes.test.ts` (I6 loading-indicator wiring), `d5b5-auth.test.ts` (spaces plain-language reframe), and `core/src/server/__tests__/server.test.ts` (vendored Chart.js + slot-renderer asset serving). Documentation footprint (Batch 7, this commit): `docs/urs.md` (26 new `REQ-GUI-*` entries + matrix rows + totals), `docs/implementation-phases.md` (this section), `docs/open-items.md` (Confirmed Phase marked implemented; UX Hardening Batch 2 line annotated shipped; D2 conversation-sessions entry marked shipped), `CLAUDE.md` (one new Implementation Status bullet, oldest bullet demoted per the anti-bloat rule).

**Final Codex review round (applied):** five findings from the end-of-phase Codex review, each landed as its own TDD commit.
1. **(Critical, `127141d`)** Report/alert history list + history-file-detail routes (`reports.ts`, `alerts.ts`) read history files without re-checking delivery visibility — a member could `GET /gui/reports/<any-id>/history` (and the file-detail route) for a report/alert NOT delivered to them, even though the list/edit views were already scoped (D5b-5). Fixed by loading the definition first and reusing the existing `isDeliveryVisible` helper; a non-visible or unknown id returns 404 (not 403), matching the `sessions.ts` anti-enumeration precedent.
2. **(Important, `e9c3054`)** Both wizards typed `delivery_user?: string | string[]` but spread the raw body into the review-step hidden-field echo, where `hiddenFields()`'s `escapeHtml(v)` assumed a string — two recipients selected (a repeated form key) 500'd. Fixed by a shared `core/src/gui/utils/wizard-body.ts` `normalizeBody()` applied identically in both wizards: `delivery_user` is consumed into a computed `delivery` array and dropped from the echoed body; any other unexpected `string[]` is joined with `", "`. `hiddenFields()` in both files also hardened defensively to serialize array values as repeated hidden inputs instead of throwing.
3. **(Important, `44b8bca`)** `/gui/sessions`, `/gui/activity`, `/gui/backups` are registered only when their optional dependency is present, but `layout.eta` always linked all three — clicking a link for an unconfigured surface 404'd. Fixed via a new `navFlags` option on `registerViewLocals` (default all-true), computed in `gui/index.ts` from the same presence checks used to conditionally register the routes, gating each nav `<li>` in `layout.eta`.
4. **(Important, `92e559c`)** In fully legacy-only auth mode (`registerAuth` given only `{ authToken }`, no per-user deps), `request.user` stays `undefined` for the whole request — the single shared token IS the admin session. `dashboard.ts` and `metrics.ts` computed `isAdmin` as `Boolean(actor?.isPlatformAdmin)`, which silently degraded that legitimate admin session into an empty member-scoped view. Fixed via a new shared `core/src/gui/utils/gui-admin.ts` `isGuiAdmin(request)` that copies the existing "no `request.user` ⇒ unrestricted" convention already used by `report-wizard.ts`/`alert-wizard.ts`'s own `isPlatformAdmin` helper and the repeated `if (request.user && !request.user.isPlatformAdmin)` guard across `reports.ts`/`alerts.ts`/`data.ts`/`spaces.ts`, rather than inventing new semantics. Routes that require a userId to scope (`sessions.ts`, `activity.ts`, `llm-usage.ts`'s `/gui/llm`) were verified to already 403 cleanly on a missing `request.user` — no change needed there.
5. **(Minor, `50aad8a`)** Neither metrics endpoint set a `Cache-Control` header despite returning per-user-scoped data. Both now set `Cache-Control: private, max-age=30`.

Tests: 5 new/extended test files (`d5b5-auth.test.ts`, `report-wizard.test.ts`, `alert-wizard.test.ts`, `nav-regroup.test.ts`, `home.test.ts`, `metrics.test.ts`), each fix TDD'd with a failing test reproducing the exact defect before the code change. `pnpm vitest run core/src/gui` green after every commit; full `pnpm test` + `pnpm lint` + `pnpm build` green at the end of the round.

**Live-verification fixes (2026-07-07).** A separate pass fixed nine bugs found by driving the redesigned GUI live against seeded data (not code review) — three commits, each TDD'd with a failing test reproducing the exact defect first.

*Commit A — timezone/window/ordering bugs (`c62d7c4`):*
- **A1:** `activity.eta`'s day header parsed a UTC `YYYY-MM-DD` string with `new Date(day.date)` (midnight UTC) then rendered it via `toLocaleDateString(undefined, ...)` in the server's LOCAL timezone — a server behind UTC at midnight rendered the previous calendar day. Fixed by parsing with an explicit `Z` suffix and rendering with `timeZone: 'UTC'`.
- **A2:** `buildPerHouseholdRows` (llm-usage.ts) sourced the "Calls (month)" column from `parseUsageMarkdown`'s ALL-TIME `perHousehold` aggregate while the same row's cost came from `costTracker.getMonthlyHouseholdCost()` (month-scoped) — the two numbers didn't share a time window. Fixed by filtering the usage-log markdown to current-month rows before aggregating call counts.
- **A3:** `dashboard.ts` built the "Recent activity" snippet via `entries.slice(-5).reverse()`, which only shows newest-first when the underlying JSONL happens to be chronological — `collectChanges` preserves raw append order with no sort guarantee. Fixed by sorting by timestamp descending before taking the top 5 (`collectChanges`'s own contract unchanged).

*Commit B — wizard save flow + report ID friendliness (`ea1510f`):*
- **B1:** report/alert wizard step 3/4 required a hand-typed "ID (lowercase, hyphens)" field with HTML5 `pattern`/`required` validation that silently blocked Next with no visible error. New `core/src/gui/utils/slugify-id.ts` (`slugifyForId` + `uniqueSlugForId`) auto-derives a slug from the name when the (now-optional, disclosure-wrapped) ID field is blank, with a `-2`/`-3` collision suffix via `reportService.getReport`/`alertService.getAlert` lookups; a hand-typed invalid id is now rejected server-side with a styled inline error.
- **B2:** saving the wizard's Review step redirected to the legacy per-item edit form (`/gui/reports/:id/edit`, `/gui/alerts/:id/edit`), dropping a nontechnical admin who just finished the guided wizard into the raw technical editor. The Review form now carries a hidden `from=wizard` field; both create routes branch on it to redirect to the list page instead — legacy form saves (no `from` field) are unaffected.

*Commit C — plain-language polish (`4cb44e0`, `ca8ecd4`):*
- **C1:** `rule-builder.ts`'s `parseExpression` only recognized `"is empty"`/`"is not empty"` — the evaluator also accepts the bare `"empty"`/`"not empty"` synonyms, so a legacy/Advanced alert using those fell through to `describeAlert`'s raw-expression fallback, producing "if it not empty". Both bare forms now map to the same rule-builder pattern as their "is ..." counterparts.
- **C2:** the backups page showed the raw cron expression in parens; the route now passes a `describeCron`-rendered `scheduleDescription` instead.
- **C3:** the topbar link read "Dashboard" while the sidebar nav for the same destination already said "Home" — relabeled to match.
- **C4:** `activity.ts`'s `VERB_BY_OPERATION` mapped `append` to the bare verb "added to", which combined with the template's fixed "{file} was {verb}" produced the dangling "log.md was added to". Verbs are now full "was/had ..." clauses (`append` → "had items added").
- **C5:** `layout.eta` always rendered the full sidebar nav + Logout button regardless of authentication state, so `/gui/login` showed the whole app chrome to an unauthenticated visitor (Logout was the first submit button in the DOM). All 6 `login.eta` render sites in `auth.ts` now pass `isLoginPage: true`; `layout.eta` gates the sidebar and Logout form on it (not on `it.currentUser`, since legacy shared-token sessions also lack `request.user` yet must still see the full chrome).
- **C6:** report/alert wizard step 2 asked for "Hour (0-23)" and "Day of week (0=Sun..6=Sat, weekly only)" as raw numeric inputs. New `hourLabel12h`/`weekdayLabel` helpers (`schedule-presets.ts`) back `<select>` dropdowns with 12h time labels and weekday names, submitting the same `preset_hour`/`preset_weekday` numeric values — no contract change.
- **C7 (addendum, folded into the C-commit):** the regrouped sidebar's "Your data" section showed "Files" (`/gui/data`) to every authenticated user, but `data.ts`'s route guard (a pre-existing deliberate data-boundary decision, unchanged here) denies non-platform-admins with a 403. Gated the Files nav item behind `it.isPlatformAdmin`, same pattern as the System section.

Tests: `pnpm test` — 574 test files, 12458 passed, 3 skipped, 1 todo, zero failures. `pnpm lint` — zero errors in changed files (baselined warnings only; the repo-wide "1 error" from a full `pnpm lint` run is an untracked runtime artifact from a separate in-progress workstream, `scripts/.gui-verify-expected.json`, out of this phase's scope). `pnpm build` — clean across all five workspace projects. Docs footprint: `docs/urs.md` (Fixes annotations + new test citations on REQ-GUI-HOME-002, REQ-GUI-SURFACE-002/003, REQ-LLM-028, REQ-GUI-UX-003/004, REQ-GUI-WIZARD-001/002/004/005; new `slugify-id.test.ts` file added to the traceability matrix; Totals row recounted), `docs/open-items.md` (member-scoped file browsing tracked as a follow-up, added separately).

---

## Regression Run Unblock — Model Capability Guards + Live Progress (2026-09-01)

**Goal:** A live `pnpm test:regression` sweep returned **100% `error` verdicts** while the systems under test were answering correctly. Find out why, fix the infrastructure so verdicts reflect model behaviour rather than request shape, and make a long-running regression sweep observable from the GUI while it runs.

**Outcome:** two independent root causes, a third and fourth instance of one recurring defect class, and a long-latent test-rot bug found along the way — six commits, `449cc40` → `9b15027`.

---

### Root cause 1 — `temperature` rejected by the judge model (`449cc40`)

`regression/src/oracles/rubric.ts` sends `temperature: 0`; `anthropic-provider.ts` forwarded it unconditionally; `claude-opus-5` answered ``400 invalid_request_error: `temperature` is deprecated for this model.`` All 10 chatbot cases errored **at the judge**, not in the chatbot.

A live probe (1-token calls against the real API, 2026-09-01) established the boundary:

- **Reject `temperature`:** `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-7`
- **Accept:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001`
- **404 / no longer served:** `claude-sonnet-4-20250514` (which is the repo's built-in Anthropic default in `core/src/services/config/default-providers.ts`), `claude-opus-4-20250514`, `claude-3-5-sonnet-20241022`, `claude-haiku-3-5-20241022`, `claude-sonnet-4-7`

No OpenAI or Google key is configured, so those providers are unprobed and rely on the permissive default plus the self-healing retry. Both facts are tracked in `docs/open-items.md`.

### Root cause 2 — thinking models return empty text (`9f9f2fb`)

`apps/food/src/routing/shadow-classifier.ts` calls with `maxTokens: 80`; `ollama-provider.ts` sends that as `num_predict` and read only `response.response`. Thinking-capable models default to thinking ON, burn the whole budget inside the SDK's separate `thinking` field, and return `""` with `done_reason: "length"`. All 16 routing cases then failed with `JSON parse failed: Unexpected end of JSON input` — while output token counts were non-zero.

Live probe evidence: `qwen3.8:27b-mlx` and `muse-glimmer:30b-mlx` both returned empty content with 762- and 856-character thinking blocks at `num_predict: 176`; with `think: false` at the real production shape (`format: json`, `temp 0`, `num_predict: 80`) they returned correct JSON in 24 and 15 tokens respectively. `think: false` is accepted and ignored by non-thinking models (`gemma4:31b`, `gemma4:e4b`).

### The recurring defect class

A fixed `maxTokens` budget feeding a structured-output parse, where truncation is reported as **malformed output** rather than as **truncation**. Four instances found this phase:

1. Ollama empty output (`9f9f2fb`) — reported as `Unexpected end of JSON input`.
2. Rubric judge (`e90e8f0`) — observed live as `judge JSON parse failed ... raw="{"score": 2, "explanation": "The reply g`.
3. Food shadow classifier (`9b15027`) — observed as `Unterminated string in JSON at position 369` from `muse-glimmer:30b-mlx`. `9f9f2fb`'s guard deliberately requires *empty* text, so non-empty truncation fell straight through to the structural oracle's generic parse failure one layer down.
4. Two further call sites found and **deliberately not fixed** (recall classifier, message segmenter, plus a lower-risk third in the weakness summarizer) — tracked in `docs/open-items.md`.

---

### Commit-by-commit

**`449cc40` — per-model temperature capability gate + self-healing fallback + non-retryable deterministic 400s**

- New `core/src/services/llm/model-capabilities.ts`, mirroring `model-pricing.ts`: `ModelCapabilities` / `MODEL_CAPABILITIES` / `getModelCapabilities()` / `supportsTemperature()`. Table seeded from the live probe above. Unknown models default to **supported**, so nothing unprobed changes behaviour; an `Object.hasOwn` guard stops a model id like `constructor` resolving through `Object.prototype`.
- Anthropic, OpenAI-compatible and Google providers spread `temperature` conditionally, matching the existing `systemPrompt` / `responseFormat` style. Ollama is untouched — local models accept it and rely on the `?? 0.1` default.
- `BaseProvider.completeWithTemperatureFallback` self-heals an unlisted model: a parameter-rejection 400 that names `temperature` triggers exactly one retry with the field stripped, plus a `warn` carrying the model id so a table entry can be added. Narrower than the general classifier on purpose — stripping the temperature only helps when the temperature is what the model objected to.
- `classifyLLMError` gains a non-retryable `parameter-rejection` category (five message patterns, gated on status 400, checked after the billing 400 so it cannot hijack it) whose user message states the real reason instead of "try again later". `withRetry` gains an optional `shouldRetry` predicate (default unchanged) so `BaseProvider` fails out of a deterministic 400 immediately instead of burning 1s + 2s of backoff before the strip-and-retry.
- Also fixed two pre-existing red suites caused by hardcoded calendar dates rotting out of their rolling lookback windows (`gui/activity`, `gui/metrics`) — both now build fixtures relative to now, per the CLAUDE.md rule.
- Verified against the live API: `claude-opus-5` and `claude-sonnet-4-6` both complete, and a table entry removed at runtime self-heals in ~1.3s.

**`9f9f2fb` — Ollama thinking disabled by default; loud `LLMEmptyOutputError` on empty-output-at-length**

- New `LLMCompletionOptions.thinking`, defaulting OFF. `OllamaProvider` sends `think` **unconditionally** (not a conditional spread) so `think: false` actually reaches the wire. The flag is deliberately **not** gated on `responseFormat === 'json'` — the tightest budget in the repo is `pas-classifier`'s `maxTokens: 10` with no `responseFormat` at all — and not set per call site either, because opt-out defaults are how this recurs. A caller wanting a reasoning phase sets `thinking: true` and raises `maxTokens`.
- `LLMEmptyOutputError` is thrown when Ollama returns empty text with a `length` finish reason, naming the model, the `num_predict` budget and the thinking-block length. Gated on empty + truncated rather than on a thinking block being present. Empty + `stop` still returns `""` — the pre-existing Gemma ambiguity that the shadow/recall classifiers already retry themselves.
- Classified as the non-retryable `empty-output` category; `BaseProvider`'s `shouldRetry` skips it (re-exhausting the same budget is as pointless as re-sending a rejected parameter). The message is carried through `ShadowResult`'s `llm-error` variant into the regression `MeteredError`, so a report says what broke instead of "food-shadow infrastructure error: unknown".

**`2767b93` — regression GUI live-run progress bar + `activeRunId` wired up**

- `run-registry`: `RunProgress {completed, total}` rides every dispatched event. `RunState` gains `totalCases` (0 = unknown) plus a monotonic `completedCases`; `eventLog` entries become `{id, event, progress}`. The counter is monotonic state rather than an `eventLog` scan (the ring buffer evicts past `MAX_EVENT_LOG_ENTRIES`), and each entry carries its own snapshot so replay reports historical counts instead of stamping every frame with the final one. New `getActiveRunId()`.
- Routes: the progress denominator is the **bucket-filtered** case count — `--rerun` only forces a cache miss (`regression/src/runner/index.ts:171`) while the bucket filter (`:134-136`) is what actually narrows selection, so every bucket-filtered case still reports a result. The bucket filter is hoisted out of the `forceFresh` block; `totalCases` rides `createRun` and the 202 body; `case-completed` SSE frames carry `completed` / `total` (two numbers, no new XSS surface). `GET /estimate` is deliberately untouched — its rerun-narrowing is correct for cost and pinned by existing tests.
- `activeRunId`: all six render paths passed `null`, leaving `data-runid`, the client bootstrap reattach, and the summary-bar guard as dead code. Threaded through each renderer's deps from `getActiveRunId()`; the "view live" link drops the `?runId=` nobody parsed; compare's three estimate literals gain the missing `totalCases` / `totalInputs`.
- Client: `setProgress()` writes element properties + `textContent` only (never `innerHTML`), clamps the bar with `Math.min` while the text keeps the true count, and runs before the row fetch so the bar advances even if the row partial 404s. Terminal handlers leave the final count in place. Native `<progress>` styled from PAS tokens (`pas.css` section 9b).
- Counts are computed server-side by design: there is no jsdom harness for `regression-live.eta`'s inline script, so server-side counts are testable through SSE frames while client-side counting would not be.

**`a37462d` — 17 pre-existing regression-package test failures fixed**

`cd regression && pnpm test` had 17 failures, all pre-existing. The package is not in the root `vitest.config.ts` `projects` list (REQ-REG-001), so nothing was watching.

- *Group 1 — 13 receipt failures, a wall-clock time bomb.* `parseReceiptFromPhoto` refuses receipt dates older than `MAX_RECEIPT_AGE_DAYS` (90), overwriting `date` with today and preserving the model's extraction in `rawExtractedDate`. `buildExpectation` asserted the sidecar date verbatim on `date`, so every date-bearing receipt case went red exactly 90 days after the receipt was issued — `receipt-costco-long` (2026-04-27) crossed that line on 2026-07-26 and `receipt-trader-joes-correction` on 2026-08-10. Photo fixtures carry an immutable real-world date, so this was never going to resolve itself, and it hits real `pnpm test:regression` runs against a *perfect* model, not only the mocked tests. `buildExpectation` now models the parser's rejection branch: outside the acceptance window it pins `date` to today and asserts the ground-truth date on `rawExtractedDate`. Assertion strength preserved, not relaxed — verified by mutation, with four clock-frozen tests covering both branches (before, which branch ran depended on how long ago the date literals happened to be authored).
- *Group 2 — 4 chatbot-environment failures.* `loadSystemConfig` validates the environment with envalid, which calls `process.exit(1)` on a missing required var, killing the vitest worker. The repo ships only `.env.example` (`.env` is gitignored), so these passed solely on the maintainer's primary checkout and died in any worktree, fresh clone, or CI. The test now stubs the two required vars plus one provider key (`buildLLMConfig` refuses a config with no usable provider); dotenv does not override already-set vars, so the stubs win where a real `.env` exists, and the values are inert.
- Deliberately left alone: the fixture sidecar dates (real receipts, immutable), and the root vitest `projects` array — REQ-REG-001 mandates the exclusion, so changing it needs a URS amendment (recorded as a proposal in `docs/open-items.md`).

**`e90e8f0` — rubric judge truncation diagnosed as truncation**

- `JUDGE_MAX_TOKENS` 400 → 1024. The old comment claimed frontier judges reply in ~100 tokens; the live run disproved it, so the comment now records the evidence. 1024 matches the provider-default `max_tokens` in core and costs nothing when the judge stops at its own EOS.
- The oracle calls `completeWithMeta` and, on `finishReason === 'length'`, returns an error verdict naming the cap and showing the raw prefix. Checked **before** parsing: a cap-truncated reply is untrusted even if its prefix happens to parse. Genuinely malformed complete output still falls through to the generic parse-failure verdict. `CallMeter` accounting in the `finally` is unchanged, so spend on throws is still captured.
- `RubricJudgeLLM` (`complete` + `completeWithMeta`) replaces the `Pick<LLMService, 'complete'>` narrow at every judge construction site: rubric deps, `ChatbotRunnerDeps`, `RunSuiteOptions.judgeLlm`, and the orchestrator test casts. `StubLLMService` gains `completeWithMeta` (delegating to `this.complete` so cost-simulating test wrappers keep working) and an optional `finishReason` on `queue()`.

**`9b15027` — food shadow classifier truncation diagnosed as truncation (third instance)**

- `FoodShadowClassifierLLM` (`complete` + `completeWithMeta`) replaces the full `LLMService` in the classifier options — the same widening `RubricJudgeLLM` did for the judge — and `callLLM` goes through `completeWithMeta` so `finishReason` is visible.
- New `interpret()` maps one completion to a `ShadowResult`. It parses first (a reply satisfying the schema is complete by construction), and only on a parse failure does `finishReason === 'length'` decide *which* failure to report: `{kind: 'llm-error', category: 'truncated-output', message}` naming the cap and echoing a `JSON.stringify`-escaped raw prefix (one log line), plus a `logger.warn`. That reuses the `llm-error.message` channel `9f9f2fb` added, which `dispatch.ts` already surfaces in the `MeteredError` — no new `ShadowResult` variant.
- `SHADOW_MAX_TOKENS` stays 80 and now records why: the good path is 15–24 tokens on both models in use, so a reply needing 369+ characters is misbehaviour to report, not to fund.
- Retry-on-empty is untouched. The truncation branch fires only for non-empty output, so an empty reply still takes its one repair retry (and a retry that itself comes back truncated is reported as truncation). Truncation is terminal: the same prompt against the same cap cuts the same way. Production callers keep failing open — `dispatchShadow` falls through for every non-`ok` kind and `computeVerdict` already maps `llm-error` to `error`.

---

### Verification — real `pnpm test:regression` runs

| Run | Result |
|-----|--------|
| `--bucket=routing --model-matrix=fast=ollama/qwen3.8:27b-mlx` | 37 cases, 34 pass / 3 fail / **0 error**, routing accuracy **98.11%**, REQ-REG-011 gate PASSED, $0.00, 697s |
| `--bucket=routing --model-matrix=fast=ollama/muse-glimmer:30b-mlx` | 37 cases, 22 pass / 14 fail / 1 error, routing accuracy **79.25%**, gate FAILED on genuine accuracy, $0.00, 610s. The single error was the truncation later fixed in `9b15027`. |
| `--bucket=chatbot --judge-model=anthropic/claude-opus-5` (before `e90e8f0`) | 10 cases, 3 pass / 6 fail / 1 error (judge truncation), $0.307 |
| same, after `e90e8f0` | 10 cases, 3 pass / 7 fail / **0 error**, $0.305 |

Before the fixes the same suite was **0 pass / 26 error**. `muse-glimmer:30b-mlx` failing the accuracy gate is a legitimate model-quality finding, not a defect — preserving that distinction is the point of the phase.

**Tests / lint:** root `pnpm test` — 575 test files, 12547 passed, 3 skipped, 1 todo, zero failures. `regression/` — 665 passed (was 17 failing). `pnpm lint` — zero errors.

**URS:** 8 new entries — REQ-LLM-037 (temperature capability registry + self-heal), REQ-LLM-038 (deterministic rejections not retried), REQ-LLM-039 (Ollama thinking off by default + loud empty-output error), REQ-LLM-040 (truncation reported as truncation), REQ-REG-019 (no infrastructure `error` verdicts), REQ-REG-020 (receipt date-acceptance window in expectations), REQ-REG-GUI-V2-027 (server-computed live progress), REQ-REG-GUI-V2-028 (`activeRunId` threading) — plus a **Fixes** annotation on REQ-REG-001 recording the 17-failure test rot and why the vitest exclusion was left in place.

**Doc footprint:** `docs/urs.md` (8 entries + REQ-REG-001 Fixes + 8 traceability rows + Totals recount), this section, one CLAUDE.md Implementation Status bullet, and nine `docs/open-items.md` entries (5-series `MODEL_PRICING` gap, dead built-in Anthropic default, unprobed Google/OpenAI temperature support, the two unfixed truncation-misdiagnosis call sites, `pas-classifier`'s 10-token budget vs larger local models, the regression-vitest-exclusion proposal, date-bearing fixture shelf life, the missing jsdom harness for `regression-live.eta`, and the run-tab submit button that ignores `activeRunId`).

---

## Truncation Diagnosis + Local-Model Cost Correctness (2026-09-02)

**Goal:** Close the defect class the 2026-09-01 phase opened rather than keep fixing it one site at a time, then answer the two questions that investigation raised but did not settle: *is the Ollama thinking fix actually systemic?* and *why does an all-local regression run quote a dollar figure when local models are free?*

**Outcome:** four commits, `ddb0c3c` → this one. One shared classification helper with ten sites migrated onto it; the empty-output guard extended to the other local-serving provider path; three cost estimators taught that a local model costs $0; and the two model-id validators aligned so a model you can benchmark is a model you can assign.

---

### The defect class, closed

The 2026-09-01 phase named it: **a fixed `maxTokens` budget feeding a structured-output parse, where truncation is reported as malformed output.** It found four instances and fixed them individually (`9f9f2fb` Ollama empty output, `e90e8f0` rubric judge, `9b15027` food shadow classifier, plus the judge's raised budget), and deferred two more to `docs/open-items.md`. Fixing the fifth the same way would have been the fourth time the same reasoning was re-derived.

`ddb0c3c` extracts the reasoning once. `classifyStructuredOutput` lives in `core/src/utils/json-strip-fences.ts` — the file whose header already claimed to be the canonical home for local-model quirks — takes `{text, finishReason}` plus the cap, and returns `ok | truncated | empty | unparseable`. It **classifies only**; each call site keeps its own policy, because their result types and retry semantics all genuinely differ. `formatRawPreview` standardises the diagnostic on `9b15027`'s `JSON.stringify(raw.slice(0, 200))` form, so a multi-line reply cannot break a log line, a `MeteredError` message, or a regression verdict detail.

**The design point worth remembering: the parse/length ordering is a required caller option with no default.** The two originally-fixed sites deliberately disagree, and both are right:

| Site | Order | Why |
|---|---|---|
| Rubric judge (`regression/src/oracles/rubric.ts`) | `check-length-first` | A cap-truncated reply is untrusted even when its prefix parses — the cut lands inside `explanation`, so the grade is real but the reasoning behind it is amputated. |
| Food shadow classifier (`apps/food/src/routing/shadow-classifier.ts`) | `parse-first` | The schema is closed by construction; a reply that satisfies it is complete, and refusing it would throw away a usable classification. |

A helper that quietly picked one would have regressed the other. `message-segmenter` is the sharpest illustration of why `check-length-first` exists at all: its payload is an **array**, so a reply cut between elements still parses into a *shorter valid* `segments` list — a silent, confident drop of the user's last request. `empty` is decided before either branch, so the retry-on-empty policies in `recall-classifier`, the shadow classifier and `weakness-summarizer` keep firing untouched.

Ten sites migrated, each widening its narrow LLM interface to require `completeWithMeta` and each pinning its existing policy in tests: `recall-classifier` (parse-first, 150), `message-segmenter` (check-length-first, 400), `title-generator` (60), `session-summarizer` (400 against a prompt asking for ~1200 characters), `session-control-classifier` (80 — `reason: 'truncated'` replaces the misleading `'parse error'`), `data-query` file selection (50 — the returned ids are deliberately unchanged, because the prose fallback turns `[0, 3, ` into a plausible but *short* file list), `route-verifier` (no cap of ours; fail-open behaviour byte-identical, only the log line is honest now), `weakness-summarizer` (1500; its persisted `errorMessage` is GUI-visible), plus `rubric.ts` and `shadow-classifier.ts` moving onto the helper with no behaviour change beyond the standardised preview.

**A test-infrastructure hazard surfaced on the way.** Several stubs hand a `complete`-only object over with `as unknown as`, so a missing `completeWithMeta` fails at *runtime*, not compile time — and in `classifySessionControl` the resulting `TypeError` was swallowed by the surrounding `try/catch` and returned the safe default, which is how `regression/src/__tests__/dispatch.test.ts` silently asserted the wrong intent and still went green. `core/src/testing/llm-meta-stub.ts#withCompleteWithMeta` now delegates to the same `complete` mock so existing call-count and prompt assertions stay meaningful, and `createMockCoreServices` delegates too. The root cause — **no tsconfig in this repo typechecks test files**, so a throwaway typecheck during this commit surfaced ~1628 pre-existing test type errors — is recorded in `docs/open-items.md` and needs an owner.

---

### Was the thinking fix systemic? Partly.

The `think` flag itself is **fully systemic**. `9f9f2fb` sends `think: options?.thinking === true` unconditionally and consults no model table, so a brand-new thinking-capable model pulled tomorrow is protected on its first call, forever, with no per-model work. Nothing to extend.

The *empty-output guard* was **not** systemic across local serving. `OpenAICompatibleProvider` — and `LlamaCppProvider`, which inherits it — had neither the thinking suppression nor the guard, and ignored `reasoning_content`, the non-standard field LM Studio, vLLM, SGLang and llama-server all use to carry a reasoning model's chain of thought. `content ?? ''` turned a budget-exhausted reasoning model into a silent empty string, indistinguishable from a model with nothing to say.

The sharp edge: `docs/open-items.md` item **L4 recommends moving the fast tier onto the llama.cpp provider**. Doing that before `1fcc3e1` would have silently reintroduced the exact bug the 2026-09-01 phase had just spent a day diagnosing.

`1fcc3e1` closes it:

- `message.reasoning_content` is read through a narrow cast, the way `OllamaProvider` reads `done_reason`. It is used **only as evidence in the diagnostic** and never substituted for the answer — reasoning text is prose, and returning it would feed narration to every `responseFormat: 'json'` caller, a quieter failure than the `''` it replaced.
- Empty text at `finishReason === 'length'` throws `LLMEmptyOutputError` naming provider, model, the cap actually sent on the wire, and the reasoning-block length. `isEmptyOutputError()` already classifies it non-retryable, so no new plumbing.
- Empty text at `'stop'` still returns `''` unchanged — callers' retry-on-empty logic depends on it — and a reasoning block on that path logs a warning so it is not silent to the operator.
- The 1024 provider default cap is hoisted so the diagnostic names the real value.
- `LlamaCppProvider` needs no changes and is covered by tests that fail if anyone re-implements `doComplete` on the subclass.

Known gap, recorded in `docs/open-items.md`: the read covers only `reasoning_content` on the non-streaming path. Some servers use `message.reasoning`, or nest it under `delta` when streaming. Unverified against a live server.

---

### Local models are free — everywhere the operator can see a number

The requirement is the operator's, not the code's: **local models run on the operator's own hardware and are always free, so a new Ollama model must never need a pricing entry.** Recorded spend already honoured it — `CostTracker.record` passes `providerType` and `estimateCallCost` short-circuits a local provider to $0.

Three *estimators* did not, because they dropped `providerType` on the way in. **Model id alone is never enough:** a local model such as `qwen3.8:27b-mlx` has no `MODEL_PRICING` entry, so it falls through to `DEFAULT_REMOTE_PRICING` at $3/$15 per Mtok and gets quoted at frontier rates. `f4a8767` fixes all three plus two narrower gaps:

**(a) Regression pre-flight estimator.** `build-deps` priced every call as `modelIds.fast` with no provider — so it was wrong twice over: free models priced as paid, *and* every bucket priced against the fast tier regardless of which tier actually ran it. `resolveTierRefs` now returns the full `ModelRef` per tier, `buildTierPricingRefs` pairs each with its `providerType` from the same `ProviderRegistry` the LLM service dispatches through, and `makeTierAwareEstimator` prices a call on the tier it will really run on. `BUCKET_ESTIMATE` gives each bucket its own token count *and* tier (routing/recall → fast, receipt/chatbot → standard). `TierModelSnapshot` and its `cache-key.ts` serialization are deliberately untouched, so **no cached result is invalidated** — provider info rides alongside the snapshot, not inside it.

**(b) Receipt runner projected cost.** `estimateUsd({tokenIn: 0, tokenOut: 0})` is structurally `$0` for every model. That zero was recorded as the case's cost *and* added to accumulated run spend, so **the run-budget ceiling could not stop a receipt sweep** — the one bucket sending multi-thousand-token vision payloads was the one bucket reporting nothing. The runner now meters a real `getMonthlyTotalCost()` delta like every other runner, and gates the pre-charge check on a realistic `RECEIPT_ESTIMATE_TOKENS` projection.

**(c) GUI confirm dialog.** `estimateRunCostUsd` took only `{caseId, bucket}` — flat per-bucket constants — so an all-Ollama matrix displayed the same figure as an all-Opus one: ~$0.19 for a 37-case routing run that costs nothing. It now takes `localTiers`, charges $0 for a bucket whose tier is local, and returns `allLocal` so the Run-tab banner and confirm dialog say "all-local run" instead of a bare $0.00 that reads like a bug. Remote constants are unchanged — numeric recalibration stays a separate open item.

**(d) Two narrower gaps.** `estimateGuardCost` no longer invents a `defaultReservationUsd` charge for an unresolvable tier when every configured provider is local (and says why when it does fall back); `SystemInfoService.getModelPricing` takes an optional provider id and returns `null` for a local one, so a GGUF served under the id `gpt-4o` no longer shows remote admin pricing.

---

### Two model-id patterns, two answers (this commit)

`MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/` at `core/src/gui/routes/llm-usage.ts` and `core/src/services/system-info/index.ts` excluded `/`. The regression path's `MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/` (`core/src/services/regression/model-spec.ts`) allowed it and explicitly documented namespaced ids. So an Ollama model pulled from HuggingFace (`hf.co/bartowski/Foo-GGUF:Q4_K_M`) could be regression-tested but could **not** be assigned to a tier via `POST /gui/llm/tiers` or the chatbot's `<switch-model>` path.

Aligned on the permissive form, in one place: `core/src/utils/model-id.ts` exports `MODEL_ID_PATTERN` / `MAX_MODEL_ID_CHARS` / `isValidModelId`, and all three surfaces import it (`model-spec.ts` keeps its own richer error messages and aliases the shared pattern as `MODEL_RE`).

These are input validators on operator-supplied strings — and, via `<switch-model>`, on LLM-supplied ones — so the widening was audited rather than assumed:

- Anchors and a length bound are kept (192 chars, up from 100).
- The first character must now be alphanumeric. That is a **tightening**: the old GUI pattern permitted a leading `-`, `.`, `_` or `:`.
- Because `/` is meaningful only as a namespace separator, the shapes it enables are rejected separately — `..`, `//`, and a trailing `/` — the same three guards `model-spec.ts` already carried outside its regex.

Downstream-consumer audit, the part that decided whether widening was safe at all:

| Consumer | Handling of `/` |
|---|---|
| Model journal (`data/model-journal/<slug>.md`) — the only filesystem use | `slugifyModelId()` maps `[^a-z0-9-]` → `-`, then `MODEL_SLUG_PATTERN` re-validates. `/` cannot reach a path segment. |
| `ModelSelector.save()` | Writes the id as a YAML **value** in `data/system/model-selection.yaml`, not as a key path. |
| GUI available-models table | `escapeHtml()` on the id, and the `hx-vals` JSON is itself escaped. `/` is not HTML-special. |
| `CostTracker` usage log | The markdown row strips `\|`, `\r` and `\n` before writing. |
| Regression CLI | `spawnRegressionCli` uses `nodeSpawn(process.execPath, [...args])` — argv array, no shell. |
| Providers | The id is a request-body field handed to the vendor SDK. |

No consumer requires `/` to be excluded, so nothing was widened past what it can hold.

---

### Verification

**Automated (this worktree, 2026-09-02):**

| Suite | Result |
|---|---|
| root `pnpm test` | 576 test files, **12678 passed**, 3 skipped, 1 todo, **zero failures** |
| `regression/` `pnpm test` | 40 test files, **676 passed**, zero failures |
| `pnpm lint` | **zero errors** (warnings unchanged from the baseline) |

**Live `pnpm test:regression` runs:** _placeholder — the operator was running these live while this section was written and the figures had not arrived. Fill in the run table here (bucket, model matrix, pass/fail/error counts, reported cost, wall time) before treating this section as complete. The specific claim to check is the cost line: an all-local matrix must report **$0.00** at the pre-flight estimate, in the GUI confirm dialog, and in the final report — the three places that disagreed before `f4a8767`._

**URS:** 6 new entries — REQ-LLM-041 (one shared truncation classifier, ordering an explicit caller choice), REQ-LLM-042 (OpenAI-compatible/llama.cpp empty-output guard + `reasoning_content` never substituted), REQ-LLM-043 (local-provider models estimate $0 in every estimator), REQ-REG-021 (estimates price the tier that actually serves the bucket), REQ-REG-022 (receipt bucket meters real cost so the run-budget ceiling binds), REQ-SEC-013 (model-id validation accepts namespaced ids consistently across GUI, system-info and the regression path) — plus **Fixes** annotations on REQ-LLM-039 (the systemic-coverage assessment), REQ-LLM-040 (superseded by the shared helper) and REQ-SEC-010 (the widened pattern and its audit).

**Doc footprint:** `docs/urs.md` (6 entries + 3 Fixes annotations + 7 traceability rows + Totals recount), this section, one CLAUDE.md Implementation Status bullet, and `docs/open-items.md` — three items closed (the two 2026-09-01 truncation-misdiagnosis call sites, and the "Regression GUI v2 — model-aware estimator" accepted risk) and six added (the `apps/food` `parseJsonResponse` cluster, the pseudo-tool-XML truncation family in `handle-message`/`handle-ask`, test files excluded from every tsconfig, `max_tokens` vs `max_completion_tokens` for OpenAI reasoning models, the narrow `reasoning_content` field coverage, and the missing `num_ctx`).

---

# Planned Phases — Pre-Open-Source Audit Remediation (2026-07-06)

> **Status: PLANNED, not yet implemented.** These are forward-looking phase definitions, not completed-work records like the sections above. They are derived from the nine-pass audit in `docs/superpowers/plans/2026-06-11-ux-review-findings-and-fix-plan.md`; every finding cited below was confirmed against code (passes 4–9 during the 2026-07-06 audit sessions; the anchor findings of passes 1–3 re-verified 2026-07-06). Per-item actionables live in `docs/open-items.md`.
>
> **Before implementing any phase here:** invoke `superpowers:writing-plans` to produce the detailed task-by-task plan under `docs/superpowers/plans/`, route it through Codex review, then execute subagent-driven per `feedback_always_subagent_execution`. Each phase's **Doc footprint** lists the URS / open-items / CLAUDE.md updates that are part of its definition of done.
>
> **Ordering:** these phases are Track A of the **Master Execution Order** at the top of `docs/open-items.md` "Phase Sequence" — consult it before choosing which phase to start; it carries the cross-track hard gates (e.g. PP-1..PP-3 before the repo goes public).

The audit surfaced ~45 confirmed findings across six areas. They group into seven planned phases plus the already-queued **UX Hardening Phase** (below). Ordering reflects the audit's cross-cutting priority: the highest-leverage items across the whole series are **INST-1** (fresh-install boot crash), **SEC-1** (PII scrub + history decision), **DEP-1/DEP-2** (dependency refresh + CI), and **BKP-1** (enable backups) — distributed across PP-1, PP-2, PP-3, and PP-5.

**Publication gating:** PP-1, PP-2, and PP-3 should complete **before the repo goes public** (SEC-1's history decision is irreversible once published). PP-4 through PP-7 and the UX Hardening Phase can land before or after launch.

---

## PP-1 — Fresh-Install Correctness (INST-1..INST-8)

**Goal:** A clean `git clone` follows the README Quick Start and DEPLOYMENT.md and reaches a working first Telegram message, on every supported run mode (dev, Docker, native), without hitting a crash or a doc dead-end.

**Findings closed** (Fifth-Pass Review, plus SEC-5 from the Fourth-Pass): INST-1 fresh-install boot crash (reproduced); INST-2 non-existent native entrypoint + missing GUI-asset copy in `pnpm build`; INST-3 webhook URL missing `/webhook/telegram` path; INST-4 Docker+Cloudflare path consumes a dead env var; INST-5 compose hard-couples Ollama + ships it empty; INST-6 wrong GUI URL; INST-7 pnpm-version + `GUI_AUTH_TOKEN` doc drift; INST-8 Windows `prepare`-hook fragility; SEC-5 the documented Cloudflare tunnel routes the whole service (GUI + API) to the internet as a side effect of webhook setup.

**Scope / batches:**
1. *The bug (code + test, do first):* fix the fresh-install branch of `core/src/services/household/migration.ts:194-202` to perform the same bootstrap as the migration path — create `data/system/households.yaml` with the `default` household (admins from config) and rewrite `pas.yaml` to add `household_id: default` to each user — then add `household_id: default` to `config/pas.yaml.example` and the DEPLOYMENT.md minimal config. Add a first-boot integration test that boots `composeRuntime` from `pas.yaml.example` + an empty data dir (the test that would have caught INST-1).
2. *Native build (code):* add a GUI-asset copy step to the `@pas/core` build so `gui/views`, `gui/public`, and the schema JSON land in `core/dist` (today only the Dockerfile hand-copies them), or explicitly declare native-production unsupported and make launchd wrap `pnpm dev`.
3. *Docs batch (DEPLOYMENT.md + OPERATIONS.md, pairs with SEC-5 and RES-7/BKP-2):* correct the entrypoint references to `node core/dist/bootstrap.js` (+ stale `personal-assistant` plist path), the webhook URL, the GUI URL, and the pnpm-version / `GUI_AUTH_TOKEN` framing.
4. *Docker + tunnel (pairs with BKP-6):* profile-gate the `ollama` service, drop the unconditional `OLLAMA_URL` override, add a model-pull step, and either add a `cloudflared` service that consumes `CLOUDFLARE_TUNNEL_TOKEN` or rewrite the README tunnel section to the `cloudflared tunnel run` flow and delete the dead env var from `.env.example` + config schema. Also fix SEC-5: document a path-scoped tunnel ingress (route only `/webhook/*` by default; keep GUI/API LAN-only) as the default, with full-service exposure as an explicit opt-in paired with a Cloudflare Access recommendation in front of `/gui`.
5. *Minor:* guard `prepare` so `pnpm install` doesn't fail on Windows without bash.

**Sequencing:** Batch 1 first — it is the single most important pre-publication fix (every evaluator hits it). A true clean-VM run (fresh user account, no author dotfiles) is a worthwhile one-hour follow-up after batches 1–3, since the audit traced code, not machine state.

**Doc footprint:** URS entries for the migration-bootstrap fix (REQ-CONFIG / REQ-HOUSEHOLD family) + traceability matrix; DEPLOYMENT.md, OPERATIONS.md, README, `.env.example`, `pas.yaml.example` edits; close the INST-1..8 entry in `docs/open-items.md`; one-line CLAUDE.md status bullet on completion.

---

## PP-2 — Repo Publication Gate (SEC-1, SEC-2, DOC-2, + CI)

**Goal:** Make the repository legally and hygienically safe to publish — no operator PII at HEAD or (per the chosen strategy) in history, a secret-scanning gate that blocks the next accidental token, open-source table-stakes files, and a CI that runs the quality gates a fork/PR contributor won't have locally.

**Findings closed:** SEC-1 operator PII in tracked files + history (Fourth-Pass); SEC-2 no secret-scanning gate; DOC-2 no LICENSE / CONTRIBUTING.md / SECURITY.md (Third-Pass Part A); DEP-2 no CI (Ninth-Pass — the workflow file is created here because the secret-scan job rides in it).

**Scope / batches:**
1. *Tree scrub (do regardless of history decision):* replace the operator's real Telegram ID (`8187111554`) with a fixture ID in the 4 tests + 4 spec/plan docs identified in SEC-1; sweep `docs/superpowers/` for real household/family specifics.
2. *History decision (operator, blocking, irreversible):* choose fresh-history public repo (recommended), `git filter-repo`, or accept-ID-in-history — see SEC-1's analysis. This is the one gate that cannot be undone after publication.
3. *Secret-scan gate (code):* add gitleaks (or equivalent) to the existing `.claude/hooks/` pre-push chain and as a CI job.
4. *Table-stakes files:* LICENSE (upstream influences are all Apache-2.0/MIT — no copyleft constraint), CONTRIBUTING.md (distilling the build/test/lint + URS + zero-failing-tests + Biome-zero-errors workflow that currently lives only in CLAUDE.md/skills), SECURITY.md (in-process app trust model + a vulnerability-reporting contact).
5. *CI workflow:* one GitHub Actions workflow — frozen-lockfile install, build, lint, `vitest run`, `pnpm audit --prod --audit-level=high` (soft gate), plus the gitleaks job from batch 3.

**Sequencing:** Batches 1, 3, 4, 5 are independent and can proceed now; batch 2 is the publication-blocking operator decision. This phase and PP-3 together clear the path to a public repo.

**Doc footprint:** LICENSE / CONTRIBUTING.md / SECURITY.md at repo root; `.github/workflows/` CI file; close the SEC-1/SEC-2 and DOC-2 open-items entries; CLAUDE.md status bullet; if fresh-history is chosen, a note in DEPLOYMENT.md/README about where full history lives.

---

## PP-3 — Dependency & Supply-Chain Refresh (DEP-1, DEP-3..DEP-5)

**Goal:** Clear the accumulated advisory backlog with in-range updates, then add the automation that prevents it from silently re-accumulating after publication.

**Findings closed** (Ninth-Pass Review): DEP-1 35 known vulns (2 critical / 13 high / 19 moderate / 1 low) mostly fixable in-range; DEP-3 no `minimumReleaseAge`, no Renovate/Dependabot; DEP-4 major-version backlog; DEP-5 dev/prod boundary blurred by tsx-as-runtime (resolves when PP-1 batch 2 lands). (DEP-2 CI is delivered in PP-2.)

**Scope / batches:**
1. *In-range sweep (code):* `pnpm update -r`; separately bump `@google/genai` to 2.x (or add a `pnpm.overrides` pin) to clear the protobufjs critical; run the full suite + `pnpm build`; confirm `pnpm audit` is clean. This clears the fastify body-validation-bypass (high, on the HTTP server), both `@fastify/static` GUI-surface moderates, the `fast-uri`/`ws`/`yaml` issues, and the vitest critical.
2. *Fresh-package protection:* set pnpm `minimumReleaseAge` (4–7 days) in `pnpm-workspace.yaml`.
3. *Update automation:* add a Renovate (or Dependabot) config — grouped weekly PRs, majors separated — validated by the PP-2 CI.
4. *Majors ledger (scheduled, not urgent):* record the major backlog (the Ninth-Pass table is the ledger); schedule `@anthropic-ai/sdk` 0.78→0.110 and `@google/genai` 1→2 first (SDK is 32 minors behind — model IDs/pricing/features accrue there), then `zod` 4 / `better-sqlite3` 12 / `@fastify/view` 12 / `emittery` 2 and the dev toolchain (`vitest` 4, Biome 2, TypeScript 6) as standalone sessions.

**Sequencing:** Batch 1 pre-publication (de-risks the README the moment it's public); batches 2–3 same week; batch 4 scheduled post-launch. Requires PP-2's CI for batch 3 to be meaningful.

**Doc footprint:** lockfile + manifest changes; `pnpm-workspace.yaml`; Renovate config; close the DEP-1..5 open-items entry; CLAUDE.md status bullet; the majors ledger stays in open-items as an ongoing tracker.

---

## PP-4 — Privacy & Trust Transparency (PRIV-1..4, SEC-3, SEC-4)

**Goal:** Make the "local-first" claim honest and legible — a written data-flow statement, an install-time trust warning that matches the real (unsandboxed) app model, and cleanup of config surfaces that imply flows which don't exist.

**Findings closed:** PRIV-1 no user-facing data-flow statement; PRIV-2 tier auto-assignment silently changes which vendor receives conversation text; PRIV-3 data files can carry secrets into prompts (code half = the existing secret-redaction proposal); PRIV-4 three config-template integrations with zero consuming code (Sixth-Pass); SEC-3 install permission summary implies enforcement that doesn't exist; SEC-4 static-analyzer expectation calibration (Fourth-Pass).

**Scope / batches:**
1. *Data-flow statement (docs):* publish `docs/PRIVACY.md` from the verified data-flow map in the Sixth-Pass Review (Telegram always; cloud LLM provider when configured — including that anything stored can be recalled into prompts; the alert `webhook` action's up-to-1MB raw-file flow; the fully-local recipe; Telegram as the one unavoidable cloud dependency). Link it from the README local-first pitch. Fold in PRIV-2's provider-terms explanation.
2. *Template cleanup (code):* remove or mark "reserved — not yet implemented" the `GOOGLE_CALENDAR_*` / `OPENWEATHERMAP_API_KEY` / `food.usda_fdc_api_key` entries in `.env.example` / `pas.yaml.example` (and drop the USDA mention from CLAUDE.md if removed).
3. *Install trust warning (code):* add a plain-language warning to the `pnpm install-app` confirm step (`core/src/cli/install-app.ts`) — apps run with the same access as PAS itself (bot token, API keys, all household data); the declared-services list is not a sandbox — and mirror it in the README/CREATING_AN_APP install sections.
4. *Optional (code, cheap):* log the resolved tier→provider map at startup (PRIV-2) so a config change that reroutes conversation data is visible in the boot log. Move the container-isolation open-items trigger earlier per SEC-4 (before `install-app` is publicized) — a documentation/tracking change, not code.

**Sequencing:** Batches 1–2 are one docs+cleanup session. Batch 3 pairs naturally with PP-6 (app-developer ecosystem). PRIV-3's code half stays as the separate secret-redaction proposal in open-items.

**Doc footprint:** `docs/PRIVACY.md`; README + CREATING_AN_APP edits; `.env.example` / `pas.yaml.example` / CLAUDE.md template cleanup; URS entry for the install-warning + startup-log changes; close PRIV-1..4 / SEC-3 open-items entries; re-scope the SEC-4 container-isolation trigger in open-items.

---

## PP-5 — Data Lifecycle: Backup, Restore & Retention (BKP-1..6, RES-1..7)

**Goal:** Ensure the system's data survives a failure and doesn't rot over years of continuous operation — backups actually enabled and restorable, and the append-forever stores rotated so read-cost and backup-size stay bounded.

**Findings closed:** BKP-1 backups off in production; BKP-2 restore doc incomplete; BKP-3 `chat-index-rebuild` `--data`/`--db` footgun; BKP-4 WAL/GNU-tar consistency + backup-job auto-disable; BKP-5 no guard against `backup.path` inside `dataDir`; BKP-6 busybox-tar unverified (Seventh-Pass); RES-1 unrotated production `pas.log` inside backup scope; RES-2/RES-5 `llm-usage.md` + `change-log.jsonl` append-forever and read whole; RES-3 report/alert history one-file-per-run; RES-4 telemetry logs no rotation; RES-6 regression cache never evicts; RES-7 retention posture undocumented (Eighth-Pass).

**Scope / batches:**
1. *Enable + document (operator + docs, do first):* add the `backup:` block to the live `config/pas.yaml` (BKP-1; consider default-on for the OSS release); complete the OPERATIONS.md restore procedure — correct filename pattern, staging mkdir, a "what's NOT in the archive" list (`.env`, codebase, third-party apps in `apps/`), the post-restore `pnpm chat-index-rebuild` step, and the vault-symlink self-heal note (BKP-2); add the "Data growth & retention" section from the Eighth-Pass inventory table (RES-7). Pairs with the PP-1 batch-3 docs session.
2. *Log rotation (code, highest RES leverage):* rotate `data/system/logs/pas.log` (e.g. `pino-roll`, size/date + keep-count) or move logs out of `data/` — it's the wildcard growth store and it poisons every backup (RES-1).
3. *Append-forever rotation (code, one pattern):* monthly rotation for `llm-usage.md` (RES-2) and `change-log.jsonl` (RES-5) via the model-journal `YYYY-MM` pattern; a shared size-triggered rotate-to-archive helper for the three telemetry logs (RES-4).
4. *Robustness (code):* derive `chat-index-rebuild`'s `--db` default from `--data` or warn on mismatched roots (BKP-3); exempt `system-backup` from the job-failure auto-disable + document the WAL/tar consistency assumptions (BKP-4); reject/warn when `backup.path` resolves inside `dataDir` (BKP-5).
5. *Post-launch / verify-once:* report/alert history keep-last-N + optional monthly digest (RES-3); regression-cache age sweep or GUI clear button (RES-6); busybox-tar multi-`-C` verification in the Alpine container, folded into PP-1 batch 4 (BKP-6).

**Sequencing:** Batch 1 now (BKP-1 is four lines of YAML and the restore claim is currently untested). Batches 2–4 are one small pre-open-source code batch. Batch 5 is post-launch. Re-measure the Eighth-Pass inventory table after a year of multi-user operation.

**Doc footprint:** `config/pas.yaml` (live); OPERATIONS.md restore + retention sections; URS entries for the rotation + rebuild-flag + backup-path-guard changes; close BKP-1..6 and RES-1..7 open-items entries; CLAUDE.md status bullet.

---

## PP-6 — App-Developer Ecosystem Readiness (DOC-1, DOC-3, DOC-5..10)

**Goal:** Make the third-party app path — the one that matters for an infrastructure-first open-source pitch — actually work end-to-end, and keep the developer docs from drifting.

**Findings closed** (Third-Pass Part A): DOC-1 `@pas/core` unpublished so the standalone path's first step is impossible; DOC-3 install loop untested + CLI/docs misstate it; DOC-5 `user_config.category` enum hard-codes app names; DOC-6 no out-of-tree example app; DOC-7 no doc-drift guard; DOC-8 `splitTelegramMessage` not exported; DOC-9 `subscribes[].handler` documented two ways; DOC-10 README doesn't route the app-developer audience. (DOC-2 is in PP-2; DOC-4 `/notes` stale example folds in here as a trivial fix.)

**Scope / batches:**
1. *Publish decision (operator + docs):* DOC-1 — either publish `@pas/core` to npm/GitHub Packages with a committed `exports` contract, or declare fork-and-clone the only supported path and rewrite the "Standalone app repo" section accordingly.
2. *Install loop (code + test):* fix the two misleading CLI lines in `install-app.ts`; document the real post-install contract (`pnpm install && pnpm build`, restart; decide + state the `dist/` commit-vs-build convention) in "Sharing Your App"; add the end-to-end install smoke test (scaffold → install into a scratch checkout → build → boot → assert a routed message).
3. *Doc fixes (docs):* DOC-4 `/notes`→`/listnotes` in `MANIFEST_REFERENCE.md` + `CREATING_AN_APP.md`; DOC-8 export `splitTelegramMessage` (e.g. `@pas/core/utils/telegram-format`) and replace the hand-rolled snippet; DOC-9 pick the file-path `handler` convention and align examples; DOC-10 add an above-the-fold app-developer pointer to the README.
4. *Schema loosening (code, cheaper before external manifests exist):* DOC-5 — replace the `user_config.category` enum with a pattern-validated string (or auto-namespace by appId), GUI grouping unknown categories under the app display name.
5. *Drift guards (code, mirrors the W1 doc-coverage gate):* DOC-6 create an out-of-tree `pas-example-app` (echo-scope: one command, one intent, one data write, one test) that doubles as the install-smoke fixture; DOC-7 add gates asserting the fenced minimal manifest validates against the JSON Schema, the service-ID table matches the schema enum, and scaffold output passes `build && test`.

**Sequencing:** DOC-4/DOC-9 are trivial and can land in any session now. DOC-1/DOC-5 need operator/design decisions before the phase is fully planned. The example app (batch 5) unblocks the smoke test (batch 2) and proves the whole path.

**Doc footprint:** `CREATING_AN_APP.md`, `MANIFEST_REFERENCE.md`, README edits; `core/package.json` exports; `app-manifest.schema.json`; new `pas-example-app` repo; URS entries for the export + schema + smoke-test changes; close DOC-1/DOC-3/DOC-5..10 open-items entries; CLAUDE.md status bullet.

---

## PP-7 — Latency & Local-LLM Serving (L1..L7)

**Goal:** Reduce response latency without trading away routing/answer quality — take the free wins now, and pursue the quality-gated ones only if regression evidence is green and the chatbot-primary T-track remains distant.

**Findings closed** (Third-Pass Part B): L1 no Ollama `keep_alive` (cold-reload after idle — the likely "sometimes slow"); L2 recall + PAS classifiers run sequentially though independent; L3 one global fast-tier knob for consumers with different accuracy needs; L4 local prefix-caching left on the table; L5 route verification is a cloud round-trip in the hot path; L6 perceived-latency levers (typing indicator = UX I2, streaming = Hermes P7) already specced; L7 the T-track collapses the classifier chain.

**Scope / batches:**
1. *Free wins (code, zero quality impact):* L1 — pass `keep_alive: -1`/long duration in the Ollama request options as a `pas.yaml` knob (verify first with `ollama ps` after 6 idle minutes); L2 — run `runRecallPipeline` and `classifyPASMessage` in `Promise.all` at `handle-message.ts:187-206` (confirm the serving layer executes them concurrently — pairs with batch 2).
2. *Serving (ops, zero quality impact):* L4 — serve the fast-tier model via the existing llama.cpp provider (persistent slots, prefix caching, `--parallel`) instead of Ollama; integration + install doc already exist. Makes L2's parallelism real.
3. *Perception (cross-ref):* L6 — prioritize the typing indicator (UX Hardening Batch 1 / I2) and pull streaming-via-edit-message (Hermes P7 carry-forward) forward to just after UX Hardening.
4. *Measurement-gated (only if T-track distant):* L5 — measure verification frequency (the verification logger already records it) and test whether the local model can verify its own grey zone at bucket parity; L3 — per-purpose model overrides for non-routing classifiers, each override citing a green regression run (overlaps the cascading-models proposal). Both L3 and L5 target components T6b deletes — pursue only with green evidence and a distant T-track.

**Sequencing:** Batches 1–2 now (free). Batch 3 rides UX Hardening. Batch 4 is explicitly gated on regression evidence and T-track distance per L7 — do not invest in components scheduled for deletion without both.

**Doc footprint:** `pas.yaml` knob docs; `INSTALL_LLAMA_CPP.md` cross-ref; URS entries for the `keep_alive` + parallelization changes; regression evidence links for any batch-4 override; close/annotate the L1/L2/L4 open-items entry; CLAUDE.md status bullet.

---

## UX Hardening Phase (already queued — passes 1–2)

The first two audit passes (C1–C2, I1–I10, M1–M7, B1–B3, O1–O3, D1–D2, N1–N2, S1) are **already a Confirmed Phase** in `docs/open-items.md` with full batch structure (Batches 1–3 by surface, plus proposed Batches 4–5 for onboarding and notification hygiene, plus design-first follow-ons for O2-layer-3 household unification, N1 quiet-hours/vacation, and D2 sessions GUI). Not re-specified here to avoid duplication. Cross-phase notes from the audit: `setMyCommands` (D1) folds into Batch 1 alongside the `sendChatAction` typing indicator (I2/L6); O2-layer-3 (food household ← platform household) should be sequenced before the chatbot-primary T5.food.* migration; L6 streaming should follow immediately after this phase.

---

# Planned Phases — Strategic Review & Agentic Autonomy (2026-07-07)

Confirmed by the operator on 2026-07-07 from two Fable strategic documents:
`docs/superpowers/plans/2026-07-07-fable-strategic-review.md` (SR-1..SR-4 — the gaps between
the current system and the open-source-infrastructure ambition) and
`docs/superpowers/plans/2026-07-07-agentic-harness-deep-dive.md` (AG — whether/how PAS gets a
light-harness agentic mode). Each phase below still needs a `superpowers:writing-plans` pass +
Codex review before implementation; the source docs carry the full analysis, issue IDs
(`ISO-*`, `CHA-*`, `PUB-*`, `EXT-*`, AG-1..AG-8), epistemic markers, and open questions.
**Already shipped from this set:** AG-1 — the graduated-autonomy doctrine is adopted and
recorded at `docs/agentic-autonomy-doctrine.md`, including the AG-8 standing decision (no
OpenClaw-style resident agent in core; three-condition revisit gate).

> **Ordering:** SR/AG phases slot into Tracks B and C of the **Master Execution Order** at
> the top of `docs/open-items.md` "Phase Sequence" — consult it before starting anything
> here. The binding gates: SR-1 design pass before T2a; AG-3 inside T2a; SR-2 before
> T5.notes; AG-2 after T3; AG-5 after AG-2 + ≥1 month of traces; SR-3 after PP-1..PP-7;
> SR-4 after SR-3; SR-1 Tier C before any public app registry.

## SR-1 — App Isolation & Shared-App Trust Model

**Goal:** Make "share apps safely" architecturally true instead of aspirationally true. Today apps run in-process with manifest-filtered but advisory service injection; the install-time regex analyzer stops accidents, not adversaries (SEC-4's own conclusion); `telegram.send(anyUserId)` lets any app message any registered user.

**Scope (three independent tiers):**
1. *Tier A — capability scoping:* reply-scoped messenger as the default injected surface (`telegram:any-user` becomes an explicit manifest capability); per-app outbound send rate limits mirroring LLMGuard; a least-privilege inventory pass over every `CoreServices` member ("what can a hostile caller do with this?").
2. *Tier B — runtime enforcement:* ESM loader hook (`module.register()`) resolving every import — dynamic specifiers included — against manifest capabilities; `process.env` scrubbed into a core-held closure before app load. Regex analyzer demoted to install-time UX hint.
3. *Tier C — process isolation:* one worker/child process per app (or trust tier), CoreServices as an RPC boundary, Node 22 `--permission` in the child. **Gate: required before a public app registry ships.**
4. *Docs (do first):* `docs/APP_TRUST_MODEL.md` promoted from `app-sharing-vision.md`'s "What PAS Does NOT Enforce" — ships in SR-3 regardless of tier progress.

**Sequencing:** Design pass **before T2a** — Tier A capability names and T2a's `capabilities.tools[]` + AG-3 metadata share one manifest surface. Open questions (worker vs. child process, loader-hook × tsx dev-mode interaction) in the strategic-review doc §SR-1.

**Doc footprint:** `docs/APP_TRUST_MODEL.md` (new); `MANIFEST_REFERENCE.md` + `CREATING_AN_APP.md` capability documentation; `app-manifest.schema.json`; URS area `REQ-ISO-*`; CLAUDE.md status bullet per phase; close/annotate the "Container isolation" open-items line.

## SR-2 — Channel Abstraction Seam

**Goal:** Telegram becomes the reference channel implementation instead of the substrate, so a Discord/Matrix/web contributor adds an adapter instead of forking core. No second channel is built.

**Scope:** `ChannelAdapter` interface (send/sendRich/edit + capability descriptor: `supportsButtons`, `maxMessageLength`, markup dialect); channel-neutral inbound context with `channel: { id, native }` escape hatch; `TelegramChannelAdapter` as sole implementation with byte-identical behavior (existing suite is the verifier); `MessageContext` kept as compatibility alias; 4000-char split + Markdown escaping behind the descriptor (BufferingTelegramProxy → channel-generic proxy + Telegram policy object). Non-goals: second channel, GUI-chat channel, changing Telegram-id-based GUI identity.

**Sequencing:** Interface lands **before T5.notes** so each T5 app slice migrates once; fallback is folding into T6b cleanup. Open question: does `sendOptions`' await-user-tap pattern generalize or need an async-interaction capability flag?

**Doc footprint:** `CREATING_AN_APP.md` context/type updates; URS area `REQ-CHANNEL-*`; CLAUDE.md Key File Paths row for the adapter interface; status bullet.

## SR-3 — Open-Source Publication Cut

**Goal:** Everything between "PP-1..PP-7 done" and a public repo a stranger succeeds with in 30 minutes.

**Scope:** (1) git-history/secret audit — gitleaks + manual fixture/personal-data review; decide squash-republish vs. full history; (2) license decision (operator; shapes app-ecosystem licensing); (3) README pitch + quickstart verified on a never-run-PAS machine, then scripted as a CI-run fresh-install test (makes INST-1's fix a regression-tested property); (4) SECURITY.md + disclosure policy; (5) CONTRIBUTING.md + issue templates + "good first app" guide seeded from `CREATING_AN_APP.md`; (6) CoreServices API stability statement (after SR-1 Tier A changes surfaces; promotes `app-sharing-vision.md`'s versioning section to a public contract); (7) internal-docs hygiene — decide publish/prune/split for `docs/superpowers/*`; "Hermes" codename never public-facing; (8) demo recording; (9) `docs/APP_TRUST_MODEL.md` shipped. Absorbs the unimplemented remainder of DOC-1..10 — reconcile overlap with PP-6 at planning time.

**Sequencing:** After PP-1..PP-7. The two blocking decisions (history strategy, license) are operator calls that can be made any time earlier.

**Doc footprint:** README, SECURITY.md, CONTRIBUTING.md, APP_TRUST_MODEL.md, API stability doc; URS area `REQ-PUB-*`; status bullet.

## SR-4 — Regression Harness Extraction

**Goal:** The persona-regression core (budgeted, cached, model-swappable, LLM-judged behavioral regression) becomes a standalone package — PAS's credibility wedge for the open-source launch.

**Scope:** Workspace package with zero `@core/*` imports (enforced like the LLM boundary); `CaseRunner` adapter interface (loaded case + model handle → output for oracles) + `CacheKeyContributor` (consumers add cache-salt inputs; PAS contributes tier snapshots); PAS buckets become the first adapter. **One seam serves three consumers:** this extraction, the "Regression Suite v2 — generic per-app test discovery" proposal, and AG-7's `agent` bucket — design it once. Repo split only when an external consumer exists. Open question: does the rubric oracle's transient judge-model override extract cleanly from ModelSelector?

**Sequencing:** After SR-3; lowest urgency, high optionality.

**Doc footprint:** package README; URS area `REQ-HARNESS-*`; status bullet.

## AG-2 — Bounded Interactive Agent Sessions (+ AG-6 GUI timeline, AG-7 agent regression bucket)

**Goal:** The long tail and cross-app composition — an explicit, budgeted escape hatch from structured routing, per the adopted doctrine (`docs/agentic-autonomy-doctrine.md`): heavy boundary, light inside; code-owned loop; reasoning-tier floor.

**Scope:**
1. *Session envelope:* `/agent <task>` command + an escalation *offer* when structured routing + single-shot tools can't satisfy a request (offer shows estimated budget); session lifecycle states; per-session budget reservation against CostTracker; step cap; timeout; kill switch; plain-language completion report (steps, touches, cost) — budget/step-cap stops are outcomes, not errors.
2. *Policy:* same ToolRegistry as the structured path filtered by ToolPolicy + AG-3 metadata (`agentAllowed`, risk class); confirmation gates render tool *arguments*; no agent-only tools; tier floor refusal with explanation (AG-4 ladder: fast = classification only, standard = single tool calls, reasoning = bounded loops).
3. *AG-6 observability:* per-session timeline on the GUI Activity surface rendered from the T2c tool trace.
4. *AG-7 evaluation:* new `agent` regression bucket — seed temp data tree, run task at fixed budget, assert final file state (existing multiset/structural oracles) + budget/step compliance; never assert the tool-call path. Model-matrix coverage is what makes the AG-4 ladder enforceable.
5. *Config:* `agent.enabled` (default false), `agent.tier_floor` (default `reasoning`), `agent.max_steps`, `agent.budget_usd_per_session`, `agent.daily_budget_usd`, `agent.tools_denylist`, `agent.require_confirmation` (default true; per-tool override only via manifest). Household caps via `HouseholdLLMLimiter`.

**Sequencing:** **After T3** (shadow-mode telemetry is the evidence the loop substrate behaves). Admin-only first; per-user opt-in only when AG-7's bucket is green across the model matrix (mirrors T3b). Telemetry from day one: per-session cost/step distributions, confirmation deny rate, abandonment.

**Doc footprint:** URS area `REQ-AGENT-*`; USER_GUIDE.md `/agent` section; `pas.yaml` config docs; GUI Activity docs; status bullet.

## AG-5 — Routine Distillation ("agency as authoring, structure as execution")

**Goal:** The strategic differentiator and the answer to the cheap-model constraint: a frontier-tier agent session solves a novel task once; its trace is distilled into a reviewed, human-readable routine that thereafter runs deterministically or on the fast/local tier at ~zero cost. Agent spend becomes compounding automation instead of per-request cost.

**Scope:** Routine artifact format (markdown+YAML, linear steps + guard conditions + typed slots for varying parts — deliberately no loops/branching beyond guard-skip in v1); distillation step (frontier-tier, offline, one-shot, trajectory → routine) with its own regression bucket; admin review queue in the GUI (reuse wizard patterns) — **review is mandatory and not config-disableable** (`routines.review_required`), which is what keeps this on the right side of the hermes review's self-improvement rejection; execution engine (deterministic steps LLM-free; fuzzy slots on fast tier); staleness handling (routines bind to tool schema versions; invalidate on mismatch); invocation by name from chat, on a schedule, or as an alert action. Key metric: routine reuse counts — the number that proves the thesis.

**Sequencing:** **After AG-2 + ≥1 month of real session traces** — traces are the design input for the routine representation; designing it earlier is guessing. This gate is deliberate so the go/no-go is made on evidence.

**Doc footprint:** URS area `REQ-ROUTINE-*`; USER_GUIDE.md routines section; review-queue GUI docs; status bullet.

---

## Deferred / Open Items

See `docs/open-items.md` for all deferred phases, unfinished corrections, proposals, and accepted risks.
