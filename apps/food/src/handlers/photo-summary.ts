/**
 * Photo-summary composers.
 *
 * Build sanitized PhotoSummary values from parsed photo data.
 * Each summary becomes an assistant-role transcript turn so it must be
 * free of control characters, zero-width/bidi chars, and prompt-fence tags.
 *
 * The actual sanitizer lives in core (shared with the app-message bridge);
 * we re-export it under the legacy name `sanitizePhotoField` so existing
 * imports keep working.
 */

import type { ParsedReceipt } from '../services/receipt-parser.js';
import type { ReceiptLineItem } from '../types.js';
import type { PhotoSummary } from '@pas/core/types';
import { sanitizeAppMessageField } from '../../../../core/src/services/app-outbound-bridge/sanitize.js';

export {
	sanitizeAppMessageField as sanitizePhotoField,
	MAX_FIELD_LEN,
} from '../../../../core/src/services/app-outbound-bridge/sanitize.js';

// Photo OCR fields are short; pass this explicit cap to the shared sanitizer.
// (The core sanitizer's own default — MAX_FIELD_LEN=500 — is sized for full
// app-message bodies, not the per-field OCR snippets used by the composers.)
const PHOTO_FIELD_LEN = 80;
const MAX_STORE_LEN = 100;
const MAX_TOP_ITEMS = 30;

export function buildReceiptSummary(parsed: ParsedReceipt): PhotoSummary {
	const store = sanitizeAppMessageField(parsed.store, MAX_STORE_LEN) || 'Unknown store';
	const date = sanitizeAppMessageField(parsed.date, 10);
	const itemCount = parsed.lineItems.length;
	const total = Number.isFinite(parsed.total) ? parsed.total : 0;

	const itemsToShow = parsed.lineItems.slice(0, MAX_TOP_ITEMS);
	const remainingCount = parsed.lineItems.length - itemsToShow.length;
	const topItems = itemsToShow
		.map((item: ReceiptLineItem) => {
			const name = sanitizeAppMessageField(item.name, PHOTO_FIELD_LEN);
			const price = Number.isFinite(item.totalPrice) ? ` — $${item.totalPrice.toFixed(2)}` : '';
			return `- ${name}${price}`;
		})
		.join('\n');
	const moreMarker =
		remainingCount > 0
			? `\n… and ${remainingCount} more (say "show all items" to see the rest)`
			: '';

	const parts = [
		`🧾 Receipt captured: ${store} — ${date}`,
		`${itemCount} items, total $${total.toFixed(2)}`,
	];
	if (topItems) parts.push(`Items:\n${topItems}${moreMarker}`);

	return { userTurn: '[Photo: receipt]', assistantTurn: parts.join('\n') };
}

export function buildRecipeSummary(title: string, ingredientCount: number, stepCount: number): PhotoSummary {
	const safeTitle = sanitizeAppMessageField(title, 100) || 'Unknown recipe';
	return {
		userTurn: '[Photo: recipe]',
		assistantTurn: `📖 Recipe saved: ${safeTitle} — ${ingredientCount} ingredients, ${stepCount} steps`,
	};
}

export function buildPantrySummary(items: Array<{ name: string; quantity: string }>): PhotoSummary {
	const count = items.length;
	const itemList = items.slice(0, 10)
		.map((i) => `- ${sanitizeAppMessageField(i.name, PHOTO_FIELD_LEN)} (${sanitizeAppMessageField(i.quantity, 20)})`)
		.join('\n');
	return {
		userTurn: '[Photo: pantry]',
		assistantTurn: `📸 Pantry updated: added ${count} items${itemList ? '\n' + itemList : ''}`,
	};
}

export function buildGrocerySummary(
	itemCount: number,
	items: Array<{ name: string; quantity?: number | null; unit?: string | null }>,
	isRecipe: boolean,
	recipeTitle?: string,
): PhotoSummary {
	const itemList = items.slice(0, 10)
		.map((i) => `- ${sanitizeAppMessageField(i.name, PHOTO_FIELD_LEN)}`)
		.join('\n');
	let assistantTurn = `🛒 Grocery list updated: added ${itemCount} items${itemList ? '\n' + itemList : ''}`;
	if (isRecipe && recipeTitle) {
		assistantTurn += `\n📖 Also saved as recipe: ${sanitizeAppMessageField(recipeTitle, 100)}`;
	}
	return {
		userTurn: isRecipe ? '[Photo: recipe]' : '[Photo: grocery list]',
		assistantTurn,
	};
}
