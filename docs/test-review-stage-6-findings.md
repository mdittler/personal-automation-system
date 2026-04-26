# Stage 6 Test Review Findings

Date: 2026-04-25
Stage: 6 - Platform Packaging, Registry, CLI, and Test Infrastructure
Status: Remediated

## Scope

This stage reviewed the platform packaging, registry, CLI, schema, shared testing, script, and example-app test areas under:

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

The review goal was to judge whether the Stage 6 tests protect the real platform contracts around app packaging, installation, loading, manifest compatibility, example-app correctness, and shared test infrastructure, rather than only checking helper logic in isolation.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `test_strategy_summary.md`
- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/open-items.md`
- `docs/codebase-review-findings.md`
- `docs/CREATING_AN_APP.md`
- `docs/MANIFEST_REFERENCE.md`

Key URS areas for this stage:

- `REQ-MANIFEST-001`
- `REQ-APPMETA-001`
- `REQ-APPKNOW-001`
- `REQ-REGISTRY-004`
- `REQ-INSTALL-001`, `REQ-INSTALL-002`, `REQ-INSTALL-003`, `REQ-INSTALL-004`, `REQ-INSTALL-005`, `REQ-INSTALL-006`, `REQ-INSTALL-007`, `REQ-INSTALL-008`
- `REQ-SCAFFOLD-001`
- `REQ-EXAMPLE-001`
- `REQ-DOC-001`, `REQ-DOC-002`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 6 coverage today is:

- `core/src/services/app-installer/__tests__/installer.test.ts`, `static-analyzer.test.ts`, and `compatibility-checker.test.ts`
  Good component-level protection for git URL validation, manifest parse/validation failures, semver compatibility checks, banned-import detection, symlink rejection, and dependency-install cleanup.
- `core/src/services/app-registry/__tests__/registry.test.ts`, `manifest-cache.test.ts`, `core/src/services/app-toggle/__tests__/app-toggle.test.ts`, `core/src/services/app-metadata/__tests__/app-metadata.test.ts`, and `core/src/services/app-knowledge/__tests__/app-knowledge.test.ts`
  Good direct coverage for duplicate-app-ID rejection before `init()`, manifest cache routing tables, per-user app-toggle persistence, metadata redaction, and knowledge indexing/filtering.
- `core/src/cli/__tests__/scaffold-app.test.ts` and `scripts-smoke.test.ts`
  Stronger-than-average CLI-side protection for scaffold template replacement, schema-valid generated manifests, and dead script references in the root `package.json`.
- `core/src/testing/__tests__/e2e-echo.test.ts`, `apps/echo/src/__tests__/echo.test.ts`, and `apps/notes/__tests__/notes.test.ts`
  Useful example-app coverage for real routing through the registry and router in the echo pipeline, plus day-to-day note save/list/summarize behavior and timezone-sensitive daily-note paths.
- `scripts/__tests__/migrate-frontmatter.test.ts`
  Good path-pattern coverage for identifying real markdown file categories across the shared data tree.

## Findings

### 1. Compiled app loading is now pinned against packaged runtime behavior

- Severity: high
- Status: remediated
- Code references:
  - `core/src/services/app-registry/loader.ts`
  - `core/src/services/app-registry/__tests__/loader.test.ts`
  - `core/src/services/app-registry/__tests__/registry.test.ts`

`AppLoader.importModule()` now resolves module entrypoints in the production-safe order this stage needed: safe local `package.json.main`, then `dist/index.js`, then the development fallbacks (`index.js`, `index.ts`, `src/index.js`, `src/index.ts`). Invalid `main` values such as absolute paths, traversal attempts, and unsupported extensions are logged at debug level and ignored without breaking the fallback chain.

The new regression coverage proves both the direct loader contract and the startup-style registry path. `loader.test.ts` now covers safe `main`, `dist/index.js`, traversal, absolute paths, and unsupported extensions. `registry.test.ts` now loads a full temp app fixture with a working compiled module plus a deliberately broken `src/index.ts`, proving `loadAll()` still succeeds through the compiled runtime path.

### 2. The install CLI now enforces a real review-then-commit boundary

- Severity: medium
- Status: remediated
- Code references:
  - `core/src/services/app-installer/index.ts`
  - `core/src/cli/install-app.ts`
  - `core/src/cli/uninstall-app.ts`

The installer is now split into a no-side-effects planning phase and a commit phase. `planInstallApp()` performs clone, validation, compatibility checks, static analysis, and permission-summary generation without copying into `apps/` or running `pnpm install`. It returns a `PreparedInstall` handle with `commit()` and idempotent `dispose()`. The legacy `installApp()` wrapper remains available, but now does `plan -> commit -> dispose` internally.

The CLI coverage is now behavioral rather than helper-only. `install-app.test.ts` proves the validated permission summary is printed before approval, canceling does not commit, `--yes` skips the prompt but still shows the summary, planner failures stop before commit, and commit failures still dispose the prepared install. `uninstall-app.test.ts` now exercises the actual runner-style flow, including restart guidance after a successful uninstall.

### 3. Manifest-scope compatibility is now protected end to end

- Severity: medium
- Status: remediated
- Code references:
  - `core/src/schemas/__tests__/validate-manifest.test.ts`
  - `core/src/schemas/__tests__/bundled-manifests.test.ts`
  - `core/src/services/data-store/__tests__/manifest-scope-contract.test.ts`
  - `apps/food/manifest.yaml`

The schema fixtures now use app-root-relative examples (`log.md`, `list.md`, `recipes/`, `shared-list.md`, `meal-plans/`) instead of the older app-prefixed convention. A new bundled-manifest contract test validates every first-party manifest under `apps/*/manifest.yaml` and asserts `warnScopePathPrefix()` returns no warnings. The runtime scope contract is now pinned with real `DataStoreServiceImpl` enforcement for echo, notes, and chatbot, including both accept and reject cases.

This pass also flushed out a live bundled-manifest bug while adding the contract test: `apps/food/manifest.yaml` still used `enum` for a `select`-style `user_config` field. That manifest now uses the schema-correct `options` property, so the full bundled-manifest sweep passes.

## Residual Risks

- `core/src/testing/__tests__/e2e-echo.test.ts` is still valuable, but it remains a source-tree integration test rather than a compiled-runtime smoke test across all bundled apps.
- The CLI runner tests assert command behavior directly without spawning a separate process, which is strong enough for the Stage 6 consent boundary but still lighter than a full child-process smoke invocation.

## Follow-Up Tasks Closed By Stage 6

- `AppLoader.importModule()` now prefers safe packaged runtime entries before source fallbacks, with direct loader and registry smoke coverage.
- The installer now supports review-first planning, and the `install-app` command is tested as a no-side-effects-until-approval flow.
- Bundled manifest validation and runtime scope contracts now agree on app-root-relative path semantics.
- The outdated app-prefixed schema fixtures have been replaced.
- `uninstall-app` now has runner-level behavioral coverage rather than regex-only helper checks.

## Stage 6 Exit Decision

Stage 6 remediation is complete.

The original three Stage 6 review gaps are now closed in code, tests, and traceability docs. Verification for this remediation is: targeted Stage 6 suites passed, full `pnpm test` passed, and `pnpm build` passed.
