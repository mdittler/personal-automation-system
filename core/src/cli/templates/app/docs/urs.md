# {{APP_NAME}} User Requirements Specification

| Field | Value |
|-------|-------|
| **Doc ID** | PAS-URS-APP-{{APP_ID}} |
| **Purpose** | Functional and non-functional requirements with test coverage mapping |
| **Status** | Active |
| **Last Updated** | (date) |

## Conventions

- **Requirement ID format:** `REQ-<AREA>-<NNN>` (e.g., `REQ-CMD-001`)
- **Status values:** `Implemented` | `Planned` | `Deferred`
- **Standard tests** = happy-path behavior verifying the requirement works correctly
- **Edge case tests** = all other tests: boundary conditions, error handling, invalid inputs, empty states, security (injection, unauthorized access), concurrency/timing, state transitions, and configuration (defaults, overrides, missing values)
- **Fixes** section tracks bug corrections with date and description
- **See also** cross-references related requirements to avoid excessive duplication

### Area Codes

| Code | Scope |
|------|-------|
| CMD | Commands and command routing |
| MSG | Message/intent handling |
| DATA | Data storage and retrieval |
| LLM | LLM usage and prompts |
| CONFIG | User configuration |
| INTEG | Integration and cross-app events |

> Update this table to reflect your app's domain areas. See the infrastructure URS (`docs/urs.md` at the project root) for a comprehensive example.

---

## 1. Commands

### REQ-CMD-001: (Example requirement title)

**Status:** Planned

(Describe what must be true when this requirement is satisfied.)

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## Traceability Matrix

| Requirement ID | Test File | Standard Count | Edge Count | Status |
|----------------|-----------|----------------|------------|--------|
| REQ-CMD-001 | TBD | 0 | 0 | Planned |
| **Totals** | **0 test files** | **0** | **0** | **0 tests** |
