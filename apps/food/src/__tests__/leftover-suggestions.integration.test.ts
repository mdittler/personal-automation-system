import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	__clearRecipeSelectionStateForTests,
	SHADOW_HANDLERS,
	handleMessage,
	init,
} from '../index.js';
import type { Household, Leftover, Recipe } from '../types.js';

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh-leftovers',
		name: 'Leftover Test Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'LEFTOV',
		createdAt: '2026-04-01T00:00:00.000Z',
		...overrides,
	};
}

function makeLeftover(overrides: Partial<Leftover> = {}): Leftover {
	return {
		name: 'leftover chili',
		quantity: '2 servings',
		fromRecipe: 'Chili Night',
		storedDate: '2026-04-20',
		expiryEstimate: '2026-04-23',
		status: 'active',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'recipe-1',
		title: 'Chili Mac',
		source: 'family',
		ingredients: [{ name: 'chili', quantity: 1, unit: 'cup' }],
		instructions: ['Heat leftovers', 'Serve'],
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

describe('leftover suggestions integration', () => {
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
		vi.mocked(services.llm.complete).mockResolvedValue('3');
		__clearRecipeSelectionStateForTests();
		await init(services);
	});

	it('returns numbered suggestions and reuses numeric recipe selection for details', async () => {
		sharedStore.storage.set('leftovers.yaml', stringify({ items: [makeLeftover()] }));
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({ id: 'chili-mac' })));
		sharedStore.storage.set('recipes/chili-rice.yaml', stringify(makeRecipe({
			id: 'chili-rice',
			title: 'Chili Rice Bowl',
			ingredients: [{ name: 'chili', quantity: 1, unit: 'cup' }, { name: 'rice', quantity: 2, unit: 'cups' }],
		})));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'what should I do with leftovers?' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Here are a few ideas for your leftovers:'),
		);
		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Reply with a number to see the full recipe.'),
		);

		vi.mocked(services.telegram.send).mockClear();
		await handleMessage(createTestMessageContext({ userId: 'user1', text: '1' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Chili'),
		);
	});

	it('returns the explicit no-match fallback for on-demand suggestions', async () => {
		sharedStore.storage.set('leftovers.yaml', stringify({ items: [makeLeftover({ name: 'leftover curry' })] }));
		sharedStore.storage.set('recipes/pancakes.yaml', stringify(makeRecipe({
			id: 'pancakes',
			title: 'Weekend Pancakes',
			ingredients: [{ name: 'flour', quantity: 2, unit: 'cups' }],
		})));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'ideas for leftovers?' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			"I couldn't find any saved recipes that match your current leftovers yet.",
		);
	});

	it('keeps leftover view phrases on the leftover list path', async () => {
		sharedStore.storage.set('leftovers.yaml', stringify({ items: [makeLeftover({ name: 'leftover rice' })] }));

		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'what leftovers are there?' }));

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('leftover rice'),
			expect.any(Array),
		);
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Here are a few ideas for your leftovers:'),
		);
	});

	it('keeps leftover add phrases on the add path', async () => {
		await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we have leftover chili' }));

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('🥘 Logged: chili'),
		);
		expect(sharedStore.write).toHaveBeenCalledWith('leftovers.yaml', expect.any(String));
	});

	it('keeps the shadow-primary leftover handler aligned with suggestion routing', async () => {
		sharedStore.storage.set('leftovers.yaml', stringify({ items: [makeLeftover()] }));
		sharedStore.storage.set('recipes/chili-mac.yaml', stringify(makeRecipe({ id: 'chili-mac' })));

		await SHADOW_HANDLERS['user wants to log leftovers']!(
			createTestMessageContext({ userId: 'user1', text: 'how can we use these leftovers?' }),
		);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Here are a few ideas for your leftovers:'),
		);
	});
});
