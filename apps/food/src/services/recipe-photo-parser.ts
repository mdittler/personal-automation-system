/**
 * Recipe photo parser — uses LLM vision to extract structured recipes from photos.
 */

import type { CoreServices } from '@pas/core/types';
import type { ParsedRecipe } from '../types.js';
import { parseJsonResponse, attachCanonicalNames } from './recipe-parser.js';
import { fenceCaption } from '../utils/sanitize.js';

const PHOTO_RECIPE_PROMPT = `You are a recipe parser. Extract the recipe from this photo into a structured JSON format.
The photo may be a cookbook page, a handwritten recipe card, or a screenshot.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "title": "Recipe Name",
  "source": "photo",
  "ingredients": [
    { "name": "ingredient name", "quantity": 2, "unit": "cups", "notes": "optional note" }
  ],
  "instructions": ["Step 1 text", "Step 2 text"],
  "servings": 4,
  "prepTime": 15,
  "cookTime": 30,
  "tags": ["tag1", "tag2"],
  "cuisine": "Italian",
  "macros": { "calories": 400, "protein": 25, "carbs": 30, "fat": 15, "fiber": 5 },
  "allergens": ["dairy", "gluten"]
}

Rules:
- quantity is a number or null if unspecified
- unit is a string or null if the ingredient is counted (e.g. "2 eggs")
- prepTime and cookTime are in minutes, omit if unknown
- macros are estimates per serving, omit if you can't estimate
- allergens should list common allergens present
- tags should be descriptive: easy, healthy, quick, weeknight, comfort-food, batch-friendly, etc.
- source must always be "photo"`;

/**
 * Parse a recipe from a photo using LLM vision.
 */
export async function parseRecipeFromPhoto(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
	caption?: string,
): Promise<ParsedRecipe> {
	const captionContext = fenceCaption(caption);
	const prompt = `${PHOTO_RECIPE_PROMPT}${captionContext}\n\nExtract the recipe from the attached photo.`;

	const result = await services.llm.complete(prompt, {
		tier: 'standard',
		images: [{ data: photo, mimeType }],
	});

	const parsed = parseJsonResponse(result, 'recipe photo parse') as ParsedRecipe;

	if (!parsed.title || !parsed.ingredients?.length || !parsed.instructions?.length) {
		throw new Error(
			'Could not parse a complete recipe from the photo. Please ensure the recipe text is clearly visible.',
		);
	}

	parsed.tags = parsed.tags ?? [];
	parsed.allergens = parsed.allergens ?? [];
	parsed.servings = parsed.servings ?? 4;
	parsed.source = 'photo';

	// F18: filter malformed ingredients and attach canonical names
	parsed.ingredients = parsed.ingredients.filter(
		(ing) => typeof ing.name === 'string' && ing.name.trim() !== '',
	);
	parsed.ingredients = await attachCanonicalNames(services, parsed.ingredients);

	return parsed;
}
