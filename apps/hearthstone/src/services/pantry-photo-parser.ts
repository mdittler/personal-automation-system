/**
 * Pantry photo parser — uses LLM vision to identify food items from pantry/fridge photos.
 */

import type { CoreServices } from '@pas/core/types';
import type { PantryItem } from '../types.js';
import { parseJsonResponse } from './recipe-parser.js';

const PANTRY_PHOTO_PROMPT = `You are a pantry inventory assistant. Identify all food items visible in this photo of a pantry, fridge, or freezer.

Return ONLY a valid JSON array (no markdown, no explanation):
[
  { "name": "item name", "quantity": "estimated quantity (e.g. '2 cans', '1 bag')", "category": "produce|dairy|meat|grains|canned|condiments|beverages|frozen|snacks|other" }
]

Rules:
- List every distinct food item you can identify
- Estimate quantities based on what's visible
- Use standard category names: produce, dairy, meat, grains, canned, condiments, beverages, frozen, snacks, other
- If unsure about an item, skip it
- Return an empty array [] if no food items are identifiable`;

/**
 * Identify pantry items from a photo using LLM vision.
 */
export async function parsePantryFromPhoto(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
): Promise<PantryItem[]> {
	const result = await services.llm.complete(
		`${PANTRY_PHOTO_PROMPT}\n\nIdentify the food items in the attached photo.`,
		{
			tier: 'standard',
			images: [{ data: photo, mimeType }],
		},
	);

	const parsed = parseJsonResponse(result, 'pantry photo parse');

	if (!Array.isArray(parsed)) {
		return [];
	}

	const today = new Date().toISOString().slice(0, 10);

	return parsed.map((item: Record<string, unknown>) => ({
		name: typeof item.name === 'string' ? item.name : 'unknown item',
		quantity: typeof item.quantity === 'string' ? item.quantity : '1',
		addedDate: today,
		category: typeof item.category === 'string' ? item.category : 'other',
	}));
}
