# PAS User Requirements Specification

| Field | Value |
|-------|-------|
| **Doc ID** | PAS-URS-INFRA-001 |
| **Purpose** | Functional and non-functional requirements with test coverage mapping |
| **Status** | Active |
| **Last Updated** | 2026-03-21 |

## Conventions

- **Requirement ID format:** `REQ-<AREA>-<NNN>` (e.g., `REQ-DATA-001`)
- **Status values:** `Implemented` | `Planned` | `Deferred`
- **Standard tests** = happy-path behavior verifying the requirement works correctly
- **Edge case tests** = all other tests: boundary conditions, error handling, invalid inputs, empty states, security (injection, unauthorized access), concurrency/timing (cooldowns, cache expiry, timeouts), state transitions (reset, re-enable, idempotency), and configuration (defaults, overrides, missing values). See CLAUDE.md "Testing Thoroughness" for the full checklist.
- **Fixes** section tracks bug corrections with date and description
- **See also** cross-references related requirements to avoid excessive duplication
- When a test verifies multiple requirements, it appears under each; use "See also" for the primary

### Area Codes

| Code | Scope |
|------|-------|
| MANIFEST | App manifest validation and schema |
| DATA | DataStore, ScopedStore, ChangeLog |
| LOG | Logging infrastructure |
| EVENT | Event bus |
| SCHED | Scheduling (cron, one-off, task runner) |
| COND | Condition evaluator, rules, cooldowns |
| LLM | LLM services, providers, guards, cost tracking |
| CONFIG | System configuration loading |
| ROUTE | Message routing (commands, intents, photos, fallback) |
| TG | Telegram gateway (adapter, service) |
| REGISTRY | App registry (loader, cache, registration) |
| USER | User management and authorization |
| RATELIMIT | Rate limiting |
| TOGGLE | App enable/disable toggles |
| CTX | Context store |
| DIFF | Daily diff and change tracking |
| AUDIO | Audio/TTS service |
| SERVER | HTTP server, webhooks, health |
| GUI | Management GUI (auth, routes) |
| UTIL | Utility functions (date, file, YAML) |
| SEC | Cross-cutting security |
| APPMETA | App metadata service |
| APPKNOW | App knowledge base service |
| NFR | Non-functional requirements |
| INTEG | Integration / E2E |
| JOURNAL | Model journal service |
| SCAFFOLD | App scaffold CLI |
| EXAMPLE | Example apps |
| DOC | Developer documentation |
| SECRETS | App secrets service |
| REPORT | Scheduled reports system |
| ALERT | Conditional alerts system |
| FMATTER | Frontmatter generation, parsing, file append |

---

## 1. Manifest & Schema Validation

### REQ-MANIFEST-001: Manifest structure validation

**Phase:** 1 | **Status:** Implemented

App manifests must be validated against the JSON Schema. Valid manifests (minimal, full-featured, bare minimum) must be accepted. Invalid manifests must be rejected with human-readable error messages.

**Standard tests:**
- `validate-manifest.test.ts` > valid manifests > accepts the echo app manifest (minimal)
- `validate-manifest.test.ts` > valid manifests > accepts a full-featured manifest with all optional fields
- `validate-manifest.test.ts` > valid manifests > accepts a bare minimum manifest (only app identity)
- `validate-manifest.test.ts` > user_config constraints > accepts select type with options provided
- `validate-manifest.test.ts` > service enum validation > accepts all valid service names

**Edge case tests:**
- `validate-manifest.test.ts` > missing required fields > rejects manifest without app block
- `validate-manifest.test.ts` > missing required fields > rejects manifest without app.id
- `validate-manifest.test.ts` > missing required fields > rejects manifest without app.name
- `validate-manifest.test.ts` > missing required fields > rejects manifest without app.version
- `validate-manifest.test.ts` > invalid patterns > rejects app.id with uppercase letters
- `validate-manifest.test.ts` > invalid patterns > rejects app.id starting with a number
- `validate-manifest.test.ts` > invalid patterns > rejects invalid semver version
- `validate-manifest.test.ts` > invalid patterns > rejects command not starting with /
- `validate-manifest.test.ts` > invalid patterns > rejects invalid cron expression
- `validate-manifest.test.ts` > integration constraints > rejects integration with required: true
- `validate-manifest.test.ts` > user_config constraints > rejects select type without options
- `validate-manifest.test.ts` > service enum validation > rejects unknown service names
- `validate-manifest.test.ts` > additional properties > rejects unknown top-level properties
- `validate-manifest.test.ts` > error formatting > returns human-readable error strings

**Fixes:** None

---

## 2. Data Store

### REQ-DATA-001: Scoped file read/write operations

**Phase:** 2 | **Status:** Implemented

The DataStore must provide per-user, per-app scoped file operations: write, read, append, exists check, and file listing. Parent directories are created automatically. Reading a non-existent file returns an empty string.

**Standard tests:**
- `scoped-store.test.ts` > write + read > writes and reads a file
- `scoped-store.test.ts` > write + read > creates parent directories when writing
- `scoped-store.test.ts` > write + read > overwrites existing file
- `scoped-store.test.ts` > append > appends to an existing file
- `scoped-store.test.ts` > exists > returns true for existing file
- `scoped-store.test.ts` > exists > returns true for existing directory
- `scoped-store.test.ts` > list > lists files in a directory (sorted)
- `scoped-store.test.ts` > list > lists files at root level

**Edge case tests:**
- `scoped-store.test.ts` > write + read > returns empty string when reading non-existent file
- `scoped-store.test.ts` > append > creates file if it does not exist
- `scoped-store.test.ts` > append > creates parent directories when appending
- `scoped-store.test.ts` > exists > returns false for non-existent file
- `scoped-store.test.ts` > list > returns empty array for non-existent directory
- `scoped-store.test.ts` > path traversal protection > allows nested paths within scope

**Fixes:** None

### REQ-DATA-002: File archive operations

**Phase:** 2 | **Status:** Implemented

The DataStore must support archiving files by renaming them with a timestamp suffix. Content must be preserved. Archiving a non-existent file is a no-op.

**Standard tests:**
- `scoped-store.test.ts` > archive > moves a file to an archive name with timestamp
- `scoped-store.test.ts` > archive > preserves content in the archive file

**Edge case tests:**
- `scoped-store.test.ts` > archive > does nothing for non-existent file

**Fixes:** None

### REQ-DATA-003: Change log recording

**Phase:** 2 | **Status:** Implemented

All data mutations must be recorded in a JSONL change log with timestamp, operation type, file path, app ID, and user ID. The log must support all operation types (read, write, append, archive).

**Standard tests:**
- `change-log.test.ts` > creates the log file on first record
- `change-log.test.ts` > writes JSONL format (one JSON object per line)
- `change-log.test.ts` > records all operation types
- `change-log.test.ts` > includes app ID when provided (added in URS audit)
- `change-log.test.ts` > records ISO 8601 timestamps
- `change-log.test.ts` > returns the correct log path

**Edge case tests:**
- `change-log.test.ts` > uses "system" for null userId

**Concurrency tests:**
- `change-log.test.ts` > handles concurrent record() calls without losing entries

**Fixes:** None

**See also:** REQ-SEC-001 (path traversal protection)

---

## 3. Logging

### REQ-LOG-001: Structured logging infrastructure

**Phase:** 2 | **Status:** Implemented

The system must provide structured logging via Pino with configurable log levels, child logger creation with service/app context, and pretty-printing in development mode.

**Standard tests:**
- `logger.test.ts` > creates a logger instance with default options
- `logger.test.ts` > respects the log level option
- `logger.test.ts` > creates child loggers with context
- `logger.test.ts` > creates child loggers with app context

**Edge case tests:**
- `logger.test.ts` > defaults to info level when no level specified
- `logger.test.ts` > creates child logger with empty context object
- `logger.test.ts` > creates child logger with both service and appId context

**Fixes:** None

---

## 4. Event Bus

### REQ-EVENT-001: Publish/subscribe event system

**Phase:** 3 | **Status:** Implemented

The system must provide an async pub/sub event bus. Events must be delivered to all subscribers. Subscriber failures must not prevent delivery to other subscribers. Unsubscribing must stop event delivery.

**Standard tests:**
- `event-bus.test.ts` > emits events to subscribers
- `event-bus.test.ts` > supports multiple subscribers on same event
- `event-bus.test.ts` > unsubscribes with off()
- `event-bus.test.ts` > handles async handlers

**Edge case tests:**
- `event-bus.test.ts` > isolates subscriber failures (URS-EVT-003)
- `event-bus.test.ts` > does not emit to unrelated event subscribers
- `event-bus.test.ts` > clearAll removes all listeners

**Fixes:** None

### REQ-EVENT-002: DataStore emits data:changed events

**Phase:** Post-26 | **Status:** Implemented

ScopedStore must emit a `data:changed` event via EventBus on every `write()`, `append()`, and `archive()` operation. Read-only operations (`read()`, `list()`, `exists()`) must NOT emit events. The event payload must include `operation`, `appId`, `userId`, `path`, and optionally `spaceId`. When no EventBus is provided (backward compatibility), operations must succeed silently without emitting.

**Standard tests:**
- `scoped-store.test.ts` > data:changed events > emits data:changed on write
- `scoped-store.test.ts` > data:changed events > emits data:changed on append
- `scoped-store.test.ts` > data:changed events > emits data:changed on archive
- `scoped-store.test.ts` > data:changed events > includes spaceId when present
- `scoped-store.test.ts` > data:changed events > emits userId: null for shared scope (forShared)

**Edge case tests:**
- `scoped-store.test.ts` > data:changed events > does NOT emit on read
- `scoped-store.test.ts` > data:changed events > does NOT emit on list
- `scoped-store.test.ts` > data:changed events > does NOT emit on exists
- `scoped-store.test.ts` > data:changed events > succeeds without eventBus (backward compat)
- `scoped-store.test.ts` > data:changed events > does not emit on archive of non-existent file
- `scoped-store.test.ts` > data:changed events > write succeeds even if eventBus.emit throws
- `scoped-store.test.ts` > data:changed events > concurrent writes each emit their own event

**Integration tests:**
- `data.test.ts` > write triggers data:changed event
- `data.test.ts` > append triggers data:changed event

**Fixes:** None

---

## 5. Scheduling

### REQ-SCHED-001: Cron job management

**Phase:** 3 | **Status:** Implemented

The scheduler must support registering cron jobs with valid cron expressions and timezone-aware execution. Duplicate job registrations and invalid cron expressions must be rejected gracefully. Multiple apps can register independent jobs.

**Standard tests:**
- `cron-manager.test.ts` > registers a cron job
- `cron-manager.test.ts` > registers multiple jobs from different apps
- `cron-manager.test.ts` > start and stop do not throw
- `cron-manager.test.ts` > passes timezone option to node-cron createTask

**Edge case tests:**
- `cron-manager.test.ts` > rejects duplicate job registration
- `cron-manager.test.ts` > rejects invalid cron expressions

**Fixes:** None

### REQ-SCHED-002: One-off task scheduling with persistence

**Phase:** 3 | **Status:** Implemented

The scheduler must support one-off tasks that persist to YAML and survive process restarts. Due tasks must be executed and removed. Future tasks must be preserved. Tasks can be cancelled.

**Standard tests:**
- `oneoff-manager.test.ts` > schedules a task and persists to YAML
- `oneoff-manager.test.ts` > executes due tasks and removes them
- `oneoff-manager.test.ts` > survives reload (persistence)
- `oneoff-manager.test.ts` > handles multiple apps

**Edge case tests:**
- `oneoff-manager.test.ts` > replaces an existing task with the same ID
- `oneoff-manager.test.ts` > cancels a pending task
- `oneoff-manager.test.ts` > cancelling non-existent task is a no-op
- `oneoff-manager.test.ts` > keeps future tasks after executing due tasks

**Error handling tests:**
- `oneoff-manager.test.ts` > rejects scheduling with invalid Date (NaN)

**Fixes:** None

### REQ-SCHED-003: Task execution with error isolation

**Phase:** 3 | **Status:** Implemented

Task execution must return structured results (success/failure, timing, error details). Handler errors must be captured in the result, never thrown. Handlers must be called exactly once.

**Standard tests:**
- `task-runner.test.ts` > returns success result on successful execution
- `task-runner.test.ts` > calls the handler exactly once

**Edge case tests:**
- `task-runner.test.ts` > returns failure result on handler error
- `task-runner.test.ts` > handles non-Error thrown values
- `task-runner.test.ts` > does not throw — errors are captured in result

**Fixes:** None

### REQ-SCHED-004: Scheduled job logging

**Phase:** 3 | **Status:** Implemented

The task runner must log start time, end time, success/failure, and duration of every scheduled job execution.

**Standard tests:**
- `task-runner.test.ts` > returns success result on successful execution (already in REQ-SCHED-003)

**Edge case tests:**
- `task-runner.test.ts` > returns failure result on handler error (already in REQ-SCHED-003)

**See also:** REQ-SCHED-003

**Fixes:** None

### REQ-SCHED-005: Failed job notification with rate limiting

**Phase:** Gap review | **Status:** Implemented

When a scheduled job fails, a notification must be sent to the admin via Telegram. Notifications must be rate-limited (configurable cooldown, default 1 hour). After a configurable number of consecutive failures (default 5), the job must be auto-disabled. Disabled jobs can be re-enabled via management GUI. Notification send failures must be swallowed.

**Standard tests:**
- `job-failure-notifier.test.ts` > onFailure > sends notification on first failure
- `job-failure-notifier.test.ts` > onFailure > includes failure count in notification
- `job-failure-notifier.test.ts` > onFailure > increments consecutive failure count
- `job-failure-notifier.test.ts` > onFailure > tracks different jobs independently
- `job-failure-notifier.test.ts` > onFailure > sends notification to admin chat ID
- `job-failure-notifier.test.ts` > onSuccess > resets consecutive failure count
- `job-failure-notifier.test.ts` > auto-disable > disables job after consecutive failure threshold
- `job-failure-notifier.test.ts` > auto-disable > getDisabledJobs returns all disabled job keys
- `job-failure-notifier.test.ts` > reEnable > re-enables a disabled job
- `job-failure-notifier.test.ts` > reEnable > resets failure count on re-enable

**Edge case tests:**
- `job-failure-notifier.test.ts` > notification rate limiting > suppresses notifications within cooldown window
- `job-failure-notifier.test.ts` > notification rate limiting > sends notification again after cooldown expires
- `job-failure-notifier.test.ts` > notification rate limiting > does not rate-limit different jobs against each other
- `job-failure-notifier.test.ts` > notification rate limiting > defaults to 1 hour cooldown
- `job-failure-notifier.test.ts` > auto-disable > returns false before threshold is reached
- `job-failure-notifier.test.ts` > auto-disable > sends auto-disable notification regardless of cooldown
- `job-failure-notifier.test.ts` > auto-disable > auto-disable notification includes failure count
- `job-failure-notifier.test.ts` > onSuccess > is a no-op for jobs with no failure state
- `job-failure-notifier.test.ts` > onSuccess > prevents auto-disable when interspersed with failures
- `job-failure-notifier.test.ts` > reEnable > is a no-op for jobs that are not disabled
- `job-failure-notifier.test.ts` > reEnable > resumes notifications after re-enable and subsequent failure
- `job-failure-notifier.test.ts` > isDisabled > returns false for unknown jobs
- `job-failure-notifier.test.ts` > getFailureCount > returns 0 for unknown jobs
- `job-failure-notifier.test.ts` > error handling > swallows send errors on failure notification
- `job-failure-notifier.test.ts` > error handling > swallows send errors on auto-disable notification
- `job-failure-notifier.test.ts` > config validation > rejects autoDisableAfter less than 1

**Fixes:** None

---

### REQ-SCHED-006: Per-user scheduled job dispatch

**Phase:** 30 | **Status:** Implemented

Scheduled jobs declared with `user_scope: all` in an app manifest must be invoked once per registered system user. Each invocation runs inside a per-user `requestContext` scope so that `services.config.get(key)` inside the handler resolves to that user's overrides. Scheduled jobs declared with `user_scope: shared` or `user_scope: system` must be invoked exactly once with `userId` undefined (behavior unchanged from prior phases). Errors in a single user's invocation must not abort iteration for the remaining users.

**Standard tests:**
- `per-user-dispatch.test.ts` > invokes handler once with undefined userId for user_scope: shared
- `per-user-dispatch.test.ts` > invokes handler once with undefined userId for user_scope: system
- `per-user-dispatch.test.ts` > invokes handler once per registered user for user_scope: all
- `per-user-dispatch.test.ts` > each per-user invocation is wrapped in requestContext with that user's id
- `request-context.test.ts` > returns undefined outside any run() scope
- `request-context.test.ts` > exposes userId set by run()
- `request-context.test.ts` > inner run() overrides outer run()
- `request-context.test.ts` > restores outer context after inner run() exits
- `request-context.test.ts` > propagates through awaited async boundaries
- `request-context.test.ts` > does not leak across sibling run() calls

**Edge case tests:**
- `per-user-dispatch.test.ts` > returns silently when user_scope: all has no registered users
- `per-user-dispatch.test.ts` > returns silently when the app module has no handleScheduledJob
- `per-user-dispatch.test.ts` > continues iterating after a per-user invocation throws (error isolation)
- `request-context.test.ts` > returns undefined when store is present but userId is omitted
- `request-context.test.ts` > inner run() with userId: undefined shadows the outer userId
- `request-context.test.ts` > preserves arbitrary string userIds verbatim (validation is a consumer responsibility)

**Fixes:**
- Per-user config runtime propagation (2026-04-09): before the fix, `handleScheduledJob` received only a jobId and no per-user context, so `user_scope: all` handlers had no way to know which user they were running on behalf of. Fixed by extending the signature to `(jobId, userId?)` and delegating per-user iteration to the scheduler via `buildScheduledJobHandler` (core/src/services/scheduler/per-user-dispatch.ts).

---

### REQ-SCHED-007: Dispatch-site request-context propagation

**Phase:** 30 | **Status:** Implemented

Every infrastructure dispatch point that has a userId in scope must wrap the dispatched work in `requestContext.run({ userId }, ...)` so that downstream `AppConfigService.get(key)` calls automatically resolve to the caller's per-user overrides. The unified `requestContext` AsyncLocalStorage (core/src/services/context/request-context.ts) is consumed by both the LLM cost attribution in `base-provider.ts` and the config service's `loadOverrides` path.

Dispatch sites covered:
1. Telegram message (bootstrap.ts)
2. Telegram photo (bootstrap.ts)
3. Telegram route-verification callback (bootstrap.ts)
4. Telegram app callback query (bootstrap.ts)
5. HTTP POST /api/messages (api/routes/messages.ts)
6. Alert executor `dispatch_message` action (services/alerts/alert-executor.ts)
7. Scheduled jobs with `user_scope: all` (services/scheduler/per-user-dispatch.ts — see REQ-SCHED-006)

**Standard tests:**
- `messages.test.ts` > dispatches inside requestContext so config.get resolves per-user
- `alert-executor-enhanced.test.ts` > dispatches inside requestContext so downstream config.get is per-user
- `dispatch-context-wrap.test.ts` > bootstrap.ts > every router.routeMessage call is wrapped in requestContext.run
- `dispatch-context-wrap.test.ts` > bootstrap.ts > every router.routePhoto call is wrapped in requestContext.run
- `dispatch-context-wrap.test.ts` > bootstrap.ts > the verification-callback dispatch block is wrapped in requestContext.run
- `dispatch-context-wrap.test.ts` > bootstrap.ts > the app-callback dispatch (handleCallbackQuery) is wrapped in requestContext.run
- `dispatch-context-wrap.test.ts` > api/routes/messages.ts > wraps router.routeMessage in requestContext.run
- `dispatch-context-wrap.test.ts` > services/alerts/alert-executor.ts > wraps deps.router.routeMessage in requestContext.run with the action user_id

**Edge case tests:**
- `dispatch-context-wrap.test.ts` > bootstrap.ts > imports requestContext from the context module (not from llm/)
- `dispatch-context-wrap.test.ts` > services/llm/providers/base-provider.ts > reads userId via getCurrentUserId from the unified request-context module

**Fixes:**
- Per-user config runtime propagation (2026-04-09): the former bespoke `llmContext` only served LLM cost attribution. Promoted to a unified `requestContext` also consumed by `AppConfigService` so per-user config reads work at every dispatch point. Canonical regression: `per-user-runtime.integration.test.ts`.

---

## 6. Condition Evaluator

### REQ-COND-001: Rule file parsing

**Phase:** 3 | **Status:** Implemented

The system must parse rule files in Markdown format, extracting rule ID, condition, data sources, action, cooldown, and last-fired timestamp. Both deterministic and fuzzy (LLM-evaluated) rules must be supported.

**Standard tests:**
- `rule-parser.test.ts` > parses multiple rules from a file
- `rule-parser.test.ts` > parses a deterministic rule correctly
- `rule-parser.test.ts` > parses a fuzzy rule correctly
- `rule-parser.test.ts` > handles multiple data sources

**Edge case tests:**
- `rule-parser.test.ts` > provides defaults for missing optional fields
- `rule-parser.test.ts` > skips rules without a condition
- `rule-parser.test.ts` > returns empty array for empty content

**Fixes:** None

### REQ-COND-002: Deterministic condition evaluation

**Phase:** 3 | **Status:** Implemented

The evaluator must support deterministic conditions: "not empty", "is empty", "contains", "not contains", "line count > N", "line count < N". Unrecognized conditions must default to false. Multiple data sources must be combined.

**Standard tests:**
- `evaluator.test.ts` > deterministic conditions > "not empty" returns true when data has content
- `evaluator.test.ts` > deterministic conditions > "is empty" returns true for empty data
- `evaluator.test.ts` > deterministic conditions > "contains" checks for text presence
- `evaluator.test.ts` > deterministic conditions > "not contains" checks for text absence
- `evaluator.test.ts` > deterministic conditions > "line count > N" counts non-empty lines
- `evaluator.test.ts` > deterministic conditions > "line count < N" counts non-empty lines
- `evaluator.test.ts` > multiple data sources > reads and combines multiple data sources

**Edge case tests:**
- `evaluator.test.ts` > deterministic conditions > "not empty" returns false when data is empty
- `evaluator.test.ts` > deterministic conditions > unrecognized condition defaults to false
- `evaluator.test.ts` > error handling > catches errors and returns failure result

**Fixes:** None

### REQ-COND-003: Cooldown tracking and enforcement

**Phase:** 3 | **Status:** Implemented

Rules must respect cooldown periods. Rules in cooldown must not fire. Rules that have never fired or whose cooldown has expired must be eligible. Cooldown remaining time must be calculable.

**Standard tests:**
- `cooldown-tracker.test.ts` > parseCooldown > parses minutes
- `cooldown-tracker.test.ts` > parseCooldown > parses hours
- `cooldown-tracker.test.ts` > parseCooldown > parses days
- `cooldown-tracker.test.ts` > canFire > returns true when lastFired is null (never fired)
- `cooldown-tracker.test.ts` > canFire > returns true when cooldown has expired
- `cooldown-tracker.test.ts` > getCooldownRemaining > returns remaining ms when in cooldown
- `cooldown-tracker.test.ts` > getCooldownRemaining > returns 0 when cooldown has expired
- `cooldown-tracker.test.ts` > buildRuleStatus > builds active status for never-fired rule
- `cooldown-tracker.test.ts` > buildRuleStatus > builds active status for rule with expired cooldown
- `evaluator.test.ts` > cooldowns > evaluates when cooldown has expired
- `evaluator.test.ts` > cooldowns > evaluates when rule has never fired

**Edge case tests:**
- `cooldown-tracker.test.ts` > parseCooldown > returns 0 for unrecognized formats
- `cooldown-tracker.test.ts` > canFire > returns false when within cooldown
- `cooldown-tracker.test.ts` > canFire > returns true when cooldown exactly matches elapsed time
- `cooldown-tracker.test.ts` > getCooldownRemaining > returns 0 when lastFired is null
- `cooldown-tracker.test.ts` > buildRuleStatus > builds inactive status for rule in cooldown
- `evaluator.test.ts` > cooldowns > skips evaluation when rule is in cooldown

**Fixes:** None

### REQ-COND-004: Last-fired timestamp writeback

**Phase:** 3 | **Status:** Implemented

When a rule fires, its "Last fired" timestamp must be updated in the rule file content. Updates must be scoped to the target rule only, preserving other rules in multi-rule files.

**Standard tests:**
- `last-fired-writeback.test.ts` > updates an existing Last fired line
- `last-fired-writeback.test.ts` > handles fuzzy rule IDs

**Edge case tests:**
- `last-fired-writeback.test.ts` > inserts Last fired line when missing
- `last-fired-writeback.test.ts` > only updates the target rule in a multi-rule file
- `last-fired-writeback.test.ts` > does not modify content when rule ID is not found

**Fixes:** None

### REQ-COND-005: Fuzzy (LLM-based) condition evaluation

**Phase:** 3 | **Status:** Implemented

Fuzzy rules must delegate condition evaluation to the LLM. Data content and the condition text must be included in the prompt. When no LLM is available, fuzzy rules must return false.

**Standard tests:**
- `evaluator.test.ts` > fuzzy evaluation > delegates to LLM and returns true for "yes" response
- `evaluator.test.ts` > fuzzy evaluation > delegates to LLM and returns false for "no" response
- `evaluator.test.ts` > fuzzy evaluation > passes data content in the LLM prompt

**Edge case tests:**
- `evaluator.test.ts` > fuzzy evaluation > returns false when no LLM is available

**Security tests:**
- `evaluator.test.ts` > fuzzy evaluation > prompt injection hardening > sanitizes condition containing triple backtick injection
- `evaluator.test.ts` > fuzzy evaluation > prompt injection hardening > sanitizes data containing injection attempt
- `evaluator.test.ts` > fuzzy evaluation > prompt injection hardening > truncates excessively long data
- `evaluator.test.ts` > fuzzy evaluation > prompt injection hardening > includes anti-instruction framing in prompt

**Fixes:** None

---

## 7. LLM Services

### REQ-LLM-001: Text classification via LLM

**Phase:** 4 | **Status:** Implemented

The system must classify text into categories using an LLM. The prompt must include all categories and the user text. Response parsing must handle JSON, text fallback, confidence clamping, and missing fields.

**Standard tests:**
- `classify.test.ts` > buildClassifyPrompt > includes all categories and the text
- `classify.test.ts` > buildClassifyPrompt > instructs LLM to respond with JSON
- `classify.test.ts` > parseClassifyResponse > parses valid JSON response
- `classify.test.ts` > parseClassifyResponse > extracts JSON from surrounding text

**Edge case tests:**
- `classify.test.ts` > classify > rejects empty categories array
- `classify.test.ts` > parseClassifyResponse > clamps confidence to [0, 1]
- `classify.test.ts` > parseClassifyResponse > defaults confidence to 0.8 when missing
- `classify.test.ts` > parseClassifyResponse > falls back to text matching when JSON is invalid
- `classify.test.ts` > parseClassifyResponse > falls back to text matching when JSON category is not in list
- `classify.test.ts` > parseClassifyResponse > returns first category with low confidence when nothing matches

**See also:** REQ-SEC-003 (prompt injection mitigation)

**Fixes:** None

### REQ-LLM-002: Structured data extraction via LLM

**Phase:** 4 | **Status:** Implemented

The system must extract structured data from text using an LLM and validate the result against a JSON Schema. Response parsing must handle plain JSON, markdown code blocks, and embedded JSON.

**Standard tests:**
- `extract-structured.test.ts` > buildExtractPrompt > includes the text and schema
- `extract-structured.test.ts` > parseExtractResponse > parses a plain JSON object
- `extract-structured.test.ts` > parseExtractResponse > extracts JSON from markdown code block
- `extract-structured.test.ts` > parseExtractResponse > extracts JSON from code block without language tag
- `extract-structured.test.ts` > parseExtractResponse > extracts JSON embedded in text
- `extract-structured.test.ts` > extractStructured (schema validation) > accepts data that matches schema

**Edge case tests:**
- `extract-structured.test.ts` > parseExtractResponse > throws when no JSON is found
- `extract-structured.test.ts` > parseExtractResponse > throws when JSON is malformed
- `extract-structured.test.ts` > extractStructured (schema validation) > rejects data that does not match schema

**See also:** REQ-SEC-003 (prompt injection mitigation)

**Fixes:** None

### REQ-LLM-003: Retry with exponential backoff

**Phase:** 4 | **Status:** Implemented

LLM calls must support configurable retry with exponential backoff. Default is 3 retries. Negative values must be clamped to 0. Non-Error thrown values must be handled.

**Standard tests:**
- `retry.test.ts` > returns result on first success
- `retry.test.ts` > retries on failure and succeeds eventually
- `retry.test.ts` > defaults to 3 retries

**Edge case tests:**
- `retry.test.ts` > throws last error when all retries exhausted
- `retry.test.ts` > handles non-Error thrown values
- `retry.test.ts` > does not retry when maxRetries is 0
- `retry.test.ts` > clamps negative maxRetries to 0
- `retry.test.ts` > clamps negative initialDelayMs to 0

**Fixes:** None

### REQ-LLM-004: Multi-provider routing

**Phase:** 10-12 | **Status:** Implemented

The LLM service must route requests to the correct provider based on priority: explicit `modelRef` > `tier` > legacy `model` option > default fast tier. Multiple providers must be supported concurrently.

**Standard tests:**
- `llm-service.test.ts` > routes to fast tier by default
- `llm-service.test.ts` > routes via explicit tier option
- `llm-service.test.ts` > routes via explicit modelRef (highest priority)
- `llm-service.test.ts` > routes across multiple providers
- `llm-service.test.ts` > classify() uses fast tier provider

**Edge case tests:**
- `llm-service.test.ts` > routes to standard tier when model is "claude" (backward compat)
- `llm-service.test.ts` > routes to fast tier when model is "local" (backward compat)
- `llm-service.test.ts` > supports claudeModel override with legacy model="claude"
- `llm-service.test.ts` > throws when provider is not registered
- `llm-service.test.ts` > throws when tier has no model configured
- `llm-service.test.ts` > modelRef takes priority over tier and legacy model
- `llm-service.test.ts` > ignores partial modelRef (missing provider)
- `llm-service.test.ts` > ignores partial modelRef (missing model)
- `llm-service.test.ts` > getFastClient throws when fast tier provider is not registered

**Fixes:** None

### REQ-LLM-005: Provider registry

**Phase:** 10 | **Status:** Implemented

The system must maintain a registry of LLM provider instances. Providers must be retrievable by ID. Model listing must aggregate across all providers and handle individual provider failures gracefully.

**Standard tests:**
- `provider-registry.test.ts` > registers and retrieves a provider
- `provider-registry.test.ts` > returns all providers
- `provider-registry.test.ts` > returns all provider IDs
- `provider-registry.test.ts` > aggregates models from all providers

**Edge case tests:**
- `provider-registry.test.ts` > returns undefined for unregistered provider
- `provider-registry.test.ts` > overwrites existing provider with same ID
- `provider-registry.test.ts` > skips providers that fail to list models

**Fixes:** None

### REQ-LLM-006: Base provider abstraction

**Phase:** 10 | **Status:** Implemented

All providers must extend a base class that handles retry, cost recording, and model resolution. Cost must be recorded asynchronously after completion. The `_appId` field must flow through to cost tracking.

**Standard tests:**
- `base-provider.test.ts` > complete() returns just the text
- `base-provider.test.ts` > completeWithUsage() returns full result
- `base-provider.test.ts` > records cost after completion
- `base-provider.test.ts` > passes _appId to cost tracker
- `base-provider.test.ts` > resolves model from modelRef
- `base-provider.test.ts` > uses default model when no override is specified
- `base-provider.test.ts` > exposes providerId and providerType
- `base-provider.test.ts` > satisfies LLMClient interface

**Edge case tests:**
- `base-provider.test.ts` > resolves model from claudeModel for backward compat
- `base-provider.test.ts` > retries on failure
- `base-provider.test.ts` > throws after all retries exhausted

**Fixes:** None

### REQ-LLM-007: Provider factory

**Phase:** 10 | **Status:** Implemented

Providers must be created from configuration. The factory must support Anthropic, Google, OpenAI-compatible, and Ollama provider types. Missing API keys or invalid configs must return null.

**Standard tests:**
- `provider-factory.test.ts` > creates an Anthropic provider when API key is set
- `provider-factory.test.ts` > creates a Google provider when API key is set
- `provider-factory.test.ts` > creates an OpenAI-compatible provider with baseUrl
- `provider-factory.test.ts` > creates an Ollama provider with baseUrl

**Edge case tests:**
- `provider-factory.test.ts` > returns null when API key is not set
- `provider-factory.test.ts` > returns null for Ollama without baseUrl
- `provider-factory.test.ts` > returns null for unknown provider type

**Fixes:** None

### REQ-LLM-008: Runtime model selection with persistence

**Phase:** 11 | **Status:** Implemented

Model assignments per tier (fast, standard, reasoning) must be changeable at runtime and persisted to YAML. Old string-format selections must be auto-migrated to the new ModelRef format.

**Standard tests:**
- `model-selector.test.ts` > uses defaults when no saved selection exists
- `model-selector.test.ts` > persists ModelRef selection to YAML file
- `model-selector.test.ts` > loads saved ModelRef selection on startup
- `model-selector.test.ts` > getTierRef returns correct ref for each tier
- `model-selector.test.ts` > persists and loads reasoning tier

**Edge case tests:**
- `model-selector.test.ts` > backward compat: getStandardModel/getFastModel return model strings
- `model-selector.test.ts` > migrates old string format to ModelRef format
- `model-selector.test.ts` > setStandardModel keeps provider, changes model (backward compat)
- `model-selector.test.ts` > setFastModel keeps provider, changes model (backward compat)
- `model-selector.test.ts` > reasoning tier is undefined when not configured

**Fixes:** None

### REQ-LLM-009: Cost tracking and usage logging

**Phase:** 4, 10 | **Status:** Implemented

All LLM calls must be logged with model, token counts, cost estimate, and optional app ID. The cost tracker must support monthly cost caching with YAML persistence, month rollover detection, and concurrent write serialization.

**Standard tests:**
- `cost-tracker.test.ts` > creates usage file with header on first record
- `cost-tracker.test.ts` > appends entries to existing file
- `cost-tracker.test.ts` > includes app ID when provided
- `cost-tracker.test.ts` > estimates cost correctly for Sonnet
- `cost-tracker.test.ts` > estimates cost correctly for Opus
- `cost-tracker.test.ts` > monthly cost cache > loadMonthlyCache loads costs from YAML file
- `cost-tracker.test.ts` > monthly cost cache > accumulates costs after record() calls
- `cost-tracker.test.ts` > monthly cost cache > flush persists costs to YAML

**Edge case tests:**
- `cost-tracker.test.ts` > uses dash for missing app ID
- `cost-tracker.test.ts` > returns zero cost for unknown models
- `cost-tracker.test.ts` > readUsage returns empty string when file does not exist
- `cost-tracker.test.ts` > serializes concurrent writes correctly (no duplicate headers)
- `cost-tracker.test.ts` > monthly cost cache > loadMonthlyCache starts fresh when no file exists
- `cost-tracker.test.ts` > monthly cost cache > loadMonthlyCache resets when month differs
- `cost-tracker.test.ts` > monthly cost cache > getMonthlyAppCost returns 0 for unknown app
- `cost-tracker.test.ts` > monthly cost cache > record without appId still increments total

**Fixes:**
- 2026-03-11: Month rollover now flushes old data before clearing cache (Phase 13 security review Fix 4)

### REQ-LLM-010: Per-app rate limiting via LLMGuard

**Phase:** 13 | **Status:** Implemented

Each app must have its own sliding-window rate limiter enforced via LLMGuard. When the rate limit is exceeded, an `LLMRateLimitError` must be thrown. Rate limit checks must consume a slot only when the request will proceed (cost cap checked first).

**Standard tests:**
- `llm-guard.test.ts` > complete() > delegates to inner service with _appId injected
- `llm-guard.test.ts` > complete() > injects _appId even with no options
- `llm-guard.test.ts` > complete() > preserves all existing options
- `llm-guard.test.ts` > classify() > routes through inner.complete with _appId (not inner.classify)
- `llm-guard.test.ts` > extractStructured() > routes through inner.complete with _appId

**Edge case tests:**
- `llm-guard.test.ts` > complete() > throws LLMRateLimitError when rate limit exceeded
- `llm-guard.test.ts` > classify() > checks rate limit and cost cap
- `llm-guard.test.ts` > classify() > counts as one rate limit request (not double-counted)
- `llm-guard.test.ts` > error details > LLMRateLimitError includes correct details

**Fixes:**
- 2026-03-11: Reordered checks — cost cap before rate limit to avoid wasting slots (Phase 13 security review Fix 6)

### REQ-LLM-011: Per-app and global monthly cost caps

**Phase:** 13 | **Status:** Implemented

LLMGuard must enforce per-app monthly cost caps and a global monthly cost cap. When cost is at or above the cap (`>=`), an `LLMCostCapError` must be thrown. Per-app cap is checked before global cap.

**Standard tests:**
- `llm-guard.test.ts` > complete() > throws LLMCostCapError when per-app cost cap exceeded
- `llm-guard.test.ts` > complete() > throws LLMCostCapError when global cost cap exceeded
- `llm-guard.test.ts` > complete() > checks per-app cap before global cap
- `llm-guard.test.ts` > extractStructured() > checks rate limit and cost cap
- `llm-guard.test.ts` > error details > LLMCostCapError includes correct details for app scope
- `llm-guard.test.ts` > error details > LLMCostCapError includes correct details for global scope

**Edge case tests:**
- `llm-guard.test.ts` > boundary conditions > blocks when cost is exactly at cap (>= not >)
- `llm-guard.test.ts` > boundary conditions > allows when cost is just below cap

**Fixes:** None

### REQ-LLM-012: LLMGuard configuration validation

**Phase:** 13 | **Status:** Implemented

LLMGuard must validate its configuration at construction time. NaN, zero, and negative cost caps must be rejected. Invalid rate limit values must be rejected. This prevents silent enforcement bypass.

**Standard tests:**
- `llm-guard.test.ts` > config validation > accepts valid config without throwing

**Edge case tests:**
- `llm-guard.test.ts` > config validation > rejects NaN monthlyCostCap
- `llm-guard.test.ts` > config validation > rejects zero monthlyCostCap
- `llm-guard.test.ts` > config validation > rejects negative globalMonthlyCostCap
- `llm-guard.test.ts` > config validation > rejects zero maxRequests

**Fixes:**
- 2026-03-11: Added constructor validation for NaN/zero/negative config values (Phase 13 security review Fix 2)

### REQ-LLM-013: LLMGuard error propagation

**Phase:** 13 | **Status:** Implemented

Inner service errors must propagate through the LLMGuard unchanged. The guard must not swallow or wrap provider errors.

**Standard tests:** None (tested via edge case)

**Edge case tests:**
- `llm-guard.test.ts` > error propagation > propagates inner service errors unchanged

**Fixes:** None

### REQ-LLM-014: LLMGuard lifecycle management

**Phase:** 13 | **Status:** Implemented

LLMGuard must provide a `dispose()` method to clean up the rate limiter timer. This must be called on shutdown.

**Standard tests:**
- `llm-guard.test.ts` > dispose() > stops the rate limiter cleanup timer

**Edge case tests:**
- `llm-guard.test.ts` > dispose() > is idempotent — double dispose does not throw

**Fixes:** None

### REQ-LLM-018: Model catalog and discovery

**Phase:** 11 | **Status:** Implemented

The system must provide a model catalog that fetches available models from all providers via the registry. Results must be cached for 1 hour. Stale cache must be returned on fetch failure. Models with pricing must sort before those without.

**Standard tests:**
- `model-catalog.test.ts` > fetches models from provider registry
- `model-catalog.test.ts` > returns cached models on subsequent calls
- `model-catalog.test.ts` > sorts models with pricing before those without
- `model-catalog.test.ts` > refresh clears cache and re-fetches
- `model-catalog.test.ts` > maps ProviderModel fields to CatalogModel correctly

**Edge case tests:**
- `model-catalog.test.ts` > returns empty array when fetch fails
- `model-catalog.test.ts` > returns stale cache when fetch fails after initial load
- `model-catalog.test.ts` > cache expires after TTL
- `model-catalog.test.ts` > returns empty array with no registry and no client

**Fixes:** None

### REQ-LLM-019: Model pricing lookup

**Phase:** 10 | **Status:** Implemented

The system must provide a pricing lookup table for all supported models (Anthropic, Google, OpenAI). Cost estimation must return 0 for unknown models.

**Standard tests:**
- `model-pricing.test.ts` > getModelPricing > returns pricing for a known Anthropic model
- `model-pricing.test.ts` > getModelPricing > returns pricing for a known Google model
- `model-pricing.test.ts` > getModelPricing > returns pricing for a known OpenAI model
- `model-pricing.test.ts` > estimateCallCost > calculates correctly for Sonnet
- `model-pricing.test.ts` > estimateCallCost > calculates correctly for Haiku
- `model-pricing.test.ts` > MODEL_PRICING > contains entries for Anthropic models
- `model-pricing.test.ts` > MODEL_PRICING > contains entries for Google models
- `model-pricing.test.ts` > MODEL_PRICING > contains entries for OpenAI models

**Edge case tests:**
- `model-pricing.test.ts` > getModelPricing > returns null for an unknown model
- `model-pricing.test.ts` > estimateCallCost > returns 0 for an unknown model
- `model-pricing.test.ts` > estimateCallCost > returns 0 when tokens are 0

**Configuration tests:**
- `model-pricing.test.ts` > estimateCallCost > produces negative cost for negative token counts
- `model-pricing.test.ts` > estimateCallCost > produces NaN for NaN token counts

**Fixes:** None

### REQ-LLM-020: Anthropic provider SDK integration

**Phase:** 10 | **Status:** Implemented

The Anthropic provider must use the official SDK for completions and model listing. It must handle multiple text blocks, system prompts, temperature options, and default to 1024 max tokens. API key must be required.

**Standard tests:**
- `anthropic-provider.test.ts` > sets providerType to anthropic
- `anthropic-provider.test.ts` > calls messages.create with correct model and prompt
- `anthropic-provider.test.ts` > returns text from response content blocks
- `anthropic-provider.test.ts` > returns usage from response
- `anthropic-provider.test.ts` > passes maxTokens option (defaults to 1024)
- `anthropic-provider.test.ts` > passes temperature option
- `anthropic-provider.test.ts` > passes system prompt when provided
- `anthropic-provider.test.ts` > does not include system key when systemPrompt is not provided
- `anthropic-provider.test.ts` > returns models from API with pricing lookup

**Edge case tests:**
- `anthropic-provider.test.ts` > throws when API key is empty
- `anthropic-provider.test.ts` > throws when API key is not provided
- `anthropic-provider.test.ts` > joins multiple text blocks
- `anthropic-provider.test.ts` > filters out non-text blocks
- `anthropic-provider.test.ts` > uses model.id as displayName when display_name is missing
- `anthropic-provider.test.ts` > returns empty array on API failure

**Fixes:** None

---

## 8. Configuration

### REQ-CONFIG-001: System configuration loading

**Phase:** 2, 11 | **Status:** Implemented

The system must load configuration from `.env` files and `pas.yaml`. Environment variables and YAML settings must be merged with appropriate defaults. Multi-user configuration, LLM provider configuration, tier assignments, and safeguards must all be parsed correctly.

**Standard tests:**
- `config.test.ts` > loads config from .env and pas.yaml
- `config.test.ts` > parses multiple users from YAML
- `config.test.ts` > builds llm config with built-in providers
- `config.test.ts` > auto-assigns standard tier to anthropic when only ANTHROPIC_API_KEY is set
- `config.test.ts` > auto-assigns fast tier to anthropic haiku when only ANTHROPIC_API_KEY is set
- `config.test.ts` > merges custom providers from pas.yaml
- `config.test.ts` > uses explicit tier assignments from pas.yaml
- `config.test.ts` > parses safeguards config from pas.yaml

**Edge case tests:**
- `config.test.ts` > uses defaults when pas.yaml is missing
- `config.test.ts` > uses env defaults for optional fields
- `config.test.ts` > YAML log_level overrides env LOG_LEVEL
- `config.test.ts` > sets ollama config when OLLAMA_URL is provided
- `config.test.ts` > sets claude.fastModel when CLAUDE_FAST_MODEL is provided
- `config.test.ts` > prefers google for fast tier when GOOGLE_AI_API_KEY is set
- `config.test.ts` > applies CLAUDE_MODEL env override to anthropic provider defaultModel

**Error handling tests:**
- `config.test.ts` > throws on malformed pas.yaml (fail fast)

**Edge case tests (pas-yaml-schema.test.ts):**
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > accepts a valid minimal config (empty)
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > accepts a valid config with users
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > accepts unknown top-level keys (passthrough)
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > accepts valid LLM provider config
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > accepts webhook with valid URL
- `pas-yaml-schema.test.ts` > parsePasYamlConfig() > returns parsed config for valid input
- `pas-yaml-schema.test.ts` > parsePasYamlConfig() > passes through unknown keys
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects a user missing required id
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects a user with empty id
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects a user missing required name
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects null input
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects undefined input
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects non-object input (number)
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects LLM provider missing api_key_env
- `pas-yaml-schema.test.ts` > PasYamlConfigSchema > rejects webhook with invalid URL
- `pas-yaml-schema.test.ts` > parsePasYamlConfig() > throws a formatted Error on invalid input
- `pas-yaml-schema.test.ts` > parsePasYamlConfig() > error message includes path and reason

**Fixes:**
- **D14 (2026-04-13):** Malformed pas.yaml now fails fast at startup — `readYamlFileStrict()` catches YAML syntax errors before Zod runs, and Zod validates object shape. Added Zod schema validation (`pas-yaml-schema.ts`) for users, LLM providers, webhooks, and all top-level config sections. CL: D14-fix.

### REQ-CONFIG-002: Built-in provider defaults

**Phase:** 11 | **Status:** Implemented

The system must include built-in provider definitions for Anthropic, Google, OpenAI, and Ollama. Each provider must have a default model configured.

**Standard tests:**
- `default-providers.test.ts` > includes anthropic provider
- `default-providers.test.ts` > includes google provider
- `default-providers.test.ts` > includes openai provider
- `default-providers.test.ts` > includes ollama provider
- `default-providers.test.ts` > all providers have a default model

**Edge case tests:**
- `default-providers.test.ts` > all provider IDs are unique
- `default-providers.test.ts` > all providers have a type field
- `default-providers.test.ts` > all providers have an apiKeyEnvVar field defined

**Fixes:** None

### REQ-CONFIG-003: Per-app configuration management

**Phase:** 8 | **Status:** Implemented

The system must support per-user app configuration with manifest defaults and user overrides. Overrides persist to YAML. User override takes precedence over manifest default. Invalid userId format must be rejected.

**Runtime propagation:** Every `user_config` key defined in an app manifest is readable at runtime as a per-user value. The infrastructure propagates the current user's identity to all app entry points (message, command, photo, callback, scheduled job, alert action, API message, GUI simulated message) via a unified `requestContext` AsyncLocalStorage. Apps call `services.config.get(key)` and transparently receive the calling user's override — no manual context wiring required.

**Standard tests:**
- `app-config-service.test.ts` > get returns manifest default when no overrides
- `app-config-service.test.ts` > get returns user override when set
- `app-config-service.test.ts` > getAll merges defaults with overrides
- `app-config-service.test.ts` > setAll writes overrides to YAML file
- `app-config-service.test.ts` > get reads userId from requestContext for subsequent get calls
- `per-user-runtime.integration.test.ts` > end-to-end GUI-save-then-dispatch returns override for the targeted user and default for untouched users

**Edge case tests:**
- `app-config-service.test.ts` > get throws for unknown config key
- `app-config-service.test.ts` > setAll rejects invalid userId format
- `app-config-service.test.ts` > getAll returns only defaults when no user context
- `app-config-service.test.ts` > get returns override when key exists in both defaults and overrides
- `app-config-service.test.ts` > loadOverrides returns null when no requestContext userId is set
- `per-user-runtime.integration.test.ts` > get outside any requestContext scope returns the manifest default
- `per-user-runtime.integration.test.ts` > concurrent requestContext scopes do not leak userIds across apps

**Concurrency tests:**
- `app-config-service.test.ts` > concurrent setAll calls produce consistent final state

**Security tests:**
- `app-config-service.test.ts` > getAll returns defaults only for path traversal userId

**Fixes:**
- D32 (2026-03): `loadOverrides()` missing userId validation — path traversal via `getAll(userId)`. Fixed with `^[a-zA-Z0-9_-]+$` pattern check. See Post-Phase 18 Security Review.
- Per-user runtime propagation (2026-04-09): `AppConfigServiceImpl.setUserId()` was never called in production, so every `services.config.get(key)` silently returned the manifest default. Fixed by unifying `llmContext` into a top-level `requestContext` AsyncLocalStorage and wrapping every dispatch point. `AppConfigService` now reads `getCurrentUserId()` from the request context. Scheduled jobs declared `user_scope: all` are iterated by the scheduler once per registered user inside a per-user request context.

---

## 9. Message Routing

### REQ-ROUTE-001: Command parsing and dispatch

**Phase:** 5 | **Status:** Implemented

The router must parse `/command` messages, strip bot name suffixes, and dispatch to the correct app's `handleCommand`. Unknown commands must receive an error message. Built-in commands (`/help`, `/start`) must be handled.

**Standard tests:**
- `command-parser.test.ts` > parseCommand > should parse a command with arguments
- `command-parser.test.ts` > parseCommand > should parse a command with no arguments
- `command-parser.test.ts` > parseCommand > should strip @botname suffix
- `command-parser.test.ts` > parseCommand > should strip @botname with no arguments
- `command-parser.test.ts` > parseCommand > should preserve rawArgs exactly
- `command-parser.test.ts` > lookupCommand > should find a registered command
- `router.test.ts` > routeMessage — commands > should route /echo to the echo app handleCommand
- `router.test.ts` > routeMessage — commands > should handle built-in /help command
- `router.test.ts` > routeMessage — commands > should handle built-in /start command

**Edge case tests:**
- `command-parser.test.ts` > parseCommand > should return null for non-command text
- `command-parser.test.ts` > parseCommand > should return null for just a slash
- `command-parser.test.ts` > parseCommand > should return null for slash with only space
- `command-parser.test.ts` > parseCommand > should handle extra whitespace in arguments
- `command-parser.test.ts` > parseCommand > should handle leading/trailing whitespace
- `command-parser.test.ts` > lookupCommand > should return null for an unregistered command
- `router.test.ts` > routeMessage — commands > should send unknown command message for unregistered commands

**Fixes:** None

### REQ-ROUTE-002: Intent classification routing

**Phase:** 5 | **Status:** Implemented

Free text messages must be classified by the LLM against all apps' declared intents. Classification must respect a confidence threshold. Low-confidence or failed classifications must fall back to the fallback handler.

**Standard tests:**
- `intent-classifier.test.ts` > should classify text and return the matching app
- `router.test.ts` > routeMessage — intent classification > should classify free text and route to matching app

**Edge case tests:**
- `intent-classifier.test.ts` > should return null when confidence is below threshold
- `intent-classifier.test.ts` > should return null when intent table is empty
- `intent-classifier.test.ts` > should return null when LLM throws an error
- `intent-classifier.test.ts` > should return null when classified category is not in table
- `intent-classifier.test.ts` > should use exact threshold boundary (equal = pass)
- `router.test.ts` > routeMessage — intent classification > should fall back when classification confidence is low

**Fixes:** None

### REQ-ROUTE-003: Photo message routing

**Phase:** 5 | **Status:** Implemented

Photo messages must be routed to apps that declare `accepts_photos`. When only one app accepts photos and no caption is provided, route directly. When multiple apps exist, classify the caption.

**Standard tests:**
- `photo-classifier.test.ts` > should route directly when only one app and no caption
- `photo-classifier.test.ts` > should classify caption when available
- `router.test.ts` > routePhoto > should route photos to the matching app

**Edge case tests:**
- `photo-classifier.test.ts` > should return null when multiple apps and no caption
- `photo-classifier.test.ts` > should return null when classification below threshold
- `photo-classifier.test.ts` > should return null when no photo intents registered
- `photo-classifier.test.ts` > should return null when LLM throws
- `router.test.ts` > routePhoto > should handle no photo apps gracefully

**Fixes:** None

### REQ-ROUTE-004: Fallback handler

**Phase:** 5 | **Status:** Implemented

When no app matches a message, the fallback handler must append the message to a daily notes file and send an acknowledgment to the user.

**Standard tests:**
- `fallback.test.ts` > should append message to daily notes file
- `fallback.test.ts` > should append multiple messages to the same daily file
- `fallback.test.ts` > should send acknowledgment to user

**Edge case tests:**
- `fallback.test.ts` > should not throw if telegram.send fails

**Fixes:** None

### REQ-ROUTE-006: Route verification (grey-zone disambiguation)

**Phase:** 28 | **Status:** Implemented

When intent classification confidence falls in the grey zone (>= 0.4 and < upperBound, default 0.7), a second LLM call (standard tier) verifies the routing decision using full app descriptions and all intents. On agreement, route immediately. On disagreement, hold the message and present inline Telegram buttons for user disambiguation. Enabled by default. Graceful degradation on LLM failure (fall back to classifier's pick). Verification skipped when only 0–1 apps installed. Verification log written to `data/system/route-verification-log.md`.

**Standard tests:**
- `route-verifier.test.ts` > returns route action when verifier agrees
- `route-verifier.test.ts` > does not send buttons when verifier agrees
- `route-verifier.test.ts` > returns held action and sends buttons when verifier disagrees
- `route-verifier.test.ts` > sends correct button labels when verifier disagrees
- `route-verifier.test.ts` > stores pending entry when message is held
- `route-verifier.test.ts` > uses standard tier for the verification LLM call
- `route-verifier.test.ts` > resolveCallback resolves pending entry and edits message
- `route-verifier.test.ts` > resolveCallback logs the user override to verificationLogger
- `route-verifier.test.ts` > handles photo context correctly — uses caption as message text
- `route-verifier.test.ts` > sends a natural language prompt mentioning both app names
- `router-verification.test.ts` > grey-zone triggers verifier
- `router-verification.test.ts` > high confidence skips verifier
- `router-verification.test.ts` > held message is not dispatched
- `prompt-templates.test.ts` > buildVerificationPrompt > contains classifier info
- `prompt-templates.test.ts` > buildVerificationPrompt > contains candidate apps
- `prompt-templates.test.ts` > buildVerificationPrompt > requests JSON response
- `pending-verification-store.test.ts` > add and get
- `pending-verification-store.test.ts` > resolve removes entry
- `verification-logger.test.ts` > creates log file with frontmatter on first write
- `verification-logger.test.ts` > appends entries to existing file
- `config.test.ts` > enables route verification by default when section is absent
- `config.test.ts` > respects explicit enabled: false for route verification

**Edge case tests:**
- `route-verifier.test.ts` > degrades gracefully when LLM call fails
- `route-verifier.test.ts` > degrades gracefully when LLM returns unparseable response
- `route-verifier.test.ts` > degrades gracefully when LLM response is valid JSON but missing agrees field
- `route-verifier.test.ts` > falls back to classifier pick when verifier suggests non-existent appId
- `route-verifier.test.ts` > allows chatbot as a suggested appId even when not in registry
- `route-verifier.test.ts` > skips verification when only 1 app is installed
- `route-verifier.test.ts` > skips verification when zero apps are installed
- `route-verifier.test.ts` > deduplicates buttons when verifier suggests same app as classifier
- `route-verifier.test.ts` > does not show chatbot as a button option when verifier suggests chatbot
- `route-verifier.test.ts` > logs pending outcome when message is held
- `route-verifier.test.ts` > resolveCallback returns undefined for unknown pending ID
- `router-verification.test.ts` > backward compatible — no verifier means no verification
- `router-verification.test.ts` > photo grey-zone triggers verifier
- `pending-verification-store.test.ts` > callback data fits Telegram 64-byte limit
- `pending-verification-store.test.ts` > IDs are unique across calls
- `verification-logger.test.ts` > includes photo path in entry
- `verification-logger.test.ts` > creates missing directory
- `config.test.ts` > enables route verification by default when routing section exists but enabled is omitted
- `config.test.ts` > clamps upper_bound to [0, 1] range
- `config.test.ts` > clamps negative upper_bound to 0

**Security tests:**
- `prompt-templates.test.ts` > buildVerificationPrompt > sanitizes backtick injection in app descriptions
- `prompt-templates.test.ts` > buildVerificationPrompt > sanitizes backtick injection in classifier intent
- `prompt-templates.test.ts` > buildVerificationPrompt > truncates excessively long app descriptions
- `prompt-templates.test.ts` > buildVerificationPrompt > sanitizes app names with backtick sequences

**Photo tests:**
- `route-verifier.test.ts` > photo saving > saves photo to photoDir when verifier disagrees and message is held
- `route-verifier.test.ts` > photo saving > saves photo to photoDir when verifier agrees
- `route-verifier.test.ts` > photo saving > does not save photo when photoDir is not configured
- `route-verifier.test.ts` > photo saving > includes saved photo path in the pending entry

**Fixes:** None

---

## 10. Telegram Gateway

### REQ-TG-001: Message adaptation

**Phase:** 5 | **Status:** Implemented

The Telegram gateway must adapt grammY context objects into typed message contexts (text, photo). User ID extraction must handle missing fields gracefully.

**Standard tests:**
- `message-adapter.test.ts` > extractUserId > should return user ID as string
- `message-adapter.test.ts` > adaptTextMessage > should adapt a text message context
- `message-adapter.test.ts` > adaptPhotoMessage > should adapt a photo message with caption

**Edge case tests:**
- `message-adapter.test.ts` > extractUserId > should return null when no from field
- `message-adapter.test.ts` > adaptTextMessage > should return null when no text in message
- `message-adapter.test.ts` > adaptTextMessage > should return null when no message
- `message-adapter.test.ts` > adaptTextMessage > should return null when no user
- `message-adapter.test.ts` > adaptPhotoMessage > should return null when no photo in message
- `message-adapter.test.ts` > adaptPhotoMessage > should return null when photo array is empty
- `message-adapter.test.ts` > adaptPhotoMessage > should return null when fetch fails

**Fixes:** None

### REQ-TG-002: Telegram message sending

**Phase:** 5 | **Status:** Implemented

The Telegram service must support sending text messages (with Markdown), photos (with/without caption), and interactive option keyboards with callback resolution.

**Standard tests:**
- `telegram-service.test.ts` > send > should send a text message with Markdown parse mode
- `telegram-service.test.ts` > sendPhoto > should send a photo with caption
- `telegram-service.test.ts` > sendPhoto > should send a photo without caption
- `telegram-service.test.ts` > sendOptions > should send a keyboard and resolve when callback arrives
- `telegram-service.test.ts` > sendOptions > should resolve with the correct option when second button clicked

**Edge case tests:**
- `telegram-service.test.ts` > send > should throw if sendMessage fails
- `telegram-service.test.ts` > sendOptions > should ignore unknown callback nonces
- `telegram-service.test.ts` > sendOptions > should ignore malformed callback data
- `telegram-service.test.ts` > sendOptions > should reject callback from wrong user
- `telegram-service.test.ts` > cleanup > should reject all pending options on cleanup

**Fixes:** None

---

## 11. App Registry

### REQ-REGISTRY-001: App discovery and loading

**Phase:** 5 | **Status:** Implemented

The registry must discover apps by scanning the apps directory for `manifest.yaml` files, validate manifests, import TypeScript modules, and initialize apps with CoreServices.

**Standard tests:**
- `loader.test.ts` > discoverApps > should find directories with manifest.yaml
- `loader.test.ts` > loadManifest > should load and validate a valid manifest
- `loader.test.ts` > importModule > should import a valid TypeScript app module
- `registry.test.ts` > should load a valid app and register it
- `registry.test.ts` > should return manifest cache with loaded manifests

**Edge case tests:**
- `loader.test.ts` > discoverApps > should return empty array when appsDir does not exist
- `loader.test.ts` > discoverApps > should return empty array when no apps have manifests
- `loader.test.ts` > loadManifest > should return null for invalid manifest
- `loader.test.ts` > loadManifest > should return null when manifest.yaml is missing
- `loader.test.ts` > importModule > should return null when no module file exists
- `registry.test.ts` > should skip apps with invalid manifests
- `registry.test.ts` > should skip apps whose init() throws
- `registry.test.ts` > should handle empty apps directory gracefully

**Fixes:** None

### REQ-REGISTRY-002: Manifest cache and routing tables

**Phase:** 5 | **Status:** Implemented

The manifest cache must build O(1) command lookup maps, intent tables, and photo intent tables from loaded manifests. Duplicate commands must keep the first registration.

**Standard tests:**
- `manifest-cache.test.ts` > add / get / has / size > should store and retrieve manifests
- `manifest-cache.test.ts` > add / get / has / size > should return all entries
- `manifest-cache.test.ts` > buildCommandMap > should build O(1) command map from all manifests
- `manifest-cache.test.ts` > buildIntentTable > should collect all intents from all manifests
- `manifest-cache.test.ts` > buildPhotoIntentTable > should collect photo intents only from apps that accept photos
- `manifest-cache.test.ts` > getPhotoAppIds > should return IDs of apps that accept photos

**Edge case tests:**
- `manifest-cache.test.ts` > buildCommandMap > should skip duplicate commands and keep the first
- `manifest-cache.test.ts` > buildCommandMap > should return empty map when no commands are declared
- `manifest-cache.test.ts` > buildIntentTable > should return empty table when no intents are declared
- `manifest-cache.test.ts` > buildPhotoIntentTable > should not include intents from apps without accepts_photos
- `manifest-cache.test.ts` > getPhotoAppIds > should return empty array when no apps accept photos

**Fixes:** None

### REQ-REGISTRY-003: App lifecycle management

**Phase:** 5 | **Status:** Implemented

The registry must support graceful shutdown of all loaded apps. Shutdown failures in individual apps must not prevent other apps from shutting down.

**Standard tests:**
- `registry.test.ts` > should call shutdown on all loaded apps

**Edge case tests:**
- `registry.test.ts` > should not crash if shutdown throws
- `registry.test.ts` > should shutdown gracefully with no loaded apps
- `registry.test.ts` > should return undefined for unknown app ID

**Fixes:** None

---

## 12. User Management

### REQ-USER-001: User lookup and registration

**Phase:** 9 | **Status:** Implemented

The system must maintain a user registry loaded from configuration. Users must be lookupable by Telegram ID. The system must track user names, admin status, enabled apps, and shared scopes.

**Standard tests:**
- `user-manager.test.ts` > getUser > returns user for known Telegram ID
- `user-manager.test.ts` > isRegistered > returns true for registered user
- `user-manager.test.ts` > getUserApps > returns enabled apps for known user
- `user-manager.test.ts` > getSharedScopes > returns shared scopes for known user
- `user-manager.test.ts` > getAllUsers > returns all registered users

**Edge case tests:**
- `user-manager.test.ts` > getUser > returns null for unknown Telegram ID
- `user-manager.test.ts` > isRegistered > returns false for unregistered user
- `user-manager.test.ts` > getUserApps > returns empty array for unknown user
- `user-manager.test.ts` > getSharedScopes > returns empty array for unknown user

**Configuration tests:**
- `user-manager.test.ts` > empty config > works with zero users configured

**Fixes:** None

### REQ-USER-002: App access control

**Phase:** 9 | **Status:** Implemented

The system must enforce per-user app access. Wildcard (`*`) must grant access to all apps. Toggle overrides must take precedence over config defaults. Unknown users must be denied access.

**Standard tests:**
- `user-manager.test.ts` > isAppEnabled > returns true for wildcard user
- `user-manager.test.ts` > isAppEnabled > returns true for explicitly enabled app
- `router.test.ts` > routeMessage — authorization > should allow wildcard (*) app access

**Edge case tests:**
- `user-manager.test.ts` > isAppEnabled > returns false for non-enabled app
- `user-manager.test.ts` > isAppEnabled > returns false for unknown user
- `user-manager.test.ts` > isAppEnabled > respects toggle overrides
- `router.test.ts` > routeMessage — authorization > should reject messages from unregistered users
- `router.test.ts` > routeMessage — authorization > should deny access to disabled apps
- `router.test.ts` > routePhoto > should reject photos from unregistered users

**Fixes:** None

### REQ-USER-003: Configuration validation

**Phase:** 9 | **Status:** Implemented

The system must validate user configuration at startup, warning about duplicate IDs, non-numeric Telegram IDs, empty names, and unknown app references.

**Standard tests:**
- `user-manager.test.ts` > validateConfig > returns empty array for valid config

**Edge case tests:**
- `user-manager.test.ts` > validateConfig > warns about duplicate user IDs
- `user-manager.test.ts` > validateConfig > warns about non-numeric Telegram IDs
- `user-manager.test.ts` > validateConfig > warns about empty user names
- `user-manager.test.ts` > validateConfig > warns about unknown app references
- `user-manager.test.ts` > validateConfig > does not warn about wildcard app

**Fixes:** None

### REQ-USER-004: Pre-routing user authorization

**Phase:** 9 | **Status:** Implemented

A user guard must check user registration before message routing. Unregistered users must receive a rejection message. Send failures during rejection must be handled gracefully.

**Standard tests:**
- `user-guard.test.ts` > allows registered users
- `user-guard.test.ts` > does not send rejection to registered users

**Edge case tests:**
- `user-guard.test.ts` > rejects unregistered users with a message
- `user-guard.test.ts` > logs warning for rejected users
- `user-guard.test.ts` > handles send failure gracefully

**Fixes:** None

### REQ-USER-005: Invite code generation and validation

**Phase:** 29 | **Status:** Implemented

The system must support admin-generated invite codes for user registration. Codes must be 8-character hex strings, expire after 24 hours, and be single-use. Used/expired codes must return specific error messages. A cleanup mechanism must remove stale codes after 7 days.

**Standard tests:**
- `index.test.ts` (invite) > createInvite > returns an 8-character hex code
- `index.test.ts` (invite) > createInvite > stores invite with correct fields
- `index.test.ts` (invite) > validateCode > returns invite for valid code
- `index.test.ts` (invite) > redeemCode > marks code as used with userId and timestamp

**Edge case tests:**
- `index.test.ts` (invite) > validateCode > returns error for non-existent code
- `index.test.ts` (invite) > validateCode > returns error for expired code
- `index.test.ts` (invite) > validateCode > returns error for already-used code
- `index.test.ts` (invite) > cleanup > removes expired+used codes older than 7 days
- `index.test.ts` (invite) > cleanup > preserves active unused codes

**Security tests:**
- `index.test.ts` (invite) > security > generates unique codes (no collisions)
- `index.test.ts` (invite) > security > rejects codes with special characters
- `index.test.ts` (invite) > security > handles concurrent redemption safely

**Fixes:** None

### REQ-USER-006: Invite code redemption

**Phase:** 29 | **Status:** Implemented

Unregistered users must be able to redeem invite codes via `/start <code>` or by sending the raw 8-char hex code. Successful redemption must register the user with default all-app access, sync to config, and send a welcome message. Invalid/expired/used codes must return specific error messages.

**Standard tests:**
- `invite-command.test.ts` > /start with invite code > validates, redeems, registers, and welcomes new user
- `user-guard.test.ts` > invite code detection > registers user and returns true when valid invite code is sent

**Edge case tests:**
- `invite-command.test.ts` > /start with invite code > sends error for invalid invite code
- `user-guard.test.ts` > invite code detection > sends specific error for expired/used code-shaped text
- `user-guard.test.ts` > invite code detection > sends standard rejection when text is not code-shaped
- `user-guard.test.ts` > invite code detection > sends standard rejection when no messageText provided
- `user-guard.test.ts` > invite code detection > sends standard rejection when inviteService not configured
- `user-guard.test.ts` > invite code detection > trims whitespace from message text
- `user-guard.test.ts` > invite code detection > handles welcome message send failure gracefully
- `user-guard.test.ts` > invite code detection > does not attempt redemption for registered users
- `user-guard.test.ts` > invite code detection > redeems valid code via /start deep link
- `user-guard.test.ts` > invite code detection > sends invite error for expired /start code
- `user-guard.test.ts` > invite code detection > handles /start with extra whitespace before code

**Natural-language journey tests:**
- `realistic-invite-journey.test.ts` > new user follows instructions > raw code, deep link, whitespace, double-space /start (4 tests)
- `realistic-invite-journey.test.ts` > confused user sends wrong things > hi, questions, wrapped code, uppercase, wrong length, missing slash (9 tests)
- `realistic-invite-journey.test.ts` > invalid/expired/used codes > expired, used, nonexistent, via deep link (4 tests)
- `realistic-invite-journey.test.ts` > registered user edge cases > code-like text and deep link pass through (2 tests)
- `realistic-invite-journey.test.ts` > admin /invite command > simple name, nickname, full name, emoji, no name, missing slash, natural language (7 tests)
- `realistic-invite-journey.test.ts` > non-admin /invite > permission denied (1 test)
- `realistic-invite-journey.test.ts` > /help visibility > admin sees /invite, regular user doesn't (2 tests)
- `realistic-invite-journey.test.ts` > /start registered user > already registered passthrough (1 test)
- `realistic-invite-journey.test.ts` > invite-adjacent messages > "invite mom for dinner" routes to classifier (1 test)

**Security tests:**
- `invite-command.test.ts` > /invite security > passes special characters in name to invite service
- `invite-command.test.ts` > /invite security > escapes MarkdownV2 special characters in response

**Fixes:** None

### REQ-USER-007: Runtime user mutations with config sync

**Phase:** 29 | **Status:** Implemented

The system must support adding, removing, and updating users at runtime. All mutations must sync to pas.yaml atomically, preserving non-user config sections. Removal must guard against self-removal and removing the last admin. App and scope updates must take effect immediately.

**Standard tests:**
- `user-mutation-service.test.ts` > registerUser > adds user to memory and syncs to config
- `user-mutation-service.test.ts` > removeUser > removes user from memory and syncs to config
- `user-mutation-service.test.ts` > updateUserApps > updates in-memory user apps
- `user-mutation-service.test.ts` > updateUserSharedScopes > updates in-memory user shared scopes
- `config-writer.test.ts` > writes users to existing config preserving other sections
- `config-writer.test.ts` > converts camelCase fields to snake_case in YAML

**Edge case tests:**
- `user-mutation-service.test.ts` > removeUser > returns error if caller is trying to remove themselves
- `user-mutation-service.test.ts` > removeUser > returns error if removing the last admin
- `user-mutation-service.test.ts` > removeUser > returns error if user not found
- `user-mutation-service.test.ts` > removeUser > allows removing an admin when another admin exists
- `config-writer.test.ts` > creates file if it does not exist
- `config-writer.test.ts` > handles empty user array

**Fixes:** None

### REQ-USER-008: GUI user management

**Phase:** 29 | **Status:** Implemented

A web GUI page must display all users in a table with app access checkboxes, editable group fields, and user removal buttons. App toggling must use htmx for inline updates. Group editing must validate group name format (alphanumeric, hyphens, underscores). User removal must require confirmation. All mutations must persist to config.

**Standard tests:**
- `integration.test.ts` (invite) > admin creates invite, user redeems, user is active, config persisted
- `integration.test.ts` (invite) > removing user updates memory and config
- `integration.test.ts` (invite) > updating apps persists to config

**Edge case tests:**
- GUI route > rejects invalid (non-numeric) user ID format
- GUI route > returns 404 for non-existent user
- GUI route > rejects invalid group name characters

**Fixes:** fix checkbox name mismatch (users.eta vs users.ts), fix groups cell ID mismatch

---

## 13. Rate Limiting

### REQ-RATELIMIT-001: Sliding-window rate limiter

**Phase:** 9 | **Status:** Implemented

The system must provide a sliding-window rate limiter that tracks keys independently, supports remaining-attempt queries, key resets, and automatic cleanup of expired entries.

**Standard tests:**
- `rate-limiter.test.ts` > allows requests within the limit
- `rate-limiter.test.ts` > tracks keys independently
- `rate-limiter.test.ts` > getRemainingAttempts > returns max for unknown key
- `rate-limiter.test.ts` > getRemainingAttempts > decreases as attempts are made
- `rate-limiter.test.ts` > reset > clears rate limit for a key
- `rate-limiter.test.ts` > cleanup > dispose clears all state
- `rate-limiter.test.ts` > factory functions > createTelegramRateLimiter allows 20 messages per 60s
- `rate-limiter.test.ts` > factory functions > createLoginRateLimiter allows 5 attempts per 15min

**Edge case tests:**
- `rate-limiter.test.ts` > blocks requests exceeding the limit
- `rate-limiter.test.ts` > allows requests again after the window expires
- `rate-limiter.test.ts` > uses sliding window (partial expiration)
- `rate-limiter.test.ts` > getRemainingAttempts > recovers after window expires
- `rate-limiter.test.ts` > reset > does not affect other keys
- `rate-limiter.test.ts` > cleanup > purges expired entries during cleanup cycle

**Configuration tests:**
- `rate-limiter.test.ts` > boundary configurations > maxAttempts=0 rejects all requests
- `rate-limiter.test.ts` > boundary configurations > maxAttempts=1 with very small window recovers quickly

**Fixes:** None

---

## 14. App Toggle

### REQ-TOGGLE-001: Per-user app enable/disable

**Phase:** 9 | **Status:** Implemented

Users must be able to enable or disable individual apps. Overrides must persist to YAML and take precedence over config defaults.

**Standard tests:**
- `app-toggle.test.ts` > returns config default when no overrides exist
- `app-toggle.test.ts` > returns true when app is in enabled list
- `app-toggle.test.ts` > override takes precedence over config defaults
- `app-toggle.test.ts` > can enable an app that was not in config defaults
- `app-toggle.test.ts` > persists overrides to YAML file
- `app-toggle.test.ts` > getOverrides returns user overrides
- `app-toggle.test.ts` > getAllOverrides returns all user overrides

**Edge case tests:**
- `app-toggle.test.ts` > returns false when app not in enabled list and no override
- `app-toggle.test.ts` > getOverrides returns empty object for unknown user
- `app-toggle.test.ts` > handles missing YAML file gracefully

**Fixes:** None

---

## 15. Context Store

### REQ-CTX-001: Read-only context knowledge base

**Phase:** 7 | **Status:** Implemented

The context store must provide read-only access to context files by key. It must support case-insensitive search across all context entries, including per-user entries via `searchForUser()` and `getForUser()`. Path traversal must be rejected.

**Standard tests:**
- `context-store.test.ts` > get > should return content for an existing key
- `context-store.test.ts` > search > should find entries matching the query (case-insensitive)
- `context-store.test.ts` > search > should find multiple matching entries
- `context-store.test.ts` > search > should be case-insensitive

**Edge case tests:**
- `context-store.test.ts` > get > should return null for a missing key
- `context-store.test.ts` > get > should reject path traversal attempts
- `context-store.test.ts` > get > should return null when context directory does not exist
- `context-store.test.ts` > search > should return empty array when no matches
- `context-store.test.ts` > search > should return empty array when context directory does not exist
- `context-store.test.ts` > search > should skip non-markdown files

**Configuration tests:**
- `context-store.test.ts` > search > should return empty array when directory exists but has no .md files

**Fixes:** None

---

### REQ-CTX-002: Per-user context store write operations

**Phase:** Post-27A | **Status:** Implemented

Per-user context entries stored at `data/users/<userId>/context/`. Save, remove, list operations with auto-slug key generation. User entries override system entries on key collision.

**Tests:** `core/src/services/context-store/__tests__/context-store.test.ts`

**Standard tests:**
- `context-store.test.ts` > searchForUser > should include user-specific entries in search results
- `context-store.test.ts` > searchForUser > should prioritize user entries over system entries with same key
- `context-store.test.ts` > getForUser > should return user entry when it exists
- `context-store.test.ts` > getForUser > should fall back to system entry when no user entry
- `context-store.test.ts` > listForUser > should list user context entries
- `context-store.test.ts` > save > should save a new context entry
- `context-store.test.ts` > save > should overwrite an existing entry
- `context-store.test.ts` > remove > should remove an existing entry
- `context-store.test.ts` > slugifyKey > should lowercase and hyphenate
- `context-store.test.ts` > slugifyKey > should collapse multiple hyphens
- `context-store.test.ts` > slugifyKey > should trim leading and trailing hyphens
- `context-store.test.ts` > slugifyKey > should remove non-alphanumeric characters
- `context-store.test.ts` > slugifyKey > should handle already-valid slugs

**Edge case tests:**
- `context-store.test.ts` > save > should generate slug from natural language name
- `context-store.test.ts` > slugifyKey > should reject empty string after slugification
- `context-store.test.ts` > remove > should handle natural language key names
- `context-store.test.ts` > listForUser > should return empty array for nonexistent user
- `context-store.test.ts` > searchForUser > should deduplicate entries with same key from system and user
- `context-store.test.ts` > save > should reject empty key after slugification (symbols-only)

**Security tests:**
- `context-store.test.ts` > save > should reject invalid userId
- `context-store.test.ts` > save > should reject path traversal in key
- `context-store.test.ts` > remove > should reject invalid userId
- `context-store.test.ts` > remove > should reject path traversal in key
- `context-store.test.ts` > searchForUser > should reject invalid userId
- `context-store.test.ts` > listForUser > should reject invalid userId

**Fixes:** None

---

## 16. Daily Diff

### REQ-DIFF-001: Change log collection and filtering

**Phase:** 7 | **Status:** Implemented

The daily diff collector must parse JSONL change log entries, filter by date, and group by app and user.

**Standard tests:**
- `collector.test.ts` > should parse and filter entries by date
- `collector.test.ts` > should group entries by app and user

**Edge case tests:**
- `collector.test.ts` > should handle missing log file gracefully
- `collector.test.ts` > should handle empty log file
- `collector.test.ts` > should skip malformed JSONL lines

**Configuration tests:**
- `collector.test.ts` > should include entries exactly at the since boundary

**Fixes:** None

### REQ-DIFF-002: Daily diff report generation

**Phase:** 7 | **Status:** Implemented

The daily diff service must produce Markdown reports from change log entries. LLM summarization must be optional. No report must be written when there are no changes.

**Standard tests:**
- `daily-diff.test.ts` > should produce a markdown report from change log entries
- `daily-diff.test.ts` > should include LLM summary when summarization is enabled

**Edge case tests:**
- `daily-diff.test.ts` > should not write a report when there are no changes
- `daily-diff.test.ts` > should filter out entries before the since date
- `daily-diff.test.ts` > should gracefully handle LLM failure with summarization enabled

**Fixes:** None

### REQ-DIFF-003: Change summarization via LLM

**Phase:** 7 | **Status:** Implemented

The summarizer must format change entries into a prompt and call the LLM. Empty entries must return an empty string. LLM failures must be handled gracefully.

**Standard tests:**
- `summarizer.test.ts` > should call LLM with formatted prompt

**Edge case tests:**
- `summarizer.test.ts` > should return empty string when no entries
- `summarizer.test.ts` > should return empty string when LLM fails
- `summarizer.test.ts` > should include app ID and operation in prompt
- `summarizer.test.ts` > should handle entries with special characters in paths

**Security tests:**
- `summarizer.test.ts` > prompt injection hardening > sanitizes change data containing injection attempt
- `summarizer.test.ts` > prompt injection hardening > includes anti-instruction framing
- `summarizer.test.ts` > prompt injection hardening > truncates excessively long change lists

**Fixes:** None

---

## 17. Audio Service

### REQ-AUDIO-001: Text-to-speech via Piper

**Phase:** 7 | **Status:** Implemented

The audio service must generate WAV audio from text using Piper TTS. Custom Piper paths and voices must be supported. Temp files must be cleaned up even on failure.

**Standard tests:**
- `audio-service.test.ts` > tts > should spawn Piper with correct arguments
- `audio-service.test.ts` > tts > should use custom Piper path and voice
- `audio-service.test.ts` > tts > should return the WAV buffer

**Edge case tests:**
- `audio-service.test.ts` > tts > should clean up temp files even on failure
- `audio-service.test.ts` > tts > should pass text to Piper via stdin temp file

**Fixes:** None

### REQ-AUDIO-002: Speak pipeline (TTS + cast)

**Phase:** 7 | **Status:** Implemented

The speak pipeline must chain TTS, FFmpeg conversion, and Chromecast output. Explicit device must override default. Missing device must log a warning and skip. Subprocess failures must be logged but not thrown.

**Standard tests:**
- `audio-service.test.ts` > speak > should chain TTS, FFmpeg, and Chromecast
- `audio-service.test.ts` > speak > should use explicit device over default

**Edge case tests:**
- `audio-service.test.ts` > speak > should warn and skip when no device is configured
- `audio-service.test.ts` > speak > should log error but not throw on subprocess failure
- `audio-service.test.ts` > speak > should clean up temp MP3 file even on failure

**Fixes:** None

---

## 18. HTTP Server

### REQ-SERVER-001: Health check endpoint

**Phase:** 5 | **Status:** Implemented

The server must expose a `GET /health` endpoint that returns 200 with `{ status: "ok" }`.

**Standard tests:**
- `health.test.ts` > should return 200 with status ok

**Edge case tests:**
- `health.test.ts` > should return application/json content type
- `health.test.ts` > should return uptime as a non-negative number

**Fixes:** None

### REQ-SERVER-002: Webhook endpoint with secret validation

**Phase:** 5 | **Status:** Implemented

The server must expose a Telegram webhook endpoint that validates the secret token header. Requests with missing or wrong tokens must be rejected. The callback must be invoked for valid requests. Callback errors must not crash the server.

**Standard tests:**
- `webhook.test.ts` > should call the webhook callback with the request body
- `webhook.test.ts` > should accept requests with correct secret token

**Edge case tests:**
- `webhook.test.ts` > should return 200 even when callback throws
- `webhook.test.ts` > should reject requests with missing secret token
- `webhook.test.ts` > should reject requests with wrong secret token

**Fixes:** None

---

## 19. Management GUI

### REQ-GUI-001: Token-based authentication

**Phase:** 8 | **Status:** Implemented

The GUI must require token-based authentication via HTTP-only cookie. Login must validate the token. Logout must clear the cookie. Unauthenticated requests must redirect to login.

**Standard tests:**
- `auth.test.ts` > GET /gui/login renders login page
- `auth.test.ts` > POST /gui/login with correct token sets cookie and redirects
- `auth.test.ts` > authenticated request with valid cookie succeeds
- `auth.test.ts` > POST /gui/logout clears cookie and redirects

**Edge case tests:**
- `auth.test.ts` > POST /gui/login with wrong token shows error
- `auth.test.ts` > unauthenticated request to protected route redirects to login

**Fixes:** None

### REQ-GUI-002: Dashboard and management routes

**Phase:** 8 | **Status:** Implemented

The GUI must provide routes for dashboard, app list, app details, app toggle, scheduler view, log viewer, config view, and LLM usage. Non-existent apps must return 404.

**Standard tests:**
- `routes.test.ts` > GET /gui/ (Dashboard) > returns 200 with dashboard content
- `routes.test.ts` > GET /gui/ (Dashboard) > shows loaded app count
- `routes.test.ts` > GET /gui/apps > returns 200 with app list
- `routes.test.ts` > GET /gui/apps/:appId > returns 200 for existing app
- `routes.test.ts` > POST /gui/apps/:appId/toggle > toggles app state and returns updated button
- `routes.test.ts` > GET /gui/scheduler > returns 200 with scheduler content
- `routes.test.ts` > GET /gui/logs > returns 200 with log viewer
- `routes.test.ts` > GET /gui/config > returns 200 with config content
- `routes.test.ts` > GET /gui/config > shows registered users
- `routes.test.ts` > GET /gui/llm > returns 200 with empty state when no usage

**Edge case tests:**
- `routes.test.ts` > GET /gui/apps/:appId > returns 404 for non-existent app
- `routes.test.ts` > GET /gui/logs > handles missing log file gracefully
- `routes.test.ts` > GET /gui/logs > parses JSON log entries when file exists

**Fixes:** None

---

## 20. Utilities

### REQ-UTIL-001: Date formatting utilities

**Phase:** 2 | **Status:** Implemented

The system must provide consistent date formatting: ISO 8601, YYYY-MM-DD, and YYYY-MM-DD_HH-mm-ss for archives. Functions must default to current date.

**Standard tests:**
- `date.test.ts` > toISO > returns ISO 8601 string for a given date
- `date.test.ts` > toDateString > returns YYYY-MM-DD format
- `date.test.ts` > toArchiveTimestamp > returns YYYY-MM-DD_HH-mm-ss format

**Edge case tests:**
- `date.test.ts` > toISO > defaults to current date when no argument provided
- `date.test.ts` > toDateString > defaults to current date when no argument provided
- `date.test.ts` > toArchiveTimestamp > replaces colons with hyphens and T with underscore

**Fixes:** None

### REQ-UTIL-002: Atomic file operations

**Phase:** 2 | **Status:** Implemented

File writes must be atomic (temp file + rename) to prevent partial reads. Directory creation must be recursive and idempotent.

**Standard tests:**
- `file.test.ts` > ensureDir > creates nested directories
- `file.test.ts` > ensureDir > is idempotent — calling twice does not error
- `file.test.ts` > atomicWrite > creates file with correct content
- `file.test.ts` > atomicWrite > creates parent directories

**Edge case tests:**
- `file.test.ts` > atomicWrite > overwrites existing file
- `file.test.ts` > atomicWrite > leaves no temp file after completion

**Fixes:**
- 2026-03-11: `atomicWrite` failed with EPERM on Windows when concurrent writes targeted the same file. Added retry logic (3 attempts with backoff) for EPERM/EACCES on Windows. See CLAUDE.md "Comprehensive Security & Correctness Review (2026-03)".

### REQ-UTIL-003: YAML read/write utilities

**Phase:** 2 | **Status:** Implemented

The system must provide YAML parse/serialize and file read/write with atomic writes. Reading a non-existent file returns null.

**Standard tests:**
- `yaml.test.ts` > parseYaml > parses YAML string to object
- `yaml.test.ts` > toYaml > serializes object to YAML string
- `yaml.test.ts` > writeYamlFile > creates file on disk
- `yaml.test.ts` > readYamlFile > reads a written YAML file
- `yaml.test.ts` > roundtrip > writeYamlFile then readYamlFile returns original data

**Edge case tests:**
- `yaml.test.ts` > readYamlFile > returns null for non-existent file
- `yaml.test.ts` > readYamlFile > returns null for directory path
- `yaml.test.ts` > parseYaml > handles empty string

**Fixes:** None

### REQ-UTIL-004: Frequency picker (frequencyToCron / cronToFrequency)

**Phase:** GUI Improvements | **Status:** Implemented

Bidirectional mapping between human-friendly frequency settings (hourly, daily, weekly, monthly, quarterly, yearly) and 5-field cron expressions. Used by report and alert GUI forms. `frequencyToCron` clamps out-of-range values; `cronToFrequency` accepts leading-zero fields and rejects step/range/list patterns.

**Standard tests:**
- `frequency-picker.test.ts` > frequencyToCron > converts hourly
- `frequency-picker.test.ts` > frequencyToCron > converts hourly with minute offset
- `frequency-picker.test.ts` > frequencyToCron > converts daily
- `frequency-picker.test.ts` > frequencyToCron > converts daily at midnight
- `frequency-picker.test.ts` > frequencyToCron > converts daily at 11pm
- `frequency-picker.test.ts` > frequencyToCron > converts weekly on Monday
- `frequency-picker.test.ts` > frequencyToCron > converts weekly on Sunday
- `frequency-picker.test.ts` > frequencyToCron > converts monthly on the 15th
- `frequency-picker.test.ts` > frequencyToCron > converts monthly defaults to 1st
- `frequency-picker.test.ts` > frequencyToCron > converts quarterly
- `frequency-picker.test.ts` > frequencyToCron > converts yearly
- `frequency-picker.test.ts` > frequencyToCron > returns * * * * * for custom
- `frequency-picker.test.ts` > frequencyToCron > defaults hour to 9
- `frequency-picker.test.ts` > frequencyToCron > defaults minute to 0
- `frequency-picker.test.ts` > cronToFrequency > recognizes hourly
- `frequency-picker.test.ts` > cronToFrequency > recognizes hourly with minute
- `frequency-picker.test.ts` > cronToFrequency > recognizes daily
- `frequency-picker.test.ts` > cronToFrequency > recognizes daily at midnight
- `frequency-picker.test.ts` > cronToFrequency > recognizes weekly
- `frequency-picker.test.ts` > cronToFrequency > recognizes weekly Sunday
- `frequency-picker.test.ts` > cronToFrequency > recognizes monthly
- `frequency-picker.test.ts` > cronToFrequency > recognizes quarterly
- `frequency-picker.test.ts` > cronToFrequency > recognizes yearly
- `frequency-picker.test.ts` > cronToFrequency > roundtrips hourly
- `frequency-picker.test.ts` > cronToFrequency > roundtrips daily
- `frequency-picker.test.ts` > cronToFrequency > roundtrips weekly
- `frequency-picker.test.ts` > cronToFrequency > roundtrips monthly
- `frequency-picker.test.ts` > cronToFrequency > roundtrips quarterly
- `frequency-picker.test.ts` > cronToFrequency > roundtrips yearly

**Edge case tests:**
- `frequency-picker.test.ts` > cronToFrequency > returns custom for complex cron
- `frequency-picker.test.ts` > cronToFrequency > returns custom for empty string
- `frequency-picker.test.ts` > cronToFrequency > returns custom for invalid input
- `frequency-picker.test.ts` > cronToFrequency > returns custom for 6-field cron
- `frequency-picker.test.ts` > cronToFrequency > returns custom for day-of-month > 28
- `frequency-picker.test.ts` > cronToFrequency > recognizes daily with leading-zero hour
- `frequency-picker.test.ts` > cronToFrequency > recognizes hourly with leading-zero minute
- `frequency-picker.test.ts` > cronToFrequency > recognizes weekly with leading zeros
- `frequency-picker.test.ts` > cronToFrequency > recognizes monthly with leading zeros
- `frequency-picker.test.ts` > cronToFrequency > recognizes quarterly with leading zeros
- `frequency-picker.test.ts` > cronToFrequency > recognizes yearly with leading zeros
- `frequency-picker.test.ts` > cronToFrequency > returns custom for step pattern
- `frequency-picker.test.ts` > cronToFrequency > returns custom for range pattern
- `frequency-picker.test.ts` > cronToFrequency > returns custom for list pattern in DOW
- `frequency-picker.test.ts` > cronToFrequency > returns custom for null
- `frequency-picker.test.ts` > cronToFrequency > returns custom for undefined
- `frequency-picker.test.ts` > cronToFrequency > returns custom for non-string
- `frequency-picker.test.ts` > frequencyToCron > clamps negative hour to 0
- `frequency-picker.test.ts` > frequencyToCron > clamps hour above 23 to 23
- `frequency-picker.test.ts` > frequencyToCron > clamps negative minute to 0
- `frequency-picker.test.ts` > frequencyToCron > clamps minute above 59 to 59
- `frequency-picker.test.ts` > frequencyToCron > clamps dayOfMonth above 28 to 28
- `frequency-picker.test.ts` > frequencyToCron > clamps dayOfMonth below 1 to 1
- `frequency-picker.test.ts` > frequencyToCron > clamps negative dayOfWeek to 0
- `frequency-picker.test.ts` > frequencyToCron > clamps dayOfWeek above 6 to 6
- `frequency-picker.test.ts` > frequencyToCron > floors fractional values
- `frequency-picker.test.ts` > frequencyToCron > falls back to defaults for NaN values

**Fixes:** C1 (cronToFrequency rejected leading-zero hours/minutes), C2 (frequencyToCron accepted out-of-range values)

---

## 21. Cross-Cutting Security

### REQ-SEC-001: Path traversal prevention

**Phase:** 2 | **Status:** Implemented

All data store operations must reject path traversal attempts (`../`, absolute paths) with a `PathTraversalError`.

**Standard tests:** None (all tests are edge cases by nature)

**Edge case tests:**
- `scoped-store.test.ts` > path traversal protection > rejects path with .. traversal
- `scoped-store.test.ts` > path traversal protection > rejects write with .. traversal
- `scoped-store.test.ts` > path traversal protection > rejects append with .. traversal
- `scoped-store.test.ts` > path traversal protection > rejects exists with .. traversal
- `scoped-store.test.ts` > path traversal protection > rejects list with .. traversal
- `scoped-store.test.ts` > path traversal protection > rejects archive with .. traversal
- `scoped-store.test.ts` > path traversal protection > rejects backslash traversal (..\\..)
- `context-store.test.ts` > get > should reject path traversal attempts
- `paths.test.ts` > findMatchingScope > rejects traversal out of directory scope via ..
- `paths.test.ts` > findMatchingScope > rejects traversal with backslashes
- `paths.test.ts` > findMatchingScope > resolves . segments and still matches
- `paths.test.ts` > findMatchingScope > resolves nested .. that stays within scope
- `paths.test.ts` > findMatchingScope > rejects double traversal escaping scope entirely
- `paths.test.ts` > findMatchingScope > rejects traversal from different scope
- `paths.test.ts` > findMatchingScope > exact file scope with normalized path still matches
- `paths.test.ts` > findMatchingScope > rejects absolute path input
- `paths.test.ts` > findMatchingScope > rejects bare . input
- `paths.test.ts` > findMatchingScope > rejects path with null byte
- `paths.test.ts` > findMatchingScope > treats URL-encoded path separators as literal characters (not decoded)
- `paths.test.ts` > findMatchingScope > handles extremely long path without crashing

**See also:** REQ-DATA-001, REQ-CTX-001

**Fixes:**
- **D2a (2026-04-13):** Virtual POSIX normalization in findMatchingScope() — prevents declared-scope bypass via .. segments. Null-byte rejection added to normalizePosix(). CL: D2a-scope-fix.

### REQ-SEC-002: Webhook secret validation

**Phase:** 5, 9 | **Status:** Implemented

Telegram webhook requests must be authenticated via a secret token header using timing-safe comparison.

**Standard tests:**
- `webhook.test.ts` > should accept requests with correct secret token

**Edge case tests:**
- `webhook.test.ts` > should reject requests with missing secret token
- `webhook.test.ts` > should reject requests with wrong secret token

**See also:** REQ-SERVER-002

**Fixes:** None

### REQ-SEC-003: LLM prompt injection mitigation

**Phase:** 4 | **Status:** Implemented

User-provided text in LLM prompts must be wrapped in delimiters with explicit instructions not to follow embedded instructions.

**Standard tests:** None (all tests are edge cases)

**Edge case tests:**
- `classify.test.ts` > buildClassifyPrompt > wraps user text in delimiters for prompt injection mitigation
- `extract-structured.test.ts` > buildExtractPrompt (injection mitigation) > wraps user text in delimiters

**See also:** REQ-LLM-001, REQ-LLM-002

**Fixes:** None

### REQ-SEC-004: Router error isolation

**Phase:** 5 | **Status:** Implemented

App handler errors must be caught and logged by the router. Individual app failures must not crash the system or affect other apps.

**Standard tests:** None (tested via edge case)

**Edge case tests:**
- `router.test.ts` > routeMessage — error isolation > should catch and log app handler errors

**Fixes:** None

### REQ-SEC-005: LLMGuard cost enforcement bypass prevention

**Phase:** 13 | **Status:** Implemented

LLMGuard config must reject NaN, zero, and negative values that would silently disable enforcement. The manifest schema must use `exclusiveMinimum: 0` for `monthly_cost_cap`.

**Edge case tests:**
- `llm-guard.test.ts` > config validation > rejects NaN monthlyCostCap
- `llm-guard.test.ts` > config validation > rejects zero monthlyCostCap
- `llm-guard.test.ts` > config validation > rejects negative globalMonthlyCostCap
- `llm-guard.test.ts` > config validation > rejects zero maxRequests

**See also:** REQ-LLM-012

**Fixes:**
- 2026-03-11: Added constructor validation + schema exclusiveMinimum (Phase 13 security review Fix 2, Fix 3)

### REQ-SEC-006: CSRF double-submit cookie protection

**Phase:** 9 | **Status:** Implemented

All GUI POST/PUT/DELETE requests must include a CSRF token matching the signed cookie. Tokens must be generated cryptographically (32 random bytes). Validation must use timing-safe comparison. Login and public paths must be exempted.

**Standard tests:**
- `csrf.test.ts` > GET request sets CSRF cookie
- `csrf.test.ts` > GET request returns CSRF token on request object
- `csrf.test.ts` > POST with valid CSRF token via header succeeds
- `csrf.test.ts` > POST with valid CSRF token via body field succeeds
- `csrf.test.ts` > reuses existing CSRF cookie on subsequent GET requests
- `csrf.test.ts` > header token takes priority over body field

**Edge case tests:**
- `csrf.test.ts` > rejects POST without CSRF cookie
- `csrf.test.ts` > rejects POST without CSRF token in header or body
- `csrf.test.ts` > rejects POST with mismatched CSRF token
- `csrf.test.ts` > rejects POST with invalid (unsigned) CSRF cookie
- `csrf.test.ts` > skips CSRF for /gui/login POST
- `csrf.test.ts` > skips CSRF for /gui/public/ paths

**Security tests:**
- `csrf.test.ts` > rejects POST with empty string CSRF token

**State transition tests:**
- `csrf.test.ts` > allows token reuse across multiple POSTs

**Fixes:** None

### REQ-SEC-007: LLM prompt input sanitization

**Phase:** 4 | **Status:** Implemented

User input in LLM prompts must be truncated to a maximum length (2000 chars) and backtick sequences (3+) neutralized to prevent delimiter escape.

**Standard tests:**
- `prompt-templates.test.ts` > sanitizeInput > returns text unchanged when under the default limit
- `prompt-templates.test.ts` > sanitizeInput > does not alter single or double backticks
- `prompt-templates.test.ts` > buildClassifyPrompt > includes all categories as a numbered list
- `prompt-templates.test.ts` > buildClassifyPrompt > includes the sanitized user text
- `prompt-templates.test.ts` > buildClassifyPrompt > wraps user text in triple backtick delimiters
- `prompt-templates.test.ts` > buildClassifyPrompt > includes classification instructions
- `prompt-templates.test.ts` > buildExtractPrompt > includes the schema as formatted JSON
- `prompt-templates.test.ts` > buildExtractPrompt > includes the sanitized user text
- `prompt-templates.test.ts` > buildExtractPrompt > wraps user text in triple backtick delimiters
- `prompt-templates.test.ts` > buildExtractPrompt > includes extraction instructions

**Edge case tests:**
- `prompt-templates.test.ts` > sanitizeInput > truncates text exceeding maxLength
- `prompt-templates.test.ts` > sanitizeInput > replaces triple backticks with a single backtick
- `prompt-templates.test.ts` > sanitizeInput > replaces longer backtick sequences too
- `prompt-templates.test.ts` > sanitizeInput > handles custom maxLength
- `prompt-templates.test.ts` > buildClassifyPrompt > sanitizes injection attempts with triple backticks in user text
- `prompt-templates.test.ts` > buildExtractPrompt > sanitizes injection attempts with triple backticks in user text

**Fixes:** None

### REQ-SEC-008: XSS prevention via HTML escaping

**Phase:** 8-9 | **Status:** Implemented

All dynamic content in GUI HTML responses must be escaped using escapeHtml (&, <, >, ", '). This applies to app names, model IDs, log entries, and all htmx partial responses.

**Standard tests:**
- `security-measures.test.ts` > escapeHtml > escapes ampersand
- `security-measures.test.ts` > escapeHtml > escapes less-than
- `security-measures.test.ts` > escapeHtml > escapes greater-than
- `security-measures.test.ts` > escapeHtml > escapes double quotes
- `security-measures.test.ts` > escapeHtml > escapes single quotes
- `security-measures.test.ts` > escapeHtml > handles multiple special characters in one string

**Edge case tests:**
- `security-measures.test.ts` > escapeHtml > returns empty string unchanged
- `security-measures.test.ts` > escapeHtml > handles string with no special characters unchanged
- `security-measures.test.ts` > escapeHtml > handles string of ONLY special characters

**Fixes:** None

### REQ-SEC-009: Telegram Markdown injection escaping

**Phase:** 5 | **Status:** Implemented

User-controlled text in Telegram messages (command names, app names, descriptions) must escape all MarkdownV2 special characters.

**Standard tests:**
- `security-measures.test.ts` > escapeMarkdown > escapes underscore
- `security-measures.test.ts` > escapeMarkdown > escapes asterisk
- `security-measures.test.ts` > escapeMarkdown > escapes brackets
- `security-measures.test.ts` > escapeMarkdown > escapes backtick
- `security-measures.test.ts` > escapeMarkdown > handles multiple markdown characters

**Edge case tests:**
- `security-measures.test.ts` > escapeMarkdown > returns plain text unchanged
- `security-measures.test.ts` > escapeMarkdown > handles empty string

**Fixes:** None

### REQ-SEC-010: Model ID input validation

**Phase:** 8 | **Status:** Implemented

Model IDs submitted via the GUI must match `/^[a-zA-Z0-9._:-]{1,100}$/`. This prevents injection into API parameters and XSS via model ID display.

**Standard tests:**
- `security-measures.test.ts` > MODEL_ID_PATTERN > accepts claude-sonnet-4-20250514
- `security-measures.test.ts` > MODEL_ID_PATTERN > accepts gpt-4o
- `security-measures.test.ts` > MODEL_ID_PATTERN > accepts gemini-2.0-flash
- `security-measures.test.ts` > MODEL_ID_PATTERN > accepts o3-mini

**Edge case tests:**
- `security-measures.test.ts` > MODEL_ID_PATTERN > rejects model ID with spaces
- `security-measures.test.ts` > MODEL_ID_PATTERN > rejects model ID with slashes
- `security-measures.test.ts` > MODEL_ID_PATTERN > rejects model ID with angle brackets (XSS)
- `security-measures.test.ts` > MODEL_ID_PATTERN > rejects model ID over 100 chars
- `security-measures.test.ts` > MODEL_ID_PATTERN > rejects empty string
- `security-measures.test.ts` > MODEL_ID_PATTERN > rejects model ID with backticks

**Fixes:** None

### REQ-SEC-011: GUI POST parameter format validation

**Phase:** 9 | **Status:** Implemented

All GUI POST routes must validate userId and appId format (defense-in-depth) before processing. appId: `/^[a-z0-9-]+$/`, userId: `/^[a-zA-Z0-9_-]+$/`.

**Standard tests:**
- `security-measures.test.ts` > userId/appId format validation > appId pattern > accepts lowercase with hyphens (echo-app)
- `security-measures.test.ts` > userId/appId format validation > appId pattern > accepts lowercase with hyphens (my-app-1)
- `security-measures.test.ts` > userId/appId format validation > userId pattern > accepts alphanumeric with underscores (user_1)
- `security-measures.test.ts` > userId/appId format validation > userId pattern > accepts alphanumeric with hyphens (test-user)
- `security-measures.test.ts` > userId/appId format validation > userId pattern > accepts numeric-only (12345)

**Edge case tests:**
- `security-measures.test.ts` > userId/appId format validation > appId pattern > rejects uppercase (EchoApp)
- `security-measures.test.ts` > userId/appId format validation > appId pattern > rejects spaces
- `security-measures.test.ts` > userId/appId format validation > appId pattern > rejects slashes
- `security-measures.test.ts` > userId/appId format validation > appId pattern > rejects dots
- `security-measures.test.ts` > userId/appId format validation > userId pattern > rejects spaces
- `security-measures.test.ts` > userId/appId format validation > userId pattern > rejects slashes
- `security-measures.test.ts` > userId/appId format validation > userId pattern > rejects angle brackets

**Security tests:**
- `security-measures.test.ts` > userId/appId format validation > appId security > rejects unicode characters
- `security-measures.test.ts` > userId/appId format validation > appId security > rejects emoji
- `security-measures.test.ts` > userId/appId format validation > appId security > rejects null bytes

**Fixes:** None

### REQ-SEC-012: Log file tail-read memory bound

**Phase:** 9 | **Status:** Implemented

The log viewer must read at most 512KB from the end of the log file to prevent memory exhaustion.

**Standard tests:**
- `security-measures.test.ts` > MAX_TAIL_BYTES > equals 512 * 1024 (512 KB)

**Edge case tests:** None

**Fixes:** None

---

## 22. Non-Functional Requirements

### REQ-NFR-001: Single-process architecture

**Phase:** 0 | **Status:** Implemented

All apps must run in a single Node.js process. Target hardware: Mac Mini with 32GB RAM.

**Tests:** Architectural constraint — verified by system design, not unit tests.

**Fixes:** None

### REQ-NFR-002: Graceful shutdown orchestration

**Phase:** 9 | **Status:** Implemented

The system must shut down gracefully: track in-flight requests, drain with timeout, stop services in order (bot, scheduler, telegram, registry, event bus, rate limiters, shutdown callbacks, server). Double-shutdown must be prevented.

**Standard tests:**
- `shutdown.test.ts` > constructor sets default drainTimeoutMs of 10000
- `shutdown.test.ts` > registerServices stores services
- `shutdown.test.ts` > isShuttingDown returns false initially
- `shutdown.test.ts` > trackRequest executes and returns the function result
- `shutdown.test.ts` > shutdown calls all service teardown methods in order
- `shutdown.test.ts` > shutdown stops bot if provided (polling mode)
- `shutdown.test.ts` > shutdown runs onShutdown callbacks
- `shutdown.test.ts` > shutdown disposes all rate limiters

**Edge case tests:**
- `shutdown.test.ts` > edge cases > trackRequest returns undefined during shutdown
- `shutdown.test.ts` > edge cases > shutdown prevents double-shutdown (second call is no-op)
- `shutdown.test.ts` > edge cases > shutdown works without registered services
- `shutdown.test.ts` > edge cases > onShutdown callback errors are swallowed (best-effort)
- `shutdown.test.ts` > edge cases > drain timeout forces shutdown when in-flight requests do not complete
- `shutdown.test.ts` > edge cases > trackRequest decrements count even when function throws

**Fixes:** None

### REQ-NFR-003: ESM-only with strict TypeScript

**Phase:** 0 | **Status:** Implemented

The entire codebase must use ESM (`"type": "module"`) with strict TypeScript (`strict: true`). No `any` unless absolutely unavoidable.

**Tests:** Enforced by `tsconfig.json` and build process.

**Fixes:** None

---

### REQ-NFR-004: Global error boundary

**Phase:** 9 | **Status:** Implemented

The system must register global handlers for uncaught exceptions and unhandled rejections. Uncaught exceptions must trigger graceful shutdown with a 30s force-exit timeout. Unhandled rejections must be logged but not exit the process.

**Standard tests:**
- `error-handler.test.ts` > registers an uncaughtException handler
- `error-handler.test.ts` > registers an unhandledRejection handler
- `error-handler.test.ts` > logs fatal on uncaughtException
- `error-handler.test.ts` > calls shutdownFn on uncaughtException when provided
- `error-handler.test.ts` > logs error on unhandledRejection

**Edge case tests:**
- `error-handler.test.ts` > exits immediately when no shutdownFn is provided
- `error-handler.test.ts` > sets 30s force-exit timeout on uncaughtException with shutdownFn
- `error-handler.test.ts` > does not call process.exit when shutdownFn is provided
- `error-handler.test.ts` > does not exit on unhandledRejection

**Fixes:** None

---

## 23. Integration / E2E

### REQ-INTEG-001: End-to-end echo app pipeline

**Phase:** 6 | **Status:** Implemented

The echo app must demonstrate the full pipeline: app loading, command routing, intent classification, data store writes, and user authorization enforcement.

**Standard tests:**
- `e2e-echo.test.ts` > should load the echo app
- `e2e-echo.test.ts` > should route /echo command and send response
- `e2e-echo.test.ts` > should write echo log to data store on /echo command
- `e2e-echo.test.ts` > should route free text via intent classifier to echo app
- `e2e-echo.test.ts` > should write echo log to data store on free text

**Edge case tests:**
- `e2e-echo.test.ts` > should reject messages from unregistered users

**Fixes:** None

### REQ-INTEG-002: Echo app unit behavior

**Phase:** 6 | **Status:** Implemented

The echo app must echo text back, handle commands, and log all messages to its data store.

**Standard tests:**
- `echo.test.ts` > init > should store services without error
- `echo.test.ts` > handleMessage > should echo the text back to the user
- `echo.test.ts` > handleMessage > should append the message to log.md
- `echo.test.ts` > handleCommand > should echo joined args back to the user
- `echo.test.ts` > handleCommand > should append the command to log.md

**Edge case tests:**
- `echo.test.ts` > handleCommand > should send "(empty)" when no args given

**Fixes:** None

---

## 24. Planned Requirements (Future Phases)

### REQ-GUI-003: Multi-provider model management GUI

**Phase:** 14 | **Status:** Implemented

**Scope:** GUI template rendering and htmx interactions — tier assignment cards, provider tables, available models display grouped by provider. See also REQ-LLM-022 (route handler logic) and REQ-LLM-024 (tier POST endpoint).

**Standard tests:**
- `llm-usage.test.ts` > `GET /gui/llm` > renders tier assignments with provider info
- `llm-usage.test.ts` > `GET /gui/llm` > shows providers table
- `llm-usage.test.ts` > `GET /gui/llm/available-models` > renders models grouped by provider
- `llm-usage.test.ts` > `GET /gui/llm/available-models` > shows Set buttons

**Edge case tests:**
- `llm-usage.test.ts` > `GET /gui/llm` > shows "Not configured" for reasoning when undefined
- `llm-usage.test.ts` > `GET /gui/llm/available-models` > correct active status with ModelRef
- `llm-usage.test.ts` > `GET /gui/llm/available-models` > HTML-escapes provider names
- `llm-usage.test.ts` > `GET /gui/llm/available-models` > catalog failure
- `llm-usage.test.ts` > `GET /gui/llm/available-models` > pricing-table fallback

### REQ-LLM-015: System-level global cost cap guard

**Phase:** 14 | **Status:** Implemented

Infrastructure LLM calls (router, daily diff, condition evaluator) must check the global monthly cost cap. Implemented via `SystemLLMGuard` wrapper. See REQ-LLM-023 for full implementation details and test references.

**Standard tests:** See REQ-LLM-023 (`system-llm-guard.test.ts`)
**Edge case tests:** See REQ-LLM-023 (`system-llm-guard.test.ts`)

**See also:** Deferred issue D3 in CLAUDE.md (resolved)

### REQ-LLM-016: Unknown model cost warning

**Phase:** 14 | **Status:** Implemented

Unknown models must log a warning when estimated cost is $0 for a non-empty model string. This surfaces unrecognized models so operators can add pricing to `model-pricing.ts`.

**Standard tests:**
- `cost-tracker.test.ts` > unknown model warning (D1) > logs warning when cost is 0 for non-empty model

**Edge case tests:**
- `cost-tracker.test.ts` > unknown model warning (D1) > does not warn for known model

**See also:** Deferred issue D1 in CLAUDE.md (resolved)

### REQ-LLM-017: Floating-point precision in cost accumulation

**Phase:** 14 | **Status:** Implemented

Cost accumulation must round to 6 decimal places before summing to prevent floating-point precision degradation.

**Standard tests:**
- `cost-tracker.test.ts` > monthly cost tracking > maintains precision after many small additions (D5)

**Edge case tests:**
- `model-pricing.test.ts` > estimateCallCost > rounds result to 6 decimal places (D5)

**See also:** Deferred issue D5 in CLAUDE.md (resolved)

### REQ-ROUTE-005: Chatbot fallback (conversational AI)

**Phase:** 16 | **Status:** Implemented

When no app matches a message, route to a built-in chatbot app that uses LLMService (standard tier) + ContextStore for personalized conversational AI responses. Configurable via `defaults.fallback` in pas.yaml (`chatbot` or `notes`). Daily notes append preserved as side effect. Graceful degradation to notes acknowledgment when LLM fails.

**Standard tests:**
- `router.test.ts` > routeMessage — chatbot fallback > dispatches to chatbot app when fallback mode is chatbot
- `router.test.ts` > routeMessage — chatbot fallback > uses FallbackHandler when fallback mode is notes
- `router.test.ts` > routeMessage — chatbot fallback > defaults to chatbot mode when fallbackMode not specified
- `chatbot.test.ts` > handleMessage > sends LLM response to user
- `chatbot.test.ts` > handleMessage > calls LLM with standard tier
- `chatbot.test.ts` > handleMessage > includes context store results in system prompt
- `chatbot.test.ts` > handleMessage > includes conversation history in system prompt

**Fixes:**
- D20 (2026-03): Chatbot fallback dispatch bypassed `isAppEnabled()` — disabled chatbot still received messages. Fixed by adding `isAppEnabled()` check in router fallback branch.

**Edge case tests:**
- `router.test.ts` > routeMessage — chatbot fallback > falls back to notes handler when chatbot mode but no chatbot app
- `router.test.ts` > routeMessage — chatbot fallback > does NOT dispatch to disabled chatbot app — falls back to notes handler
- `router.test.ts` > routeMessage — chatbot fallback > catches chatbot app errors and sends error message
- `chatbot.test.ts` > handleMessage > handles empty message text
- `chatbot.test.ts` > handleMessage > handles no context store entries
- `chatbot.test.ts` > handleMessage > handles empty conversation history (first message)
- `chatbot.test.ts` > handleMessage > limits context entries to 3
- `chatbot.test.ts` > handleMessage > gracefully degrades to notes acknowledgment on LLM failure
- `chatbot.test.ts` > handleMessage > still works when context store throws
- `chatbot.test.ts` > handleMessage > still sends response when history save fails
- `chatbot.test.ts` > handleMessage > still sends response when daily note append fails
- `chatbot.test.ts` > handleMessage > sanitizes triple backticks in user message before LLM
- `chatbot.test.ts` > handleMessage > sanitizes context entries in system prompt (D9)
- `chatbot.test.ts` > handleMessage > sanitizes conversation history in system prompt

### REQ-CHATBOT-001: Conversation history management

**Phase:** 16 | **Status:** Implemented

The chatbot maintains per-user conversation history as JSON via ScopedDataStore. History is loaded before each LLM call and included in the system prompt for continuity. A sliding window (maxTurns, default 20) keeps history bounded. Malformed or missing history files are handled gracefully.

**Standard tests:**
- `conversation-history.test.ts` > load > returns parsed turns from valid JSON
- `conversation-history.test.ts` > load > reads from history.json
- `conversation-history.test.ts` > append > saves user and assistant turns
- `conversation-history.test.ts` > append > appends to existing history
- `conversation-history.test.ts` > append > uses atomic write via store.write

**Edge case tests:**
- `conversation-history.test.ts` > load > returns empty array when store has no data
- `conversation-history.test.ts` > load > truncates to maxTurns on load
- `conversation-history.test.ts` > load > returns empty array for malformed JSON
- `conversation-history.test.ts` > load > returns empty array when JSON is not an array
- `conversation-history.test.ts` > load > returns empty array when JSON is a string
- `conversation-history.test.ts` > load > clamps maxTurns of 0 to 1
- `conversation-history.test.ts` > load > clamps negative maxTurns to 1
- `conversation-history.test.ts` > load > handles maxTurns of 1
- `conversation-history.test.ts` > append > truncates to maxTurns when exceeding limit
- `conversation-history.test.ts` > append > works with empty store (first conversation)
- `conversation-history.test.ts` > append > works with malformed existing data

### REQ-CHATBOT-002: Context-aware responses with prompt sanitization

**Phase:** 16 | **Status:** Implemented

The chatbot searches ContextStore for relevant user preferences/facts and includes them in the LLM system prompt. All user-generated content (messages, context entries, conversation history) is sanitized via `sanitizeInput()` before inclusion in prompts — triple backticks neutralized, anti-instruction framing applied. Addresses deferred issue D9.

**Standard tests:**
- `chatbot.test.ts` > buildSystemPrompt > includes context section when entries present
- `chatbot.test.ts` > buildSystemPrompt > includes conversation history when turns present
- `chatbot.test.ts` > buildSystemPrompt > includes anti-instruction framing for context
- `chatbot.test.ts` > buildSystemPrompt > includes anti-instruction framing for conversation history

**Edge case tests:**
- `chatbot.test.ts` > buildSystemPrompt > includes base personality without context or history
- `chatbot.test.ts` > sanitizeInput > neutralizes triple backticks
- `chatbot.test.ts` > sanitizeInput > neutralizes long backtick sequences
- `chatbot.test.ts` > sanitizeInput > truncates text exceeding maxLength
- `chatbot.test.ts` > sanitizeInput > preserves text at exactly maxLength
- `chatbot.test.ts` > sanitizeInput > passes through normal text

### REQ-CHATBOT-003: Daily notes side effect

**Phase:** 16 | **Status:** Implemented

The chatbot preserves the pre-existing fallback behavior of appending messages to daily notes files. All messages are logged to `chatbot/daily-notes/YYYY-MM-DD.md` before the LLM call, regardless of whether the LLM succeeds.

**Standard tests:**
- `chatbot.test.ts` > handleMessage > appends message to daily notes

**Edge case tests:**
- `chatbot.test.ts` > handleMessage > still sends response when daily note append fails

### REQ-CHATBOT-004: /ask command for PAS-specific help

**Phase:** 18 | **Status:** Implemented

The chatbot `/ask` command provides PAS-specific help using app metadata and infrastructure documentation. With no arguments, it sends a static intro (no LLM cost). With a question, it builds an app-aware system prompt including enabled apps, knowledge base results, context entries, and conversation history. The response is sent to the user and conversation history is saved.

**Standard tests:**
- `chatbot.test.ts` > handleCommand /ask > sends static intro when no args provided
- `chatbot.test.ts` > handleCommand /ask > calls LLM with app-aware prompt when question provided
- `chatbot.test.ts` > handleCommand /ask > saves conversation history after /ask response
- `chatbot.test.ts` > handleCommand /ask > appends to daily notes on /ask

**Edge case tests:**
- `chatbot.test.ts` > handleCommand /ask > sends intro for empty string args
- `chatbot.test.ts` > handleCommand /ask > works when appMetadata returns empty list
- `chatbot.test.ts` > handleCommand /ask > sends error message when LLM fails on /ask
- `chatbot.test.ts` > handleCommand /ask > handles appMetadata.getEnabledApps throwing gracefully
- `chatbot.test.ts` > handleCommand /ask > handles appKnowledge.search throwing gracefully

**Security tests:**
- `chatbot.test.ts` > handleCommand /ask > sanitizes app metadata in the prompt
- `chatbot.test.ts` > handleCommand /ask > includes anti-instruction framing in app-aware prompt

### REQ-CHATBOT-005: Auto-detect PAS-relevant questions

**Phase:** 18 → updated D1 | **Status:** Implemented

When the per-user `auto_detect_pas` config is enabled, the chatbot uses an LLM classifier (`classifyPASMessage()`) to detect PAS-related messages and automatically uses the app-aware system prompt instead of the generic one. Classification uses a compact fast-tier LLM call (no large metadata). Fails open (defaults to app-aware context) on LLM error. Default changed from `false` → `true` in D1.

**Standard tests:**
- `chatbot.test.ts` > auto-detect PAS questions > uses regular prompt when auto-detect is off (default)
- `chatbot.test.ts` > auto-detect PAS questions > uses app-aware prompt when auto-detect is on and LLM classifier returns PAS-relevant
- `chatbot.test.ts` > auto-detect PAS questions > uses regular prompt when auto-detect is on and LLM classifier returns not PAS-relevant

**Edge case tests:**
- `chatbot.test.ts` > auto-detect PAS questions > handles auto-detect config value as string "true"
- `chatbot.test.ts` > auto-detect PAS questions > defaults to false when config.getAll throws (no classifier call, basic prompt)
- `chatbot.test.ts` > auto-detect PAS questions > uses app-aware prompt (fail-open) when classifier LLM call throws

### REQ-CHATBOT-006: PAS relevance detection (isPasRelevant)

**Phase:** 18 | **Status:** Implemented (deprecated in D1)

The `isPasRelevant()` function determines if a message is PAS-related using keyword heuristics: static keywords (pas, app, command, schedule, etc.) and dynamic lookups (installed app names, IDs, command names from AppMetadataService). Case-insensitive. No LLM cost. **Deprecated in D1** — superseded by `classifyPASMessage()` (REQ-CHATBOT-012). Kept for backward compatibility; not called from active code paths.

**Standard tests:**
- `chatbot.test.ts` > isPasRelevant > detects "what apps do I have"
- `chatbot.test.ts` > isPasRelevant > detects "how do i schedule"
- `chatbot.test.ts` > isPasRelevant > detects "what commands are available"
- `chatbot.test.ts` > isPasRelevant > detects installed app names
- `chatbot.test.ts` > isPasRelevant > detects command names from installed apps

**Edge case tests:**
- `chatbot.test.ts` > isPasRelevant > returns false for general questions
- `chatbot.test.ts` > isPasRelevant > returns false for empty text
- `chatbot.test.ts` > isPasRelevant > is case insensitive

### REQ-CHATBOT-007: App-aware system prompt construction

**Phase:** 18 | **Status:** Implemented

The `buildAppAwareSystemPrompt()` constructs a system prompt for PAS-specific questions including: PAS assistant personality, read-only instruction, sanitized app metadata from `AppMetadataService.getEnabledApps()`, sanitized knowledge base results from `AppKnowledgeBase.search()`, context store entries, and conversation history. All sections use anti-instruction framing.

**Standard tests:**
- `chatbot.test.ts` > buildAppAwareSystemPrompt > includes PAS assistant personality
- `chatbot.test.ts` > buildAppAwareSystemPrompt > includes read-only instruction
- `chatbot.test.ts` > buildAppAwareSystemPrompt > includes app metadata when apps are available
- `chatbot.test.ts` > buildAppAwareSystemPrompt > includes knowledge base results
- `chatbot.test.ts` > buildAppAwareSystemPrompt > includes context entries and conversation history

### REQ-SYSINFO-001: System introspection service

**Phase:** Post-19 | **Status:** Implemented

The SystemInfoService provides read-only access to system state (models, costs, scheduling, status) plus model tier switching. It aggregates data from ModelSelector, ProviderRegistry, ModelCatalog, CostTracker, CronManager, UserManager, and AppRegistry. Exposed to apps via `CoreServices.systemInfo` when `system-info` is declared in manifest `requirements.services`.

**Standard tests:**
- `system-info.test.ts` > getTierAssignments > returns standard and fast tiers
- `system-info.test.ts` > getTierAssignments > includes reasoning tier when configured
- `system-info.test.ts` > getProviders > returns provider info from registry
- `system-info.test.ts` > getAvailableModels > returns models from catalog
- `system-info.test.ts` > getModelPricing > returns pricing for known model
- `system-info.test.ts` > getCostSummary > returns monthly costs from cost tracker
- `system-info.test.ts` > getScheduledJobs > returns job details from cron manager
- `system-info.test.ts` > getSystemStatus > returns system status
- `system-info.test.ts` > getSafeguardDefaults > returns safeguard config
- `system-info.test.ts` > setTierModel > switches standard tier model
- `system-info.test.ts` > setTierModel > switches fast tier model
- `system-info.test.ts` > setTierModel > switches reasoning tier model

**Edge case tests:**
- `system-info.test.ts` > getAvailableModels > returns empty array on catalog failure
- `system-info.test.ts` > getModelPricing > returns null for unknown model
- `system-info.test.ts` > getCostSummary > handles empty cost data
- `system-info.test.ts` > getScheduledJobs > returns empty array when no jobs
- `system-info.test.ts` > getProviders > returns empty array when no providers registered

**Security tests:**
- `system-info.test.ts` > setTierModel > rejects invalid tier
- `system-info.test.ts` > setTierModel > rejects non-existent provider
- `system-info.test.ts` > setTierModel > rejects invalid model ID pattern
- `system-info.test.ts` > setTierModel > rejects empty model ID
- `system-info.test.ts` > setTierModel > rejects model ID with path traversal

**Error handling tests:**
- `system-info.test.ts` > setTierModel > handles selector save failure

### REQ-CHATBOT-008: System question categorization and data gathering

**Phase:** Post-19 | **Status:** Implemented

The chatbot's `/ask` command detects system-related questions via keyword heuristics (no LLM cost) and gathers relevant live system data for prompt injection. Categories: llm (models/providers/tiers), costs (spending/pricing/budget), scheduling (cron/jobs), system (status/uptime). Data is capped and sanitized via `sanitizeInput()` before prompt inclusion.

**Standard tests:**
- `chatbot.test.ts` > categorizeQuestion > detects LLM/model questions
- `chatbot.test.ts` > categorizeQuestion > detects cost questions
- `chatbot.test.ts` > categorizeQuestion > detects scheduling questions
- `chatbot.test.ts` > categorizeQuestion > detects system questions
- `chatbot.test.ts` > gatherSystemData > gathers LLM data for llm category
- `chatbot.test.ts` > gatherSystemData > gathers cost data for costs category
- `chatbot.test.ts` > gatherSystemData > gathers scheduling data
- `chatbot.test.ts` > gatherSystemData > gathers system status data
- `chatbot.test.ts` > system data in /ask prompt > includes system data when question matches categories
- `chatbot.test.ts` > system data in /ask prompt > includes switch-model instruction for model questions

**Edge case tests:**
- `chatbot.test.ts` > categorizeQuestion > returns multiple categories for broad questions
- `chatbot.test.ts` > categorizeQuestion > returns empty set for unrelated questions
- `chatbot.test.ts` > categorizeQuestion > returns empty set for empty string
- `chatbot.test.ts` > categorizeQuestion > handles very long input without performance issues
- `chatbot.test.ts` > gatherSystemData > includes available models when switching
- `chatbot.test.ts` > gatherSystemData > gathers all categories simultaneously
- `chatbot.test.ts` > system data in /ask prompt > omits system data when question is not system-related

**Error handling tests:**
- `chatbot.test.ts` > gatherSystemData error isolation > returns other data when getCostSummary throws
- `chatbot.test.ts` > gatherSystemData error isolation > returns other data when getScheduledJobs throws
- `chatbot.test.ts` > gatherSystemData error isolation > returns other data when getSystemStatus throws
- `chatbot.test.ts` > gatherSystemData error isolation > returns other data when getTierAssignments throws

**Security tests:**
- `chatbot.test.ts` > system data in /ask prompt > sanitizes system data in prompt

**State transition tests:**
- `chatbot.test.ts` > gatherSystemData state transition > reflects updated tier assignments after model switch

### REQ-CHATBOT-009: Model switching via /ask

**Phase:** Post-19 | **Status:** Implemented

The chatbot extracts `<switch-model>` tags from LLM responses, validates parameters, calls `SystemInfoService.setTierModel()`, strips tags from user-visible response, and appends confirmation or error messages.

**Standard tests:**
- `chatbot.test.ts` > processModelSwitchTags > extracts and processes switch-model tags
- `chatbot.test.ts` > processModelSwitchTags > handles multiple switch tags

**Edge case tests:**
- `chatbot.test.ts` > processModelSwitchTags > includes error message on switch failure
- `chatbot.test.ts` > processModelSwitchTags > passes through response without switch tags
- `chatbot.test.ts` > processModelSwitchTags > strips tags gracefully when systemInfo is undefined

**Security tests:**
- `chatbot.test.ts` > processModelSwitchTags > validates parameters when LLM echoes user switch-model tag

### REQ-CHATBOT-010: isPasRelevant system keyword detection

**Phase:** Post-19 | **Status:** Implemented (deprecated in D1)

The `isPasRelevant()` function detects system-related keywords (model, cost, usage, uptime) in addition to app-related keywords, ensuring auto-detect mode routes system questions to the app-aware prompt. **Deprecated in D1** — superseded by `classifyPASMessage()` (REQ-CHATBOT-012).

**Standard tests:**
- `chatbot.test.ts` > isPasRelevant with system keywords > detects model-related questions
- `chatbot.test.ts` > isPasRelevant with system keywords > detects cost-related questions
- `chatbot.test.ts` > isPasRelevant with system keywords > detects usage questions
- `chatbot.test.ts` > isPasRelevant with system keywords > detects uptime questions

### REQ-CHATBOT-012: LLM-based PAS message classification

**Phase:** D1 | **Status:** Implemented

The `classifyPASMessage()` function replaces the static `isPasRelevant()` keyword list. It uses a compact fast-tier LLM call to determine whether a message is PAS-related (home automation, installed apps, scheduling, data queries, system status, model/cost info). Returns an extensible `PASClassification { pasRelated: boolean, dataQueryCandidate?: boolean }` object for D2 wiring. Sanitizes user input and app names before LLM injection. Fails open (`pasRelated: true`) on LLM error so users with auto-detect on always get helpful responses. Short-circuits on empty/whitespace input without an LLM call. Only invoked when `auto_detect_pas` is enabled; `/ask` is always app-aware.

**Standard tests:**
- `pas-classifier.test.ts` > classifyPASMessage > returns pasRelated: true when LLM responds YES
- `pas-classifier.test.ts` > classifyPASMessage > returns pasRelated: false when LLM responds NO
- `pas-classifier.test.ts` > classifyPASMessage > parses "yes." (with period, lowercase)
- `pas-classifier.test.ts` > classifyPASMessage > parses "YES." (with period, uppercase)
- `pas-classifier.test.ts` > classifyPASMessage > parses "No." (with period, mixed case)
- `pas-classifier.test.ts` > classifyPASMessage > uses fast tier for classification call
- `pas-classifier.test.ts` > classifyPASMessage > includes dataQueryCandidate field in result

**Edge case tests:**
- `pas-classifier.test.ts` > classifyPASMessage > returns pasRelated: false for empty text without calling LLM
- `pas-classifier.test.ts` > classifyPASMessage > returns pasRelated: false for whitespace-only text without calling LLM
- `pas-classifier.test.ts` > classifyPASMessage > does not include large app metadata in classifier prompt
- `chatbot.test.ts` > auto-detect PAS questions > uses app-aware prompt (fail-open) when classifier LLM call throws

**Error handling tests:**
- `pas-classifier.test.ts` > classifyPASMessage > returns pasRelated: true (fail-open) when LLM throws
- `pas-classifier.test.ts` > classifyPASMessage > logs a warning when LLM call fails

**Security tests:**
- `pas-classifier.test.ts` > classifyPASMessage > sanitizes user text before passing to LLM (security)
- `pas-classifier.test.ts` > classifyPASMessage > sanitizes app names in classifier system prompt (security)

### REQ-CHATBOT-013: User profile context injection

**Phase:** D1 | **Status:** Implemented

The `buildUserContext()` function builds a concise context string from `MessageContext.spaceName` and `services.appMetadata.getEnabledApps()`. Injected into both the basic system prompt and the app-aware system prompt, giving the LLM household and app awareness without requiring SpaceService or UserManager. All strings are sanitized with `sanitizeInput()` before injection. Returns empty string gracefully when no context is available.

**Standard tests:**
- `user-context.test.ts` > buildUserContext > includes space name when ctx.spaceName is provided
- `user-context.test.ts` > buildUserContext > omits space line when ctx.spaceName is absent
- `user-context.test.ts` > buildUserContext > includes enabled app names
- `user-context.test.ts` > buildUserContext > returns empty string when no space and no apps
- `chatbot.test.ts` > auto-detect PAS questions > includes user household context in basic system prompt
- `chatbot.test.ts` > auto-detect PAS questions > includes user household context in app-aware system prompt
- `chatbot.test.ts` > handleCommand /ask > includes user household context in /ask system prompt

**Edge case tests:**
- `user-context.test.ts` > buildUserContext > does not include display name (not available in MessageContext)
- `user-context.test.ts` > buildUserContext > returns space name even when appMetadata.getEnabledApps throws

**Security tests:**
- `user-context.test.ts` > buildUserContext > sanitizes spaceName and app names to neutralize prompt injection attempts

### REQ-CHATBOT-014: Telegram message splitting

**Phase:** D1 | **Status:** Implemented

The `splitTelegramMessage()` function splits long LLM responses into Telegram-safe chunks. Splitting priority: paragraph boundaries (`\n\n`) first, line boundaries (`\n`) second, hard chunk at maxLength as last resort. Default threshold: 3800 characters (below Telegram's 4096-character limit). Applied to both `handleMessage()` and `handleCommand()` output paths. Does not modify global TelegramService behavior.

**Standard tests:**
- `message-splitter.test.ts` > splitTelegramMessage > returns single-element array for short messages
- `message-splitter.test.ts` > splitTelegramMessage > returns single-element array for message at exactly the limit
- `message-splitter.test.ts` > splitTelegramMessage > splits at paragraph boundary for message over limit
- `message-splitter.test.ts` > splitTelegramMessage > splits at line boundary when no paragraph fits
- `message-splitter.test.ts` > splitTelegramMessage > falls back to hard chunk when no newlines exist
- `message-splitter.test.ts` > splitTelegramMessage > accepts custom maxLength parameter

**Edge case tests:**
- `message-splitter.test.ts` > splitTelegramMessage > does not produce empty parts
- `message-splitter.test.ts` > splitTelegramMessage > preserves all content across splits

### REQ-CHATBOT-015: Extended LLM response token cap

**Phase:** D1 | **Status:** Implemented

The chatbot's LLM calls use `maxTokens: 2048` (raised from 1024 in Phase 16). Applied to both `handleMessage()` fallback responses and `handleCommand()` `/ask` responses. Combined with `splitTelegramMessage()`, this allows richer multi-paragraph answers without hitting Telegram's single-message limit.

**Standard tests:**
- `chatbot.test.ts` > handleMessage > calls LLM with standard tier (covers maxTokens via objectContaining check)

### REQ-CHATBOT-016: DataQueryService integration for YES_DATA messages

**Category:** Data Access  **Phase:** D2b  **Status:** Implemented

When `classifyPASMessage()` returns `YES_DATA`, the chatbot calls `DataQueryService.query()` with the user's message and userId. The returned files are formatted via `formatDataQueryContext()` and injected into the system prompt via `sanitizeInput()`. The LLM response incorporates the data context when answering. DataQueryService is only called when the service is available and `auto_detect_pas` is enabled.

### REQ-CHATBOT-017: /ask uses LLM classifier for data detection

**Category:** Data Access  **Phase:** D2b  **Status:** Implemented

The `/ask` command uses `classifyPASMessage()` (same LLM classifier as `handleMessage`) to detect data queries, replacing the previous keyword-matching gate. When the classifier returns `YES_DATA`, `/ask` calls DataQueryService and injects the data context. This ensures consistent data detection behavior across both the main message handler and the `/ask` command.

### REQ-APPMETA-001: App metadata service

**Phase:** 18 | **Status:** Implemented

The AppMetadataService provides read-only access to app manifest metadata. `getInstalledApps()` returns all loaded apps as `AppInfo` objects. `getEnabledApps(userId)` filters by the user's enabled apps via AppToggleStore. `getAppInfo(appId)` returns a single app or null. `getCommandList()` aggregates commands across all apps. AppInfo objects must not expose module instances or file paths.

**Standard tests:**
- `app-metadata.test.ts` > getInstalledApps > returns metadata for all loaded apps
- `app-metadata.test.ts` > getInstalledApps > maps commands correctly
- `app-metadata.test.ts` > getInstalledApps > maps intents correctly
- `app-metadata.test.ts` > getInstalledApps > maps capability flags correctly
- `app-metadata.test.ts` > getAppInfo > returns metadata for a known app
- `app-metadata.test.ts` > getCommandList > aggregates commands from all apps
- `app-metadata.test.ts` > getEnabledApps > returns only apps enabled for the user
- `app-metadata.test.ts` > getEnabledApps > passes correct defaultEnabledApps from config

**Edge case tests:**
- `app-metadata.test.ts` > getAppInfo > returns null for an unknown app
- `app-metadata.test.ts` > getEnabledApps > uses empty defaults for unknown user
- `app-metadata.test.ts` > edge cases > handles app with no commands or intents
- `app-metadata.test.ts` > edge cases > handles empty registry
- `app-metadata.test.ts` > edge cases > handles wildcard enabledApps for user

**Security tests:**
- `app-metadata.test.ts` > security > does not expose module instances in AppInfo
- `app-metadata.test.ts` > security > does not expose file paths in AppInfo
- `app-metadata.test.ts` > security > mutations to returned intents do not affect future calls
- `app-metadata.test.ts` > security > mutations to returned command args do not affect future calls

**Fixes:**
- D31 (2026-03): Mutable array references — `intents` and command `args` returned by reference. Fixed with spread operator. See Post-Phase 18 Security Review.

### REQ-APPKNOW-001: App knowledge base service

**Phase:** 18 | **Status:** Implemented

The AppKnowledgeBase indexes app documentation (`help.md`, `docs/*.md`) and infrastructure docs (`core/docs/help/`). `init()` scans app directories and infra docs. `search(query, userId?)` returns matching entries scored by keyword match count, capped at 5 results with 2000 char truncation. Infrastructure docs are always included regardless of user's app toggle state. When userId is provided, results are filtered by enabled apps.

**Standard tests:**
- `app-knowledge.test.ts` > init and indexing > loads infrastructure docs from infraDocsDir
- `app-knowledge.test.ts` > init and indexing > loads help.md from app directory
- `app-knowledge.test.ts` > init and indexing > loads docs/*.md from app directory
- `app-knowledge.test.ts` > init and indexing > logs the total indexed entry count
- `app-knowledge.test.ts` > search > returns entries matching query keywords
- `app-knowledge.test.ts` > search > ranks results by keyword match count
- `app-knowledge.test.ts` > search > filters by enabled apps when userId provided
- `app-knowledge.test.ts` > search > always includes infrastructure docs regardless of userId
- `app-knowledge.test.ts` > search > limits results to 5

**Edge case tests:**
- `app-knowledge.test.ts` > edge cases > returns empty for empty query
- `app-knowledge.test.ts` > edge cases > returns empty when no entries match
- `app-knowledge.test.ts` > edge cases > handles app with no help.md or docs/
- `app-knowledge.test.ts` > edge cases > ignores non-markdown files
- `app-knowledge.test.ts` > edge cases > truncates large files to max content length
- `app-knowledge.test.ts` > edge cases > filters out short query words (<=2 chars)

**Error handling tests:**
- `app-knowledge.test.ts` > error handling > handles missing infrastructure docs directory gracefully
- `app-knowledge.test.ts` > error handling > handles missing app directory gracefully

### REQ-CONFIG-004: Fallback mode configuration

**Phase:** 16 | **Status:** Implemented

The `defaults.fallback` field in pas.yaml controls fallback behavior: `chatbot` (default) routes unmatched messages to the chatbot app, `notes` uses the legacy daily notes handler. Invalid or missing values default to `chatbot`.

**Standard tests:**
- `config.test.ts` > loadSystemConfig > parses fallback: chatbot from pas.yaml defaults
- `config.test.ts` > loadSystemConfig > parses fallback: notes from pas.yaml defaults

**Edge case tests:**
- `config.test.ts` > loadSystemConfig > defaults fallback to chatbot when not specified
- `config.test.ts` > loadSystemConfig > defaults fallback to chatbot for invalid values

### REQ-REGISTRY-004: App packaging and install CLI

**Phase:** 17 | **Status:** Planned

Support `pas install <git-url>` for installing apps from git repos with manifest validation, static analysis, and compatibility checks.

**Standard tests:** TBD
**Edge case tests:** TBD

### REQ-DATA-004: Manifest-scoped data access enforcement

**Phase:** 17 | **Status:** Planned

The data store must enforce app-level data access scopes declared in manifests. An app must only be able to read/write paths declared in its manifest. Currently only path traversal is blocked; scope enforcement is not fully implemented.

**Standard tests:** TBD
**Edge case tests:** TBD

### REQ-NFR-005: App runtime contract

**Phase:** 0 | **Status:** Implemented (architectural)

Apps must conform to the AppModule interface, receive services via CoreServices DI, not import infrastructure internals or other apps directly, and not access the filesystem directly. Enforced architecturally via DI; planned for static analysis enforcement at install time (Phase 17).

**Tests:** Enforced by architecture and TypeScript type system, not unit tests.

### REQ-LLM-021: Provider tests for Google, OpenAI-compatible, and Ollama

**Phase:** 14-15 | **Status:** Partially Implemented — tests deferred until API keys available

Individual provider implementations for Google, OpenAI-compatible, and Ollama must have dedicated unit tests once those providers become available for testing.

**Standard tests:** TBD
**Edge case tests:** TBD

### REQ-LLM-022: LLM usage GUI route

**Phase:** 14 | **Status:** Implemented

**Scope:** Usage data parsing (`parseUsageMarkdown`), cost aggregation logic, `escapeHtml` utility, and route handler request/response validation. See also REQ-GUI-003 (template rendering) and REQ-LLM-024 (tier POST endpoint).

The LLM usage GUI route must parse the usage markdown log into structured rows and per-model breakdowns. It must handle both old 6-column and new 7-column (provider) log formats. Cost accumulation must use 6-decimal rounding to match CostTracker precision (D11). Available models must be grouped by provider with correct active-status comparison using both provider and model (not just model ID). All dynamic HTML content must be escaped for XSS prevention.

**Standard tests:** `llm-usage.test.ts` > `parseUsageMarkdown` > parses 7-column format, parses 6-column format, aggregates per-model correctly, computes today/month costs, keys per-model by provider:model, returns rows in reverse chronological order; `escapeHtml` > escapes all dangerous characters; `POST /gui/llm/models` > still works for standard model
**Edge case tests:** `parseUsageMarkdown` > empty input, malformed rows, non-numeric values, rounds accumulated costs (D11), rounds per-model breakdown costs (D11); `escapeHtml` > ampersands and single quotes, empty string; `POST /gui/llm/models` > rejects invalid model ID

### REQ-LLM-023: System LLM Guard (infrastructure cost cap)

**Phase:** 14 | **Status:** Implemented

Infrastructure LLM calls (router, daily diff, condition evaluator) must be subject to the global monthly cost cap. A lightweight SystemLLMGuard wrapper checks only the global cap (no per-app rate limiting) and injects `_appId: 'system'` for cost attribution.

**Standard tests:** `system-llm-guard.test.ts` > `complete()` > delegates to inner when under cap, injects _appId: system; `classify()` > delegates via inner.complete; `extractStructured()` > delegates via inner.complete
**Edge case tests:** `complete()` > blocks when global cap exceeded, blocks at exactly cap boundary, allows just below cap; `classify()` > checks global cap; `extractStructured()` > checks global cap; config validation > rejects NaN/zero/negative cap; error propagation > propagates inner errors

### REQ-LLM-024: Multi-provider GUI

**Phase:** 14 | **Status:** Implemented

The LLM management GUI must display configured providers, tier assignments with provider+model (ModelRef), available models grouped by provider with Set buttons for all three tiers, and usage data with provider columns.

**Standard tests:** `llm-usage.test.ts` > `POST /gui/llm/tiers` > updates fast tier, updates standard tier, updates reasoning tier
**Edge case tests:** `POST /gui/llm/tiers` > rejects invalid tier, rejects missing tier, rejects invalid provider pattern, rejects invalid model pattern, rejects unknown provider

### REQ-GUI-004: Log viewer htmx partial

**Phase:** 15 | **Status:** Implemented

The `GET /gui/logs/entries` route must return HTML table rows for log entries, support level filtering via query parameter, respect a limit parameter (capped at 500), and return a fallback message when the log file is unavailable.

**Standard tests:**
- `routes.test.ts` > `GET /gui/logs/entries (D16)` > returns HTML table rows when log file exists
- `routes.test.ts` > `GET /gui/logs/entries (D16)` > filters by level parameter

**Edge case tests:**
- `routes.test.ts` > `GET /gui/logs/entries (D16)` > respects limit parameter
- `routes.test.ts` > `GET /gui/logs/entries (D16)` > caps limit at 500
- `routes.test.ts` > `GET /gui/logs/entries (D16)` > returns fallback when log file is missing

### REQ-GUI-005: App config POST endpoint

**Phase:** 15 | **Status:** Implemented

The `POST /gui/config/:appId/:userId` route must validate appId/userId format, return 404 for unknown apps, return 400 for unknown users, coerce number and boolean types from form data, skip the `_csrf` field, and ignore unknown config keys.

**Standard tests:**
- `routes.test.ts` > `POST /gui/config/:appId/:userId (D17)` > redirects on successful update
- `routes.test.ts` > `POST /gui/config with user_config app (D17)` > coerces number and boolean types
- `routes.test.ts` > `POST /gui/config with user_config app (D17)` > skips _csrf field and unknown keys

**Edge case tests:**
- `routes.test.ts` > `POST /gui/config/:appId/:userId (D17)` > rejects invalid appId format
- `routes.test.ts` > `POST /gui/config/:appId/:userId (D17)` > rejects invalid userId format
- `routes.test.ts` > `POST /gui/config/:appId/:userId (D17)` > returns 404 for unknown app
- `routes.test.ts` > `POST /gui/config/:appId/:userId (D17)` > returns 400 for unknown user

### REQ-GUI-006: Scheduler GUI human-readable display

**Phase:** 20 | **Status:** Implemented

The scheduler GUI page must display cron jobs with human-readable schedule descriptions (e.g., "At 02:00 AM" instead of `0 2 * * *`), next run times with relative countdown, last run times, and timezone-aware date formatting. One-off tasks must also display formatted dates with countdowns.

**Standard tests:**
- `cron-describe.test.ts` > `describeCron` > describes daily at 2am
- `cron-describe.test.ts` > `describeCron` > describes every 5 minutes
- `cron-describe.test.ts` > `describeCron` > describes weekly on Sunday at 3am
- `cron-describe.test.ts` > `describeCron` > describes monthly on the 1st at 9am
- `cron-describe.test.ts` > `describeCron` > describes hourly
- `cron-describe.test.ts` > `getNextRun` > returns a future date for valid expression
- `cron-describe.test.ts` > `getNextRun` > respects timezone parameter
- `cron-describe.test.ts` > `formatRelativeTime` > shows minutes in future
- `cron-describe.test.ts` > `formatRelativeTime` > shows hours and minutes in future
- `cron-describe.test.ts` > `formatDateTime` > formats date with timezone
- `cron-describe.test.ts` > `formatDateTime` > formats date in different timezone
- `cron-manager.test.ts` > `CronManager` > getJobDetails includes lastRunAt as null before any runs
- `routes.test.ts` > `GET /gui/scheduler` > returns 200 with scheduler content

**Edge case tests:**
- `cron-describe.test.ts` > `describeCron` > returns raw expression for invalid cron
- `cron-describe.test.ts` > `describeCron` > returns raw expression for empty string
- `cron-describe.test.ts` > `getNextRun` > returns null for malformed expression
- `cron-describe.test.ts` > `formatRelativeTime` > shows "now" for same time
- `cron-describe.test.ts` > `formatRelativeTime` > shows less than a minute as "now"
- `cron-describe.test.ts` > `formatRelativeTime` > handles very large time differences

**Error handling tests:**
- `cron-describe.test.ts` > `getNextRun` > returns null for invalid timezone
- `cron-describe.test.ts` > `formatDateTime` > returns ISO fallback for invalid timezone
- `cron-describe.test.ts` > `formatDateTime` > returns "Invalid date" for NaN date
- `cron-describe.test.ts` > `formatRelativeTime` > returns "unknown" for NaN date

### REQ-SERVER-003: Reverse proxy support (trustProxy)

**Phase:** 15 | **Status:** Implemented

The Fastify server must accept a `trustProxy` option to correctly resolve client IPs behind reverse proxies (Cloudflare Tunnel, nginx). When enabled, `request.ip` must reflect the `X-Forwarded-For` header; when disabled, the header must be ignored.

**Standard tests:**
- `server.test.ts` > `createServer` > creates server successfully with default options
- `server.test.ts` > `createServer` > creates server with trustProxy enabled

**Edge case tests:**
- `server.test.ts` > `createServer` > ignores X-Forwarded-For when trustProxy is false
- `server.test.ts` > `createServer` > registers formbody plugin for POST parsing

### REQ-INSTALL-001: Static analysis for banned imports

**Phase:** 17 | **Status:** Implemented

The static analyzer must scan app source files (.ts, .js, .mts, .mjs, .cts, .cjs) for banned import patterns that violate the PAS security model. Banned imports include direct LLM SDK usage (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama`) and process execution (`child_process`, `node:child_process`). The analyzer must skip `node_modules/`, `dist/`, and `.git/` directories. It must report file path and line number for each violation.

**Standard tests:**
- `static-analyzer.test.ts` > Static Analyzer > should report no violations for a clean app
- `static-analyzer.test.ts` > Static Analyzer > should detect a single banned import
- `static-analyzer.test.ts` > Static Analyzer > should detect multiple violations across files
- `static-analyzer.test.ts` > Static Analyzer > should detect all banned LLM SDK imports
- `static-analyzer.test.ts` > Static Analyzer > should detect child_process variants

**Edge case tests:**
- `static-analyzer.test.ts` > Static Analyzer > should handle an empty directory
- `static-analyzer.test.ts` > Static Analyzer > should handle a file with no imports
- `static-analyzer.test.ts` > Static Analyzer > should flag import type from banned packages
- `static-analyzer.test.ts` > Static Analyzer > should flag dynamic import() of banned packages
- `static-analyzer.test.ts` > Static Analyzer > should flag require() of banned packages
- `static-analyzer.test.ts` > Static Analyzer > should scan deeply nested files
- `static-analyzer.test.ts` > Static Analyzer > should match subpath imports of banned packages
- `static-analyzer.test.ts` > Static Analyzer > should NOT match packages that start with a banned name but are different
- `static-analyzer.test.ts` > Static Analyzer > should skip node_modules directory
- `static-analyzer.test.ts` > Static Analyzer > should skip dist directory
- `static-analyzer.test.ts` > Static Analyzer > should scan .js, .mts, .mjs files
- `static-analyzer.test.ts` > Static Analyzer > should handle a non-existent directory gracefully
- `static-analyzer.test.ts` > Static Analyzer > should NOT flag banned strings inside single-line comments
- `static-analyzer.test.ts` > Static Analyzer > should NOT flag banned strings inside block comments
- `static-analyzer.test.ts` > Static Analyzer > should flag export-from statements with banned packages
- `static-analyzer.test.ts` > Static Analyzer > should report correct line numbers for violations

### REQ-INSTALL-002: CoreServices version compatibility checking

**Phase:** 17 | **Status:** Implemented

The compatibility checker must validate that an app's declared `pas_core_version` semver range is satisfied by the running CoreServices version. It must use the `semver` library for range evaluation and provide clear error messages when incompatible. Invalid semver ranges and invalid core versions must be rejected.

**Standard tests:**
- `compatibility-checker.test.ts` > Compatibility Checker > should return compatible for satisfied range
- `compatibility-checker.test.ts` > Compatibility Checker > should return compatible for exact version match
- `compatibility-checker.test.ts` > Compatibility Checker > should return compatible for range with upper bound
- `compatibility-checker.test.ts` > Compatibility Checker > should return compatible for caret range
- `compatibility-checker.test.ts` > Compatibility Checker > should return compatible for tilde range

**Edge case tests:**
- `compatibility-checker.test.ts` > Compatibility Checker > should return incompatible when version is below range
- `compatibility-checker.test.ts` > Compatibility Checker > should return incompatible when version is above range
- `compatibility-checker.test.ts` > Compatibility Checker > should return incompatible for caret range major mismatch
- `compatibility-checker.test.ts` > Compatibility Checker > should return incompatible for invalid semver range
- `compatibility-checker.test.ts` > Compatibility Checker > should return incompatible for invalid core version
- `compatibility-checker.test.ts` > Compatibility Checker > should handle OR ranges
- `compatibility-checker.test.ts` > Compatibility Checker > should reject value in gap of OR range
- `compatibility-checker.test.ts` > Compatibility Checker > should handle pre-release versions
- `compatibility-checker.test.ts` > Compatibility Checker > should handle wildcard ranges

### REQ-INSTALL-003: App installation pipeline

**Phase:** 17 | **Status:** Implemented

The app installer must orchestrate a complete installation pipeline: validate git URL (rejecting `file://` and shell metacharacters), clone the repository, validate the manifest against JSON Schema, check for duplicate app IDs, verify CoreServices compatibility, run static analysis, build a permission summary, copy to `apps/`, and install dependencies. Each failure mode must return a structured error with a descriptive type code and message. Failed dependency installs must clean up the target directory.

**Standard tests:**
- `installer.test.ts` > App Installer > should successfully install a valid app
- `installer.test.ts` > App Installer > should build correct permission summary
- `installer.test.ts` > App Installer > should copy app to apps/<app-id>/ directory
- `installer.test.ts` > App Installer > should call pnpm install after copying

**Edge case tests:**
- `installer.test.ts` > App Installer > should skip compatibility check when pas_core_version is not set
- `installer.test.ts` > App Installer > should pass when pas_core_version is satisfied
- `installer.test.ts` > App Installer > should accept SSH git URLs
- `installer.test.ts` > App Installer > should handle invalid YAML in manifest

**Error handling tests:**
- `installer.test.ts` > App Installer > should reject empty git URL
- `installer.test.ts` > App Installer > should report clone failure
- `installer.test.ts` > App Installer > should report missing manifest.yaml
- `installer.test.ts` > App Installer > should report invalid manifest
- `installer.test.ts` > App Installer > should report already installed app
- `installer.test.ts` > App Installer > should report incompatible CoreServices version
- `installer.test.ts` > App Installer > should report banned imports
- `installer.test.ts` > App Installer > should report multiple banned imports as separate errors
- `installer.test.ts` > App Installer > should clean up target directory on dependency install failure

**Security tests:**
- `installer.test.ts` > App Installer > should reject file:// URLs
- `installer.test.ts` > App Installer > should reject URLs with shell metacharacters
- `installer.test.ts` > App Installer > should reject URLs with pipe characters
- `installer.test.ts` > App Installer > should reject URLs with backtick characters

### REQ-INSTALL-004: Install CLI entry point

**Phase:** 17 | **Status:** Implemented

The `pnpm install-app <git-url>` CLI command must validate URL format (HTTPS and SSH), detect shell metacharacters, and support `--yes`/`-y` flags for non-interactive mode. URL validation must reject bare paths, `file://` URLs, and command injection attempts.

**Standard tests:**
- `install-app.test.ts` > install-app CLI > URL validation > should accept valid HTTPS URLs
- `install-app.test.ts` > install-app CLI > URL validation > should accept valid SSH URLs
- `install-app.test.ts` > install-app CLI > argument parsing > should extract git URL from args

**Edge case tests:**
- `install-app.test.ts` > install-app CLI > URL validation > should reject file:// URLs
- `install-app.test.ts` > install-app CLI > argument parsing > should detect --yes flag
- `install-app.test.ts` > install-app CLI > argument parsing > should detect -y flag
- `install-app.test.ts` > install-app CLI > argument parsing > should handle missing URL

**Security tests:**
- `install-app.test.ts` > install-app CLI > URL validation > should reject URLs with semicolons
- `install-app.test.ts` > install-app CLI > URL validation > should reject URLs with pipe characters
- `install-app.test.ts` > install-app CLI > URL validation > should reject URLs with backticks
- `install-app.test.ts` > install-app CLI > URL validation > should reject URLs with dollar signs
- `install-app.test.ts` > install-app CLI > URL validation > should reject bare paths

### REQ-INSTALL-005: Uninstall CLI entry point

**Phase:** 17 | **Status:** Implemented

The `pnpm uninstall-app <app-id>` CLI command must validate app ID format, protect built-in apps (echo, chatbot) from uninstallation, verify the app directory exists, and remove the directory recursively. Invalid app IDs including path traversal attempts must be rejected.

**Standard tests:**
- `uninstall-app.test.ts` > uninstall-app CLI > app ID validation > should accept valid app IDs
- `uninstall-app.test.ts` > uninstall-app CLI > protected apps > should protect built-in echo app
- `uninstall-app.test.ts` > uninstall-app CLI > directory removal > should remove an existing app directory

**Edge case tests:**
- `uninstall-app.test.ts` > uninstall-app CLI > app ID validation > should reject app IDs starting with numbers
- `uninstall-app.test.ts` > uninstall-app CLI > app ID validation > should reject app IDs with uppercase letters
- `uninstall-app.test.ts` > uninstall-app CLI > app ID validation > should reject empty app IDs
- `uninstall-app.test.ts` > uninstall-app CLI > protected apps > should protect built-in chatbot app
- `uninstall-app.test.ts` > uninstall-app CLI > protected apps > should not protect custom apps
- `uninstall-app.test.ts` > uninstall-app CLI > directory removal > should detect non-existent app directory

**Security tests:**
- `uninstall-app.test.ts` > uninstall-app CLI > app ID validation > should reject app IDs with path traversal

### REQ-INSTALL-006: Manifest v2 fields

**Phase:** 17 | **Status:** Implemented

The manifest schema and types must support optional v2 fields: `pas_core_version` (semver range), `license` (SPDX identifier), `tags` (up to 20 discovery keywords), `category` (enum: productivity, home, health, finance, social, utility), and `homepage` (URI). Existing manifests without these fields must continue to validate. The `core/package.json` version serves as the CoreServices API version.

**Standard tests:**
- Covered by existing `validate-manifest.test.ts` tests (backward compatibility confirmed — all 19 tests pass)

**Edge case tests:**
- Validated via schema enforcement (maxItems on tags, enum on category, URI format on homepage)

**Security tests (added in post-Phase 17 security review):**
- `validate-manifest.test.ts` > `v2 manifest fields` > `rejects homepage with javascript: protocol`
- `validate-manifest.test.ts` > `v2 manifest fields` > `rejects homepage with data: protocol`
- `validate-manifest.test.ts` > `v2 manifest fields` > `accepts homepage with https:// URL`
- `validate-manifest.test.ts` > `v2 manifest fields` > `rejects tag exceeding maxLength`
- `validate-manifest.test.ts` > `v2 manifest fields` > `accepts tag at maxLength boundary`
- `validate-manifest.test.ts` > `v2 manifest fields` > `rejects more than 20 tags`
- `validate-manifest.test.ts` > `v2 manifest fields` > `rejects invalid category value`
- `validate-manifest.test.ts` > `v2 manifest fields` > `accepts manifest with all v2 fields`

---

### REQ-INSTALL-007: App uninstall CLI

**Phase:** 17 | **Status:** Implemented

The system must provide a CLI command (`pnpm uninstall-app <app-id>`) that removes an installed app. The CLI must validate the app ID format, reject attempts to uninstall built-in apps (echo, chatbot), verify the app directory exists, remove the app directory recursively, and advise the user to restart PAS.

**Standard tests:**
- `uninstall-app.test.ts` > `App ID validation` > `should accept valid app IDs`
- `uninstall-app.test.ts` > `App ID validation` > `should accept hyphenated app IDs`
- `uninstall-app.test.ts` > `App removal` > `should remove existing app directory`
- `uninstall-app.test.ts` > `App removal` > `should handle non-existent app`

**Edge case tests:**
- `uninstall-app.test.ts` > `App ID validation` > `should reject IDs with uppercase letters`
- `uninstall-app.test.ts` > `App ID validation` > `should reject IDs starting with numbers`
- `uninstall-app.test.ts` > `App ID validation` > `should reject IDs with special characters`
- `uninstall-app.test.ts` > `App ID validation` > `should reject empty ID`
- `uninstall-app.test.ts` > `Protected apps` > `should protect echo app`
- `uninstall-app.test.ts` > `Protected apps` > `should protect chatbot app`

---

### REQ-INSTALL-008: Symlink protection during app installation

**Phase:** 17 | **Status:** Implemented

The installer must scan cloned repositories for symbolic links before copying to the apps directory. Repos containing symlinks are rejected with a clear error message. This prevents symlink escape attacks where a malicious repo could use symlinks to read or write files outside the app directory.

**Security tests:**
- `installer.test.ts` > `should reject repositories containing symlinks`
- `installer.test.ts` > `should reject repositories containing nested symlinks`

---

## Phase 19: App Developer Documentation

### REQ-SCAFFOLD-001: App scaffold CLI

**Phase:** 19 | **Status:** Implemented

The `pnpm scaffold-app --name=<app-id>` CLI must generate a valid app skeleton from templates. It validates the app ID against the manifest schema pattern (`^[a-z][a-z0-9-]*$`), rejects reserved names (`shared`, `system`), checks for existing directories, and replaces all template placeholders (APP_ID, APP_NAME, APP_COMMAND, APP_DESCRIPTION, AUTHOR). Generated manifests must pass JSON Schema validation.

**Standard tests:**
- `scaffold-app.test.ts` > `should generate correct directory structure`
- `scaffold-app.test.ts` > `should replace all placeholders in manifest`
- `scaffold-app.test.ts` > `should replace all placeholders in package.json`
- `scaffold-app.test.ts` > `should generate manifest that passes JSON Schema validation`
- `scaffold-app.test.ts` > `should use custom description and author when provided`
- `scaffold-app.test.ts` > `should derive display name from kebab-case ID`
- `scaffold-app.test.ts` > `should replace placeholders in test file`
- `scaffold-app.test.ts` > `should return the app directory path on success`
- `scaffold-app.test.ts` > `should generate docs directory with URS and requirements`
- `scaffold-app.test.ts` > `should replace placeholders in URS template`
- `scaffold-app.test.ts` > `should replace placeholders in requirements template`

**Edge case tests:**
- `scaffold-app.test.ts` > `should reject uppercase app name`
- `scaffold-app.test.ts` > `should reject name starting with number`
- `scaffold-app.test.ts` > `should reject special characters in name`
- `scaffold-app.test.ts` > `should reject empty name`
- `scaffold-app.test.ts` > `should reject existing directory`
- `scaffold-app.test.ts` > `should reject reserved name "shared"`
- `scaffold-app.test.ts` > `should reject reserved name "system"`
- `scaffold-app.test.ts` > `should reject reserved name "core"`
- `scaffold-app.test.ts` > `should reject reserved name "pas"`
- `scaffold-app.test.ts` > `should reject reserved name "internal"`

---

### REQ-EXAMPLE-001: Notes example app

**Phase:** 19 | **Status:** Implemented

The notes example app demonstrates commands (/note, /notes, /summarize), intents, data storage (per-user daily markdown files), LLM usage (fast-tier summarization), and user config (notes_per_page). It serves as a practical reference for developers building PAS apps. Gracefully handles empty input, missing data, and LLM failures.

**Standard tests:**
- `notes.test.ts` > `should store services without error`
- `notes.test.ts` > `should save note to daily file`
- `notes.test.ts` > `should save note via command`
- `notes.test.ts` > `should list recent notes`
- `notes.test.ts` > `should call LLM and send summary`
- `notes.test.ts` > `should send empty message when no notes`

**Edge case tests:**
- `notes.test.ts` > `should handle empty message text gracefully`
- `notes.test.ts` > `should handle whitespace-only message`
- `notes.test.ts` > `should show usage when /note has no text`
- `notes.test.ts` > `should respect notes_per_page config`
- `notes.test.ts` > `should handle no notes gracefully` (summarize)
- `notes.test.ts` > `should handle LLM failure gracefully`

---

### REQ-DOC-001: App developer guide

**Phase:** 19 | **Status:** Implemented

`docs/CREATING_AN_APP.md` covers the complete app development workflow: scaffolding, manifest structure, AppModule implementation, CoreServices usage, testing with mock services, sharing via git, and security constraints. No automated tests (documentation).

---

### REQ-DOC-002: Manifest reference

**Phase:** 19 | **Status:** Implemented

`docs/MANIFEST_REFERENCE.md` documents all manifest fields with types, constraints, and examples. Covers app block, capabilities (intents, commands, schedules, rules, events), requirements (services, data, APIs, LLM), and user_config. Derived from `core/src/schemas/app-manifest.schema.json`. No automated tests (documentation).

---

### REQ-ERROR-001: LLM error classification utility

**Phase:** Post-19 | **Status:** Implemented

`core/src/utils/llm-errors.ts` classifies LLM errors into user-friendly categories (billing, rate-limit, cost-cap, auth, overloaded, unknown) using duck-typing on error properties. Apps import via `@pas/core/utils/llm-errors`.

**Tests:** `core/src/utils/__tests__/llm-errors.test.ts`

Standard:
- `classifyLLMError` > billing error (status 400 + credit message)
- `classifyLLMError` > billing error (status 400 + billing message)
- `classifyLLMError` > provider rate limit (status 429)
- `classifyLLMError` > auth error (status 401)
- `classifyLLMError` > server error (status 500)
- `classifyLLMError` > overloaded (status 529)
- `classifyLLMError` > PAS LLMRateLimitError by name
- `classifyLLMError` > PAS LLMCostCapError by name
- `classifyLLMError` > generic Error as unknown

Edge:
- `classifyLLMError` > status 400 without credit/billing keywords → unknown
- `classifyLLMError` > error with no status or name → unknown
- `classifyLLMError` > non-Error thrown value (string) → unknown
- `classifyLLMError` > null error → unknown
- `classifyLLMError` > undefined error → unknown

---

### REQ-TIMEZONE-001: Timezone-aware dates in apps

**Phase:** Post-19 | **Status:** Implemented

`CoreServices.timezone` property (IANA string) exposed to all apps. Notes and chatbot apps use `Intl.DateTimeFormat` with configured timezone for date formatting instead of UTC `toISOString()`. Resolves D21/D22.

**Tests:** Covered by existing notes and chatbot tests (timezone test in notes.test.ts, daily notes date pattern in chatbot.test.ts)

---

### REQ-GUI-006: Data browser page

**Phase:** Post-19 | **Status:** Implemented

GUI "Data" page with sidebar showing user data directories, shared data, and system data. htmx-powered directory navigation with file listing (name, size, modified). Path traversal protection via segment validation and resolve-within-dataDir checks.

**Tests:** `core/src/gui/__tests__/data.test.ts`

Standard:
- `GET /gui/data` > renders data page with user sections
- `GET /gui/data` > shows system data directories
- `GET /gui/data/browse` > returns file listing for user app data
- `GET /gui/data/browse` > returns file listing for subdirectory
- `GET /gui/data/browse` > returns file listing for system data
- `GET /gui/data/browse` > returns empty message for non-existent directory
- `GET /gui/data/browse` > returns 400 for missing scope parameter

Standard (file browser):
- `GET /gui/data/files` > returns file listing for user app directory
- `GET /gui/data/files` > returns clickable files with path fill onclick
- `GET /gui/data/files` > shows back link for subdirectories
- `GET /gui/data/files` > returns empty message for non-existent directory
- `GET /gui/data/files` > prompts for app and user when missing
- `GET /gui/data/files` > includes close button

Standard (system files vs directories):
- `GET /gui/data` > renders system files with view links and directories with browse links

Standard (empty sections):
- `GET /gui/data` > shows shared section even when empty
- `GET /gui/data` > shows spaces section even when empty

Security:
- `security` > rejects path traversal in subpath
- `security` > rejects invalid userId format
- `security` > rejects invalid appId format
- `security` > rejects absolute path in subpath
- `GET /gui/data/files` > returns 400 for missing target parameter
- `GET /gui/data/files` > rejects path traversal in subpath

---

### REQ-GUI-007: Context management GUI

**Phase:** Post-27A | **Status:** Implemented

GUI CRUD for per-user context entries at `/gui/context`. htmx partials for list/edit/create. Auto-slug key generation. CSRF protection. HTML escaping.

**Tests:** `core/src/gui/__tests__/context-routes.test.ts`

**Standard tests:**
- `context-routes.test.ts` > GET /gui/context > renders main context page
- `context-routes.test.ts` > GET /gui/context/list > lists entries for a user
- `context-routes.test.ts` > GET /gui/context/list > lists entries for a different user
- `context-routes.test.ts` > GET /gui/context/edit > renders edit form for existing entry
- `context-routes.test.ts` > GET /gui/context/edit > renders create form for new entry
- `context-routes.test.ts` > POST /gui/context/save > saves a new entry
- `context-routes.test.ts` > POST /gui/context/save > updates an existing entry
- `context-routes.test.ts` > POST /gui/context/delete > deletes an entry

**Edge case tests:**
- `context-routes.test.ts` > POST /gui/context/save > rejects empty key
- `context-routes.test.ts` > POST /gui/context/save > rejects empty content
- `context-routes.test.ts` > POST /gui/context/save > handles symbols-only key
- `context-routes.test.ts` > GET /gui/context/edit > returns 404 for non-existent key

**Error tests:**
- `context-routes.test.ts` > GET /gui/context/list > rejects invalid userId
- `context-routes.test.ts` > GET /gui/context/list > rejects unregistered userId

**Security tests:**
- `context-routes.test.ts` > security > escapes HTML in content
- `context-routes.test.ts` > security > rejects path traversal in userId
- `context-routes.test.ts` > security > includes CSRF token in forms

**Fixes:** None

---

## Post-Phase 19: Model Journal

### REQ-JOURNAL-001: Per-model journal service (read, append, archive, listModels)

**Phase:** Post-19 | **Status:** Implemented

The ModelJournalService provides per-model persistent markdown files at `data/model-journal/{model-slug}.md`. Each model gets its own isolated journal — no cross-model access. `read(modelSlug)` returns current journal content. `append(modelSlug, content)` adds timestamped entries with month headers, creating the file and directory if needed. On `append()`, checks the existing month header against the current month (timezone-aware); if different, archives the old file to `data/model-journal-archive/{model-slug}/YYYY-MM.md`. `listArchives(modelSlug)` returns archive filenames sorted newest-first. `readArchive(modelSlug, filename)` reads a specific archive with filename pattern validation. `listModels()` discovers models with journals. `slugifyModelId()` converts model IDs (e.g., `anthropic/claude-sonnet-4-20250514`) to filesystem-safe slugs. All methods validate slugs against `MODEL_SLUG_PATTERN` (`/^[a-z0-9][a-z0-9-]*$/`) — invalid slugs return empty/no-op.

**Tests:** `core/src/services/model-journal/__tests__/model-journal.test.ts`

**Standard tests:**
- `slugifyModelId` > passes through already-valid slugs
- `slugifyModelId` > replaces slashes with hyphens
- `slugifyModelId` > lowercases the input
- `slugifyModelId` > replaces dots and colons with hyphens
- `read` > returns empty string when no journal exists
- `read` > returns journal content when file exists
- `append` > creates journal file with month header on first write
- `append` > appends entries with timestamp headers
- `append` > includes date and time in entry header
- `multi-model isolation` > each model reads only its own journal
- `multi-model isolation` > archives are independent per model
- `listArchives` > returns sorted archive filenames (newest first)
- `readArchive` > returns archive content
- `archival` > archives journal when month differs from current
- `archival` > does not archive when month matches current
- `listModels` > returns slugs of models with journal files
- `listModels` > returns sorted slugs
- `timezone` > uses configured timezone for month headers

**Edge case tests:**
- `slugifyModelId` > collapses consecutive hyphens
- `slugifyModelId` > trims leading and trailing hyphens
- `slugifyModelId` > handles empty string
- `read` > returns empty string for invalid slug
- `append` > skips empty content
- `append` > skips whitespace-only content
- `append` > trims content before writing
- `append` > creates model-journal directory if missing
- `append` > does nothing for invalid slug
- `archival` > creates archive directory if missing
- `archival` > skips archival when journal has no month header
- `listArchives` > returns empty array when no archive directory exists
- `listArchives` > filters out non-archive files
- `listArchives` > returns empty for invalid slug
- `readArchive` > returns empty string for non-existent archive
- `readArchive` > returns empty string for invalid filename (path traversal)
- `readArchive` > returns empty string for filename not matching pattern
- `readArchive` > returns empty string for invalid model slug
- `listModels` > returns empty array when no journals exist
- `listModels` > filters out non-md files
- `listModels` > returns empty when model-journal directory does not exist
- `timezone` > falls back to UTC for empty timezone
- `error handling` > logs warning and continues when archival rename fails
- `error handling` > handles ensureDir failure gracefully on first write
- `concurrency` > serializes concurrent appends for the same model
- `concurrency` > independent models can append concurrently without interference

---

### REQ-JOURNAL-002: Per-model journal chatbot integration

**Phase:** Post-19 | **Status:** Implemented

The chatbot determines the model slug from `services.llm.getModelForTier('standard')` via `slugifyModelId()` at each interaction start. Extracts `<model-journal>` tags from LLM responses, strips them before the user sees the response, and appends extracted content to the model's own journal via `ModelJournalService.append(modelSlug, content)`. Journal prompt section tells each model "This file is yours alone — no other model reads or writes to it." with model-specific path `data/model-journal/{modelSlug}.md`. Journal prompt added to both `buildSystemPrompt()` and `buildAppAwareSystemPrompt()` — includes instructions and current month's journal content (sanitized, capped at 2000 chars). Conversation history saves the cleaned response. Journal write failures do not prevent the user response from being sent.

**Tests:** `apps/chatbot/src/__tests__/chatbot.test.ts`

**Standard tests:**
- `extractJournalEntries` > returns unchanged response when no journal tags
- `extractJournalEntries` > extracts single journal entry and cleans response
- `extractJournalEntries` > extracts multiple journal entries
- `buildSystemPrompt` > includes model journal instruction section with model-specific path
- `buildSystemPrompt` > includes journal content when journal has entries
- `buildAppAwareSystemPrompt` > includes model journal instruction section with model-specific path
- `model journal integration` > strips journal tags from response in handleMessage
- `model journal integration` > writes journal entries via modelJournal.append
- `model journal integration` > strips journal tags from /ask command response

**Edge case tests:**
- `extractJournalEntries` > handles journal tag at the beginning of response
- `extractJournalEntries` > handles multiline journal content
- `extractJournalEntries` > ignores empty journal tags
- `extractJournalEntries` > ignores whitespace-only journal tags
- `extractJournalEntries` > preserves unclosed journal tags (passes through to user)
- `extractJournalEntries` > cleans up excess whitespace after tag removal
- `buildSystemPrompt` > omits journal content section when journal is empty
- `model journal integration` > does not call modelJournal.append when no journal tags
- `model journal integration` > sends response even when journal write fails
- `model journal integration` > saves cleaned response (without journal tags) to conversation history
- `model journal integration` > sanitizes journal content in system prompt (anti-injection)
- `handleMessage` > sends response normally when modelJournal service is undefined
- `extractJournalEntries` > handles nested journal tags by matching to first closing tag
- `buildSystemPrompt` > truncates journal content exceeding 2000 chars
- `buildSystemPrompt` > omits journal content when modelJournal.read() throws
- `model journal integration` > uses unknown model slug when getModelForTier is unavailable

---

### REQ-JOURNAL-003: Per-model journal GUI routes

**Phase:** Post-19 | **Status:** Implemented

GUI "Model Notes" card on the Data page (read-only, htmx lazy-loaded). `GET /gui/data/journal` discovers all models with journals and renders collapsible `<details>` sections per model. `GET /gui/data/journal/model?slug={slug}` returns a specific model's journal content + archive list. `GET /gui/data/journal/archive?slug={slug}&file=YYYY-MM.md` returns a specific archived journal for a model. Slug validated against `MODEL_SLUG_PATTERN`. Archive filename validated against `ARCHIVE_FILENAME_PATTERN`. Path traversal protection via resolve + startsWith check. All content HTML-escaped.

**Tests:** `core/src/gui/__tests__/data.test.ts`

**Standard tests:**
- `GET /gui/data (Model Journal section)` > renders Model Notes section in data page
- `GET /gui/data/journal (multi-model discovery)` > returns empty state when no journals exist
- `GET /gui/data/journal (multi-model discovery)` > lists model slugs as collapsible sections
- `GET /gui/data/journal/model (per-model journal)` > returns journal content for a model
- `GET /gui/data/journal/model (per-model journal)` > lists per-model archived journals
- `GET /gui/data/journal/archive (per-model archive)` > returns archived journal content for a model

**Edge case tests:**
- `GET /gui/data/journal (multi-model discovery)` > filters out non-md files from journal directory
- `GET /gui/data/journal (multi-model discovery)` > HTML-escapes model slugs
- `GET /gui/data/journal/model (per-model journal)` > returns empty message when model has no journal
- `GET /gui/data/journal/model (per-model journal)` > HTML-escapes journal content
- `GET /gui/data/journal/model (per-model journal)` > returns 400 for invalid slug (path traversal)
- `GET /gui/data/journal/model (per-model journal)` > returns 400 for missing slug parameter
- `GET /gui/data/journal/archive (per-model archive)` > returns 400 for invalid slug (path traversal)
- `GET /gui/data/journal/archive (per-model archive)` > returns 400 for invalid filename (path traversal)
- `GET /gui/data/journal/archive (per-model archive)` > returns 400 for missing slug parameter
- `GET /gui/data/journal/archive (per-model archive)` > returns 400 for missing file parameter
- `GET /gui/data/journal/archive (per-model archive)` > returns 400 for non-matching filename pattern
- `GET /gui/data/journal/archive (per-model archive)` > returns not found for non-existent archive
- `GET /gui/data/journal/model (per-model journal)` > handles empty journal file

---

### REQ-SECRETS-001: Per-app secrets service

**Phase:** Post-19 | **Status:** Implemented

Apps declare `requirements.external_apis` in manifest with `id`, `env_var`, and `required` fields. Infrastructure reads env vars from `process.env`, provides values via `services.secrets.get(id)` and `services.secrets.has(id)`. Missing required APIs log a warning. `SecretsService` is always provided (empty if no `external_apis` declared). Resolves credential scoping deferred item.

**Tests:** `core/src/services/secrets/__tests__/secrets.test.ts`

Standard:
- `SecretsService` > returns a declared secret
- `SecretsService` > has() returns true for declared secrets
- `SecretsService` > supports multiple secrets

Edge:
- `SecretsService` > returns undefined for undeclared ID
- `SecretsService` > has() returns false for undeclared ID
- `SecretsService` > works with empty values map
- `SecretsService` > preserves empty string values
- `SecretsService` > defensive copy prevents input mutation

---

## 27. Scheduled Reports

### REQ-REPORT-001: Report validation

**Phase:** 21 | **Status:** Implemented

Report definitions must be validated: ID pattern (`^[a-z][a-z0-9-]*$`, max 50 chars), name (non-empty, max 100 chars), schedule (valid cron), delivery (registered users only), sections (1-20, valid types, type-specific config), LLM config (valid tier, max_tokens 1-2000). Path traversal blocked in app-data paths.

**Standard tests:**
- `report-validator.test.ts` > validateReport > accepts a valid report definition
- `report-validator.test.ts` > validateReport > accepts a report with all section types
- `report-validator.test.ts` > validateReport > accepts a report with LLM config
- `report-validator.test.ts` > validateReport > accepts changes section with defaults
- `report-validator.test.ts` > validateReport > accepts registered user IDs
- `report-validator.test.ts` > validateReport > accepts ID at max length
- `report-validator.test.ts` > validateReport > accepts max_tokens at limit
- `report-validator.test.ts` > validateReport > accepts valid app-data with date token

**Edge case tests:**
- `report-validator.test.ts` > validateReport > rejects empty ID
- `report-validator.test.ts` > validateReport > rejects ID with uppercase letters
- `report-validator.test.ts` > validateReport > rejects ID starting with a digit
- `report-validator.test.ts` > validateReport > rejects ID exceeding max length
- `report-validator.test.ts` > validateReport > rejects empty name
- `report-validator.test.ts` > validateReport > rejects whitespace-only name
- `report-validator.test.ts` > validateReport > rejects name exceeding max length
- `report-validator.test.ts` > validateReport > rejects empty schedule
- `report-validator.test.ts` > validateReport > rejects invalid cron expression
- `report-validator.test.ts` > validateReport > rejects empty delivery array
- `report-validator.test.ts` > validateReport > rejects unregistered user ID in delivery
- `report-validator.test.ts` > validateReport > rejects empty sections array
- `report-validator.test.ts` > validateReport > rejects exceeding max sections
- `report-validator.test.ts` > validateReport > rejects invalid section type
- `report-validator.test.ts` > validateReport > rejects section with empty label
- `report-validator.test.ts` > validateReport > rejects negative lookback_hours
- `report-validator.test.ts` > validateReport > rejects app-data with missing app_id
- `report-validator.test.ts` > validateReport > rejects app-data with invalid app_id format
- `report-validator.test.ts` > validateReport > rejects app-data with path traversal (..)
- `report-validator.test.ts` > validateReport > rejects app-data with absolute path
- `report-validator.test.ts` > validateReport > rejects app-data with backslashes
- `report-validator.test.ts` > validateReport > rejects app-data with missing path
- `report-validator.test.ts` > validateReport > rejects context with empty key_prefix
- `report-validator.test.ts` > validateReport > rejects custom with empty text
- `report-validator.test.ts` > validateReport > rejects invalid LLM tier
- `report-validator.test.ts` > validateReport > rejects zero max_tokens
- `report-validator.test.ts` > validateReport > rejects negative max_tokens
- `report-validator.test.ts` > validateReport > rejects max_tokens exceeding limit
- `report-validator.test.ts` > validateReport > rejects non-integer max_tokens
- `report-validator.test.ts` > validateReport > reports multiple errors simultaneously
- `report-validator.test.ts` > validateReport > rejects section with null config
- `report-validator.test.ts` > validateReport > rejects app-data with path traversal in user_id
- `report-validator.test.ts` > validateReport > rejects app-data with special characters in user_id

---

### REQ-REPORT-002: Section data collection

**Phase:** 21 | **Status:** Implemented

Section collector gathers data per section type: changes (from change log with lookback_hours and app_filter), app-data (file read with path traversal protection and date token resolution), context (store search by key_prefix), custom (static text). Unknown types and errors handled gracefully.

**Standard tests:**
- `section-collector.test.ts` > collectSection — changes > collects changes from change log
- `section-collector.test.ts` > collectSection — changes > filters by app when app_filter specified
- `section-collector.test.ts` > collectSection — app-data > reads an app data file
- `section-collector.test.ts` > collectSection — app-data > resolves {today} date token
- `section-collector.test.ts` > collectSection — context > collects matching context entries
- `section-collector.test.ts` > collectSection — custom > returns custom text as-is
- `section-collector.test.ts` > resolveDateTokens > resolves {today} token
- `section-collector.test.ts` > resolveDateTokens > resolves {yesterday} token
- `section-collector.test.ts` > resolveDateTokens > resolves multiple tokens in one path
- `section-collector.test.ts` > resolveDateTokens > leaves paths without tokens unchanged

**Edge case tests:**
- `section-collector.test.ts` > collectSection — changes > returns empty when no changes exist
- `section-collector.test.ts` > collectSection — changes > returns empty when filter matches no apps
- `section-collector.test.ts` > collectSection — changes > uses default lookback hours when not specified
- `section-collector.test.ts` > collectSection — app-data > returns file not found when file missing
- `section-collector.test.ts` > collectSection — app-data > rejects path traversal attempt
- `section-collector.test.ts` > collectSection — app-data > rejects path that escapes via prefix match (e.g., notes-evil)
- `section-collector.test.ts` > collectSection — app-data > returns empty for empty file
- `section-collector.test.ts` > collectSection — context > returns empty when no context entries match
- `section-collector.test.ts` > collectSection — custom > returns empty for whitespace-only text
- `section-collector.test.ts` > collectSection — error handling > returns error message for unknown section type
- `section-collector.test.ts` > collectSection — error handling > catches errors and returns error message
- `section-collector.test.ts` > resolveDateTokens > handles invalid timezone gracefully

---

### REQ-REPORT-003: Report formatting

**Phase:** 21 | **Status:** Implemented

Reports formatted as markdown with header, optional LLM summary (before sections), section data with empty-state italics. Telegram delivery truncates at 4000 chars with notice.

**Standard tests:**
- `report-formatter.test.ts` > formatReport > includes report name as heading
- `report-formatter.test.ts` > formatReport > includes run date when provided
- `report-formatter.test.ts` > formatReport > includes description
- `report-formatter.test.ts` > formatReport > includes summary section
- `report-formatter.test.ts` > formatReport > includes section content
- `report-formatter.test.ts` > formatReport > places summary before sections
- `report-formatter.test.ts` > formatForTelegram > returns short reports unchanged

**Edge case tests:**
- `report-formatter.test.ts` > formatReport > omits summary when not provided
- `report-formatter.test.ts` > formatReport > italicizes empty sections
- `report-formatter.test.ts` > formatReport > works with no description and no date
- `report-formatter.test.ts` > formatForTelegram > truncates long reports

---

### REQ-REPORT-004: Report service CRUD and execution

**Phase:** 21 | **Status:** Implemented

ReportService provides CRUD (save/get/list/delete) with YAML persistence, report execution (collect sections, optional LLM summarize, format, deliver via Telegram, save to history), preview mode (no send/save), max 50 reports limit.

**Standard tests:**
- `report-service.test.ts` > ReportService — CRUD > saves and retrieves a report
- `report-service.test.ts` > ReportService — CRUD > lists all reports sorted by name
- `report-service.test.ts` > ReportService — CRUD > deletes a report
- `report-service.test.ts` > ReportService — CRUD > updates an existing report
- `report-service.test.ts` > ReportService — run > runs a report with custom section
- `report-service.test.ts` > ReportService — run > sends report via Telegram
- `report-service.test.ts` > ReportService — run > delivers to multiple users
- `report-service.test.ts` > ReportService — run > saves report to history
- `report-service.test.ts` > ReportService — LLM summarization > summarizes when LLM enabled
- `report-service.test.ts` > ReportService — LLM summarization > uses custom LLM prompt when provided

**Edge case tests:**
- `report-service.test.ts` > ReportService — CRUD > returns false when deleting nonexistent report
- `report-service.test.ts` > ReportService — CRUD > returns null for nonexistent report ID
- `report-service.test.ts` > ReportService — CRUD > returns null for invalid report ID
- `report-service.test.ts` > ReportService — CRUD > returns validation errors for invalid report
- `report-service.test.ts` > ReportService — CRUD > enforces maximum report count
- `report-service.test.ts` > ReportService — CRUD > allows updating when at report limit
- `report-service.test.ts` > ReportService — run > returns null for nonexistent report
- `report-service.test.ts` > ReportService — run > does not send or save in preview mode
- `report-service.test.ts` > ReportService — run > continues delivery when one user fails
- `report-service.test.ts` > ReportService — LLM summarization > skips summarization when LLM disabled
- `report-service.test.ts` > ReportService — LLM summarization > gracefully degrades when LLM fails
- `report-service.test.ts` > ReportService — LLM summarization > skips summarization when all sections are empty
- `report-service.test.ts` > ReportService — LLM summarization > sanitizes data before LLM prompt

**Edge case tests (D14 load-time validation):**
- `report-load-validation.test.ts` > listReports() > skips files with corrupt YAML (parse error)
- `report-load-validation.test.ts` > listReports() > skips files that are not objects
- `report-load-validation.test.ts` > listReports() > skips files with no id field
- `report-load-validation.test.ts` > listReports() > includes structurally invalid report with _validationErrors attached
- `report-load-validation.test.ts` > listReports() > returns valid reports without _validationErrors
- `report-load-validation.test.ts` > getReport() > returns null for corrupt YAML
- `report-load-validation.test.ts` > getReport() > attaches _validationErrors for invalid definition
- `report-load-validation.test.ts` > getReport() > returns valid report without _validationErrors
- `report-load-validation.test.ts` > run() execution gate > refuses to run a report with validation errors
- `report-load-validation.test.ts` > run() execution gate > runs a valid report normally
- `report-load-validation.test.ts` > saveReport() strips _validationErrors > does not persist _validationErrors to disk

**Fixes:**
- **D14 (2026-04-13):** Report loading now uses `readYamlFileStrict()` + `safeValidateReport()`. Corrupt YAML is skipped with logged warning. Invalid definitions are included in lists with `_validationErrors` attached but cannot be executed via `run()`. `_validationErrors` is stripped before persisting to disk. CL: D14-fix.

---

### REQ-REPORT-005: Report cron lifecycle

**Phase:** 21 | **Status:** Implemented

Reports register/unregister cron jobs on save/delete. Enabled reports get cron jobs; disabled do not. Toggling updates registration. Init loads all reports from disk and registers enabled ones.

**Standard tests:**
- `report-service.test.ts` > ReportService — cron lifecycle > registers cron job on save when enabled
- `report-service.test.ts` > ReportService — cron lifecycle > re-registers cron job on update
- `report-service.test.ts` > ReportService — cron lifecycle > registers when toggling from disabled to enabled
- `report-service.test.ts` > ReportService — cron lifecycle > init registers enabled reports from disk
- `cron-manager.test.ts` > CronManager > unregisters an existing job

**Edge case tests:**
- `report-service.test.ts` > ReportService — cron lifecycle > does not register cron job when disabled
- `report-service.test.ts` > ReportService — cron lifecycle > unregisters cron job on delete
- `report-service.test.ts` > ReportService — cron lifecycle > unregisters when toggling from enabled to disabled
- `cron-manager.test.ts` > CronManager > returns false for nonexistent job unregister
- `cron-manager.test.ts` > CronManager > removes lastRunAt on unregister
- `cron-manager.test.ts` > CronManager > can re-register after unregister

---

### REQ-REPORT-006: Report GUI

**Phase:** 21 | **Status:** Implemented

GUI provides list, create, edit, delete, toggle (htmx), preview (htmx), and history viewing for reports. XSS protection via escapeHtml on htmx partials. Path traversal protection on history file access.

**Standard tests:**
- `reports.test.ts` > Report GUI Routes > GET /gui/reports > returns 200 with empty report list
- `reports.test.ts` > Report GUI Routes > GET /gui/reports > shows existing reports
- `reports.test.ts` > Report GUI Routes > GET /gui/reports > shows schedule and section count
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/new > returns 200 with create form
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/edit > returns 200 for existing report
- `reports.test.ts` > Report GUI Routes > POST /gui/reports > creates a report and redirects
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id > updates an existing report
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id/delete > deletes a report and redirects
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id/toggle > toggles report enabled state
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id/preview > returns preview HTML
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history > returns history page for existing report
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history > lists history files
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history/:file > returns history file content

**Edge case tests:**
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/edit > returns 404 for nonexistent report
- `reports.test.ts` > Report GUI Routes > POST /gui/reports > re-renders form on validation error
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id > forces ID from URL param
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id/toggle > returns 404 for nonexistent report
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id/preview > returns not found for nonexistent report
- `reports.test.ts` > Report GUI Routes > POST /gui/reports/:id/preview > does not send via Telegram
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history > returns 404 for nonexistent report
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history/:file > rejects path traversal in file name
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history/:file > rejects non-.md files
- `reports.test.ts` > Report GUI Routes > GET /gui/reports/:id/history/:file > returns 404 for missing history file
- `reports.test.ts` > Report GUI Routes > XSS protection > escapes HTML in toggle response
- `reports.test.ts` > Report GUI Routes > XSS protection > escapes HTML in preview response

**Standard tests (D39 space_id support):**
- `report-space-id.test.ts` > D39: Report form space_id round-trip > scope=space parsing > parses space scope — space_id set, user_id omitted
- `report-space-id.test.ts` > D39: Report form space_id round-trip > scope=user parsing > parses user scope — user_id set, space_id omitted
- `report-space-id.test.ts` > D39: Report form space_id round-trip > fallback scope detection > treats as space scope when scope field absent but space_id present
- `report-space-id.test.ts` > D39: Report form space_id round-trip > D39 regression: API-created space-scoped report round-trip > retains space_id after GUI edit and save

**Edge case tests (D39 + D14 GUI robustness):**
- `report-space-id.test.ts` > D39: Report form space_id round-trip > space dropdown > edit page includes space options when spaceService is provided
- `report-space-id.test.ts` > D39: Report form space_id round-trip > space dropdown > edit page renders without errors when spaceService is absent
- `report-space-id.test.ts` > D39: Report form space_id round-trip > D14: list route tolerance > renders list page without crash when a structurally invalid report exists on disk
- `report-space-id.test.ts` > D39: Report form space_id round-trip > D14: validation error banner > edit page shows structural error banner for an invalid report
- `report-space-id.test.ts` > D39: Report form space_id round-trip > D39: empty space_id edge case > rejects empty space_id — re-renders form with validation errors, no redirect

**Fixes:**
- **D39 (2026-04-13):** Report edit form now exposes scope radio (user/space) + space dropdown. `parseFormToReport` handles `section_scope_*` / `section_space_id_*` with user_id/space_id mutual exclusion and fallback for missing scope field. SpaceService wired into route registration. Validation error banners in edit views, warning badges in list views. CL: D39-fix.

---

## 26. Conditional Alerts System

### REQ-ALERT-001: Alert validation

**Status:** Implemented

Validates alert definitions: ID pattern, name, schedule (cron), delivery (registered users), cooldown (parseable), condition (type/expression/data_sources with path traversal checks), actions (type/config per type).

**Standard tests:**
- `alert-validator.test.ts` > validates valid alert definition passes
- `alert-validator.test.ts` > validates ID must match pattern
- `alert-validator.test.ts` > validates ID max length
- `alert-validator.test.ts` > validates name is required
- `alert-validator.test.ts` > validates name max length
- `alert-validator.test.ts` > validates schedule is required
- `alert-validator.test.ts` > validates schedule must be valid cron
- `alert-validator.test.ts` > validates delivery is required
- `alert-validator.test.ts` > validates delivery users must be registered
- `alert-validator.test.ts` > validates cooldown is required
- `alert-validator.test.ts` > validates cooldown must be parseable
- `alert-validator.test.ts` > validates condition type is required
- `alert-validator.test.ts` > validates condition expression is required
- `alert-validator.test.ts` > validates at least one data source is required
- `alert-validator.test.ts` > validates at least one action is required
- `alert-validator.test.ts` > validates action config per type

**Edge case tests:**
- `alert-validator.test.ts` > rejects uppercase in ID
- `alert-validator.test.ts` > rejects spaces in ID
- `alert-validator.test.ts` > rejects empty ID
- `alert-validator.test.ts` > rejects invalid cron expressions
- `alert-validator.test.ts` > rejects unknown condition type
- `alert-validator.test.ts` > rejects missing data source fields
- `alert-validator.test.ts` > rejects path traversal in data source path
- `alert-validator.test.ts` > rejects absolute paths in data source
- `alert-validator.test.ts` > rejects backslashes in data source path
- `alert-validator.test.ts` > enforces max data sources limit
- `alert-validator.test.ts` > enforces max actions limit
- `alert-validator.test.ts` > rejects unknown action type
- `alert-validator.test.ts` > rejects missing condition entirely
- `alert-validator.test.ts` > validates multiple errors returned at once
- `alert-validator.test.ts` > rejects invalid cooldown formats

### REQ-ALERT-002: Alert action execution

**Status:** Implemented

Executes typed actions when conditions are met. Supports `telegram_message` (per-user delivery with error isolation) and `run_report` (triggers report by ID).

**Standard tests:**
- `alert-executor.test.ts` > executes telegram_message action
- `alert-executor.test.ts` > executes run_report action
- `alert-executor.test.ts` > executes multiple actions in order
- `alert-executor.test.ts` > sends to all delivery users

**Edge case tests:**
- `alert-executor.test.ts` > skips unknown action types
- `alert-executor.test.ts` > isolates telegram send failure per user
- `alert-executor.test.ts` > fails telegram_message action if ALL users fail
- `alert-executor.test.ts` > fails run_report when report returns null
- `alert-executor.test.ts` > isolates action failures — first fails, second succeeds
- `alert-executor.test.ts` > isolates action failures — first succeeds, second fails
- `alert-executor.test.ts` > returns zero counts when no actions

### REQ-ALERT-003: Alert service CRUD and evaluation

**Status:** Implemented

AlertService manages alert definitions (CRUD), scheduled condition evaluation, cooldown tracking, action execution, and history saving.

**Standard tests:**
- `alert-service.test.ts` > CRUD > creates and retrieves an alert
- `alert-service.test.ts` > CRUD > lists alerts sorted by name
- `alert-service.test.ts` > CRUD > updates an existing alert
- `alert-service.test.ts` > CRUD > deletes an alert
- `alert-service.test.ts` > CRUD > returns validation errors on save
- `alert-service.test.ts` > CRUD > sets updatedAt timestamp on save
- `alert-service.test.ts` > evaluation > evaluates deterministic condition
- `alert-service.test.ts` > evaluation > evaluates fuzzy condition via LLM
- `alert-service.test.ts` > evaluation > fuzzy condition returns false when LLM says no
- `alert-service.test.ts` > evaluation > executes actions when condition is met
- `alert-service.test.ts` > evaluation > executes run_report action
- `alert-service.test.ts` > evaluation > reads data and evaluates "not empty"
- `alert-service.test.ts` > evaluation > saves history after firing
- `alert-service.test.ts` > evaluation > updates lastFired timestamp

**Edge case tests:**
- `alert-service.test.ts` > CRUD > returns null for nonexistent alert
- `alert-service.test.ts` > CRUD > returns false when deleting nonexistent alert
- `alert-service.test.ts` > CRUD > enforces maximum alert limit
- `alert-service.test.ts` > evaluation > skips actions when in cooldown
- `alert-service.test.ts` > evaluation > does not execute actions in preview mode
- `alert-service.test.ts` > evaluation > preview does not update lastFired
- `alert-service.test.ts` > evaluation > preview does not save history
- `alert-service.test.ts` > evaluation > returns not-met when condition is false
- `alert-service.test.ts` > evaluation > returns error result for nonexistent alert
- `alert-service.test.ts` > evaluation > handles missing data source files
- `alert-service.test.ts` > error handling > returns error result on evaluation failure
- `alert-service.test.ts` > error handling > returns empty list when alerts directory does not exist

**Concurrency tests:**
- `alert-service.test.ts` > concurrency > handles concurrent evaluate calls without errors

**State transition tests:**
- `alert-service.test.ts` > state transitions > toggle enabled → disabled → enabled preserves alert data

**Security tests:**
- `alert-service.test.ts` > preview ignores cooldown > preview returns conditionMet true even when in cooldown

**Edge case tests (D14 load-time validation):**
- `alert-load-validation.test.ts` > listAlerts() > skips files with corrupt YAML
- `alert-load-validation.test.ts` > listAlerts() > includes structurally invalid alert with _validationErrors
- `alert-load-validation.test.ts` > listAlerts() > returns valid alerts without _validationErrors
- `alert-load-validation.test.ts` > getAlert() > returns null for corrupt YAML
- `alert-load-validation.test.ts` > getAlert() > attaches _validationErrors for invalid definition
- `alert-load-validation.test.ts` > evaluate() execution gate > refuses to evaluate an alert with validation errors
- `alert-load-validation.test.ts` > saveAlert() strips _validationErrors > does not persist _validationErrors to disk

**Fixes:**
- **D14 (2026-04-13):** Alert loading now uses `readYamlFileStrict()` + `safeValidateAlert()`. Corrupt YAML is skipped with logged warning. Invalid definitions are included in lists with `_validationErrors` attached but cannot be evaluated via `evaluate()`. `_validationErrors` is stripped before persisting to disk. CL: D14-fix.

### REQ-ALERT-004: Alert cron lifecycle

**Status:** Implemented

Alerts register/unregister cron jobs on save/delete/toggle. Init registers all enabled alerts.

**Standard tests:**
- `alert-service.test.ts` > cron lifecycle > registers cron job on save for enabled alert
- `alert-service.test.ts` > cron lifecycle > does not register cron job for disabled alert
- `alert-service.test.ts` > cron lifecycle > unregisters cron job on delete
- `alert-service.test.ts` > cron lifecycle > re-syncs cron job on update
- `alert-service.test.ts` > cron lifecycle > init registers enabled alerts as cron jobs

### REQ-ALERT-005: Alert event-based triggers

**Status:** Implemented

Event-triggered alerts subscribe to EventBus events instead of running on a cron schedule. Event subscriptions are managed alongside cron jobs: subscribe on save/init for enabled alerts, unsubscribe on delete/disable. Saving an enabled event alert without EventBus returns a validation error. Event name format validated with pattern `^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,99}$`.

**Standard tests:**
- `alert-service.test.ts` > event trigger lifecycle > subscribes to event on save for enabled event-triggered alert
- `alert-service.test.ts` > event trigger lifecycle > does not subscribe for disabled event-triggered alert
- `alert-service.test.ts` > event trigger lifecycle > unsubscribes on delete
- `alert-service.test.ts` > event trigger lifecycle > re-syncs subscription on update (disable → enable)
- `alert-service.test.ts` > event trigger lifecycle > does not register cron job for event-triggered alert
- `alert-service.test.ts` > event trigger lifecycle > init registers event subscriptions for enabled alerts
- `alert-service.test.ts` > event trigger lifecycle > evaluates alert when event fires
- `alert-validator.test.ts` > accepts valid event-triggered alert
- `alert-validator.test.ts` > accepts event names with colons, dots, hyphens, underscores
- `alert-validator.test.ts` > event trigger does not require schedule field

**Edge case tests:**
- `alert-service.test.ts` > event trigger without eventBus > returns validation error when saving enabled event alert without eventBus
- `alert-service.test.ts` > event trigger without eventBus > allows saving disabled event alert without eventBus
- `alert-service.test.ts` > event trigger without eventBus > cleans up map entry on delete, re-save works
- `alert-validator.test.ts` > rejects empty event_name
- `alert-validator.test.ts` > rejects whitespace-only event_name
- `alert-validator.test.ts` > rejects event_name with spaces
- `alert-validator.test.ts` > rejects event_name exceeding 100 characters
- `alert-validator.test.ts` > rejects event_name starting with special character
- `alert-validator.test.ts` > falls back to schedule validation for scheduled trigger type

**Fixes:** C3 (event alerts silently never fired without eventBus), C4 (no event_name format validation), C5 (event trigger tests absent), C6 (event trigger validation tests absent), C7 (getEffectiveTrigger silent fallback), C8 (unsubscribeEvent map leak)

### REQ-ALERT-006: Enhanced alert actions (6 types + dynamic data)

**Status:** Implemented

Enhanced alert action system: data passthrough from evaluation to actions, template variable resolution (`{data}`, `{summary}`, `{alert_name}`, `{date}`), 4 new action types (webhook, write_data, audio, dispatch_message), LLM summary generation for telegram messages. Backward compatible — existing alerts work unchanged.

**Standard tests:**
- `alert-executor-enhanced.test.ts` > resolveTemplate > resolves {data} variable
- `alert-executor-enhanced.test.ts` > resolveTemplate > resolves {summary} variable
- `alert-executor-enhanced.test.ts` > resolveTemplate > resolves {alert_name} variable
- `alert-executor-enhanced.test.ts` > resolveTemplate > resolves {date} variable
- `alert-executor-enhanced.test.ts` > resolveTemplate > resolves multiple variables in one template
- `alert-executor-enhanced.test.ts` > telegram_message with templates > resolves {data} in telegram message
- `alert-executor-enhanced.test.ts` > telegram_message with templates > resolves {alert_name} in telegram message
- `alert-executor-enhanced.test.ts` > telegram_message with LLM summary > generates LLM summary when {summary} is used
- `alert-executor-enhanced.test.ts` > telegram_message with LLM summary > skips LLM call when {summary} not in template
- `alert-executor-enhanced.test.ts` > webhook > sends POST to configured URL
- `alert-executor-enhanced.test.ts` > webhook > includes data when include_data is true
- `alert-executor-enhanced.test.ts` > write_data > writes content to a file
- `alert-executor-enhanced.test.ts` > write_data > appends content to a file
- `alert-executor-enhanced.test.ts` > write_data > resolves template variables in content
- `alert-executor-enhanced.test.ts` > audio > calls audioService.speak with resolved text
- `alert-executor-enhanced.test.ts` > audio > passes device name to audioService
- `alert-executor-enhanced.test.ts` > dispatch_message > calls router.routeMessage with resolved text
- `alert-executor-enhanced.test.ts` > dispatch_message > resolves template variables in dispatch text
- `alert-executor-enhanced.test.ts` > mixed action types > executes multiple different action types
- `alert-executor-enhanced.test.ts` > mixed action types > reuses LLM summary across actions (only one LLM call)

**Edge case tests:**
- `alert-executor-enhanced.test.ts` > resolveTemplate > resolves same variable multiple times
- `alert-executor-enhanced.test.ts` > resolveTemplate > leaves unknown variables untouched
- `alert-executor-enhanced.test.ts` > telegram_message with templates > truncates long telegram messages
- `alert-executor-enhanced.test.ts` > telegram_message with templates > works without context (backward compat)
- `alert-executor-enhanced.test.ts` > telegram_message with LLM summary > gracefully degrades when LLM fails
- `alert-executor-enhanced.test.ts` > telegram_message with LLM summary > gracefully degrades when LLM service not available
- `alert-executor-enhanced.test.ts` > webhook > fails on non-200 response
- `alert-executor-enhanced.test.ts` > webhook > fails on network error
- `alert-executor-enhanced.test.ts` > write_data > fails when dataDir not available
- `alert-executor-enhanced.test.ts` > audio > fails when audioService not available
- `alert-executor-enhanced.test.ts` > dispatch_message > fails when router not available
- `alert-executor-enhanced.test.ts` > mixed action types > isolates failures across action types
- `alert-executor-enhanced.test.ts` > edge cases > handles empty data gracefully
- `alert-executor-enhanced.test.ts` > edge cases > handles empty alertName gracefully
- `alert-executor-enhanced.test.ts` > edge cases > data truncation preserves exact MAX_DATA_LENGTH characters
- `alert-executor-enhanced.test.ts` > edge cases > template with no variables passes through unchanged

**Security tests:**
- `alert-executor-enhanced.test.ts` > security > LLM summary sanitizes data to prevent prompt injection
- `alert-executor-enhanced.test.ts` > security > LLM summary sanitizes custom prompt to prevent injection
- `alert-executor-enhanced.test.ts` > security > write_data with backslash path is rejected at runtime
- `alert-executor-enhanced.test.ts` > write_data > rejects path traversal

### REQ-ALERT-007: Validation for new action types

**Status:** Implemented

Validator extended for 4 new action types: webhook (URL required, http/https only), write_data (app_id format, registered user_id, path traversal/backslash protection, mode), audio (message required), dispatch_message (text + registered user_id).

**Standard tests:**
- `alert-validator-actions.test.ts` > webhook > accepts valid webhook config
- `alert-validator-actions.test.ts` > webhook > accepts http URL
- `alert-validator-actions.test.ts` > write_data > accepts valid write_data config
- `alert-validator-actions.test.ts` > write_data > accepts empty string content
- `alert-validator-actions.test.ts` > audio > accepts valid audio config
- `alert-validator-actions.test.ts` > audio > accepts audio config with device
- `alert-validator-actions.test.ts` > dispatch_message > accepts valid dispatch_message config
- `alert-validator-actions.test.ts` > action type recognition > recognizes all 6 valid types (6 tests)
- `alert-validator-actions.test.ts` > action type recognition > rejects unknown action type

**Edge case tests:**
- `alert-validator-actions.test.ts` > webhook > rejects missing URL
- `alert-validator-actions.test.ts` > write_data > rejects missing app_id
- `alert-validator-actions.test.ts` > write_data > rejects invalid app_id format
- `alert-validator-actions.test.ts` > write_data > rejects missing user_id
- `alert-validator-actions.test.ts` > write_data > rejects missing path
- `alert-validator-actions.test.ts` > write_data > rejects invalid mode
- `alert-validator-actions.test.ts` > write_data > rejects backslash in path
- `alert-validator-actions.test.ts` > audio > rejects empty message
- `alert-validator-actions.test.ts` > audio > rejects whitespace-only message
- `alert-validator-actions.test.ts` > dispatch_message > rejects empty text
- `alert-validator-actions.test.ts` > dispatch_message > rejects missing user_id

**Security tests:**
- `alert-validator-actions.test.ts` > webhook > rejects non-http URL
- `alert-validator-actions.test.ts` > webhook > rejects file:// URL
- `alert-validator-actions.test.ts` > webhook > rejects javascript: URL
- `alert-validator-actions.test.ts` > write_data > rejects unregistered user_id
- `alert-validator-actions.test.ts` > write_data > rejects path traversal
- `alert-validator-actions.test.ts` > write_data > rejects absolute path
- `alert-validator-actions.test.ts` > dispatch_message > rejects unregistered user_id
- `alert-validator-actions.test.ts` > dispatch_message > rejects invalid user_id format

### REQ-ALERT-GUI-001: Alert GUI

**Status:** Implemented

GUI routes for alert management: list, create, edit, delete, toggle, test/preview, history.

**Standard tests:**
- `alerts.test.ts` > GET /gui/alerts > returns 200 with empty alert list
- `alerts.test.ts` > GET /gui/alerts > shows existing alerts
- `alerts.test.ts` > GET /gui/alerts > shows schedule and condition
- `alerts.test.ts` > GET /gui/alerts/new > returns 200 with create form
- `alerts.test.ts` > GET /gui/alerts/:id/edit > returns 200 for existing alert
- `alerts.test.ts` > POST /gui/alerts > creates an alert and redirects
- `alerts.test.ts` > POST /gui/alerts/:id > updates an existing alert
- `alerts.test.ts` > POST /gui/alerts/:id/delete > deletes an alert and redirects
- `alerts.test.ts` > POST /gui/alerts/:id/toggle > toggles alert enabled state
- `alerts.test.ts` > POST /gui/alerts/:id/test > returns test result HTML

**Edge case tests:**
- `alerts.test.ts` > GET /gui/alerts/:id/edit > returns 404 for nonexistent alert
- `alerts.test.ts` > POST /gui/alerts > re-renders form on validation error
- `alerts.test.ts` > POST /gui/alerts/:id > forces ID from URL param
- `alerts.test.ts` > POST /gui/alerts/:id/toggle > returns 404 for nonexistent alert
- `alerts.test.ts` > POST /gui/alerts/:id/test > does not execute actions
- `alerts.test.ts` > GET /gui/alerts/:id/history > returns history page for existing alert
- `alerts.test.ts` > GET /gui/alerts/:id/history > returns 404 for nonexistent alert
- `alerts.test.ts` > GET /gui/alerts/:id/history/:file > rejects path traversal in file name
- `alerts.test.ts` > GET /gui/alerts/:id/history/:file > rejects path traversal in alert id parameter
- `alerts.test.ts` > GET /gui/alerts/:id/history/:file > rejects non-.md files
- `alerts.test.ts` > GET /gui/alerts/:id/history/:file > returns 404 for missing history file
- `alerts.test.ts` > XSS protection > escapes HTML in toggle response
- `alerts.test.ts` > XSS protection > escapes HTML in test response

**Standard tests (D39 space_id support):**
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > scope=space parsing > parses space scope — space_id set, user_id omitted
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > scope=user parsing > parses user scope — user_id set, space_id omitted
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > fallback scope detection > treats as space scope when scope field absent but space_id present
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > D39 regression: API-created space-scoped alert round-trip > retains space_id after GUI edit and save

**Edge case tests (D39 + D14 GUI robustness):**
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > space dropdown > edit page includes space options when spaceService is provided
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > D14: list route tolerance > renders list page without crash when a structurally invalid alert exists on disk
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > D14: validation error banner > edit page shows structural error banner for an invalid alert
- `alert-space-id.test.ts` > D39: Alert form space_id round-trip > D39: empty space_id edge case > rejects empty space_id — re-renders form with validation errors, no redirect

**Fixes:**
- **D39 (2026-04-13):** Alert edit form now exposes scope radio (user/space) + space dropdown. `parseFormToAlert` handles `ds_scope_*` / `ds_space_id_*` with user_id/space_id mutual exclusion and fallback for missing scope field. SpaceService wired into route registration. Validation error banners in edit views, warning badges in list views. CL: D39-fix.

---

## Phase 23: Shared Data Spaces

### REQ-SPACE-001: Space CRUD with validation
**Status:** Implemented
**Description:** Space service provides full CRUD operations (create, read, update, delete) with validation of space ID pattern, name, members (registered users only), and limits (max spaces, max members).

**Tests:**
- `spaces.test.ts` > init > loads spaces and active spaces from disk
- `spaces.test.ts` > init > handles missing files (empty state)
- `spaces.test.ts` > listSpaces > returns sorted list by name
- `spaces.test.ts` > getSpace > returns space by ID
- `spaces.test.ts` > getSpace > returns null for non-existent ID
- `spaces.test.ts` > saveSpace > creates a new space
- `spaces.test.ts` > saveSpace > updates an existing space
- `spaces.test.ts` > saveSpace > persists to disk
- `spaces.test.ts` > deleteSpace > removes the definition
- `spaces.test.ts` > deleteSpace > returns false for non-existent space
- `spaces.test.ts` > deleteSpace > clears active spaces for affected users
- `spaces.test.ts` > validation > rejects invalid ID (pattern)
- `spaces.test.ts` > validation > rejects ID starting with number
- `spaces.test.ts` > validation > rejects ID with spaces
- `spaces.test.ts` > validation > rejects ID too long
- `spaces.test.ts` > validation > rejects empty name
- `spaces.test.ts` > validation > rejects whitespace-only name
- `spaces.test.ts` > validation > rejects name too long
- `spaces.test.ts` > validation > rejects unregistered members
- `spaces.test.ts` > validation > rejects missing creator
- `spaces.test.ts` > validation > rejects empty ID
- `spaces.test.ts` > validation > rejects members exceeding max limit on create
- `spaces.test.ts` > edge cases > saveSpace enforces max spaces limit
- `spaces.test.ts` > edge cases > saveSpace allows update when at limit

**Edge case tests (D14 load-time validation):**
- `spaces.test.ts` > init() space entry validation (D14) > excludes invalid space entries (missing name) from operational map
- `spaces.test.ts` > init() space entry validation (D14) > excludes space entry where id does not match key
- `spaces.test.ts` > init() space entry validation (D14) > logs warning and loads no spaces when spaces.yaml has corrupt YAML

**Fixes:**
- **D14 (2026-04-13):** Space `init()` now uses `readYamlFileStrict()` — corrupt `spaces.yaml` logs a warning instead of silently loading as empty. Each entry's structure (`id`, `name`, `members`, `createdBy`) is validated and invalid entries are excluded from the operational map with a logged warning. CL: D14-fix.

### REQ-SPACE-002: Membership management
**Status:** Implemented
**Description:** Add/remove members from spaces with validation. Members must be registered users. Removal clears active space for the removed user.

**Tests:**
- `spaces.test.ts` > isMember > returns true for a member
- `spaces.test.ts` > isMember > returns false for a non-member
- `spaces.test.ts` > isMember > returns false for non-existent space
- `spaces.test.ts` > getSpacesForUser > returns all spaces where user is a member
- `spaces.test.ts` > getSpacesForUser > returns empty array for user with no spaces
- `spaces.test.ts` > addMember > adds a member to a space
- `spaces.test.ts` > addMember > persists new member to disk
- `spaces.test.ts` > removeMember > removes a member from a space
- `spaces.test.ts` > removeMember > clears active space for removed member
- `spaces.test.ts` > edge cases > addMember rejects duplicate
- `spaces.test.ts` > edge cases > addMember rejects at member limit
- `spaces.test.ts` > edge cases > addMember returns error for non-existent space
- `spaces.test.ts` > edge cases > removeMember returns error for non-member
- `spaces.test.ts` > edge cases > removeMember returns error for non-existent space
- `spaces.test.ts` > security > addMember rejects unregistered user

### REQ-SPACE-003: Active space tracking with stale cleanup
**Status:** Implemented
**Description:** Per-user active space tracking persisted to disk. Stale references (deleted space, removed membership) auto-cleared on read.

**Tests:**
- `spaces.test.ts` > getActiveSpace > returns active space ID for user
- `spaces.test.ts` > getActiveSpace > returns null when user has no active space
- `spaces.test.ts` > setActiveSpace > enters space mode
- `spaces.test.ts` > setActiveSpace > exits space mode (null)
- `spaces.test.ts` > setActiveSpace > persists active space to disk
- `spaces.test.ts` > edge cases > getActiveSpace clears stale active space (deleted space)
- `spaces.test.ts` > edge cases > getActiveSpace clears stale active space (removed from membership)
- `spaces.test.ts` > edge cases > getActiveSpace detects stale reference on reload
- `spaces.test.ts` > security > setActiveSpace rejects non-member
- `spaces.test.ts` > security > setActiveSpace rejects non-existent space
- `spaces.test.ts` > security > setActiveSpace allows exit (null) even without prior space

### REQ-SPACE-004: Telegram /space command with subcommands
**Status:** Implemented
**Description:** Built-in router command with subcommands: status, enter, exit, create, delete, invite (by name), kick (by name), members. Includes active space injection into message context.

**Tests:**
- `router-spaces.test.ts` > active space injection > injects spaceId and spaceName when user has active space
- `router-spaces.test.ts` > active space injection > does NOT inject spaceId when user has no active space
- `router-spaces.test.ts` > active space injection > does NOT inject spaceId when spaceService is not configured
- `router-spaces.test.ts` > /space (status) > shows "Personal mode" when no active space
- `router-spaces.test.ts` > /space (status) > shows active space name when in a space
- `router-spaces.test.ts` > /space (status) > lists user spaces
- `router-spaces.test.ts` > /space <id> > enters space mode successfully
- `router-spaces.test.ts` > /space <id> > rejects non-member with error
- `router-spaces.test.ts` > /space <id> > rejects non-existent space
- `router-spaces.test.ts` > /space off > exits space mode
- `router-spaces.test.ts` > /space create > creates space with user as first member
- `router-spaces.test.ts` > /space create > sends validation errors on invalid input
- `router-spaces.test.ts` > /space create > sends usage message when missing args
- `router-spaces.test.ts` > /space delete > deletes space when requested by creator
- `router-spaces.test.ts` > /space delete > rejects non-creator
- `router-spaces.test.ts` > /space delete > handles non-existent space
- `router-spaces.test.ts` > /space invite > adds member by name
- `router-spaces.test.ts` > /space invite > rejects unknown username
- `router-spaces.test.ts` > /space invite > sends usage message when missing args
- `router-spaces.test.ts` > /space kick > removes member by name
- `router-spaces.test.ts` > /space kick > rejects unknown username
- `router-spaces.test.ts` > /space members > lists members with names
- `router-spaces.test.ts` > /space when not configured > sends "not configured" message
- `router-spaces.test.ts` > /help > includes space commands when spaceService is configured
- `router-spaces.test.ts` > /help > does NOT include space commands when spaceService is absent

### REQ-SPACE-005: Authorization — invite/kick requires membership
**Status:** Implemented
**Description:** `/space invite` and `/space kick` require the calling user to be a member of the target space. Non-members are rejected with a clear error message.
**Fixes:** C1 (2026-03-15) — any registered user could modify any space's membership. See Phase 23 Security Review.

**Tests:**
- `router-spaces.test.ts` > /space invite — authorization > rejects invite from non-member
- `router-spaces.test.ts` > /space invite — authorization > allows invite from member
- `router-spaces.test.ts` > /space kick — authorization > rejects kick from non-member
- `router-spaces.test.ts` > /space kick — authorization > allows kick from member
- `router-spaces.test.ts` > /space kick — authorization > rejects kicking the creator via service validation

### REQ-SPACE-006: Creator cannot be removed from own space
**Status:** Implemented
**Description:** `removeMember()` prevents removing the space creator, which would leave `createdBy` pointing to a non-member and prevent deletion via Telegram.
**Fixes:** H1 (2026-03-15) — creator could kick themselves, leaving orphaned space.

**Tests:**
- `spaces.test.ts` > security > removeMember rejects removing the creator

### REQ-SPACE-007: Write serialization (writeQueue) on SpaceService
**Status:** Implemented
**Description:** All write operations (`saveSpace`, `deleteSpace`, `addMember`, `removeMember`, `setActiveSpace`) are serialized through a promise-chain `writeQueue` to prevent concurrent YAML file corruption from simultaneous Telegram messages.
**Fixes:** C4 (2026-03-15) — concurrent family members could race on persist(), causing lost writes.

**Tests:**
- `spaces.test.ts` > concurrency > concurrent saveSpace operations serialize correctly
- `spaces.test.ts` > concurrency > concurrent saveSpace and deleteSpace serialize correctly
- `spaces.test.ts` > concurrency > concurrent addMember operations serialize correctly

### REQ-SPACE-008: space_id validation in report/alert validators
**Status:** Implemented
**Description:** When `space_id` is present in report app-data sections or alert data sources, it is validated against `SPACE_ID_PATTERN` (defense-in-depth against path traversal).
**Fixes:** C2 (2026-03-15) — malicious space_id bypassed validation.

**Tests:**
- `alert-validator-spaces.test.ts` > validates valid space_id format
- `alert-validator-spaces.test.ts` > rejects path-traversal space_id
- `alert-validator-spaces.test.ts` > rejects uppercase space_id
- `report-validator-spaces.test.ts` > validates valid space_id format
- `report-validator-spaces.test.ts` > rejects path-traversal space_id
- `report-validator-spaces.test.ts` > rejects uppercase space_id

### REQ-SPACE-009: user_id optional when space_id present
**Status:** Implemented
**Description:** In report app-data sections and alert data sources, `user_id` is required only when `space_id` is NOT set. When `space_id` is set, data is read from `data/spaces/<space_id>/<app_id>/` instead of per-user directories.
**Fixes:** C3 (2026-03-15) — user_id was unconditionally required even for space-only data sources.

**Tests:**
- `alert-validator-spaces.test.ts` > allows missing user_id when space_id is set
- `alert-validator-spaces.test.ts` > requires user_id when space_id is not set
- `alert-validator-spaces.test.ts` > allows both user_id and space_id together
- `report-validator-spaces.test.ts` > allows missing user_id when space_id is set
- `report-validator-spaces.test.ts` > requires user_id when space_id is not set
- `report-validator-spaces.test.ts` > allows both user_id and space_id together

### REQ-SPACE-010: Duplicate member rejection
**Status:** Implemented
**Description:** `validateSpace()` rejects space definitions with duplicate member IDs.
**Fixes:** H3 (2026-03-15) — `saveSpace({ members: ['111', '111'] })` succeeded.

**Tests:**
- `spaces.test.ts` > security > saveSpace rejects duplicate members

### REQ-SPACE-011: Creator must be registered and in members array
**Status:** Implemented
**Description:** `validateSpace()` validates that `createdBy` is a registered user AND is included in the `members` array.
**Fixes:** H2 (2026-03-15) — creator not validated as registered or as member.

**Tests:**
- `spaces.test.ts` > security > saveSpace rejects unregistered creator
- `spaces.test.ts` > security > saveSpace rejects creator not in members array

### REQ-SPACE-012: GUI space management
**Status:** Implemented
**Description:** GUI pages for space CRUD and member management (add/remove with user dropdown). Navigation link in layout header. Space data browsable in data browser.

**Tests:**
- `spaces-gui.test.ts` (15 tests — see Phase 23 implementation)

### REQ-SPACE-013: DataStore.forSpace() with membership enforcement
**Status:** Implemented
**Description:** `DataStore.forSpace(spaceId, userId)` returns `ScopedDataStore` rooted at `data/spaces/<spaceId>/<appId>/`. Validates space ID format and membership; throws `SpaceMembershipError` on unauthorized access.

**Tests:**
- `scoped-store.test.ts` (20 space-related tests — see Phase 23 implementation)

### REQ-SPACE-014: Change log tracks spaceId
**Status:** Implemented
**Description:** `ChangeLogEntry.spaceId` optional field tracks which space was modified. `ScopedStore` passes `spaceId` to all change log records.

**Tests:**
- See REQ-DATA-003 tests in change-log.test.ts

### REQ-SPACE-015: Data browser shows space data
**Status:** Implemented
**Description:** GUI data browser supports `scope=space` parameter for browsing space data directories.

**Tests:**
- See REQ-GUI-DATA-001 tests in data.test.ts

### REQ-SPACE-016: Error handling — corrupt YAML recovery
**Status:** Implemented
**Description:** SpaceService init() gracefully handles corrupt or malformed YAML files (returns empty state instead of crashing).

**Tests:**
- `spaces.test.ts` > error handling > init recovers from corrupt YAML (empty state)

### REQ-SPACE-017: State transition — setActiveSpace on deleted space
**Status:** Implemented
**Description:** Setting active space on a deleted space returns a validation error.

**Tests:**
- `spaces.test.ts` > state transitions > setActiveSpace on deleted space returns error

---

## Per-User Obsidian Vaults

### REQ-VAULT-001: Vault rebuild creates correct symlinks
**Status:** Implemented
**Description:** VaultService.rebuildVault() creates symlinks for personal app directories, shared directories, and space directories (membership-gated). Stale symlinks are cleaned up. Rebuild is idempotent.

**Tests:**
- Standard (happy path)
  - `vault.test.ts` > rebuildVault > should create symlinks for personal app directories
  - `vault.test.ts` > rebuildVault > should create symlinks for shared app directories
  - `vault.test.ts` > rebuildVault > should create symlinks for space directories the user is a member of
  - `vault.test.ts` > rebuildVault > should handle user with no data directories
  - `vault.test.ts` > rebuildAll > should rebuild vaults for all registered users
  - `vault.test.ts` > rebuildAll > should handle no registered users
  - `vault.test.ts` > symlink correctness > should use absolute targets for symlinks
  - `vault.test.ts` > symlink correctness > should update symlink if target changes
- Edge cases
  - `vault.test.ts` > rebuildVault > should not create space symlinks for spaces the user is not a member of
  - `vault.test.ts` > rebuildVault > should remove stale symlinks on rebuild
  - `vault.test.ts` > rebuildVault > should remove stale space directories on rebuild
  - `vault.test.ts` > rebuildVault > should be idempotent — second rebuild produces same result
  - `vault.test.ts` > rebuildVault > should not remove real directories, only symlinks
  - `vault.test.ts` > rebuildAll > should continue if one user vault fails
  - `vault.test.ts` > edge cases > should handle multiple spaces per user
  - `vault.test.ts` > edge cases > should handle personal and space data together
  - `vault.test.ts` > edge cases > should not create _shared dir if no shared data exists
  - `vault.test.ts` > edge cases > should handle space with empty app directories
  - `vault.test.ts` > edge cases > should remove stale shared app symlinks

### REQ-VAULT-002: Incremental space link add/remove
**Status:** Implemented
**Description:** VaultService.addSpaceLink() and removeSpaceLink() provide incremental vault updates without full rebuild. addSpaceLink triggers full rebuild if vault doesn't exist yet.

**Tests:**
- Standard (happy path)
  - `vault.test.ts` > addSpaceLink > should add space symlinks to user vault
  - `vault.test.ts` > removeSpaceLink > should remove space symlinks from user vault
  - `vault.test.ts` > removeSpaceFromAll > should remove space from all members vaults
- Edge cases
  - `vault.test.ts` > addSpaceLink > should trigger full rebuild if vault does not exist yet
  - `vault.test.ts` > addSpaceLink > should handle space with no app directories
  - `vault.test.ts` > removeSpaceLink > should not throw if space link does not exist

### REQ-VAULT-003: Path traversal prevention
**Status:** Implemented
**Description:** userId and spaceId parameters validated against SAFE_SEGMENT pattern to prevent path traversal in vault directory creation and symlink operations.

**Tests:**
- Security
  - `vault.test.ts` > security > should reject path traversal in userId for rebuildVault
  - `vault.test.ts` > security > should reject path traversal in userId for addSpaceLink
  - `vault.test.ts` > security > should reject path traversal in spaceId for addSpaceLink
  - `vault.test.ts` > security > should reject path traversal in spaceId for removeSpaceLink

### REQ-VAULT-004: SpaceService integration hooks
**Status:** Implemented
**Description:** SpaceService calls VaultService on addMember, removeMember, saveSpace, and deleteSpace. VaultService is optional — operations work without it (backward compatible). Vault errors caught and logged, never break space operations.

**Tests:**
- Standard (happy path)
  - `vault.test.ts` > SpaceService integration > should call vault hooks from SpaceService.addMember
  - `vault.test.ts` > SpaceService integration > should call vault hooks from SpaceService.removeMember
  - `vault.test.ts` > SpaceService integration > should call vault hooks from SpaceService.deleteSpace
- Edge cases
  - `vault.test.ts` > SpaceService integration > should work without vault service (backward compat)

---

## 24. External Data API

### REQ-API-001: API Bearer token authentication
**Status:** Implemented
**Description:** External API endpoints require `Authorization: Bearer <token>` header. Token validated via `timingSafeEqual()`. Rate limited per IP (100 req/60s). API disabled when `API_TOKEN` env var is empty.

**Tests:**
- Standard (happy path)
  - `auth.test.ts` > API Auth > valid token returns 200
- Edge cases
  - `auth.test.ts` > API Auth > missing Authorization header returns 401
  - `auth.test.ts` > API Auth > wrong prefix (no "Bearer ") returns 401
  - `auth.test.ts` > API Auth > empty token after Bearer returns 401
  - `auth.test.ts` > API Auth > wrong token returns 401
- Security
  - `auth.test.ts` > API Auth > rate limit exceeded returns 429
  - `auth.test.ts` > API Auth > rate limit check runs before auth

### REQ-API-002: Data ingestion endpoint
**Status:** Implemented
**Description:** `POST /api/data` writes or appends files to PAS's scoped data store. Validates userId registration and format, appId format, path traversal, mode, and optional spaceId. Supports user-scoped and space-scoped writes.

**Tests:**
- Standard (happy path)
  - `data.test.ts` > API Data Route > write mode creates file
  - `data.test.ts` > API Data Route > append mode appends to file
  - `data.test.ts` > API Data Route > space-scoped write with valid membership
  - `data.test.ts` > API Data Route > change log records operation
- Edge cases
  - `data.test.ts` > API Data Route > mode defaults to write
  - `data.test.ts` > API Data Route > empty string content writes empty file
  - `data.test.ts` > API Data Route > nested path creates subdirectories
- Error handling
  - `data.test.ts` > API Data Route > missing userId returns 400
  - `data.test.ts` > API Data Route > missing appId returns 400
  - `data.test.ts` > API Data Route > missing path returns 400
  - `data.test.ts` > API Data Route > missing content returns 400
  - `data.test.ts` > API Data Route > unregistered userId returns 403
  - `data.test.ts` > API Data Route > invalid appId pattern returns 400
  - `data.test.ts` > API Data Route > invalid mode returns 400
  - `data.test.ts` > API Data Route > filesystem error returns 500
- Security
  - `data.test.ts` > API Data Route > path traversal attempt returns 400
  - `data.test.ts` > API Data Route > space membership denied returns 403
  - `data.test.ts` > API Data Route > invalid spaceId format returns 400
  - `data.test.ts` > API Data Route > userId with path traversal chars returns 400

### REQ-API-003: Message dispatch endpoint
**Status:** Implemented
**Description:** `POST /api/messages` dispatches text through PAS's router. Validates userId registration and format, text length (max 4096), and non-empty text. Wraps in LLM context for per-user cost attribution. Router responses sent via Telegram DM.

**Tests:**
- Standard (happy path)
  - `messages.test.ts` > API Messages Route > valid message dispatched through router
  - `messages.test.ts` > API Messages Route > message context includes timestamp
- Edge cases
  - `messages.test.ts` > API Messages Route > text at exactly 4096 chars is accepted
  - `messages.test.ts` > API Messages Route > non-string text returns 400
- Error handling
  - `messages.test.ts` > API Messages Route > missing text returns 400
  - `messages.test.ts` > API Messages Route > empty text returns 400
  - `messages.test.ts` > API Messages Route > text over 4096 chars returns 400
  - `messages.test.ts` > API Messages Route > missing userId returns 400
  - `messages.test.ts` > API Messages Route > unregistered userId returns 403
  - `messages.test.ts` > API Messages Route > router error caught and returns 500
- Security
  - `messages.test.ts` > API Messages Route > userId with path traversal chars returns 400

### REQ-API-004: Data read endpoint
**Status:** Implemented
**Description:** `GET /api/data?userId=X&appId=Y&path=Z[&spaceId=S]` reads files (returns content) or lists directories (returns entries with isDirectory flag). Returns `type: "not_found"` for missing paths. 1MB file size limit (413). Same auth, validation, and space membership checks as write endpoint.

**Tests:**
- Standard (happy path)
  - `data-read.test.ts` > API Data Read Route > reads a file
  - `data-read.test.ts` > API Data Read Route > lists a directory
  - `data-read.test.ts` > API Data Read Route > returns not_found for missing file
  - `data-read.test.ts` > API Data Read Route > reads space-scoped file
- Edge cases
  - `data-read.test.ts` > API Data Read Route > reads empty file
  - `data-read.test.ts` > API Data Read Route > lists nested directories showing isDirectory
  - `data-read.test.ts` > API Data Read Route > handles path with dots
  - `data-read.test.ts` > API Data Read Route > lists empty directory
  - `data-read.test.ts` > API Data Read Route > reads app root directory
- Error handling
  - `data-read.test.ts` > API Data Read Route > missing userId returns 400
  - `data-read.test.ts` > API Data Read Route > missing appId returns 400
  - `data-read.test.ts` > API Data Read Route > missing path returns 400
  - `data-read.test.ts` > API Data Read Route > unregistered user returns 403
  - `data-read.test.ts` > API Data Read Route > invalid appId pattern returns 400
- Security
  - `data-read.test.ts` > API Data Read Route > path traversal attempt returns 400
  - `data-read.test.ts` > API Data Read Route > invalid userId format returns 400
  - `data-read.test.ts` > API Data Read Route > non-member space read returns 403
  - `data-read.test.ts` > API Data Read Route > invalid spaceId format returns 400
- Configuration
  - `data-read.test.ts` > API Data Read Route > file exceeding 1MB returns 413

### REQ-API-005: Schedule listing endpoint
**Status:** Implemented
**Description:** `GET /api/schedules` returns all registered cron jobs with human-readable descriptions, ISO 8601 next/last run times. System-wide, no user scoping. Auth required.

**Tests:**
- Standard (happy path)
  - `schedules.test.ts` > API Schedules Route > returns empty schedule list
  - `schedules.test.ts` > API Schedules Route > returns job details with human-readable descriptions
  - `schedules.test.ts` > API Schedules Route > includes lastRunAt when available
  - `schedules.test.ts` > API Schedules Route > handles multiple jobs
- Edge cases
  - `schedules.test.ts` > API Schedules Route > job with no description returns null
  - `schedules.test.ts` > API Schedules Route > handles job with invalid cron expression gracefully
- Error handling
  - `schedules.test.ts` > API Schedules Route > CronManager error returns 500
- Security
  - `schedules.test.ts` > API Schedules Route > requires authentication

### REQ-API-006: Outbound webhooks
**Status:** Implemented
**Description:** `WebhookService` subscribes to EventBus events and POSTs JSON payloads to configured URLs. HMAC-SHA256 signing when secret configured. 10 deliveries/minute rate limit per URL. Fire-and-forget with 5s timeout. URL scheme validation (http/https only). Events emitted: `alert:fired`, `report:completed`, `data:changed`.

**Tests:**
- Standard (happy path)
  - `webhooks.test.ts` > WebhookService > subscribes to configured events on init
  - `webhooks.test.ts` > WebhookService > delivers payload on event
  - `webhooks.test.ts` > WebhookService > signs payload with HMAC when secret configured
  - `webhooks.test.ts` > WebhookService > delivers to multiple webhooks for same event
- Edge cases
  - `webhooks.test.ts` > WebhookService > no webhooks configured is a no-op
  - `webhooks.test.ts` > WebhookService > unrecognized event does not trigger delivery
  - `webhooks.test.ts` > WebhookService > wraps non-object payload in value field
  - `webhooks.test.ts` > WebhookService > wraps array payload in value field
  - `webhooks.test.ts` > WebhookService > undefined payload wraps as null value
- Error handling
  - `webhooks.test.ts` > WebhookService > handles fetch timeout gracefully
  - `webhooks.test.ts` > WebhookService > handles non-2xx response
- Security
  - `webhooks.test.ts` > WebhookService > rejects webhook with invalid URL scheme
  - `webhooks.test.ts` > WebhookService > rejects webhook with missing fields
- Concurrency
  - `webhooks.test.ts` > WebhookService > rate limits deliveries per URL
- State transitions
  - `webhooks.test.ts` > WebhookService > dispose unsubscribes from all events
  - `webhooks.test.ts` > WebhookService > double init does not duplicate subscriptions

---

## n8n Dispatch Pattern (Phase 26)

### REQ-API-007: Report execution API
**Status:** Implemented
**Description:** REST endpoints for report CRUD and execution. `GET /api/reports` lists all definitions. `GET /api/reports/:id` returns a single definition (404 for missing, 400 for invalid ID format). `POST /api/reports/:id/run` executes a report with optional `preview` flag. `POST /api/reports/:id/deliver` sends content to delivery users via Telegram with per-user error isolation. Explicit `userIds` array validated for format and registration. Content max 50,000 chars.

**Tests:**
- Standard
  - `reports-api.test.ts` > GET /reports > returns list of reports
  - `reports-api.test.ts` > GET /reports > returns empty list when no reports
  - `reports-api.test.ts` > GET /reports/:id > returns a report definition
  - `reports-api.test.ts` > POST /reports/:id/run > runs a report successfully
  - `reports-api.test.ts` > POST /reports/:id/run > passes preview option
  - `reports-api.test.ts` > POST /reports/:id/deliver > delivers content to report delivery users
  - `reports-api.test.ts` > POST /reports/:id/deliver > delivers to explicit userIds
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns partial delivery results on telegram errors
- Edge cases
  - `reports-api.test.ts` > GET /reports/:id > returns 404 for non-existent report
  - `reports-api.test.ts` > GET /reports/:id > returns 400 for invalid report ID
  - `reports-api.test.ts` > POST /reports/:id/run > returns 404 for non-existent report
  - `reports-api.test.ts` > POST /reports/:id/run > returns 400 for invalid report ID
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 404 when no explicit userIds and report not found
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 400 when delivery list is empty
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 400 for missing content
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 400 for oversized content
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 400 for invalid report ID
- Error handling
  - `reports-api.test.ts` > GET /reports > returns 500 on service error
  - `reports-api.test.ts` > GET /reports/:id > returns 500 on service error
  - `reports-api.test.ts` > POST /reports/:id/run > returns 500 on service error
- Security
  - `reports-api.test.ts` > GET /reports > requires authentication
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 403 for unregistered explicit userIds
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 400 for invalid userId format in userIds array
  - `reports-api.test.ts` > POST /reports/:id/deliver > returns 400 for non-string elements in userIds array

### REQ-API-008: Alert evaluation API
**Status:** Implemented
**Description:** REST endpoints for alert CRUD and evaluation. `GET /api/alerts` lists all definitions. `GET /api/alerts/:id` returns a single definition. `POST /api/alerts/:id/evaluate` evaluates condition and executes actions if met, with optional `preview` flag. `POST /api/alerts/:id/fire` is an alias for evaluate without preview. All endpoints validate alert ID format.

**Tests:**
- Standard
  - `alerts-api.test.ts` > GET /alerts > returns list of alerts
  - `alerts-api.test.ts` > GET /alerts/:id > returns an alert definition
  - `alerts-api.test.ts` > POST /alerts/:id/evaluate > evaluates an alert successfully
  - `alerts-api.test.ts` > POST /alerts/:id/evaluate > passes preview option
  - `alerts-api.test.ts` > POST /alerts/:id/fire > fires an alert
  - `alerts-api.test.ts` > GET /alerts > returns empty list
- Edge cases
  - `alerts-api.test.ts` > GET /alerts/:id > returns 404 for non-existent alert
  - `alerts-api.test.ts` > GET /alerts/:id > returns 400 for invalid alert ID
  - `alerts-api.test.ts` > POST /alerts/:id/evaluate > returns 404 for non-existent alert
  - `alerts-api.test.ts` > POST /alerts/:id/evaluate > returns 400 for invalid alert ID
  - `alerts-api.test.ts` > POST /alerts/:id/fire > returns 404 for non-existent alert
  - `alerts-api.test.ts` > POST /alerts/:id/fire > returns 400 for invalid alert ID
- Error handling
  - `alerts-api.test.ts` > GET /alerts > returns 500 on service error
  - `alerts-api.test.ts` > GET /alerts/:id > returns 500 on service error
  - `alerts-api.test.ts` > POST /alerts/:id/evaluate > returns 500 on service error
- Security
  - `alerts-api.test.ts` > GET /alerts > requires authentication

### REQ-API-009: Change log read API
**Status:** Implemented
**Description:** `GET /api/changes` returns change log entries. Default: last 24 hours. Optional `since` (ISO 8601), `appFilter` (app ID), `limit` (default 500, max 5000) query parameters. Returns `{ ok, since, count, entries }`.

**Tests:**
- Standard
  - `changes.test.ts` > returns entries from the last 24 hours by default
  - `changes.test.ts` > filters by since parameter
  - `changes.test.ts` > filters by appFilter parameter
  - `changes.test.ts` > respects limit parameter
- Edge cases
  - `changes.test.ts` > returns empty entries when no change log exists
  - `changes.test.ts` > returns empty when appFilter matches nothing
  - `changes.test.ts` > caps limit at maximum
  - `changes.test.ts` > returns 400 for invalid since date
  - `changes.test.ts` > returns 400 for invalid limit
- Security
  - `changes.test.ts` > requires authentication

### REQ-API-010: LLM proxy API
**Status:** Implemented
**Description:** `POST /api/llm/complete` proxies LLM completions through PAS. Required: `prompt` (string, max 100K chars). Optional: `tier` (fast/standard/reasoning, default fast), `systemPrompt` (max 10K), `maxTokens`, `temperature` (0-2). Cost attributed to `_appId: 'api'`. Cost cap/rate limit errors returned as 429 with sanitized messages. Prompt must not be empty after trim.

**Tests:**
- Standard
  - `llm.test.ts` > completes an LLM prompt
  - `llm.test.ts` > uses specified tier
  - `llm.test.ts` > passes systemPrompt, maxTokens, temperature
  - `llm.test.ts` > sets _appId to api
- Edge cases
  - `llm.test.ts` > returns 400 for missing prompt
  - `llm.test.ts` > returns 400 for empty prompt
  - `llm.test.ts` > returns 400 for invalid tier
  - `llm.test.ts` > returns 400 for invalid maxTokens
  - `llm.test.ts` > returns 400 for invalid temperature
  - `llm.test.ts` > returns 400 for oversized prompt
- Error handling
  - `llm.test.ts` > returns 500 for generic LLM errors
  - `llm.test.ts` > returns 429 for cost cap errors with sanitized message
  - `llm.test.ts` > returns 429 for rate limit errors with sanitized message
- Security
  - `llm.test.ts` > requires authentication

### REQ-API-011: Telegram send API
**Status:** Implemented
**Description:** `POST /api/telegram/send` sends a message via PAS's Telegram bot. Required: `userId` (validated format + registered), `message` (max 4096 chars, not empty). Returns `{ ok, sent }`.

**Tests:**
- Standard
  - `telegram.test.ts` > sends a message to a registered user
  - `telegram.test.ts` > returns 400 for missing userId
- Edge cases
  - `telegram.test.ts` > returns 400 for missing message
  - `telegram.test.ts` > returns 400 for empty message
  - `telegram.test.ts` > returns 400 for oversized message
- Error handling
  - `telegram.test.ts` > returns 500 on telegram send error
- Security
  - `telegram.test.ts` > requires authentication
  - `telegram.test.ts` > returns 400 for invalid userId format
  - `telegram.test.ts` > returns 403 for unregistered user

### REQ-API-012: n8n dispatcher service
**Status:** Implemented
**Description:** `N8nDispatcherImpl` sends `{ type, id, action }` payloads to configured dispatch URL via HTTP POST with 10s timeout. Returns `true` on 2xx, `false` on error/non-2xx (fallback signal). Disabled when URL is empty. Validates URL scheme (http/https only). Logs all dispatch attempts.

**Tests:**
- Standard
  - `n8n-dispatcher.test.ts` > enabled > returns true when dispatchUrl is set
  - `n8n-dispatcher.test.ts` > dispatch > returns true on successful dispatch (2xx)
  - `n8n-dispatcher.test.ts` > dispatch > dispatches alert payloads
  - `n8n-dispatcher.test.ts` > dispatch > dispatches daily_diff payloads
  - `n8n-dispatcher.test.ts` > dispatch > logs successful dispatches
- Edge cases
  - `n8n-dispatcher.test.ts` > enabled > returns false when dispatchUrl is empty
  - `n8n-dispatcher.test.ts` > dispatch > returns false when not enabled
  - `n8n-dispatcher.test.ts` > enabled > accepts https URLs
- Error handling
  - `n8n-dispatcher.test.ts` > dispatch > returns false on non-2xx response
  - `n8n-dispatcher.test.ts` > dispatch > returns false on network error
- Security
  - `n8n-dispatcher.test.ts` > enabled > returns false for non-http URL scheme

### REQ-API-013: n8n dispatch integration
**Status:** Implemented
**Description:** ReportService and AlertService accept optional `n8nDispatcher` parameter. When configured, cron handlers dispatch to n8n before executing internally. Dispatch failure triggers fallback to internal execution. Backward compatible — services work without dispatcher. Daily-diff cron in bootstrap also dispatches when configured.

**Tests:**
- Standard
  - `n8n-dispatch-integration.test.ts` > ReportService > accepts n8nDispatcher option without error
  - `n8n-dispatch-integration.test.ts` > ReportService > registers cron job when report is saved with dispatcher
  - `n8n-dispatch-integration.test.ts` > AlertService > accepts n8nDispatcher option without error
  - `n8n-dispatch-integration.test.ts` > AlertService > registers cron job when alert is saved with dispatcher
  - `n8n-dispatch-integration.test.ts` > N8nDispatcherImpl — disabled mode > disabled dispatcher never calls fetch
- Configuration
  - `n8n-dispatch-integration.test.ts` > ReportService > works without n8nDispatcher (backward compat)
  - `n8n-dispatch-integration.test.ts` > AlertService > works without n8nDispatcher (backward compat)

---

## Frontmatter

### REQ-FMATTER-001: Frontmatter generation and parsing

**Phase:** Post-24 | **Status:** Implemented

Generated markdown files must include Obsidian-compatible YAML frontmatter. The frontmatter utility must correctly generate, parse, and strip frontmatter blocks. Parsing must handle both `\n` and `\r\n` line endings. Values with YAML special characters must be quoted. Roundtrip (generate then parse) must preserve all values.

**Standard tests:**
- `frontmatter.test.ts` > generateFrontmatter > generates basic frontmatter block
- `frontmatter.test.ts` > generateFrontmatter > omits undefined and null fields
- `frontmatter.test.ts` > generateFrontmatter > handles arrays as YAML lists
- `frontmatter.test.ts` > generateFrontmatter > handles all FrontmatterMeta fields
- `frontmatter.test.ts` > generateFrontmatter > does not quote simple values
- `frontmatter.test.ts` > parseFrontmatter > parses basic frontmatter
- `frontmatter.test.ts` > parseFrontmatter > parses array values
- `frontmatter.test.ts` > parseFrontmatter > roundtrips through generate/parse
- `frontmatter.test.ts` > stripFrontmatter > strips frontmatter and returns body

**Edge case tests:**
- `frontmatter.test.ts` > generateFrontmatter > skips empty arrays
- `frontmatter.test.ts` > generateFrontmatter > quotes values with special characters
- `frontmatter.test.ts` > generateFrontmatter > quotes empty string values
- `frontmatter.test.ts` > parseFrontmatter > returns empty meta and full content when no frontmatter
- `frontmatter.test.ts` > parseFrontmatter > handles quoted values
- `frontmatter.test.ts` > parseFrontmatter > handles content with --- inside body
- `frontmatter.test.ts` > parseFrontmatter — edge cases > handles \r\n line endings
- `frontmatter.test.ts` > parseFrontmatter — edge cases > handles unclosed frontmatter (no closing ---)
- `frontmatter.test.ts` > parseFrontmatter — edge cases > handles frontmatter-only content (no body)
- `frontmatter.test.ts` > parseFrontmatter — edge cases > handles empty frontmatter block
- `frontmatter.test.ts` > generateFrontmatter — edge cases > quotes YAML reserved words
- `frontmatter.test.ts` > generateFrontmatter — edge cases > handles values containing backslashes
- `frontmatter.test.ts` > generateFrontmatter — edge cases > handles values containing double quotes
- `frontmatter.test.ts` > generateFrontmatter — edge cases > handles numeric values
- `frontmatter.test.ts` > generateFrontmatter — edge cases > handles completely empty meta object
- `frontmatter.test.ts` > hasFrontmatter > returns true for content with frontmatter
- `frontmatter.test.ts` > hasFrontmatter > returns false for content without frontmatter
- `frontmatter.test.ts` > hasFrontmatter > returns false for empty string
- `frontmatter.test.ts` > hasFrontmatter > returns false for --- not at start
- `frontmatter.test.ts` > stripFrontmatter > returns full content when no frontmatter
- `frontmatter.test.ts` > stripFrontmatter > handles empty body after frontmatter
- Security
  - `frontmatter.test.ts` > generateFrontmatter — security > quotes values that could be YAML injection
  - `frontmatter.test.ts` > generateFrontmatter — security > quotes tag values with special characters

**Fixes:**
- **D2a (2026-04-13):** Widened FrontmatterMeta.type from 6-literal union to string for app-defined types. CL: D2a-type-widen.

### REQ-FMATTER-004: Cross-app linking utilities

**Phase:** 27A | **Status:** Implemented

Frontmatter must support cross-app linking fields (`aliases`, `related`) for Obsidian vault compatibility. `extractWikiLinks()` must extract `[[target]]` and `[[target|display]]` patterns from markdown content. `buildAppTags()` must generate standardized hierarchical tags with `pas/` prefix, deduplicating extras.

**Standard tests:**
- `frontmatter.test.ts` > generateFrontmatter — cross-linking fields > generates aliases as YAML list
- `frontmatter.test.ts` > generateFrontmatter — cross-linking fields > generates related as YAML list with wiki-links
- `frontmatter.test.ts` > generateFrontmatter — cross-linking fields > roundtrips aliases through generate/parse
- `frontmatter.test.ts` > generateFrontmatter — cross-linking fields > roundtrips related wiki-links through generate/parse
- `frontmatter.test.ts` > generateFrontmatter — cross-linking fields > supports Dataview-friendly custom fields
- `frontmatter.test.ts` > extractWikiLinks > extracts simple wiki-links
- `frontmatter.test.ts` > extractWikiLinks > extracts wiki-links with display text
- `frontmatter.test.ts` > extractWikiLinks > extracts multiple wiki-links
- `frontmatter.test.ts` > buildAppTags > builds basic tags with app ID and type
- `frontmatter.test.ts` > buildAppTags > appends extra tags
- `frontmatter.test.ts` > buildAppTags > preserves tag order (extras after base tags)

**Edge case tests:**
- `frontmatter.test.ts` > extractWikiLinks > deduplicates repeated links
- `frontmatter.test.ts` > extractWikiLinks > returns empty array when no links present
- `frontmatter.test.ts` > extractWikiLinks > handles empty string
- `frontmatter.test.ts` > extractWikiLinks > ignores malformed links
- `frontmatter.test.ts` > extractWikiLinks > handles links with spaces in target
- `frontmatter.test.ts` > extractWikiLinks > trims whitespace from link targets
- `frontmatter.test.ts` > extractWikiLinks > handles links adjacent to each other
- `frontmatter.test.ts` > extractWikiLinks > handles multiline content with links
- `frontmatter.test.ts` > extractWikiLinks > ignores empty link targets
- `frontmatter.test.ts` > extractWikiLinks > handles nested brackets gracefully
- `frontmatter.test.ts` > buildAppTags > deduplicates extras that match base tags
- `frontmatter.test.ts` > buildAppTags > handles empty extras array
- `frontmatter.test.ts` > buildAppTags > handles undefined extras
- `frontmatter.test.ts` > buildAppTags > filters out empty string extras
- `frontmatter.test.ts` > buildAppTags > handles special characters in extras

### REQ-CHATBOT-011: Data question category

**Phase:** 27A | **Status:** Implemented

The chatbot `/ask` command must detect data-related questions via keyword heuristics (no LLM cost) and include relevant data context in the prompt. When triggered, lists the user's daily notes and installed app capabilities. Must not attempt to read other apps' data directories (scoped data isolation).

**Standard tests:**
- `chatbot.test.ts` > categorizeQuestion — data category > detects data-related questions
- `chatbot.test.ts` > categorizeQuestion — data category > detects food/fitness data keywords
- `chatbot.test.ts` > data category — app-aware prompt integration > includes daily notes listing when data category is detected
- `chatbot.test.ts` > data category — app-aware prompt integration > includes cross-app data note in overview

**Edge case tests:**
- `chatbot.test.ts` > categorizeQuestion — data category > does not false-positive on unrelated questions
- `chatbot.test.ts` > categorizeQuestion — data category > can combine data with other categories
- `chatbot.test.ts` > data category — app-aware prompt integration > handles no daily notes gracefully

### REQ-FMATTER-002: Atomic frontmatter-aware file append

**Phase:** Post-24 | **Status:** Implemented

`appendWithFrontmatter()` must atomically create a file with frontmatter on first write, and append without frontmatter on subsequent writes. Uses `O_EXCL` to prevent TOCTOU race conditions. Concurrent appends must not duplicate frontmatter.

**Standard tests:**
- `file-frontmatter.test.ts` > appendWithFrontmatter > creates new file with frontmatter + content
- `file-frontmatter.test.ts` > appendWithFrontmatter > appends without frontmatter to existing file
- `file-frontmatter.test.ts` > appendWithFrontmatter > creates parent directories if needed
- `file-frontmatter.test.ts` > appendWithFrontmatter > handles multiple sequential appends correctly

**Edge case tests:**
- `file-frontmatter.test.ts` > appendWithFrontmatter > works with empty frontmatter string
- `file-frontmatter.test.ts` > appendWithFrontmatter > propagates errors other than EEXIST
- Concurrency
  - `file-frontmatter.test.ts` > appendWithFrontmatter > concurrent appends do not duplicate frontmatter

### REQ-FMATTER-003: Migration script

**Phase:** Post-24 | **Status:** Implemented

The migration script must add frontmatter to existing markdown files in `data/`, skip files that already have frontmatter, skip non-note files (`llm-usage.md`), report unrecognized files, and support dry-run mode. Must correctly identify file types from path patterns.

**Standard tests:**
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies daily-diff files
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies report history files
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies alert history files
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies model journal files
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies daily notes files
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies echo log files
- `migrate-frontmatter.test.ts` > inferFrontmatter > identifies model journal archive files
- `migrate-frontmatter.test.ts` > migrate > adds frontmatter to files without it
- `migrate-frontmatter.test.ts` > migrate > handles multiple file types in one run

**Edge case tests:**
- `migrate-frontmatter.test.ts` > inferFrontmatter > returns null for unrecognized paths
- `migrate-frontmatter.test.ts` > inferFrontmatter > handles space-scoped daily notes
- `migrate-frontmatter.test.ts` > migrate > skips files that already have frontmatter
- `migrate-frontmatter.test.ts` > migrate > skips llm-usage.md
- `migrate-frontmatter.test.ts` > migrate > reports unrecognized files
- `migrate-frontmatter.test.ts` > migrate > dry run does not modify files
- `migrate-frontmatter.test.ts` > migrate > handles empty data directory

---

## File Index Service

### REQ-FILEINDEX-001: FileIndexService startup indexing and live refresh

**Phase:** D2a | **Status:** Implemented

FileIndexService scans `users/` and `spaces/` directories at startup, indexes `.md`/`.yaml`/`.yml` files within registered app manifest scopes, excludes archived files, and maintains a live index via `data:changed` event subscription. Apps with empty scope lists have zero files indexed. Invalid event payloads and path traversal attempts are rejected. Payload `appId`, `userId`, `spaceId` are validated against the `SAFE_SEGMENT` pattern.

**Standard tests:**
- `file-index.test.ts` > rebuild > indexes user-scoped files within declared scopes
- `file-index.test.ts` > rebuild > indexes shared-scoped files
- `file-index.test.ts` > rebuild > indexes space-scoped files using shared scopes
- `file-index.test.ts` > handleDataChanged > re-indexes file on write event
- `file-index.test.ts` > handleDataChanged > removes entry on archive event
- `file-index.test.ts` > handleDataChanged > indexes space-scoped file from write event
- `file-index.test.ts` > handleDataChanged > reindexByPath updates an existing entry
- `file-index.test.ts` > rebuild consistency with archive > excludes archived files after rebuild
- `file-index.test.ts` > size property > returns total indexed count

**Edge case tests:**
- `file-index.test.ts` > rebuild > excludes archived files
- `file-index.test.ts` > rebuild > excludes files from unregistered apps
- `file-index.test.ts` > rebuild > excludes files outside declared manifest scopes
- `file-index.test.ts` > error handling > handleDataChanged skips null payload gracefully
- `file-index.test.ts` > error handling > handleDataChanged skips empty object payload gracefully
- `file-index.test.ts` > error handling > handleDataChanged skips payload with invalid operation
- Security
  - `file-index.test.ts` > security > handleDataChanged rejects path traversal in payload.path
  - `file-index.test.ts` > security > handleDataChanged rejects userId with path separators
  - `file-index.test.ts` > security > handleDataChanged rejects spaceId with path traversal
  - `file-index.test.ts` > security > handleDataChanged rejects appId with path separators
  - `file-index.test.ts` > security > handleDataChanged rejects Windows drive-like path
  - `file-index.test.ts` > security > handleDataChanged rejects empty path
  - `file-index.test.ts` > security > reindexByPath rejects path traversal
  - `file-index.test.ts` > security > reindexByPath rejects absolute path
  - `file-index.test.ts` > security > reindexByPath rejects empty string
- Concurrency
  - `file-index.test.ts` > concurrency > concurrent handleDataChanged calls on same file resolve without corruption
- Configuration
  - `file-index.test.ts` > configuration edge cases > empty appScopes map means zero files indexed
  - `file-index.test.ts` > configuration edge cases > registered app with empty scopes indexes zero files
  - `file-index.test.ts` > configuration edge cases > non-existent data directory results in zero entries

### REQ-FILEINDEX-002: FileIndexService query and filtering

**Phase:** D2a | **Status:** Implemented

`getEntries()` supports filtering by scope, appId, owner, type, tags, dateFrom, dateTo, and text (case-insensitive search on title + entityKeys + aliases). Date filtering uses range-overlap semantics where a file is included if its date range overlaps the query window. No filter returns all entries.

**Standard tests:**
- `file-index.test.ts` > getEntries filter > filters by type
- `file-index.test.ts` > getEntries filter > filters by owner
- `file-index.test.ts` > getEntries filter > filters by text search on title
- `file-index.test.ts` > getEntries filter > filters by text search on entityKeys
- `file-index.test.ts` > getEntries filter > no filter returns all entries

**Edge case tests:**
- `file-index.test.ts` > getEntries filter > date range filtering > dateFrom includes file when dateFrom is before latest date
- `file-index.test.ts` > getEntries filter > date range filtering > dateFrom excludes file when dateFrom is after latest date
- `file-index.test.ts` > getEntries filter > date range filtering > dateTo includes file when dateTo is after earliest date
- `file-index.test.ts` > getEntries filter > date range filtering > dateTo excludes file when dateTo is before earliest date

### REQ-FILEINDEX-003: FileIndexService graph edges

**Phase:** D2a | **Status:** Implemented

`getRelated()` returns frontmatter `related`/`source` relationships plus wiki-link edges extracted from file body content. Entity-key matching is deferred to D2b.

**Standard tests:**
- `file-index.test.ts` > getRelated > returns frontmatter relationships and wiki-link edges

### REQ-DATAQUERY-001: Scope-filtered file retrieval with content

**Category:** Data Access  **Phase:** D2b  **Status:** Implemented

`DataQueryService.query(question, userId)` queries `FileIndexService` for candidate files scoped to the requesting user (personal files and files in spaces the user belongs to). It calls a fast-tier LLM to select relevant file IDs from the candidates, validates the returned IDs against the pre-authorized candidate set (preventing LLM-injected IDs), reads file content, and returns a `DataQueryResult` with the selected files and their content.

### REQ-DATAQUERY-002: LLM file selection validated against pre-authorized candidate set

**Category:** Security  **Phase:** D2b  **Status:** Implemented

File IDs returned by the LLM file selection call are validated against the set of candidate IDs that were provided to the LLM. IDs not in the pre-authorized set are silently discarded. The fallback regex for prose responses uses `(?<![-.\d])\b\d+\b(?!\.\d)` to reject negative and float-adjacent numbers. This prevents the LLM from selecting files outside the user's authorized scope.

### REQ-DATAQUERY-003: Multi-household scope isolation

**Category:** Security  **Phase:** D2b  **Status:** Implemented

DataQueryService delegates scope filtering to FileIndexService, which applies the same scope rules as DataStore: personal files (`data/users/<userId>/`) are only accessible to that user; space files (`data/spaces/<spaceId>/`) are only accessible to members of that space. Shared files (`data/users/shared/`) are hidden when the user belongs to a space (space takes precedence).

### REQ-DATAQUERY-004: Path hardening via realpath containment

**Category:** Security  **Phase:** D2b  **Status:** Implemented

Before reading file content, `DataQueryService` resolves the full file path via `realpath()`, which follows all symlinks in the entire path chain including parent directories. The resolved path is verified to start with `realpath(dataDir)`. Files that escape the data directory (via symlinks, junctions, or path traversal) are silently skipped with a warning log. This supersedes the previous `resolve()+lstat()` approach which only checked the final path segment.

### REQ-FILEINDEX-004: Entry parsing and metadata extraction

**Phase:** D2a | **Status:** Implemented

`parsePathMeta()` derives appId, scope, and owner from data-root-relative paths for user, shared, and space path structures. `parseFileContent()` extracts title, type, tags, aliases, entity_keys, dates, relationships, wiki-links, and summary from YAML frontmatter and markdown body. `isArchived()` detects archive filenames by timestamp suffix pattern. Date validation rejects values with invalid month (00 or 13+) or invalid day (00) values.

**Standard tests:**
- `entry-parser.test.ts` > parsePathMeta > parses user-scoped path
- `entry-parser.test.ts` > parsePathMeta > parses shared-scoped path
- `entry-parser.test.ts` > parsePathMeta > parses space-scoped path
- `entry-parser.test.ts` > parseFileContent > extracts frontmatter fields
- `entry-parser.test.ts` > parseFileContent > extracts wiki-links from body
- `entry-parser.test.ts` > parseFileContent > extracts title from first heading when no frontmatter title
- `entry-parser.test.ts` > parseFileContent > extracts summary from first non-heading paragraph
- `entry-parser.test.ts` > parseFileContent > extracts path-like source as relationship
- `entry-parser.test.ts` > parseFileContent > extracts dates from frontmatter

**Edge case tests:**
- `entry-parser.test.ts` > parsePathMeta > returns unknown appId for unrecognized path structure
- `entry-parser.test.ts` > parseFileContent > ignores non-path source values (labels)
- `entry-parser.test.ts` > parseFileContent > handles file with no frontmatter
- `entry-parser.test.ts` > parseFileContent > handles empty file content
- `entry-parser.test.ts` > parseFileContent > handles file with only frontmatter and no body
- `entry-parser.test.ts` > parseFileContent > handles unclosed frontmatter block — parser returns empty meta
- `entry-parser.test.ts` > parseFileContent > handles entity_keys with special YAML characters
- `entry-parser.test.ts` > parseFileContent > rejects invalid month in date field (month 00)
- `entry-parser.test.ts` > parseFileContent > rejects invalid month in date field (month 13)
- `entry-parser.test.ts` > parseFileContent > rejects invalid day in date field (day 00)
- `entry-parser.test.ts` > isArchived > detects archived filename
- `entry-parser.test.ts` > isArchived > rejects normal filename
- `entry-parser.test.ts` > isArchived > rejects date-named files

### REQ-FMATTER-005: Food app frontmatter enrichment

**Phase:** D2a | **Status:** Implemented

All food app write sites include `type` and `app: food` in generated frontmatter. Recipe, receipt, price-list, meal-plan, grocery-list, and grocery-history stores additionally include `entity_keys` for index searchability. Both create and update writes are enriched. Recipe `entity_keys` are limited to the title plus first 5 ingredient names (6 total maximum) for reasonable index size.

**Standard tests:**
- `recipe-store.test.ts` > saveRecipe — D2a frontmatter enrichment > writes type: recipe in frontmatter
- `recipe-store.test.ts` > saveRecipe — D2a frontmatter enrichment > writes entity_keys containing lowercased title in frontmatter
- `recipe-store.test.ts` > saveRecipe — D2a frontmatter enrichment > writes entity_keys containing lowercased ingredient names in frontmatter
- `recipe-store.test.ts` > updateRecipe — D2a frontmatter enrichment > writes type: recipe in frontmatter after update
- `recipe-store.test.ts` > updateRecipe — D2a frontmatter enrichment > writes entity_keys with lowercased title after update
- `recipe-store.test.ts` > updateRecipe — D2a frontmatter enrichment > writes entity_keys with lowercased ingredient names after update
- `health-store.test.ts` > saveMonthlyHealth > includes type: health-metrics in frontmatter
- `health-store.test.ts` > saveMonthlyHealth > includes app: food in frontmatter
- `cultural-calendar.test.ts` > ensureCalendar > includes type: cultural-calendar in frontmatter when writing
- `cultural-calendar.test.ts` > ensureCalendar > writes frontmatter with app: food and pas/ tags
- `price-store.test.ts` > formatPriceFile frontmatter enrichment (D2a) > includes type: price-list in frontmatter
- `price-store.test.ts` > formatPriceFile frontmatter enrichment (D2a) > includes entity_keys with lowercased store name
- `price-store.test.ts` > formatPriceFile frontmatter enrichment (D2a) > includes entity_keys with slug
- `grocery-store.test.ts` > saveGroceryList frontmatter enrichment (D2a) > includes type: grocery-list in frontmatter
- `grocery-store.test.ts` > archivePurchased frontmatter enrichment (D2a) > includes type: grocery-history in archive frontmatter
- `meal-plan-store.test.ts` > savePlan > includes type: meal-plan in frontmatter
- `meal-plan-store.test.ts` > savePlan > includes entity_keys with the week identifier in frontmatter
- `meal-plan-store.test.ts` > archivePlan > includes type: meal-plan in frontmatter
- `meal-plan-store.test.ts` > archivePlan > includes entity_keys with the week identifier in archivePlan frontmatter
- `macro-tracker.test.ts` > saveMonthlyLog frontmatter enrichment (D2a) > includes type: nutrition-log in frontmatter
- `pantry-store.test.ts` > savePantry > includes type: pantry in frontmatter

**Edge case tests:**
- `recipe-store.test.ts` > saveRecipe — entity_keys ingredient cap > entity_keys limited to title plus first 5 ingredients (6 total max)

---

## Traceability Matrix

The matrix includes only implemented requirements. Planned requirements (REQ-REGISTRY-004, REQ-DATA-004, REQ-NFR-005, REQ-LLM-021) will be added when implemented. Std/Edge column sums slightly exceed the unique test count because some tests are cross-referenced across multiple requirements.

| Requirement | Test File(s) | Std | Edge | Status |
|-------------|-------------|-----|------|--------|
| REQ-MANIFEST-001 | validate-manifest.test.ts | 5 | 14 | Implemented |
| REQ-DATA-001 | scoped-store.test.ts | 8 | 6 | Implemented |
| REQ-DATA-002 | scoped-store.test.ts | 2 | 2 | Implemented |
| REQ-DATA-003 | change-log.test.ts | 6 | 2 | Implemented |
| REQ-LOG-001 | logger.test.ts | 4 | 3 | Implemented |
| REQ-EVENT-001 | event-bus.test.ts | 4 | 3 | Implemented |
| REQ-EVENT-002 | scoped-store.test.ts, data.test.ts | 5 | 9 | Implemented |
| REQ-SCHED-001 | cron-manager.test.ts | 4 | 2 | Implemented |
| REQ-SCHED-002 | oneoff-manager.test.ts | 4 | 7 | Implemented |
| REQ-SCHED-003 | task-runner.test.ts | 2 | 3 | Implemented |
| REQ-SCHED-004 | task-runner.test.ts | 1 | 1 | Implemented |
| REQ-SCHED-005 | job-failure-notifier.test.ts | 10 | 16 | Implemented |
| REQ-COND-001 | rule-parser.test.ts | 4 | 3 | Implemented |
| REQ-COND-002 | evaluator.test.ts | 7 | 3 | Implemented |
| REQ-COND-003 | cooldown-tracker.test.ts, evaluator.test.ts | 11 | 6 | Implemented |
| REQ-COND-004 | last-fired-writeback.test.ts | 2 | 3 | Implemented |
| REQ-COND-005 | evaluator.test.ts | 3 | 5 | Implemented |
| REQ-LLM-001 | classify.test.ts | 4 | 6 | Implemented |
| REQ-LLM-002 | extract-structured.test.ts | 6 | 3 | Implemented |
| REQ-LLM-003 | retry.test.ts | 3 | 5 | Implemented |
| REQ-LLM-004 | llm-service.test.ts | 5 | 9 | Implemented |
| REQ-LLM-005 | provider-registry.test.ts | 4 | 3 | Implemented |
| REQ-LLM-006 | base-provider.test.ts | 8 | 3 | Implemented |
| REQ-LLM-007 | provider-factory.test.ts | 4 | 6 | Implemented |
| REQ-LLM-008 | model-selector.test.ts | 5 | 5 | Implemented |
| REQ-LLM-009 | cost-tracker.test.ts | 8 | 11 | Implemented |
| REQ-LLM-010 | llm-guard.test.ts | 5 | 4 | Implemented |
| REQ-LLM-011 | llm-guard.test.ts | 6 | 2 | Implemented |
| REQ-LLM-012 | llm-guard.test.ts | 1 | 4 | Implemented |
| REQ-LLM-013 | llm-guard.test.ts | 0 | 1 | Implemented |
| REQ-LLM-014 | llm-guard.test.ts | 1 | 1 | Implemented |
| REQ-LLM-018 | model-catalog.test.ts | 5 | 4 | Implemented |
| REQ-LLM-019 | model-pricing.test.ts | 8 | 6 | Implemented |
| REQ-LLM-020 | anthropic-provider.test.ts | 9 | 6 | Implemented |
| REQ-CONFIG-001 | config.test.ts, pas-yaml-schema.test.ts | 15 | 18 | Implemented |
| REQ-CONFIG-002 | default-providers.test.ts | 5 | 3 | Implemented |
| REQ-CONFIG-003 | app-config-service.test.ts | 5 | 7 | Implemented |
| REQ-ROUTE-001 | command-parser.test.ts, router.test.ts | 9 | 7 | Implemented |
| REQ-ROUTE-002 | intent-classifier.test.ts, router.test.ts | 2 | 6 | Implemented |
| REQ-ROUTE-003 | photo-classifier.test.ts, router.test.ts | 3 | 5 | Implemented |
| REQ-ROUTE-004 | fallback.test.ts | 3 | 1 | Implemented |
| REQ-TG-001 | message-adapter.test.ts | 3 | 7 | Implemented |
| REQ-TG-002 | telegram-service.test.ts | 5 | 5 | Implemented |
| REQ-REGISTRY-001 | loader.test.ts, registry.test.ts | 5 | 8 | Implemented |
| REQ-REGISTRY-002 | manifest-cache.test.ts | 6 | 5 | Implemented |
| REQ-REGISTRY-003 | registry.test.ts | 1 | 3 | Implemented |
| REQ-USER-001 | user-manager.test.ts | 5 | 5 | Implemented |
| REQ-USER-002 | user-manager.test.ts, router.test.ts | 3 | 6 | Implemented |
| REQ-USER-003 | user-manager.test.ts | 1 | 5 | Implemented |
| REQ-USER-004 | user-guard.test.ts | 2 | 3 | Implemented |
| REQ-USER-005 | index.test.ts (invite) | 4 | 5 | Implemented |
| REQ-USER-006 | invite-command.test.ts, user-guard.test.ts, realistic-invite-journey.test.ts | 2 | 11 + 31 journey | Implemented |
| REQ-USER-007 | user-mutation-service.test.ts, config-writer.test.ts | 6 | 6 | Implemented |
| REQ-USER-008 | integration.test.ts (invite) | 3 | 3 | Implemented |
| REQ-RATELIMIT-001 | rate-limiter.test.ts | 8 | 8 | Implemented |
| REQ-TOGGLE-001 | app-toggle.test.ts | 7 | 3 | Implemented |
| REQ-CTX-001 | context-store.test.ts | 4 | 7 | Implemented |
| REQ-CTX-002 | context-store.test.ts | 13 | 6 | Implemented |
| REQ-DIFF-001 | collector.test.ts | 2 | 4 | Implemented |
| REQ-DIFF-002 | daily-diff.test.ts | 2 | 3 | Implemented |
| REQ-DIFF-003 | summarizer.test.ts | 1 | 9 | Implemented |
| REQ-AUDIO-001 | audio-service.test.ts | 3 | 2 | Implemented |
| REQ-AUDIO-002 | audio-service.test.ts | 2 | 3 | Implemented |
| REQ-SERVER-001 | health.test.ts | 1 | 2 | Implemented |
| REQ-SERVER-002 | webhook.test.ts | 2 | 3 | Implemented |
| REQ-GUI-001 | auth.test.ts | 4 | 2 | Implemented |
| REQ-GUI-002 | routes.test.ts | 10 | 3 | Implemented |
| REQ-GUI-004 | routes.test.ts | 2 | 3 | Implemented |
| REQ-GUI-005 | routes.test.ts | 3 | 4 | Implemented |
| REQ-GUI-006 | cron-describe.test.ts, cron-manager.test.ts, routes.test.ts | 13 | 10 | Implemented |
| REQ-UTIL-001 | date.test.ts | 3 | 3 | Implemented |
| REQ-UTIL-002 | file.test.ts | 4 | 2 | Implemented |
| REQ-UTIL-003 | yaml.test.ts | 5 | 3 | Implemented |
| REQ-UTIL-004 | frequency-picker.test.ts | 29 | 27 | Implemented |
| REQ-SEC-001 | scoped-store.test.ts, context-store.test.ts, paths.test.ts | 0 | 20 | Implemented |
| REQ-SEC-002 | webhook.test.ts | 1 | 2 | Implemented |
| REQ-SEC-003 | classify.test.ts, extract-structured.test.ts | 0 | 2 | Implemented |
| REQ-SEC-004 | router.test.ts | 0 | 1 | Implemented |
| REQ-SEC-005 | llm-guard.test.ts | 0 | 4 | Implemented |
| REQ-SEC-006 | csrf.test.ts | 6 | 8 | Implemented |
| REQ-SEC-007 | prompt-templates.test.ts | 10 | 6 | Implemented |
| REQ-SEC-008 | security-measures.test.ts | 6 | 3 | Implemented |
| REQ-SEC-009 | security-measures.test.ts | 5 | 2 | Implemented |
| REQ-SEC-010 | security-measures.test.ts | 4 | 6 | Implemented |
| REQ-SEC-011 | security-measures.test.ts | 5 | 10 | Implemented |
| REQ-SEC-012 | security-measures.test.ts | 1 | 0 | Implemented |
| REQ-NFR-001 | — | — | — | Implemented |
| REQ-NFR-002 | shutdown.test.ts | 8 | 6 | Implemented |
| REQ-NFR-003 | — | — | — | Implemented |
| REQ-NFR-004 | error-handler.test.ts | 5 | 4 | Implemented |
| REQ-INTEG-001 | e2e-echo.test.ts | 5 | 1 | Implemented |
| REQ-INTEG-002 | echo.test.ts | 5 | 1 | Implemented |
| REQ-LLM-022 | llm-usage.test.ts | 8 | 8 | Implemented |
| REQ-LLM-023 | system-llm-guard.test.ts | 6 | 8 | Implemented |
| REQ-LLM-024 | llm-usage.test.ts | 3 | 5 | Implemented |
| REQ-GUI-003 | llm-usage.test.ts | 4 | 5 | Implemented |
| REQ-LLM-016 | cost-tracker.test.ts | 1 | 1 | Implemented |
| REQ-LLM-017 | cost-tracker.test.ts, model-pricing.test.ts | 1 | 1 | Implemented |
| REQ-SERVER-003 | server.test.ts | 2 | 2 | Implemented |
| REQ-ROUTE-005 | router.test.ts, chatbot.test.ts | 7 | 14 | Implemented |
| REQ-ROUTE-006 | route-verifier.test.ts, router-verification.test.ts, prompt-templates.test.ts, pending-verification-store.test.ts, verification-logger.test.ts, config.test.ts | 22 | 24 | Implemented |
| REQ-CHATBOT-001 | conversation-history.test.ts | 5 | 11 | Implemented |
| REQ-CHATBOT-002 | chatbot.test.ts | 4 | 6 | Implemented |
| REQ-CHATBOT-003 | chatbot.test.ts | 1 | 1 | Implemented |
| REQ-CHATBOT-004 | chatbot.test.ts | 4 | 7 | Implemented |
| REQ-CHATBOT-005 | chatbot.test.ts | 3 | 2 | Implemented |
| REQ-CHATBOT-006 | chatbot.test.ts | 5 | 3 | Implemented |
| REQ-CHATBOT-007 | chatbot.test.ts | 5 | 0 | Implemented |
| REQ-APPMETA-001 | app-metadata.test.ts | 8 | 9 | Implemented |
| REQ-APPKNOW-001 | app-knowledge.test.ts | 9 | 9 | Implemented |
| REQ-CONFIG-004 | config.test.ts | 2 | 2 | Implemented |
| REQ-INSTALL-001 | static-analyzer.test.ts | 5 | 16 | Implemented |
| REQ-INSTALL-002 | compatibility-checker.test.ts | 5 | 9 | Implemented |
| REQ-INSTALL-003 | installer.test.ts | 4 | 17 | Implemented |
| REQ-INSTALL-004 | install-app.test.ts | 3 | 9 | Implemented |
| REQ-INSTALL-005 | uninstall-app.test.ts | 3 | 7 | Implemented |
| REQ-INSTALL-006 | validate-manifest.test.ts | 1 | 7 | Implemented |
| REQ-INSTALL-007 | uninstall-app.test.ts | 4 | 6 | Implemented |
| REQ-INSTALL-008 | installer.test.ts | 0 | 2 | Implemented |
| REQ-SCAFFOLD-001 | scaffold-app.test.ts | 11 | 10 | Implemented |
| REQ-EXAMPLE-001 | notes.test.ts | 7 | 7 | Implemented |
| REQ-DOC-001 | — | — | — | Implemented |
| REQ-DOC-002 | — | — | — | Implemented |
| REQ-ERROR-001 | llm-errors.test.ts | 9 | 5 | Implemented |
| REQ-TIMEZONE-001 | notes.test.ts, chatbot.test.ts | 1 | 0 | Implemented |
| REQ-GUI-006 | data.test.ts | 16 | 6 | Implemented |
| REQ-GUI-007 | context-routes.test.ts | 8 | 10 | Implemented |
| REQ-JOURNAL-001 | model-journal.test.ts | 18 | 26 | Implemented |
| REQ-JOURNAL-002 | chatbot.test.ts | 9 | 16 | Implemented |
| REQ-JOURNAL-003 | data.test.ts | 6 | 13 | Implemented |
| REQ-SYSINFO-001 | system-info.test.ts | 12 | 11 | Implemented |
| REQ-CHATBOT-008 | chatbot.test.ts | 10 | 12 | Implemented |
| REQ-CHATBOT-009 | chatbot.test.ts | 2 | 4 | Implemented |
| REQ-CHATBOT-010 | chatbot.test.ts | 4 | 0 | Implemented |
| REQ-SECRETS-001 | secrets.test.ts | 3 | 5 | Implemented |
| REQ-REPORT-001 | report-validator.test.ts | 8 | 33 | Implemented |
| REQ-REPORT-002 | section-collector.test.ts | 10 | 12 | Implemented |
| REQ-REPORT-003 | report-formatter.test.ts | 7 | 4 | Implemented |
| REQ-REPORT-004 | report-service.test.ts, report-load-validation.test.ts | 10 | 24 | Implemented |
| REQ-REPORT-005 | report-service.test.ts, cron-manager.test.ts | 5 | 6 | Implemented |
| REQ-REPORT-006 | reports.test.ts, report-space-id.test.ts | 17 | 17 | Implemented |
| REQ-ALERT-001 | alert-validator.test.ts | 19 | 30 | Implemented |
| REQ-ALERT-002 | alert-executor.test.ts | 4 | 7 | Implemented |
| REQ-ALERT-003 | alert-service.test.ts, alert-load-validation.test.ts | 14 | 25 | Implemented |
| REQ-ALERT-004 | alert-service.test.ts | 5 | 0 | Implemented |
| REQ-ALERT-005 | alert-service.test.ts, alert-validator.test.ts | 10 | 9 | Implemented |
| REQ-ALERT-006 | alert-executor-enhanced.test.ts | 20 | 20 | Implemented |
| REQ-ALERT-007 | alert-validator-actions.test.ts | 15 | 19 | Implemented |
| REQ-ALERT-GUI-001 | alerts.test.ts, alert-space-id.test.ts | 14 | 17 | Implemented |
| REQ-SPACE-001 | spaces.test.ts | 11 | 16 | Implemented |
| REQ-SPACE-002 | spaces.test.ts | 9 | 6 | Implemented |
| REQ-SPACE-003 | spaces.test.ts | 5 | 6 | Implemented |
| REQ-SPACE-004 | router-spaces.test.ts | 17 | 8 | Implemented |
| REQ-SPACE-005 | router-spaces.test.ts | 2 | 3 | Implemented |
| REQ-SPACE-006 | spaces.test.ts | 0 | 1 | Implemented |
| REQ-SPACE-007 | spaces.test.ts | 0 | 3 | Implemented |
| REQ-SPACE-008 | alert-validator-spaces.test.ts, report-validator-spaces.test.ts | 2 | 4 | Implemented |
| REQ-SPACE-009 | alert-validator-spaces.test.ts, report-validator-spaces.test.ts | 4 | 2 | Implemented |
| REQ-SPACE-010 | spaces.test.ts | 0 | 1 | Implemented |
| REQ-SPACE-011 | spaces.test.ts | 0 | 2 | Implemented |
| REQ-SPACE-012 | spaces-gui.test.ts | 9 | 6 | Implemented |
| REQ-SPACE-013 | scoped-store.test.ts | 10 | 10 | Implemented |
| REQ-SPACE-014 | change-log.test.ts | 1 | 0 | Implemented |
| REQ-SPACE-015 | data.test.ts | 2 | 3 | Implemented |
| REQ-SPACE-016 | spaces.test.ts | 0 | 1 | Implemented |
| REQ-SPACE-017 | spaces.test.ts | 0 | 1 | Implemented |
| REQ-API-001 | auth.test.ts | 1 | 6 | Implemented |
| REQ-API-002 | data.test.ts | 4 | 15 | Implemented |
| REQ-API-003 | messages.test.ts | 2 | 9 | Implemented |
| REQ-API-004 | data-read.test.ts | 4 | 15 | Implemented |
| REQ-API-005 | schedules.test.ts | 4 | 4 | Implemented |
| REQ-API-006 | webhooks.test.ts | 4 | 12 | Implemented |
| REQ-API-007 | reports-api.test.ts | 8 | 16 | Implemented |
| REQ-API-008 | alerts-api.test.ts | 6 | 10 | Implemented |
| REQ-API-009 | changes.test.ts | 4 | 6 | Implemented |
| REQ-API-010 | llm.test.ts | 4 | 10 | Implemented |
| REQ-API-011 | telegram.test.ts | 2 | 7 | Implemented |
| REQ-API-012 | n8n-dispatcher.test.ts | 5 | 6 | Implemented |
| REQ-API-013 | n8n-dispatch-integration.test.ts | 5 | 2 | Implemented |
| REQ-FMATTER-001 | frontmatter.test.ts | 9 | 23 | Implemented |
| REQ-FMATTER-002 | file-frontmatter.test.ts | 4 | 3 | Implemented |
| REQ-FMATTER-003 | migrate-frontmatter.test.ts | 9 | 7 | Implemented |

| REQ-FMATTER-004 | frontmatter.test.ts | 11 | 15 | Implemented |
| REQ-CHATBOT-011 | chatbot.test.ts | 4 | 3 | Implemented |
| REQ-CHATBOT-012 | pas-classifier.test.ts, chatbot.test.ts | 7 | 5 | Implemented |
| REQ-CHATBOT-013 | user-context.test.ts, chatbot.test.ts | 7 | 2 | Implemented |
| REQ-CHATBOT-014 | message-splitter.test.ts | 6 | 2 | Implemented |
| REQ-CHATBOT-015 | chatbot.test.ts | 1 | 0 | Implemented |

| REQ-VAULT-001 | vault.test.ts | 8 | 11 | Implemented |
| REQ-VAULT-002 | vault.test.ts | 3 | 3 | Implemented |
| REQ-VAULT-003 | vault.test.ts | 0 | 4 | Implemented |
| REQ-VAULT-004 | vault.test.ts | 3 | 1 | Implemented |

| REQ-FILEINDEX-001 | file-index.test.ts | 9 | 19 | Implemented |
| REQ-FILEINDEX-002 | file-index.test.ts | 5 | 4 | Implemented |
| REQ-FILEINDEX-003 | file-index.test.ts | 1 | 0 | Implemented |
| REQ-FILEINDEX-004 | entry-parser.test.ts | 9 | 13 | Implemented |
| REQ-FMATTER-005 | recipe-store.test.ts, health-store.test.ts, cultural-calendar.test.ts, price-store.test.ts, grocery-store.test.ts, meal-plan-store.test.ts, macro-tracker.test.ts, pantry-store.test.ts | 21 | 1 | Implemented |
| REQ-DATAQUERY-001 | data-query.test.ts, data-query-wiring.test.ts | 12 | 8 | Implemented |
| REQ-DATAQUERY-002 | data-query.test.ts | 6 | 4 | Implemented |
| REQ-DATAQUERY-003 | data-query.test.ts | 3 | 2 | Implemented |
| REQ-DATAQUERY-004 | data-query.test.ts | 3 | 2 | Implemented |
| REQ-CHATBOT-016 | data-query-wiring.test.ts | 8 | 6 | Implemented |
| REQ-CHATBOT-017 | data-query-wiring.test.ts | 3 | 3 | Implemented |

Note: Phase 26 requirements (REQ-API-007 through REQ-API-013) cover the n8n dispatch pattern endpoints and services. Full requirement descriptions deferred to next URS update session.
| **Totals** | **143 test files** | **1023** | **1245** | **2268 tests** |
