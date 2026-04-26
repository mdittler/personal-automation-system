# Staged Test Review Roadmap

This document is the session-by-session planner for a staged review of PAS test coverage and test quality.

It is intentionally planning-only. No review findings have been recorded here yet, and no stage should be treated as started unless its status is updated below.

The review is meant to answer the same questions in every stage:

- Do the tests cover the intended behavior described by the specs, plans, and accepted requirements?
- Do the assertions verify the behavior that actually matters, rather than only proving helpers or mocked internals were called?
- Are any tests too narrow, too brittle, or too dependent on implementation details to be trustworthy?
- Are any tests obsolete, superseded, or no longer meaningful for the current software?

## Source Documents for Traceability

Use these documents as the primary source of truth during each review stage:

- `test_strategy_summary.md`
- `docs/codebase-review-findings.md`
- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/open-items.md`
- `docs/superpowers/specs/*.md`
- `docs/superpowers/plans/*.md`

The staged review should focus only on repo-local, non-vendored tests and supporting docs. Vendored files, `node_modules`, and worktree copies are out of scope.

## Status Tracker

| Stage | Name | Status | Findings / Follow-up |
|---|---|---|---|
| 1 | Documentation and Traceability Baseline | Completed | `docs/test-review-stage-1-findings.md` (remediation update 2026-04-23) |
| 2 | Core Trust Boundaries and Runtime Entry Points | Completed | `docs/test-review-stage-2-findings.md` (remediation update 2026-04-23) |
| 3 | Core Data, Identity, and Shared-State Services | Completed | `docs/test-review-stage-3-findings.md` (remediation update 2026-04-23) |
| 4 | Core Automation, Reporting, and Operational Services | Completed | `docs/test-review-stage-4-findings.md` (remediation update 2026-04-23) |
| 5 | Core LLM, Routing, Query, and Edit Flows | Completed | `docs/test-review-stage-5-findings.md` |
| 6 | Platform Packaging, Registry, CLI, and Test Infrastructure | Completed | `docs/test-review-stage-6-findings.md` |
| 7 | Food App Foundations | Completed | `docs/test-review-stage-7-findings.md` |
| 8 | Food App User Workflows and Feature Coverage | Completed | `docs/test-review-stage-8-findings.md` |

## Stage Overview

| Stage | Scope | Primary Directories | Primary Specs / Docs | Review Goals |
|---|---|---|---|---|
| 1 | Build traceability before reviewing individual tests | `docs/`, root test planning docs | `test_strategy_summary.md`, `docs/codebase-review-findings.md`, `docs/urs.md`, `docs/uat-checklist.md`, `docs/superpowers/specs/`, `docs/superpowers/plans/` | Map expected behavior to code areas, identify missing traceability, and note likely obsolete feature or test areas before code-level review starts |
| 2 | Runtime entry points and trust boundaries | `core/src/api`, `core/src/gui`, `core/src/server`, `core/src/middleware`, `core/src/__tests__` | `docs/urs.md`, `docs/uat-checklist.md`, security and routing-related specs/plans | Verify auth, household isolation, permissions, route protection, request lifecycle behavior, and integration wiring coverage |
| 3 | Core persistence and identity boundaries | `core/src/services/data-store`, `core/src/services/context-store`, `core/src/services/household`, `core/src/services/user-manager`, `core/src/services/credentials`, `core/src/services/invite`, `core/src/services/spaces`, `core/src/services/vault`, `core/src/services/config` | Data-boundary, auth, household, and shared-space specs/plans | Verify persistence correctness, isolation rules, migrations, config behavior, and shared/personal scope handling |
| 4 | Core automation and operational behavior | `core/src/services/alerts`, `core/src/services/reports`, `core/src/services/scheduler`, `core/src/services/condition-evaluator`, `core/src/services/event-bus`, `core/src/services/backup`, `core/src/services/n8n`, `core/src/services/metrics`, `core/src/services/system-info`, `core/src/services/webhooks`, `core/src/services/logger` | Reporting, alerting, scheduler, deployment, and ops-related specs/plans | Verify async behavior, scheduling semantics, failure handling, notifier/report correctness, and operational visibility coverage |
| 5 | Core LLM and routing-heavy flows | `core/src/services/llm`, `core/src/services/router`, `core/src/services/data-query`, `core/src/services/interaction-context`, `core/src/services/edit`, `apps/chatbot/src/__tests__` | LLM, routing, data-query, interaction-context, and edit-related specs/plans | Verify routing decisions, prompt and cost guard behavior, fallback behavior, context/edit integration, and brittle prompt-structure assertions |
| 6 | Platform packaging and shared test infrastructure | `core/src/services/app-*`, `core/src/cli`, `core/src/schemas`, `core/src/testing`, `core/src/utils`, `core/src/types`, `scripts/__tests__`, `apps/echo`, `apps/notes` | Manifest, installer, CLI, testing, and utility docs/specs | Verify manifest and installer coverage, CLI behavior, fixture realism, utility correctness, and obsolete compatibility tests |
| 7 | Food foundations and shared plumbing | `apps/food/src/routing`, `apps/food/src/services`, `apps/food/src/utils`, foundational food store tests | Food feature specs/plans plus cross-cutting routing and data docs | Verify routing/classification helpers, store and utility behavior, helper realism, and unit-vs-integration balance |
| 8 | Food feature workflows and user-facing scenarios | `apps/food/src/__tests__`, `apps/food/src/__tests__/handlers` | Food feature specs/plans, UAT, and relevant review findings | Verify natural-language flows, photo flows, nutrition, pantry/grocery/meal planning, family and household workflows, event-driven behavior, and obsolete tests tied to superseded features |

## Standard Review Checklist

Every stage uses the same checklist. Record the answers for the current stage before moving on:

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

## Stage Details

### Stage 1 — Documentation and Traceability Baseline

**Status:** Completed

**Findings:** `docs/test-review-stage-1-findings.md`

**Sources**

- `test_strategy_summary.md`
- `docs/codebase-review-findings.md`
- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/superpowers/specs/`
- `docs/superpowers/plans/`

**What this stage should accomplish**

- Build a reliable map from product intent and accepted requirements to the major test areas in `core/`, `apps/`, and `scripts/`
- Identify doc gaps that make later test review ambiguous
- Flag features, requirements, or plans that may no longer match the current software and could imply obsolete tests

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 2 — Core Trust Boundaries and Runtime Entry Points

**Status:** Completed

**Findings:** `docs/test-review-stage-2-findings.md`

**Primary scope**

- `core/src/api`
- `core/src/gui`
- `core/src/server`
- `core/src/middleware`
- `core/src/__tests__`

**What this stage should accomplish**

- Review runtime entry points where trust, auth, session state, permissions, and request lifecycle rules are enforced
- Confirm tests cover household isolation, route protection, and top-level integration wiring rather than only local helper behavior

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 3 — Core Data, Identity, and Shared-State Services

**Status:** Completed

**Findings:** `docs/test-review-stage-3-findings.md` (remediation update 2026-04-23)

**Primary scope**

- `core/src/services/data-store`
- `core/src/services/context-store`
- `core/src/services/household`
- `core/src/services/user-manager`
- `core/src/services/credentials`
- `core/src/services/invite`
- `core/src/services/spaces`
- `core/src/services/vault`
- `core/src/services/config`

**What this stage should accomplish**

- Review data and identity services where persistence correctness and isolation rules matter most
- Confirm migrations, scope boundaries, shared-vs-personal behavior, and config-driven behavior are covered by meaningful tests

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 4 — Core Automation, Reporting, and Operational Services

**Status:** Completed

**Findings:** `docs/test-review-stage-4-findings.md` (remediation update 2026-04-23)

**Primary scope**

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

**What this stage should accomplish**

- Review asynchronous and operational behavior where tests must protect timing, scheduling, failure handling, and report/alert correctness
- Confirm tests validate behavior that matters under real runtime conditions, not just in isolated helper paths

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 5 — Core LLM, Routing, Query, and Edit Flows

**Status:** Completed

**Findings:** `docs/test-review-stage-5-findings.md`

**Primary scope**

- `core/src/services/llm`
- `core/src/services/router`
- `core/src/services/data-query`
- `core/src/services/interaction-context`
- `core/src/services/edit`
- `apps/chatbot/src/__tests__`

**What this stage should accomplish**

- Review decision-heavy and prompt-heavy areas where tests can become brittle or over-coupled to implementation details
- Confirm routing, fallback, guards, context persistence, and edit flows are covered in ways that verify real behavior

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 6 — Platform Packaging, Registry, CLI, and Test Infrastructure

**Status:** Completed

**Findings:** `docs/test-review-stage-6-findings.md`

**Primary scope**

- `core/src/services/app-installer`
- `core/src/services/app-registry`
- `core/src/services/app-toggle`
- `core/src/services/app-knowledge`
- `core/src/services/app-metadata`
- `core/src/cli`
- `core/src/schemas`
- `core/src/testing`
- `core/src/utils`
- `core/src/types`
- `scripts/__tests__`
- `apps/echo`
- `apps/notes`

**What this stage should accomplish**

- Review packaging, installer, registry, CLI, utility, and fixture coverage that supports the rest of the platform
- Confirm manifest validation, compatibility checks, CLI behavior, and shared test helpers remain meaningful and not obsolete

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 7 — Food App Foundations

**Status:** Completed

**Findings:** `docs/test-review-stage-7-findings.md`

**Primary scope**

- `apps/food/src/routing`
- `apps/food/src/services`
- `apps/food/src/utils`
- Foundational food store and shared plumbing tests

**What this stage should accomplish**

- Review the shared plumbing beneath food workflows before feature-level scenario review begins
- Confirm routing helpers, classification helpers, stores, and utilities are covered with the right balance of unit and integration tests

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

### Stage 8 — Food App User Workflows and Feature Coverage

**Status:** Completed and remediated

**Findings:** `docs/test-review-stage-8-findings.md`

**Primary scope**

- `apps/food/src/__tests__`
- `apps/food/src/__tests__/handlers`

**What this stage should accomplish**

- Review the user-facing food workflows after the foundations are understood
- Confirm natural-language, photo, nutrition, pantry, grocery, meal-planning, family, guest, household, and event-driven flows are covered in ways that match the feature specs and current product behavior

**Checklist**

- Which specs, plans, URS items, UAT items, or review notes define the expected behavior?
- Which tests appear high-value and trustworthy enough to keep relying on?
- Which important behaviors, edge cases, or failure paths are not covered well enough?
- Which tests are weak, misleading, over-mocked, brittle, or too implementation-coupled?
- Which tests appear obsolete, superseded, or in need of confirmation before removal?
- Which follow-up implementation, test, or documentation tasks should be opened afterward?

## How to Run Each Review Session

Use the same workflow for every stage so findings stay comparable:

1. Confirm the current stage, scope, and source documents from this roadmap before opening test files.
2. Read the relevant specs, plans, URS, UAT, and open-items context first so expected behavior is clear before judging tests.
3. Review the tests in that stage as a group, looking for gaps, weak assertions, brittle implementation coupling, and obsolete coverage.
4. Record findings separately from fixes. The review session should identify issues first; implementation work can happen later in a dedicated follow-up session.
5. Update this roadmap's status tracker with the stage status and a link to any findings document once that stage is complete.

## Notes

- `test_strategy_summary.md` remains the current-state summary of the test landscape and prior observations.
- This roadmap is the execution planner for future staged review sessions.
- The first actual review session should start with Stage 1 rather than jumping straight into code-level findings.
