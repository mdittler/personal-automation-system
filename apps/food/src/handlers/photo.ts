/**
 * Photo handler — dispatches incoming photos to the appropriate parser.
 *
 * Routes by caption keyword first, falls back to LLM vision classification.
 */

import type { CoreServices, PhotoContext } from '@pas/core/types';
import { stringify } from 'yaml';
import { generateFrontmatter } from '@pas/core/utils/frontmatter';
import { savePhoto } from '../services/photo-store.js';
import { parseRecipeFromPhoto } from '../services/recipe-photo-parser.js';
import { parseReceiptFromPhoto } from '../services/receipt-parser.js';
import { parsePantryFromPhoto } from '../services/pantry-photo-parser.js';
import { parseGroceryFromPhoto } from '../services/grocery-photo-parser.js';
import { saveRecipe, updateRecipe } from '../services/recipe-store.js';
import { addPantryItems, loadPantry, savePantry } from '../services/pantry-store.js';
import { addItems, loadGroceryList, saveGroceryList, createEmptyList } from '../services/grocery-store.js';
import { isoNow } from '../utils/date.js';
import type { Receipt } from '../types.js';
import { updatePricesFromReceipt } from '../services/price-store.js';

type PhotoType = 'recipe' | 'receipt' | 'pantry' | 'grocery';

// ─── Caption-based classification ──────────────────────────────

const RECIPE_KEYWORDS = /\b(recipe|cookbook|recipe\s+card)\b/i;
const RECIPE_SAVE = /\bsave\b/i;
const RECEIPT_KEYWORDS = /\b(receipt|bill|checkout|total|spent)\b/i;
const PANTRY_KEYWORDS = /\b(pantry|fridge|freezer|shelf|what.?s in|contents)\b/i;
const GROCERY_KEYWORDS = /\b(grocery|shopping|list|buy|add.+to.+(list|grocery))\b/i;

function classifyByCaption(caption: string): PhotoType | null {
	// Check receipt before recipe — "save this bill" should be receipt, not recipe
	if (RECEIPT_KEYWORDS.test(caption)) return 'receipt';
	if (RECIPE_KEYWORDS.test(caption)) return 'recipe';
	// "save" alone implies recipe (user wants to save a recipe from a photo)
	if (RECIPE_SAVE.test(caption)) return 'recipe';
	if (PANTRY_KEYWORDS.test(caption)) return 'pantry';
	if (GROCERY_KEYWORDS.test(caption)) return 'grocery';
	return null;
}

// ─── LLM vision classification ─────────────────────────────────

const CLASSIFY_PROMPT = `Look at this photo and classify it as one of:
- "recipe" (a recipe: cookbook page, handwritten card, screenshot)
- "receipt" (a grocery/store receipt or bill)
- "pantry" (contents of a pantry, fridge, or freezer)
- "grocery" (a grocery/shopping list, handwritten or printed)

Reply with ONLY the single word classification. Nothing else.`;

async function classifyByVision(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
): Promise<PhotoType | null> {
	const result = await services.llm.complete(CLASSIFY_PROMPT, {
		tier: 'standard',
		images: [{ data: photo, mimeType }],
	});

	const lower = result.trim().toLowerCase();
	if (lower.includes('recipe')) return 'recipe';
	if (lower.includes('receipt')) return 'receipt';
	if (lower.includes('pantry') || lower.includes('fridge') || lower.includes('freezer')) return 'pantry';
	if (lower.includes('grocery') || lower.includes('list') || lower.includes('shopping')) return 'grocery';

	return null;
}

// ─── Main handler ───────────────────────────────────────────────

export async function handlePhoto(
	services: CoreServices,
	ctx: PhotoContext,
): Promise<void> {
	try {
		// Classify the photo type
		let photoType: PhotoType | null;
		if (ctx.caption) {
			const captionType = classifyByCaption(ctx.caption);
			photoType = captionType ?? await classifyByVision(services, ctx.photo, ctx.mimeType);
		} else {
			photoType = await classifyByVision(services, ctx.photo, ctx.mimeType);
		}

		if (!photoType) {
			await services.telegram.send(
				ctx.userId,
				'I\'m not sure what kind of photo this is. Please add a caption:\n' +
				'• "save this recipe" for recipe photos\n' +
				'• "receipt" for grocery receipts\n' +
				'• "what\'s in my fridge" for pantry photos\n' +
				'• "add to grocery list" for shopping lists',
			);
			return;
		}

		const sharedStore = services.data.forShared('shared');

		switch (photoType) {
			case 'recipe':
				await handleRecipePhoto(services, ctx, sharedStore);
				break;
			case 'receipt':
				await handleReceiptPhoto(services, ctx, sharedStore);
				break;
			case 'pantry':
				await handlePantryPhoto(services, ctx, sharedStore);
				break;
			case 'grocery':
				await handleGroceryPhoto(services, ctx, sharedStore);
				break;
		}
	} catch (err) {
		services.logger.error('Photo handler error: %s', err);
		await services.telegram.send(
			ctx.userId,
			'Sorry, I had trouble processing that photo. Please try again or add a caption describing what it is (e.g. "save this recipe" or "grocery receipt").',
		);
	}
}

// ─── Sub-handlers ───────────────────────────────────────────────

async function handleRecipePhoto(
	services: CoreServices,
	ctx: PhotoContext,
	store: ReturnType<CoreServices['data']['forShared']>,
): Promise<void> {
	const parsed = await parseRecipeFromPhoto(services, ctx.photo, ctx.mimeType, ctx.caption);

	// Save photo
	const photoPath = await savePhoto(store, ctx.photo, 'recipe');

	// Save recipe
	const recipe = await saveRecipe(store, parsed, ctx.userId);

	// Update recipe with photo path
	recipe.sourcePhoto = photoPath;
	await updateRecipe(store, recipe);

	await services.telegram.send(
		ctx.userId,
		`📷 Recipe saved from photo!\n\n**${recipe.title}**\n` +
		`• ${recipe.ingredients.length} ingredients\n` +
		`• ${recipe.instructions.length} steps\n` +
		`• Servings: ${recipe.servings}\n` +
		(recipe.cuisine ? `• Cuisine: ${recipe.cuisine}\n` : '') +
		`\nStatus: draft (will be confirmed after you cook and rate it)`,
	);
}

async function handleReceiptPhoto(
	services: CoreServices,
	ctx: PhotoContext,
	store: ReturnType<CoreServices['data']['forShared']>,
): Promise<void> {
	const parsed = await parseReceiptFromPhoto(services, ctx.photo, ctx.mimeType, ctx.caption);

	// Save photo
	const photoPath = await savePhoto(store, ctx.photo, 'receipt');

	// Build receipt record
	const id = `${parsed.date}-${Date.now().toString(36)}`;
	const receipt: Receipt = {
		id,
		store: parsed.store,
		date: parsed.date,
		lineItems: parsed.lineItems,
		subtotal: parsed.subtotal,
		tax: parsed.tax,
		total: parsed.total,
		photoPath,
		capturedAt: isoNow(),
	};

	// Save receipt
	const fm = generateFrontmatter({
		title: `Receipt: ${parsed.store}`,
		date: parsed.date,
		tags: ['food', 'receipt'],
		app: 'food',
	});
	await store.write(`receipts/${id}.yaml`, fm + stringify(receipt));

	// H10: Auto-update price store from receipt
	let priceUpdateMsg = '';
	try {
		const priceResult = await updatePricesFromReceipt(services, store, receipt);
		if (priceResult.updatedCount > 0 || priceResult.addedCount > 0) {
			const parts: string[] = [];
			if (priceResult.updatedCount > 0) parts.push(`updated ${priceResult.updatedCount}`);
			if (priceResult.addedCount > 0) parts.push(`added ${priceResult.addedCount} new`);
			priceUpdateMsg = `\n📊 Prices: ${parts.join(', ')} items`;
		}
	} catch (err) {
		services.logger.error('Failed to update prices from receipt: %s', err);
	}

	await services.telegram.send(
		ctx.userId,
		`🧾 Receipt captured!\n\n` +
		`**${parsed.store}** — ${parsed.date}\n` +
		`• ${parsed.lineItems.length} items\n` +
		`• Total: $${parsed.total.toFixed(2)}\n` +
		(parsed.tax != null ? `• Tax: $${parsed.tax.toFixed(2)}\n` : '') +
		priceUpdateMsg,
	);
}

async function handlePantryPhoto(
	services: CoreServices,
	ctx: PhotoContext,
	store: ReturnType<CoreServices['data']['forShared']>,
): Promise<void> {
	const items = await parsePantryFromPhoto(services, ctx.photo, ctx.mimeType);

	if (items.length === 0) {
		await services.telegram.send(
			ctx.userId,
			'I couldn\'t identify any food items in that photo. Try taking a clearer photo or manually add items with "add [items] to pantry".',
		);
		return;
	}

	// Add items to pantry
	const pantry = await loadPantry(store);
	const updated = addPantryItems(pantry, items);
	await savePantry(store, updated);

	const itemNames = items.map((i) => `• ${i.name} (${i.quantity})`).join('\n');
	await services.telegram.send(
		ctx.userId,
		`📸 Added ${items.length} items to pantry from photo:\n\n${itemNames}\n\n` +
		'Not quite right? Say "remove [item] from pantry" to fix.',
	);
}

async function handleGroceryPhoto(
	services: CoreServices,
	ctx: PhotoContext,
	store: ReturnType<CoreServices['data']['forShared']>,
): Promise<void> {
	const result = await parseGroceryFromPhoto(services, ctx.photo, ctx.mimeType, ctx.caption);

	if (result.items.length === 0) {
		await services.telegram.send(
			ctx.userId,
			'I couldn\'t extract any items from that photo. Try taking a clearer photo.',
		);
		return;
	}

	// Add items to grocery list
	let list = await loadGroceryList(store);
	if (!list) {
		list = createEmptyList();
	}

	const groceryItems = result.items.map((item) => ({
		name: item.name,
		quantity: item.quantity,
		unit: item.unit,
		department: 'other',
		recipeIds: [] as string[],
		purchased: false,
		addedBy: ctx.userId,
	}));

	list = addItems(list, groceryItems);
	await saveGroceryList(store, list);

	const itemNames = result.items.map((i) => `• ${i.name}${i.quantity ? ` (${i.quantity}${i.unit ? ' ' + i.unit : ''})` : ''}`).join('\n');
	let message = `🛒 Added ${result.items.length} items to grocery list from photo:\n\n${itemNames}`;

	if (result.isRecipe && result.parsedRecipe) {
		message += '\n\nThis looks like a recipe! I\'ll save it too.';
		const recipe = await saveRecipe(store, result.parsedRecipe, ctx.userId);
		message += `\n📖 Saved: **${recipe.title}** (draft)`;
	}

	await services.telegram.send(ctx.userId, message);
}
