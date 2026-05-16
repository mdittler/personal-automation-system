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

All major phases — infrastructure, food app, security, deployment, conversation memory (Hermes), LLM enhancement, and Persona Regression — are complete. See `docs/implementation-phases.md` for the per-phase history. Most recent:

- **Receipt Parser Robustness PR1** (2026-05-15) — anti-reconciliation prompt, `finishReason` plumbing, post-parse integrity check, single-shot continuation, user-readable Telegram warning. 13 URS REQ-FOOD-RECEIPT-INTEGRITY entries. PR2 (transcription oracle) blocked on operator photo delivery.
- **llama.cpp provider** (2026-05-15) — `LlamaCppProvider extends OpenAICompatibleProvider`, free local inference, coexists with Ollama. 6 URS REQ-LLM-LLAMA-CPP entries.
- **Open-Items Cleanup Batches 1–5** (2026-05-07) — `/flushmemory`, `SessionControlLogger` telemetry, `chat.recall.max_window_days`, GUI cleanup, food micro-fixes, P4 freeze integration coverage. ~470 test files / ~10,368 tests passing after the batch sweep.
- **Hermes P6 + P6.next** (2026-05-05) — typed memory + temporal recall + NL temporal precision broadening + mid-session snapshot rebuild. 27 URS entries (REQ-CONV-KIND, REQ-CONV-TEMPORAL, REQ-CONV-MEMORY-013..022).
- **Hermes P5 carry-forwards** (2026-05-05) — `/recall` command + `<session-search>` pseudo-tool. 21 URS REQ-CONV-RECALL + REQ-CONV-TOOL-SEARCH entries.

Original deployment-readiness spec: `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md`.

### Current Priority: Receipt Parser Robustness — PR1 (complete, branch `worktree-food+receipt-robustness`, 2026-05-15)
**Goal:** Operator reported a real-world Costco-receipt failure: parser dropped the last line item AND inflated an earlier item's price so the printed total still tied out. PR1 layers defense — anti-reconciliation prompt, generous maxTokens, `finishReason` plumbed through all four providers, deterministic post-parse integrity check, single-shot continuation, user-readable Telegram warning. PR2 (transcription oracle in the regression suite) is the primary defense against the consistent-fudging case the parser cannot self-detect; PR2 is blocked on operator delivery of 5 receipt photos + transcriptions per the Chunk A.2 carry-forward in `docs/open-items.md`.

**Approach:** Six TDD batches in `food/receipt-robustness` worktree, one commit each. Plan: `~/.claude/plans/yea-lets-start-a-foamy-pnueli.md`.

**Batch 1 — `finishReason` plumbing:** new `LLMFinishReason` type + required field on `LLMCompletionResult`; per-provider mapping (Anthropic stop_reason, OpenAI choices[0].finish_reason, Google candidates[0].finishReason, Ollama done_reason with `eval_count >= maxTokens` fallback for older SDKs); unknown → 'other'; new `LLMService.completeWithMeta` (text + finishReason + usage); `complete()` unchanged for backward compat; `LLMGuard` + `SystemLLMGuard` implement the new method; stub-llm-provider + mock-services + every existing test fixture updated.

**Batch 2 — Prompt + maxTokens + line-item normalization:** anti-reconciliation block appended to `buildReceiptPrompt` (don't adjust prices, omit unreadable items, emit total as printed, negative totals are real); parser switched to `completeWithMeta` with `maxTokens: 8192`; `isValidReceiptLineItem` accepts negative `totalPrice` (discount/coupon/return lines); `normalizeReceiptLineItem` defaults missing quantity to 1 and unitPrice to null.

**Batch 3 — Post-parse integrity check:** `ReceiptVerificationWarning` enum (`sum_mismatch`, `line_arithmetic_mismatch`, `output_truncated`, `continuation_unresolved`); `validateReceiptIntegrity` with reference chain `subtotal → total-tax → total` (strict 1% tolerance for first two, loose 2% for `total` fallback); per-line `|q·u − total| > $0.50` check skipped when `unitPrice` is null; boundary tests at exactly $1, $1.01, $2-on-$1000; explicit documented-limitation test confirming the parser CANNOT detect self-consistent inflation (PR2's domain).

**Batch 4 — Persist warnings + Telegram warning:** receipt YAML body (NOT the Obsidian frontmatter block, which is search/index shape) gains `verification_warnings:` array only when non-empty; Telegram confirmation appends `⚠️ I could not fully verify every line item on this receipt. Please double-check it.` (user-readable; raw codes never shown to user, logged at warn level instead with userId + receiptId).

**Batch 5 — Continuation pass:** on first `finishReason === 'length'`, fires exactly one continuation call with the photo and the items already parsed; multiset merge by `(lowercased-name, totalPrice-cents)` preserves duplicates at different prices and dedupes accidental re-listings; successful continuation that resolves sum mismatch strips both `output_truncated` and `continuation_unresolved`; failed/unresolved continuation emits both; single-retry cap means at most two LLM calls per receipt.

**Batch 6 — URS + docs:** 13 new REQ-FOOD-RECEIPT-INTEGRITY entries (001..013) with full traceability matrix rows; three accepted-risks entries in `docs/open-items.md` (single-shot continuation cap, self-consistent inflation parser blindness, Ollama heuristic false positives transparently resolved by continuation).

**Tests:** 11,536 root tests pass (+36 from this phase across `core/src/services/llm/__tests__/providers/`, `core/src/services/llm/__tests__/llm-service.test.ts`, `apps/food/src/utils/__tests__/photo-validators.test.ts`, `apps/food/src/services/__tests__/receipt-parser.test.ts`, `apps/food/src/__tests__/photo-handler.test.ts`).

### Previous Priority: Regression GUI Polish — SSE Reconnect + Manifest Default + Doc Supersession (complete, branch `regression/gui-rework-v2`, 2026-05-13)
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

Earlier "Previous Priority" entries (Regression GUI Rework v2, model-override surface, stronger-routing-model sweep, Chunk C Codex correction phase) are archived in `docs/implementation-phases.md` under "Archived from CLAUDE.md (2026-05-15)".

Spec / plan pointers:
- LLM enhancement #2 plan: `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`
- D5c per-household governance plan: `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`

### Open Items
See `docs/open-items.md` for all deferred phases, unfinished corrections, proposals, and accepted risks.

## AI Assistant Directives

- You are not constrained by human development timelines. **Within the scoped phase, implement the complete vertical slice; do not defer required safety, tests, or docs.**
