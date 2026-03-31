---
name: pas-testing-standards
description: PAS testing thoroughness standards, URS workflow, and error fix tracking. Use when implementing features, writing tests, fixing bugs, or completing phases.
---

# PAS Testing Standards

This skill defines the testing and requirements workflow for the Personal Automation System. Follow these standards whenever writing tests, implementing features, or fixing bugs.

## Test Category Checklist

Every new feature or service must be tested across **all applicable** categories:

| Category | What to Test |
|----------|-------------|
| **Standard (happy path)** | Normal usage, expected inputs, correct behavior |
| **Edge cases** | Boundary values, empty inputs, null/undefined, zero, max values, off-by-one |
| **Error handling** | Invalid inputs, network failures, thrown exceptions, malformed data |
| **Security** | Injection attempts (XSS, path traversal, prompt injection), unauthorized access, input validation bypass |
| **Concurrency/timing** | Race conditions, cooldown windows, cache expiry, timeout behavior |
| **State transitions** | Reset after success, re-enable after disable, count rollover, idempotency |
| **Configuration** | Defaults, overrides, invalid config, missing optional values |

Not every category applies to every feature — use judgment. But default to writing **more** tests, not fewer. If a test would be considered best practice, write it.

## Requirement-Driven Development

`docs/urs.md` is a living document — update it during every session that adds, changes, or removes functionality.

### Before Implementation
1. Identify all user requirements for the work
2. Add them to `docs/urs.md` with status `Planned`
3. Each requirement must list expected tests across relevant categories from the checklist above
4. If a requirement is unclear, ask the user before adding it

### After Implementation
1. Update requirement status from `Planned` to `Implemented`
2. Replace TBD test lists with actual test references (`file.test.ts` > `describe` > `test name`)
3. Add or update the traceability matrix row (test file, standard count, edge count, status)
4. Update the **Totals** row at the bottom of the matrix

### Rules
- Duplicate test references across requirements are acceptable; use "See also: REQ-XXX-NNN" when cross-referencing gets complex
- When tests are added outside of a phase (e.g., gap review, refactoring), add corresponding URS entries and update the matrix in the same session

## Error Fix Tracking

When a bug is found and fixed:
1. Add a `**Fixes:**` entry to the affected requirement in `docs/urs.md` with: date, brief description, and the Change Log entry reference
2. Update any deferred issue lists to mark items as resolved when fixed

## Traceability Matrix Format

Each row in the matrix at the bottom of `docs/urs.md`:

| Requirement | Test File | Std | Edge | Status |
|-------------|-----------|-----|------|--------|

Keep the **Totals** row accurate after every update.
