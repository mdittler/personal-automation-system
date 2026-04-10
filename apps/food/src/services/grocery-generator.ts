/**
 * Recipe-to-grocery pipeline.
 *
 * Aggregates ingredients from recipes, filters staples and pantry items,
 * deduplicates via LLM, and produces a ready-to-shop grocery list.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import type { GroceryItem, GroceryList, Recipe } from '../types.js';
import { deduplicateAndAssignDepartments } from './grocery-dedup.js';
import { addItems, createEmptyList, loadGroceryList, saveGroceryList } from './grocery-store.js';
import { assignDepartment } from './item-parser.js';
import { loadPantry, pantryContains } from './pantry-store.js';
import { emitGroceryListReady } from '../events/emitters.js';
import { loadHousehold } from '../utils/household-guard.js';
import { isoNow } from '../utils/date.js';

export interface GenerationResult {
	list: GroceryList;
	excludedStaples: string[];
	excludedPantry: string[];
	recipeTitles: string[];
}

/**
 * Generate a grocery list from pre-resolved recipes.
 *
 * Pipeline:
 * 1. Aggregate all ingredients
 * 2. Exact-match merge
 * 3. Filter staples (from user config)
 * 4. Filter pantry items
 * 5. LLM dedup + department assignment
 * 6. Add to existing list (or create new)
 * 7. Save
 *
 * Recipe resolution (search, disambiguation) is done by the caller.
 */
export async function generateGroceryFromRecipes(
	services: CoreServices,
	recipes: Recipe[],
	sharedStore: ScopedDataStore,
): Promise<GenerationResult> {
	if (!recipes.length) {
		throw new Error('No recipes provided');
	}

	// 1. Aggregate ingredients across recipes
	const rawItems: GroceryItem[] = [];
	for (const recipe of recipes) {
		for (const ing of recipe.ingredients) {
			rawItems.push({
				name: ing.name,
				quantity: ing.quantity,
				unit: ing.unit,
				department: assignDepartment(ing.name),
				recipeIds: [recipe.id],
				purchased: false,
				addedBy: 'system',
			});
		}
	}

	// 3. Exact-match merge
	const merged = exactMerge(rawItems);

	// 4. Filter staples
	const stapleStr = (await services.config.get<string>('staple_items')) as string | undefined;
	const staples = (stapleStr ?? 'salt,pepper,olive oil,butter,garlic')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	const excludedStaples: string[] = [];
	const afterStaples = merged.filter((item) => {
		const isStaple = staples.some(
			(s) => item.name.toLowerCase().includes(s) || s.includes(item.name.toLowerCase()),
		);
		if (isStaple) excludedStaples.push(item.name);
		return !isStaple;
	});

	// 5. Filter pantry items
	const pantry = await loadPantry(sharedStore);
	const excludedPantry: string[] = [];
	const afterPantry = afterStaples.filter((item) => {
		// H11.z: prefer canonical match when grocery item carries one
		if (pantryContains(pantry, item.name, item.canonicalName)) {
			excludedPantry.push(item.name);
			return false;
		}
		return true;
	});

	// 6. LLM dedup + department assignment
	const deduped = await deduplicateAndAssignDepartments(services, afterPantry);

	// 7. Add to existing list or create new
	let list = await loadGroceryList(sharedStore);
	if (!list) list = createEmptyList();
	list = addItems(list, deduped);

	// 8. Save
	await saveGroceryList(sharedStore, list);

	// Emit event after successful save
	const household = await loadHousehold(sharedStore);
	await emitGroceryListReady(services, {
		listId: list.id,
		householdId: household?.id ?? 'shared',
		itemCount: list.items.length,
		source: 'recipes',
		generatedAt: isoNow(),
	});

	return {
		list,
		excludedStaples,
		excludedPantry,
		recipeTitles: recipes.map((r) => r.title),
	};
}

/** Merge items with exact same lowercase name and same unit. */
function exactMerge(items: GroceryItem[]): GroceryItem[] {
	const merged = new Map<string, GroceryItem>();
	for (const item of items) {
		const key = `${item.name.toLowerCase()}|${item.unit?.toLowerCase() ?? ''}`;
		const existing = merged.get(key);
		if (existing) {
			if (existing.quantity != null && item.quantity != null) {
				existing.quantity += item.quantity;
			}
			for (const rid of item.recipeIds) {
				if (!existing.recipeIds.includes(rid)) {
					existing.recipeIds.push(rid);
				}
			}
		} else {
			merged.set(key, { ...item });
		}
	}
	return [...merged.values()];
}
