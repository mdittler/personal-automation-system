/**
 * Tests for interaction recording in the food app.
 *
 * Verifies that services.interactionContext.record() is called with the correct
 * entry shape after each successful data write, and that the call is a no-op
 * when interactionContext is undefined.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleMessage,
	handleCommand,
	init,
} from '../index.js';
import { handlePhoto } from '../handlers/photo.js';
import type { PhotoContext } from '@pas/core/types';
import type { Household } from '../types.js';

// ─── Shared fixtures ────────────────────────────────────────────

const sampleHousehold: Household = {
	id: 'hh1',
	name: 'Test Household',
	createdBy: 'user1',
	members: ['user1'],
	joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

function makeHouseholdYaml(): string {
	return stringify(sampleHousehold);
}

function createMockScopedStore(initialData: Record<string, string> = {}) {
	const storage = new Map<string, string>(Object.entries(initialData));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		append: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
		delete: vi.fn(),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

interface MockInteractionContext {
	record: ReturnType<typeof vi.fn>;
	getRecent: ReturnType<typeof vi.fn>;
}

function makeInteractionContext(): MockInteractionContext {
	return {
		record: vi.fn(),
		getRecent: vi.fn().mockReturnValue([]),
	};
}

// ─── Receipt photo ───────────────────────────────────────────────

describe('interaction recording — receipt_captured', () => {
	const testPhoto = Buffer.from('fake-jpeg-data');

	const validReceiptJson = JSON.stringify({
		store: 'Grocery Store',
		date: '2026-04-05',
		lineItems: [{ name: 'Milk', quantity: 1, unitPrice: 3.99, totalPrice: 3.99 }],
		subtotal: 3.99,
		tax: 0.24,
		total: 4.23,
	});

	function createReceiptServices(interactionContext?: MockInteractionContext) {
		const sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		const services = {
			llm: {
				complete: vi.fn().mockResolvedValue(validReceiptJson),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
			telegram: {
				send: vi.fn().mockResolvedValue(undefined),
				sendPhoto: vi.fn().mockResolvedValue(undefined),
				sendOptions: vi.fn().mockResolvedValue(undefined),
				sendWithButtons: vi.fn().mockResolvedValue(undefined),
				editMessage: vi.fn().mockResolvedValue(undefined),
			},
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(createMockScopedStore()),
			},
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() },
			interactionContext,
		} as unknown as CoreServices;
		return { services, sharedStore };
	}

	function createPhotoCtx(caption?: string): PhotoContext {
		return {
			userId: 'user1',
			photo: testPhoto,
			caption,
			mimeType: 'image/jpeg',
			timestamp: new Date(),
			chatId: 123,
			messageId: 456,
		};
	}

	it('records receipt_captured after a successful receipt photo write', async () => {
		const interactionContext = makeInteractionContext();
		const { services } = createReceiptServices(interactionContext);
		const ctx = createPhotoCtx('grocery receipt');

		await handlePhoto(services, ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'receipt_captured',
			entityType: 'receipt',
			scope: 'shared',
		});
	});

	it('does not throw when interactionContext is undefined', async () => {
		const { services } = createReceiptServices(undefined);
		const ctx = createPhotoCtx('grocery receipt');

		await expect(handlePhoto(services, ctx)).resolves.not.toThrow();
	});
});

// ─── Recipe saved (handleSaveRecipe) ─────────────────────────────

describe('interaction recording — recipe_saved', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let interactionContext: MockInteractionContext;

	const parsedRecipeJson = JSON.stringify({
		title: 'Pasta Bake',
		source: 'homemade',
		ingredients: [{ name: 'pasta', quantity: 200, unit: 'g' }],
		instructions: ['Boil pasta', 'Bake'],
		servings: 4,
		tags: [],
		allergens: [],
	});

	beforeEach(async () => {
		interactionContext = makeInteractionContext();
		sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		// Override interactionContext on the mock services
		(services as any).interactionContext = interactionContext;
		vi.mocked(services.llm.complete).mockResolvedValue(parsedRecipeJson);
		await init(services);
	});

	it('records recipe_saved after saving a recipe from text', async () => {
		const ctx = createTestMessageContext({
			text: 'save this recipe: Pasta Bake',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'recipe_saved',
			entityType: 'recipe',
			scope: 'shared',
		});
	});

	it('does not throw when interactionContext is undefined', async () => {
		(services as any).interactionContext = undefined;
		const ctx = createTestMessageContext({
			text: 'save this recipe: Pasta Bake',
			userId: 'user1',
		});

		await expect(handleMessage?.(ctx)).resolves.not.toThrow();
	});
});

// ─── Grocery updated (handleGroceryAdd) ──────────────────────────

describe('interaction recording — grocery_updated', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let interactionContext: MockInteractionContext;

	beforeEach(async () => {
		interactionContext = makeInteractionContext();
		sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		(services as any).interactionContext = interactionContext;
		// Mock LLM dedup response
		vi.mocked(services.llm.complete).mockResolvedValue(
			JSON.stringify([{ name: 'milk', quantity: 1, unit: 'gallon', department: 'dairy' }]),
		);
		await init(services);
	});

	it('records grocery_updated after adding items to the grocery list', async () => {
		const ctx = createTestMessageContext({
			text: 'add milk to grocery list',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'grocery_updated',
			entityType: 'grocery-list',
			scope: 'shared',
		});
	});

	it('does not throw when interactionContext is undefined', async () => {
		(services as any).interactionContext = undefined;
		const ctx = createTestMessageContext({
			text: 'add milk to grocery list',
			userId: 'user1',
		});

		await expect(handleMessage?.(ctx)).resolves.not.toThrow();
	});
});

// ─── Meal plan finalized (handleMealPlanGenerate) ─────────────────

describe('interaction recording — meal_plan_finalized', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let interactionContext: MockInteractionContext;

	const mealPlanJson = JSON.stringify({
		meals: [
			{
				date: '2026-04-21',
				mealType: 'dinner',
				recipeTitle: 'Chicken Tacos',
				description: 'Easy weeknight meal',
				recipeId: null,
				isNew: true,
			},
		],
	});

	beforeEach(async () => {
		interactionContext = makeInteractionContext();
		sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		(services as any).interactionContext = interactionContext;
		vi.mocked(services.llm.complete).mockResolvedValue(mealPlanJson);
		await init(services);
	});

	it('records meal_plan_finalized after generating a meal plan', async () => {
		const ctx = createTestMessageContext({
			text: 'plan meals for this week',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'meal_plan_finalized',
			entityType: 'meal-plan',
			scope: 'shared',
		});
	});

	it('does not throw when interactionContext is undefined', async () => {
		(services as any).interactionContext = undefined;
		const ctx = createTestMessageContext({
			text: 'plan meals for this week',
			userId: 'user1',
		});

		await expect(handleMessage?.(ctx)).resolves.not.toThrow();
	});
});

// ─── Recipe saved via photo (handleRecipePhoto) ───────────────────

describe('interaction recording — recipe_saved via photo', () => {
	const testPhoto = Buffer.from('fake-jpeg-data');

	const validRecipeJson = JSON.stringify({
		title: 'Chocolate Cake',
		source: 'cookbook',
		ingredients: [{ name: 'flour', quantity: 200, unit: 'g' }],
		instructions: ['Mix', 'Bake'],
		servings: 8,
		tags: [],
		allergens: [],
	});

	function createRecipePhotoServices(interactionContext?: MockInteractionContext) {
		const sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		const services = {
			llm: {
				complete: vi.fn().mockResolvedValue(validRecipeJson),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
			telegram: {
				send: vi.fn().mockResolvedValue(undefined),
				sendPhoto: vi.fn().mockResolvedValue(undefined),
				sendOptions: vi.fn().mockResolvedValue(undefined),
				sendWithButtons: vi.fn().mockResolvedValue(undefined),
				editMessage: vi.fn().mockResolvedValue(undefined),
			},
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(createMockScopedStore()),
			},
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() },
			interactionContext,
		} as unknown as CoreServices;
		return { services, sharedStore };
	}

	function createPhotoCtx(caption?: string): PhotoContext {
		return {
			userId: 'user1',
			photo: testPhoto,
			caption,
			mimeType: 'image/jpeg',
			timestamp: new Date(),
			chatId: 123,
			messageId: 456,
		};
	}

	it('records recipe_saved after a successful recipe photo write', async () => {
		const interactionContext = makeInteractionContext();
		const { services } = createRecipePhotoServices(interactionContext);
		const ctx = createPhotoCtx('save this recipe');

		await handlePhoto(services, ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'recipe_saved',
			entityType: 'recipe',
			scope: 'shared',
		});
		// entityId and filePaths should be populated with the saved recipe ID
		expect(call[1].entityId).toBeTruthy();
		expect(call[1].filePaths?.[0]).toMatch(/^recipes\/.+\.yaml$/);
	});

	it('does not throw when interactionContext is undefined', async () => {
		const { services } = createRecipePhotoServices(undefined);
		const ctx = createPhotoCtx('save this recipe');

		await expect(handlePhoto(services, ctx)).resolves.not.toThrow();
	});
});

// ─── Grocery updated via photo (handleGroceryPhoto) ──────────────

describe('interaction recording — grocery_updated via photo', () => {
	const testPhoto = Buffer.from('fake-jpeg-data');

	const validGroceryJson = JSON.stringify({
		items: [
			{ name: 'apples', quantity: 6, unit: null },
			{ name: 'bread', quantity: 1, unit: 'loaf' },
		],
		isRecipe: false,
	});

	function createGroceryPhotoServices(interactionContext?: MockInteractionContext) {
		const sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		const services = {
			llm: {
				complete: vi.fn().mockResolvedValue(validGroceryJson),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
			telegram: {
				send: vi.fn().mockResolvedValue(undefined),
				sendPhoto: vi.fn().mockResolvedValue(undefined),
				sendOptions: vi.fn().mockResolvedValue(undefined),
				sendWithButtons: vi.fn().mockResolvedValue(undefined),
				editMessage: vi.fn().mockResolvedValue(undefined),
			},
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(createMockScopedStore()),
			},
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() },
			interactionContext,
		} as unknown as CoreServices;
		return { services, sharedStore };
	}

	function createPhotoCtx(caption?: string): PhotoContext {
		return {
			userId: 'user1',
			photo: testPhoto,
			caption,
			mimeType: 'image/jpeg',
			timestamp: new Date(),
			chatId: 123,
			messageId: 456,
		};
	}

	it('records grocery_updated after a successful grocery photo write', async () => {
		const interactionContext = makeInteractionContext();
		const { services } = createGroceryPhotoServices(interactionContext);
		const ctx = createPhotoCtx('add to grocery list');

		await handlePhoto(services, ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'grocery_updated',
			entityType: 'grocery-list',
			filePaths: ['grocery/active.yaml'],
			scope: 'shared',
		});
	});

	it('does not throw when interactionContext is undefined', async () => {
		const { services } = createGroceryPhotoServices(undefined);
		const ctx = createPhotoCtx('add to grocery list');

		await expect(handlePhoto(services, ctx)).resolves.not.toThrow();
	});
});

// ─── Price updated (handlePriceUpdateIntent) ──────────────────────

describe('interaction recording — price_updated', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let interactionContext: MockInteractionContext;

	const priceParseJson = JSON.stringify({
		item: 'eggs',
		price: 3.50,
		unit: 'dozen',
		store: 'Costco',
		department: 'dairy',
	});

	beforeEach(async () => {
		interactionContext = makeInteractionContext();
		sharedStore = createMockScopedStore({
			'household.yaml': makeHouseholdYaml(),
		});
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		(services as any).interactionContext = interactionContext;
		vi.mocked(services.llm.complete).mockResolvedValue(priceParseJson);
		await init(services);
	});

	it('records price_updated after updating a price', async () => {
		const ctx = createTestMessageContext({
			text: 'eggs are $3.50 at costco',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(interactionContext.record).toHaveBeenCalledOnce();
		const call = vi.mocked(interactionContext.record).mock.calls[0];
		expect(call[0]).toBe('user1');
		expect(call[1]).toMatchObject({
			appId: 'food',
			action: 'price_updated',
			entityType: 'price-list',
			scope: 'shared',
		});
	});

	it('does not throw when interactionContext is undefined', async () => {
		(services as any).interactionContext = undefined;
		const ctx = createTestMessageContext({
			text: 'eggs are $3.50 at costco',
			userId: 'user1',
		});

		await expect(handleMessage?.(ctx)).resolves.not.toThrow();
	});
});
