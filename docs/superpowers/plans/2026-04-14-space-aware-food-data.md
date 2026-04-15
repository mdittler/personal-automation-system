# Space-Aware Food Data Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make food app data writes space-scoped when the user is in an active space, so NL queries via DataQueryService can discover receipt, price, and all other food data.

**Architecture:** Router injects active space into PhotoContext and CallbackContext (matching existing MessageContext pattern). New `resolveFoodStore()` helper in the food app resolves the correct ScopedDataStore based on explicit spaceId. All interactive food handlers migrate from `requireHousehold()` to `resolveFoodStore()`. Scheduled jobs remain on shared store — they will NOT see space-scoped data until per-space scheduled jobs are explicitly designed. Legacy data migrated via script.

**Tech Stack:** TypeScript 5.x, ESM, Vitest, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`

**Callback space semantics:** Space is resolved at tap-time (the user's active space when they tap the button), not creation-time (when the button was generated). This is accepted behavior — encoding originating scope into every callback data string would require changing all callback formats across the food app, which is out of scope. A code comment in bootstrap.ts documents this decision.

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
	/**
	 * Active space ID at tap-time (set by bootstrap from user's current active space).
	 * Note: this is the space active when the button is tapped, NOT when the button
	 * was generated. If the user switches spaces between generation and tap, the
	 * handler sees the new space. This is accepted behavior — encoding originating
	 * scope into callback data strings is a larger change deferred for later.
	 */
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
- Modify: `core/src/services/router/index.ts:253-323` (routePhoto) and near line 476 (enrichWithActiveSpace area)
- Test: `core/src/services/router/__tests__/router-spaces.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `'active space injection'` describe block in `core/src/services/router/__tests__/router-spaces.test.ts`. First add `PhotoContext` to the import from `../../../types/telegram.js`. Then:

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

	const photoCtx: PhotoContext = {
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

	const photoCtx: PhotoContext = {
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

Add `PhotoContext` to the import from types if not already present.

- [ ] **Step 4: Call enrichPhotoWithActiveSpace in routePhoto**

In `routePhoto` (line 253), change the parameter to `rawCtx` and enrich after user auth:

```typescript
async routePhoto(rawCtx: PhotoContext): Promise<void> {
	// 1. Check user authorization
	const user = this.findUser(rawCtx.userId);
	if (!user) {
		this.logger.warn({ userId: rawCtx.userId }, 'Photo from unregistered user');
		await this.trySend(rawCtx.userId, 'You are not authorized to use this bot.');
		return;
	}

	// 2. Enrich with active space (same as text messages)
	const ctx = this.enrichPhotoWithActiveSpace(rawCtx);
```

Then the rest of the method uses `ctx` as before (no other changes needed).

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
- Test: `core/src/__tests__/dispatch-context-wrap.test.ts`

The existing test file uses structural regex-on-source scans (no behavioral mocks). We add a structural test matching the existing pattern.

- [ ] **Step 1: Write the structural test**

In `core/src/__tests__/dispatch-context-wrap.test.ts`, add:

```typescript
it('the callback context includes spaceId from active space lookup', async () => {
	const source = stripComments(await readSource('bootstrap.ts'));

	// Verify that the callback branch constructs callbackCtx with spaceId.
	// The code should look like: callbackCtx = { userId, chatId: ..., messageId: ..., spaceId, spaceName }
	const hasSpaceIdInCtx = source.match(/callbackCtx\s*=\s*\{[^}]*spaceId/);
	expect(hasSpaceIdInCtx).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run core/src/__tests__/dispatch-context-wrap.test.ts`
Expected: FAIL — `callbackCtx` doesn't include spaceId yet.

- [ ] **Step 3: Inject space into callback context in bootstrap.ts**

In `core/src/bootstrap.ts`, at line ~848, replace the callback context construction. First verify `spaceService` is in scope (it should be — it's created in the composition root above this code). Then:

```typescript
if (appEntry.module.handleCallbackQuery) {
	// Resolve active space at tap-time. Note: this is the user's current
	// active space when the button is tapped, not when the button was
	// generated. See CallbackContext type docs for rationale.
	let cbSpaceId: string | undefined;
	let cbSpaceName: string | undefined;
	if (spaceService) {
		const activeId = spaceService.getActiveSpace(userId);
		if (activeId) {
			const space = spaceService.getSpace(activeId);
			if (space) {
				cbSpaceId = activeId;
				cbSpaceName = space.name;
			}
		}
	}

	const callbackCtx = {
		userId,
		chatId: ctx.callbackQuery.message?.chat.id ?? 0,
		messageId: ctx.callbackQuery.message?.message_id ?? 0,
		spaceId: cbSpaceId,
		spaceName: cbSpaceName,
	};
	const handler = appEntry.module.handleCallbackQuery;
	await requestContext.run({ userId }, () => handler(customData, callbackCtx));
}
```

- [ ] **Step 4: Run test to verify it passes**

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

Add to `apps/food/src/__tests__/household-guard.test.ts`. Import `resolveFoodStore` and `FoodStoreResult` from the household-guard module. Add a new `describe('resolveFoodStore')` block:

```typescript
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

		// Household membership is checked via shared store (migration bridge)
		expect(services.data.forShared).toHaveBeenCalledWith('shared');
		expect(sharedStore.read).toHaveBeenCalledWith('household.yaml');
	});

	it('propagates SpaceMembershipError when forSpace rejects', async () => {
		vi.mocked(services.data.forSpace).mockImplementation(() => {
			throw new Error('User stranger is not a member of space "family"');
		});

		// User passes household check but forSpace throws
		await expect(resolveFoodStore(services, 'user1', 'family')).rejects.toThrow(
			'not a member of space',
		);
	});
});
```

Ensure `stringify` is imported from `'yaml'` and `sampleHousehold` is the existing fixture (members: `['user1']`). Adjust member IDs to match existing fixture.

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
 *
 * **Migration note:** Household membership is always checked via `users/shared/food/household.yaml`,
 * even when returning a space-scoped store. This is a migration bridge — long-term, household
 * membership should come from SpaceService rather than a global file.
 *
 * If the spaceId is invalid or the user is not a space member, `forSpace()` will throw
 * `SpaceMembershipError`. Callers should let this propagate (the router already validated
 * space membership when injecting spaceId, so this is a defense-in-depth guard).
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
- Modify: `apps/food/src/handlers/photo.ts`
- Test: `apps/food/src/__tests__/photo-handler.test.ts`

- [ ] **Step 1: Write failing test — receipt photo with spaceId writes to space store**

Add to `apps/food/src/__tests__/photo-handler.test.ts`. First add `forSpace: vi.fn()` to the `data` mock in `createMockServices` if not present:

```typescript
describe('space-aware store resolution', () => {
	it('receipt photo with spaceId writes to space-scoped store', async () => {
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
		(services.data as any).forSpace = vi.fn().mockReturnValue(spaceStore);

		const ctx = createPhotoCtx('receipt');
		(ctx as any).spaceId = 'family';

		await handlePhoto(services, ctx);

		// Receipt should be written to space store
		const spaceWriteCall = spaceStore.write.mock.calls.find(
			(c: any) => typeof c[0] === 'string' && c[0].startsWith('receipts/')
		);
		expect(spaceWriteCall).toBeDefined();

		// Shared store should NOT have receipt writes (only household.yaml read)
		const sharedReceiptWrite = sharedStore.write.mock.calls.find(
			(c: any) => typeof c[0] === 'string' && c[0].startsWith('receipts/')
		);
		expect(sharedReceiptWrite).toBeUndefined();
	});

	it('receipt photo without spaceId writes to shared store', async () => {
		const { services, sharedStore } = createMockServices(
			JSON.stringify({
				store: 'Costco',
				date: '2026-04-14',
				lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 5.99, totalPrice: 5.99 }],
				subtotal: 5.99,
				total: 6.49,
			}),
		);

		const ctx = createPhotoCtx('receipt');
		// No spaceId set

		await handlePhoto(services, ctx);

		const sharedWriteCall = sharedStore.write.mock.calls.find(
			(c: any) => typeof c[0] === 'string' && c[0].startsWith('receipts/')
		);
		expect(sharedWriteCall).toBeDefined();
	});

	it('interaction record path is space-scoped when spaceId present', async () => {
		const spaceStore = createMockStore({
			'household.yaml': makeHouseholdYaml(['user-1']),
		});
		const { services } = createMockServices(
			JSON.stringify({
				store: 'Costco',
				date: '2026-04-14',
				lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 5.99, totalPrice: 5.99 }],
				subtotal: 5.99,
				total: 6.49,
			}),
		);
		(services.data as any).forSpace = vi.fn().mockReturnValue(spaceStore);
		services.interactionContext = { record: vi.fn(), getRecent: vi.fn().mockReturnValue([]) } as any;

		const ctx = createPhotoCtx('receipt');
		(ctx as any).spaceId = 'family';

		await handlePhoto(services, ctx);

		const recordCall = vi.mocked(services.interactionContext!.record).mock.calls[0];
		expect(recordCall).toBeDefined();
		expect(recordCall![1].filePaths[0]).toMatch(/^spaces\/family\/food\/receipts\//);
		expect(recordCall![1].scope).toBe('space');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Update handlePhoto to use resolveFoodStore**

In `apps/food/src/handlers/photo.ts`:

Replace `requireHousehold` import with `resolveFoodStore`:
```typescript
import { resolveFoodStore, type FoodStoreResult } from '../utils/household-guard.js';
```

Update `handlePhoto` (line 78):
```typescript
export async function handlePhoto(
	services: CoreServices,
	ctx: PhotoContext,
): Promise<void> {
	try {
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
				await handleRecipePhoto(services, ctx, store, fh);
				break;
			case 'receipt':
				await handleReceiptPhoto(services, ctx, store, fh);
				break;
			case 'pantry':
				await handlePantryPhoto(services, ctx, store);
				break;
			case 'grocery':
				await handleGroceryPhoto(services, ctx, store, fh);
				break;
		}
	} catch (error) {
		// ... error handling unchanged ...
	}
}
```

- [ ] **Step 4: Update handleReceiptPhoto to accept FoodStoreResult**

Change signature and update interaction recording:

```typescript
async function handleReceiptPhoto(
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
	action: 'receipt_captured',
	entityType: 'receipt',
	entityId: id,
	filePaths: [fh.scope === 'space'
		? `spaces/${fh.spaceId}/food/receipts/${id}.yaml`
		: `users/shared/food/receipts/${id}.yaml`],
	scope: fh.scope,
});
```

- [ ] **Step 5: Update handleRecipePhoto and handleGroceryPhoto interaction recordings**

Same pattern for both — accept `fh: FoodStoreResult` parameter and update interaction recording paths. For handlers that don't record interactions (like `handlePantryPhoto`), only the store parameter is needed.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/food/src/handlers/photo.ts apps/food/src/__tests__/photo-handler.test.ts
git commit -m "feat: migrate photo handlers to space-aware resolveFoodStore"
```

---

### Task 6a: Migrate receipt/price handlers in index.ts

**Files:**
- Modify: `apps/food/src/index.ts` (receipt, price, and budget-related handlers only)

- [ ] **Step 1: Add imports and helper**

In `apps/food/src/index.ts`, add:

```typescript
import { loadHousehold, requireHousehold, resolveFoodStore, type FoodStoreResult } from './utils/household-guard.js';

/** Build the data-dir-relative file path for interaction recording. */
function interactionPath(fh: FoodStoreResult, appRelativePath: string): string {
	return fh.scope === 'space'
		? `spaces/${fh.spaceId}/food/${appRelativePath}`
		: `users/shared/food/${appRelativePath}`;
}
```

- [ ] **Step 2: Migrate handlePriceUpdateIntent (line ~3014)**

Replace `requireHousehold` → `resolveFoodStore`, `hh.sharedStore` → `fh.store`, update interaction path:

```typescript
async function handlePriceUpdateIntent(text: string, ctx: MessageContext): Promise<void> {
	const fh = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
	if (!fh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}

	// ... parsing unchanged ...

	const slug = getStoreSlug(parsed.store);
	let priceData = await loadStorePrices(fh.store, slug);
	// ... rest unchanged except hh.sharedStore → fh.store ...

	priceData = addOrUpdatePrice(priceData, entry);
	await saveStorePrices(fh.store, priceData);

	services.interactionContext?.record(ctx.userId, {
		appId: 'food',
		action: 'price_updated',
		entityType: 'price-list',
		filePaths: [interactionPath(fh, `prices/${slug}.md`)],
		scope: fh.scope,
	});

	// ... telegram send unchanged ...
}
```

- [ ] **Step 3: Migrate budget/spending handlers**

Find handlers related to `/budget`, food spending views, and price lookups. Replace `requireHousehold` → `resolveFoodStore` and `hh.sharedStore` → `fh.store` in each.

- [ ] **Step 4: Build to verify compilation**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 5: Run food tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS (fix any mock issues — add `forSpace: vi.fn()` to data mocks where needed)

- [ ] **Step 6: Commit**

```bash
git add apps/food/src/index.ts
git commit -m "feat: migrate receipt/price/budget handlers to resolveFoodStore"
```

---

### Task 6b: Migrate grocery/pantry handlers in index.ts

**Files:**
- Modify: `apps/food/src/index.ts` (grocery list, pantry, leftovers, freezer handlers)

- [ ] **Step 1: Migrate grocery handlers**

Find all `requireHousehold` calls in grocery-related code paths (`loadGroceryList`, `saveGroceryList`, `archivePurchased`, `addgrocery`, grocery generation, etc.). Replace `requireHousehold` → `resolveFoodStore` and `hh.sharedStore` → `fh.store`. Update grocery interaction recordings to use `interactionPath(fh, 'grocery/active.yaml')`.

- [ ] **Step 2: Migrate pantry, leftovers, freezer handlers**

Same pattern for pantry (`loadPantry`, `savePantry`), leftovers (`loadLeftovers`, `saveLeftovers`), freezer (`loadFreezer`, `saveFreezer`), and waste log (`appendWaste`) handlers.

- [ ] **Step 3: Build to verify compilation**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 4: Run food tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/index.ts
git commit -m "feat: migrate grocery/pantry/leftovers/freezer handlers to resolveFoodStore"
```

---

### Task 6c: Migrate recipe/meal-plan handlers in index.ts

**Files:**
- Modify: `apps/food/src/index.ts` (recipe, meal plan, voting, batch prep handlers)

- [ ] **Step 1: Migrate recipe handlers**

Replace `requireHousehold` → `resolveFoodStore` and `hh.sharedStore` → `fh.store` in recipe save, search, load, update handlers. Update the recipe_saved interaction recording to use `interactionPath(fh, ...)`.

- [ ] **Step 2: Migrate meal plan handlers**

Same for meal plan generation, finalization, voting. Update meal_plan_finalized interaction recording.

- [ ] **Step 3: Build to verify compilation**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 4: Run food tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/index.ts
git commit -m "feat: migrate recipe/meal-plan handlers to resolveFoodStore"
```

---

### Task 6d: Migrate callback, nutrition, hosting, and remaining handlers in index.ts

**Files:**
- Modify: `apps/food/src/index.ts` (handleCallbackQuery, child food, nutrition NL, hosting, cultural calendar, health correlation, what-can-I-make, dinner intent, etc.)

- [ ] **Step 1: Migrate handleCallbackQuery**

The `requireHousehold` call at line ~818 becomes `resolveFoodStore(services, ctx.userId, ctx.spaceId)`. Replace all `hh.sharedStore` → `fh.store` within the callback handler scope.

Note: Household-independent callbacks (nutrition targets, adherence) that don't call `requireHousehold` are unchanged.

- [ ] **Step 2: Migrate remaining handleMessage sub-handlers**

Replace in: child food flows (line ~333, ~431), nutrition NL (line ~510), adherence (line ~530), hosting (line ~568), health correlation (line ~582), what-can-I-make, dinner intent, and any other `requireHousehold` calls not covered in 6a-6c.

- [ ] **Step 3: Build to verify compilation**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 4: Run full food test suite**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/index.ts
git commit -m "feat: migrate callback/nutrition/hosting/remaining handlers to resolveFoodStore"
```

---

### Task 7: Migrate cook-mode interactive handlers

**Files:**
- Modify: `apps/food/src/handlers/cook-mode.ts`

Resolved signatures:
- `handleCookCommand(services, args, ctx: MessageContext)` at line 88 → migrate to `resolveFoodStore(services, ctx.userId, ctx.spaceId)`
- `handleServingsReply(services, text, ctx: MessageContext)` at line 175 → migrate
- `handleCookCallback(services, action, userId, chatId, messageId)` at line 275 → **stays on `requireHousehold`** — receives bare `userId`, no context object, no spaceId
- `handleCookTextAction(services, text, ctx: MessageContext)` at line 463 → migrate if it calls `requireHousehold`
- `handleCookIntent(services, text, ctx: MessageContext)` at line 553 → migrate if it calls `requireHousehold`

- [ ] **Step 1: Migrate handleCookCommand and handleServingsReply**

Replace `requireHousehold(services, ctx.userId)` → `resolveFoodStore(services, ctx.userId, ctx.spaceId)`, rename `hh.sharedStore` → `fh.store`.

- [ ] **Step 2: Keep handleCookCallback on requireHousehold**

`handleCookCallback` receives only `userId: string` — no spaceId available. It stays on `requireHousehold`. This is the same limitation as scheduled jobs: callbacks dispatched through this path use shared store. Add a comment:

```typescript
// handleCookCallback receives bare userId (no context object), so it cannot
// resolve space. Stays on requireHousehold/shared store. To make this space-aware,
// the callback dispatch would need to pass CallbackContext instead of individual fields.
const hh = await requireHousehold(services, userId);
```

- [ ] **Step 3: Build and test**

Run: `pnpm build && pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/food/src/handlers/cook-mode.ts
git commit -m "feat: migrate cook-mode interactive handlers to resolveFoodStore"
```

---

### Task 8: Enrich receipt and price frontmatter with entity_keys

**Files:**
- Modify: `apps/food/src/handlers/photo.ts:205-212`
- Modify: `apps/food/src/services/price-store.ts:28-38`
- Test: `apps/food/src/__tests__/photo-handler.test.ts`

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
Expected: FAIL

- [ ] **Step 3: Implement receipt entity_keys enrichment**

In `handleReceiptPhoto` in `photo.ts`, replace the frontmatter generation:

```typescript
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

- [ ] **Step 4: Implement price entity_keys enrichment**

In `apps/food/src/services/price-store.ts`, in `formatPriceFile` (line 28), replace entity_keys:

```typescript
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

- [ ] **Step 5: Run tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/food/src/handlers/photo.ts apps/food/src/services/price-store.ts apps/food/src/__tests__/
git commit -m "feat: enrich receipt and price entity_keys with item names and caption labels"
```

---

### Task 9: Receipt capture response with line items

**Files:**
- Modify: `apps/food/src/handlers/photo.ts:239-247`
- Test: `apps/food/src/__tests__/photo-handler.test.ts`

- [ ] **Step 1: Write failing tests**

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

	await handlePhoto(services, createPhotoCtx('receipt'));

	const message = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
	expect(message).toContain('2026-04-14-');
});
```

- [ ] **Step 2: Implement line-item response**

In `handleReceiptPhoto`, replace the Telegram send (uses existing `escapeMarkdown` utility, legacy Telegram Markdown mode):

```typescript
const maxDisplayItems = 10;
const itemLines = parsed.lineItems.slice(0, maxDisplayItems).map(
	(item: { name: string; totalPrice: number }) =>
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

- [ ] **Step 3: Run tests**

Run: `pnpm exec vitest run apps/food/src/__tests__/photo-handler.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/food/src/handlers/photo.ts apps/food/src/__tests__/photo-handler.test.ts
git commit -m "feat: include line items and receipt ID in capture response"
```

---

### Task 10: Food manifest intents

**Files:**
- Modify: `apps/food/manifest.yaml`

- [ ] **Step 1: Add intents**

After line 36 (`"user wants to see food spending"`):

```yaml
      - "user wants to see receipt details or look up items from a receipt"
      - "user asks about prices at a specific store"
```

- [ ] **Step 2: Build**

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

Create `scripts/migrate-shared-to-space.ts` (run from repo root):

```typescript
#!/usr/bin/env npx tsx
/**
 * Migrate legacy shared food data to a space-scoped directory.
 *
 * Usage: npx tsx scripts/migrate-shared-to-space.ts <spaceId> [--dry-run]
 *
 * Non-destructive: copies files, skips existing, does not delete originals.
 * Run from the repository root (where data/ lives).
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const spaceId = args.find((a) => !a.startsWith('--'));

if (!spaceId) {
	console.error('Usage: npx tsx scripts/migrate-shared-to-space.ts <spaceId> [--dry-run]');
	process.exit(1);
}

// Validate spaceId exists
const spacesPath = join('data', 'system', 'spaces.yaml');
if (!existsSync(spacesPath)) {
	console.error(`No spaces.yaml found at ${spacesPath}. Run from repo root.`);
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
			} else if (dryRun) {
				console.log(`  WOULD COPY ${relative('.', srcPath)} → ${relative('.', destPath)}`);
				copied++;
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

console.log(`${dryRun ? '[DRY RUN] ' : ''}Migrating ${srcDir} → ${destDir}\n`);
copyRecursive(srcDir, destDir);
console.log(`\nDone: ${copied} ${dryRun ? 'would be copied' : 'copied'}, ${skipped} skipped, ${errors} errors`);
if (errors > 0) process.exit(1);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrate-shared-to-space.ts
git commit -m "feat: add legacy shared-to-space data migration script with --dry-run"
```

---

### Task 12: End-to-end data query tests for space-scoped data

**Files:**
- Modify: `core/src/services/data-query/__tests__/data-query.test.ts`

These tests verify the full chain: space-scoped food writes are indexed, queryable, and the existing shared-hidden test still holds.

- [ ] **Step 1: Write tests**

Add after the existing scope tests (around line 700):

```typescript
it('space member can query space-scoped receipt files', async () => {
	await writeDataFile(
		dataDir,
		'spaces/family/food/receipts/2026-04-14-abc.yaml',
		'---\ntitle: "Receipt: Costco"\ntype: receipt\nentity_keys:\n  - costco\n  - receipt 2\n  - eggs\n  - diapers\napp: food\n---\nstore: Costco\nlineItems:\n  - name: Eggs\n    totalPrice: 12.99\n  - name: Diapers\n    totalPrice: 29.99\n',
	);

	const fileIndex = new FileIndexService(dataDir, makeAppScopes([], ['receipts/']));
	await fileIndex.rebuild();

	const llm = makeMockLlm('[0]');
	const svc = new DataQueryServiceImpl({
		fileIndex,
		spaceService: makeSpaceService([{ id: 'family', members: ['matt'] }]),
		llm,
		dataDir,
		logger,
	});

	const result = await svc.query('how much were diapers at costco', 'matt');
	expect(result.empty).toBe(false);
	expect(result.files[0].content).toContain('Diapers');
});

it('space member can query space-scoped price files', async () => {
	await writeDataFile(
		dataDir,
		'spaces/family/food/prices/costco.md',
		'---\nstore: Costco\nslug: costco\ntype: price-list\nentity_keys:\n  - costco\n  - eggs\n  - diapers\napp: food\n---\n## Dairy\n- Eggs: $12.99\n## Baby\n- Diapers: $29.99\n',
	);

	const fileIndex = new FileIndexService(dataDir, makeAppScopes([], ['prices/']));
	await fileIndex.rebuild();

	const llm = makeMockLlm('[0]');
	const svc = new DataQueryServiceImpl({
		fileIndex,
		spaceService: makeSpaceService([{ id: 'family', members: ['matt'] }]),
		llm,
		dataDir,
		logger,
	});

	const result = await svc.query('show me costco prices', 'matt');
	expect(result.empty).toBe(false);
	expect(result.files[0].content).toContain('Eggs');
});

it('non-member cannot query another space\'s food data', async () => {
	await writeDataFile(
		dataDir,
		'spaces/family/food/receipts/2026-04-14-abc.yaml',
		'---\ntitle: "Receipt: Costco"\ntype: receipt\nentity_keys:\n  - costco\napp: food\n---\nstore: Costco\n',
	);

	const fileIndex = new FileIndexService(dataDir, makeAppScopes([], ['receipts/']));
	await fileIndex.rebuild();

	const llm = makeMockLlm('[0]');
	const svc = new DataQueryServiceImpl({
		fileIndex,
		spaceService: makeSpaceService([{ id: 'family', members: ['matt'] }]),
		llm,
		dataDir,
		logger,
	});

	// nina is not in the family space
	const result = await svc.query('show me costco receipt', 'nina');
	expect(result.empty).toBe(true);
});
```

- [ ] **Step 2: Verify existing shared-hidden test still passes**

The test at line 625 (`'shared files are hidden when user belongs to a space'`) must still pass — shared data stays hidden for space members.

- [ ] **Step 3: Run tests**

Run: `pnpm exec vitest run core/src/services/data-query/__tests__/data-query.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add core/src/services/data-query/__tests__/data-query.test.ts
git commit -m "test: end-to-end tests for space-scoped receipt/price data queries"
```

---

### Task 13: Full test suite verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: 6272+ tests passing, 0 failures.

- [ ] **Step 2: Fix any failures**

Common fixes needed:
- Mock setups missing `forSpace` on data service mocks — add `forSpace: vi.fn().mockReturnValue(createMockStore())`.
- Tests that call food handlers without `spaceId` in context — these should still work (spaceId is optional, defaults to shared store).
- Tests that mock `requireHousehold` directly may need adjustment if the handler now calls `resolveFoodStore` instead.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: update test mocks for space-aware food store resolution"
```

---

### Task 14: Update CLAUDE.md

- [ ] **Step 1: Update implementation status**

Add to the Implementation Status section in `CLAUDE.md`:
- Record this phase as complete with date
- Update test counts
- Note migration script: `npx tsx scripts/migrate-shared-to-space.ts <spaceId> [--dry-run]`
- Note that scheduled jobs remain on shared store (explicit limitation)

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for space-aware food data phase"
```
