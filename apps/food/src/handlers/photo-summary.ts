/**
 * Photo-summary composers.
 *
 * Build sanitized PhotoSummary values from parsed photo data.
 * Each summary becomes an assistant-role transcript turn so it must be
 * free of control characters, zero-width/bidi chars, and prompt-fence tags.
 */

import type { ParsedReceipt } from '../services/receipt-parser.js';
import type { ReceiptLineItem } from '../types.js';
import type { PhotoSummary } from '@pas/core/types';

const MAX_FIELD_LEN = 80;
const MAX_STORE_LEN = 100;
const MAX_TOP_ITEMS = 10;

/**
 * Strip control chars, zero-width/bidi chars, and prompt-fence-like tags.
 * Collapses whitespace and truncates. Used on every OCR-extracted field
 * that ends up in an assistant-role transcript turn.
 */
export function sanitizePhotoField(input: string | undefined | null, maxLen = MAX_FIELD_LEN): string {
	if (!input) return '';
	let s = String(input);
	// Strip ASCII control chars (0x00–0x1f, 0x7f)
	s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
	// Strip Unicode zero-width / bidi / BOM chars.
	// U+200B–U+200F: zero-width space through RLM
	// U+202A–U+202E: LRE through RLO
	// U+2060–U+2069: word-joiner through bidi isolate controls (LRI/RLI/FSI/PDI)
	// U+FEFF: BOM / ZWNBSP
	s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
	// Neutralize prompt-fence-like XML tags (including close tags)
	s = s.replace(/<\/?(system|assistant|user|content|memory-context|memory-snapshot)[^>]*>/gi, '');
	// Collapse whitespace
	s = s.replace(/\s+/g, ' ').trim();
	if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
	return s;
}

export function buildReceiptSummary(parsed: ParsedReceipt): PhotoSummary {
	const store = sanitizePhotoField(parsed.store, MAX_STORE_LEN) || 'Unknown store';
	const date = sanitizePhotoField(parsed.date, 10);
	const itemCount = parsed.lineItems.length;
	const total = Number.isFinite(parsed.total) ? parsed.total : 0;

	const topItems = parsed.lineItems
		.slice(0, MAX_TOP_ITEMS)
		.map((item: ReceiptLineItem) => {
			const name = sanitizePhotoField(item.name);
			const price = Number.isFinite(item.totalPrice) ? ` — $${item.totalPrice.toFixed(2)}` : '';
			return `- ${name}${price}`;
		})
		.join('\n');

	const parts = [
		`🧾 Receipt captured: ${store} — ${date}`,
		`${itemCount} items, total $${total.toFixed(2)}`,
	];
	if (topItems) parts.push(`Items:\n${topItems}`);

	return { userTurn: '[Photo: receipt]', assistantTurn: parts.join('\n') };
}

export function buildRecipeSummary(title: string, ingredientCount: number, stepCount: number): PhotoSummary {
	const safeTitle = sanitizePhotoField(title, 100) || 'Unknown recipe';
	return {
		userTurn: '[Photo: recipe]',
		assistantTurn: `📖 Recipe saved: ${safeTitle} — ${ingredientCount} ingredients, ${stepCount} steps`,
	};
}

export function buildPantrySummary(items: Array<{ name: string; quantity: string }>): PhotoSummary {
	const count = items.length;
	const itemList = items.slice(0, 10)
		.map((i) => `- ${sanitizePhotoField(i.name)} (${sanitizePhotoField(i.quantity, 20)})`)
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
		.map((i) => `- ${sanitizePhotoField(i.name)}`)
		.join('\n');
	let assistantTurn = `🛒 Grocery list updated: added ${itemCount} items${itemList ? '\n' + itemList : ''}`;
	if (isRecipe && recipeTitle) {
		assistantTurn += `\n📖 Also saved as recipe: ${sanitizePhotoField(recipeTitle, 100)}`;
	}
	return {
		userTurn: isRecipe ? '[Photo: recipe]' : '[Photo: grocery list]',
		assistantTurn,
	};
}
