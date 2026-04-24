# Stage 3 Test Review Findings

Date: 2026-04-23
Stage: 3 - Core Data, Identity, and Shared-State Services
Status: Completed

## Scope

This stage reviewed the persistence, identity, and shared-state services under:

- `core/src/services/data-store`
- `core/src/services/context-store`
- `core/src/services/household`
- `core/src/services/user-manager`
- `core/src/services/credentials`
- `core/src/services/invite`
- `core/src/services/spaces`
- `core/src/services/vault`
- `core/src/services/config`

The review goal was to judge whether the tests protect persistence correctness, scope and tenant boundaries, config-driven behavior, migrations, and shared-vs-personal state handling in ways that match the current software.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `docs/urs.md`
- `docs/open-items.md`
- `docs/codebase-review-findings.md`
- `docs/superpowers/specs/2026-04-08-invite-code-user-management-design.md`
- `docs/superpowers/specs/2026-04-11-phase-r3-data-boundaries-design.md`
- `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`
- `docs/superpowers/plans/2026-04-11-phase-r3-data-boundaries.md`

Key URS areas for this stage:

- `REQ-DATA-001`, `REQ-DATA-002`, `REQ-DATA-003`
- `REQ-CTX-001`, `REQ-CTX-002`
- `REQ-CONFIG-001`, `REQ-CONFIG-002`, `REQ-CONFIG-003`, `REQ-CONFIG-004`
- `REQ-USER-001`, `REQ-USER-005`, `REQ-USER-006`, `REQ-USER-007`, `REQ-USER-008`
- `REQ-SPACE-001`, `REQ-SPACE-002`, `REQ-SPACE-003`, `REQ-SPACE-007`, `REQ-SPACE-010`, `REQ-SPACE-011`, `REQ-SPACE-013`, `REQ-SPACE-016`, `REQ-SPACE-017`
- `REQ-VAULT-001`, `REQ-VAULT-002`, `REQ-VAULT-003`, `REQ-VAULT-004`
- `REQ-SEC-001`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 3 coverage today is:

- `core/src/services/data-store/__tests__/scoped-store.test.ts`
  This is still the best core coverage for scope enforcement, path traversal rejection, change-log wiring, and the post-R3 fail-closed behavior.
- `core/src/services/data-store/__tests__/data-store-shared.test.ts` and `core/src/services/data-store/__tests__/data-store-spaces.test.ts`
  These are the most useful household-aware routing and actor-boundary tests around shared and space-scoped stores.
- `core/src/services/context-store/__tests__/context-store-household.test.ts`
  Good direct evidence for household-aware context routing and actor-vs-target checks.
- `core/src/services/spaces/__tests__/spaces.test.ts`
  This is the backbone suite for CRUD validation, membership rules, stale active-space cleanup, YAML recovery, and serialized writes.
- `core/src/services/vault/__tests__/vault-household.test.ts`
  Good targeted coverage for household-vs-collaboration vault path routing after the migration-era layout changes.
- `core/src/services/config/__tests__/config.test.ts` and `core/src/services/config/__tests__/per-user-runtime.integration.test.ts`
  These are the most trustworthy config tests because they cover both parsing/validation and the real request-context-based override path that previously failed silently.
- `core/src/services/invite/__tests__/index.test.ts`, `integration.test.ts`, and `redeem-and-register.test.ts`
  Good lifecycle coverage for invite creation, atomic redemption, registration, and post-registration flow control.
- `core/src/services/household/__tests__/migration.test.ts`
  Good focused migration coverage for the main happy path, idempotency, and the most important backup/move failure branches.

## Findings

### 1. Household space enforcement still permits members with no household assignment

- Severity: high
- Type: tenant-boundary bug plus missing regression coverage
- Code references:
  - `core/src/services/spaces/index.ts:258-268`
  - `core/src/services/spaces/index.ts:465-478`
  - `core/src/services/user-manager/user-mutation-service.ts:42-49`
- Test references:
  - `core/src/services/spaces/__tests__/spaces.test.ts:1009-1084`
  - `core/src/services/invite/__tests__/integration.test.ts:175-214`

The post-migration same-household checks in both `addMember()` and `validateSpace()` only reject a user when `memberHousehold !== null && memberHousehold !== targetHousehold`. A registered user with no household therefore slips through the `kind: 'household'` membership gate.

That state is still reachable in this codebase because the mutation layer only warns when registering a user without `householdId`, and the Stage 3 lifecycle tests still use that legacy shape in normal happy-path flows. The current space tests cover wrong-household users and legacy no-household-service behavior, but they do not pin the null-household case. As written, a household space can accept a member whose tenant boundary is unknown.

### 2. Mutation sync coverage stops at registration, but the live remove/update paths can leave memory and disk out of sync

- Severity: medium
- Type: persistence bug plus missing regression coverage
- Code references:
  - `core/src/services/user-manager/user-mutation-service.ts:51-62`
  - `core/src/services/user-manager/user-mutation-service.ts:75-117`
- Test references:
  - `core/src/services/user-manager/__tests__/user-mutation-service.test.ts:159-177`
  - `core/src/services/user-manager/__tests__/user-mutation-service.test.ts:197-335`

`registerUser()` correctly rolls back the in-memory mutation when `syncUsersToConfig()` fails. `removeUser()`, `updateUserApps()`, and `updateUserSharedScopes()` do not. They mutate `UserManager` first, then sync to disk, and have no rollback path if the write throws.

That means a failed removal can leave a user missing in memory but still present in `pas.yaml`, and a failed app/scope update can leave the live process serving settings that were never durably persisted. The update methods also ignore `UserManager`'s boolean return values, so a nonexistent-user update currently logs success and rewrites config unchanged. The tests only exercise registration rollback and otherwise stay on happy-path persistence, so these divergence cases are unguarded.

### 3. Editing a space through `saveSpace()` can leave removed members with stale vault links

- Severity: medium
- Type: shared-state cleanup bug plus missing regression coverage
- Code references:
  - `core/src/gui/routes/spaces.ts:115-136`
  - `core/src/services/spaces/index.ts:151-168`
  - `core/src/services/vault/index.ts:314-335`
- Test references:
  - `core/src/services/spaces/__tests__/spaces.test.ts:161-170`
  - `core/src/services/vault/__tests__/vault.test.ts:582-706`

The GUI edit form posts the full member list back through `saveSpace()`. On update, `saveSpace()` persists the new definition and rebuilds vaults only for the members still present. It never diffs the old and new membership sets, so former members do not get `removeSpaceLink()` and can keep stale `_spaces/<spaceId>` symlinks until some later cleanup path happens to run.

The current tests verify vault integration for `addMember()`, `removeMember()`, and `deleteSpace()`, which is good coverage for the explicit membership endpoints. But the only Stage 3 `saveSpace()` update test changes the name only, so the edit-form path that removes a member through an update is not exercised at all.

## Transitional Or Lower-Trust Coverage To Treat Carefully

- `core/src/services/data-store/__tests__/data-store-shared.test.ts`, `core/src/services/context-store/__tests__/context-store-household.test.ts`, `core/src/services/spaces/__tests__/spaces.test.ts`, and `core/src/services/vault/__tests__/vault-household.test.ts` intentionally preserve legacy or transitional no-household behavior. Those tests are still useful backward-compat guards, but they are not the main proof that strict post-migration isolation is correct.
- The Stage 3 user lifecycle tests still register users without `householdId` in several happy-path flows. That is useful for migration compatibility, but it makes those tests weaker evidence for current steady-state household invariants.
- `core/src/services/context-store/__tests__/context-store.test.ts` remains a strong path-hardening and keyword-search suite, but the household-aware routing expectations now live more authoritatively in `context-store-household.test.ts`.

## Follow-Up Tasks Opened By Stage 3

- Add null-household regression tests for both `saveSpace()` and `addMember()` when `householdService` is wired, then reject those members explicitly.
- Add rollback and failure-path tests for `removeUser()`, `updateUserApps()`, and `updateUserSharedScopes()`, and either move the mutation after a successful sync or restore the pre-mutation state on failure.
- Add a `saveSpace()` membership-diff regression test that removes a member through the update path and proves their vault `_spaces/<spaceId>` directory is cleaned up.
- Decide whether user removal should also scrub downstream shared state such as space memberships, active-space records, and household admin references, then add cross-service integration coverage if that cleanup becomes required.

## Remediation Update

Update applied: 2026-04-23

- `core/src/services/spaces/index.ts` now rejects household-space members whose `householdId` is missing as well as mismatched, both during `saveSpace()` validation and `addMember()` checks.
- `core/src/services/spaces/__tests__/spaces.test.ts` now includes explicit null-household regression coverage for both `saveSpace()` and `addMember()` when `householdService` is wired.
- `core/src/services/user-manager/user-mutation-service.ts` now snapshots and restores the in-memory user state if `removeUser()`, `updateUserApps()`, or `updateUserSharedScopes()` fail during config sync, and the update paths now reject missing users instead of silently succeeding.
- `core/src/services/user-manager/__tests__/user-mutation-service.test.ts` now covers rollback behavior for failed remove/app/scope syncs plus the missing-user update cases.
- `core/src/services/spaces/index.ts` now diffs prior vs updated membership during `saveSpace()` and removes stale vault `_spaces/<spaceId>` links for users who were dropped from the space.
- `core/src/services/vault/__tests__/vault.test.ts` now proves that editing a space through `saveSpace()` removes the former member's vault link.
- The broader design question about whether user removal should also scrub downstream shared state remains open; that was not changed in this pass.

## Stage 3 Exit Decision

Stage 3 is complete.

The strongest persistence and identity coverage is in the data-store, context-store, spaces, vault, config, and invite lifecycle suites. The main remaining problems in this stage are not missing test volume; they are a few important boundary and cleanup paths where the current tests are still too happy-path-oriented to catch the runtime behavior that matters most.

As of the 2026-04-23 remediation update, the three smaller runtime/test gaps identified above have been addressed. The remaining open Stage 3 follow-up is deciding whether user removal should also clean downstream shared state and then adding the corresponding integration coverage if that behavior becomes required.
