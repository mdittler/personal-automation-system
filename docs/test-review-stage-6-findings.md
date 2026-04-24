# Stage 6 Test Review Findings

Date: 2026-04-23
Stage: 6 - Platform Packaging, Registry, CLI, and Test Infrastructure
Status: Completed

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

### 1. Compiled app loading is still unprotected, and the current loader still does not try `dist/index.js`

- Severity: high
- Type: production packaging/runtime mismatch plus missing regression coverage
- Code references:
  - `core/src/services/app-registry/loader.ts:117-125`
  - `apps/echo/package.json:1-8`
  - `apps/notes/package.json:1-8`
  - `docs/codebase-review-findings.md:1102-1139`
- Test references:
  - `core/src/services/app-registry/__tests__/loader.test.ts:141-169`
  - `core/src/testing/__tests__/e2e-echo.test.ts:95-109`
  - `test_strategy_summary.md:321-324`

`AppLoader.importModule()` still comments that it "tries the compiled .js first," but the actual candidate list is only `index.js`, `index.ts`, `src/index.js`, and `src/index.ts`. It never tries `dist/index.js`, even though the packaged example apps still declare `"main": "dist/index.js"`. That leaves the same production seam identified in `docs/codebase-review-findings.md` effectively open in the current source tree, despite that finding being marked fixed there.

The Stage 6 tests do not pin this. `loader.test.ts` only exercises a tiny inline `index.ts` module and the missing-module case. The strongest end-to-end check in this stage, `e2e-echo.test.ts`, points the registry at the live `apps/` tree but still relies on the current source layout instead of a compiled-package scenario. So the stage has good development-mode confidence, but still lacks the regression test that would catch a compiled-runtime packaging failure before deployment.

### 2. The install CLI still lacks a true review-then-commit flow, and the tests only cover helper parsing

- Severity: medium
- Type: consent-boundary/runtime-flow gap plus shallow CLI coverage
- Code references:
  - `core/src/cli/install-app.ts:85-137`
  - `core/src/services/app-installer/index.ts:267-300`
  - `docs/codebase-review-findings.md:1173-1199`
  - `test_strategy_summary.md:323-324`
- Test references:
  - `core/src/cli/__tests__/install-app.test.ts:4-85`
  - `core/src/services/app-installer/__tests__/installer.test.ts:100-243`

The install CLI is better than the earlier broken version because `--yes` is now parsed and a confirmation prompt exists. But it still prompts before any validated permission summary exists, then calls `installApp()`, and only prints `result.permissionSummary` after clone/validation/copy/dependency-install side effects have already succeeded. The installer service likewise has no validation-only or planning mode; once you ask it for a permission summary, you are already on the commit path.

That means the user-visible review-permissions-then-install flow is still not protected as a real contract. The current CLI tests make that easy to miss because they only assert regexes, array parsing, and `parseYesFlag()`. The service tests are strong for installer safety once installation is underway, but they do not prove that the actual `install-app` command gates those side effects behind a reviewed permission plan.

### 3. Manifest-scope compatibility is still not protected end to end, and the schema fixtures still encode the older app-prefixed path convention

- Severity: medium
- Type: schema/example/runtime contract drift
- Code references:
  - `core/src/schemas/__tests__/validate-manifest.test.ts:8-41`
  - `core/src/schemas/__tests__/validate-manifest.test.ts:116-120`
  - `core/src/services/data-store/paths.ts:231-240`
  - `apps/echo/manifest.yaml:19-27`
  - `apps/notes/manifest.yaml:28-37`
  - `apps/echo/src/index.ts:21-27`
  - `apps/notes/src/index.ts:10-16`
  - `docs/codebase-review-findings.md:233-253`
- Test references:
  - `core/src/schemas/__tests__/validate-manifest.test.ts:8-41`
  - `core/src/testing/__tests__/e2e-echo.test.ts:100-109`
  - `test_strategy_summary.md:191-195`

The runtime now treats manifest data scopes as app-root-relative and even includes `warnScopePathPrefix()` to flag `<appId>/...` paths as suspicious. The bundled example manifests and runtime code reflect that contract: echo declares `log.md` and writes `log.md`, while notes declares `daily-notes/` and writes `daily-notes/<date>.md`. But the canonical schema test fixture still uses app-prefixed paths like `echo/log.md` and `grocery/list.md`, which teaches and preserves the older convention inside the validation suite itself.

The missing protection is the contract test that ties all of this together. Stage 6 still has no bundled-manifest compatibility regression that proves the example manifests, schema fixtures, and enforced runtime scopes agree with each other. So even though the live example apps have moved to the correct convention, the test corpus still contains outdated "valid" examples that could reintroduce scope-path drift without failing the stage.

## Transitional Or Lower-Trust Coverage To Treat Carefully

- `core/src/cli/__tests__/install-app.test.ts:4-85` and `core/src/cli/__tests__/uninstall-app.test.ts:17-69` are helper-level CLI tests. They are useful for regex and constant drift, but they are weak evidence of the actual command-entry behavior because they do not invoke the real `main()` flow.
- `core/src/services/app-registry/__tests__/loader.test.ts:141-169` only proves tiny inline `index.ts` modules can import in the test environment. It does not exercise realistic compiled app layouts, `.js`-specifier source imports, or `dist/index.js` preference.
- `apps/echo/src/__tests__/echo.test.ts` and `apps/notes/__tests__/notes.test.ts` are good example-app behavior tests, but they rely on `createMockCoreServices()` and mocked scoped stores. They do not prove manifest-scope enforcement or compiled-package loading. `core/src/testing/__tests__/e2e-echo.test.ts` is stronger, but it only covers echo and only in the source-loaded path.
- `scripts/__tests__/load-test.test.ts` is useful for quantile math and cap-hit log parsing, but it is not a smoke test of the actual `load-test` script wiring or CLI invocation.

## Follow-Up Tasks Opened By Stage 6

- Fix `AppLoader.importModule()` to consider `dist/index.js` (or a safely resolved package `main`) before source fallbacks in production-like conditions, and add loader/registry smoke coverage for compiled bundles.
- Split the installer into validation/permission-plan and commit phases, or add a `dryRun`/`validateOnly` mode, then add command-level `install-app` tests proving no side effects occur before explicit approval unless `--yes` is present.
- Add bundled-manifest/runtime contract tests for echo, notes, chatbot, and other packaged apps so scope-path semantics are checked against real manifests and real store enforcement.
- Replace the outdated app-prefixed scope fixtures in `validate-manifest.test.ts` with app-root-relative examples, or add an explicit warning/lint assertion that documents the prefixed form as transitional and discouraged.
- Consider broadening `uninstall-app` coverage from regex-only tests to real entrypoint-level behavior checks in the same style the install CLI still needs.

## Stage 6 Exit Decision

Stage 6 is complete.

The strongest coverage in this stage is around installer safety checks, manifest cache and metadata behavior, scaffolding, root script existence, and the basic example-app behavior model. The main remaining weaknesses are the still-unpinned compiled-app loading path, the missing validation-before-commit install flow, and the lingering contract drift between schema fixtures and runtime data-scope semantics.
