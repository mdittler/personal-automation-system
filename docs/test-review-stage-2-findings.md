# Stage 2 Test Review Findings

Date: 2026-04-23
Stage: 2 - Core Trust Boundaries and Runtime Entry Points
Status: Completed

## Scope

This stage reviewed the runtime-facing trust boundaries and top-level entry points under:

- `core/src/api`
- `core/src/gui`
- `core/src/server`
- `core/src/middleware`
- `core/src/__tests__`

The review goal was to judge whether the tests protect auth, household isolation, route protection, request lifecycle behavior, and top-level runtime wiring in ways that match current software behavior.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/codebase-review-findings.md`
- `docs/superpowers/specs/2026-04-08-route-verification-design.md`
- `docs/superpowers/plans/2026-04-11-phase-r1-access-control.md`
- `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`

Key URS areas for this stage:

- `REQ-USER-002`, `REQ-USER-004`
- `REQ-GUI-001`, `REQ-GUI-002`
- `REQ-SERVER-001`, `REQ-SERVER-002`, `REQ-SERVER-003`
- `REQ-API-001` through `REQ-API-006`
- `REQ-SEC-002`, `REQ-SEC-004`, `REQ-SEC-006`, `REQ-SEC-008`, `REQ-SEC-010`, `REQ-SEC-011`
- `REQ-LLM-022`, `REQ-LLM-023`
- `REQ-SPACE-008`, `REQ-SPACE-009`, `REQ-SPACE-012`, `REQ-SPACE-015`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 2 coverage today is:

- `core/src/gui/__tests__/auth-d5b3.test.ts`
  This is the best current coverage for password login, session invalidation, household ALS propagation, and the modern GUI auth contract.
- `core/src/gui/__tests__/d5b5-auth.test.ts`
  This is the most useful GUI trust-boundary suite for actor-based route filtering across data browsing, reports, alerts, and spaces.
- `core/src/gui/__tests__/csrf.test.ts`
  Good direct coverage of the double-submit cookie protection and secure-cookie behavior.
- `core/src/api/__tests__/d5b7-route-enforcement.test.ts`
  Good central coverage for per-user API key restrictions, admin gates, and data/report/schedule/LLM route authorization shape.
- `core/src/api/__tests__/data-read.test.ts`
  Good route-level coverage for path validation, membership checks, file size limits, and household-aware path resolution.
- `core/src/server/__tests__/webhook.test.ts`
  Good minimal coverage for webhook-secret enforcement and callback error handling.
- `core/src/middleware/__tests__/shutdown.test.ts`
  Strong request-drain and teardown ordering coverage.
- `core/src/__tests__/compose-runtime.smoke.integration.test.ts`
  Useful smoke coverage for the real composition root and disposal path.

These are the tests that look most worth preserving and extending in later phases.

## Findings

These findings describe the gaps as originally observed during the review pass. See the remediation update below for the current repo state.

### 1. GUI data-route authorization is inconsistent, and the tests only cover the protected endpoint

- Severity: high
- Type: security gap plus missing regression coverage
- Code references:
  - `core/src/gui/routes/data.ts:212-297`
  - `core/src/gui/routes/data.ts:303-337`
  - `core/src/gui/routes/data.ts:433-626`
- Test references:
  - `core/src/gui/__tests__/d5b5-auth.test.ts:166-232`
  - `core/src/gui/__tests__/data.test.ts`
  - `core/src/gui/__tests__/data-household.test.ts`

`/gui/data/browse` has explicit actor-based authorization for non-admin users, but the sibling routes `/gui/data`, `/gui/data/view`, and `/gui/data/files` do not apply the same guard. The top-level `/gui/data` page enumerates user sections, shared/system entries, household sections, and vault paths. `/gui/data/view` and `/gui/data/files` resolve and return data without the actor checks present in `/gui/data/browse`.

The current trust-boundary tests only verify non-admin restrictions on `/gui/data/browse`. There is no comparable non-admin regression coverage for `/gui/data`, `/gui/data/view`, or `/gui/data/files`. As written, a non-admin authenticated GUI user can likely bypass the intended browse restrictions by hitting the other data endpoints directly.

This is the highest-signal Stage 2 issue because it is a real runtime entry-point permission gap, not just a test-quality complaint.

### 2. `/api/changes` household filtering still lacks a real route-level regression test

- Severity: medium
- Type: coverage gap
- Code reference:
  - `core/src/api/routes/changes.ts:57-72`
- Test references:
  - `core/src/api/__tests__/d5b7-route-enforcement.test.ts:574-591`
  - `core/src/__tests__/multi-household-isolation.integration.test.ts:486-511`

The route correctly applies a request-context household filter, but the current tests do not actually prove that behavior through the route output:

- `d5b7-route-enforcement.test.ts` only verifies that a valid key gets a `200` and explicitly notes that the important thing is just getting past the auth gate.
- `multi-household-isolation.integration.test.ts` reimplements the filtering logic with an in-test `entries.filter(...)` instead of seeding a change log and calling `/api/changes`.

That means the suite would miss regressions in request-context propagation, route-to-filter wiring, or response serialization as long as the route still returns `200`.

### 3. Some Stage 2 “wiring” coverage is still structural or overly loose rather than behavioral

- Severity: medium
- Type: weak assertion / brittle test strategy
- Test references:
  - `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts:10-19`
  - `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts:125-190`
  - `core/src/gui/__tests__/llm-usage-ops-persona.test.ts:264-272`

Two patterns in this stage are weaker than the roadmap’s goal of proving real runtime behavior:

- `message-rate-tracker-wiring.integration.test.ts` explicitly relies on source scans for API message dispatch, alert dispatch, and shutdown registration rather than exercising the running composition root. That gives some structural protection, but it is still weaker than a real behavioral integration.
- `llm-usage-ops-persona.test.ts` checks Nina’s non-admin denial with `expect(res.statusCode).not.toBe(200)`. That would still pass on an unexpected redirect or unrelated error status instead of confirming the intended failure mode.

These are not necessarily broken today, but they are weaker trust-boundary evidence than the stronger route-level suites in this stage.

## Obsolete Or Superseded Coverage To Treat Carefully

- `core/src/gui/__tests__/auth.test.ts`
  This is still useful as a legacy token-mode smoke test, but it is no longer the primary source of truth for the current per-user GUI auth contract. That role belongs to `auth-d5b3.test.ts`.
- `core/src/gui/__tests__/data.test.ts`
  This suite still logs in with the legacy token flow and seeds the legacy `data/users/...` layout. It remains useful for rendering and XSS smoke coverage, but it should not be treated as primary evidence for current household-isolated data-browser behavior.
- `core/src/gui/routes/__tests__/spaces.test.ts`
  This is good CRUD and HTMX coverage, but it runs in legacy auth mode and is not the main trust-boundary suite for current actor filtering. `d5b5-auth.test.ts` is more authoritative for that purpose.

These tests are not worthless, but later stages should avoid treating them as the main proof that the current runtime entry contracts are safe.

## Follow-Up Tasks Opened By Stage 2

All Stage 2 follow-up tasks opened during review are complete as of the 2026-04-23 remediation update:

- Completed: actor-based authorization now protects `/gui/data`, `/gui/data/view`, and `/gui/data/files`, with explicit non-admin regression coverage.
- Completed: `/api/changes` now has a real route-level regression with seeded mixed-household entries and request-context-backed filtering assertions.
- Completed: the former source-scan-only `message-rate-tracker-wiring.integration.test.ts` proof has been replaced with executable composition-root coverage.
- Completed: loose denial assertions now verify the intended failure mode directly.

## Remediation Update

Update applied: 2026-04-23

- `core/src/gui/routes/data.ts` now enforces actor-based authorization on the previously inconsistent `/gui/data`, `/gui/data/view`, and `/gui/data/files` endpoints. The full `/gui/data` overview is now platform-admin-only, and the sibling partial routes reuse the same scope checks as `/gui/data/browse`.
- `core/src/gui/__tests__/d5b5-auth.test.ts` now includes explicit non-admin regression coverage for `/gui/data`, `/gui/data/view`, and `/gui/data/files`, alongside the existing `/gui/data/browse` checks.
- `core/src/api/__tests__/d5b7-route-enforcement.test.ts` now seeds a real change log file and proves `/api/changes` returns only same-household rows plus global rows for the authenticated caller.
- `core/src/gui/__tests__/llm-usage-ops-persona.test.ts` now asserts the intended non-admin failure mode directly (`403`) instead of the weaker “not 200” check.
- `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts` now uses the composed runtime to prove the production router records the active household and that teardown disposes the tracker through the real shutdown path. The API and alert dispatch entry points are already covered behaviorally by `messages.test.ts` and `alert-executor-enhanced.test.ts`.

## Stage 2 Exit Decision

Stage 2 is complete.

The strongest runtime-entry coverage is in the newer D5b-era GUI/API suites plus CSRF, shutdown, webhook, and data-read tests. The main problems identified in this stage were not a lack of test volume, but one important GUI data boundary that was inconsistently enforced and a few entry-point tests that stopped short of proving the exact behavior that mattered.

As of the 2026-04-23 remediation update, the inconsistent GUI data boundary, the missing route-level `/api/changes` regression, the loose `/gui/llm` denial assertion, and the former source-scan-only message-rate-tracker wiring proof identified above have all been addressed.
