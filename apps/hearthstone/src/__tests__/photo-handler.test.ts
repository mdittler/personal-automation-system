/**
 * Tests for the photo dispatch handler.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handlePhoto } from '../handlers/photo.js';
import type { CoreServices, PhotoContext, ScopedDataStore } from '@pas/core/types';

const testPhoto = Buffer.from('fake-jpeg-data');

function createMockStore() {
	const storage = new Map<string, string>();
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
		delete: vi.fn(),
	};
}

function createMockServices(llmResponse: string) {
	const sharedStore = createMockStore();
	return {
		services: {
			llm: {
				complete: vi.fn().mockResolvedValue(llmResponse),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
			telegram: {
				send: vi.fn().mockResolvedValue(undefined),
				sendPhoto: vi.fn().mockResolvedValue(undefined),
				sendOptions: vi.fn().mockResolvedValue(undefined),
			},
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(createMockStore()),
			},
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		} as unknown as CoreServices,
		sharedStore,
	};
}

function createPhotoCtx(caption?: string): PhotoContext {
	return {
		userId: 'user-1',
		photo: testPhoto,
		caption,
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 123,
		messageId: 456,
	};
}

const validRecipeJson = JSON.stringify({
	title: 'Test Recipe',
	source: 'photo',
	ingredients: [{ name: 'flour', quantity: 2, unit: 'cups' }],
	instructions: ['Mix', 'Bake'],
	servings: 4,
	tags: ['easy'],
	allergens: [],
});

const validReceiptJson = JSON.stringify({
	store: 'Grocery Store',
	date: '2026-04-05',
	lineItems: [{ name: 'Milk', quantity: 1, unitPrice: 3.99, totalPrice: 3.99 }],
	subtotal: 3.99,
	tax: 0.24,
	total: 4.23,
});

const validPantryJson = JSON.stringify([
	{ name: 'eggs', quantity: '12', category: 'dairy' },
]);

const validGroceryJson = JSON.stringify({
	items: [{ name: 'bread', quantity: 1, unit: 'loaf' }],
	isRecipe: false,
});

describe('Photo Handler', () => {
	describe('caption-based routing', () => {
		it('routes recipe caption to recipe parser', async () => {
			const { services } = createMockServices(validRecipeJson);
			const ctx = createPhotoCtx('save this recipe');

			await handlePhoto(services, ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'user-1',
				expect.stringContaining('Test Recipe'),
			);
		});

		it('routes receipt caption to receipt parser', async () => {
			const { services } = createMockServices(validReceiptJson);
			const ctx = createPhotoCtx('grocery receipt');

			await handlePhoto(services, ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'user-1',
				expect.stringContaining('Grocery Store'),
			);
		});

		it('routes pantry caption to pantry parser', async () => {
			const { services } = createMockServices(validPantryJson);
			const ctx = createPhotoCtx('what is in my fridge');

			await handlePhoto(services, ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'user-1',
				expect.stringContaining('eggs'),
			);
		});

		it('routes grocery list caption to grocery parser', async () => {
			const { services } = createMockServices(validGroceryJson);
			const ctx = createPhotoCtx('add these to grocery list');

			await handlePhoto(services, ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'user-1',
				expect.stringContaining('bread'),
			);
		});
	});

	describe('no caption — vision classification fallback', () => {
		it('uses LLM vision to classify when no caption is provided', async () => {
			// First call: classification. Second call: actual parsing.
			const completeFn = vi.fn()
				.mockResolvedValueOnce('recipe')
				.mockResolvedValueOnce(validRecipeJson);
			const { services } = createMockServices('');
			services.llm.complete = completeFn;

			const ctx = createPhotoCtx();

			await handlePhoto(services, ctx);

			// First call should be classification with image
			expect(completeFn).toHaveBeenCalledTimes(2);
			expect(completeFn.mock.calls[0]?.[1]).toEqual(
				expect.objectContaining({
					images: [{ data: testPhoto, mimeType: 'image/jpeg' }],
				}),
			);
		});
	});

	describe('recipe photo — storage', () => {
		it('saves photo and recipe to data store', async () => {
			const { services, sharedStore } = createMockServices(validRecipeJson);
			const ctx = createPhotoCtx('save recipe');

			await handlePhoto(services, ctx);

			// Should have written the photo (base64) and the recipe
			expect(sharedStore.write).toHaveBeenCalledWith(
				expect.stringContaining('photos/recipe-'),
				expect.any(String),
			);
			expect(sharedStore.write).toHaveBeenCalledWith(
				expect.stringContaining('recipes/'),
				expect.any(String),
			);
		});
	});

	describe('receipt photo — storage', () => {
		it('saves receipt data to data store', async () => {
			const { services, sharedStore } = createMockServices(validReceiptJson);
			const ctx = createPhotoCtx('receipt');

			await handlePhoto(services, ctx);

			expect(sharedStore.write).toHaveBeenCalledWith(
				expect.stringContaining('receipts/'),
				expect.any(String),
			);
		});
	});

	describe('error handling', () => {
		it('sends friendly error on LLM failure', async () => {
			const { services } = createMockServices('');
			services.llm.complete = vi.fn().mockRejectedValue(new Error('LLM down'));

			const ctx = createPhotoCtx('recipe');

			await handlePhoto(services, ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'user-1',
				expect.stringContaining('Sorry'),
			);
		});
	});
});
