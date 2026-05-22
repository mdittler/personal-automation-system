---
name: pas-urs-workflow
description: PAS project URS (User Requirements Specification) workflow. How to add requirements, tests, and fixes to docs/urs.md and the traceability matrix. Use when updating the URS after implementing a feature or fix.
---

# PAS URS Workflow

Use when adding or updating entries in `docs/urs.md` after implementing features, fixes, or test coverage.

---

## Document Structure

Each requirement section follows this format:

```markdown
### REQ-XXX-NNN: Short description

**Phase:** N | **Status:** Implemented

Description of what the requirement covers.

**Standard tests:**
- `test-file.test.ts` > Describe block > test name

**Edge case tests:**
- `test-file.test.ts` > Describe block > edge test name

**Error handling tests:**
- `test-file.test.ts` > Describe block > error test name

**Security tests:**
- `test-file.test.ts` > Describe block > security test name

**Fixes:**
- **D14 (2026-04-13):** Description of what changed. CL: label.
```

Not all sections are required — include only the categories that apply.

---

## Test Name Format

Test references use the exact hierarchy from Vitest describe/it nesting:

```
`file.test.ts` > OuterDescribe > InnerDescribe > it name
```

Example: `alert-service.test.ts` > CRUD > creates and retrieves an alert

Use the exact `it(...)` string — do not paraphrase.

---

## Traceability Matrix

The matrix lives near the end of `docs/urs.md` under `## Traceability Matrix`. Columns are:

| Requirement | Test File(s) | Std | Edge | Status |

- **Std** = count of standard (happy path) tests
- **Edge** = count of edge case + error handling + security + concurrency tests
- Multiple test files are comma-separated

**To count tests:** grep the test file for `it(` and categorize each test. Do not use arithmetic from memory — recount from the actual file after edits.

---

## Adding a New Requirement

1. Find the appropriate phase section in `docs/urs.md`
2. Add a new `### REQ-XXX-NNN:` section with description + tests
3. Add a row to the traceability matrix
4. Update the **Totals** row — recount from all modified files

---

## Updating an Existing Requirement

1. Find the requirement by heading (use `grep '### REQ-XXX-NNN'`) — not by line number
2. Add new tests under the appropriate category sub-section
3. If a test name changed (e.g. bug fix renamed a test), update the old name
4. Update the **Fixes:** sub-section with the fix description and CL label
5. Update the traceability matrix row counts

---

## Fixes Format

Each fix entry:
```
- **DNN (YYYY-MM-DD):** What changed and why. CL: <label>.
```

- **DNN** = deferred issue number (D14, D39, etc.) or finding number (F41, etc.)
- **CL** = change label (e.g. `D14-fix`, `D39-fix`, `CR9-fix`)

---

## Totals Row Update

After all matrix edits, update:
```
| **Totals** | **N test files** | **std** | **edge** | **total tests** |
```

- Count distinct test file names that appear anywhere in the matrix
- Sum all Std and Edge columns
- Total = Std + Edge

---

## Common Mistakes

- Using line numbers as anchors — they shift with every edit. Use `### REQ-XXX-NNN` headings.
- Using arithmetic instead of recounting — always grep the actual test file after edits.
- Paraphrasing test names — use the exact string from `it(...)`.
- Forgetting to update the Totals row after adding files/tests.
