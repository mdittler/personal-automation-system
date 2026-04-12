# Personal Automation System (PAS)

## Project Overview

A local-first home automation platform where users interact through a single Telegram bot. The infrastructure handles message routing, scheduling, data storage, LLM access, multi-user management, audio output, condition evaluation, and a management interface. Apps are modular plugins that implement specific functionality. Apps can be developed independently and shared between PAS instances as git repos.

**Documentation maintenance rules are in the `pas-documentation-maintenance` skill. Testing patterns and standards are in the `pas-testing-standards` skill. URS workflow and traceability matrix are in the `pas-urs-workflow` skill.**

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
- Auth: `GUI_AUTH_TOKEN` env var, HTTP-only cookie. CSRF double-submit cookie on all POSTs

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
- **Testing patterns and standards are in the `pas-testing-standards` skill. URS workflow and traceability matrix are in the `pas-urs-workflow` skill.**

## Key File Paths

| Path | Purpose |
|------|---------|
| `core/src/bootstrap.ts` | Main composition root |
| `core/src/types/app-module.ts` | AppModule + CoreServices interfaces |
| `core/src/types/llm.ts` | LLM type system (providers, tiers, models) |
| `core/src/types/config.ts` | SystemConfig + LLMConfig types |
| `core/src/schemas/app-manifest.schema.json` | Manifest JSON Schema |
| `core/src/services/router/index.ts` | Message routing dispatch |
| `core/src/services/router/route-verifier.ts` | Post-classification grey-zone verifier |
| `core/src/services/router/pending-verification-store.ts` | In-memory pending message store |
| `core/src/services/router/verification-logger.ts` | Verification event log writer |
| `core/src/services/data-store/scoped-store.ts` | Per-user/per-app data access |
| `core/src/services/llm/index.ts` | LLM service (multi-provider routing) |
| `core/src/services/llm/llm-guard.ts` | Per-app rate limit + cost cap |
| `core/src/services/context/request-context.ts` | Unified AsyncLocalStorage userId propagation (LLM cost attribution + per-user config reads) |
| `core/src/services/config/app-config-service.ts` | Per-user config overrides (reads userId from requestContext) |
| `core/src/services/scheduler/per-user-dispatch.ts` | Wraps user_scope: all scheduled jobs in per-user requestContext |
| `core/src/services/reports/index.ts` | ReportService: CRUD, run, cron lifecycle |
| `core/src/services/alerts/index.ts` | AlertService: CRUD, evaluate, cron lifecycle |
| `core/src/services/spaces/index.ts` | SpaceService: CRUD, membership |
| `core/src/services/vault/index.ts` | VaultService: per-user Obsidian vault symlinks |
| `core/src/services/n8n/index.ts` | N8nDispatcher: dispatch execution to n8n |
| `core/src/services/webhooks/index.ts` | WebhookService: outbound event delivery |
| `core/src/services/app-installer/index.ts` | App install orchestrator |
| `core/src/services/system-info/index.ts` | System introspection service |
| `core/src/gui/index.ts` | GUI route registration |
| `core/src/gui/routes/users.ts` | User management GUI routes |
| `core/src/services/invite/index.ts` | Invite code generation, validation, redemption |
| `core/src/services/user-manager/user-mutation-service.ts` | Runtime user mutations + config sync |
| `core/src/services/config/config-writer.ts` | Sync users array to pas.yaml |
| `core/src/gui/auth.ts` | GUI token auth + cookie middleware |
| `core/src/gui/csrf.ts` | CSRF protection |
| `core/src/api/index.ts` | External API plugin registration |
| `core/src/api/auth.ts` | API Bearer token auth |
| `core/src/utils/frontmatter.ts` | Obsidian frontmatter utilities |
| `core/src/middleware/rate-limiter.ts` | Sliding-window rate limiter |
| `core/src/middleware/shutdown.ts` | Graceful shutdown manager |
| `config/pas.yaml` | System configuration |
| `apps/chatbot/src/index.ts` | Chatbot app (fallback, /ask, app-aware prompts) |
| `apps/food/` | Food management app (household, recipes, grocery, pantry) |
| `apps/notes/` | Notes example app |
| `docs/urs.md` | User Requirements Specification |
| `docs/CREATING_AN_APP.md` | App developer guide |
| `docs/MANIFEST_REFERENCE.md` | Manifest field reference |
| `docs/implementation-phases.md` | Detailed phase guide (read before starting new phases) |

## Security

### Current Posture
- CSRF double-submit cookie on all GUI POSTs. Rate limiting on login (5/15min), Telegram (20/60s), API (100/60s)
- LLM prompt injection hardening: `sanitizeInput()` + backtick neutralization + anti-instruction framing on all user-content-to-LLM surfaces
- XSS: Eta auto-escaping + `escapeHtml()` on htmx partials + escaped `hx-vals` JSON
- Path traversal: `SAFE_SEGMENT` validation, resolve-within checks on all file operations
- Input validation: userId/appId/spaceId pattern validation before use. `timingSafeEqual` for secrets
- App install: static analysis for banned imports, symlink detection, manifest size limits, reserved ID protection
- API keys server-side only. Model IDs never in LLM prompts. `trustProxy` configurable via `TRUST_PROXY=true`

### Open Deferred Issues
- **D14**: YAML `parseYaml<T>` unchecked type cast — acceptable risk (system-managed files only)
- **D36-D38**: GUI doesn't enforce space membership/creator — acceptable risk (admin GUI, single auth token)
- **D39**: Report/alert GUI forms don't expose space_id — feature gap for later
- **D40**: `getActiveSpace()` fire-and-forget persist — acceptable risk (self-healing)
- **D42**: Conversation history anti-instruction framing removed — accepted risk (continuity > theoretical injection)

## Implementation Status

All infrastructure phases (0-30) and Food phases (H1, H2a, H3, H4, H5a, H5b, H6, H7, H8, H9, H10, H11, H11.x, H11.z incl. iteration-2 hardening, H11.w, H11.y, H12a, H12b) are complete. Security review remediation phases R1 (access control), R2 (chatbot LLM trust), and R3 (data boundaries) are complete. Security finding F9 (Telegram Markdown escaping) is fixed — shared `escapeMarkdown` utility in core, applied to 8 food formatters, echo/notes apps, reports, and alerts. Phase R4 (LLM routing, provider selection, cost caps) is complete — F10 (unpriced remote models), F11 (Anthropic hard startup requirement), F12 (stale saved tier selections), F13 (cost cap reset on cache miss), F14 (API calls attributed as 'system') all fixed. **5573 tests passing across 225 test files.**

**GUI cleanup (2026-04-10):** Left sidebar navigation (all 10 nav items moved to sticky sidebar, top bar keeps PAS brand + Dashboard + theme + logout); Users page groups column replaced with space checkboxes (auto-save on toggle, linked to SpaceService.listSpaces()); admin self-removal UX protection (Remove button disabled for sole admin); scheduler lastRunAt persisted to `data/system/cron-last-run.json` (survives restarts); dashboard Claude Model now reads from ModelSelector instead of stale .env value.

See `docs/implementation-phases.md` for detailed phase guide.

### Deferred / Future Items
- **Phase 27B** — FileIndexService: in-memory cross-app file metadata index. Deferred until lifestyle apps validate Phase 27A conventions
- **Phase 27C** — CrossAppDataService + LinkResolver: read-only cross-app file access. Deferred until 27B proves needed
- **Infra: Per-User Config Runtime Propagation** — **FIXED 2026-04-09.** A unified `requestContext` AsyncLocalStorage (replacing the former `llmContext`) now propagates the active `userId` through every dispatch point (message, command, photo, callback, scheduled job, alert action, API message, GUI simulated message). `AppConfigServiceImpl` reads `getCurrentUserId()` from the request context, so `services.config.get(key)` automatically returns the calling user's override. Scheduled jobs declared `user_scope: all` are now invoked once per registered user by the scheduler inside a per-user context, and `AppModule.handleScheduledJob(jobId, userId?)` receives that userId. Canonical regression tests: `core/src/services/config/__tests__/per-user-runtime.integration.test.ts` (core fence) and `apps/food/src/__tests__/handlers/nutrition-per-user-config.integration.test.ts` (food app fence).
- **Phase H11.y** — **COMPLETE 2026-04-09.** Guided button flows for nutrition target-setting (`targets-flow.ts`) and hosting guest-add (`guest-add-flow.ts`); adherence period picker; NL routing for `isTargetsSetIntent` / `isAdherenceIntent` / extended `isNutritionViewIntent`.
- **Phase H12a** — **COMPLETE 2026-04-09.** 5 food event emitters wired at canonical call sites (`food:meal-plan-finalized`, `food:grocery-list-ready`, `food:recipe-scheduled`, `food:meal-cooked`, `food:shopping-completed`); `health:daily-metrics` subscriber persisting to per-user `health/YYYY-MM.yaml`; `health-correlator.ts` (standard-tier LLM, ≤3 observational insights with disclaimer, prompt-injection defense, insight type-guard); `weekly-health-correlation` scheduled job; `isHealthCorrelationIntent` NL intent (9 patterns covering real user phrasing) + handler; `HEALTH_CORRELATION_GUARD` preventing nutrition-view bleed. Post-review hardening: `isCorrelationInsight` type guard on LLM output, `metrics` field guard in subscriber, date format validation in `upsertDailyHealth`, `userId` guard in `loadMonthlyHealth`, `itemsPurchased` semantic fix in shopping-followup, period disclosure "(last 14 days)" in insight response. Key files: `apps/food/src/events/` (types/emitters/subscribers), `apps/food/src/services/health-store.ts`, `apps/food/src/services/health-correlator.ts`, `apps/food/src/handlers/health.ts`.
- **Phase H12b** — **COMPLETE 2026-04-10.** Cultural calendar with 15 default holidays; deterministic date computation (fixed, nthWeekday, Easter Computus, lunisolar lookup tables); `ensureCalendar` writes defaults to shared store on first run; `isCulturalCalendarIntent` + `handleCulturalCalendarMessage` (on-demand, named-holiday aware) + `handleCulturalCalendarJob` (weekly Sunday 10am, silent when nothing upcoming); household recipe library integrated into LLM prompt; `cultural_calendar` boolean config. Key files: `apps/food/src/services/cultural-calendar.ts`, `apps/food/src/handlers/cultural-calendar-handler.ts`.
- **General: Full Telegram data access** — Any data an app stores should be readable and correctable via Telegram NL. Currently several food data stores have no viewing or editing intents (price store, receipt items, health metrics, etc.). Discovered 2026-04-10 when: (1) receipt OCR misread "HUG PU 3T-4T" as "Hugot Pumpkin Puree" with no way to correct it via Telegram, and (2) user couldn't ask "show me my Costco prices" despite price store existing at `shared/food/prices/{store}.md`. Each app phase should audit its stored data and ensure every store has corresponding read + correct intents. Data manually corrected 2026-04-10.
- **Phase H12c** — Alcohol + Meal Quality Signals. Alcohol NL logging (`isAlcoholLogIntent` → fast-tier LLM extracts units+type → `upsertDailyHealth`); meal quality/heaviness flag (`isMealQualityLogIntent` → deterministic keyword heuristic → `processedFoodDay`/`heavyMealDay`); correlator table updated with `alcohol_units`, `alcohol_type`, `processed_food`, `heavy_meal` columns. Hydration explicitly out of scope. Deferred pending H12a stabilization.
- **Fitness/Health app (future)** — Subjective signals (`energyLevel`, `mood`, stress scores from wearables like Garmin) belong in a dedicated fitness app, not the food app. The food app's `HealthDailyMetricsPayload` intentionally omits these fields. When a fitness app is created, it should emit `health:daily-metrics` events with those fields, which the food correlator will automatically pick up (the column inclusion is already conditional on data presence).
- **App registry/marketplace** — static JSON index files. Deferred until enough apps exist
- **App signing** — cryptographic verification. Deferred until community forms
- **Container isolation** — for untrusted apps. Deferred until community forms
