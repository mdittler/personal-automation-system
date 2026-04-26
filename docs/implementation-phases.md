# PAS Infrastructure — Implementation Phases

| Field | Value |
|---|---|
| **Purpose** | Detailed phase-by-phase implementation guide for the PAS infrastructure |
| **Status** | Phases 0–28, D1–D4 complete (except 27A-Vaults, 27B, 27C planned) |
| **Last Updated** | 2026-04-25 |

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
| D5c | Per-Household LLM Governance + Ops + Load Test | **Planned** | TBD | Household cost ledger (9th column), shared household rate limiter, per-household cost caps + reservations, ops dashboard, 40-user load test with bootstrap composeRuntime refactor. Plan: `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md` |

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

- **Modified:** `apps/chatbot/src/index.ts` — `classifyPASMessage()`, `buildUserContext()`, `splitTelegramMessage()` added and wired into `handleMessage()` / `handleCommand()`. `isPasRelevant()` deprecated (not removed).
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
- `isPasRelevant()` is deprecated. Its tests remain for backward compat. Remove in a future cleanup once no callers remain.
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
- **Modified:** `core/src/types/config.ts` — `@deprecated` on `fallback`; new `_legacyKeys?` field
- **Modified:** `core/src/services/config/index.ts` — populates `_legacyKeys.defaultsFallback`
- **Modified:** `core/src/compose-runtime.ts` — constructs ConversationService with dedicated LLMGuard + DataStore + AppConfigService; passes to Router; rv:chatbot callback prefers conversationService; deprecation warning on `_legacyKeys.defaultsFallback`
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

## Deferred / Open Items

See `docs/open-items.md` for all deferred phases, unfinished corrections, proposals, and accepted risks.
