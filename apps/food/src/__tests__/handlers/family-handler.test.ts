import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildRecipeApprovalButtons,
	handleApprovalCallback,
	handleChildApprovalIntent,
	handleFamilyCommand,
	handleFoodIntroCallback,
	handleFoodIntroduction,
	handleKidAdaptIntent,
	isChildApprovalIntent,
	isFoodIntroIntent,
	isKidAdaptIntent,
} from '../../handlers/family.js';
import type { ChildFoodLog, Recipe } from '../../types.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

const MARGOT_YAML = `profile:
  name: Margot
  slug: margot
  birthDate: "2024-06-15"
  allergenStage: early-introduction
  knownAllergens:
    - milk
    - eggs
  avoidAllergens: []
  dietaryNotes: Prefers soft textures
  createdAt: "2026-01-01T00:00:00.000Z"
  updatedAt: "2026-01-01T00:00:00.000Z"
introductions: []`;

const MARGOT_WITH_INTRO_YAML = `profile:
  name: Margot
  slug: margot
  birthDate: "2024-06-15"
  allergenStage: early-introduction
  knownAllergens:
    - milk
    - eggs
  avoidAllergens: []
  dietaryNotes: Prefers soft textures
  createdAt: "2026-01-01T00:00:00.000Z"
  updatedAt: "2026-01-01T00:00:00.000Z"
introductions:
  - food: scrambled eggs
    allergenCategory: eggs
    date: "2026-04-01"
    reaction: none
    accepted: true
    notes: ""`;

const RECIPE_YAML = `id: rec-123
title: Spicy Chili
source: homemade
ingredients:
  - name: ground beef
    quantity: 1
    unit: lb
  - name: hot sauce
    quantity: 2
    unit: tbsp
instructions:
  - Brown the beef
  - Add hot sauce
  - Simmer
servings: 4
tags: [spicy]
allergens: []
ratings: []
history: []
status: confirmed
createdAt: "2026-01-01"
updatedAt: "2026-01-01"`;

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'rec-123',
		title: 'Spicy Chili',
		source: 'homemade',
		ingredients: [{ name: 'ground beef', quantity: 1, unit: 'lb' }],
		instructions: ['Brown the beef', 'Add hot sauce', 'Simmer'],
		servings: 4,
		tags: ['spicy'],
		allergens: [],
		ratings: [],
		history: [],
		status: 'confirmed',
		createdAt: '2026-01-01',
		updatedAt: '2026-01-01',
		...overrides,
	} as Recipe;
}

describe('family handler', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = createMockScopedStore();
	});

	// ─── /family command ─────────────────────────────────────────
	describe('handleFamilyCommand', () => {
		it('lists children when no subcommand', async () => {
			store.list.mockResolvedValue([]);
			const result = await handleFamilyCommand(services, [], 'user1', store as any);
			expect(result.text).toContain('No children');
			expect(result.buttons).toBeUndefined();
		});

		it('lists children when profiles exist', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(services, [], 'user1', store as any);
			expect(result.text).toContain('Margot');
		});

		it('adds a child profile with ISO date', async () => {
			const result = await handleFamilyCommand(
				services,
				['add', 'Margot', '2024-06-15'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Margot');
			expect(result.text).toContain('2024-06-15');
			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('name: Margot'),
			);
		});

		it('adds a child profile with US date format', async () => {
			const result = await handleFamilyCommand(
				services,
				['add', 'Oliver', '6/15/2024'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Oliver');
			expect(result.text).toContain('2024-06-15');
		});

		it('adds a child profile with named month date', async () => {
			const result = await handleFamilyCommand(
				services,
				['add', 'Emma', 'June', '15', '2024'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Emma');
		});

		it('rejects invalid date input', async () => {
			const result = await handleFamilyCommand(
				services,
				['add', 'Test', 'not-a-date'],
				'user1',
				store as any,
			);
			expect(result.text).toContain("couldn't understand");
		});

		it('shows usage when add has missing args', async () => {
			const result = await handleFamilyCommand(services, ['add'], 'user1', store as any);
			expect(result.text).toContain('Usage');
		});

		it('shows remove confirmation with buttons', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['remove', 'Margot'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Remove');
			expect(result.text).toContain('Margot');
			expect(result.buttons).toBeDefined();
			expect(result.buttons?.[0]).toHaveLength(2);
			// Should NOT immediately archive
			expect(store.archive).not.toHaveBeenCalled();
		});

		it('shows not found when removing nonexistent child', async () => {
			store.read.mockResolvedValue('');
			const result = await handleFamilyCommand(
				services,
				['remove', 'Ghost'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('not found');
		});

		it('views a specific child profile with edit buttons', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['margot'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Margot');
			expect(result.text).toContain('early-introduction');
			expect(result.buttons).toBeDefined();
		});

		it('shows not found for unknown child', async () => {
			store.read.mockResolvedValue('');
			const result = await handleFamilyCommand(
				services,
				['unknown'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('not found');
		});

		// /family edit
		it('shows edit usage when no field given', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('What would you like to update');
		});

		it('edits allergen stage', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot', 'stage', 'expanding'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Updated');
			expect(result.text).toContain('expanding');
			expect(store.write).toHaveBeenCalled();
		});

		it('rejects invalid stage', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot', 'stage', 'invalid'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Invalid stage');
		});

		it('adds a safe allergen', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot', 'safe', 'wheat'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Updated');
			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('wheat'),
			);
		});

		it('adds an avoid allergen', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot', 'avoid', 'peanuts'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Updated');
		});

		it('updates dietary notes', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot', 'notes', 'No spicy food'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Updated');
			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('No spicy food'),
			);
		});

		it('rejects unknown edit field', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleFamilyCommand(
				services,
				['edit', 'margot', 'badfield', 'value'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('Unknown field');
		});
	});

	// ─── Intent detection ────────────────────────────────────────
	describe('isKidAdaptIntent', () => {
		it('matches "make this for Margot"', () => {
			expect(isKidAdaptIntent('make this for margot', ['margot'])).toBe(true);
		});

		it('matches "how do I adapt this for Margot"', () => {
			expect(isKidAdaptIntent('how do i adapt this for margot', ['margot'])).toBe(true);
		});

		it('matches "kid friendly version"', () => {
			expect(isKidAdaptIntent('kid friendly version', [])).toBe(true);
		});

		it('matches "baby version"', () => {
			expect(isKidAdaptIntent('baby version', [])).toBe(true);
		});

		it('matches "toddler friendly"', () => {
			expect(isKidAdaptIntent('make a toddler friendly version', [])).toBe(true);
		});

		it('matches "for the baby"', () => {
			expect(isKidAdaptIntent('how do I make this for the baby', [])).toBe(true);
		});

		it('matches "child safe"', () => {
			expect(isKidAdaptIntent('is this child safe', [])).toBe(true);
		});

		it('does not match unregistered child name', () => {
			expect(isKidAdaptIntent('make this for oliver', ['margot'])).toBe(false);
		});

		it('does not match unrelated text', () => {
			expect(isKidAdaptIntent('what is for dinner', ['margot'])).toBe(false);
		});

		it('handles regex-special characters in child names', () => {
			expect(isKidAdaptIntent("make this for o'brien", ["o'brien"])).toBe(true);
		});
	});

	describe('isFoodIntroIntent', () => {
		it('matches "Margot tried peanut butter today"', () => {
			expect(isFoodIntroIntent('margot tried peanut butter today')).toBe(true);
		});

		it('matches "introduced eggs to baby"', () => {
			expect(isFoodIntroIntent('introduced eggs to baby')).toBe(true);
		});

		it('matches "log food introduction"', () => {
			expect(isFoodIntroIntent('log food introduction')).toBe(true);
		});

		it('matches "gave baby yogurt for the first time"', () => {
			expect(isFoodIntroIntent('gave baby yogurt for the first time')).toBe(true);
		});

		it('matches "new food for margot"', () => {
			expect(isFoodIntroIntent('new food for margot')).toBe(true);
		});

		it('matches "fed the baby some banana"', () => {
			expect(isFoodIntroIntent('fed the baby some banana')).toBe(true);
		});

		it('matches "introducing solids to baby"', () => {
			expect(isFoodIntroIntent('introducing solids to baby')).toBe(true);
		});

		it('does not match unrelated text', () => {
			expect(isFoodIntroIntent('what is for dinner')).toBe(false);
		});

		it('does not match "I tried a new restaurant"', () => {
			// "tried" without today/yesterday/first should not match
			expect(isFoodIntroIntent('I tried a new restaurant')).toBe(false);
		});
	});

	describe('isChildApprovalIntent', () => {
		it('matches "Margot loved the chili"', () => {
			expect(isChildApprovalIntent('margot loved the chili', ['margot'])).toBe(true);
		});

		it('matches "Margot refused the soup"', () => {
			expect(isChildApprovalIntent('margot refused the soup', ['margot'])).toBe(true);
		});

		it('matches "Margot ate the pasta"', () => {
			expect(isChildApprovalIntent('margot ate the pasta', ['margot'])).toBe(true);
		});

		it("matches \"Margot wouldn't eat the fish\"", () => {
			expect(isChildApprovalIntent("margot wouldn't eat the fish", ['margot'])).toBe(true);
		});

		it('does not match without registered child name', () => {
			expect(isChildApprovalIntent('oliver loved the chili', ['margot'])).toBe(false);
		});

		it('does not match unrelated text', () => {
			expect(isChildApprovalIntent('i loved the chili', ['margot'])).toBe(false);
		});

		it('returns false with empty child list', () => {
			expect(isChildApprovalIntent('margot loved the chili', [])).toBe(false);
		});
	});

	// ─── handleFoodIntroduction ─────────────────────────────────
	describe('handleFoodIntroduction', () => {
		it('logs a food introduction and returns reaction buttons', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			vi.mocked(services.llm.complete).mockResolvedValue('peanut butter');

			const result = await handleFoodIntroduction(
				services,
				'Margot tried peanut butter today',
				'user1',
				store as any,
				3,
			);
			expect(result.text).toContain('peanut butter');
			expect(result.text).toContain('peanuts');
			expect(result.buttons).toBeDefined();
			expect(result.buttons!.length).toBeGreaterThan(0);
			expect(store.write).toHaveBeenCalled();
		});

		it('returns message when no children exist', async () => {
			store.list.mockResolvedValue([]);
			const result = await handleFoodIntroduction(
				services,
				'baby tried milk',
				'user1',
				store as any,
				3,
			);
			expect(result.text).toContain('No children');
		});

		it('falls back to regex when LLM fails', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM down'));

			const result = await handleFoodIntroduction(
				services,
				'Margot tried yogurt today',
				'user1',
				store as any,
				3,
			);
			expect(result.text).toContain('yogurt');
			expect(store.write).toHaveBeenCalled();
		});

		it('warns about allergen wait window', async () => {
			// Child has recent egg intro — new peanut intro should warn
			// Use today's date minus 1 day so the wait window (5 days) is not met
			const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
			const recentIntroYaml = MARGOT_WITH_INTRO_YAML.replace(
				'date: "2026-04-01"',
				`date: "${yesterday}"`,
			);
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(recentIntroYaml);
			vi.mocked(services.llm.complete).mockResolvedValue('peanut butter');

			const result = await handleFoodIntroduction(
				services,
				'Margot tried peanut butter today',
				'user1',
				store as any,
				5, // 5-day wait, only 1 day since last allergen
			);
			expect(result.text).toContain('wait period');
		});

		it('asks which child when multiple exist and none named', async () => {
			store.list.mockResolvedValue(['children/margot.yaml', 'children/oliver.yaml']);
			store.read
				.mockResolvedValueOnce(MARGOT_YAML)
				.mockResolvedValueOnce(
					MARGOT_YAML.replace(/Margot/g, 'Oliver').replace(/margot/g, 'oliver'),
				);

			const result = await handleFoodIntroduction(
				services,
				'baby tried bananas today',
				'user1',
				store as any,
				3,
			);
			expect(result.text).toContain('Which child');
		});

		it('prompts for food when extraction fails', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			vi.mocked(services.llm.complete).mockResolvedValue('');

			const result = await handleFoodIntroduction(
				services,
				'Margot tried something',
				'user1',
				store as any,
				3,
			);
			expect(result.text).toContain('What food');
		});
	});

	// ─── handleKidAdaptIntent ───────────────────────────────────
	describe('handleKidAdaptIntent', () => {
		it('returns message when no children exist', async () => {
			store.list.mockResolvedValue([]);
			const result = await handleKidAdaptIntent(
				services,
				'make this kid friendly',
				'user1',
				store as any,
				makeRecipe(),
				[],
			);
			expect(result).toContain('No children');
		});

		it('prompts for recipe when none cached or found', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			const result = await handleKidAdaptIntent(
				services,
				'make this kid friendly',
				'user1',
				store as any,
				null,
				[],
			);
			expect(result).toContain('Which recipe');
		});

		it('generates adaptation with cached recipe', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({
					setAsideBefore: ['Remove hot sauce portion'],
					textureGuidance: ['Mash beans'],
					allergenFlags: [],
					portionGuidance: '1/4 cup',
					generalNotes: 'Good for early eaters',
				}),
			);

			const result = await handleKidAdaptIntent(
				services,
				'make this kid friendly',
				'user1',
				store as any,
				makeRecipe(),
				[],
			);
			expect(result).toContain('Mash beans');
		});

		it('searches allRecipes when no cached recipe', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({
					setAsideBefore: [],
					textureGuidance: [],
					allergenFlags: [],
					portionGuidance: '1/4 cup',
					generalNotes: 'Mild version',
				}),
			);

			const result = await handleKidAdaptIntent(
				services,
				'adapt the spicy chili for margot',
				'user1',
				store as any,
				null,
				[makeRecipe()],
			);
			expect(result).toContain('Mild version');
		});

		it('handles LLM error gracefully', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM timeout'));

			const result = await handleKidAdaptIntent(
				services,
				'make this kid friendly',
				'user1',
				store as any,
				makeRecipe(),
				[],
			);
			expect(result).toContain("couldn't generate");
		});
	});

	// ─── handleChildApprovalIntent ──────────────────────────────
	describe('handleChildApprovalIntent', () => {
		it('marks recipe as approved', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read
				.mockResolvedValueOnce(MARGOT_YAML) // loadAllChildren
				.mockResolvedValueOnce(MARGOT_YAML) // loadChildProfile (child match)
				.mockResolvedValueOnce(RECIPE_YAML); // loadRecipe (updateRecipe reads first)

			const result = await handleChildApprovalIntent(
				services,
				'Margot loved the spicy chili',
				store as any,
				[makeRecipe()],
				['margot'],
			);
			expect(result).toContain('approved');
			expect(result).toContain('Spicy Chili');
		});

		it('marks recipe as rejected', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read
				.mockResolvedValueOnce(MARGOT_YAML)
				.mockResolvedValueOnce(MARGOT_YAML)
				.mockResolvedValueOnce(RECIPE_YAML);

			const result = await handleChildApprovalIntent(
				services,
				'Margot hated the spicy chili',
				store as any,
				[makeRecipe()],
				['margot'],
			);
			expect(result).toContain('rejected');
		});

		it('returns null when no child matches', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);

			const result = await handleChildApprovalIntent(
				services,
				'Oliver loved the chili',
				store as any,
				[makeRecipe()],
				['margot'],
			);
			expect(result).toBeNull();
		});

		it('returns message when recipe not found', async () => {
			store.list.mockResolvedValue(['children/margot.yaml']);
			store.read.mockResolvedValue(MARGOT_YAML);

			const result = await handleChildApprovalIntent(
				services,
				'Margot loved the mystery dish',
				store as any,
				[makeRecipe()],
				['margot'],
			);
			expect(result).toContain("couldn't find");
		});
	});

	// ─── handleApprovalCallback ──────────────────────────────────
	describe('handleApprovalCallback', () => {
		it('sets approval on recipe for child', async () => {
			store.read
				.mockResolvedValueOnce(MARGOT_YAML) // child profile load
				.mockResolvedValueOnce(RECIPE_YAML); // recipe load

			await handleApprovalCallback(
				services,
				'y:margot:rec-123',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.write).toHaveBeenCalledWith(
				'recipes/rec-123.yaml',
				expect.stringContaining('margot: approved'),
			);
			expect(services.telegram.editMessage).toHaveBeenCalled();
		});

		it('sets rejection on recipe for child', async () => {
			store.read
				.mockResolvedValueOnce(MARGOT_YAML)
				.mockResolvedValueOnce(RECIPE_YAML);

			await handleApprovalCallback(
				services,
				'n:margot:rec-123',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.write).toHaveBeenCalledWith(
				'recipes/rec-123.yaml',
				expect.stringContaining('margot: rejected'),
			);
		});

		it('clears approval on recipe for child', async () => {
			store.read
				.mockResolvedValueOnce(MARGOT_YAML)
				.mockResolvedValueOnce(
					RECIPE_YAML + '\nchildApprovals:\n  margot: approved',
				);

			await handleApprovalCallback(
				services,
				'c:margot:rec-123',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('cleared'),
			);
		});

		it('handles stale recipe gracefully', async () => {
			store.read
				.mockResolvedValueOnce(MARGOT_YAML)
				.mockResolvedValueOnce(''); // recipe not found

			await handleApprovalCallback(
				services,
				'y:margot:rec-123',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('not found'),
			);
		});

		it('handles missing child gracefully', async () => {
			store.read.mockResolvedValue(''); // child not found

			await handleApprovalCallback(
				services,
				'y:ghost:rec-123',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('not found'),
			);
		});

		it('handles remove confirmation callback with valid pending', async () => {
			store.exists.mockResolvedValue(true);
			store.read.mockResolvedValue(MARGOT_YAML);

			// First trigger the remove command to set pending state
			await handleFamilyCommand(services, ['remove', 'Margot'], 'user1', store as any);

			await handleApprovalCallback(
				services,
				'rm:margot',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.archive).toHaveBeenCalledWith('children/margot.yaml');
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('removed'),
			);
		});

		it('rejects remove callback without pending state', async () => {
			await handleApprovalCallback(
				services,
				'rm:margot',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.archive).not.toHaveBeenCalled();
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('expired'),
			);
		});

		it('handles remove cancel callback', async () => {
			await handleApprovalCallback(
				services,
				'rm-cancel',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				'Cancelled.',
			);
		});

		it('handles edit stage prompt callback', async () => {
			await handleApprovalCallback(
				services,
				'es:margot',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('allergen stage'),
				expect.any(Array),
			);
		});

		it('handles set stage callback', async () => {
			store.read.mockResolvedValue(MARGOT_YAML);

			await handleApprovalCallback(
				services,
				'ss:margot:expanding',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('expanding'),
			);
		});
	});

	// ─── handleFoodIntroCallback ────────────────────────────────
	describe('handleFoodIntroCallback', () => {
		it('records reaction severity on most recent intro', async () => {
			store.read.mockResolvedValue(MARGOT_WITH_INTRO_YAML);

			await handleFoodIntroCallback(
				services,
				'r:margot:mild',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('reaction: mild'),
			);
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('mild'),
			);
		});

		it('records no reaction', async () => {
			store.read.mockResolvedValue(MARGOT_WITH_INTRO_YAML);

			await handleFoodIntroCallback(
				services,
				'r:margot:none',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('none'),
			);
		});

		it('records food rejection', async () => {
			store.read.mockResolvedValue(MARGOT_WITH_INTRO_YAML);

			await handleFoodIntroCallback(
				services,
				'rej:margot',
				'user1',
				123,
				456,
				store as any,
			);

			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('accepted: false'),
			);
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('rejected'),
			);
		});

		it('handles missing child gracefully', async () => {
			store.read.mockResolvedValue('');

			await handleFoodIntroCallback(
				services,
				'r:ghost:mild',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('No recent'),
			);
		});

		it('handles empty introduction list', async () => {
			store.read.mockResolvedValue(MARGOT_YAML); // no introductions

			await handleFoodIntroCallback(
				services,
				'r:margot:mild',
				'user1',
				123,
				456,
				store as any,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('No recent'),
			);
		});
	});

	// ─── buildRecipeApprovalButtons ─────────────────────────────
	describe('buildRecipeApprovalButtons', () => {
		const margotLog: ChildFoodLog = {
			profile: {
				name: 'Margot',
				slug: 'margot',
				birthDate: '2024-06-15',
				allergenStage: 'early-introduction',
				knownAllergens: [],
				avoidAllergens: [],
				dietaryNotes: '',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
			introductions: [],
		};

		it('returns empty array when no children', () => {
			expect(buildRecipeApprovalButtons('rec-123', [])).toEqual([]);
		});

		it('builds buttons for each child', () => {
			const buttons = buildRecipeApprovalButtons('rec-123', [margotLog]);
			expect(buttons.length).toBe(1);
			expect(buttons[0][0].text).toContain('Margot');
			expect(buttons[0][0].callbackData).toContain('fa:y:margot:rec-123');
		});

		it('shows current approval status', () => {
			const buttons = buildRecipeApprovalButtons(
				'rec-123',
				[margotLog],
				{ margot: 'approved' },
			);
			expect(buttons[0][0].text).toContain('👍');
			// Toggling: approved -> next action is reject (n)
			expect(buttons[0][0].callbackData).toContain('fa:n:margot:rec-123');
		});

		it('shows rejection status', () => {
			const buttons = buildRecipeApprovalButtons(
				'rec-123',
				[margotLog],
				{ margot: 'rejected' },
			);
			expect(buttons[0][0].text).toContain('👎');
		});

		it('callback data stays under 64 bytes', () => {
			const buttons = buildRecipeApprovalButtons('rec-123', [margotLog]);
			for (const row of buttons) {
				for (const btn of row) {
					expect(new TextEncoder().encode(btn.callbackData).length).toBeLessThanOrEqual(64);
				}
			}
		});
	});

	// ─── Security ───────────────────────────────────────────────
	describe('security', () => {
		it('rejects path traversal in child name', async () => {
			const result = await handleFamilyCommand(
				services,
				['../etc/passwd'],
				'user1',
				store as any,
			);
			expect(result.text).toContain('not found');
		});

		it('callback data with malformed slug is handled safely', async () => {
			store.read.mockResolvedValue('');
			await handleApprovalCallback(
				services,
				'y:../../hack:rec-123',
				'user1',
				123,
				456,
				store as any,
			);
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123,
				456,
				expect.stringContaining('not found'),
			);
		});
	});
});
