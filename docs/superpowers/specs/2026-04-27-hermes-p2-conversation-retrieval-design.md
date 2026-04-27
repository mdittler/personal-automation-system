# Hermes P2 — ConversationRetrievalService Design

**Date:** 2026-04-27
**Author:** Claude (Chunk A implementation)
**Status:** Chunk A complete — Chunks B–E pending

---

## Context

**Hermes P1** (complete, merged 2026-04-27) extracted the chatbot into a first-class
`ConversationService` at `core/src/services/conversation/`. The chatbot app source was deleted
and all legacy `fallback`/`_legacyKeys` surface was removed.

**Hermes P2** introduces `ConversationRetrievalService` — an orchestrator that gives the
conversation engine broad, policy-governed data visibility without exposing raw service
references to the LLM handler layer. The service composes existing scoped readers (DataQuery,
ContextStore, InteractionContext, AppMetadata, AppKnowledge, SystemInfo, Reports, Alerts) into a
single entry point with a well-defined auth model per category.

Key design goals:

- **Source Policy first** — every data source must be listed in `SOURCE_POLICY` before it can be
  wired. The `DENIED_SOURCES` set documents what the conversation engine must never touch.
- **requestContext-based auth** — no userId parameter on service methods. The conversation
  engine reads userId from `AsyncLocalStorage` via `getCurrentUserId()`, the same mechanism
  used by every other infrastructure service.
- **Minimal-context default** — `buildContextSnapshot()` only fetches categories relevant to the
  current question, controlled by `ContextSnapshotOptions.include` and `characterBudget`.
- **Partial-failure tolerance** — individual reader failures populate `snapshot.failures` rather
  than aborting the entire context fetch.

---

## Architecture

### Source Policy

`core/src/services/conversation-retrieval/source-policy.ts` exports:

| Export | Purpose |
|--------|---------|
| `AllowedSourceCategory` | Union type of 11 permitted data source categories |
| `DeniedSourceCategory` | Union type of 9 categories the service must never touch |
| `ALLOWED_SOURCES` | `ReadonlySet<AllowedSourceCategory>` — runtime allowlist |
| `DENIED_SOURCES` | `ReadonlySet<DeniedSourceCategory>` — runtime denylist |
| `SOURCE_POLICY` | `ReadonlyMap<AllowedSourceCategory, SourcePolicyEntry>` — full per-category metadata |
| `METHOD_SOURCE_CATEGORIES` | N:M map from method name → categories it reads |

### Allowed Source Categories (11)

| Category | Underlying Service | Auth Model |
|----------|-------------------|------------|
| `user-app-data` | DataQueryService.query | user-scoped |
| `household-shared-data` | DataQueryService.query | household-membership |
| `space-data` | DataQueryService.query | space-membership |
| `collaboration-data` | DataQueryService.query | collaboration-membership |
| `context-store` | ContextStoreService.listForUser | user-scoped |
| `interaction-context` | InteractionContextService.getRecent | user-scoped |
| `app-metadata` | AppMetadataService.getEnabledApps | user-scoped |
| `app-knowledge` | AppKnowledgeBaseService.search | user-scoped |
| `system-info` | ConversationSystemInfoReader.buildSystemDataBlock | admin-gated |
| `reports` | ReportService.listForUser | user-scoped (Chunk B) |
| `alerts` | AlertService.listForUser | user-scoped (Chunk B) |

### Denied Source Categories (9)

`credentials`, `api-keys`, `secrets`, `other-user-personal-data`, `other-household-data`,
`admin-only-config`, `cost-tracker-raw-rows`, `internal-logs`, `model-journal-entries`

---

## Service API

```ts
interface ConversationRetrievalService {
  searchData(args: { question: string; recentFilePaths?: string[] }): Promise<DataQueryResult>;
  listContextEntries(): Promise<unknown[]>;
  getRecentInteractions(): Promise<unknown[]>;
  getEnabledApps(): Promise<unknown[]>;
  searchAppKnowledge(query: string): Promise<unknown[]>;
  buildSystemDataBlock(args: { question: string; isAdmin: boolean }): Promise<string>;
  listScopedReports(): Promise<unknown[]>;
  listScopedAlerts(): Promise<unknown[]>;
  buildContextSnapshot(opts: ContextSnapshotOptions): Promise<ConversationContextSnapshot>;
}

interface ContextSnapshotOptions {
  question: string;
  mode: 'free-text' | 'ask';
  dataQueryCandidate: boolean;
  recentFilePaths: string[];
  isAdmin: boolean;
  include?: { [K in AllowedSourceCategory]?: boolean };
  characterBudget?: number;
}

interface ConversationContextSnapshot {
  failures: AllowedSourceCategory[];
  // Additional fields (data, contextEntries, appInfo, …) added in Chunk C
}
```

All methods assert `getCurrentUserId()` is set. When called outside a `requestContext` scope,
they throw `MissingRequestContextError`. When called inside a context (Chunk A skeleton), they
throw `new Error('not implemented yet — blocked on Chunk B/C')`.

### DI Wiring

`ConversationRetrievalService` is **not** added to `CoreServices` — apps cannot access it.
It is an internal infrastructure service used only by the conversation handlers.

`ConversationRetrievalServiceImpl` is instantiated in `compose-runtime.ts` after
`DataQueryServiceImpl` and `EditServiceImpl` are initialized, and is passed into
`ConversationService` via its deps. `ConversationService` threads it through to `HandleAskDeps`
and `HandleMessageDeps` (both gain an optional `conversationRetrieval` field in Chunk A).

---

## Chunk Plan

| Chunk | Status | What it does |
|-------|--------|-------------|
| A | **Complete** | Source Policy + service skeleton + DI wiring. All methods throw "not implemented". ~46 new tests. |
| B | Pending | Add `ReportService.listForUser` and `AlertService.listForUser` scoped APIs. |
| C | Pending | Implement all reader methods; compose `buildContextSnapshot` with partial-failure tolerance and character budget enforcement. |
| D | Pending | Wire `ConversationRetrievalService` into `handleMessage` and `handleAsk` handler bodies; replace inline reader calls; persona tests. |
| E | Pending | URS finalization, docs update, CLAUDE.md status update. |

---

## Out of Scope

The following are explicitly deferred to later chunks or later phases:

- **FTS5 transcript search** — not part of Hermes P2; tracked in `docs/open-items.md` as a
  future phase.
- **Session auto-reset** — deferred per `feedback_no_autoreset_before_recall.md` until FTS5
  search exists.
- **Frozen snapshot / memory snapshot** — Chat-to-Core Roadmap P4, separate from P2.
- **Collaboration-data wiring** — `SOURCE_POLICY` declares the category but the underlying
  cross-household `SpaceService.isMember` query is not implemented in Chunk A. Wired in Chunk C.
- **Real return types for `unknown[]` methods** — placeholder until Chunk C fills in the bodies.
