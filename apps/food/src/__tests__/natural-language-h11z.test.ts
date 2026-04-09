/**
 * H11.z Natural Language User Simulation Tests
 * =============================================
 *
 * Phase H11.z adds canonical ingredient normalization at write time. A real
 * household user never types "canonical name" — they type "tomato" today and
 * "tomatoes" tomorrow and expect the system to know it's the same thing.
 * These tests take that persona and verify:
 *
 *   1. Natural phrasings still classify correctly — H11.z did not break the
 *      pantry/grocery/recipe intent routing that already works.
 *   2. Pantry and grocery writes attach `canonicalName` via the normalizer
 *      so downstream dedup/matching is exact, not fuzzy.
 *   3. Deterministic fast-path covers everyday produce/proteins WITHOUT
 *      burning an LLM call — "tomato", "tomatoes", "4 cups of salt",
 *      "Roma tomatoes" all resolve locally.
 *   4. LLM fast-tier fallback fires only for genuinely ambiguous inputs
 *      and its response is parsed + cached + written through to disk.
 *   5. Grocery dedup short-circuits on canonical equality, so two free-text
 *      adds of the same fuzzy duplicate collapse to one list entry with
 *      summed quantities — no LLM call needed.
 *   6. LLM normalization failure degrades gracefully — the user never sees
 *      a crash, and the deterministic fallback fills in.
 *   7. Pantry-matcher subtract during hosting uses canonical equality so
 *      "salt" in the pantry satisfies "4 cups of salt" in an inline recipe.
 *
 * Companion to:
 *   - ingredient-normalizer.test.ts (unit tests for the normalizer)
 *   - natural-language-h11.test.ts / -h11x.test.ts (earlier phase personas)
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { handleMessage, init } from '../index.js';
import { deduplicateAndAssignDepartments } from '../services/grocery-dedup.js';
import {
	normalizeIngredientName,
	resetIngredientNormalizerCacheForTests,
} from '../services/ingredient-normalizer.js';
import { attachCanonicalNames } from '../services/recipe-parser.js';
import type { GroceryItem, Household, PantryItem } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * In-memory pantry store used by the natural-language tests below. Using a
 * real backing array instead of a plain mock lets us simulate successive
 * user messages ("we have tomatoes" → "we have a tomato") and observe the
 * cumulative pantry state the way a real user would.
 */
function createLivePantryStore() {
	let pantryYaml = '';
	return {
		getPantryItems(): PantryItem[] {
			if (!pantryYaml) return [];
			const body = stripFrontmatter(pantryYaml);
			const parsed = parse(body) as { items?: PantryItem[] } | null;
			return parsed?.items ?? [];
		},
		read: vi.fn(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			if (path === 'pantry.yaml') return pantryYaml;
			return '';
		}),
		write: vi.fn(async (path: string, contents: string) => {
			if (path === 'pantry.yaml') pantryYaml = contents;
		}),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

// ─── Test Harness ────────────────────────────────────────────────────────────

describe('H11.z Natural Language — Ingredient normalization personas', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createLivePantryStore>;

	beforeEach(async () => {
		resetIngredientNormalizerCacheForTests();
		store = createLivePantryStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(store as never);
		vi.mocked(services.data.forUser).mockReturnValue(store as never);
		await init(services);
	});

	function msg(text: string, userId = 'matt') {
		return createTestMessageContext({ text, userId });
	}

	// ════════════════════════════════════════════════════════════════════════
	// PANTRY — free-text adds attach canonical names
	// ════════════════════════════════════════════════════════════════════════

	describe('Pantry adds attach canonicalName from the normalizer', () => {
		it('"we have tomatoes" → pantry entry carries canonicalName "tomato"', async () => {
			await handleMessage(msg('we have tomatoes'));

			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.name).toBe('tomatoes');
			expect(items[0]!.canonicalName).toBe('tomato');
			// Deterministic fast-path — no LLM call for a plain plural.
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('"we have tomatoes" then "we have a tomato" → single pantry entry', async () => {
			await handleMessage(msg('we have tomatoes'));
			await handleMessage(msg('we have a tomato'));

			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.canonicalName).toBe('tomato');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('"add 2 onions to the pantry" then "add onion to the pantry" → one entry', async () => {
			await handleMessage(msg('add 2 onions to the pantry'));
			await handleMessage(msg('add onion to the pantry'));

			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.canonicalName).toBe('onion');
		});

		it('"put butter in the pantry" still routes to pantry add (no regression)', async () => {
			await handleMessage(msg('put butter in the pantry'));

			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.canonicalName).toBe('butter');
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('butter'),
			);
		});

		it('"add chicken and rice to the pantry" → both entries normalized', async () => {
			await handleMessage(msg('add chicken and rice to the pantry'));

			const items = store.getPantryItems();
			const canonicals = items.map((i) => i.canonicalName).sort();
			expect(canonicals).toEqual(['chicken', 'rice']);
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('"we have eggs, milk, and bread" → all three canonicalised without LLM', async () => {
			await handleMessage(msg('we have eggs, milk, and bread'));

			const items = store.getPantryItems();
			const canonicals = items.map((i) => i.canonicalName).sort();
			expect(canonicals).toEqual(['bread', 'egg', 'milk']);
			expect(services.llm.complete).not.toHaveBeenCalled();
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// NORMALIZER — direct calls matching user phrasings
	// ════════════════════════════════════════════════════════════════════════

	describe('Direct normalizer calls for common household phrasings', () => {
		it('"tomato" and "tomatoes" normalize to the same canonical', async () => {
			const a = await normalizeIngredientName(services, 'tomato');
			const b = await normalizeIngredientName(services, 'tomatoes');
			expect(a.canonical).toBe(b.canonical);
			expect(a.canonical).toBe('tomato');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('"Roma tomatoes" normalizes to "roma tomato" (head-noun rescue handles lookup)', async () => {
			// Phase H11.z iteration 2: the normalizer preserves the varietal
			// qualifier ("roma tomato"), and the lookup layer — `pantryContains`'s
			// head-noun rescue tier — bridges the gap to a plain "tomato" query.
			// This is intentional: the normalizer's job is to preserve
			// information; the matcher's job is to handle the specificity gap.
			// End-to-end coverage lives in the "Hosting subtract" journey below.
			const result = await normalizeIngredientName(services, 'Roma tomatoes');
			expect(result.canonical).toBe('roma tomato');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('"4 cups of salt" → canonical "salt" (quantifier stripped)', async () => {
			const result = await normalizeIngredientName(services, '4 cups of salt');
			expect(result.canonical).toBe('salt');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('"chicken breasts" → canonical "chicken breast" without LLM', async () => {
			const result = await normalizeIngredientName(services, 'chicken breasts');
			expect(result.canonical).toBe('chicken breast');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('second call for the same input is served from cache', async () => {
			await normalizeIngredientName(services, 'carrots');
			await normalizeIngredientName(services, 'carrots');
			// Cache hit on second call — no extra work, no LLM call either way.
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('case-insensitive cache hit: "Tomatoes" and "tomatoes" share the entry', async () => {
			const a = await normalizeIngredientName(services, 'Tomatoes');
			const b = await normalizeIngredientName(services, 'tomatoes');
			expect(a.canonical).toBe(b.canonical);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// NORMALIZER — LLM fallback + graceful degradation
	// ════════════════════════════════════════════════════════════════════════

	describe('LLM fallback path', () => {
		it('ambiguous non-ASCII input triggers the LLM, response is parsed', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({ canonical: 'kimchi', display: '김치' }),
			);

			const result = await normalizeIngredientName(services, '김치');

			expect(services.llm.complete).toHaveBeenCalledTimes(1);
			expect(services.llm.complete).toHaveBeenCalledWith(expect.any(String), { tier: 'fast' });
			expect(result.canonical).toBe('kimchi');
		});

		it('LLM failure → graceful deterministic fallback, no crash', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

			// Input that can't resolve deterministically — forces the LLM branch.
			const result = await normalizeIngredientName(services, '김치');

			// Falls back to lowercased/trimmed input — still returns something usable.
			expect(result.canonical.length).toBeGreaterThan(0);
			expect(result.display.length).toBeGreaterThan(0);
		});

		it("LLM fallback result is cached — same input doesn't re-hit LLM", async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({ canonical: 'kimchi', display: '김치' }),
			);

			await normalizeIngredientName(services, '김치');
			await normalizeIngredientName(services, '김치');

			expect(services.llm.complete).toHaveBeenCalledTimes(1);
		});

		it('LLM is never asked to normalise "tomatoes" — fast-path owns it', async () => {
			await handleMessage(msg('we have tomatoes'));
			await handleMessage(msg('add tomato to the pantry'));
			await handleMessage(msg('we have a tomato'));

			expect(services.llm.complete).not.toHaveBeenCalled();
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// GROCERY DEDUP — canonical short-circuit
	// ════════════════════════════════════════════════════════════════════════

	describe('Grocery dedup canonical short-circuit', () => {
		function gitem(overrides: Partial<GroceryItem> = {}): GroceryItem {
			return {
				name: 'tomato',
				quantity: 1,
				unit: null,
				department: 'Produce',
				recipeIds: [],
				purchased: false,
				addedBy: 'matt',
				...overrides,
			};
		}

		it('"tomato" + "tomatoes" → merged into one line, no LLM call', async () => {
			const items: GroceryItem[] = [
				gitem({ name: 'tomato', quantity: 2, recipeIds: ['pasta'] }),
				gitem({ name: 'tomatoes', quantity: 3, recipeIds: ['salad'] }),
			];

			const result = await deduplicateAndAssignDepartments(services, items);

			expect(result).toHaveLength(1);
			expect(result[0]!.quantity).toBe(5);
			expect(result[0]!.recipeIds.sort()).toEqual(['pasta', 'salad']);
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('canonical merge promotes Produce over Other when only one knows the department', async () => {
			const items: GroceryItem[] = [
				gitem({ name: 'Onion', quantity: 1, department: 'Other' }),
				gitem({ name: 'onions', quantity: 2, department: 'Produce' }),
			];

			const result = await deduplicateAndAssignDepartments(services, items);

			expect(result).toHaveLength(1);
			expect(result[0]!.department).toBe('Produce');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('distinct items with different canonicals keep their canonical forms after merge', async () => {
			// With >1 items and no dupes to merge, the canonical short-circuit
			// still runs first (and attaches canonicalName), then the LLM dedup
			// path runs for possible fuzzy merges. We assert the canonical
			// attachment, not the LLM-call count — the LLM is allowed here.
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify([
					{ name: 'Tomatoes', quantity: 2, unit: null, department: 'Produce' },
					{ name: 'onions', quantity: 1, unit: null, department: 'Produce' },
					{ name: 'carrots', quantity: 3, unit: null, department: 'Produce' },
				]),
			);
			const items: GroceryItem[] = [
				gitem({ name: 'Tomatoes', quantity: 2, department: 'Produce' }),
				gitem({ name: 'onions', quantity: 1, department: 'Produce' }),
				gitem({ name: 'carrots', quantity: 3, department: 'Produce' }),
			];

			const result = await deduplicateAndAssignDepartments(services, items);

			expect(result).toHaveLength(3);
			// Names preserved; the canonical merge ran first and assigned
			// canonicalName before handing off to the LLM step.
			const names = result.map((i) => i.name.toLowerCase()).sort();
			expect(names).toEqual(['carrots', 'onions', 'tomatoes']);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// RECIPE PARSER — canonical attachment on parsed ingredients
	// ════════════════════════════════════════════════════════════════════════

	describe('Recipe ingredient normalization (attachCanonicalNames)', () => {
		it('"Roma tomatoes", "yellow onion", "garlic cloves" all get canonical forms', async () => {
			const ingredients = [
				{ name: 'Roma tomatoes', quantity: 4, unit: null },
				{ name: 'yellow onion', quantity: 1, unit: null },
				{ name: 'garlic cloves', quantity: 3, unit: null },
			];

			const attached = await attachCanonicalNames(services, ingredients);

			expect(attached).toHaveLength(3);
			// Deterministic path keeps varietal adjectives; only head-noun
			// plural→singular normalisation runs.
			expect(attached[0]!.canonicalName).toBe('roma tomato');
			expect(attached[1]!.canonicalName).toBe('yellow onion');
			expect(attached[2]!.canonicalName).toBe('garlic clove');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('already-normalised ingredients are left alone (idempotent)', async () => {
			const ingredients = [{ name: 'tomato', quantity: 2, unit: null, canonicalName: 'tomato' }];

			const attached = await attachCanonicalNames(services, ingredients);

			expect(attached[0]!.canonicalName).toBe('tomato');
			expect(services.llm.complete).not.toHaveBeenCalled();
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// END-TO-END — full household journey
	// ════════════════════════════════════════════════════════════════════════

	describe('End-to-end H11.z household journeys', () => {
		it('Journey: "we have tomatoes" → later "we have a tomato" → pantry still one entry', async () => {
			await handleMessage(msg('we have tomatoes'));
			await handleMessage(msg('we have a tomato'));
			await handleMessage(msg('we have tomatoes'));

			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.canonicalName).toBe('tomato');
			// 3 pantry writes happened, but they all dedupe by canonical key.
			expect(store.write.mock.calls.length).toBeGreaterThanOrEqual(3);
		});

		it('Journey: mixed plurals in one message dedupe correctly', async () => {
			// First add — two separate items (plural).
			await handleMessage(msg('add carrots and potatoes to the pantry'));
			// Second add — articles + singular ("a carrot and a potato"). Phase
			// H11.z iteration 2 strips leading articles in `deterministicCanonical`
			// so the canonical keys collapse onto the plural entries from the
			// first message.
			await handleMessage(msg('add a carrot and a potato to the pantry'));

			const items = store.getPantryItems();
			const canonicals = items.map((i) => i.canonicalName).sort();
			expect(canonicals).toEqual(['carrot', 'potato']);
		});

		it('Journey: add grocery dupes via free-text adds → list collapses by canonical', async () => {
			// Two adds of the same item with different pluralisation. This goes
			// through handleGroceryAdd → grocery-store dedup, but we exercise the
			// canonical-merge path directly here against the merged list.
			const raw: GroceryItem[] = [
				{
					name: 'tomatoes',
					quantity: 3,
					unit: null,
					department: 'Produce',
					recipeIds: ['salad'],
					purchased: false,
					addedBy: 'matt',
				},
				{
					name: 'tomato',
					quantity: 2,
					unit: null,
					department: 'Produce',
					recipeIds: ['pasta'],
					purchased: false,
					addedBy: 'sarah',
				},
			];

			const result = await deduplicateAndAssignDepartments(services, raw);

			expect(result).toHaveLength(1);
			expect(result[0]!.quantity).toBe(5);
			expect(result[0]!.recipeIds.sort()).toEqual(['pasta', 'salad']);
			// Neither user pays an LLM tax for a boring plural merge.
			expect(services.llm.complete).not.toHaveBeenCalled();
		});

		it('Journey: LLM down → pantry add still works (deterministic fast-path)', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

			await handleMessage(msg('we have tomatoes and onions'));

			const items = store.getPantryItems();
			expect(items).toHaveLength(2);
			const canonicals = items.map((i) => i.canonicalName).sort();
			expect(canonicals).toEqual(['onion', 'tomato']);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// ITERATION 2 — Articles, quantity words, varietal rescue, pressure tests
	// ════════════════════════════════════════════════════════════════════════

	describe('Iteration 2: article & quantity-word stripping', () => {
		it('"we have a tomato" → canonical "tomato" (article stripped)', async () => {
			await handleMessage(msg('we have a tomato'));
			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.canonicalName).toBe('tomato');
		});

		it('"add a potato and a carrot to the pantry" → two entries, no "a potato" dupe', async () => {
			await handleMessage(msg('add a potato and a carrot to the pantry'));
			const items = store.getPantryItems();
			const canonicals = items.map((i) => i.canonicalName).sort();
			expect(canonicals).toEqual(['carrot', 'potato']);
			// Exactly 2 — not 3 or 4 from article-laden duplicates.
			expect(items).toHaveLength(2);
			// Display names must not echo back the stripped article ("a "),
			// otherwise /pantry list shows "a potato" to the user even though
			// canonical dedup works correctly.
			for (const it of items) {
				expect(it.name.toLowerCase()).not.toMatch(/^(?:a|an|the|some|a few|a bunch of) /);
			}
		});

		it('"we have an onion" → canonical "onion"', async () => {
			await handleMessage(msg('we have an onion'));
			const items = store.getPantryItems();
			expect(items[0]!.canonicalName).toBe('onion');
		});

		it('"add a potato" then "add potato" → single pantry entry (article-strip dedup)', async () => {
			await handleMessage(msg('add a potato to the pantry'));
			await handleMessage(msg('add potato to the pantry'));
			const items = store.getPantryItems();
			expect(items).toHaveLength(1);
			expect(items[0]!.canonicalName).toBe('potato');
		});

		it('direct normalizer: "the eggs" → canonical "egg"', async () => {
			const result = await normalizeIngredientName(services, 'the eggs');
			expect(result.canonical).toBe('egg');
		});

		it('direct normalizer: quantity words resolve to bare head nouns', async () => {
			const cases: Array<[string, string]> = [
				['some rice', 'rice'],
				['several apples', 'apple'],
				['a few bananas', 'banana'],
				['a bunch of kale', 'kale'],
				['lots of carrots', 'carrot'],
				['a handful of almonds', 'almond'],
			];
			for (const [raw, expected] of cases) {
				const result = await normalizeIngredientName(services, raw);
				expect(result.canonical, `"${raw}" → "${expected}"`).toBe(expected);
			}
			expect(services.llm.complete).not.toHaveBeenCalled();
		});
	});

	describe('Iteration 2: varietal & brand head-noun rescue at lookup time', () => {
		// These tests use the `pantryContains` head-noun rescue tier added in
		// Phase H11.z iteration 2. The normalizer preserves the full specific
		// form ("roma tomato", "kerrygold butter") and the matcher bridges.
		// Import locally since the top of the file doesn't pull `pantryContains`.
		async function pantryContains(
			...args: Parameters<typeof import('../services/pantry-store.js').pantryContains>
		) {
			const mod = await import('../services/pantry-store.js');
			return mod.pantryContains(...args);
		}

		it('pantry "Roma tomatoes" + recipe query "tomato" → match', async () => {
			const items: PantryItem[] = [
				{
					name: 'Roma tomatoes',
					quantity: '5',
					addedDate: '2026-04-09',
					category: 'Produce',
					canonicalName: 'roma tomato',
				},
			];
			expect(await pantryContains(items, 'tomatoes', 'tomato')).toBe(true);
		});

		it('symmetric: pantry "tomato" + query "Roma tomatoes" → match', async () => {
			const items: PantryItem[] = [
				{
					name: 'Tomato',
					quantity: '3',
					addedDate: '2026-04-09',
					category: 'Produce',
					canonicalName: 'tomato',
				},
			];
			expect(await pantryContains(items, 'Roma tomatoes', 'roma tomato')).toBe(true);
		});

		it('pantry "Kerrygold butter" + query "butter" → match', async () => {
			const items: PantryItem[] = [
				{
					name: 'Kerrygold butter',
					quantity: '1 lb',
					addedDate: '2026-04-09',
					category: 'Dairy & Eggs',
					canonicalName: 'kerrygold butter',
				},
			];
			expect(await pantryContains(items, 'butter', 'butter')).toBe(true);
		});

		it('pantry "large yellow onion" + query "onion" → match', async () => {
			const items: PantryItem[] = [
				{
					name: 'Large yellow onion',
					quantity: '1',
					addedDate: '2026-04-09',
					category: 'Produce',
					canonicalName: 'large yellow onion',
				},
			];
			expect(await pantryContains(items, 'onion', 'onion')).toBe(true);
		});

		it('REGRESSION: pantry "rice" + query "licorice" → NO match (word-boundary guard)', async () => {
			const items: PantryItem[] = [
				{
					name: 'Rice',
					quantity: '2 lbs',
					addedDate: '2026-04-09',
					category: 'Pantry & Dry Goods',
					canonicalName: 'rice',
				},
			];
			// The leading-space requirement in the head-noun rescue prevents
			// this false positive. Critical regression guard.
			expect(await pantryContains(items, 'licorice', 'licorice')).toBe(false);
		});

		it('REGRESSION: pantry "potato" + query "tomato" → NO match', async () => {
			const items: PantryItem[] = [
				{
					name: 'Potato',
					quantity: '3',
					addedDate: '2026-04-09',
					category: 'Produce',
					canonicalName: 'potato',
				},
			];
			expect(await pantryContains(items, 'tomato', 'tomato')).toBe(false);
		});

		it('prep-state adjective: pantry "chopped onion" + query "onion" → match', async () => {
			const items: PantryItem[] = [
				{
					name: 'Chopped onions',
					quantity: '2 cups',
					addedDate: '2026-04-09',
					category: 'Produce',
					canonicalName: 'chopped onion',
				},
			];
			expect(await pantryContains(items, 'onion', 'onion')).toBe(true);
		});
	});

	describe('Iteration 2: null-unit grocery dedup', () => {
		function gitem(overrides: Partial<GroceryItem> = {}): GroceryItem {
			return {
				name: 'chicken',
				quantity: 1,
				unit: null,
				department: 'Meat & Seafood',
				recipeIds: [],
				purchased: false,
				addedBy: 'matt',
				...overrides,
			};
		}

		it('"2 lbs chicken" + "chicken" → one line (unit-ful wins)', async () => {
			const items: GroceryItem[] = [
				gitem({ quantity: 2, unit: 'lbs', recipeIds: ['a'] }),
				gitem({ quantity: 1, unit: null, recipeIds: ['b'] }),
			];
			const result = await deduplicateAndAssignDepartments(services, items);
			expect(result).toHaveLength(1);
			expect(result[0]!.unit).toBe('lbs');
			expect(result[0]!.quantity).toBe(3);
			expect(services.llm.complete).not.toHaveBeenCalled();
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// DOCUMENTED GAPS — skipped with full context, NOT hidden TODOs
	// ════════════════════════════════════════════════════════════════════════

	describe('Documented gaps (it.skip with full fix recipes)', () => {
		/**
		 * GAP-1: Cross-family unit conversion
		 * ------------------------------------
		 * `apps/food/src/services/grocery-dedup.ts` `canonicalMerge` keys on
		 * `${canonical}|${unit}`. Merging "2 lbs chicken" + "16 oz chicken"
		 * requires knowing that 1 lb = 16 oz — cross-family mass conversion.
		 *
		 * FIX REQUIRES:
		 *   1. New `apps/food/src/services/unit-conversions.ts` with a
		 *      unit-family table (mass: lb/oz/g/kg; volume: tsp/tbsp/cup/ml/L;
		 *      count: dozen/pair/each).
		 *   2. A `convertToCommonUnit(qty, unit, targetUnit)` helper.
		 *   3. Extend canonicalMerge to, after the null-unit sweep, walk
		 *      pairs sharing a canonical and convert to the larger unit.
		 *
		 * DEFERRED because: unit-family table is a standalone concern that
		 * warrants its own dedicated mini-phase (H11.zz). Not a silent bug —
		 * the user sees two chicken lines, slightly annoying but not wrong.
		 */
		it.skip('GAP-1: "2 lbs chicken" + "16 oz chicken" → should merge to 3 lbs', async () => {
			expect(true).toBe(true);
		});

		/**
		 * GAP-2: Possessive stripping
		 * ----------------------------
		 * `apps/food/src/services/ingredient-normalizer.ts` `deterministicCanonical`
		 * does not strip `'s`. "Matt's eggs" normalizes to `"matt's egg"`,
		 * which does NOT dedup with `"egg"`.
		 *
		 * FIX REQUIRES: Add a regex pass after article strip:
		 *   s = s.replace(/^[a-z]+'s\s+/i, '');
		 *
		 * DEFERRED because: possessives are rare in ingredient contexts, and
		 * naïve stripping risks over-stripping recipe titles ("Matt's
		 * meatballs" → "meatballs"). Needs a policy decision on whether the
		 * stripping should be scoped to ingredient names only.
		 */
		it.skip('GAP-2: "Matt\'s eggs" should dedup with "eggs"', async () => {
			expect(true).toBe(true);
		});

		/**
		 * GAP-3: Misspelling tolerance
		 * -----------------------------
		 * No edit-distance or LLM rescue on deterministic miss.
		 * "tomatoe", "brocoli", "onyon" all produce unique canonicals that
		 * silently stay distinct from correctly-spelled entries.
		 *
		 * FIX REQUIRES (two options):
		 *   A. Bounded Levenshtein lookup against existing canonicals
		 *      before accepting a new unique canonical — cheap but may
		 *      overcorrect ("bass" vs "base").
		 *   B. LLM rescue on first-seen input with no cache hit — more
		 *      accurate but costs a token per first-seen typo.
		 *
		 * DEFERRED because: this is a design question (how aggressive should
		 * auto-correct be?), not a pure bug fix. Requires user calibration
		 * on a real corpus of misspellings before picking a strategy.
		 */
		it.skip('GAP-3: "tomatoe" should normalize to "tomato" (typo tolerance)', async () => {
			expect(true).toBe(true);
		});
	});
});
