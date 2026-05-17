# Personal Automation System (PAS)

## Project Overview

A local-first home automation platform where users interact through a single Telegram bot. The infrastructure handles message routing, scheduling, data storage, LLM access, multi-user management, audio output, condition evaluation, and a management interface. Apps are modular plugins that implement specific functionality. Apps can be developed independently and shared between PAS instances as git repos.

**Architectural and operational details live in plugin skills (`pas-llm-architecture`, `pas-app-system`, `pas-testing-standards`, `pas-urs-workflow`, `pas-security-posture`, `pas-documentation-maintenance`). Invoke them by name when the topic comes up.**

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

LLM architecture (multi-provider, tiers, security boundary, banned imports, guards, cost tracking, model selection, llama.cpp) is in the `pas-llm-architecture` skill.

### App System

App system patterns (manifests, distribution, install-time trust model, message routing priority, route verification) are in the `pas-app-system` skill.

### Chatbot & App Awareness
- **Chatbot app** — full conversational AI fallback. Per-user conversation history (20 turns), context store integration, graceful LLM failure degradation
- **`/ask` command** — app-aware system prompt with AppMetadataService + AppKnowledgeBase + SystemInfoService
- **Model journal** — per-model markdown files at `data/model-journal/{model-slug}.md`, `<model-journal>` tag extraction from LLM responses
- **"Hermes" is a codename, not a product name** — the long-term memory system's phase work (`Hermes P1`–`P9` etc., spec filenames, commit history) is codenamed "Hermes" after [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent), the repo whose memory framework was the conceptual starting point. The system itself is just "long-term memory" / the ConversationService stack. Public-facing docs should not call the system "Hermes"; internal phase labels stay as historical codenames.

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
- **Comprehensive testing patterns and standards are in the `pas-testing-standards` skill. URS workflow and traceability matrix are in the `pas-urs-workflow` skill.**

### Deferred Work Tracking
- **`docs/open-items.md` is the single source of truth for all deferred, out-of-scope, and follow-up work.** Every spec, plan, and findings doc that explicitly defers something must have a corresponding entry in `docs/open-items.md` before the session ends.
- If a task is described as "deferred", "out of scope", "future phase", "follow-up", or "to be done in a later session", it must be added to `docs/open-items.md` under the appropriate section: Confirmed Phases, Deferred Infrastructure Work, Unfinished Corrections, Food App Enhancements, Proposals, or Accepted Risks.
- A `PostToolUse` hook (`check-deferred-work.sh`) automatically reminds you when you write to a spec or plan doc that contains deferred-work language. Do not dismiss this reminder without acting on it.

### Post-Phase Simplify Pass
After a phase merges, a brief cleanup commit is allowed before starting the next phase. Rules:
- **Phase footprint only** — touch only files that were part of the completed phase. No opportunistic cleanup of unrelated code.
- **No restructuring** — rename, extract, or reorganize only if the change is obviously correct and risk-free (e.g., a duplicated helper that is clearly safe to DRY). Do not refactor logic.
- **Separate commit** — the simplify pass must be its own commit, clearly labeled (e.g., `refactor(hermes-p7): post-merge simplify pass`), so it is easy to revert if it causes regressions.
- **Zero failing tests** — run `pnpm test` before committing the simplify pass. If any test is red, fix it first.
- **Triggered by** — dead code found during review, duplicated helpers within the phase, spurious comments, or a reviewer explicitly noting a cleanup opportunity. Not every phase needs one.

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

All major phases — infrastructure, food app, security, deployment, conversation memory (Hermes), LLM enhancement, and Persona Regression — are complete. **Per-phase history (including the full batch-by-batch breakdown of every Current/Previous Priority) lives in `docs/implementation-phases.md`.** Most recent phases (one line each, newest first):

- **Receipt Parser Robustness PR2 — Transcription Oracle** (2026-05-15) — operator-authored `.transcription.yaml` ground truth + SHA256 sidecars; drift resistance + confidence tiers. 11 REQ-FOOD-RECEIPT-TRANSCRIPTION URS entries.
- **Receipt Parser Robustness PR1** (2026-05-15) — anti-reconciliation prompt, `finishReason` plumbing, integrity check, single-shot continuation, Telegram warning. 13 REQ-FOOD-RECEIPT-INTEGRITY URS entries.
- **Persona Regression Suite Chunk A.2** (2026-05-15) — 5 receipt fixtures + `multisetRows` structural oracle + receipt-bucket cache key salting.
- **llama.cpp provider** (2026-05-15) — `LlamaCppProvider extends OpenAICompatibleProvider`. 6 REQ-LLM-LLAMA-CPP URS entries.
- **Open-Items Cleanup Batches 1–5** (2026-05-07) — `/flushmemory`, telemetry, GUI cleanup, food micro-fixes, P4 freeze coverage.
- **Hermes P6 + P6.next** (2026-05-05) — typed memory + temporal recall + mid-session snapshot rebuild. 27 URS entries.
- **Hermes P5 carry-forwards** (2026-05-05) — `/recall` command + `<session-search>` pseudo-tool. 21 URS entries.

Spec pointers: deployment-readiness — `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md`; LLM enhancement #2 — `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`; D5c — `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`.

**Open items:** see `docs/open-items.md` for all deferred phases, unfinished corrections, proposals, and accepted risks.

### Implementation Status Discipline (anti-bloat rule)

**This section must not grow.** When a new phase completes, do the following — *do not* add a "Current Priority" or "Previous Priority" prose block in CLAUDE.md.

1. Write the full batch-by-batch breakdown (Goal / Approach / Batch detail / Codex review rounds / Tests) **directly into `docs/implementation-phases.md`** under a new dated section. That file is the canonical home for phase prose.
2. Add **one bullet** to the Implementation Status list above — date + phase name + one short clause + URS-entry count. Keep it under one line of soft-wrapped Markdown.
3. Demote the oldest bullet off the list if the list grows beyond ~8 entries; the demoted entry's prose already lives in `docs/implementation-phases.md`.
4. **No "Current Priority" or "Previous Priority" headings in CLAUDE.md.** When operator briefing on current work is needed, point at `docs/implementation-phases.md` (newest section first) and the active spec/plan link.

The PR Batch 6 ("URS + docs") commit must follow this rule. Bloat-by-PR is what previously inflated CLAUDE.md from a one-page brief into a multi-page log.

## AI Assistant Directives

- You are not constrained by human development timelines. **Within the scoped phase, implement the complete vertical slice; do not defer required safety, tests, or docs.**
