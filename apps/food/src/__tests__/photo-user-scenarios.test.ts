/**
 * User-scenario tests for the photo feature.
 *
 * Each test represents something a real user would do: send a photo with a
 * natural-language caption (or no caption at all), then verify
 *   1. the photo is routed to the correct handler (classification),
 *   2. the LLM prompt contains the right instructions and context,
 *   3. the Telegram reply makes sense to a non-technical person.
 *
 * These tests use the full handlePhoto pipeline with mocked LLM/Telegram.
 */

import { describe, expect, it, vi } from 'vitest';
import { handlePhoto } from '../handlers/photo.js';
import { isRecipePhotoIntent } from '../index.js';
import type { CoreServices, PhotoContext } from '@pas/core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function mockServices(llmResponse: string | ((...args: unknown[]) => string)) {
	const sharedStore = createMockStore();
	const completeFn = typeof llmResponse === 'function'
		? vi.fn(llmResponse)
		: vi.fn().mockResolvedValue(llmResponse);
	return {
		services: {
			llm: {
				complete: completeFn,
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
		completeFn,
	};
}

function photo(caption?: string): PhotoContext {
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

/** Shorthand: the prompt the LLM was called with. */
function promptSentToLLM(completeFn: ReturnType<typeof vi.fn>, callIndex = 0): string {
	return completeFn.mock.calls[callIndex]?.[0] as string;
}

/** Shorthand: the text Telegram sent to the user. */
function messageSentToUser(services: CoreServices): string {
	const call = (services.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0];
	return call?.[1] as string;
}

// ---------------------------------------------------------------------------
// Recipe JSON fixtures
// ---------------------------------------------------------------------------

const recipeResponse = JSON.stringify({
	title: 'Grandma\'s Banana Bread',
	source: 'photo',
	ingredients: [
		{ name: 'ripe bananas', quantity: 3, unit: null },
		{ name: 'flour', quantity: 2, unit: 'cups' },
		{ name: 'sugar', quantity: 0.75, unit: 'cups' },
		{ name: 'butter', quantity: 0.5, unit: 'cups' },
		{ name: 'egg', quantity: 1, unit: null },
	],
	instructions: [
		'Preheat oven to 350°F',
		'Mash bananas in a bowl',
		'Mix in melted butter and sugar',
		'Beat in egg, then fold in flour',
		'Pour into greased loaf pan and bake 60 minutes',
	],
	servings: 8,
	prepTime: 10,
	cookTime: 60,
	tags: ['baking', 'dessert', 'easy'],
	cuisine: 'American',
	allergens: ['gluten', 'dairy', 'eggs'],
});

const receiptResponse = JSON.stringify({
	store: 'Whole Foods Market',
	date: '2026-04-05',
	lineItems: [
		{ name: 'Organic Bananas', quantity: 1, unitPrice: 1.29, totalPrice: 1.29 },
		{ name: 'Almond Milk', quantity: 2, unitPrice: 4.49, totalPrice: 8.98 },
		{ name: 'Sourdough Bread', quantity: 1, unitPrice: 5.99, totalPrice: 5.99 },
	],
	subtotal: 16.26,
	tax: 0.98,
	total: 17.24,
});

const pantryResponse = JSON.stringify([
	{ name: 'eggs', quantity: 'about a dozen', category: 'dairy' },
	{ name: 'cheddar cheese', quantity: '1 block', category: 'dairy' },
	{ name: 'leftover pasta', quantity: '1 container', category: 'other' },
	{ name: 'orange juice', quantity: 'half gallon', category: 'beverages' },
	{ name: 'strawberries', quantity: 'small carton', category: 'produce' },
]);

const groceryResponse = JSON.stringify({
	items: [
		{ name: 'chicken breast', quantity: 2, unit: 'lbs' },
		{ name: 'broccoli', quantity: 1, unit: 'head' },
		{ name: 'soy sauce', quantity: 1, unit: 'bottle' },
		{ name: 'rice', quantity: 2, unit: 'cups' },
	],
	isRecipe: false,
});

// ╔═════════════════════════════════════════════════════════════════╗
// ║  1. CAPTION CLASSIFICATION — does a real caption route right?  ║
// ╚═════════════════════════════════════════════════════════════════╝

describe('Photo caption classification — real user phrases', () => {
	// ── Recipe captions ────────────────────────────────────────────

	describe('recipe captions', () => {
		it.each([
			'save this recipe',
			'here\'s a recipe from my mom',
			'recipe I found online',
			'save this please',                      // "save" alone triggers recipe
			'found this in an old cookbook',           // "cookbook" triggers recipe
			'this is a recipe card from the 1960s',   // "card" triggers recipe
		])('routes to recipe handler: "%s"', async (caption) => {
			const { services } = mockServices(recipeResponse);
			await handlePhoto(services, photo(caption));

			expect(messageSentToUser(services)).toContain('Recipe saved from photo');
		});
	});

	// ── Receipt captions ───────────────────────────────────────────

	describe('receipt captions', () => {
		it.each([
			'receipt',
			'grocery receipt',
			'here\'s my receipt from costco',
			'I just spent too much at target',        // "spent" triggers receipt
			'total was like $80',                      // "total" triggers receipt
			'checkout slip',                           // "checkout" triggers receipt
			'the bill from trader joes',               // "bill" triggers receipt
		])('routes to receipt handler: "%s"', async (caption) => {
			const { services } = mockServices(receiptResponse);
			await handlePhoto(services, photo(caption));

			expect(messageSentToUser(services)).toContain('Receipt captured');
		});
	});

	// ── Pantry captions ────────────────────────────────────────────

	describe('pantry captions', () => {
		it.each([
			'what\'s in my fridge',
			'here\'s my pantry',
			'this is what\'s in the freezer',
			'fridge contents',                        // "fridge" or "contents"
			'stuff on the shelf',                     // "shelf" triggers pantry
			'whats in here',                          // "what.?s in" triggers pantry
		])('routes to pantry handler: "%s"', async (caption) => {
			const { services } = mockServices(pantryResponse);
			await handlePhoto(services, photo(caption));

			expect(messageSentToUser(services)).toContain('Added');
			expect(messageSentToUser(services)).toContain('pantry');
		});
	});

	// ── Grocery captions ───────────────────────────────────────────

	describe('grocery captions', () => {
		it.each([
			'add these to grocery list',
			'shopping list',
			'we need to buy this stuff',              // "buy" triggers grocery
			'grocery list for the week',              // "grocery" triggers grocery
			'add this to the list',                   // "add...to...list" triggers grocery
		])('routes to grocery handler: "%s"', async (caption) => {
			const { services } = mockServices(groceryResponse);
			await handlePhoto(services, photo(caption));

			expect(messageSentToUser(services)).toContain('grocery list');
		});
	});

	// ── Ambiguous / no caption → vision fallback ───────────────────

	describe('ambiguous captions that need vision fallback', () => {
		it.each([
			'here you go',
			'check this out',
			'took this at the store',
			'can you read this?',
			'what do you think?',
		])('falls back to LLM vision for ambiguous caption: "%s"', async (caption) => {
			// First call: classification → "recipe". Second call: parse.
			const completeFn = vi.fn()
				.mockResolvedValueOnce('recipe')
				.mockResolvedValueOnce(recipeResponse);
			const { services } = mockServices('');
			services.llm.complete = completeFn;

			await handlePhoto(services, photo(caption));

			// Verify it needed two LLM calls (classify + parse)
			expect(completeFn).toHaveBeenCalledTimes(2);
			// First call should be the classification prompt
			expect(promptSentToLLM(completeFn, 0)).toContain('classify');
		});
	});

	// ── Priority / overlap ─────────────────────────────────────────

	describe('classification priority when captions match multiple categories', () => {
		it('prefers recipe over grocery when caption says "save this recipe from my grocery trip"', async () => {
			// "recipe" appears first in priority, should win over "grocery"
			const { services } = mockServices(recipeResponse);
			await handlePhoto(services, photo('save this recipe from my grocery trip'));

			expect(messageSentToUser(services)).toContain('Recipe saved from photo');
		});

		it('prefers receipt over grocery when caption says "grocery receipt"', async () => {
			// "receipt" appears before "grocery" in priority
			const { services } = mockServices(receiptResponse);
			await handlePhoto(services, photo('grocery receipt'));

			expect(messageSentToUser(services)).toContain('Receipt captured');
		});
	});

	// ── False positive prevention ──────────────────────────────────

	describe('captions that should NOT be misclassified', () => {
		it('routes "save this bill" to receipt, not recipe', async () => {
			// "bill" is a receipt keyword — should beat "save" (recipe keyword)
			const { services } = mockServices(receiptResponse);
			await handlePhoto(services, photo('save this bill'));

			expect(messageSentToUser(services)).toContain('Receipt captured');
		});

		it('does not treat "birthday card" as a recipe', async () => {
			// "card" in recipe keywords is for "recipe card", not greeting cards
			// Should fall through to vision classification
			const completeFn = vi.fn()
				.mockResolvedValueOnce('I see a birthday card, not food related')
				.mockResolvedValue('{}');
			const { services } = mockServices('');
			services.llm.complete = completeFn;

			await handlePhoto(services, photo('birthday card from aunt sue'));

			// Should have gone to vision classification, not recipe parser
			const msg = messageSentToUser(services);
			expect(msg).toContain('not sure what kind of photo');
		});

		it('does not treat "business card" as a recipe', async () => {
			const completeFn = vi.fn()
				.mockResolvedValueOnce('This appears to be a business card')
				.mockResolvedValue('{}');
			const { services } = mockServices('');
			services.llm.complete = completeFn;

			await handlePhoto(services, photo('business card I found'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('not sure what kind of photo');
		});
	});
});

// ╔═════════════════════════════════════════════════════════════════╗
// ║  2. LLM PROMPT VERIFICATION — is the LLM asked the right Q?  ║
// ╚═════════════════════════════════════════════════════════════════╝

describe('LLM prompt construction — what the model actually sees', () => {
	it('recipe prompt asks for structured JSON with ingredients and instructions', async () => {
		const { services, completeFn } = mockServices(recipeResponse);
		await handlePhoto(services, photo('save this recipe'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('ingredients');
		expect(prompt).toContain('instructions');
		expect(prompt).toContain('JSON');
		expect(prompt).toContain('servings');
	});

	it('recipe prompt includes user caption as context', async () => {
		const { services, completeFn } = mockServices(recipeResponse);
		await handlePhoto(services, photo('my mom\'s banana bread recipe'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('banana bread');
	});

	it('receipt prompt asks for store name, line items, and total', async () => {
		const { services, completeFn } = mockServices(receiptResponse);
		await handlePhoto(services, photo('receipt'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('store');
		expect(prompt).toContain('lineItems');
		expect(prompt).toContain('total');
	});

	it('receipt prompt includes store hint from caption', async () => {
		const { services, completeFn } = mockServices(receiptResponse);
		await handlePhoto(services, photo('Costco receipt'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('Costco');
	});

	it('pantry prompt asks for item names, quantities, and categories', async () => {
		const { services, completeFn } = mockServices(pantryResponse);
		await handlePhoto(services, photo('what\'s in my fridge'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('name');
		expect(prompt).toContain('quantity');
		expect(prompt).toContain('category');
	});

	it('grocery prompt asks for item list and detects recipes', async () => {
		const { services, completeFn } = mockServices(groceryResponse);
		await handlePhoto(services, photo('shopping list'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('items');
		expect(prompt).toContain('isRecipe');
	});

	it('grocery prompt includes caption context', async () => {
		const { services, completeFn } = mockServices(groceryResponse);
		await handlePhoto(services, photo('shopping list for taco night'));

		const prompt = promptSentToLLM(completeFn);
		expect(prompt).toContain('taco night');
	});

	it('sends the photo buffer to the LLM along with the prompt', async () => {
		const { services, completeFn } = mockServices(recipeResponse);
		await handlePhoto(services, photo('save recipe'));

		const opts = completeFn.mock.calls[0]?.[1];
		expect(opts.images).toHaveLength(1);
		expect(opts.images[0].data).toBe(testPhoto);
		expect(opts.images[0].mimeType).toBe('image/jpeg');
	});

	it('uses standard LLM tier for all photo parsing', async () => {
		const { services, completeFn } = mockServices(recipeResponse);
		await handlePhoto(services, photo('save recipe'));

		const opts = completeFn.mock.calls[0]?.[1];
		expect(opts.tier).toBe('standard');
	});

	it('classification prompt asks for a single-word response', async () => {
		const completeFn = vi.fn()
			.mockResolvedValueOnce('recipe')
			.mockResolvedValueOnce(recipeResponse);
		const { services } = mockServices('');
		services.llm.complete = completeFn;

		await handlePhoto(services, photo()); // no caption → vision classify

		const classifyPrompt = promptSentToLLM(completeFn, 0);
		expect(classifyPrompt).toContain('ONLY the single word');
	});
});

// ╔═════════════════════════════════════════════════════════════════╗
// ║  3. USER-FACING OUTPUTS — does the reply make sense?          ║
// ╚═════════════════════════════════════════════════════════════════╝

describe('Telegram responses — what the user actually sees', () => {
	describe('recipe photo response', () => {
		it('shows the recipe title, ingredient count, and step count', async () => {
			const { services } = mockServices(recipeResponse);
			await handlePhoto(services, photo('save this recipe'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('Grandma\'s Banana Bread');
			expect(msg).toContain('5 ingredients');
			expect(msg).toContain('5 steps');
			expect(msg).toContain('Servings: 8');
		});

		it('shows cuisine when available', async () => {
			const { services } = mockServices(recipeResponse);
			await handlePhoto(services, photo('save this recipe'));

			expect(messageSentToUser(services)).toContain('American');
		});

		it('tells the user the recipe starts as a draft', async () => {
			const { services } = mockServices(recipeResponse);
			await handlePhoto(services, photo('save this recipe'));

			expect(messageSentToUser(services)).toContain('draft');
		});
	});

	describe('receipt photo response', () => {
		it('shows store name, item count, and total', async () => {
			const { services } = mockServices(receiptResponse);
			await handlePhoto(services, photo('receipt'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('Whole Foods Market');
			expect(msg).toContain('3 items');
			expect(msg).toContain('$17.24');
		});

		it('shows tax when present', async () => {
			const { services } = mockServices(receiptResponse);
			await handlePhoto(services, photo('receipt'));

			expect(messageSentToUser(services)).toContain('$0.98');
		});
	});

	describe('pantry photo response', () => {
		it('lists each identified item with quantity', async () => {
			const { services } = mockServices(pantryResponse);
			await handlePhoto(services, photo('what\'s in my fridge'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('eggs');
			expect(msg).toContain('about a dozen');
			expect(msg).toContain('cheddar cheese');
			expect(msg).toContain('strawberries');
		});

		it('shows item count', async () => {
			const { services } = mockServices(pantryResponse);
			await handlePhoto(services, photo('fridge'));

			expect(messageSentToUser(services)).toContain('5 items');
		});

		it('tells user how to fix mistakes', async () => {
			const { services } = mockServices(pantryResponse);
			await handlePhoto(services, photo('fridge'));

			expect(messageSentToUser(services)).toContain('remove');
		});
	});

	describe('grocery photo response', () => {
		it('lists extracted items', async () => {
			const { services } = mockServices(groceryResponse);
			await handlePhoto(services, photo('shopping list'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('chicken breast');
			expect(msg).toContain('broccoli');
			expect(msg).toContain('4 items');
		});

		it('offers to save the recipe when a recipe photo is detected', async () => {
			const recipeGrocery = JSON.stringify({
				items: [
					{ name: 'chicken', quantity: 1, unit: 'lb' },
					{ name: 'rice', quantity: 2, unit: 'cups' },
				],
				isRecipe: true,
				parsedRecipe: {
					title: 'Chicken Fried Rice',
					source: 'photo',
					ingredients: [
						{ name: 'chicken', quantity: 1, unit: 'lb' },
						{ name: 'rice', quantity: 2, unit: 'cups' },
					],
					instructions: ['Cook rice', 'Stir fry chicken', 'Combine'],
					servings: 4,
					tags: ['easy', 'asian'],
					allergens: [],
				},
			});
			const { services } = mockServices(recipeGrocery);
			await handlePhoto(services, photo('shopping list'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('recipe');
			expect(msg).toContain('Chicken Fried Rice');
		});
	});

	describe('empty results', () => {
		it('tells user no items found in pantry photo and suggests alternatives', async () => {
			const { services } = mockServices('[]');
			await handlePhoto(services, photo('what\'s in the fridge'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('couldn\'t identify');
			expect(msg).toContain('clearer photo');
		});

		it('tells user no items found in grocery photo', async () => {
			const emptyGrocery = JSON.stringify({ items: [], isRecipe: false });
			const { services } = mockServices(emptyGrocery);
			await handlePhoto(services, photo('grocery list'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('couldn\'t extract');
		});
	});

	describe('error scenarios', () => {
		it('shows a friendly message when the LLM fails completely', async () => {
			const { services } = mockServices('');
			services.llm.complete = vi.fn().mockRejectedValue(new Error('API timeout'));
			await handlePhoto(services, photo('save this recipe'));

			const msg = messageSentToUser(services);
			expect(msg).toContain('Sorry');
			expect(msg).toContain('try again');
			// Should NOT expose the error string "API timeout" to the user
			expect(msg).not.toContain('API timeout');
		});

		it('suggests adding a caption when uncertain photo is sent', async () => {
			const completeFn = vi.fn()
				.mockResolvedValueOnce('I can see a photo but it\'s unclear what type it is');
			const { services } = mockServices('');
			services.llm.complete = completeFn;

			await handlePhoto(services, photo());

			const msg = messageSentToUser(services);
			expect(msg).toContain('not sure what kind of photo');
			expect(msg).toContain('save this recipe');
			expect(msg).toContain('receipt');
			expect(msg).toContain('fridge');
			expect(msg).toContain('grocery list');
		});
	});
});

// ╔═════════════════════════════════════════════════════════════════╗
// ║  4. RECIPE PHOTO RETRIEVAL — natural language intent matching  ║
// ╚═════════════════════════════════════════════════════════════════╝

describe('Recipe photo retrieval — user phrases', () => {
	describe('phrases that SHOULD trigger photo retrieval', () => {
		it.each([
			// Direct requests
			'show me the photo of the lasagna',
			'can I see the picture of that pasta recipe',
			'send me the banana bread photo',
			'view the original image for chicken stir fry',

			// Casual phrasing
			'get the photo of the carbonara',
			'let me see the picture from the cookbook',

			// Abbreviations and variations
			'show the recipe image',
			'send the original photo',
			'see the source photo of the chili',
		])('detects intent: "%s"', (text) => {
			expect(isRecipePhotoIntent(text.toLowerCase())).toBe(true);
		});
	});

	describe('phrases that should NOT trigger photo retrieval', () => {
		it.each([
			// Recipe operations (not photo retrieval)
			'show me the lasagna recipe',
			'what\'s in the pasta recipe',
			'search for chicken recipes',
			'find me a good chili recipe',

			// Saving photos (uploading, not retrieving)
			'save this recipe',
			'here\'s a recipe to save',

			// General photo mentions
			'take a photo',
			'I took a photo earlier',

			// Food questions
			'how do I make banana bread',
			'what\'s for dinner tonight',

			// Grocery / pantry
			'add chicken to the list',
			'what\'s in the fridge',
		])('does NOT match: "%s"', (text) => {
			expect(isRecipePhotoIntent(text.toLowerCase())).toBe(false);
		});
	});
});
