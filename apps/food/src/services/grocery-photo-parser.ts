/**
 * Grocery photo parser — uses LLM vision to extract grocery items from photos.
 * Can also detect and extract recipes from recipe photos.
 */

import type { CoreServices } from '@pas/core/types';
import type { ParsedRecipe } from '../types.js';
import { parseJsonResponse, attachCanonicalNames } from './recipe-parser.js';
import { fenceCaption } from '../utils/sanitize.js';
import { isValidGroceryPhotoItem } from '../utils/photo-validators.js';

/** Result of parsing a grocery photo. */
export interface GroceryPhotoResult {
	items: Array<{ name: string; quantity: number | null; unit: string | null }>;
	isRecipe: boolean;
	parsedRecipe?: ParsedRecipe;
}

const GROCERY_PHOTO_PROMPT = `You are a grocery list assistant. Extract grocery/shopping items from this photo.
The photo may be a handwritten shopping list, a printed list, or a recipe (from which you should extract ingredients).

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "items": [
    { "name": "item name", "quantity": 2, "unit": "cups" }
  ],
  "isRecipe": false,
  "parsedRecipe": null
}

If the photo is a RECIPE (not a shopping list), set isRecipe to true and also include parsedRecipe:
{
  "items": [
    { "name": "ingredient name", "quantity": 2, "unit": "cups" }
  ],
  "isRecipe": true,
  "parsedRecipe": {
    "title": "Recipe Name",
    "source": "photo",
    "ingredients": [{ "name": "name", "quantity": 2, "unit": "cups" }],
    "instructions": ["Step 1", "Step 2"],
    "servings": 4,
    "tags": [],
    "allergens": []
  }
}

Rules:
- quantity is a number or null if unspecified
- unit is a string or null if the item is counted
- items should be the ingredients/shopping items extracted
- If it's a recipe photo, extract both the grocery items AND the full recipe`;

/**
 * Extract grocery items from a photo using LLM vision.
 * If the photo is a recipe, also extracts the recipe data.
 */
export async function parseGroceryFromPhoto(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
	caption?: string,
): Promise<GroceryPhotoResult> {
	const captionContext = fenceCaption(caption);
	const result = await services.llm.complete(
		`${GROCERY_PHOTO_PROMPT}${captionContext}\n\nExtract grocery items from the attached photo.`,
		{
			tier: 'standard',
			images: [{ data: photo, mimeType }],
		},
	);

	const parsed = parseJsonResponse(result, 'grocery photo parse') as Record<string, unknown>;

	const rawItems = Array.isArray(parsed.items) ? (parsed.items as unknown[]) : [];
	const items = rawItems
		.filter(isValidGroceryPhotoItem)
		.map((item) => ({
			name: item.name,
			quantity: (item.quantity !== undefined && item.quantity !== null) ? item.quantity : null,
			unit: typeof (item as Record<string, unknown>)['unit'] === 'string'
				? ((item as Record<string, unknown>)['unit'] as string)
				: null,
		}));

	const isRecipe = parsed.isRecipe === true;
	let parsedRecipe = isRecipe && parsed.parsedRecipe
		? (parsed.parsedRecipe as ParsedRecipe)
		: undefined;

	// F18: attach canonical names to photo-derived recipe ingredients (guard for malformed parsedRecipe)
	if (parsedRecipe && Array.isArray(parsedRecipe.ingredients)) {
		parsedRecipe.ingredients = parsedRecipe.ingredients.filter(
			(ing) => typeof ing.name === 'string' && ing.name.trim() !== '',
		);
		parsedRecipe.ingredients = await attachCanonicalNames(services, parsedRecipe.ingredients);
	}

	return { items, isRecipe, parsedRecipe };
}
