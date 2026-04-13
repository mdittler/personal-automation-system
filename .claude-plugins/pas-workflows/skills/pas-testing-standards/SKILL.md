---
name: pas-testing-standards
description: PAS-specific testing patterns and conventions. Use when writing tests in the Personal Automation System. Also apply the global testing-standards skill for universal rules.
---

# PAS Testing Patterns

These are the PAS-specific conventions for structuring test files. Also apply the global `testing-standards` skill for the category checklist and trust-boundary rules.

---

## File Naming and Location

- All test files: `__tests__/<name>.test.ts` co-located with source
- Integration tests: `__tests__/<name>.integration.test.ts`
- Sub-area tests (e.g. food handlers): `__tests__/handlers/<name>.test.ts`

## Imports

Vitest globals are disabled — always import explicitly:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```

## Mocking CoreServices (App Tests)

Use the central mock factory. This is the dominant pattern for all app-level tests:

```typescript
import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';

let services: CoreServices;
beforeEach(() => {
  services = createMockCoreServices();
});
```

Core service tests (testing internal components) use inline ad-hoc mocks instead — do not reach for `createMockCoreServices()` when testing a core service's internals.

Override specific methods:

```typescript
services = createMockCoreServices({
  telegram: { send: vi.fn().mockRejectedValue(new Error('network')) },
});
```

## Mocking ScopedStore

```typescript
import { createMockScopedStore } from '@pas/core/testing';

const store = createMockScopedStore({
  read: vi.fn().mockResolvedValue('# Active\n- item'),
  list: vi.fn().mockResolvedValue(['file.md']),
});
```

Defaults: `read → ''`, `write/append/archive → undefined`, `exists → false`, `list → []`.

## Context Factories

```typescript
import { createTestMessageContext, createTestPhotoContext } from '@pas/core/testing/helpers';

const ctx = createTestMessageContext({ userId: 'user-123', text: 'show me recipes' });
const photo = createTestPhotoContext(); // fake JPEG buffer, image/jpeg
```

## Domain Object Factory Pattern

For complex domain objects, define a `make<Thing>` factory at the top of the test file:

```typescript
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'chicken-stir-fry-abc',
    title: 'Chicken Stir Fry',
    ingredients: [],
    servings: 4,
    ...overrides,
  };
}
```

Use `as never` (not `as any`) when passing partial mocks to typed parameters.

## Filesystem Tests (DataStore, ChangeLog, etc.)

Use real temp directories — never mock the filesystem for DataStore tests:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pas-test-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
```

Temp dir prefix must start with `pas-` (e.g. `pas-test-`, `pas-gui-spaces-`, `pas-api-alerts-`).

## HTTP Route Tests

**GUI routes** — build a real Fastify instance with auth/CSRF middleware, use `app.inject()`, extract CSRF token via `authenticatedGet()`/`authenticatedPost()` helpers:

```typescript
const res = await authenticatedPost(app, '/gui/spaces', { name: 'family' });
expect(res.statusCode).toBe(302);
```

Assert on `statusCode`, `res.body` (HTML via `toContain`), `res.headers.location` (redirects), and mock service calls.

**API routes** — use `app.inject()` with a Bearer token header:

```typescript
const res = await app.inject({
  method: 'POST',
  url: '/api/data',
  headers: { authorization: 'Bearer test-token' },
  payload: { appId: 'food', key: 'pantry', content: '...' },
});
expect(res.json()).toEqual(expect.objectContaining({ ok: true }));
```

Always test auth (401), validation (400), not-found (404), and error (500) paths alongside happy paths.

## Loggers

Suppress all logger output in tests:

```typescript
import pino from 'pino';
const logger = pino({ level: 'silent' });
// or
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
```

## vi.mock() Usage

Use sparingly. Place module-level mock declarations before imports (vitest hoists them). Use only when:
- Mocking external SDKs (`@anthropic-ai/sdk`, `openai`)
- Mocking sibling modules to isolate a handler from a flow it calls

## What Does Not Exist (Don't Add)

- No `__mocks__/` directories
- No snapshot tests
- No shared `fixtures/` directory
- No test-specific `.env` files — tests must not require real API keys
