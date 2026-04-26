import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	__clearRecipeSelectionStateForTests,
	handleCommand,
	handleMessage,
	init,
} from '../index.js';
import type { Household, Recipe } from '../types.js';

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh-photos',
		name: 'Photo Test Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'PHOTO1',
		createdAt: '2026-04-01T00:00:00.000Z',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'recipe-1',
		title: 'Chili Mac',
		source: 'family',
		ingredients: [{ name: 'chili', quantity: 1, unit: 'cup' }],
		instructions: ['Heat', 'Serve'],
		servings: 4,
		prepTime: 10,
		cookTime: 15,
		tags: [],
		ratings: [],
		history: [],
		allergens: [],
		status: 'confirmed',
		createdAt: '2026-04-01T00:00:00.000Z',
		updatedAt: '2026-04-01T00:00:00.000Z',
		...overrides,
	};
}

function createStore(data: Record<string, string | null> = {}) {
	const storage = new Map(Object.entries(data));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		append: vi.fn(),
		list: vi.fn(async (path: string) => {
			if (path !== 'recipes') return [];
			return Array.from(storage.keys())
				.filter((key) => key.startsWith('recipes/') && key.endsWith('.yaml'))
				.map((key) => key.slice('recipes/'.length));
		}),
		exists: vi.fn(),
		archive: vi.fn(),
		storage,
	};
}

describe('recipe photo retrieval integration', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createStore>;

	beforeEach(async () => {
		sharedStore = createStore({
			'household.yaml': stringify(makeHousehold()),
		});
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		vi.mocked(services.data.forUser).mockReturnValue(sharedStore as any);
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'shadow_sample_rate') return 0 as never;
			return undefined as never;
		});
		__clearRecipeSelectionStateForTests();
		await init(services);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns the empty-state message when no recipes with photos exist', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe()));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me recipe photo' }));

		expect(services.telegram.send).toHaveBeenCalledWith('user1', 'No recipes with photos found.');
	});

	it('sends the only available recipe photo directly', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({
			sourcePhoto: 'photos/recipe-chili-mac.b64',
		})));
		sharedStore.storage.set('photos/recipe-chili-mac.b64', Buffer.from('photo-one').toString('base64'));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me recipe photo' }));

		expect(services.telegram.sendPhoto).toHaveBeenCalledWith(
			'user1',
			expect.any(Buffer),
			'Original photo: Chili Mac',
		);
	});

	it('uses pendingPhotoSelection for numeric replies in the multi-photo flow', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({
			id: 'chili-mac',
			title: 'Chili Mac',
			sourcePhoto: 'photos/chili-mac.b64',
		})));
		sharedStore.storage.set('recipes/soup.yaml', stringify(makeRecipe({
			id: 'soup',
			title: 'Soup Night',
			sourcePhoto: 'photos/soup.b64',
		})));
		sharedStore.storage.set('photos/chili-mac.b64', Buffer.from('photo-one').toString('base64'));
		sharedStore.storage.set('photos/soup.b64', Buffer.from('photo-two').toString('base64'));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me recipe photo' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Which recipe photo?'),
		);

		vi.mocked(services.telegram.send).mockClear();
		await handleMessage(createTestMessageContext({ userId: 'user1', text: '1' }));

		expect(services.telegram.sendPhoto).toHaveBeenCalledWith(
			'user1',
			expect.any(Buffer),
			'Original photo: Chili Mac',
		);
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Reply with a number to see the full recipe.'),
		);
	});

	it('keeps pending photo selection ahead of generic recipe selection on out-of-range replies', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({
			id: 'chili-mac',
			title: 'Chili Mac',
			sourcePhoto: 'photos/chili-mac.b64',
		})));
		sharedStore.storage.set('recipes/soup.yaml', stringify(makeRecipe({
			id: 'soup',
			title: 'Soup Night',
			sourcePhoto: 'photos/soup.b64',
		})));
		sharedStore.storage.set('recipes/weekday-pasta.yaml', stringify(makeRecipe({
			id: 'weekday-pasta',
			title: 'Weekday Pasta',
			ingredients: [{ name: 'pasta', quantity: 1, unit: 'box' }],
		})));
		sharedStore.storage.set('photos/chili-mac.b64', Buffer.from('photo-one').toString('base64'));
		sharedStore.storage.set('photos/soup.b64', Buffer.from('photo-two').toString('base64'));

		await handleCommand?.('recipes', [], createTestMessageContext({ userId: 'user1', text: '/recipes' }));
		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me recipe photo' }));

		vi.mocked(services.telegram.send).mockClear();
		vi.mocked(services.telegram.sendPhoto).mockClear();
		await handleMessage(createTestMessageContext({ userId: 'user1', text: '3' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			'Please reply with a number between 1 and 2 to choose a recipe photo.',
		);
		expect(services.telegram.sendPhoto).not.toHaveBeenCalled();
	});

	it('returns the existing no-source-photo message for a queried recipe', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({ title: 'Chili Mac' })));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me the recipe photo for chili mac' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			`"Chili Mac" wasn't saved from a photo, so there's no original photo to show.`,
		);
	});

	it('returns the missing-photo message when the stored file is gone', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({
			title: 'Chili Mac',
			sourcePhoto: 'photos/missing.b64',
		})));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me the recipe photo for chili mac' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			'The photo for "Chili Mac" could not be found. It may have been removed.',
		);
	});

	it('returns the existing not-found message for unmatched recipe photo queries', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({ title: 'Chili Mac' })));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me the recipe photo for tacos' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			`Couldn't find a recipe matching "tacos".`,
		);
	});

	it('preserves generic numeric recipe selection through lastSearchResults', async () => {
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({ id: 'chili-mac' })));
		sharedStore.storage.set('recipes/soup.yaml', stringify(makeRecipe({ id: 'soup', title: 'Soup Night' })));

		await handleCommand?.('recipes', ['chili'], createTestMessageContext({ userId: 'user1', text: '/recipes chili' }));

		vi.mocked(services.telegram.send).mockClear();
		await handleMessage(createTestMessageContext({ userId: 'user1', text: '1' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Chili Mac'),
		);
	});

	it('falls back to generic recipe selection after pending photo state expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));

		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({
			id: 'chili-mac',
			title: 'Chili Mac',
			sourcePhoto: 'photos/chili-mac.b64',
		})));
		sharedStore.storage.set('recipes/soup.yaml', stringify(makeRecipe({
			id: 'soup',
			title: 'Soup Night',
			sourcePhoto: 'photos/soup.b64',
		})));
		sharedStore.storage.set('photos/chili-mac.b64', Buffer.from('photo-one').toString('base64'));
		sharedStore.storage.set('photos/soup.b64', Buffer.from('photo-two').toString('base64'));

		await handleCommand?.('recipes', ['chili'], createTestMessageContext({ userId: 'user1', text: '/recipes chili' }));
		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me recipe photo' }));

		vi.setSystemTime(new Date('2026-04-25T12:06:00.000Z'));
		vi.mocked(services.telegram.send).mockClear();
		vi.mocked(services.telegram.sendPhoto).mockClear();
		await handleMessage(createTestMessageContext({ userId: 'user1', text: '1' }));

		expect(services.telegram.sendPhoto).not.toHaveBeenCalled();
		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Chili Mac'),
		);
	});
});
