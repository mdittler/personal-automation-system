/**
 * Tests for the cook-mode handler — Telegram orchestration for step-by-step cooking.
 */

import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import type { CoreServices, MessageContext, ScopedDataStore } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleCookCallback,
	handleCookCommand,
	handleCookTextAction,
	handleServingsReply,
	hasPendingCookRecipe,
	isCookModeActive,
} from '../handlers/cook-mode.js';
import { endSession, hasActiveSession } from '../services/cook-session.js';
import type { Household, Recipe } from '../types.js';

// ─── Factory helpers ────────────────────────────────────────────────

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'rec-pasta-001',
		title: 'Pasta Carbonara',
		source: 'homemade',
		ingredients: [
			{ name: 'spaghetti', quantity: 1, unit: 'lb' },
			{ name: 'bacon', quantity: 8, unit: 'oz' },
			{ name: 'eggs', quantity: 3, unit: null },
			{ name: 'parmesan', quantity: 1, unit: 'cup' },
		],
		instructions: [
			'Cook spaghetti according to package directions.',
			'Fry bacon until crispy. Reserve fat.',
			'Mix eggs and parmesan in a bowl.',
			'Toss hot pasta with bacon, then egg mixture.',
		],
		servings: 4,
		tags: ['italian', 'pasta'],
		ratings: [],
		history: [],
		allergens: ['eggs', 'dairy'],
		status: 'confirmed',
		createdAt: '2026-03-31',
		updatedAt: '2026-03-31',
		...overrides,
	};
}

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'household-001',
		name: 'Test Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
	return {
		userId: 'user1',
		chatId: 100,
		text: '',
		...overrides,
	};
}

function recipeYaml(recipe: Recipe): string {
	return stringify(recipe);
}

function householdYaml(household: Household): string {
	return stringify(household);
}

/**
 * Set up a shared store that returns a household and one recipe.
 */
function setupStoreWithRecipe(
	services: CoreServices,
	recipe: Recipe = makeRecipe(),
	household: Household = makeHousehold(),
): ScopedDataStore {
	const sharedStore = createMockScopedStore({
		read: vi.fn().mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return householdYaml(household);
			if (path.startsWith('recipes/') && path.endsWith('.yaml')) {
				return recipeYaml(recipe);
			}
			return '';
		}),
		list: vi.fn().mockResolvedValue([`recipes/${recipe.id}.yaml`]),
		exists: vi.fn().mockResolvedValue(true),
	});
	vi.mocked(services.data.forShared).mockReturnValue(sharedStore);
	return sharedStore;
}

// Clean up sessions between tests
afterEach(() => {
	for (const userId of ['user1', 'user2']) {
		if (hasActiveSession(userId)) {
			endSession(userId);
		}
	}
});

// ─── handleCookCommand ──────────────────────────────────────────────

describe('handleCookCommand', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('sends servings prompt when recipe found', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('servings'),
		);
		expect(hasPendingCookRecipe('user1')).toBe(true);
	});

	it('shows search results as buttons when recipe not found by title but has search matches', async () => {
		// "italian" won't match title "Pasta Carbonara" via findRecipeByTitle,
		// but searchRecipes should find it via tags
		const recipe = makeRecipe({ tags: ['italian'] });
		setupStoreWithRecipe(services, recipe);
		const ctx = makeCtx();
		await handleCookCommand(services, ['italian'], ctx);

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Did you mean'),
			expect.any(Array),
		);
	});

	it('shows no-match message when no search results', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['zzzzzznonexistent'], ctx);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining("couldn't find"),
		);
	});

	it('sends error when no household exists', async () => {
		const sharedStore = createMockScopedStore({
			read: vi.fn().mockResolvedValue(''),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta'], ctx);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('household'),
		);
	});

	it('warns when already in cook mode', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();

		// Start first cook session manually
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		// Try to start another
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('already cooking'),
		);
	});

	it('shows recipe selection buttons when no recipe name given', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, [], ctx);

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Which recipe'),
			expect.any(Array),
		);
	});

	it('handles recipe selection callback', async () => {
		const recipe = makeRecipe();
		setupStoreWithRecipe(services, recipe);

		await handleCookCallback(services, `sel:${recipe.id}`, 'user1', 100, 456);

		// Should edit the selection message and prompt for servings
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('Selected'),
		);
		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('servings'),
		);
		expect(hasPendingCookRecipe('user1')).toBe(true);
	});
});

// ─── handleServingsReply ────────────────────────────────────────────

describe('handleServingsReply', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('creates session and sends first step for valid servings', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();

		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		expect(isCookModeActive('user1')).toBe(true);
		// Should send ingredients + first step
		expect(services.telegram.sendWithButtons).toHaveBeenCalled();
	});

	it('scales when user says "double"', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();

		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, 'double', ctx);

		expect(isCookModeActive('user1')).toBe(true);
	});

	it('sends error for invalid servings input', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();

		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, 'banana', ctx);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining("didn't understand"),
		);
		expect(isCookModeActive('user1')).toBe(false);
	});

	it('allows retry after invalid input', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();

		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, 'banana', ctx);

		// Should still have pending recipe — user can retry
		expect(hasPendingCookRecipe('user1')).toBe(true);

		// Now enter valid servings
		await handleServingsReply(services, '4', ctx);
		expect(isCookModeActive('user1')).toBe(true);
	});

	it('does nothing when no pending recipe', async () => {
		const ctx = makeCtx();
		await handleServingsReply(services, '4', ctx);
		expect(isCookModeActive('user1')).toBe(false);
	});
});

// ─── handleCookCallback ────────────────────────────────────────────

describe('handleCookCallback', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	async function startCooking(): Promise<void> {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);
	}

	it('advances step on ck:n', async () => {
		await startCooking();
		await handleCookCallback(services, 'n', 'user1', 100, 456);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('Step 2 of 4'),
			expect.any(Array),
		);
	});

	it('goes back on ck:b', async () => {
		await startCooking();
		// Advance first, then go back
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'b', 'user1', 100, 456);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('Step 1 of 4'),
			expect.any(Array),
		);
	});

	it('repeats current step on ck:r', async () => {
		await startCooking();
		await handleCookCallback(services, 'r', 'user1', 100, 456);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('Step 1 of 4'),
			expect.any(Array),
		);
	});

	it('ends session on ck:d', async () => {
		await startCooking();
		await handleCookCallback(services, 'd', 'user1', 100, 456);

		expect(isCookModeActive('user1')).toBe(false);
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('done'),
			expect.anything(),
		);
	});

	it('shows completion when advancing past last step', async () => {
		await startCooking();
		// Recipe has 4 steps (0,1,2,3) — advance 3 times to reach last, then once more
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 2
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 3
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 4
		await handleCookCallback(services, 'n', 'user1', 100, 456); // completed

		// Should have sent completion message
		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Pasta Carbonara'),
		);
		expect(isCookModeActive('user1')).toBe(false);
	});

	it('sends friendly message when going back from step 1', async () => {
		await startCooking();
		await handleCookCallback(services, 'b', 'user1', 100, 456);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('first step'),
			expect.any(Array),
		);
	});

	it('ignores callback when no active session', async () => {
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		// Should not throw, should send a message
		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('No active'),
		);
	});
});

// ─── handleCookTextAction ──────────────────────────────────────────

describe('handleCookTextAction', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	async function startCooking(): Promise<void> {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);
	}

	it('returns true and advances on "next"', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, 'next', makeCtx());
		expect(result).toBe(true);
	});

	it('returns true and goes back on "back"', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, 'back', makeCtx());
		expect(result).toBe(true);
	});

	it('returns true and goes back on "previous"', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, 'previous', makeCtx());
		expect(result).toBe(true);
	});

	it('returns true and repeats on "repeat"', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, 'repeat', makeCtx());
		expect(result).toBe(true);
	});

	it('returns true and ends on "done"', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, 'done', makeCtx());
		expect(result).toBe(true);
		expect(isCookModeActive('user1')).toBe(false);
	});

	it('returns true and ends on "exit"', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, 'exit', makeCtx());
		expect(result).toBe(true);
		expect(isCookModeActive('user1')).toBe(false);
	});

	it('returns false for non-cook text', async () => {
		await startCooking();
		const result = await handleCookTextAction(services, "what's for dinner?", makeCtx());
		expect(result).toBe(false);
	});

	it('returns false when no active session', async () => {
		const result = await handleCookTextAction(services, 'next', makeCtx());
		expect(result).toBe(false);
	});
});

// ─── Single-step recipe ────────────────────────────────────────────

describe('single-step recipe', () => {
	it('completes immediately on next', async () => {
		const services = createMockCoreServices();
		const recipe = makeRecipe({ instructions: ['Just serve it.'] });
		setupStoreWithRecipe(services, recipe);

		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		// Now advance — should complete immediately
		await handleCookCallback(services, 'n', 'user1', 100, 456);

		expect(isCookModeActive('user1')).toBe(false);
		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Pasta Carbonara'),
		);
	});
});
