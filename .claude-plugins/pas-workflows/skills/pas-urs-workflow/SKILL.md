---
name: pas-urs-workflow
description: URS requirement tracking, traceability matrix, and error fix tracking. Use when adding features, completing phases, or fixing bugs that need requirement traceability.
---

# PAS URS Workflow

`docs/urs.md` is a living document — update it during every session that adds, changes, or removes functionality.

## Requirement-Driven Development

### Before Implementation
1. Identify all user requirements for the work
2. Add them to `docs/urs.md` with status `Planned`
3. Each requirement must list expected tests across relevant categories (see `pas-testing-standards` skill for the category checklist)
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
