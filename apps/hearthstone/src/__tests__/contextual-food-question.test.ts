/**
 * Contextual Food Question Tests
 *
 * Tests that handleFoodQuestion enriches the LLM prompt with:
 * 1. User context entries (dietary preferences, allergies, etc.)
 * 2. Active cook session context (current recipe + step)
 *
 * Tested indirectly via handleMessage() since handleFoodQuestion is private.
 * All tests use messages that trigger isFoodQuestionIntent().
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { handleMessage, init } from '../index.js';
import { createSession, endSession } from '../services/cook-session.js';
import type { Household, Recipe } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

const pastaRecipe: Recipe = {
	id: 'pasta-001',
	title: 'Pasta Bolognese',
	source: 'homemade',
	ingredients: [
		{ name: 'ground beef', quantity: 1, unit: 'lb' },
		{ name: 'pasta', quantity: 500, unit: 'g' },
	],
	instructions: ['Brown the beef', 'Add tomato sauce', 'Cook pasta until al dente'],
	servings: 4,
	tags: ['italian'],
	cuisine: 'Italian',
	ratings: [],
	history: [],
	allergens: ['gluten'],
	status: 'confirmed',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

// A message that reliably triggers isFoodQuestionIntent
const FOOD_QUESTION = 'what goes well with pasta';
const USER_ID = 'matt';

// ─── Test Setup ──────────────────────────────────────────────────────

function createMockStore() {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

describe('Contextual Food Questions', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createMockStore>;

	beforeEach(async () => {
		store = createMockStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(store as any);
		vi.mocked(services.data.forUser).mockReturnValue(store as any);

		// Default: household exists so routing proceeds normally
		store.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			return '';
		});

		// Default LLM response
		vi.mocked(services.llm.complete).mockResolvedValue('Use herbs and a light salad.');

		await init(services);
	});

	afterEach(() => {
		endSession(USER_ID);
	});

	function msg(text: string, userId = USER_ID) {
		return createTestMessageContext({ text, userId });
	}

	// ─── No context, no session ───────────────────────────────────────

	describe('Basic food question (no context, no session)', () => {
		it('calls LLM with base prompt when no context and no active session', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);

			await handleMessage(msg(FOOD_QUESTION));

			expect(services.llm.complete).toHaveBeenCalledOnce();
			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('You are a helpful cooking assistant');
			expect(prompt).toContain('what goes well with pasta');
			// No context or session sections should appear
			expect(prompt).not.toContain('User context');
			expect(prompt).not.toContain('currently cooking');
		});

		it('sends the LLM answer to the user', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);

			await handleMessage(msg(FOOD_QUESTION));

			expect(services.telegram.send).toHaveBeenCalledWith(USER_ID, 'Use herbs and a light salad.');
		});
	});

	// ─── User context ─────────────────────────────────────────────────

	describe('Food question with user context', () => {
		it('includes dietary context in the LLM prompt', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([
				{
					key: 'food-preferences',
					content: 'User is vegetarian and allergic to nuts.',
					lastUpdated: new Date('2026-01-01'),
				},
			]);

			await handleMessage(msg(FOOD_QUESTION));

			expect(services.llm.complete).toHaveBeenCalledOnce();
			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('User context');
			expect(prompt).toContain('User is vegetarian and allergic to nuts.');
		});

		it('joins multiple context entries with newlines', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([
				{
					key: 'food-preferences',
					content: 'Vegetarian.',
					lastUpdated: new Date('2026-01-01'),
				},
				{
					key: 'allergies',
					content: 'Allergic to shellfish.',
					lastUpdated: new Date('2026-01-02'),
				},
			]);

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('Vegetarian.');
			expect(prompt).toContain('Allergic to shellfish.');
		});

		it('searches context store with the expected food-related query', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);

			await handleMessage(msg(FOOD_QUESTION));

			expect(services.contextStore.searchForUser).toHaveBeenCalledWith(
				'food preferences allergies dietary restrictions family',
				USER_ID,
			);
		});

		it('excludes context section when context store returns empty array', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).not.toContain('User context');
		});
	});

	// ─── Active cook session ──────────────────────────────────────────

	describe('Food question during active cook session', () => {
		it('includes recipe name and current step in the LLM prompt', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);

			// Start a cook session at step 1 (index 1)
			const session = createSession(USER_ID, pastaRecipe, 4, [], null);
			session.currentStep = 1; // "Add tomato sauce"

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('currently cooking');
			expect(prompt).toContain('Pasta Bolognese');
			expect(prompt).toContain('Add tomato sauce');
			expect(prompt).toContain('2/3'); // step 2 of 3
		});

		it('includes step 1 context when session is at the beginning', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);

			createSession(USER_ID, pastaRecipe, 4, [], null);
			// currentStep defaults to 0 → step 1

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('currently cooking');
			expect(prompt).toContain('1/3'); // step 1 of 3
			expect(prompt).toContain('Brown the beef');
		});

		it('does not include session section when no active session', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);
			// No createSession call — no active session

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).not.toContain('currently cooking');
		});
	});

	// ─── Context + session combined ───────────────────────────────────

	describe('Food question with both context and active session', () => {
		it('includes both context entries and cook session in the LLM prompt', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([
				{
					key: 'food-preferences',
					content: 'Gluten-free diet.',
					lastUpdated: new Date('2026-01-01'),
				},
			]);

			const session = createSession(USER_ID, pastaRecipe, 4, [], null);
			session.currentStep = 2; // "Cook pasta until al dente"

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('User context');
			expect(prompt).toContain('Gluten-free diet.');
			expect(prompt).toContain('currently cooking');
			expect(prompt).toContain('Pasta Bolognese');
			expect(prompt).toContain('Cook pasta until al dente');
			expect(prompt).toContain('3/3');
		});
	});

	// ─── Error handling ───────────────────────────────────────────────

	describe('Graceful degradation', () => {
		it('proceeds without context when context store throws', async () => {
			vi.mocked(services.contextStore.searchForUser).mockRejectedValue(
				new Error('Context store unavailable'),
			);

			await handleMessage(msg(FOOD_QUESTION));

			// LLM should still be called — with base prompt only
			expect(services.llm.complete).toHaveBeenCalledOnce();
			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('You are a helpful cooking assistant');
			expect(prompt).not.toContain('User context');
		});

		it('still includes session context when context store throws', async () => {
			vi.mocked(services.contextStore.searchForUser).mockRejectedValue(
				new Error('Context store unavailable'),
			);

			createSession(USER_ID, pastaRecipe, 4, [], null);

			await handleMessage(msg(FOOD_QUESTION));

			const [prompt] = vi.mocked(services.llm.complete).mock.calls[0];
			expect(prompt).toContain('currently cooking');
			expect(prompt).toContain('Pasta Bolognese');
		});

		it('sends error message to user when LLM fails', async () => {
			vi.mocked(services.contextStore.searchForUser).mockResolvedValue([]);
			vi.mocked(services.llm.complete).mockRejectedValue(
				Object.assign(new Error('LLM timeout'), { code: 'TIMEOUT' }),
			);

			await handleMessage(msg(FOOD_QUESTION));

			// Should not throw — error message sent to user
			expect(services.telegram.send).toHaveBeenCalledWith(USER_ID, expect.any(String));
		});
	});
});
