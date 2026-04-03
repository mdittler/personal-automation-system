/**
 * Tests for cook timer functionality in the cook-mode handler.
 *
 * Covers ck:t (set timer), ck:tc (cancel timer), auto-cancel on navigation,
 * and TTS notification on timer fire.
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
} from '../handlers/cook-mode.js';
import { endSession, getSession, hasActiveSession } from '../services/cook-session.js';
import type { Household, Recipe } from '../types.js';

// ─── Factory helpers ────────────────────────────────────────────────

/**
 * Recipe with step 3 (index 2) containing "Bake for 25 minutes at 375°F."
 * so timer parsing fires on that step.
 */
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'rec-lasagna-001',
		title: 'Lasagna',
		source: 'homemade',
		ingredients: [
			{ name: 'lasagna noodles', quantity: 12, unit: null },
			{ name: 'ground beef', quantity: 1, unit: 'lb' },
			{ name: 'ricotta', quantity: 2, unit: 'cups' },
			{ name: 'mozzarella', quantity: 2, unit: 'cups' },
		],
		instructions: [
			'Cook lasagna noodles until al dente.',
			'Brown ground beef and mix with marinara sauce.',
			'Bake for 25 minutes at 375°F.',
			'Let rest for 10 minutes before serving.',
		],
		servings: 6,
		tags: ['italian', 'baked'],
		ratings: [],
		history: [],
		allergens: ['dairy', 'gluten'],
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

async function startCookingSession(services: CoreServices, recipe = makeRecipe()): Promise<void> {
	setupStoreWithRecipe(services, recipe);
	const ctx = makeCtx();
	await handleCookCommand(services, ['lasagna'], ctx);
	await handleServingsReply(services, '6', ctx);
}

// ─── Cleanup ────────────────────────────────────────────────────────

afterEach(() => {
	for (const userId of ['user1', 'user2']) {
		if (hasActiveSession(userId)) {
			endSession(userId);
		}
	}
});

// ─── Timer set (ck:t) ──────────────────────────────────────────────

describe('ck:t — set timer', () => {
	let services: CoreServices;

	beforeEach(() => {
		vi.useFakeTimers();
		services = createMockCoreServices();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sets timer on step with timing info (step 3, "Bake for 25 minutes")', async () => {
		await startCookingSession(services);
		// Navigate to step 3 (index 2): "Bake for 25 minutes at 375°F."
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 2
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 3

		const session = getSession('user1');
		expect(session).not.toBeNull();
		expect(session!.timerHandle).toBeUndefined();

		await handleCookCallback(services, 't', 'user1', 100, 456);

		expect(session!.timerHandle).toBeDefined();
		expect(session!.timerStepIndex).toBe(2);
	});

	it('sends timer confirmation message when setting timer', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 3

		vi.mocked(services.telegram.editMessage).mockClear();
		await handleCookCallback(services, 't', 'user1', 100, 456);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('Timer set for 25 min'),
			expect.any(Array),
		);
	});

	it('fires timer notification after 25 minutes', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456); // step 3

		await handleCookCallback(services, 't', 'user1', 100, 456);

		vi.mocked(services.telegram.sendWithButtons).mockClear();

		// Advance fake timers by 25 minutes
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Timer done'),
			expect.arrayContaining([
				expect.arrayContaining([
					expect.objectContaining({ callbackData: 'app:hearthstone:ck:n' }),
				]),
			]),
		);
	});

	it('clears timerHandle after timer fires', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);

		await handleCookCallback(services, 't', 'user1', 100, 456);
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

		const session = getSession('user1');
		expect(session?.timerHandle).toBeUndefined();
		expect(session?.timerStepIndex).toBeUndefined();
	});

	it('does nothing when step has no timing (step 1)', async () => {
		await startCookingSession(services);
		// Step 1: "Cook lasagna noodles until al dente." — no timing

		vi.mocked(services.telegram.editMessage).mockClear();
		await handleCookCallback(services, 't', 'user1', 100, 456);

		// editMessage should not be called for timer confirmation
		expect(services.telegram.editMessage).not.toHaveBeenCalled();

		const session = getSession('user1');
		expect(session?.timerHandle).toBeUndefined();
	});

	it('replaces existing timer when setting a new one', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);

		// Set timer once
		await handleCookCallback(services, 't', 'user1', 100, 456);
		const session = getSession('user1');
		const firstHandle = session!.timerHandle;

		// Set timer again — should replace
		await handleCookCallback(services, 't', 'user1', 100, 456);
		const secondHandle = session!.timerHandle;

		// Handle should still be defined and timerStepIndex intact
		expect(secondHandle).toBeDefined();
		expect(session!.timerStepIndex).toBe(2);

		// Old timer should not fire (advance only 25 min — only one notification)
		vi.mocked(services.telegram.sendWithButtons).mockClear();
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

		// Only one timer should fire (the replacement)
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(1);

		// Suppress unused variable warning
		void firstHandle;
	});
});

// ─── Timer cancel (ck:tc) ──────────────────────────────────────────

describe('ck:tc — cancel timer', () => {
	let services: CoreServices;

	beforeEach(() => {
		vi.useFakeTimers();
		services = createMockCoreServices();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('cancels active timer and clears handle', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		const session = getSession('user1');
		expect(session?.timerHandle).toBeDefined();

		await handleCookCallback(services, 'tc', 'user1', 100, 456);

		expect(session?.timerHandle).toBeUndefined();
		expect(session?.timerStepIndex).toBeUndefined();
	});

	it('does not fire timer after cancellation', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);
		await handleCookCallback(services, 'tc', 'user1', 100, 456);

		vi.mocked(services.telegram.sendWithButtons).mockClear();
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

		// Timer was cancelled — should not fire "Timer done"
		const timerCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls.filter(
			([, msg]) => typeof msg === 'string' && msg.includes('Timer done'),
		);
		expect(timerCalls).toHaveLength(0);
	});

	it('restores normal step buttons after cancel', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		vi.mocked(services.telegram.editMessage).mockClear();
		await handleCookCallback(services, 'tc', 'user1', 100, 456);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			456,
			expect.stringContaining('Step 3 of 4'),
			expect.any(Array),
		);
	});
});

// ─── Auto-cancel on navigation ─────────────────────────────────────

describe('auto-cancel on navigation', () => {
	let services: CoreServices;

	beforeEach(() => {
		vi.useFakeTimers();
		services = createMockCoreServices();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('auto-cancels timer when advancing to next step (ck:n)', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		const session = getSession('user1');
		expect(session?.timerHandle).toBeDefined();

		// Navigate next — should auto-cancel timer
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		expect(session?.timerHandle).toBeUndefined();

		// Timer should not fire
		vi.mocked(services.telegram.sendWithButtons).mockClear();
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
		const timerCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls.filter(
			([, msg]) => typeof msg === 'string' && msg.includes('Timer done'),
		);
		expect(timerCalls).toHaveLength(0);
	});

	it('auto-cancels timer when going back (ck:b)', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		const session = getSession('user1');
		expect(session?.timerHandle).toBeDefined();

		await handleCookCallback(services, 'b', 'user1', 100, 456);
		expect(session?.timerHandle).toBeUndefined();
	});

	it('auto-cancels timer when pressing done (ck:d)', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		const session = getSession('user1');
		expect(session?.timerHandle).toBeDefined();

		await handleCookCallback(services, 'd', 'user1', 100, 456);
		// Session is now ended; timer was cleared
		expect(hasActiveSession('user1')).toBe(false);
	});

	it('auto-cancels timer on text "next"', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		const session = getSession('user1');
		expect(session?.timerHandle).toBeDefined();

		await handleCookTextAction(services, 'next', makeCtx());
		expect(session?.timerHandle).toBeUndefined();
	});

	it('auto-cancels timer on text "back"', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		const session = getSession('user1');
		await handleCookTextAction(services, 'back', makeCtx());
		expect(session?.timerHandle).toBeUndefined();
	});

	it('auto-cancels timer on text "done"', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 't', 'user1', 100, 456);

		await handleCookTextAction(services, 'done', makeCtx());
		expect(hasActiveSession('user1')).toBe(false);
	});
});

// ─── Timer fire with TTS ───────────────────────────────────────────

describe('timer fire with TTS', () => {
	let services: CoreServices;

	beforeEach(() => {
		vi.useFakeTimers();
		services = createMockCoreServices();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls audio.speak when ttsEnabled is true', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);

		// Enable TTS on the session
		const session = getSession('user1');
		expect(session).not.toBeNull();
		session!.ttsEnabled = true;

		await handleCookCallback(services, 't', 'user1', 100, 456);
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

		// config.get is called for the device, then audio.speak is called
		expect(services.config.get).toHaveBeenCalledWith('cooking_speaker_device');
		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Timer done'),
			// device may be undefined when config returns undefined (mock default)
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('does not call audio.speak when ttsEnabled is false', async () => {
		await startCookingSession(services);
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		await handleCookCallback(services, 'n', 'user1', 100, 456);

		const session = getSession('user1');
		expect(session).not.toBeNull();
		session!.ttsEnabled = false;

		await handleCookCallback(services, 't', 'user1', 100, 456);
		await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

		expect(services.audio.speak).not.toHaveBeenCalled();
	});
});
