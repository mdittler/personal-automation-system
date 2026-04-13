# Phase R3: Data Boundaries, Scopes, and Path Containment

## Context

The codebase security review (Phase 3 of `docs/codebase-review-findings.md`) identified four findings related to data boundaries. This phase addresses three of them — F3, F7, and F8. F9 (Telegram markdown escaping) is deferred to a separate phase due to its ~100+ call site scope.

**Problem:** Apps can read/write any path within their data directory regardless of what their manifest declares. The manifest `data_scopes` are purely advisory. Additionally, the context store uses a string prefix check for path containment that fails on sibling directories (e.g. `context2` passes a check for `context`).

**Goal:** Make manifest data scopes enforceable at the operation level, and fix the context store path traversal.

## Findings Addressed

| Finding | Severity | Summary |
|---------|----------|---------|
| F3 | medium | Manifest data scopes are advisory only — ScopedStore does not enforce declared scopes or access levels |
| F7 | medium | Three app manifests use `{appId}/path` convention while runtime uses app-root-relative paths — enforcement would break legitimate writes |
| F8 | medium | Context store `readEntry()` uses `startsWith` for path containment, allowing sibling directory escape |

**Deferred:** F9 (Telegram markdown escaping inconsistency) — separate phase.

## Design

### F7: Normalize Manifest Scope Paths

Fix the coordinate system mismatch before wiring enforcement. The correct convention is app-root-relative (matching `ScopedStore.baseDir` which is already `data/users/{userId}/{appId}/`).

**Manifest changes:**

| App | Current path | Corrected path |
|-----|-------------|----------------|
| echo | `echo/log.md` | `log.md` |
| notes | `notes/daily-notes/` | `daily-notes/` |
| chatbot | `chatbot/history.json` | `history.json` |
| chatbot | `chatbot/daily-notes/` | `daily-notes/` |
| food | (already correct) | (no change) |

**Validation:** Add a manifest validation warning when a scope path starts with the declaring app's ID followed by `/`. This catches future regressions. Location: the manifest validation logic that runs at app load time.

**Docs:** Update `docs/MANIFEST_REFERENCE.md` examples if any show the `{appId}/` prefix pattern.

### F3: Wire Scope Enforcement Into ScopedStore

**Core change:** `ScopedStore` receives declared scopes and checks them on every operation.

**New types and errors (`core/src/services/data-store/paths.ts`):**

```typescript
export class ScopeViolationError extends Error {
    constructor(
        public readonly attemptedPath: string,
        public readonly operation: string,
        public readonly appId: string,
    ) {
        super(`Scope violation: app "${appId}" attempted ${operation} on "${attemptedPath}" outside declared scopes`);
        this.name = 'ScopeViolationError';
    }
}

export function findMatchingScope(
    path: string,
    scopes: ManifestDataScope[],
): ManifestDataScope | undefined {
    // Normalize to forward slashes for comparison
    // Check exact file match or directory prefix match
    // Return the matching scope with its access level
}
```

**ScopedStoreOptions extension:**

```typescript
export interface ScopedStoreOptions {
    // ... existing fields ...
    /** Manifest-declared scopes. Empty = no enforcement (API trust). */
    scopes?: ManifestDataScope[];
    /** App ID used for error messages in scope violations. */
    appId: string; // already exists
}
```

**Enforcement logic in ScopedStore:**

```typescript
private checkScope(relativePath: string, operation: 'read' | 'write'): void {
    if (!this.scopes || this.scopes.length === 0) return; // no enforcement

    const scope = findMatchingScope(relativePath, this.scopes);
    if (!scope) {
        throw new ScopeViolationError(relativePath, operation, this.appId);
    }

    // Check access level
    if (operation === 'write' && scope.access === 'read') {
        throw new ScopeViolationError(relativePath, operation, this.appId);
    }
    if (operation === 'read' && scope.access === 'write') {
        throw new ScopeViolationError(relativePath, operation, this.appId);
    }
    // 'read-write' allows both
}
```

**Operation mapping:**
- `read()`, `exists()`, `list()` → `checkScope(path, 'read')`
- `write()`, `append()`, `archive()` → `checkScope(path, 'write')`

**DataStoreServiceImpl changes:**
- Store full `ManifestDataScope[]` arrays (not just path strings)
- `forUser()` passes `userScopes` to ScopedStore
- `forShared()` / `forSpace()` pass `sharedScopes` to ScopedStore
- Remove the "Phase 5 enforcement" NOTE comment
- Remove `isAllowedUserPath()` and `isAllowedSharedPath()` (replaced by ScopedStore enforcement)

**API bypass preserved:** The API data route already passes `userScopes: []` and `sharedScopes: []`. When scopes are empty, `checkScope()` returns immediately — no enforcement. The existing comment documents this intent.

### F8: Fix Context Store Path Containment

**`readEntry()` fix:** Replace `startsWith` with `relative()`-based containment:

```typescript
private async readEntry(dir: string, key: string): Promise<string | null> {
    // Validate key format (same as save/remove)
    const slug = slugifyKey(key);
    if (!slug || !SLUG_PATTERN.test(slug)) {
        this.logger.warn({ key }, 'Context store key failed slug validation');
        return null;
    }

    const filePath = resolve(join(dir, `${slug}.md`));
    const rel = relative(dir, filePath);
    if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
        this.logger.warn({ key }, 'Context store key attempted path traversal');
        return null;
    }
    // ... read file ...
}
```

**Key behavioral change:** `readEntry()` now slugifies the key, meaning `get('My Notes')` and `get('my-notes')` produce the same lookup. This aligns with save/remove behavior where the key is always slugified before storage.

**`save()` and `remove()` hardening:** Replace their `startsWith` checks with the same `relative()`-based pattern for consistency:

```typescript
const rel = relative(dir, filePath);
if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
    throw new Error('Path traversal detected');
}
```

These are already safe via slugification, but this provides defense-in-depth.

## Files Modified

| File | Change |
|------|--------|
| `apps/echo/manifest.yaml` | Fix scope path: `echo/log.md` → `log.md` |
| `apps/notes/manifest.yaml` | Fix scope path: `notes/daily-notes/` → `daily-notes/` |
| `apps/chatbot/manifest.yaml` | Fix scope paths: remove `chatbot/` prefix |
| `core/src/services/data-store/paths.ts` | Add `ScopeViolationError`, `findMatchingScope()` |
| `core/src/services/data-store/scoped-store.ts` | Add `scopes` to options, add `checkScope()`, call it in all 6 operations |
| `core/src/services/data-store/index.ts` | Store full `ManifestDataScope[]`, pass to ScopedStore, remove advisory methods |
| `core/src/services/context-store/index.ts` | Fix `readEntry()` with slug+relative check, harden save/remove |
| `core/src/gui/routes/context.ts` | No changes needed (fixed via readEntry) |

## Test Plan

**F7 tests:**
- Verify each bundled app's manifest scope paths match their runtime data access patterns
- Add manifest validation test: scope path starting with `{appId}/` produces a warning

**F3 tests:**
- ScopedStore with `scopes: [{ path: 'notes/', access: 'read-write' }]`: write to `notes/foo.md` succeeds, write to `test.md` throws ScopeViolationError
- Read-only scope: `read()` succeeds, `write()`/`append()`/`archive()` throw
- Write-only scope: `write()` succeeds, `read()` throws
- Empty scopes (API case): all operations succeed
- `list()` within declared scope succeeds, outside scope throws
- Regression tests for echo (`log.md`), notes (`daily-notes/`), chatbot (`history.json`, `daily-notes/`) under enforced scopes

**F8 tests:**
- `get('../context2/secret')` returns null even when sibling file exists
- `getForUser('../context2/secret', userId)` returns null
- `save()` with traversal key still throws
- `remove()` with traversal key still throws
- `readEntry()` with non-slug key (e.g. `My Notes`) resolves via slugification

## Verification

1. Run `pnpm test` — all tests pass
2. Run `pnpm build` — clean compile
3. Verify the corrected manifests load without warnings at startup
4. Verify food app data operations work correctly (largest scope declaration surface)
