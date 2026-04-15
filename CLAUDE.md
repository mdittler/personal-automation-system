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
- **Testing patterns and standards are in the `testing-standards` skill. URS workflow and traceability matrix are in the `pas-urs-workflow` skill.**

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
| `core/src/services/data-store/paths.ts` | Scope normalization (POSIX traversal rejection, null-byte guard) |
| `core/src/services/file-index/index.ts` | FileIndexService — in-memory file metadata index, EventBus refresh |
| `core/src/services/file-index/entry-parser.ts` | Path metadata + content extraction (title, type, entityKeys, wikiLinks) |
| `core/src/services/file-index/types.ts` | FileIndexEntry (untrusted-data fields; sanitized via sanitizeInput() in chatbot wiring) |
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
- XSS: Eta auto-escaping + `escapeHtml()` on htmx partials + escaped `hx-vals` JSON. Inline `onclick` handlers with untrusted data replaced by `data-*` attributes + delegated listener in `layout.eta`. `safeJsonForScript()` for inline `<script>` JSON embeds
- Secure cookies: `pas_auth` and `pas_csrf` cookies set with `secure: true` in production (`NODE_ENV=production` or `GUI_SECURE_COOKIES=true`). Auth guard reissues cookies with current policy on every request (upgrades pre-hardening cookies). File picker `target` parameter validated against `^[A-Za-z0-9_-]+$`
- Path traversal: `SAFE_SEGMENT` validation, resolve-within checks on all file operations
- Input validation: userId/appId/spaceId pattern validation before use. `timingSafeEqual` for secrets
- App install: static analysis for banned imports, symlink detection, manifest size limits, reserved ID protection
- API keys server-side only. Model IDs never in LLM prompts. `trustProxy` configurable via `TRUST_PROXY=true`

### Open Deferred Issues
- **D36-D38**: GUI doesn't enforce space membership/creator — acceptable risk (admin GUI, single auth token)
- **D40**: `getActiveSpace()` fire-and-forget persist — acceptable risk (self-healing)
- **D42**: Conversation history anti-instruction framing removed — accepted risk (continuity > theoretical injection)

## Implementation Status

All infrastructure phases (0-30) and Food phases (H1, H2a, H3, H4, H5a, H5b, H6, H7, H8, H9, H10, H11, H11.x, H11.z incl. iteration-2 hardening, H11.w, H11.y, H12a, H12b) are complete. Security review remediation phases R1 (access control), R2 (chatbot LLM trust), R3 (data boundaries), R4 (LLM routing/cost caps), and R5 (food photo/vision) are complete. Security finding F9 (Telegram Markdown escaping) is fixed — shared `escapeMarkdown` utility in core, applied to 8 food formatters, echo/notes apps, reports, and alerts; followup fixes applied to cook-session/batch-cooking/cuisine-tracker formatters, router MarkdownV2 sequences, and food inline confirmations. Phase R4 complete — F10 (unpriced remote models), F11 (Anthropic hard startup requirement), F12 (stale saved tier selections), F13 (cost cap reset on cache miss), F14 (API calls attributed as 'system') all fixed. Phase R5 complete — F15 (household guard on photo uploads), F16 (strict vision classification), F17 (caption prompt injection hardening), F18 (canonical ingredient names for photo recipes), F19 (grocery-photo atomic writes), F20 (malformed LLM output type guards), F21 (Telegram Markdown escaping for photo handlers) all fixed. Phase R6 complete — F31 (one-off resolver wiring), F32 (promise queue poisoning), F33 (job failure notifications), F34 (event bus handler map), F35 (in-flight job shutdown drain) all fixed. Phase R7 (test gap audit) complete — notifier exception resilience guard added to CronManager and OneOffManager (throwing notifier no longer aborts batch); coverage added for EventBus.clearAll(), CostTracker queue pattern, 30s drain timeout paths, OneOffManager stopping flag, and notifier exception resilience. Phase R1 post-review complete — H1 (access check before resolveCallback), H2 (claimAndRedeem idempotency + registerUser rollback), L3 (shared redeemInviteAndRegister helper), M1 (verifier single-app fallback), M2 (answerCallbackQuery denial feedback), M3 (appToggle overrides in verifier), L1 (type narrowing), L2 (redeemCode lock), L4 (chatbot exemption removed), L5 (full test coverage), L6 (stale docs fixed). Phase CR6 (arithmetic/date/cost/schedule calculations) complete — F22 (parseInt garbage rejection via parseStrictInt), F23 (DST-safe addDays utility consolidation, 7+ call sites), F24 (timezone-aware todayDate in health correlator + cultural calendar), F25 (ISO week 53 in getPrevWeekId), F26 (boundary-week startDate-only policy for monthly/yearly budget), F27 (LLM cost estimate drop-invalid validation), F28 (price store isValidPriceEntry guard at parse + persistence), F29 (shelf-life caps: leftovers 14d, pantry 365d), F30 (dead manifest config cleanup, meal_plan_dinners alignment) all fixed. H11.w review remaining fixes complete (2026-04-13) — H3 (macro-tracker corrupt YAML preservation via `preserveCorruptFile` sidecar, including schema-invalid nonempty YAML), M2 (MealMacroEntrySchema Zod validation + macro normalization in `logMealMacros`, zod added to @pas/food dependencies), L2 (callback return values captured + `services.logger.warn` on false for all three quick-meal callback handlers in index.ts). Phase CR8 (remaining review findings) complete — F37 (condition-eval mismatch), F38 (install prompt), F39 (dead register-app), F40 (duplicate app IDs), F41 (GUI XSS safeJsonForScript), F42 ({date} token alias), H6 (nutrition markdown escaping), L1 (sanitizeInput JSDoc), L3 (multilingual stopwords) all fixed or closed. Also fixed pre-existing TelegramService import bug in redeem-and-register.ts. Phase CR9 (test coverage gaps) complete — all 14 test gaps from review Phases 9-10 addressed: 9 confirmed already covered, 5 new tests added (scope parent-traversal regression, Markdown escaping regression suite, unknown-model cost cap guard integration, GUI edit-page XSS script-context escaping for reports and alerts, alert {date} path token expansion). **5811 tests passing across 230 test files. All 42 codebase review findings (F1-F42) fully resolved and covered.**

**GUI cleanup (2026-04-10):** Left sidebar navigation (all 10 nav items moved to sticky sidebar, top bar keeps PAS brand + Dashboard + theme + logout); Users page groups column replaced with space checkboxes (auto-save on toggle, linked to SpaceService.listSpaces()); admin self-removal UX protection (Remove button disabled for sole admin); scheduler lastRunAt persisted to `data/system/cron-last-run.json` (survives restarts); dashboard Claude Model now reads from ModelSelector instead of stale .env value.

**D14 + D39 fixes (2026-04-13):** D14 — strict load-time validation for reports, alerts, spaces, and pas.yaml. New `readYamlFileStrict()` discriminated-union loader; `safeValidateReport/Alert()` wrappers guard against validator exceptions on garbage input; `_validationErrors` transient field attached at load, stripped before write, gated in `run()`/`evaluate()`; invalid spaces excluded from operational map; pas.yaml validated with Zod (fail fast at startup). D39 — GUI report/alert edit forms now expose scope radio (user/space) + space dropdown; `parseFormToReport`/`parseFormToAlert` parse `section_scope_*/ds_scope_*` with space_id/user_id mutual exclusion; SpaceService wired into both route registrations; validation error banners in edit views + warning badges in list views. **5856 tests passing across 235 test files.**

**Phase D1 (2026-04-13):** Chatbot context & conversation quality — `classifyPASMessage()` replaces 66-keyword static list with fast-tier LLM classifier (fail-open, extensible for D2); `buildUserContext()` injects spaceName + enabled apps into both prompt paths; `splitTelegramMessage()` splits at paragraph → line → hard chunk under 3800 chars; `maxTokens` raised 1024 → 2048; `auto_detect_pas` default changed `false` → `true`; all strings sanitized before LLM injection. **202 chatbot tests / 5900+ total tests passing.**

**Phase D2a complete (2026-04-13):** Scope normalization fix (virtual POSIX normalization in `findMatchingScope`), FileIndexService (in-memory file metadata index, startup rebuild, `data:changed` event subscription, path/scope/tag/date queries), frontmatter enrichment on food app write sites (recipe, receipt, price-list, grocery-list, grocery-history, nutrition-log, meal-plan, pantry, health-metrics, cultural-calendar). **Post-review (D2a-review):** empty-scopes bug, payload validation (operation enum + SAFE_SEGMENT + posix.normalize), reindexByPath safety, untrusted data annotation, recipe entity_keys cap. **6023 tests passing across 241 test files.** **Phase D2b complete (2026-04-13):** DataQueryService + chatbot wiring — NL data queries over FileIndexService. Chatbot classifier (YES_DATA) routes data questions to DataQueryService; dataContext injected into system prompt with sanitization. End-of-phase review fixes: S1 (sanitize dataContext), S2 (tighten fallback regex for negative/float IDs), S3 (realpath path hardening), S4 (suppress llm/costs categories for data queries), S5 (bootstrap lazy facade graceful fallback). /ask now uses LLM classifier (consistent with handleMessage path). **6103 tests passing across 243 test files.** **Phase D2c complete (2026-04-14):** InteractionContextService (per-user circular buffer, 5 entries, 10-min TTL), DataQueryService context hints (recentFilePaths, `[recent interaction]` label), food app interaction recording at 5 write sites, chatbot classifier context injection + recentFilePaths wiring, router context-aware promotion (`classifyWithLowConfidence` + `tryContextPromotion`, verifier-always invariant), food DataQuery fallback (recent context OR keyword gating), `formatDataAnswer` shared utility, `generateDiff` LCS unified diff with 3000-char truncation, EditService (proposeEdit/confirmEdit, SHA-256 stale-write guard, per-path PathLock, realpath containment at propose+confirm, `data:changed` event, JSONL audit log at `data/system/edit-log.jsonl`), chatbot `/edit` command (diff preview + sendOptions confirm/cancel + TTL enforcement). **6251 tests passing across 257 files.**

**Phase D3 complete (2026-04-14):** Security Hardening (4 Codex audit findings). Secure cookie flag on `pas_auth` and `pas_csrf` (`secure: true` when `NODE_ENV=production` or `GUI_SECURE_COOKIES=true`), applied to login setCookie, logout clearCookie, invalid-auth clearCookie, and CSRF setCookie. Auth guard and CSRF hook reissue cookies with current secure policy on every request (upgrades pre-hardening cookies). Inline `onclick` handlers with untrusted data replaced by `data-*` attributes + global delegated click handler in `layout.eta` (file picker `data-pick-path`/`data-pick-target`/`data-close-browser`, confirm dialogs `data-confirm-delete`). File picker `target` query parameter validated against `^[A-Za-z0-9_-]+$` with `encodeURIComponent` in `hx-get` URLs. CSRF tokens added to spaces delete and create/edit forms (pre-existing gap). Docker `Dockerfile` updated to copy all 4 app `package.json` files before `pnpm install` for correct layer caching. Scope normalization (finding 2) confirmed already fixed in D2a. **6272 tests passing across 257 files.**

**DataQueryService shared-scope fix (2026-04-14):** `getAuthorizedEntries()` was incorrectly hiding all `users/shared/` files for users who belong to a space (the `includeShared` flag was `false` when `userSpaces.length > 0`). Shared data is household-wide and should always be visible regardless of space membership — space membership only gates *space-scoped* data. Fixed by removing the conditional and returning `true` for the `'shared'` case. Also added 2 receipt/price query intents to `apps/food/manifest.yaml` so NL queries route to the food app. **6273 tests passing across 257 files.**

See `docs/implementation-phases.md` for detailed phase guide.

### Deployment Readiness Roadmap (D1-D6)
Spec: `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md`. Target: Mac Mini deployment for owner's household, scaling to 5-10 households (15-40 users).
- **Phase D1** — Chatbot Context & Conversation Quality: LLM-based PAS context detection (replaces 66+ hardcoded keywords), user profile grounding (spaceName + enabled apps), token cap raise to 2048 + Telegram message splitting. **Status: complete (2026-04-13).**
- **Phase D2** — NL Data Access: decomposed into D2a/D2b/D2c. **D2a complete (2026-04-13):** FileIndexService (in-memory file metadata index, startup rebuild, `data:changed` event subscription), scope normalization fix in `findMatchingScope`, frontmatter enrichment on all food app write sites. **D2b complete (2026-04-13):** DataQueryService + chatbot wiring — NL queries via YES_DATA classifier, realpath path hardening, sanitized dataContext, /ask uses LLM classifier. **D2c complete (2026-04-14):** InteractionContextService (per-user circular buffer, 5 entries, 10-min TTL), DataQueryService context hints (recentFilePaths bypass pre-filter, `[recent interaction]` label), food app interaction recording at 5 write sites, chatbot classifier context injection, router context-aware promotion via `classifyWithLowConfidence` + `tryContextPromotion`, food DataQuery fallback, `formatDataAnswer` shared utility, `generateDiff` LCS-based unified diff, EditService (proposeEdit/confirmEdit with SHA-256 stale-write guard, PathLock, realpath containment, `data:changed` event, JSONL audit log), chatbot `/edit` command with diff preview + sendOptions confirm/cancel. **6251 tests passing across 257 files.**
- **Phase D3** — Security Hardening: secure cookie (auth+CSRF, with reissue upgrade), inline JS→data-attributes, target validation, CSRF in spaces forms, Docker dep gap. Scope normalization confirmed already fixed in D2a. **Status: complete (2026-04-14).**
- **Phase D4** — Concurrency & Ops: FileMutex (reuse AsyncLock), health endpoint upgrade, backup mechanism, deployment docs.
- **Phase D5** — Multi-Household Scalability: onboarding flow, per-household data isolation audit, per-space rate limiting + cost caps.
- **Phase D6** — Persistent Interaction Context: InteractionContextService is currently in-memory only (clears on restart, 10-min TTL, 5-entry circular buffer). Persist interaction records to disk so context-aware routing promotion and DataQueryService `recentFilePaths` hints survive restarts. Also consider extending TTL or making it configurable. Discovered 2026-04-14: after restarting the server, follow-up questions about recently captured data fail because all interaction context is lost.

### Deferred / Future Items
- **Phase 27B** — FileIndexService: superseded by Phase D2's FileIndexService design (file-native graph with metadata indexing, `data:changed` event subscription, deterministic graph edge derivation)
- **Phase 27C** — CrossAppDataService + LinkResolver: read-only cross-app file access. Deferred until D2 proves needed
- **Infra: Per-User Config Runtime Propagation** — **FIXED 2026-04-09.** A unified `requestContext` AsyncLocalStorage (replacing the former `llmContext`) now propagates the active `userId` through every dispatch point (message, command, photo, callback, scheduled job, alert action, API message, GUI simulated message). `AppConfigServiceImpl` reads `getCurrentUserId()` from the request context, so `services.config.get(key)` automatically returns the calling user's override. Scheduled jobs declared `user_scope: all` are now invoked once per registered user by the scheduler inside a per-user context, and `AppModule.handleScheduledJob(jobId, userId?)` receives that userId. Canonical regression tests: `core/src/services/config/__tests__/per-user-runtime.integration.test.ts` (core fence) and `apps/food/src/__tests__/handlers/nutrition-per-user-config.integration.test.ts` (food app fence).
- **Phase H11.y** — **COMPLETE 2026-04-09.** Guided button flows for nutrition target-setting (`targets-flow.ts`) and hosting guest-add (`guest-add-flow.ts`); adherence period picker; NL routing for `isTargetsSetIntent` / `isAdherenceIntent` / extended `isNutritionViewIntent`.
- **Phase H12a** — **COMPLETE 2026-04-09.** 5 food event emitters wired at canonical call sites (`food:meal-plan-finalized`, `food:grocery-list-ready`, `food:recipe-scheduled`, `food:meal-cooked`, `food:shopping-completed`); `health:daily-metrics` subscriber persisting to per-user `health/YYYY-MM.yaml`; `health-correlator.ts` (standard-tier LLM, ≤3 observational insights with disclaimer, prompt-injection defense, insight type-guard); `weekly-health-correlation` scheduled job; `isHealthCorrelationIntent` NL intent (9 patterns covering real user phrasing) + handler; `HEALTH_CORRELATION_GUARD` preventing nutrition-view bleed. Post-review hardening: `isCorrelationInsight` type guard on LLM output, `metrics` field guard in subscriber, date format validation in `upsertDailyHealth`, `userId` guard in `loadMonthlyHealth`, `itemsPurchased` semantic fix in shopping-followup, period disclosure "(last 14 days)" in insight response. Key files: `apps/food/src/events/` (types/emitters/subscribers), `apps/food/src/services/health-store.ts`, `apps/food/src/services/health-correlator.ts`, `apps/food/src/handlers/health.ts`.
- **Phase H12b** — **COMPLETE 2026-04-10.** Cultural calendar with 15 default holidays; deterministic date computation (fixed, nthWeekday, Easter Computus, lunisolar lookup tables); `ensureCalendar` writes defaults to shared store on first run; `isCulturalCalendarIntent` + `handleCulturalCalendarMessage` (on-demand, named-holiday aware) + `handleCulturalCalendarJob` (weekly Sunday 10am, silent when nothing upcoming); household recipe library integrated into LLM prompt; `cultural_calendar` boolean config. Key files: `apps/food/src/services/cultural-calendar.ts`, `apps/food/src/handlers/cultural-calendar-handler.ts`.
- **General: Full Telegram data access** — Any data an app stores should be readable and correctable via Telegram NL. Currently several food data stores have no viewing or editing intents (price store, receipt items, health metrics, etc.). Discovered 2026-04-10 when: (1) receipt OCR misread "HUG PU 3T-4T" as "Hugot Pumpkin Puree" with no way to correct it via Telegram, and (2) user couldn't ask "show me my Costco prices" despite price store existing at `shared/food/prices/{store}.md`. Each app phase should audit its stored data and ensure every store has corresponding read + correct intents. Data manually corrected 2026-04-10.
- **LLM Enhancement Opportunities** — Future plan documented at `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`. Main focus: stop discarding LLM route intent metadata before app handlers, reduce Food app regex/keyword routing in favor of fast structured classification/extraction, improve DataQuery/knowledge retrieval selectors, and evaluate agentic helpers for routing learning, data stewardship, OCR QA, household planning, ops summaries, and app onboarding.
- **Phase H12c** — Alcohol + Meal Quality Signals. Alcohol NL logging (`isAlcoholLogIntent` → fast-tier LLM extracts units+type → `upsertDailyHealth`); meal quality/heaviness flag (`isMealQualityLogIntent` → deterministic keyword heuristic → `processedFoodDay`/`heavyMealDay`); correlator table updated with `alcohol_units`, `alcohol_type`, `processed_food`, `heavy_meal` columns. Hydration explicitly out of scope. Deferred pending H12a stabilization.
- **Fitness/Health app (future)** — Subjective signals (`energyLevel`, `mood`, stress scores from wearables like Garmin) belong in a dedicated fitness app, not the food app. The food app's `HealthDailyMetricsPayload` intentionally omits these fields. When a fitness app is created, it should emit `health:daily-metrics` events with those fields, which the food correlator will automatically pick up (the column inclusion is already conditional on data presence).
- **One-off task user scope** — `OneOffTask` schema has no `user_scope` field; all one-off tasks currently run with `userScope: 'system'` (single execution, no per-user context). Apps that need per-user one-off tasks would need the `OneOffTask` schema extended with a `user_scope` field and corresponding bootstrap wiring.
- **App registry/marketplace** — static JSON index files. Deferred until enough apps exist
- **App signing** — cryptographic verification. Deferred until community forms
- **Container isolation** — for untrusted apps. Deferred until community forms
