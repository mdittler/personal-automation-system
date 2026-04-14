# Space-Aware Food Data Access

## Problem

When a user sends a receipt photo, the bot captures data correctly to `data/users/shared/food/receipts/` and `data/users/shared/food/prices/`. But follow-up NL queries ("how much were diapers at costco?", "break down the items on receipt 2") fail because:

1. **DataQueryService scope isolation**: `getAuthorizedEntries()` in `core/src/services/data-query/index.ts:117` intentionally hides `users/shared/` files when the user belongs to a space. User belongs to `family` space → all shared food data is invisible to NL queries.
2. **Missing routing intents**: Food manifest has no receipt/price query intents, so these messages can't classify to the food app.
3. **Poor discoverability**: Receipt `entity_keys` only contain the store name, not line item names. Price file `entity_keys` lack individual item names.
4. **No receipt review at capture**: Bot only shows item count and total, not actual line items.

## Design

### Principle: Explicit context, no implicit inference

Space resolution happens at the router level (interactive context injection). The food app never looks up active space on its own. Scheduled jobs remain on `forShared('shared')`. DataQueryService scope isolation is preserved unchanged.

### 1. PhotoContext gets space fields

**File:** `core/src/types/telegram.ts`

Add optional `spaceId` and `spaceName` to `PhotoContext`, matching `MessageContext`:

```typescript
export interface PhotoContext {
  userId: string;
  photo: Buffer;
  caption?: string;
  mimeType: string;
  timestamp: Date;
  chatId: number;
  messageId: number;
  spaceId?: string;
  spaceName?: string;
}
```

### 2. Router enriches photo context

**File:** `core/src/services/router/index.ts`

Add `enrichPhotoWithActiveSpace()` that does the same space lookup as `enrichWithActiveSpace()` but operates on `PhotoContext`. Call it in `routePhoto()` before classification and dispatch, so the photo context carries `spaceId` throughout.

The existing `enrichWithActiveSpace` is typed for `MessageContext`. Rather than making it generic (which would require a shared base type or generics), add a parallel method for photos — the logic is 4 lines and duplication is preferable to type gymnastics.

### 3. Food app: `resolveFoodStore()` helper

**File:** `apps/food/src/utils/household-guard.ts`

New function alongside existing `requireHousehold()`:

```typescript
export interface FoodStoreResult {
    household: Household;
    store: ScopedDataStore;
    scope: 'shared' | 'space';
    spaceId?: string;
}

export async function resolveFoodStore(
    services: CoreServices,
    userId: string,
    spaceId?: string,
): Promise<FoodStoreResult | null> {
    // Always check household via shared store (household.yaml lives there)
    const sharedStore = services.data.forShared('shared');
    const household = await loadHousehold(sharedStore);
    if (!household) return null;
    if (!household.members.includes(userId)) return null;

    if (spaceId) {
        return {
            household,
            store: services.data.forSpace(spaceId, userId),
            scope: 'space',
            spaceId,
        };
    }
    return { household, store: sharedStore, scope: 'shared' };
}
```

- `requireHousehold()` is kept for backward compat (scheduled jobs, setup commands). It always returns shared store.
- Interactive handlers migrate from `requireHousehold(services, ctx.userId)` → `resolveFoodStore(services, ctx.userId, ctx.spaceId)`.
- Return field is `store` (not `sharedStore`). All callers rename `hh.sharedStore` → `fh.store`.

### 4. Migrate interactive callers to `resolveFoodStore`

**Scope of change:** All `requireHousehold` calls in interactive handlers (message, command, callback, photo) switch to `resolveFoodStore`. This is ~45 call sites across:

- `apps/food/src/index.ts` — handleMessage, handleCommand, handleCallbackQuery, and all their sub-functions that receive `MessageContext`
- `apps/food/src/handlers/photo.ts` — handlePhoto and sub-handlers
- `apps/food/src/handlers/cook-mode.ts` — handleCookCommand, handleCookMessage, handleCookScheduledJob

**Pattern:**
```typescript
// Before:
const hh = await requireHousehold(services, ctx.userId);
if (!hh) { /* send setup message */ return; }
const list = await loadGroceryList(hh.sharedStore);

// After:
const fh = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
if (!fh) { /* send setup message */ return; }
const list = await loadGroceryList(fh.store);
```

**Exceptions that stay on `requireHousehold`:**
- `handleScheduledJob` in `index.ts` — already uses `services.data.forShared('shared')` directly, not `requireHousehold`. No change needed.
- `cook-mode.ts:285` — `handleCookScheduledJob` is called from `handleScheduledJob` and receives only `userId` (no `MessageContext`). Stays on `requireHousehold`.
- `cook-mode.ts:93,194` — `handleCookCommand` and `handleCookMessage` receive `MessageContext` (which has `spaceId`) and SHOULD migrate to `resolveFoodStore`.

### 5. Interaction recording paths

Update all `interactionContext.record()` calls to use the correct path prefix based on scope:

```typescript
// Before (hardcoded):
filePaths: [`users/shared/food/receipts/${id}.yaml`],
scope: 'shared',

// After (dynamic):
filePaths: [fh.scope === 'space'
    ? `spaces/${fh.spaceId}/food/receipts/${id}.yaml`
    : `users/shared/food/receipts/${id}.yaml`],
scope: fh.scope,
```

Apply to all interaction recording sites in:
- `photo.ts` — receipt_captured
- `index.ts` — price_updated, and any other recording sites

### 6. Receipt frontmatter enrichment

**File:** `apps/food/src/handlers/photo.ts`, `handleReceiptPhoto()`

Enrich `entity_keys` with normalized line item names (capped at 20 to bound metadata):

```typescript
const itemKeys = parsed.lineItems
    .slice(0, 20)
    .map(item => item.name.toLowerCase());
const entityKeys = [parsed.store.toLowerCase(), ...new Set(itemKeys)];

const fm = generateFrontmatter({
    title: `Receipt: ${parsed.store}`,
    date: parsed.date,
    tags: ['food', 'receipt'],
    type: 'receipt',
    entity_keys: entityKeys,
    app: 'food',
});
```

### 7. Price file frontmatter enrichment

**File:** `apps/food/src/services/price-store.ts`, `formatPriceFile()`

Add individual item names to `entity_keys` (capped at 30):

```typescript
const itemKeys = data.items.slice(0, 30).map(i => i.name.toLowerCase());
const entityKeys = [data.store.toLowerCase(), data.slug, ...new Set(itemKeys)];

const fm = generateFrontmatter({
    // ...existing fields...
    entity_keys: entityKeys,
});
```

### 8. Receipt capture response with line items

**File:** `apps/food/src/handlers/photo.ts`, `handleReceiptPhoto()`

Include a concise line-item summary and receipt ID in the Telegram response:

```typescript
// Build line item summary (truncated for readability)
const maxItems = 10;
const itemLines = parsed.lineItems.slice(0, maxItems).map(item =>
    `  ${escapeMarkdown(item.name)}: $${item.totalPrice.toFixed(2)}`
).join('\n');
const moreItems = parsed.lineItems.length > maxItems
    ? `\n  _\\.\\.\\. and ${parsed.lineItems.length - maxItems} more_`
    : '';

await services.telegram.send(
    ctx.userId,
    `🧾 Receipt captured\\! \\(${escapeMarkdown(id)}\\)\n\n` +
    `*${escapeMarkdown(parsed.store)}* — ${escapeMarkdown(parsed.date)}\n` +
    `${itemLines}${moreItems}\n\n` +
    `• ${parsed.lineItems.length} items — Total: $${parsed.total.toFixed(2)}\n` +
    (parsed.tax != null ? `• Tax: $${parsed.tax.toFixed(2)}\n` : '') +
    priceUpdateMsg,
);
```

The receipt ID in the response allows the user to reference it in follow-up queries (e.g., "receipt 2026-04-14-abc123"). The `/edit` command (D2c) already supports editing files found via DataQueryService, so follow-up corrections work if the receipt is discoverable (which it now will be with enriched entity_keys).

### 9. Legacy data migration script

**File:** `scripts/migrate-shared-to-space.ts` (new)

Non-destructive copy from `data/users/shared/food/` → `data/spaces/<spaceId>/food/`.

```
Usage: npx tsx scripts/migrate-shared-to-space.ts <spaceId>
```

Behavior:
- Recursively copies all files from `data/users/shared/food/` to `data/spaces/<spaceId>/food/`
- Skips files that already exist at the destination (no overwrites)
- Reports: files copied, files skipped, errors
- Does NOT delete originals
- Validates spaceId exists in `data/system/spaces.yaml` before proceeding

Directories to copy: `receipts/`, `prices/`, `recipes/`, `photos/`, `pantry/`, `grocery-list.md`, `meal-plan/`, `freezer.yaml`, `leftovers.yaml`, `household.yaml`, `children/`, `guests.yaml`, `seasonal/`, `cultural-calendar.yaml`, `waste-log.yaml`, `cost-history/`.

### 10. Food manifest intents

**File:** `apps/food/manifest.yaml`

Add after line 36 ("user wants to see food spending"):

```yaml
      - "user wants to see receipt details or look up items from a receipt"
      - "user asks about prices at a specific store"
```

### What does NOT change

- **DataQueryService** — scope isolation preserved. No shared-file visibility fallback.
- **Scheduled jobs** — continue using `services.data.forShared('shared')` directly. Per-space scheduled jobs are future work.
- **InteractionContextService** — remains in-memory with 10-min TTL. Not persisted across restarts.
- **`requireHousehold()`** — kept as-is for backward compatibility (scheduled jobs, setup commands).

## Files Modified

| File | Change |
|------|--------|
| `core/src/types/telegram.ts` | Add `spaceId?`, `spaceName?` to `PhotoContext` |
| `core/src/services/router/index.ts` | Add `enrichPhotoWithActiveSpace()`, call in `routePhoto()` |
| `apps/food/src/utils/household-guard.ts` | Add `resolveFoodStore()` + `FoodStoreResult` type |
| `apps/food/src/index.ts` | Migrate ~40 `requireHousehold` → `resolveFoodStore`, rename `hh.sharedStore` → `fh.store` |
| `apps/food/src/handlers/photo.ts` | Space-aware store, enriched entity_keys, line-item response |
| `apps/food/src/handlers/cook-mode.ts` | Migrate interactive `requireHousehold` calls |
| `apps/food/src/services/price-store.ts` | Enriched entity_keys with item names |
| `apps/food/manifest.yaml` | Add receipt/price query intents |
| `scripts/migrate-shared-to-space.ts` | New migration script |

## Tests

| Test file | What to test |
|-----------|-------------|
| `core/src/services/router/__tests__/` | Photo context carries `spaceId` after routing |
| `apps/food/src/__tests__/household-guard.test.ts` | `resolveFoodStore` returns space-scoped store when spaceId present, shared store when absent |
| `apps/food/src/__tests__/photo-handler.test.ts` (or similar) | Receipt photo with `spaceId: 'family'` writes to `spaces/family/food/receipts/...` |
| `apps/food/src/__tests__/interaction-recording.test.ts` (or similar) | Interaction filePaths are space-scoped when spaceId present |
| `core/src/services/data-query/__tests__/data-query.test.ts` | Space member can query space-scoped receipt/price files; keep existing test that hides shared for space members |
| `apps/food/src/__tests__/` | entity_keys on receipt and price files include item names |

## Verification

1. Run focused tests: `pnpm exec vitest run core/src/services/data-query/ core/src/services/router/ apps/food/src/__tests__/household-guard`
2. Run full suite: `pnpm test` (expect 6272+ tests passing)
3. Manual validation:
   - User is in `/space family`
   - Send a Costco receipt photo labeled "receipt 2"
   - Receipt saved under `data/spaces/family/food/receipts/`
   - Price file updated under `data/spaces/family/food/prices/`
   - Bot response includes line items for review
   - "break down the items on receipt 2" returns saved data
   - "how much were diapers at Costco last time?" returns price data
