/**
 * Photo handler — dispatches incoming photos to the appropriate parser.
 *
 * Routes by caption keyword first, falls back to LLM vision classification.
 */

import type { CoreServices, PhotoContext, PhotoHandlerResult } from '@pas/core/types';
import { stringify } from 'yaml';
import { generateFrontmatter } from '@pas/core/utils/frontmatter';
import { savePhoto } from '../services/photo-store.js';
import { parseRecipeFromPhoto } from '../services/recipe-photo-parser.js';
import { parseReceiptFromPhoto } from '../services/receipt-parser.js';
import { parsePantryFromPhoto } from '../services/pantry-photo-parser.js';
import { parseGroceryFromPhoto } from '../services/grocery-photo-parser.js';
import { saveRecipe, updateRecipe } from '../services/recipe-store.js';
import {
	addPantryItems,
	loadPantry,
	normalizePantryItems,
	savePantry,
	withPantryLock,
} from '../services/pantry-store.js';
import { addItems, loadGroceryList, saveGroceryList, createEmptyList, withGroceryLock } from '../services/grocery-store.js';
import { isoNow } from '../utils/date.js';
import type { Receipt } from '../types.js';
import { updatePricesFromReceipt } from '../services/price-store.js';
import {
	resolveFoodStore,
	type ResolvedFoodStore,
} from '../utils/household-guard.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';

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

	// F16: require exact single-token match; reject negated or verbose responses
	const VALID_PHOTO_TYPES = new Set<PhotoType>(['recipe', 'receipt', 'pantry', 'grocery']);
	const normalized = result.trim().toLowerCase().replace(/[^a-z]/g, '');
	return VALID_PHOTO_TYPES.has(normalized as PhotoType) ? (normalized as PhotoType) : null;
}

function buildScopedFoodPath(resolved: ResolvedFoodStore, relativePath: string): string {
	if (resolved.scope === 'space') {
		return `spaces/${resolved.spaceId}/food/${relativePath}`;
	}
	return `users/shared/food/${relativePath}`;
}

// ─── Main handler ───────────────────────────────────────────────

export async function handlePhoto(
	services: CoreServices,
	ctx: PhotoContext,
): Promise<void | PhotoHandlerResult> {
	try {
		// F15: require household membership before any LLM call or store write
		const resolved = await resolveFoodStore(services, ctx.userId, ctx.spaceId);
		if (!resolved) {
			await services.telegram.send(
				ctx.userId,
				'You need to set up or join a household before using photo features. ' +
				'Use /household to get started.',
			);
			return;
		}

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

		switch (photoType) {
			case 'recipe':
				await handleRecipePhoto(services, ctx, resolved);
				break;
			case 'receipt':
				await handleReceiptPhoto(services, ctx, resolved);
				break;
			case 'pantry':
				// Review Phase 7 intentionally leaves pantry photos shared-only.
				await handlePantryPhoto(services, ctx, services.data.forShared('shared'));
				break;
			case 'grocery':
				await handleGroceryPhoto(services, ctx, resolved);
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
	resolved: ResolvedFoodStore,
): Promise<void> {
	const store = resolved.store;
	const parsed = await parseRecipeFromPhoto(services, ctx.photo, ctx.mimeType, ctx.caption);

	// Save photo
	const photoPath = await savePhoto(store, ctx.photo, 'recipe');

	// Save recipe
	const recipe = await saveRecipe(store, parsed, ctx.userId);

	// Update recipe with photo path
	recipe.sourcePhoto = photoPath;
	await updateRecipe(store, recipe);

	// Record the interaction after successful write
	services.interactionContext?.record(ctx.userId, {
		appId: 'food',
		action: 'recipe_saved',
		entityType: 'recipe',
		entityId: recipe.id,
		filePaths: [buildScopedFoodPath(resolved, `recipes/${recipe.id}.yaml`)],
		scope: resolved.scope,
	});

	await services.telegram.send(
		ctx.userId,
		`📷 Recipe saved from photo!\n\n*${escapeMarkdown(recipe.title)}*\n` +
		`• ${recipe.ingredients.length} ingredients\n` +
		`• ${recipe.instructions.length} steps\n` +
		`• Servings: ${recipe.servings}\n` +
		(recipe.cuisine ? `• Cuisine: ${escapeMarkdown(recipe.cuisine)}\n` : '') +
		`\nStatus: draft (will be confirmed after you cook and rate it)`,
	);
}

async function handleReceiptPhoto(
	services: CoreServices,
	ctx: PhotoContext,
	resolved: ResolvedFoodStore,
): Promise<void> {
	const store = resolved.store;
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
		type: 'receipt',
		entity_keys: [parsed.store.toLowerCase()],
		app: 'food',
	});
	await store.write(`receipts/${id}.yaml`, fm + stringify(receipt));

	// Record the interaction after successful write
	services.interactionContext?.record(ctx.userId, {
		appId: 'food',
		action: 'receipt_captured',
		entityType: 'receipt',
		entityId: id,
		filePaths: [buildScopedFoodPath(resolved, `receipts/${id}.yaml`)],
		scope: resolved.scope,
	});

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
		`*${escapeMarkdown(parsed.store)}* — ${escapeMarkdown(parsed.date)}\n` +
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

	// H11.z: normalize canonical names before dedup + save.
	// LLM normalization outside lock.
	const normalized = await normalizePantryItems(services, items);
	await withPantryLock(async () => {
		const pantry = await loadPantry(store);
		const updated = addPantryItems(pantry, normalized);
		await savePantry(store, updated);
	});

	const itemNames = items.map((i) => `• ${escapeMarkdown(i.name)} (${escapeMarkdown(i.quantity)})`).join('\n');
	await services.telegram.send(
		ctx.userId,
		`📸 Added ${items.length} items to pantry from photo:\n\n${itemNames}\n\n` +
		'Not quite right? Say "remove [item] from pantry" to fix.',
	);
}

async function handleGroceryPhoto(
	services: CoreServices,
	ctx: PhotoContext,
	resolved: ResolvedFoodStore,
): Promise<void> {
	const store = resolved.store;
	const result = await parseGroceryFromPhoto(services, ctx.photo, ctx.mimeType, ctx.caption);

	if (result.items.length === 0) {
		await services.telegram.send(
			ctx.userId,
			'I couldn\'t extract any items from that photo. Try taking a clearer photo.',
		);
		return;
	}

	// Add items to grocery list
	const groceryItems = result.items.map((item) => ({
		name: item.name,
		quantity: item.quantity,
		unit: item.unit,
		department: 'other',
		recipeIds: [] as string[],
		purchased: false,
		addedBy: ctx.userId,
	}));

	try {
		await withGroceryLock(async () => {
			let list = await loadGroceryList(store);
			if (!list) {
				list = createEmptyList();
			}
			list = addItems(list, groceryItems);
			await saveGroceryList(store, list);
		});
	} catch (err) {
		services.logger.error('Failed to save grocery list from photo: %s', err);
		await services.telegram.send(ctx.userId, '⚠️ I recognised the items but couldn\'t save the grocery list. Please try again.');
		return;
	}

	// Record the interaction after successful write
	services.interactionContext?.record(ctx.userId, {
		appId: 'food',
		action: 'grocery_updated',
		entityType: 'grocery-list',
		filePaths: [buildScopedFoodPath(resolved, 'grocery/active.yaml')],
		scope: resolved.scope,
	});

	const itemNames = result.items.map((i) => {
		const qty = i.quantity != null ? ` (${i.quantity}${i.unit ? ' ' + escapeMarkdown(i.unit) : ''})` : '';
		return `• ${escapeMarkdown(i.name)}${qty}`;
	}).join('\n');
	let message = `🛒 Added ${result.items.length} items to grocery list from photo:\n\n${itemNames}`;

	// F19: validate recipe shape before saveRecipe() to prevent partial side effects
	if (result.isRecipe && result.parsedRecipe) {
		const pr = result.parsedRecipe;
		const recipeValid = pr.title?.trim() &&
			Array.isArray(pr.ingredients) && pr.ingredients.length > 0 &&
			Array.isArray(pr.instructions) && pr.instructions.length > 0;

		if (recipeValid) {
			try {
				const recipe = await saveRecipe(store, pr, ctx.userId);
				message += `\n\n📖 Also saved as recipe: *${escapeMarkdown(recipe.title)}* (draft)`;
			} catch (err) {
				services.logger.error('Failed to save recipe from grocery photo: %s', err);
				message += '\n\n⚠️ I spotted a recipe but couldn\'t save it completely.';
			}
		} else {
			message += '\n\n⚠️ I spotted a recipe but couldn\'t parse it completely.';
		}
	}

	await services.telegram.send(ctx.userId, message);
}
