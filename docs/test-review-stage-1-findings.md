# Stage 1 Test Review Findings

Date: 2026-04-23
Stage: 1 - Documentation and Traceability Baseline
Status: Completed

## Scope

This stage reviewed the planning and traceability documents named by `docs/test-review-roadmap.md` before opening stage-specific test suites in detail.

Primary sources used:

- `test_strategy_summary.md`
- `docs/codebase-review-findings.md`
- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/open-items.md`
- `docs/superpowers/specs/*.md`
- `docs/superpowers/plans/*.md`

## Current Test Inventory Snapshot

Current non-vendored test inventory under `core/`, `apps/`, and `scripts/`:

- `core`: 192 test files
- `apps/food`: 100 test files
- `apps/chatbot`: 11 test files
- `apps/echo`: 1 test file
- `apps/notes`: 1 test file
- `scripts`: 2 test files
- Total: 307 test files

This immediately shows that `test_strategy_summary.md` is stale. It still says the suite has 223 non-vendored test files, which is no longer true.

## Traceability Map

This is the baseline mapping from product intent to major test areas for later review stages.

| Product area | Primary source docs | Main test areas to review later |
|---|---|---|
| Core runtime, auth, routing, API, GUI, and trust boundaries | `docs/urs.md`, `docs/uat-checklist.md`, `docs/codebase-review-findings.md`, `docs/superpowers/specs/2026-04-08-route-verification-design.md`, `docs/superpowers/plans/2026-04-11-phase-r1-access-control.md` | `core/src/api/__tests__`, `core/src/gui/__tests__`, `core/src/middleware/__tests__`, `core/src/server/__tests__`, `core/src/__tests__`, `core/src/services/router/__tests__`, `core/src/services/user-manager/__tests__`, `core/src/services/invite/__tests__` |
| Data scope, spaces, vaults, config, and persistence | `docs/urs.md`, `docs/open-items.md`, `docs/superpowers/specs/2026-04-11-phase-r3-data-boundaries-design.md`, `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`, `docs/superpowers/plans/2026-04-11-phase-r3-data-boundaries.md` | `core/src/services/data-store/__tests__`, `core/src/services/context-store/__tests__`, `core/src/services/household/__tests__`, `core/src/services/credentials/__tests__`, `core/src/services/spaces/__tests__`, `core/src/services/vault/__tests__`, `core/src/services/config/__tests__` |
| LLM, chatbot, data-query, interaction context, and edit flows | `docs/urs.md`, `docs/open-items.md`, `docs/superpowers/specs/2026-04-14-d2c-interaction-context-and-edit-design.md`, `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`, `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md` | `core/src/services/llm/__tests__`, `core/src/services/data-query/__tests__`, `core/src/services/interaction-context/__tests__`, `core/src/services/edit/__tests__`, `apps/chatbot/src/__tests__` |
| Scheduler, events, alerts, reports, and operations | `docs/urs.md`, `docs/uat-checklist.md`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/codebase-review-findings.md` | `core/src/services/scheduler/__tests__`, `core/src/services/event-bus/__tests__`, `core/src/services/alerts/__tests__`, `core/src/services/reports/__tests__`, `core/src/services/n8n/__tests__`, `core/src/services/webhooks/__tests__`, `core/src/services/system-info/__tests__` |
| Packaging, manifests, installer, registry, fixtures, and scripts | `docs/urs.md`, `docs/CREATING_AN_APP.md`, `docs/MANIFEST_REFERENCE.md`, `docs/USER_GUIDE.md` | `core/src/schemas/__tests__`, `core/src/services/app-installer/__tests__`, `core/src/services/app-registry/__tests__`, `core/src/cli/__tests__`, `core/src/testing/__tests__`, `scripts/__tests__`, `apps/echo`, `apps/notes` |
| Food foundations and user workflows | `docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md`, `docs/codebase-review-findings.md` | `apps/food/src/routing/__tests__`, `apps/food/src/services/__tests__`, `apps/food/src/utils/__tests__`, `apps/food/src/__tests__`, `apps/food/src/__tests__/handlers` |

## Expected-Behavior Sources By Review Theme

- `docs/urs.md` remains the broadest requirement inventory for core platform behavior, but it mixes original requirements with later phase additions and therefore needs careful cross-checking before a stage relies on a requirement ID as authoritative.
- `docs/uat-checklist.md` is the best end-user behavior checklist for GUI, API, scheduler, alert, report, frontmatter, and n8n flows, but it is not current enough to use as a strict source of exact startup prerequisites or suite size.
- `docs/codebase-review-findings.md` is the most useful document for identifying where the existing suite already had important blind spots. It should guide review attention, not replace the requirements.
- `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` are the main source of truth for the newer food, routing, data-boundary, interaction-context, file-index, and governance work. They are essential for Stages 3, 5, 7, and 8 because many of those behaviors are not described fully in the early URS sections.
- `docs/open-items.md` is necessary context for deciding whether a test is obsolete, transitional, or intentionally deferred.

## High-Value Test Areas Already Worth Trusting

The current suite already has a strong backbone in the following areas:

- Core routing and verifier behavior in `core/src/services/router/__tests__`
- Core LLM guardrails and cost tracking in `core/src/services/llm/__tests__`
- Core data-scope and membership behavior in `core/src/services/data-store/__tests__`
- Context persistence and retrieval in `core/src/services/context-store/__tests__`
- Invite lifecycle coverage in `core/src/services/invite/__tests__`
- Alert/report behavior in `core/src/services/alerts/__tests__`, `core/src/services/reports/__tests__`, `core/src/gui/__tests__`, and `core/src/api/__tests__`
- Food natural-language, photo, recipe, pantry, grocery, and nutrition behavior across `apps/food/src/__tests__`
- Manifest, registry, installer, and CLI coverage in `core/src/schemas/__tests__`, `core/src/services/app-registry/__tests__`, `core/src/services/app-installer/__tests__`, and `core/src/cli/__tests__`

These suites are the best candidates for later stage-by-stage review because they already protect meaningful business behavior and are likely to reveal whether assertions are still aligned with current product intent.

## Coverage Gaps To Carry Into Later Stages

The main cross-cutting gaps are already visible from the prior findings log and strategy summary:

- Authorization checks after verifier- or callback-selected routing changes
- True concurrent races instead of sequential double-call tests
- LLM output validation as hostile input, including schema, range, and authorization checks
- Production-wiring tests that exercise the same wrappers used by bootstrap
- Exact output-context rendering tests for HTML, inline script, JSON-in-script, and Telegram Markdown sinks
- Date, timezone, ISO week, and accounting-boundary edge cases
- Scheduler lifecycle tests that connect execution, failure notification, retry, shutdown, and cleanup behavior end to end

These gaps validate the roadmap staging order. Stages 2 through 6 should stay focused on those boundaries rather than trying to expand generic unit-test volume.

## Documentation And Traceability Findings

### 1. `test_strategy_summary.md` is stale enough to mislead later review work

- The summary still reports 223 non-vendored test files.
- The current inventory is 307 non-vendored test files.
- Later stages should not use the old counts as a planning baseline.

### 2. `docs/uat-checklist.md` mixes valid workflow coverage with stale prerequisites

- The prerequisites still require `ANTHROPIC_API_KEY` specifically even though the current codebase supports provider-specific configurations and open items already mention provider-only startup scenarios.
- The checklist still says `pnpm test` is 2156 tests, which is now only useful as historical context.
- Later reviewers can still use the UAT flow structure, but not its numeric suite-size claims or provider-specific assumptions.

### 3. `docs/urs.md` has traceability issues that will create ambiguity during later stages

- `REQ-GUI-006` is duplicated for two different features.
- `REQ-API-007` through `REQ-API-013` are still called out in `docs/open-items.md` as placeholder descriptions.
- `REQ-CHATBOT-006` still documents `isPasRelevant`, while `docs/open-items.md` already marks that behavior as deprecated and slated for removal once callers are gone.

This means later stages should treat the URS as partially authoritative, but confirm the exact current behavior against the newer specs/plans and the open-items list before calling a test obsolete or missing.

### 4. Stage ownership is clear, but the source-doc-to-test-area mapping was not written down before this pass

- The roadmap had a good stage breakdown, but it did not yet include a concrete mapping from each documentation family to the test areas that implement it.
- The traceability table above is the first baseline map for that work and should be used as the handoff into Stages 2 through 8.

## Likely Obsolete, Transitional, Or High-Risk Review Areas

- `isPasRelevant` requirements/tests are transitional rather than clearly permanent.
- Prompt-copy-sensitive chatbot tests are already called out in `docs/open-items.md` as brittle and should be reviewed with extra care in Stage 5.
- Accepted risk `D42` in `docs/open-items.md` means reviewers should not assume every earlier anti-instruction hardening note is still an intended runtime contract.
- Provider integration expectations are partially blocked on real API keys, so reviewers should distinguish missing offline coverage from intentionally deferred live-provider integration tests.

## Follow-Up Tasks Opened By Stage 1

- Refresh `test_strategy_summary.md` so its inventory and framing match the current suite.
- Refresh `docs/uat-checklist.md` prerequisites and current-suite references.
- Repair URS traceability issues, especially duplicate requirement IDs and the placeholder Phase 26 API descriptions.
- Keep using this Stage 1 traceability map as the doc baseline for Stages 2 through 8.

## Remediation Update

Update applied: 2026-04-23

- Refreshed `test_strategy_summary.md` to use the current repo-local `core/`, `apps/`, and `scripts/` inventory baseline.
- Refreshed `docs/uat-checklist.md` so prerequisites and suite-size references are provider-agnostic and no longer rely on stale test totals.
- Repaired the URS traceability issues called out here: the duplicate GUI requirement ID was removed, the Phase 26 API entries are now documented rather than flagged as placeholders, and `REQ-CHATBOT-006` now explicitly documents its legacy/deprecated compatibility role.
- Removed the corresponding stale Phase 26 placeholder reminder from `docs/open-items.md`.

## Stage 1 Exit Decision

Stage 1 is complete. The repo now has:

- a current traceability baseline from source docs to major test areas
- a short list of documentation defects that would otherwise make later test review ambiguous
- a clearer record of which gaps are true test-review targets versus known deferred or accepted-risk items

As of the 2026-04-23 remediation update, the documentation defects identified in this stage have been corrected in the live baseline docs.
