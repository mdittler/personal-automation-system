# Test Strategy Summary

This document summarizes the current testing picture after reviewing `docs/codebase-review-findings.md` and the existing non-vendored test suite under `core/` and `apps/`.

The main conclusion is not that PAS lacks tests. It has a large and useful test suite. The repeated gap is that many tests stop at a helper, service, or happy-path route boundary, while the findings happen where trust, permissions, serialized data, documented contracts, or production wiring cross from one layer into another.

## Review Scope

- Reviewed findings 1-42 across phases 1-10 in `docs/codebase-review-findings.md`.
- Reviewed the non-vendored test inventory under `core/` and `apps/`.
- Counted 223 non-vendored test files and about 4,896 `it()` / `test()` cases.
- Distribution by area: `core` has 133 test files, `apps` has 90. Of the app tests, `apps/food` has 86 files, `apps/chatbot` has 2, `apps/echo` has 1, and `apps/notes` has 1.
- Distribution by core area: 92 core service test files, 10 GUI route files, 10 API route files, 4 CLI/template files, 8 utility files, and smaller middleware/server/schema/testing groups.
- Found 3 intentional skipped tests in `apps/food/src/__tests__/natural-language-h11z.test.ts`, all documented as future natural-language grocery normalization gaps.

The prior phase evidence in `docs/codebase-review-findings.md` also shows many targeted Vitest runs passing. This pass focused on reviewing coverage shape and gaps rather than rerunning the whole suite.

## Existing Tests That Are Working Well

The strongest existing tests are focused service tests with tight fixtures. They are cheap to run, easy to understand, and protect real business logic.

Good core examples:

- `core/src/services/alerts/__tests__/alert-executor-enhanced.test.ts`
- `core/src/services/reports/__tests__/section-collector.test.ts`
- `core/src/services/data-store/__tests__/data-store-spaces.test.ts`
- `core/src/services/data-store/__tests__/scoped-store.test.ts`
- `core/src/services/context-store/__tests__/context-store.test.ts`
- `core/src/services/router/__tests__/router.test.ts`
- `core/src/services/router/__tests__/router-verification.test.ts`
- `core/src/services/invite/__tests__/index.test.ts`
- `core/src/services/llm/__tests__/llm-guard.test.ts`
- `core/src/services/llm/__tests__/system-llm-guard.test.ts`
- `core/src/services/llm/__tests__/cost-tracker.test.ts`
- `core/src/services/config/__tests__/config.test.ts`
- `core/src/services/scheduler/__tests__/job-failure-notifier.test.ts`

These tests do useful work:

- They verify normal routing, disabled-app rejection before normal dispatch, fallback behavior, verifier hold/route behavior, and LLM error degradation.
- They cover invite creation, validation, redemption, cleanup, and persistence.
- They cover scoped-store traversal checks, data-store space membership, change-log propagation, and context-store CRUD/search behavior.
- They cover LLM guard cap checks, cost-tracker persistence, model selector load/save behavior, and many config parsing paths.
- They cover alert/report action execution and section collection, including path traversal for report app-data sections and alert `write_data` backslash traversal.
- They cover individual scheduler components such as cron registration, one-off persistence, task-runner failure result shaping, and job-failure notifier state.

The GUI and API tests also provide solid regression value. They cover route availability, auth, CSRF, CRUD flows, history paths, malformed IDs, service errors, and some HTML/Markdown escaping helper behavior.

Good GUI/API examples:

- `core/src/gui/__tests__/reports.test.ts`
- `core/src/gui/__tests__/alerts.test.ts`
- `core/src/gui/__tests__/auth.test.ts`
- `core/src/gui/__tests__/csrf.test.ts`
- `core/src/gui/__tests__/security-measures.test.ts`
- `core/src/api/__tests__/alerts-api.test.ts`
- `core/src/api/__tests__/reports-api.test.ts`
- `core/src/api/__tests__/data.test.ts`
- `core/src/api/__tests__/llm.test.ts`

The app-level suite, especially `apps/food`, is broad and practical. It covers stores, natural-language flows, recipe parsing, pantry/grocery logic, nutrition handlers, budget reporting, photo happy paths, ingredient normalization, household logic, event emitters/subscribers, sanitizers, and Telegram Markdown helper behavior.

Good app examples:

- `apps/food/src/__tests__/natural-language.test.ts`
- `apps/food/src/__tests__/photo-handler.test.ts`
- `apps/food/src/__tests__/photo-parsers.test.ts`
- `apps/food/src/__tests__/recipe-parser.test.ts`
- `apps/food/src/__tests__/ingredient-normalizer.test.ts`
- `apps/food/src/__tests__/grocery-store.test.ts`
- `apps/food/src/__tests__/pantry-store.test.ts`
- `apps/food/src/__tests__/handlers/nutrition-handler.test.ts`
- `apps/food/src/__tests__/budget-reporter.test.ts`
- `apps/chatbot/src/__tests__/chatbot.test.ts`
- `apps/chatbot/src/__tests__/conversation-history.test.ts`

The manifest, registry, installer, and CLI tests are also a useful base. They cover schema validation, installer URL/symlink/static-analysis checks, app scaffolding, compatibility checks, registry loading, manifest cache maps, and CLI argument parsing.

Good examples:

- `core/src/schemas/__tests__/validate-manifest.test.ts`
- `core/src/services/app-registry/__tests__/loader.test.ts`
- `core/src/services/app-registry/__tests__/registry.test.ts`
- `core/src/services/app-registry/__tests__/manifest-cache.test.ts`
- `core/src/services/app-installer/__tests__/installer.test.ts`
- `core/src/services/app-installer/__tests__/static-analyzer.test.ts`
- `core/src/cli/__tests__/install-app.test.ts`
- `core/src/cli/__tests__/scaffold-app.test.ts`
- `core/src/cli/__tests__/uninstall-app.test.ts`

## Main Remaining Strategy Gap

The suite is strongest at happy-path units, helpers, and local service contracts. The findings mostly require tests in these missing categories:

- Post-selection authorization tests, where access is checked again after an LLM/verifier/callback chooses a different target.
- True concurrency tests, where two calls overlap before either writes state.
- Cross-layer contract tests, where GUI copy, manifest schema, TypeScript comments, config, or examples must match runtime behavior.
- Production-wiring tests, where the object passed in bootstrap is the same wrapper used in production rather than a bare mock service.
- LLM trust-boundary tests, where model output is treated as hostile data until validated by code.
- Output-context tests, where the assertion matches the exact rendering context: HTML text, HTML attribute, inline JavaScript, JSON in script, Telegram Markdown, or client-side `innerHTML`.
- Date/time edge tests for DST, ISO week 53, calendar boundary weeks, and configured timezone versus UTC.
- Lifecycle and resilience tests that connect individually tested scheduler/failure/shutdown helpers together.

## Missing Test Types By Finding Group

### 1. Authorization After Derived Routing

Would have prevented findings: 1, 6, 15.

Missing tests:

- A router-verifier test where the classifier app is enabled but the verifier-selected app is disabled, asserting the disabled app handler is never invoked.
- A Telegram callback-level verifier test where `resolveCallback()` returns a chosen app that the clicking user cannot access.
- A chatbot `/ask` non-admin test for cost, scheduling, and system questions that proves other users' IDs, cron details, global provider data, and global totals are redacted.
- A food photo-handler test that proves a non-household user cannot mutate shared food state through recipe, pantry, grocery, or receipt photo flows.

Good nearby coverage:

- `router.test.ts` already denies disabled apps on the normal classifier path.
- `router-verification.test.ts` already covers verifier route/hold decisions.
- `chatbot.test.ts` already covers system-data gathering and app-aware prompts.
- `household-guard.test.ts` and text food flows cover household membership concepts.

The missing piece is rechecking authorization after a second component changes the target or data scope.

### 2. Atomicity And Real Concurrent Races

Would have prevented findings: 2, 19, 32.

Missing tests:

- A true `Promise.all` invite redemption test where two users attempt to validate/register/redeem the same code at the same time and exactly one succeeds.
- A router or user-guard integration test that drives two simultaneous `/start <code>` flows.
- A photo grocery-recipe handler test that validates the whole LLM result before any grocery or recipe write, so malformed `parsedRecipe` cannot leave partial side effects.
- A one-off scheduler queue recovery test where one rejected operation is followed by a valid schedule/cancel/check operation and the later operation still runs.

Good nearby coverage:

- `invite/index.test.ts` has broad invite lifecycle coverage, but its "concurrent redemption" case is sequential because the second call observes the first completed redeem.
- `oneoff-manager.test.ts` covers concurrent schedule/cancel serialization, but not recovery after the promise chain rejects.
- `photo-parsers.test.ts` covers invalid JSON and missing recipe fields in some parser paths, but not the handler-level order of side effects.

### 3. LLM Output As Untrusted Input

Would have prevented findings: 4, 16, 17, 18, 19, 20, 27, 28, 29.

Missing tests:

- A chatbot test where a non-admin or unrelated current turn receives a valid `<switch-model .../>` tag from the LLM and `setTierModel()` is not called.
- Exact-enum tests for vision classification, including negated and verbose responses such as "not a recipe, this is a receipt".
- Prompt tests proving photo captions are fenced as untrusted hints and cannot forge role/system instructions.
- Photo recipe and grocery-photo recipe tests asserting every saved recipe ingredient has `canonicalName`.
- Runtime schema/type-guard tests for pantry/grocery/receipt photo items, malformed `parsedRecipe`, and placeholder `"unknown item"` fallbacks.
- Cost-estimator tests for negative, string, missing, non-array, `NaN`, infinite, and absurdly large model-returned costs.
- Price-update tests for negative, zero, huge, missing, and string prices from model output.
- Shelf-life tests for huge values, numeric-prefix strings, ranges, zero, and negative estimates.

Good nearby coverage:

- `recipe-parser.test.ts` has strong text-recipe prompt and canonical-name coverage.
- `sanitize.test.ts` includes a hardened `sanitizeForPrompt()` helper.
- `photo-parsers.test.ts` checks basic parser behavior and some invalid JSON.
- `health-correlator.test.ts` already filters malformed model insight objects.
- `price-store.test.ts` skips bad receipt-derived line item prices, but text price updates remain under-tested.

The strategic improvement is to make every LLM-to-state boundary use table-driven invalid-output tests, not just malformed JSON tests.

### 4. Prompt-Injection Framing For Persisted Context

Would have prevented findings: 5, 17.

Missing tests:

- `buildSystemPrompt()` and `buildAppAwareSystemPrompt()` tests asserting conversation history is explicitly fenced/framed as untrusted data, not only sanitized for triple backticks.
- A saved-history regression containing role text and a switch-model tag, asserting the model is told not to follow instructions inside history.
- Photo caption prompt tests matching the stronger text-recipe prompt framing pattern.

Good nearby coverage:

- `chatbot.test.ts` already verifies context anti-instruction framing and journal sanitization.
- `recipe-parser.test.ts` already proves text recipe input receives stronger prompt-injection treatment.

The gap is persisted conversation/photo-caption data receiving weaker framing than other untrusted prompt sections.

### 5. Manifest And Data-Scope Contract Tests

Would have prevented findings: 3, 7, 37, 40.

Missing tests:

- Manifest data-scope enforcement tests where `forUser().write('test.md')` is rejected when only `notes/` or `log.md` is declared.
- Access-level tests: read-only allows reads but rejects write/append/archive; write/read-write are enforced as designed.
- Shared and space store scope tests proving `sharedScopes` apply consistently.
- Bundled app compatibility tests for echo `log.md`, notes `daily-notes/`, chatbot `history.json`/`daily-notes/`, and food scopes after enforcement.
- A manifest validation or lint test rejecting or warning on app-prefixed scope paths such as `<appId>/...` when runtime stores are already app-rooted.
- A schema-to-service-injection table test proving every schema-listed service ID, including `condition-eval`, maps to the expected `CoreServices` property.
- A duplicate manifest app-id registry test asserting duplicate IDs are rejected before either duplicate module runs `init()`.

Good nearby coverage:

- `scoped-store.test.ts` has good traversal and CRUD behavior.
- `data-store-spaces.test.ts` covers space roots, membership, and change logs.
- `validate-manifest.test.ts` covers schema validity and service enum acceptance.
- `registry.test.ts` covers loading, skipping invalid manifests, init failure isolation, and shutdown.

The missing tests are contract tests between schema/docs/manifests and runtime service injection or store enforcement.

### 6. Path Containment And OS Boundary Tests

Would have prevented finding: 8.

Missing tests:

- Context-store read tests for same-prefix sibling directories such as `../context2/secret` and `../context-backup/secret`.
- GUI context edit-route tests with crafted `key=../context2/secret`.
- Save/remove regression tests that keep same-prefix sibling paths blocked if slugification changes later.

Good nearby coverage:

- `context-store.test.ts` has basic `..` traversal tests and good slug/search/list coverage.
- `section-collector.test.ts` already has a same-prefix app-data path test, which is the right pattern to copy.

The missing detail is Windows-style or same-prefix containment, where a plain `startsWith()` check can look safe but is not.

### 7. Output-Context Encoding And Rendered UI Tests

Would have prevented findings: 9, 21, 41.

Missing tests:

- Formatter tests for recipe titles, ingredients, meal-plan descriptions, grocery/pantry names, child names/foods, guest notes, report data, and alert data containing Telegram Markdown parser characters.
- Integration-style Telegram tests proving the final string sent through `send()`, `sendWithButtons()`, or `editMessage()` is escaped for the selected parse mode or parse mode is disabled.
- Report and alert edit-page render tests with hostile persisted data in every data source emitted into inline scripts: users, apps, reports, n8n URL, and saved action config.
- Assertions that rendered responses do not contain literal attacker-provided `</script><script>` sequences and use script-safe escapes such as `\u003c`.
- Browser/JSDOM or extracted-helper tests proving client-side select builders insert app/user/report names as text rather than parsed `innerHTML`.

Good nearby coverage:

- `security-measures.test.ts` covers generic `escapeHtml()` and `escapeMarkdown()`.
- `reports.test.ts` and `alerts.test.ts` include XSS checks for toggle/test/preview responses.
- `escape-markdown.test.ts` covers the food Markdown escaping helper.

The gap is not generic escaping; it is context-aware escaping at the exact output sink.

### 8. Provider, Cost-Cap, And Production LLM Wiring Tests

Would have prevented findings: 10, 11, 12, 13, 14.

Missing tests:

- Unpriced remote model tests proving unknown remote models are blocked, conservatively charged, or require explicit admin override instead of being recorded as free.
- Guard-level tests where an unpriced remote model under a tiny monthly cap cannot bypass the cap.
- Config tests for OpenAI-only, Google-only, and Ollama-only startup with no `ANTHROPIC_API_KEY`.
- Startup/reconciliation tests where saved `model-selection.yaml` points to a provider that did not register on this boot.
- Monthly cache recovery tests that rebuild current-month totals from `llm-usage.md` when `monthly-costs.yaml` is missing or malformed.
- API LLM route tests wired through the actual `SystemLLMGuard` wrapper used in bootstrap, asserting the intended attribution is `api` or `system`.

Good nearby coverage:

- `llm-guard.test.ts` and `system-llm-guard.test.ts` cover cap behavior well once a cost value exists.
- `cost-tracker.test.ts` covers cost persistence and monthly cache loading.
- `model-selector.test.ts` covers normal saved selection load/save.
- `config.test.ts` covers many provider/tier assignment paths.
- `api/llm.test.ts` validates route inputs and bare `_appId: 'api'` behavior.

Several existing tests actually document the vulnerable current behavior, such as unknown model cost returning zero. Those tests should become policy tests once the desired fail-closed behavior is chosen.

### 9. Date, Numeric, And Accounting Edge-Case Tests

Would have prevented findings: 22, 23, 24, 25, 26, 27, 28, 29, 30, 42.

Missing tests:

- Strict full-token numeric parsing tests for manual macro logs, target shortcut values, and guided target-flow replies: `600abc`, `2000cal`, `1e3`, `150g`.
- Date-only arithmetic tests crossing DST start/end, especially ranges ending near `2026-11-02` in `America/New_York`.
- Health-correlation tests at UTC/local day boundaries, asserting the configured timezone defines "today".
- ISO week tests for `2021-W01 -> 2020-W53`.
- Monthly/yearly budget aggregation tests for weeks spanning month/year boundaries, proving the chosen accounting policy does not double-count or misassign weeks.
- Finite/non-negative/capped numeric tests for cost estimates, price updates, and shelf-life estimates.
- Planner/scheduler config tests proving exposed `meal_types`, `planning_period`, and `plan_generation_day` either affect runtime behavior or are not exposed.
- Alert `write_data.path` tests using the exact GUI placeholder `alert-log/{date}.md`, plus a token contract test shared by UI copy, type comments, validators, and runtime path resolvers.

Good nearby coverage:

- `nutrition-handler.test.ts` covers missing/negative/too-large macro target values.
- `budget-reporter.test.ts` covers normal weekly/monthly/yearly reporting.
- `date-utils.test.ts` covers basic timezone formatting.
- `health-correlator.test.ts` has good LLM output filtering and prompt checks.
- `alert-executor-enhanced.test.ts` covers alert content `{date}` and `write_data` happy path, while `section-collector.test.ts` covers `{today}` and `{yesterday}` path tokens.

The missing cases are boundary values and doc/UI/runtime consistency, not the ordinary happy path.

### 10. Scheduler, Events, And Shutdown Integration Tests

Would have prevented findings: 31, 32, 33, 34, 35.

Missing tests:

- Bootstrap- or `SchedulerServiceImpl`-level tests proving production one-off handler resolution is configured and due one-offs are not silently dropped.
- Negative tests where absent resolver or unknown app/handler leaves a one-off task pending or explicitly failed, rather than removed as if it ran.
- Cron and one-off manager tests wired to `JobFailureNotifier`, asserting `onFailure()`, `onSuccess()`, and `isDisabled()` are used by execution managers.
- EventBus tests registering the same handler to two events and unsubscribing one event without leaking or removing the other.
- Scheduler shutdown tests with in-flight cron/one-off work, asserting shutdown waits for completion or times out by policy before tearing down dependent services.

Good nearby coverage:

- `job-failure-notifier.test.ts` thoroughly tests the notifier itself.
- `task-runner.test.ts` shapes success/failure results correctly.
- `cron-manager.test.ts` and `oneoff-manager.test.ts` cover local registration/persistence/execution mechanics.
- `shutdown.test.ts` covers request draining and service teardown order.
- `event-bus.test.ts` covers ordinary subscribe/unsubscribe behavior.

The missing tests connect the components together along the production lifecycle.

### 11. Production Packaging, CLI, And Installer Smoke Tests

Would have prevented findings: 36, 38, 39.

Missing tests:

- App-loader tests where both `src/index.ts` and `dist/index.js` exist and production-like loading chooses compiled `dist/index.js`.
- Startup-style smoke tests after build that confirm bundled app IDs load under compiled core.
- CLI tests invoking the actual `install-app` main flow, proving permission review happens before copy/install unless `--yes` or `-y` is present.
- Installer planning/dry-run tests proving a permission summary can be generated without copying to `apps/` or running `pnpm install`.
- Root `package.json` script smoke tests verifying documented commands such as `pnpm register-app --help` resolve to real files.

Good nearby coverage:

- `loader.test.ts` covers TypeScript app import and missing module files.
- `install-app.test.ts` parses `--yes`, but does not prove the parsed flag gates installer side effects.
- `installer.test.ts` has strong service-level installation safety checks, including URL validation, symlink rejection, static analysis, and cleanup on dependency install failure.
- `scaffold-app.test.ts` and `uninstall-app.test.ts` cover many CLI helper rules.

The missing tests exercise the command users actually run and the compiled runtime users actually deploy.

## Phase 10 Specific Addendum

The current Phase 10-focused summary remains valid, but it should be understood as one instance of the broader cross-layer pattern.

For Finding 41, the missing tests are context-aware template output tests:

- Render every server template that embeds server-side data into inline JavaScript.
- Seed persisted data with hostile strings that are valid user/app/report/action names, for example `</script><script>window.__pasXss=1</script>`, `<img src=x onerror=alert(1)>`, quotes, apostrophes, ampersands, and backslashes.
- Assert the rendered response does not contain attacker-supplied literal `</script><script>` sequences.
- Assert script-context data serializes dangerous characters as escaped code units rather than relying on `JSON.stringify()` alone.
- Parse the resulting HTML, or run a browser/JSDOM test, and verify hostile input did not create extra executable script tags, event-handler attributes, or extra select options.

For Finding 42, the missing tests are GUI/type/runtime contract tests:

- Use the exact GUI default `alert-log/{date}.md` in an alert executor test with frozen time.
- Assert the created path contains the resolved date and not literal braces.
- Add a token inventory test so UI help text, TypeScript comments, validators, and runtime path resolvers use the same supported path-token list.
- Add a negative test for unknown path tokens, documenting whether they stay literal or are rejected.

## Suggested Immediate Test Backlog

1. Add router-verifier and callback authorization tests for verifier-selected disabled apps.
2. Add true concurrent invite redemption and two-user `/start <code>` integration tests.
3. Add chatbot admin-gating tests for switch-model tags and non-admin system-data redaction.
4. Add manifest data-scope enforcement and bundled-app scope-coordinate compatibility tests.
5. Add context-store same-prefix sibling traversal tests.
6. Add a Telegram output regression corpus for Markdown control characters through food/report/alert formatters.
7. Add unpriced remote model, provider-only startup, saved-model reconciliation, monthly-cache recovery, and API-with-`SystemLLMGuard` tests.
8. Add food photo negative tests for household membership, negated classifier output, caption injection, malformed item schemas, canonical recipe ingredients, and partial side effects.
9. Add strict numeric, DST, ISO week 53, and budget boundary-week tests.
10. Add scheduler integration tests connecting one-off resolver wiring, failure notifier, EventBus unsubscribe semantics, and shutdown draining.
11. Add compiled app-loader, root CLI script smoke, and install confirmation side-effect tests.
12. Add report/alert edit-page script serialization and DOM insertion tests, plus the alert `{date}` path-token contract test.

## Strategic Takeaway

The existing suite has a good service-level spine and strong food-domain breadth. The next quality gain should come from targeted boundary tests rather than generic volume:

- Follow data from user input or persisted storage to the exact runtime sink.
- Exercise production wrappers and bootstrap wiring, not only bare mocks.
- Treat LLM output as untrusted data with schema, range, and authorization tests.
- Keep UI/docs/type comments/manifests synchronized with runtime behavior through contract tests.
- Add a small set of OS/time/concurrency/lifecycle edge cases where ordinary happy-path tests give false confidence.
