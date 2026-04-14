# Space-Aware Food Data Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make food app data writes space-scoped when the user is in an active space, so NL queries via DataQueryService can discover receipt, price, and all other food data.

**Architecture:** Router injects active space into PhotoContext and CallbackContext (matching existing MessageContext pattern). New `resolveFoodStore()` helper in the food app resolves the correct ScopedDataStore based on explicit spaceId. All interactive food handlers migrate from `requireHousehold()` to `resolveFoodStore()`. Scheduled jobs remain on shared store. Legacy data migrated via script.

**Tech Stack:** TypeScript 5.x, ESM, Vitest, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`

---

### Task 1: Add spaceId/spaceName to PhotoContext and CallbackContext

**Files:**
- Modify: `core/src/types/telegram.ts:27-42` (PhotoContext) and `core/src/types/telegram.ts:57-61` (CallbackContext)

- [ ] **Step 1: Add fields to PhotoContext**

In `core/src/types/telegram.ts`, add `spaceId` and `spaceName` to `PhotoContext` after the `messageId` field:

```typescript
export interface PhotoContext {
	/** Telegram user ID of the sender. */
	userId: string;
	/** The photo data. */
	photo: Buffer;
	/** Optional caption attached to the photo. */
	caption?: string;
	/** MIME type of the photo (e.g. image/jpeg). */
	mimeType: string;
	/** When the message was sent. */
	timestamp: Date;
	/** Telegram chat ID. */
	chatId: number;
	/** Telegram message ID. */
	messageId: number;
	/** Active space ID (set by router when user is in space mode). */
	spaceId?: string;
	/** Active space display name. */
	spaceName?: string;
}
```

- [ ] **Step 2: Add fields to CallbackContext**

In the same file, add `spaceId` and `spaceName` to `CallbackContext`:

```typescript
/** Context passed to app callback handlers. */
export interface CallbackContext {
	userId: string;
	chatId: number;
	messageId: number; // the message the button was on
	/** Active space ID (set by bootstrap when user is in space mode). */
	spaceId?: string;
	/** Active space display name. */
	spaceName?: string;
}
```

- [ ] **Step 3: Build to verify no type errors**

Run: `pnpm build`
Expected: SUCCESS — fields are optional, so all existing code continues to compile.

- [ ] **Step 4: Commit**

```bash
git add core/src/types/telegram.ts
git commit -m "feat: add spaceId/spaceName to PhotoContext and CallbackContext"
```

---

### Task 2: Router injects active space into photo context

**Files:**
- Modify: `core/src/services/router/index.ts:253-323` (routePhoto) and `core/src/services/router/index.ts:466-476` (enrichWithActiveSpace area)
- Test: `core/src/services/router/__tests__/router-spaces.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `'active space injection'` describe block in `core/src/services/router/__tests__/router-spaces.test.ts`:

```typescript
it('injects spaceId and spaceName into photo context', async () => {
	const spaceService = createMockSpaceService({
		getActiveSpace: vi.fn().mockReturnValue('family'),
		getSpace: vi.fn().mockReturnValue({
			id: 'family',
			name: 'Family',
			members: ['user1'],
			createdBy: 'user1',
			createdAt: '',
			description: '',
		}),
	});
	const photoModule = createMockModule();
	const photoManifest: AppManifest = {
		...echoManifest,
		app: { ...echoManifest.app, id: 'food' },
		capabilities: {
			...echoManifest.capabilities,
			photos: { types: ['receipt'] },
		},
	};
	const router = buildRouter({
		spaceService,
		apps: [{ manifest: photoManifest, module: photoModule }],
	});

	const photoCtx = {
		userId: 'user1',
		photo: Buffer.from('test'),
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1,
		messageId: 1,
		caption: 'receipt',
	};

	// Mock the photo classifier to return a match
	vi.mocked(llm.classify).mockResolvedValueOnce({
		category: 'food',
		confidence: 0.95,
	});

	await router.routePhoto(photoCtx);

	const call = vi.mocked(photoModule.handlePhoto!).mock.calls[0];
	expect(call).toBeDefined();
	expect(call![0].spaceId).toBe('family');
	expect(call![0].spaceName).toBe('Family');
});

it('does not inject space into photo context when no active space', async () => {
	const spaceService = createMockSpaceService({
		getActiveSpace: vi.fn().mockReturnValue(null),
	});
	const photoModule = createMockModule();
	const photoManifest: AppManifest = {
		...echoManifest,
		app: { ...echoManifest.app, id: 'food' },
		capabilities: {
			...echoManifest.capabilities,
			photos: { types: ['receipt'] },
		},
	};
	const router = buildRouter({
		spaceService,
		apps: [{ manifest: photoManifest, module: photoModule }],
	});

	const photoCtx = {
		userId: 'user1',
		photo: Buffer.from('test'),
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1,
		messageId: 1,
		caption: 'receipt',
	};

	vi.mocked(llm.classify).mockResolvedValueOnce({
		category: 'food',
		confidence: 0.95,
	});

	await router.routePhoto(photoCtx);

	const call = vi.mocked(photoModule.handlePhoto!).mock.calls[0];
	expect(call).toBeDefined();
	expect(call![0].spaceId).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run core/src/services/router/__tests__/router-spaces.test.ts`
Expected: FAIL — `spaceId` is undefined because `routePhoto` doesn't inject it yet.

- [ ] **Step 3: Add enrichPhotoWithActiveSpace method**

In `core/src/services/router/index.ts`, add after the existing `enrichWithActiveSpace` method (after line 476):

```typescript
/** Enrich photo context with active space info if the user is in a space. */
private enrichPhotoWithActiveSpace(ctx: PhotoContext): PhotoContext {
	if (!this.spaceService) return ctx;

	const activeSpaceId = this.spaceService.getActiveSpace(ctx.userId);
	if (!activeSpaceId) return ctx;

	const space = this.spaceService.getSpace(activeSpaceId);
	if (!space) return ctx;

	return { ...ctx, spaceId: activeSpaceId, spaceName: space.name };
}
```

Add the `PhotoContext` import if not already present at top of file.

- [ ] **Step 4: Call enrichPhotoWithActiveSpace in routePhoto**

In the `routePhoto` method (line 253), add the enrichment call after the user authorization check (after line 260, before the "Check if any apps accept photos" comment):

```typescript
// Enrich with active space (same as text messages)
ctx = this.enrichPhotoWithActiveSpace(ctx);
```

Change the method parameter from `ctx: PhotoContext` to `let ctx` (or use a new variable) since we're reassigning it. The cleanest approach: change line 253 to accept `rawCtx` and assign:

```typescript
async routePhoto(rawCtx: PhotoContext): Promise<void> {
	// 1. Check user authorization
	const user = this.findUser(rawCtx.userId);
	if (!user) {
		this.logger.warn({ userId: rawCtx.userId }, 'Photo from unregistered user');
		await this.trySend(rawCtx.userId, 'You are not authorized to use this bot.');
		return;
	}

	// 2. Enrich with active space
	const ctx = this.enrichPhotoWithActiveSpace(rawCtx);
```

Then the rest of the method uses `ctx` as before.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run core/src/services/router/__tests__/router-spaces.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add core/src/services/router/index.ts core/src/services/router/__tests__/router-spaces.test.ts
git commit -m "feat: inject active space into photo context in router"
```

---

### Task 3: Bootstrap injects active space into callback context

**Files:**
- Modify: `core/src/bootstrap.ts:848-856`
- Test: `core/src/__tests__/dispatch-context-wrap.test.ts` (existing test for callback dispatch)

- [ ] **Step 1: Write the failing test**

In `core/src/__tests__/dispatch-context-wrap.test.ts`, add a test that verifies `spaceId` is injected into callback context. First, read the file to understand its existing test setup patterns (imports, mocks, etc.), then add:

```typescript
it('injects spaceId from active space into callback context', async () => {
	// This test should verify that when spaceService.getActiveSpace returns 'family',
	// the callbackCtx passed to the app's handleCallbackQuery includes spaceId: 'family'
	// and spaceName: 'Family'.
	// Use the existing test setup patterns from this file.
	// The key assertion is on the ctx argument of handleCallbackQuery.
});
```

Note: Read the full test file first to understand the bootstrap test harness. The test needs to simulate a callback query with a spaceService that returns an active space, and verify the `callbackCtx` passed to the app handler includes `spaceId` and `spaceName`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run core/src/__tests__/dispatch-context-wrap.test.ts`
Expected: FAIL — spaceId not present in callback context.

- [ ] **Step 3: Inject space into callback context**

In `core/src/bootstrap.ts`, at line 849 (the callback context construction), add space lookup. The bootstrap file should have access to `spaceService` from the composition root. Add:

```typescript
if (appEntry.module.handleCallbackQuery) {
	// Inject active space into callback context
	let spaceId: string | undefined;
	let spaceName: string | undefined;
	if (spaceService) {
		const activeSpaceId = spaceService.getActiveSpace(userId);
		if (activeSpaceId) {
			const space = spaceService.getSpace(activeSpaceId);
			if (space) {
				spaceId = activeSpaceId;
				spaceName = space.name;
			}
		}
	}

	const callbackCtx = {
		userId,
		chatId: ctx.callbackQuery.message?.chat.id ?? 0,
		messageId: ctx.callbackQuery.message?.message_id ?? 0,
		spaceId,
		spaceName,
	};
	const handler = appEntry.module.handleCallbackQuery;
	await requestContext.run({ userId }, () => handler(customData, callbackCtx));
}
```

Note: Verify that `spaceService` is in scope at this point in bootstrap.ts. It should be — it's created in the composition root. If the variable name differs, adjust accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run core/src/__tests__/dispatch-context-wrap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/bootstrap.ts core/src/__tests__/dispatch-context-wrap.test.ts
git commit -m "feat: inject active space into callback context in bootstrap"
```

---

### Task 4: Add resolveFoodStore helper

**Files:**
- Modify: `apps/food/src/utils/household-guard.ts`
- Test: `apps/food/src/__tests__/household-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/food/src/__tests__/household-guard.test.ts`, in a new `describe('resolveFoodStore')` block:

```typescript
import { resolveFoodStore, type FoodStoreResult } from '../utils/household-guard.js';

describe('resolveFoodStore', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let spaceStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		sharedStore = createMockScopedStore();
		spaceStore = createMockScopedStore();
		sharedStore.read.mockResolvedValue(stringify(sampleHousehold));
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		vi.mocked(services.data.forSpace).mockReturnValue(spaceStore as any);
	});

	it('returns space-scoped store when spaceId is provided', async () => {
		const result = await resolveFoodStore(services, 'user1', 'family');

		expect(result).not.toBeNull();
		expect(result!.scope).toBe('space');
		expect(result!.spaceId).toBe('family');
		expect(result!.store).toBe(spaceStore);
		expect(services.data.forSpace).toHaveBeenCalledWith('family', 'user1');
	});

	it('returns shared store when no spaceId', async () => {
		const result = await resolveFoodStore(services, 'user1');

		expect(result).not.toBeNull();
		expect(result!.scope).toBe('shared');
		expect(result!.spaceId).toBeUndefined();
		expect(result!.store).toBe(sharedStore);
	});

	it('returns null for non-member', async () => {
		const result = await resolveFoodStore(services, 'stranger', 'family');
		expect(result).toBeNull();
	});

	it('returns null when no household exists', async () => {
		sharedStore.read.mockResolvedValue(null);
		const result = await resolveFoodStore(services, 'user1', 'family');
		expect(result).toBeNull();
	});

	it('always reads household from shared store even when spaceId provided', async () => {
		await resolveFoodStore(services, 'user1', 'family');

		expect(services.data.forShared).toHaveBeenCalledWith('shared');
		// Household is read from shared store, not space store
		expect(sharedStore.read).toHaveBeenCalledWith('household.yaml');
	});
});
```

Note: Adjust imports and mock patterns to match the existing test file's conventions. The file already imports `createMockCoreServices` and has `createMockScopedStore` and `sampleHousehold` fixtures. Also import `stringify` from `'yaml'` if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/food/src/__tests__/household-guard.test.ts`
Expected: FAIL — `resolveFoodStore` doesn't exist yet.

- [ ] **Step 3: Implement resolveFoodStore**

Add to `apps/food/src/utils/household-guard.ts`:

```typescript
/** Result of resolving the food data store for an interactive context. */
export interface FoodStoreResult {
	household: Household;
	store: ScopedDataStore;
	scope: 'shared' | 'space';
	spaceId?: string;
}

/**
 * Resolve the food data store for an interactive handler.
 *
 * When spaceId is provided (from router-injected context), returns a space-scoped store.
 * When absent, returns the shared store.
 * Always checks household membership via the shared store (migration bridge).
 */
export async function resolveFoodStore(
	services: CoreServices,
	userId: string,
	spaceId?: string,
): Promise<FoodStoreResult | null> {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/food/src/__tests__/household-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/utils/household-guard.ts apps/food/src/__tests__/household-guard.test.ts
git commit -m "feat: add resolveFoodStore helper for space-aware food data"
```

---

### Task 5: Migrate photo handlers to resolveFoodStore

**Files:**
- Modify: `apps/food/src/handlers/photo.ts:78-127` (handlePhoto) and all sub-handlers
- Test: `apps/food/src/__tests__/photo-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/food/src/__tests__/photo-handler.test.ts`:

```typescript
describe('space-aware store resolution', () => {
	it('uses space-scoped store when photo context has spaceId', async () => {
		const spaceStore = createMockStore({
			'household.yaml': makeHouseholdYaml(['user-1']),
		});
		const { services, sharedStore } = createMockServices(
			JSON.stringify({
				store: 'Costco',
				date: '2026-04-14',
				lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 5.99, totalPrice: 5.99 }],
				subtotal: 5.99,
				tax: 0.5,
				total: 6.49,
			}),
		);
		vi.mocked(services.data.forSpace).mockReturnValue(spaceStore as any);

		const ctx = createPhotoCtx('receipt');
		(ctx as any).spaceId = 'family';

		await handlePhoto(services, ctx);

		// Writes should go to space store, not shared store
		expect(spaceStore.write).toHaveBeenCalled();
		const writeCall = spaceStore.write.mock.calls.find(
			(c: any) => typeof c[0] === 'string' && c[0].startsWith('receipts/')
		);
		expect(writeCall).toBeDefined();
	});
});
```

Note: The `createMockServices` helper already mocks `services.data.forShared`. Add `forSpace: vi.fn()` to the `data` mock if not present. Adjust based on the actual mock structure.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: FAIL — photo handler still uses shared store.

- [ ] **Step 3: Update handlePhoto to use resolveFoodStore**

In `apps/food/src/handlers/photo.ts`, change the `handlePhoto` function (line 78):

```typescript
import { resolveFoodStore } from '../utils/household-guard.js';

export async function handlePhoto(
	services: CoreServices,
	ctx: PhotoContext,
): Promise<void> {
	try {
		// F15: require household membership before any LLM call or store write
		const fh = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
		if (!fh) {
			await services.telegram.send(
				ctx.userId,
				'You need to set up or join a household before using photo features. ' +
				'Use /household to get started.',
			);
			return;
		}

		// ... classification code unchanged ...

		const store = fh.store;

		switch (photoType) {
			case 'recipe':
				await handleRecipePhoto(services, ctx, store);
				break;
			case 'receipt':
				await handleReceiptPhoto(services, ctx, store, fh);
				break;
			case 'pantry':
				await handlePantryPhoto(services, ctx, store);
				break;
			case 'grocery':
				await handleGroceryPhoto(services, ctx, store);
				break;
		}
	} catch (error) {
		// ... error handling unchanged ...
	}
}
```

Note: Pass `fh` (the full FoodStoreResult) to `handleReceiptPhoto` so it can use `fh.scope` and `fh.spaceId` for interaction recording. Other sub-handlers only need the `store`.

- [ ] **Step 4: Update handleReceiptPhoto signature**

Change `handleReceiptPhoto` to accept `FoodStoreResult` for interaction recording:

```typescript
async function handleReceiptPhoto(
	services: CoreServices,
	ctx: PhotoContext,
	store: ScopedDataStore,
	fh: FoodStoreResult,
): Promise<void> {
```

Update the interaction recording (line 216):

```typescript
services.interactionContext?.record(ctx.userId, {
	appId: 'food',
	action: 'receipt_captured',
	entityType: 'receipt',
	entityId: id,
	filePaths: [fh.scope === 'space'
		? `spaces/${fh.spaceId}/food/receipts/${id}.yaml`
		: `users/shared/food/receipts/${id}.yaml`],
	scope: fh.scope,
});
```

Also update the other photo sub-handlers' interaction recordings similarly (recipe_saved at line 160, grocery_updated at line 320). Those handlers also need the `fh` parameter OR just need the scope/spaceId. The simplest approach: pass `fh` to all sub-handlers that have interaction recording.

- [ ] **Step 5: Update remaining photo interaction recordings**

For `handleRecipePhoto` (line ~145-170), update to accept and use `fh`:

```typescript
async function handleRecipePhoto(
	services: CoreServices,
	ctx: PhotoContext,
	store: ScopedDataStore,
	fh: FoodStoreResult,
): Promise<void> {
```

Update interaction recording:
```typescript
services.interactionContext?.record(ctx.userId, {
	appId: 'food',
	action: 'recipe_saved',
	entityType: 'recipe',
	entityId: recipe.id,
	filePaths: [fh.scope === 'space'
		? `spaces/${fh.spaceId}/food/recipes/${recipe.id}.yaml`
		: `users/shared/food/recipes/${recipe.id}.yaml`],
	scope: fh.scope,
});
```

Do the same for `handleGroceryPhoto` (line ~300-330).

Update the switch statement in `handlePhoto` to pass `fh` to all sub-handlers that record interactions.

- [ ] **Step 6: Remove old requireHousehold import if no longer used**

Remove `requireHousehold` from the import statement in photo.ts if it's no longer referenced. Keep `loadHousehold` if still used elsewhere.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/food/src/handlers/photo.ts apps/food/src/__tests__/photo-handler.test.ts
git commit -m "feat: migrate photo handlers to space-aware resolveFoodStore"
```

---

### Task 6: Migrate food app index.ts interactive handlers to resolveFoodStore

This is the largest mechanical change — ~40 call sites in `apps/food/src/index.ts`.

**Files:**
- Modify: `apps/food/src/index.ts`

- [ ] **Step 1: Add resolveFoodStore import**

In `apps/food/src/index.ts`, update the import from household-guard:

```typescript
import { loadHousehold, requireHousehold, resolveFoodStore } from './utils/household-guard.js';
```

Keep `requireHousehold` imported — some edge cases or flows that don't have a context may still need it.

- [ ] **Step 2: Create a helper for interaction path resolution**

Add a utility near the top of the file to reduce repetition:

```typescript
import type { FoodStoreResult } from './utils/household-guard.js';

/** Build the data-dir-relative file path for interaction recording. */
function interactionPath(fh: FoodStoreResult, appRelativePath: string): string {
	return fh.scope === 'space'
		? `spaces/${fh.spaceId}/food/${appRelativePath}`
		: `users/shared/food/${appRelativePath}`;
}
```

- [ ] **Step 3: Migrate handleMessage requireHousehold calls**

In `handleMessage` (line 269+), find each `requireHousehold(services, ctx.userId)` call and replace with `resolveFoodStore(services, ctx.userId, ctx.spaceId)`. Change the variable name from `hh` to `fh` and replace all `hh.sharedStore` with `fh.store` in each scope.

**Pattern for each call site:**

Before:
```typescript
const hh = await requireHousehold(services, ctx.userId);
if (!hh) {
    await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
    return;
}
// ... uses hh.sharedStore
```

After:
```typescript
const fh = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
if (!fh) {
    await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
    return;
}
// ... uses fh.store
```

Apply to ALL `requireHousehold` calls inside `handleMessage` and its nested/called functions that receive `MessageContext`:
- Line 333 (guest add flow)
- Line 431 (child food flows)
- Line 510 (nutrition log NL)
- Line 530 (adherence)
- Line 547, 568, 582 (various NL handlers)
- And all other instances through the end of handleMessage

For functions that are called from handleMessage and receive `ctx: MessageContext`, propagate `ctx.spaceId`.

- [ ] **Step 4: Migrate handleCommand requireHousehold calls**

Same pattern for the `/command` handler — `handleCommand` receives `MessageContext`. Replace all `requireHousehold` → `resolveFoodStore` calls within it (lines ~740-790 and their sub-functions).

- [ ] **Step 5: Migrate handleCallbackQuery requireHousehold calls**

`handleCallbackQuery` receives `CallbackContext` (which now has `spaceId`). Replace the `requireHousehold` call at line 818:

Before:
```typescript
const hh = await requireHousehold(services, ctx.userId);
if (!hh) return;
```

After:
```typescript
const fh = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
if (!fh) return;
```

Replace all `hh.sharedStore` with `fh.store` in the callback handler scope.

- [ ] **Step 6: Migrate handlePriceUpdateIntent**

In `handlePriceUpdateIntent` (line 3014):

```typescript
async function handlePriceUpdateIntent(text: string, ctx: MessageContext): Promise<void> {
	const fh = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
	if (!fh) {
		await services.telegram.send(
			ctx.userId,
			'Set up a household first with /household create <name>',
		);
		return;
	}

	const parsed = await parsePriceUpdateText(services, text);
	if (!parsed) {
		await services.telegram.send(
			ctx.userId,
			'I couldn\'t understand that price update. Try: "eggs are $3.50 at costco"',
		);
		return;
	}

	const slug = getStoreSlug(parsed.store);
	let priceData = await loadStorePrices(fh.store, slug);
	if (!priceData.store || priceData.store === slug) {
		priceData = { ...priceData, store: parsed.store, slug };
	}

	const entry = {
		name: parsed.item,
		price: parsed.price,
		unit: parsed.unit,
		department: parsed.department,
		updatedAt: todayDate(services.timezone),
	};

	priceData = addOrUpdatePrice(priceData, entry);
	await saveStorePrices(fh.store, priceData);

	services.interactionContext?.record(ctx.userId, {
		appId: 'food',
		action: 'price_updated',
		entityType: 'price-list',
		filePaths: [interactionPath(fh, `prices/${slug}.md`)],
		scope: fh.scope,
	});

	await services.telegram.send(
		ctx.userId,
		`✅ Updated ${parsed.item} → $${parsed.price.toFixed(2)} at ${parsed.store}`,
	);
}
```

- [ ] **Step 7: Update all remaining interaction recording calls in index.ts**

Update each `interactionContext.record()` call to use `interactionPath()`:

- recipe_saved (line ~1794): `filePaths: [interactionPath(fh, `recipes/${recipe.id}.yaml`)]`
- grocery_updated (line ~2174): `filePaths: [interactionPath(fh, 'grocery/active.yaml')]`
- meal_plan_finalized (line ~2474): `filePaths: [interactionPath(fh, 'meal-plans/current.yaml')]`
- price_updated (line ~3050): already handled in step 6

For each, also change `scope: 'shared'` to `scope: fh.scope`.

- [ ] **Step 8: Verify the `fh` variable is in scope for each interaction recording**

Each interaction recording must have the `fh` (FoodStoreResult) variable in scope. If a recording is inside a nested function that doesn't currently receive `fh`, thread it through as a parameter.

- [ ] **Step 9: Run tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS (or fix any failing tests — mock setups may need `forSpace` added to the data mock)

- [ ] **Step 10: Commit**

```bash
git add apps/food/src/index.ts
git commit -m "feat: migrate food app interactive handlers to resolveFoodStore"
```

---

### Task 7: Migrate cook-mode interactive handlers

**Files:**
- Modify: `apps/food/src/handlers/cook-mode.ts`

- [ ] **Step 1: Migrate handleCookCommand and handleCookMessage**

In `apps/food/src/handlers/cook-mode.ts`:

- `handleCookCommand` (line 88) receives `ctx: MessageContext` — replace `requireHousehold` with `resolveFoodStore(services, ctx.userId, ctx.spaceId)`, rename `hh.sharedStore` → `fh.store`.
- `handleCookMessage` (line 194) receives `ctx: MessageContext` — same migration.
- `handleCookCallback` (line 275) — check its signature. If it receives `CallbackContext` or `userId`, migrate accordingly.
- Any function that receives only `userId` (no spaceId) stays on `requireHousehold`.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/food/src/handlers/cook-mode.ts
git commit -m "feat: migrate cook-mode interactive handlers to resolveFoodStore"
```

---

### Task 8: Enrich receipt and price frontmatter with entity_keys

**Files:**
- Modify: `apps/food/src/handlers/photo.ts:205-212` (receipt frontmatter)
- Modify: `apps/food/src/services/price-store.ts:28-38` (price frontmatter)
- Test: `apps/food/src/__tests__/photo-handler.test.ts`, `apps/food/src/__tests__/price-store.test.ts` (or create if needed)

- [ ] **Step 1: Write failing test for receipt entity_keys**

Add to `apps/food/src/__tests__/photo-handler.test.ts`:

```typescript
it('includes item names and caption label in receipt entity_keys', async () => {
	const receiptResponse = JSON.stringify({
		store: 'Costco',
		date: '2026-04-14',
		lineItems: [
			{ name: 'Eggs 5DZ', quantity: 1, unitPrice: 12.99, totalPrice: 12.99 },
			{ name: 'Diapers', quantity: 1, unitPrice: 29.99, totalPrice: 29.99 },
		],
		subtotal: 42.98,
		tax: 3.50,
		total: 46.48,
	});
	const { services, sharedStore } = createMockServices(receiptResponse);
	const ctx = createPhotoCtx('receipt 2');

	await handlePhoto(services, ctx);

	// Find the receipt write
	const writeCall = sharedStore.write.mock.calls.find(
		(c: any) => typeof c[0] === 'string' && c[0].startsWith('receipts/')
	);
	expect(writeCall).toBeDefined();
	const content = writeCall![1] as string;

	// entity_keys should include store, caption label, and item names
	expect(content).toContain('costco');
	expect(content).toContain('receipt 2');
	expect(content).toContain('eggs 5dz');
	expect(content).toContain('diapers');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: FAIL — entity_keys only contain store name.

- [ ] **Step 3: Implement receipt entity_keys enrichment**

In `apps/food/src/handlers/photo.ts`, in `handleReceiptPhoto`, replace the frontmatter generation:

```typescript
// Enriched entity_keys: store + caption label + item names (capped at 20)
const itemKeys = parsed.lineItems
	.slice(0, 20)
	.map((item: { name: string }) => item.name.toLowerCase());
const captionKeys: string[] = [];
if (ctx.caption) {
	const label = ctx.caption.trim().toLowerCase();
	if (label && label !== parsed.store.toLowerCase()) {
		captionKeys.push(label);
	}
}
const entityKeys = [
	parsed.store.toLowerCase(),
	...captionKeys,
	...new Set(itemKeys),
];

const fm = generateFrontmatter({
	title: `Receipt: ${parsed.store}`,
	date: parsed.date,
	tags: ['food', 'receipt'],
	type: 'receipt',
	entity_keys: entityKeys,
	app: 'food',
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for price entity_keys**

Find or create a test for `formatPriceFile` in `apps/food/src/__tests__/`. Add:

```typescript
it('includes item names in price file entity_keys', () => {
	const data: StorePriceData = {
		store: 'Costco',
		slug: 'costco',
		lastUpdated: '2026-04-14',
		items: [
			{ name: 'Eggs', price: 12.99, department: 'Dairy', updatedAt: '2026-04-14' },
			{ name: 'Milk', price: 4.99, department: 'Dairy', updatedAt: '2026-04-14' },
		],
	};

	const content = formatPriceFile(data);

	expect(content).toContain('eggs');
	expect(content).toContain('milk');
});
```

- [ ] **Step 6: Implement price entity_keys enrichment**

In `apps/food/src/services/price-store.ts`, in `formatPriceFile` (line 28):

```typescript
export function formatPriceFile(data: StorePriceData): string {
	const itemKeys = data.items.slice(0, 30).map((i) => i.name.toLowerCase());
	const entityKeys = [data.store.toLowerCase(), data.slug, ...new Set(itemKeys)];

	const fm = generateFrontmatter({
		store: data.store,
		slug: data.slug,
		last_updated: data.lastUpdated,
		item_count: data.items.length,
		tags: buildAppTags('food', 'prices'),
		type: 'price-list',
		entity_keys: entityKeys,
		app: 'food',
	});
```

- [ ] **Step 7: Run tests to verify both pass**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/food/src/handlers/photo.ts apps/food/src/services/price-store.ts apps/food/src/__tests__/
git commit -m "feat: enrich receipt and price entity_keys with item names and caption labels"
```

---

### Task 9: Receipt capture response with line items

**Files:**
- Modify: `apps/food/src/handlers/photo.ts:239-247`

- [ ] **Step 1: Write the failing test**

Add to `apps/food/src/__tests__/photo-handler.test.ts`:

```typescript
it('includes line items in receipt capture response', async () => {
	const receiptResponse = JSON.stringify({
		store: 'Costco',
		date: '2026-04-14',
		lineItems: [
			{ name: 'Eggs 5DZ', quantity: 1, unitPrice: 12.99, totalPrice: 12.99 },
			{ name: 'Diapers', quantity: 1, unitPrice: 29.99, totalPrice: 29.99 },
		],
		subtotal: 42.98,
		tax: 3.50,
		total: 46.48,
	});
	const { services } = createMockServices(receiptResponse);
	const ctx = createPhotoCtx('receipt');

	await handlePhoto(services, ctx);

	const sendCall = vi.mocked(services.telegram.send).mock.calls[0];
	expect(sendCall).toBeDefined();
	const message = sendCall![1] as string;

	// Should include item lines, not just count
	expect(message).toContain('Eggs 5DZ');
	expect(message).toContain('$12.99');
	expect(message).toContain('Diapers');
	expect(message).toContain('$29.99');
});

it('includes receipt ID in capture response', async () => {
	const receiptResponse = JSON.stringify({
		store: 'Costco',
		date: '2026-04-14',
		lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 5.99, totalPrice: 5.99 }],
		subtotal: 5.99,
		total: 5.99,
	});
	const { services } = createMockServices(receiptResponse);
	const ctx = createPhotoCtx('receipt');

	await handlePhoto(services, ctx);

	const sendCall = vi.mocked(services.telegram.send).mock.calls[0];
	const message = sendCall![1] as string;

	// Should include receipt ID (date-based)
	expect(message).toContain('2026-04-14-');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: FAIL — current message only shows item count.

- [ ] **Step 3: Implement line-item response**

In `apps/food/src/handlers/photo.ts`, replace the Telegram send in `handleReceiptPhoto` (line 239-247):

```typescript
// Build line item summary (truncated for readability)
const maxDisplayItems = 10;
const itemLines = parsed.lineItems.slice(0, maxDisplayItems).map((item: { name: string; totalPrice: number }) =>
	`  ${escapeMarkdown(item.name)}: $${item.totalPrice.toFixed(2)}`
).join('\n');
const moreItems = parsed.lineItems.length > maxDisplayItems
	? `\n  _... and ${parsed.lineItems.length - maxDisplayItems} more_`
	: '';

await services.telegram.send(
	ctx.userId,
	`🧾 Receipt captured! (${escapeMarkdown(id)})\n\n` +
	`*${escapeMarkdown(parsed.store)}* — ${escapeMarkdown(parsed.date)}\n` +
	`${itemLines}${moreItems}\n\n` +
	`• ${parsed.lineItems.length} items — Total: $${parsed.total.toFixed(2)}\n` +
	(parsed.tax != null ? `• Tax: $${parsed.tax.toFixed(2)}\n` : '') +
	priceUpdateMsg,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/handlers/photo.ts apps/food/src/__tests__/photo-handler.test.ts
git commit -m "feat: include line items and receipt ID in capture response"
```

---

### Task 10: Food manifest intents for receipt/price queries

**Files:**
- Modify: `apps/food/manifest.yaml`

- [ ] **Step 1: Add intents**

In `apps/food/manifest.yaml`, add after line 36 (`"user wants to see food spending"`):

```yaml
      - "user wants to see receipt details or look up items from a receipt"
      - "user asks about prices at a specific store"
```

- [ ] **Step 2: Verify manifest validates**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 3: Commit**

```bash
git add apps/food/manifest.yaml
git commit -m "feat: add receipt and price query intents to food manifest"
```

---

### Task 11: Legacy data migration script

**Files:**
- Create: `scripts/migrate-shared-to-space.ts`

- [ ] **Step 1: Write the migration script**

Create `scripts/migrate-shared-to-space.ts`:

```typescript
#!/usr/bin/env npx tsx
/**
 * Migrate legacy shared food data to a space-scoped directory.
 *
 * Usage: npx tsx scripts/migrate-shared-to-space.ts <spaceId>
 *
 * Non-destructive: copies files, skips existing, does not delete originals.
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { parse } from 'yaml';

const spaceId = process.argv[2];
if (!spaceId) {
	console.error('Usage: npx tsx scripts/migrate-shared-to-space.ts <spaceId>');
	process.exit(1);
}

// Validate spaceId exists
const spacesPath = join('data', 'system', 'spaces.yaml');
if (!existsSync(spacesPath)) {
	console.error(`No spaces.yaml found at ${spacesPath}`);
	process.exit(1);
}

const spacesRaw = readFileSync(spacesPath, 'utf-8');
const spaces = parse(spacesRaw) as Record<string, unknown>;
if (!spaces[spaceId]) {
	console.error(`Space "${spaceId}" not found in spaces.yaml. Available: ${Object.keys(spaces).join(', ')}`);
	process.exit(1);
}

const srcDir = join('data', 'users', 'shared', 'food');
const destDir = join('data', 'spaces', spaceId, 'food');

if (!existsSync(srcDir)) {
	console.error(`Source directory does not exist: ${srcDir}`);
	process.exit(1);
}

let copied = 0;
let skipped = 0;
let errors = 0;

function copyRecursive(src: string, dest: string): void {
	const entries = readdirSync(src);
	for (const entry of entries) {
		const srcPath = join(src, entry);
		const destPath = join(dest, entry);
		const stat = statSync(srcPath);

		if (stat.isDirectory()) {
			copyRecursive(srcPath, destPath);
		} else {
			if (existsSync(destPath)) {
				console.log(`  SKIP ${relative('.', destPath)} (already exists)`);
				skipped++;
			} else {
				try {
					mkdirSync(dirname(destPath), { recursive: true });
					copyFileSync(srcPath, destPath);
					console.log(`  COPY ${relative('.', srcPath)} → ${relative('.', destPath)}`);
					copied++;
				} catch (err) {
					console.error(`  ERROR ${relative('.', srcPath)}: ${err}`);
					errors++;
				}
			}
		}
	}
}

console.log(`Migrating ${srcDir} → ${destDir}\n`);
copyRecursive(srcDir, destDir);
console.log(`\nDone: ${copied} copied, ${skipped} skipped, ${errors} errors`);
if (errors > 0) process.exit(1);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrate-shared-to-space.ts
git commit -m "feat: add legacy shared-to-space data migration script"
```

---

### Task 12: Add space-scoped data query test

**Files:**
- Modify: `core/src/services/data-query/__tests__/data-query.test.ts`

- [ ] **Step 1: Write the test**

Add after the existing scope tests (around line 700):

```typescript
it('space member can query space-scoped receipt and price files', async () => {
	// Write receipt and price files to space directory
	await writeDataFile(
		dataDir,
		'spaces/family/food/receipts/2026-04-14-abc.yaml',
		'---\ntitle: "Receipt: Costco"\ntype: receipt\nentity_keys:\n  - costco\n  - receipt 2\n  - eggs\n  - diapers\napp: food\n---\nstore: Costco\nlineItems:\n  - name: Eggs\n    totalPrice: 12.99\n  - name: Diapers\n    totalPrice: 29.99\n',
	);
	await writeDataFile(
		dataDir,
		'spaces/family/food/prices/costco.md',
		'---\nstore: Costco\nslug: costco\ntype: price-list\nentity_keys:\n  - costco\n  - eggs\n  - diapers\napp: food\n---\n## Dairy\n- Eggs: $12.99\n## Baby\n- Diapers: $29.99\n',
	);

	const fileIndex = new FileIndexService(dataDir, makeAppScopes([], ['receipts/', 'prices/']));
	await fileIndex.rebuild();

	const llm = makeMockLlm('[0, 1]');
	const svc = new DataQueryServiceImpl({
		fileIndex,
		spaceService: makeSpaceService([{ id: 'family', members: ['matt'] }]),
		llm,
		dataDir,
		logger,
	});

	const result = await svc.query('how much were diapers at costco', 'matt');

	expect(result.empty).toBe(false);
	expect(result.files.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run core/src/services/data-query/__tests__/data-query.test.ts`
Expected: PASS — space-scoped files are accessible to space members (existing behavior).

- [ ] **Step 3: Verify existing shared-hidden test still passes**

The existing test `'shared files are hidden when user belongs to a space'` at line 625 should still pass — shared data remains hidden for space members.

- [ ] **Step 4: Commit**

```bash
git add core/src/services/data-query/__tests__/data-query.test.ts
git commit -m "test: verify space-scoped receipt/price data is queryable by members"
```

---

### Task 13: Full test suite verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: 6272+ tests passing, 0 failures.

- [ ] **Step 2: Fix any failures**

If tests fail, they're most likely:
- Mock setups missing `forSpace` on data service mocks — add `forSpace: vi.fn().mockReturnValue(createMockStore())`.
- Tests that assert `hh.sharedStore` on the return value of `requireHousehold` — these still work since `requireHousehold` is unchanged.
- Tests that mock `requireHousehold` calls — update to expect `resolveFoodStore` import.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "fix: update test mocks for space-aware food store resolution"
```

---

### Task 14: Update CLAUDE.md

- [ ] **Step 1: Update implementation status**

Add to the Implementation Status section in `CLAUDE.md`:

- Record that this phase is complete
- Update test counts
- Note the migration script usage: `npx tsx scripts/migrate-shared-to-space.ts <spaceId>`

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for space-aware food data phase"
```
