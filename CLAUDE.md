# Personal Automation System (PAS)

## Project Overview

A local-first home automation platform where users interact through a single Telegram bot. The infrastructure handles message routing, scheduling, data storage, LLM access, multi-user management, audio output, condition evaluation, and a management interface. Apps are modular plugins that implement specific functionality. Apps can be developed independently and shared between PAS instances as git repos.

**Documentation maintenance rules are in the `pas-documentation-maintenance` skill. Testing patterns and standards are in the `testing-standards` skill. URS workflow and traceability matrix are in the `pas-urs-workflow` skill.**

## Architecture Decisions

### Runtime & Monorepo
- **Node.js 22 LTS + TypeScript 5.x**, ESM only, `strict: true`
- **pnpm workspaces** — `core/` is infrastructure, `apps/*` are plugins. Path aliases: `@core/*` → `core/src/*`
- **Single process** — all apps in one Node.js process (target: Mac Mini with 32GB RAM)
- **Developer commands**: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm scaffold-app --name=<app>`, `pnpm install-app <git-url>`

### Data & Storage
- **Markdown files on filesystem** — no database. Scoped paths: `data/users/<user_id>/<app_id>/`, `data/users/shared/<app_id>/`, `data/spaces/<spaceId>/<appId>/`, `data/system/`
- Atomic writes via temp file + rename (with Windows retry for EPERM). History never deleted — archive operations preserve content
- **YAML frontmatter** on all generated .md files for Obsidian compatibility. Use `stripFrontmatter()` before processing for LLM/eval. `appendWithFrontmatter()` for atomic create-or-append
- **Shared data spaces** — named membership groups (`/space` command). `DataStore.forSpace(spaceId, userId)` checks membership
- **Per-user Obsidian vaults** — symlinks at `data/vaults/<userId>/` to canonical data. Windows junctions, Unix symlinks. VaultService rebuilds at startup

### LLM Architecture
- **Multi-provider**: Anthropic (native), Google Gemini (native), OpenAI-compatible (covers OpenAI, Groq, Together, etc.), Ollama (optional local)
- **Tier-based routing** — apps request `fast`, `standard`, or `reasoning` tier; infrastructure maps to provider+model
- **Security boundary** — apps must NOT import LLM SDKs directly (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama` are banned). All LLM access via `CoreServices.llm`
- **Per-app safeguards** — `LLMGuard` enforces rate limits + monthly cost caps. `SystemLLMGuard` for infrastructure calls
- **Per-user cost tracking** — `AsyncLocalStorage` propagates userId transparently; 8-column usage log
- **Runtime model switching** — `ModelSelector` persists to YAML, changeable via GUI. `ModelCatalog` fetches available models (1-hour cache)
- Ollama optional — when `OLLAMA_URL` is empty, classification uses Claude fast model

### App System
- **Manifests** — YAML (`manifest.yaml`), validated against JSON Schema. Declare identity, capabilities (intents, commands, photos, schedules, rules, events), requirements, user config
- **Distribution** — apps are standalone git repos. `pas install <git-url>` clones, validates, scans for banned imports, checks `pas_core_version` compatibility
- **Trust model** — install-time static analysis catches accidental violations. No runtime sandbox (honest about this). DI enforces undeclared services are `undefined`, scoped data prevents path traversal
- **Message routing priority**: 1) `/command` exact match → 2) Photo classification → 3) Free text LLM classification (with "none" escape) → 4) Chatbot fallback
- **Route verification** — enabled by default. Grey-zone classifications (confidence 0.4–0.7) trigger a second LLM call (standard tier) with app descriptions for verification. On disagreement, inline Telegram buttons let the user choose. Disable via `routing.verification.enabled: false` in pas.yaml

### Chatbot & App Awareness
- **Chatbot app** — full conversational AI fallback. Per-user conversation history (20 turns), context store integration, graceful LLM failure degradation
- **`/ask` command** — app-aware system prompt with AppMetadataService + AppKnowledgeBase + SystemInfoService
- **Model journal** — per-model markdown files at `data/model-journal/{model-slug}.md`, `<model-journal>` tag extraction from LLM responses

### Reports, Alerts & Automation
- **Reports** — user-defined recurring reports: 4 section types (changes, app-data, context, custom), optional LLM summary, Telegram delivery
- **Alerts** — condition evaluation (deterministic + fuzzy/LLM) against data files. 6 action types: telegram_message, run_report, webhook, write_data, audio, dispatch_message. Scheduled or event-triggered
- **Template variables** — `{data}`, `{summary}`, `{alert_name}`, `{date}` in alert action fields

### External APIs & n8n
- **REST API** — `POST/GET /api/data`, `POST /api/messages`, `GET /api/schedules`, plus report/alert/changes/LLM/telegram APIs. Bearer token auth, 100 req/60s
- **n8n dispatch** — `n8n.dispatch_url` in pas.yaml; cron triggers POST to n8n instead of internal execution, with automatic fallback
- **Outbound webhooks** — config-driven EventBus subscribers, HMAC-SHA256 signing, fire-and-forget

### Frontend (Management GUI)
- **Server-rendered HTML** via Fastify + Eta templates, **htmx** for interactivity, **Pico CSS**
- Auth: Per-user password login (Telegram user id + password). Cookie: `{userId, sessionVersion, issuedAt}`, signed, 24h sliding session. Legacy `GUI_AUTH_TOKEN` accepted only when exactly one `isAdmin` user exists. CSRF double-submit cookie on all POSTs. Admin routes require `isPlatformAdmin`; non-admin users see only own data and joined spaces.

## Code Conventions

### File Naming & Imports
- Lowercase with hyphens: `scoped-store.ts`. Tests: `__tests__/<name>.test.ts`
- ESM imports with `.js` extension. Apps import types from `@core/types`, receive services via `CoreServices` in `init()`

### Error Handling & Logging
- App failures caught and logged — never crash the system
- Structured logging via Pino (JSON in production, pretty in dev)

### Data Files
- `## Active` / `## Archive` sections for list-type data. YAML frontmatter. Lowercase filenames with hyphens

### Testing
- **Vitest** for all tests. Mock `CoreServices` for app unit tests. Real filesystem (temp dirs) for DataStore tests
- **Zero failing tests policy** — the full test suite must pass with zero failures at all times. "Pre-existing failure" is not an excuse to leave tests broken. If you encounter a failing test, fix it — either fix the code or fix the test. Never skip, ignore, or dismiss test failures as someone else's problem.
- **Time-sensitive tests** — never hardcode dates in tests that compare against "today". Use relative dates (e.g., `new Date(Date.now() - 86400000)`) so tests don't rot as time passes
- **Testing patterns and standards are in the `testing-standards` skill. URS workflow and traceability matrix are in the `pas-urs-workflow` skill.**

### Deferred Work Tracking
- **`docs/open-items.md` is the single source of truth for all deferred, out-of-scope, and follow-up work.** Every spec, plan, and findings doc that explicitly defers something must have a corresponding entry in `docs/open-items.md` before the session ends.
- If a task is described as "deferred", "out of scope", "future phase", "follow-up", or "to be done in a later session", it must be added to `docs/open-items.md` under the appropriate section: Confirmed Phases, Deferred Infrastructure Work, Unfinished Corrections, Food App Enhancements, Proposals, or Accepted Risks.
- A `PostToolUse` hook (`check-deferred-work.sh`) automatically reminds you when you write to a spec or plan doc that contains deferred-work language. Do not dismiss this reminder without acting on it.

## Key File Paths

| Path | Purpose |
|------|---------|
| `core/src/bootstrap.ts` | Main composition root |
| `core/src/types/app-module.ts` | AppModule + CoreServices interfaces |
| `core/src/types/llm.ts` | LLM type system (providers, tiers, models) |
| `core/src/types/config.ts` | SystemConfig + LLMConfig types |
| `core/src/schemas/app-manifest.schema.json` | Manifest JSON Schema |
| `core/src/services/router/index.ts` | Message routing dispatch |
| `core/src/services/data-store/scoped-store.ts` | Per-user/per-app data access |
| `core/src/services/data-store/paths.ts` | Scope normalization (POSIX traversal rejection, null-byte guard) |
| `core/src/services/file-index/index.ts` | FileIndexService — in-memory file metadata index, EventBus refresh |
| `core/src/services/llm/index.ts` | LLM service (multi-provider routing) |
| `core/src/services/llm/llm-guard.ts` | Per-app rate limit + cost cap |
| `core/src/services/context/request-context.ts` | Unified AsyncLocalStorage — `{userId?, householdId?}` propagated through every dispatch point |
| `core/src/services/config/app-config-service.ts` | Per-user config overrides (reads userId from requestContext) |
| `core/src/services/reports/index.ts` | ReportService: CRUD, run, cron lifecycle |
| `core/src/services/alerts/index.ts` | AlertService: CRUD, evaluate, cron lifecycle |
| `core/src/services/spaces/index.ts` | SpaceService: CRUD, membership |
| `core/src/services/vault/index.ts` | VaultService: per-user Obsidian vault symlinks |
| `core/src/services/household/index.ts` | HouseholdService — YAML persistence, userId→householdId, boundary assertions |
| `core/src/services/app-installer/index.ts` | App install orchestrator |
| `core/src/services/invite/index.ts` | Invite code generation, validation, redemption |
| `core/src/services/credentials/index.ts` | CredentialService — scrypt hashing, sessionVersion, credentials.yaml |
| `core/src/services/api-keys/index.ts` | ApiKeyService — per-user API key store, verify/revoke, debounced lastUsedAt |
| `core/src/gui/index.ts` | GUI route registration |
| `core/src/gui/auth.ts` | GUI token auth + cookie middleware |
| `core/src/gui/csrf.ts` | CSRF protection |
| `core/src/api/index.ts` | External API plugin registration |
| `core/src/api/auth.ts` | API Bearer token auth |
| `core/src/utils/frontmatter.ts` | Obsidian frontmatter utilities |
| `core/src/utils/file-mutex.ts` | FileMutex — `withFileLock`/`withMultiFileLock` for atomic RMW operations |
| `config/pas.yaml` | System configuration |
| `core/src/services/conversation/` | ConversationService + all conversation helpers (fallback, /ask, /edit, /notes) |
| `apps/food/` | Food management app (household, recipes, grocery, pantry) |
| `docs/urs.md` | User Requirements Specification |
| `docs/CREATING_AN_APP.md` | App developer guide |
| `docs/MANIFEST_REFERENCE.md` | Manifest field reference |
| `docs/implementation-phases.md` | Detailed phase guide (read before starting new phases) |

## Security

Security patterns and posture are in the `pas-security-posture` skill. Invoke when touching auth, cookies, LLM prompts, templates, path handling, or API endpoints.

## Implementation Status

All infrastructure (phases 0–30), food app (H1–H12b), security remediation (R1–R7, CR6, CR8, CR9), and deployment readiness (D1–D6 incl. D5a, D5b) phases are complete. LLM enhancement items #1 (route metadata) and #2 Chunks A–D complete. D5c Chunks 0–E complete. **Hermes P1 complete (Chunks A–D, all sub-chunks).** **Hermes P2 complete (Chunks A–E).** **Hermes P3 complete — session persistence, REQ-CONV-SESSION-001..014.** ~8260 tests / ~354 files.

Spec: `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md`. See `docs/implementation-phases.md` for detailed phase history.

### Current Priority: Production flip of shadow classifier
**Hermes P1 is complete** (D.4 merged 2026-04-27). ConversationService is now a first-class core service; all legacy `fallback`/`_legacyKeys` surface is removed. **Hermes P2 is complete** (Chunks A–E merged 2026-04-27). ConversationRetrievalService provides broad, policy-governed data visibility for `handleMessage` and `handleAsk`; 16 new URS requirements (REQ-CONV-RETRIEVAL-001 through 016) document the implementation. **Hermes P3 is complete** (2026-04-27). Session persistence — manual `/newchat` and `/reset`; `ChatSessionStore` with per-session markdown transcripts, `active-sessions.yaml` index, legacy `history.json` migration, `expectedSessionId` in-flight race guard; 14 URS requirements (REQ-CONV-SESSION-001 through 014). **LLM Enhancement #2 Chunks A–D** are complete: Chunk A (route-first dispatch, 9-intent allowlist, ~74 new tests), Chunk B (shadow classifier infrastructure B.1 + B.2 + FOOD_PERSONAS, ~239 tests), Chunk C (shadow pipeline wired into `handleMessage` — `computeVerdict`, `finalizeShadow`, `regexWinner` per branch, skipped-* gates, `shadow_sample_rate` config; +26 tests), Chunk D (shadow-primary machinery — `routing_primary` flag, `SHADOW_HANDLERS` 25-entry table, `shadow_min_confidence` threshold, result reuse preventing double-classify, telemetry CLI `pnpm analyze-shadow-log`; +64 tests). Production flip (`routing_primary: shadow`) is a config decision gated on ≥95% telemetry from `pnpm analyze-shadow-log`. Future work: LLM Enhancement #3 (structured extractors), A.1 allowlist expansion, or Hermes P5 (SQLite + FTS5 transcript search).

Plan: `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`

D5c plan: `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`

| Chunk | Status | What it does |
|---|---|---|
| 0 | ✓ Complete | Semantics decisions + URS entries + open-items.md fix |
| A | ✓ Complete | Fix 3 ALS dispatch gaps (bootstrap:816/835/924, context.ts:60/115/163/191) + regression guard |
| B | ✓ Complete | CostTracker household dimension + reservations |
| C | ✓ Complete | HouseholdLLMLimiter + RateLimiter peek/commit + config surface + error types |
| D | ✓ Complete | Ops dashboard (/gui/llm Per-Household section + live metrics) |
| E | ✓ Complete | composeRuntime() bootstrap refactor + load-test harness |

### Open Items
See `docs/open-items.md` for all deferred phases, unfinished corrections, proposals, and accepted risks.
