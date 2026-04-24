# Stage 4 Test Review Findings

Date: 2026-04-23
Stage: 4 - Core Automation, Reporting, and Operational Services
Status: Completed

## Scope

This stage reviewed the automation, reporting, scheduling, operational, and observability services under:

- `core/src/services/alerts`
- `core/src/services/reports`
- `core/src/services/scheduler`
- `core/src/services/condition-evaluator`
- `core/src/services/event-bus`
- `core/src/services/backup`
- `core/src/services/n8n`
- `core/src/services/metrics`
- `core/src/services/system-info`
- `core/src/services/webhooks`
- `core/src/services/logger`

The review goal was to judge whether the tests protect real runtime behavior around scheduling, asynchronous dispatch, operational failure handling, alert/report correctness, and operator recovery paths.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/DEPLOYMENT.md`
- `docs/OPERATIONS.md`
- `docs/codebase-review-findings.md`
- `docs/open-items.md`
- `docs/superpowers/specs/2026-04-11-f9-telegram-markdown-escaping-design.md`
- `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md`
- `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`
- `docs/superpowers/plans/2026-04-21-d5c-chunk-d-review.md`

Key URS areas for this stage:

- `REQ-LOG-001`
- `REQ-EVENT-001`
- `REQ-SCHED-001`, `REQ-SCHED-002`, `REQ-SCHED-003`, `REQ-SCHED-004`, `REQ-SCHED-005`, `REQ-SCHED-006`, `REQ-SCHED-007`
- `REQ-COND-001`, `REQ-COND-002`, `REQ-COND-003`, `REQ-COND-004`, `REQ-COND-005`
- `REQ-REPORT-001`, `REQ-REPORT-002`, `REQ-REPORT-003`, `REQ-REPORT-004`, `REQ-REPORT-005`, `REQ-REPORT-006`
- `REQ-ALERT-001`, `REQ-ALERT-002`, `REQ-ALERT-003`, `REQ-ALERT-004`, `REQ-ALERT-005`, `REQ-ALERT-006`, `REQ-ALERT-007`
- `REQ-API-006`, `REQ-API-012`, `REQ-API-013`
- `REQ-SYSINFO-001`
- `REQ-LLM-028`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 4 coverage today is:

- `core/src/services/alerts/__tests__/alert-executor-enhanced.test.ts`
  This is the best direct coverage for alert templating, LLM-summary hardening, write-data routing, and the newer action types.
- `core/src/services/alerts/__tests__/alert-service.test.ts`, `alert-spaces.test.ts`, and `core/src/services/reports/__tests__/report-household.test.ts`
  These are the most trustworthy runtime suites for household/space boundaries and trigger lifecycle behavior.
- `core/src/services/reports/__tests__/section-collector.test.ts` and `section-collector-spaces.test.ts`
  Good direct protection for path hardening, token expansion, household filtering, and space-aware resolution.
- `core/src/services/scheduler/__tests__/oneoff-manager.test.ts`
  This is the most complete scheduler suite for serialized writes, stop behavior, resolver failures, and notifier integration.
- `core/src/services/scheduler/__tests__/job-failure-notifier.test.ts`
  Strong isolated coverage for rate limiting, auto-disable thresholds, and re-enable semantics inside the notifier itself.
- `core/src/services/metrics/__tests__/message-rate-tracker.test.ts` plus `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts`
  Good combined evidence for the in-memory window logic and the production router/shutdown wiring.
- `core/src/services/backup/__tests__/backup.test.ts`
  Good low-level coverage for tarball creation, retention cleanup, and Windows no-op behavior.
- `core/src/services/webhooks/__tests__/webhooks.test.ts`
  Still valuable for payload shaping, HMAC signing, timeout handling, and per-URL rate limiting, with one caveat noted below.

## Findings

These findings describe the gaps as originally observed during the review pass. See the remediation update below for the current repo state.

### 1. Auto-disabled job behavior is only tested in-memory; the operator recovery path is still unprotected

- Severity: high
- Type: runtime/ops coverage gap plus URS mismatch
- Code references:
  - `core/src/services/scheduler/job-failure-notifier.ts:49-52`
  - `core/src/services/scheduler/job-failure-notifier.ts:141-159`
  - `core/src/services/scheduler/cron-manager.ts:98-100`
  - `core/src/services/scheduler/oneoff-manager.ts:234-240`
  - `core/src/compose-runtime.ts:775-780`
  - `core/src/gui/routes/scheduler.ts:49-75`
  - `core/src/api/routes/schedules.ts:34-48`
- Test references:
  - `core/src/services/scheduler/__tests__/job-failure-notifier.test.ts:185-272`

`JobFailureNotifier` correctly tracks disabled jobs and exposes `getDisabledJobs()` and `reEnable()`, and both cron and one-off execution paths consult `isDisabled()` before running work. But that disabled state only lives in the notifier's in-memory `Map`/`Set`, and the runtime keeps the notifier as a private bootstrap object. The scheduler GUI and schedules API only render cron metadata plus next/last run times; they do not expose disabled state or a re-enable action.

A repo-wide search of `core/src` shows `getDisabledJobs()` and `reEnable()` are only used in the notifier implementation and its unit tests. That means the Stage 4 tests currently prove the isolated helper works, but they do not protect the URS-promised operator workflow that "disabled jobs can be re-enabled via management GUI." They also do not pin what should happen across process restarts, where the current in-memory disabled state is lost entirely.

### 2. n8n coverage stops before the live trigger-and-fallback path

- Severity: medium
- Type: asynchronous runtime coverage gap
- Code references:
  - `core/src/services/reports/index.ts:491-504`
  - `core/src/services/alerts/index.ts:749-762`
  - `core/src/bootstrap.ts:71-79`
- Test references:
  - `core/src/services/n8n/__tests__/n8n-dispatcher.test.ts:62-130`
  - `core/src/services/n8n/__tests__/n8n-dispatch-integration.test.ts:6-7`
  - `core/src/services/n8n/__tests__/n8n-dispatch-integration.test.ts:66-164`
  - `core/src/services/n8n/__tests__/n8n-dispatch-integration.test.ts:168-288`

The current n8n tests do a good job validating HTTP delivery at the dispatcher boundary, and the integration suite confirms that `ReportService` and `AlertService` accept an injected dispatcher and still register cron jobs. But the integration file explicitly says direct cron-handler testing is not covered, and that gap matters here: nothing in Stage 4 actually drives a report cron callback, a scheduled alert callback, an event-triggered alert callback, or the bootstrap daily-diff path through the "dispatch first, fall back locally on failure" logic.

As a result, a regression that bypasses `dispatch()`, removes the fallback, or breaks only one trigger site would still leave the current n8n tests green. This stage needs at least one integration-style test per live trigger family, even if that means exposing a narrow callback seam or testing via the registered scheduler handler instead of the current constructor-only checks.

### 3. AlertService failure semantics after executor errors are still unpinned at the service level

- Severity: medium
- Type: alert correctness gap under real delivery failures
- Code references:
  - `core/src/services/alerts/index.ts:362-397`
  - `core/src/types/alert.ts:185-194`
- Test references:
  - `core/src/services/alerts/__tests__/alert-executor.test.ts:120-157`
  - `core/src/services/alerts/__tests__/alert-service.test.ts:325-521`
  - `core/src/services/alerts/__tests__/alert-service.test.ts:571-611`

The executor suite already proves that individual action failures are isolated and that a `telegram_message` action can fail for every delivery user. But the service-level suite never exercises what happens after that result bubbles back into `AlertService.evaluate()`. Today the service updates `lastFired`, saves history, emits `alert:fired`, and returns `actionTriggered: true` after `executeActions()` as long as the condition passed and the alert was not in cooldown, even if `successCount` is zero.

That may be the intended contract, or it may not be. The problem is that the current tests never force the service through a zero-success or mixed-success execution path and assert the resulting cooldown/history/event behavior. For a system whose primary purpose is alert delivery, that leaves one of the most operationally important decisions effectively undocumented and unguarded.

### 4. Cron last-run persistence that drives the scheduler UI and API is effectively untested

- Severity: medium
- Type: operational persistence coverage gap
- Code references:
  - `core/src/services/scheduler/cron-manager.ts:36-72`
  - `core/src/services/scheduler/cron-manager.ts:108-109`
  - `core/src/services/scheduler/cron-manager.ts:212-217`
  - `core/src/gui/routes/scheduler.ts:33-64`
  - `core/src/api/routes/schedules.ts:34-47`
- Test references:
  - `core/src/services/scheduler/__tests__/cron-manager.test.ts:63-71`
  - `core/src/services/scheduler/__tests__/cron-manager.test.ts:96-103`

`CronManager` persists `lastRunAt` to `data/system/cron-last-run.json`, reloads it on construction, and both the scheduler GUI and `/api/schedules` depend on `getJobDetails()` for their displayed "Last Run" values. But the Stage 4 tests only assert the in-memory null case before a run and that unregister clears the in-memory entry. They never drive a successful execution, verify the JSON file is written, construct a fresh manager, or check malformed persisted data behavior.

That leaves a real operational blind spot. The current persistence helper also never creates `data/system` before `writeFileSync()`, so a fresh-instance regression can be silently swallowed by the logger and still pass the current suite. If "Last Run" is part of the scheduler/admin contract, it needs restart-level tests rather than just in-process map assertions.

## Transitional Or Lower-Trust Coverage To Treat Carefully

This section captures the lower-trust areas as originally observed during review; several of these suites were tightened in the remediation update below.

- `core/src/services/n8n/__tests__/n8n-dispatch-integration.test.ts` is useful as a smoke check, but it is intentionally configuration-level rather than runtime-dispatch-level coverage.
- `core/src/services/scheduler/__tests__/job-failure-notifier.test.ts` is detailed and worth keeping, but it is stronger evidence for the helper object than for the actual operator-facing scheduler lifecycle.
- `core/src/services/webhooks/__tests__/webhooks.test.ts:300-314` is a misleadingly named lifecycle test. It is titled "double init does not duplicate subscriptions" while explicitly asserting that `EventBus.on()` is called twice and documenting the leaked first handler as acceptable. That makes it a poor guard against duplicate delivery or cleanup regressions.
- `core/src/services/scheduler/__tests__/cron-manager.test.ts` covers in-process execution and notifier callbacks well, but not persistence, restart, or first-run filesystem behavior.

## Follow-Up Tasks Opened By Stage 4

All Stage 4 follow-up tasks opened during review are complete as of the 2026-04-23 remediation update:

- Completed: disabled-job state is now persisted, surfaced through the scheduler GUI and schedules API, and recoverable through tested re-enable flows.
- Completed: live-trigger n8n regression coverage now exercises report cron runs, scheduled alerts, event-triggered alerts, and the bootstrap daily-diff dispatch/fallback path.
- Completed: `AlertService.evaluate()` failure-path tests now pin all-failure and mixed-success behavior, including cooldown/history/event effects.
- Completed: `cron-last-run.json` persistence is now covered for missing directories, malformed data, and restart reloads.
- Completed: webhook double-init behavior is now idempotent and tested as such.

## Remediation Update

Update applied: 2026-04-23

- `core/src/services/scheduler/cron-manager.ts` now creates `data/system/` before persisting `cron-last-run.json`, so first-run scheduler surfaces no longer depend on bootstrap pre-creating the directory.
- `core/src/services/scheduler/__tests__/cron-manager.test.ts` now covers successful `lastRunAt` persistence and reload, first-run directory creation, and malformed persisted JSON startup behavior.
- `core/src/services/alerts/__tests__/alert-service.test.ts` now pins the service-level contract when action execution fails: all-action-failure evaluations still update `lastFired`, save history, emit `alert:fired`, and enter cooldown, and mixed delivery failures still count as a fired alert once any delivery succeeds.
- `core/src/services/webhooks/index.ts` now makes `init()` idempotent instead of silently layering duplicate EventBus subscriptions on repeated initialization.
- `core/src/services/webhooks/__tests__/webhooks.test.ts` now asserts the real idempotent behavior rather than normalizing the duplicate-subscription leak behind a misleading test title.
- `core/src/services/scheduler/job-failure-notifier.ts`, `cron-manager.ts`, `oneoff-manager.ts`, `gui/routes/scheduler.ts`, and `api/routes/schedules.ts` now persist disabled-job state, surface disabled/failure counts in operator views, and provide tested GUI/API re-enable flows.
- `core/src/services/n8n/__tests__/n8n-dispatch-integration.test.ts` now drives the live trigger/fallback paths for report cron runs, scheduled alert cron runs, event-triggered alerts, and the bootstrap `daily-diff` callback, proving both dispatch-first and local-fallback behavior.

## Stage 4 Exit Decision

Stage 4 is complete.

The best coverage in this stage is around report/alert validation, section collection, one-off scheduling mechanics, message-rate tracking, and the low-level backup/webhook helpers. The main weaknesses identified in the review were the operator-facing and cross-service runtime paths: disabled-job recovery, live n8n dispatch/fallback behavior, alert execution semantics under real action failure, and persisted last-run state for scheduling surfaces.

As of the 2026-04-23 remediation update, the Stage 4 runtime/test gaps around cron last-run persistence, alert failure semantics, webhook init idempotency, disabled-job operator recovery, and the full report/alert/daily-diff n8n live trigger paths have all been addressed.
