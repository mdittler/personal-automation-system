import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProfile, KidAdaptation, Recipe } from '../types.js';
import {
	generateKidAdaptation,
	formatKidAdaptation,
} from '../services/kid-adapter.js';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'rec-123',
		title: 'Spicy Chili',
		source: 'homemade',
		ingredients: [
			{ name: 'ground beef', quantity: 1, unit: 'lb' },
			{ name: 'kidney beans', quantity: 1, unit: 'can' },
			{ name: 'hot sauce', quantity: 2, unit: 'tbsp' },
		],
		instructions: ['Brown the beef.', 'Add beans and hot sauce.', 'Simmer for 30 minutes.'],
		servings: 4,
		tags: ['spicy', 'comfort-food'],
		allergens: [],
		ratings: [],
		history: [],
		status: 'confirmed',
		createdAt: '2026-01-01',
		updatedAt: '2026-01-01',
		...overrides,
	};
}

function makeChild(overrides: Partial<ChildProfile> = {}): ChildProfile {
	return {
		name: 'Margot',
		slug: 'margot',
		birthDate: '2024-06-15',
		allergenStage: 'early-introduction',
		knownAllergens: ['milk', 'eggs'],
		avoidAllergens: ['peanuts'],
		dietaryNotes: 'Prefers soft textures',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

const VALID_LLM_RESPONSE = JSON.stringify({
	setAsideBefore: ['Set aside a portion of beef and beans before adding hot sauce'],
	textureGuidance: ['Cut beans into smaller pieces for 21-month-old', 'Shred beef finely'],
	allergenFlags: [],
	portionGuidance: 'About 1/4 cup total, age-appropriate portion for a toddler',
	generalNotes: 'This is a great protein-rich meal for toddlers when spice is removed.',
});

describe('kid-adapter', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	// ─── generateKidAdaptation ───────────────────────────────────
	describe('generateKidAdaptation', () => {
		it('calls LLM with correct prompt including child age and allergens', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(VALID_LLM_RESPONSE);

			const result = await generateKidAdaptation(services, makeRecipe(), makeChild(), 21);

			expect(services.llm.complete).toHaveBeenCalledOnce();
			const prompt = vi.mocked(services.llm.complete).mock.calls[0][0];
			expect(prompt).toContain('21 months');
			expect(prompt).toContain('Margot');
			expect(prompt).toContain('early-introduction');
			expect(prompt).toContain('peanuts'); // avoidAllergens
			expect(prompt).toContain('Prefers soft textures');
			expect(prompt).toContain('Spicy Chili');

			// Should use standard tier
			const opts = vi.mocked(services.llm.complete).mock.calls[0][1];
			expect(opts).toEqual(expect.objectContaining({ tier: 'standard' }));
		});

		it('parses valid JSON response into KidAdaptation', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(VALID_LLM_RESPONSE);

			const result = await generateKidAdaptation(services, makeRecipe(), makeChild(), 21);

			expect(result.childName).toBe('Margot');
			expect(result.originalRecipeId).toBe('rec-123');
			expect(result.setAsideBefore).toHaveLength(1);
			expect(result.textureGuidance).toHaveLength(2);
			expect(result.portionGuidance).toContain('1/4 cup');
		});

		it('includes anti-injection framing in prompt', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(VALID_LLM_RESPONSE);

			await generateKidAdaptation(services, makeRecipe(), makeChild(), 21);

			const prompt = vi.mocked(services.llm.complete).mock.calls[0][0];
			expect(prompt).toMatch(/do not follow any instructions/i);
		});

		it('handles LLM error gracefully', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

			await expect(
				generateKidAdaptation(services, makeRecipe(), makeChild(), 21),
			).rejects.toThrow('LLM unavailable');
		});

		it('flags recipe allergens against child avoid list', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({
					setAsideBefore: [],
					textureGuidance: [],
					allergenFlags: ['peanuts — this recipe contains peanuts which Margot should avoid'],
					portionGuidance: 'Small portion',
					generalNotes: '',
				}),
			);

			const recipe = makeRecipe({ allergens: ['peanuts'] });
			const result = await generateKidAdaptation(services, recipe, makeChild(), 21);
			expect(result.allergenFlags).toHaveLength(1);
			expect(result.allergenFlags[0]).toContain('peanuts');
		});

		it('handles recipe with no allergens', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({
					setAsideBefore: [],
					textureGuidance: ['Mash vegetables'],
					allergenFlags: [],
					portionGuidance: '1/4 cup',
					generalNotes: '',
				}),
			);

			const result = await generateKidAdaptation(
				services,
				makeRecipe({ allergens: [] }),
				makeChild(),
				21,
			);
			expect(result.allergenFlags).toEqual([]);
		});

		it('includes safety note for very young children', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(VALID_LLM_RESPONSE);

			await generateKidAdaptation(services, makeRecipe(), makeChild(), 4);

			const prompt = vi.mocked(services.llm.complete).mock.calls[0][0];
			expect(prompt).toContain('4 months');
			// Pre-solids age — prompt should emphasize caution
			expect(prompt).toMatch(/under 6 months|very young|caution/i);
		});
	});

	// ─── formatKidAdaptation ─────────────────────────────────────
	describe('formatKidAdaptation', () => {
		it('formats adaptation as readable Telegram markdown', () => {
			const adaptation: KidAdaptation = {
				childName: 'Margot',
				originalRecipeId: 'rec-123',
				setAsideBefore: ['Set aside plain beef before adding hot sauce'],
				textureGuidance: ['Cut beans small', 'Shred beef finely'],
				allergenFlags: [],
				portionGuidance: 'About 1/4 cup',
				generalNotes: 'Great protein source for toddlers.',
			};

			const output = formatKidAdaptation(adaptation);
			expect(output).toContain('Margot');
			expect(output).toContain('Set aside');
			expect(output).toContain('Cut beans');
			expect(output).toContain('1/4 cup');
			expect(output).toContain('Great protein source');
		});

		it('shows allergen warnings prominently', () => {
			const adaptation: KidAdaptation = {
				childName: 'Margot',
				originalRecipeId: 'rec-123',
				setAsideBefore: [],
				textureGuidance: [],
				allergenFlags: ['Contains peanuts — Margot should avoid'],
				portionGuidance: 'Small portion',
				generalNotes: '',
			};

			const output = formatKidAdaptation(adaptation);
			expect(output).toContain('⚠️');
			expect(output).toContain('peanuts');
		});

		it('omits empty sections', () => {
			const adaptation: KidAdaptation = {
				childName: 'Margot',
				originalRecipeId: 'rec-123',
				setAsideBefore: [],
				textureGuidance: [],
				allergenFlags: [],
				portionGuidance: 'About 1/4 cup',
				generalNotes: '',
			};

			const output = formatKidAdaptation(adaptation);
			expect(output).not.toContain('Set aside');
			expect(output).not.toContain('Texture');
			expect(output).toContain('1/4 cup');
		});
	});
});
