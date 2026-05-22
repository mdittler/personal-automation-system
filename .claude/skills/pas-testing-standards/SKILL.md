---
name: pas-testing-standards
description: Universal testing standards for TypeScript/Node projects. Category checklist (happy path, edge cases, security, concurrency, state, config) and trust-boundary rules (LLM output, post-routing auth, output encoding, contract tests, concurrency, date/numeric edges).
---

# Testing Standards

Apply these standards when writing tests in any TypeScript/Node project.

---

## Test Category Checklist

Every new feature or service must be tested across **all applicable** categories:

| Category | What to Test |
|----------|-------------|
| **Happy path** | Normal usage, expected inputs, correct behavior |
| **Edge cases** | Boundary values, empty inputs, null/undefined, zero, max values, off-by-one |
| **Error handling** | Invalid inputs, network failures, thrown exceptions, malformed data |
| **Security** | Injection (XSS, path traversal, prompt injection), unauthorized access, input validation bypass |
| **Concurrency/timing** | Race conditions, overlapping writes, cooldown windows, cache expiry, timeout behavior |
| **State transitions** | Reset after success, re-enable after disable, count rollover, idempotency |
| **Configuration** | Defaults, overrides, invalid config, missing optional values |

Default to more tests, not fewer. If a test would be considered best practice, write it.

---

## Trust Boundary & Cross-Layer Testing Rules

These categories are systematically undertested in most projects. Apply them whenever writing tests at a boundary between two layers.

### 1. LLM Output Is Untrusted Data

Every place LLM output is used to write state needs **table-driven invalid-output tests** — not just malformed JSON tests.

For each LLM→state boundary, test all of: wrong types, negative numbers, `NaN`, `Infinity`, absurdly large values, missing required fields, extra unexpected fields, placeholder strings (`"unknown"`, `""`), and enum values outside the expected set.

**Rule:** Invalid LLM output must be rejected or safely defaulted. It must never be written to state in a corrupt form.

Examples:
- Cost estimator returns `"free"`, `-5`, `NaN`, `1e20` → blocked, not stored
- Vision classifier returns a verbose non-enum response → rejected, not treated as a valid classification
- Required field missing from structured output → write rejected, not stored as partial record
- Enum value outside valid set → rejected, not stored as-is

### 2. Post-Routing Authorization

When a second component (verifier, callback resolver, classifier, middleware) changes the routing target, authorization must be rechecked against the **new** target — not just the original.

**Rule:** For each routing handoff, write a test where the secondary component selects a different target than the primary, and assert the result is correct for the secondary target.

Examples:
- Classifier picks handler A (authorized) → verifier redirects to handler B (unauthorized) → handler B must NOT run
- A callback resolver picks a resource the calling user cannot access → access must be denied
- Middleware rewrites the request destination mid-flight → downstream auth applies to the rewritten destination

### 3. Output-Context Encoding

Assertions must match the **exact rendering sink**, not just "escaping happens somewhere."

| Sink | Required test |
|------|--------------|
| HTML text content | Escaping applied before all renders |
| HTML attribute | Values are properly quoted and escaped |
| Inline `<script>` | Dangerous characters serialized as `\u003c`/`\u003e`/`\u0026`, not `<`/`>`/`&` |
| JSON in script tags | `JSON.stringify` alone is not safe — use unicode escapes for `<`, `>`, `&` |
| DOM `innerHTML` | Client-side builders insert untrusted values as `.textContent`, not `innerHTML` |
| Messaging APIs | Escaping matches the parse mode of the target API (Markdown, HTML, plain text) |

Seed persisted data with hostile strings (e.g. `</script><script>window.__xss=1</script>`, `<img onerror=alert(1)>`, quotes, backslashes) and assert the rendered output does not contain attacker-supplied executable content.

### 4. Contract Tests

Schema, docs, UI copy, and runtime behavior must stay synchronized. Test the contracts explicitly rather than trusting they stay in sync manually.

- **Declared capabilities match runtime enforcement** — what a manifest/schema declares as allowed must match what the runtime actually enforces
- **UI placeholder tokens** — tokens shown in UI (e.g. `{date}`, `{user}`) must resolve correctly at runtime; test with frozen time/data
- **Duplicate ID rejection** — registries must reject duplicate IDs before any duplicate handler runs
- **Schema service IDs** — every service identifier in a schema must map to a real runtime property
- **Doc examples** — example values in docs/comments must work if copy-pasted into a real config

### 5. Production Wiring Tests

Testing a component in isolation is not enough if the production composition is never tested.

**Rule:** For each major subsystem, write at least one integration test that uses the real wrapper/guard from production configuration, not a bare mock.

Examples:
- API routes: wire through the actual auth guard used in production, assert attribution is correct
- Scheduler: use the production handler resolver, assert due tasks are not silently dropped on unknown app/handler
- External service clients: test with the real retry/rate-limit wrapper, not just the raw client

These tests often live in `*.integration.test.ts` files.

### 6. Real Concurrency Tests

Concurrency tests must use `Promise.all` where two calls genuinely overlap before either writes state — not sequential calls where the second observes the first's result.

```typescript
// Wrong — second call sees first call's completed state
await doThing('resource', 'caller1');
await doThing('resource', 'caller2'); // observes already-modified state

// Right — both calls overlap before either writes
const [r1, r2] = await Promise.all([
  doThing('resource', 'caller1'),
  doThing('resource', 'caller2'),
]);
// Assert exactly one won and one lost
```

Examples:
- Redemption/claim flows: two simultaneous calls → exactly one succeeds
- Queue operations: rejected operation followed by a valid one → valid one still executes
- Write-then-read races: interleaved writes must not corrupt the read result

### 7. Date, Time, and Numeric Edge Cases

These give false confidence when only the happy path is tested.

**Numeric parsing — reject partial parses:**
- Inputs like `600abc`, `2000cal`, `1e3`, `150g` must be rejected as invalid
- Use `Number()` + `isFinite()` or strict regex; never rely on `parseInt()`/`parseFloat()` alone for validated inputs

**Date/time boundaries:**
- DST start/end: date-range arithmetic crossing clock changes must produce correct day counts
- ISO week 53: week-based grouping must handle years where the last week is W53 (e.g. 2020)
- Month/year boundaries: weekly aggregations must not double-count or mis-assign weeks that span month/year end
- Timezone-aware "today": operations that define "today" must use the configured timezone, not UTC

**Numeric validity for externally-derived values:**
- Finite, non-negative, and capped: reject `NaN`, `Infinity`, negative, and absurdly large values
- These checks apply to any value arriving from LLM output, user input, or external APIs

---

## General Guidelines

### Zero Failures Policy

Full test suite must pass with zero failures at all times. Fix the code or the test — never skip, mark todo, or dismiss failures.

### Time-Sensitive Tests

Never hardcode absolute dates in tests that compare against "today." Use relative time so tests don't rot:

```typescript
// Wrong
const date = new Date('2024-01-01');

// Right
const date = new Date(Date.now() - 86400000); // yesterday
```

### Filesystem Tests

For tests touching the filesystem, use real temp dirs — never mock I/O at the layer you're testing:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'test-<feature>-')); });
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });
```

### Load-Time Validation Tests

To test how a service handles corrupt or structurally invalid persisted data, write the raw file directly to disk (bypassing the service's write path), then call the service's load/init method:

```typescript
// Write invalid data directly, bypassing service validation
await mkdir(join(tempDir, 'data'), { recursive: true });
await writeFile(join(tempDir, 'data', 'record.yaml'), 'invalid: [[[corrupt yaml');

// Then test how the service handles it at load time
await service.init();
expect(service.list()).toHaveLength(0); // or assert warning logged, etc.
```
