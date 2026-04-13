/**
 * Pantry store — CRUD for household pantry inventory.
 *
 * Stored at `pantry.yaml` in shared scope.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { GroceryItem, PantryItem } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';
import { parseStrictInt } from '../utils/parse-int-strict.js';
import { sanitizeInput } from '../utils/sanitize.js';
import { normalizeIngredientName } from './ingredient-normalizer.js';
import { DEPARTMENT_EMOJI, assignDepartment } from './item-parser.js';

const PANTRY_PATH = 'pantry.yaml';

/** Department display order for pantry. */
const DEPT_ORDER = [
	'Produce',
	'Dairy & Eggs',
	'Meat & Seafood',
	'Bakery',
	'Frozen',
	'Pantry & Dry Goods',
	'Beverages',
	'Snacks',
	'Other',
];

/** Load the pantry, or empty array if none exists. */
export async function loadPantry(store: ScopedDataStore): Promise<PantryItem[]> {
	const raw = await store.read(PANTRY_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as PantryItem[];
		if (data && typeof data === 'object' && Array.isArray(data.items))
			return data.items as PantryItem[];
		return [];
	} catch {
		return [];
	}
}

/** Save the pantry. */
export async function savePantry(store: ScopedDataStore, items: PantryItem[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Pantry Inventory',
		date: isoNow(),
		tags: buildAppTags('food', 'pantry'),
		app: 'food',
		type: 'pantry',
	});
	await store.write(PANTRY_PATH, fm + stringify({ items }));
}

/**
 * Dedup key for pantry items. Prefers canonicalName (Phase H11.z); falls
 * back to lowercased name for legacy entries that predate normalization.
 */
function pantryDedupKey(item: PantryItem): string {
	return item.canonicalName ?? item.name.toLowerCase();
}

/**
 * Add items to pantry with dedup by canonical name (falls back to
 * case-insensitive name for legacy entries). New callers should pass
 * normalized items produced by `normalizePantryItems`.
 */
export function addPantryItems(existing: PantryItem[], newItems: PantryItem[]): PantryItem[] {
	const result = [...existing];
	for (const item of newItems) {
		const key = pantryDedupKey(item);
		const idx = result.findIndex((p) => pantryDedupKey(p) === key);
		if (idx >= 0) {
			// Update existing item
			const existing = result[idx];
			if (existing) result[idx] = { ...existing, ...item };
		} else {
			result.push(item);
		}
	}
	return result;
}

/**
 * Normalize a batch of pantry items — adds `canonicalName` in place by
 * running each item's name through the ingredient normalizer. Call this
 * before `addPantryItems` / `savePantry` so dedup and lookup work against
 * canonical forms. Items that already have a `canonicalName` are left
 * untouched.
 */
export async function normalizePantryItems(
	services: CoreServices,
	items: PantryItem[],
): Promise<PantryItem[]> {
	const result: PantryItem[] = [];
	for (const item of items) {
		if (item.canonicalName) {
			result.push(item);
			continue;
		}
		const { canonical, display } = await normalizeIngredientName(services, item.name);
		// Phase H11.z iteration 2: propagate the cleaned display form back to
		// `name` so user-facing surfaces (pantry list, reply text, grocery)
		// don't echo back raw qualifiers like "a potato" or "4 cups of salt".
		// Only rewrite when the cleaned display actually differs from the
		// original, so normal inputs like "Tomatoes" remain untouched.
		const cleanedName =
			display && display.toLowerCase() !== item.name.toLowerCase() ? display : item.name;
		result.push({
			...item,
			name: cleanedName,
			canonicalName: canonical || item.name.toLowerCase(),
		});
	}
	return result;
}

/** Remove a pantry item by name (case-insensitive). Returns updated list. */
export function removePantryItem(items: PantryItem[], name: string): PantryItem[] {
	return items.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
}

/**
 * Check if the pantry contains a specific ingredient.
 *
 * Phase H11.z: prefers canonical-name equality when both sides have it;
 * otherwise falls back to the legacy case-insensitive substring + 60%
 * length-ratio heuristic. The legacy path is retained so this function
 * continues to work against un-migrated data.
 *
 * Callers that already have a canonical form should pass it via the
 * optional second argument to avoid false positives from the legacy path.
 */
export function pantryContains(
	items: PantryItem[],
	ingredientName: string,
	ingredientCanonical?: string,
): boolean {
	if (ingredientCanonical) {
		// Tier 1 — canonical equality (exact match on both sides).
		for (const p of items) {
			if (p.canonicalName && p.canonicalName === ingredientCanonical) return true;
		}
		// Tier 2 — head-noun rescue (Phase H11.z iteration 2): one side's
		// canonical ends with " <other>" (leading space is required so that
		// "licorice" does NOT rescue-match "rice", and "potato" does not
		// match "tomato"). Bidirectional so either the pantry entry or the
		// query can be the more specific form.
		for (const p of items) {
			if (!p.canonicalName) continue;
			const pc = p.canonicalName;
			const ic = ingredientCanonical;
			if (pc.endsWith(` ${ic}`) || ic.endsWith(` ${pc}`)) return true;
		}
	}
	// Tier 3 — legacy case-insensitive substring path (60% length ratio to
	// avoid "oil" matching "olive oil" or "rice" matching "licorice"). Kept
	// as the last-resort rescue for un-migrated (canonical-less) data.
	const lower = ingredientName.toLowerCase();
	return items.some((p) => {
		const pLower = p.name.toLowerCase();
		if (pLower === lower) return true;
		const shorter = pLower.length <= lower.length ? pLower : lower;
		const longer = pLower.length > lower.length ? pLower : lower;
		if (!longer.includes(shorter)) return false;
		return shorter.length >= longer.length * 0.6;
	});
}

/**
 * Convert purchased grocery items to pantry items. Propagates
 * `canonicalName` from the grocery item when present (Phase H11.z) so
 * the caller can skip a second normalization pass.
 */
export function groceryToPantryItems(purchased: GroceryItem[], timezone: string): PantryItem[] {
	const date = todayDate(timezone);
	return purchased.map((item) => ({
		name: item.name,
		quantity: formatGroceryQty(item),
		addedDate: date,
		category: mapDepartmentToCategory(item.department),
		...(item.canonicalName ? { canonicalName: item.canonicalName } : {}),
	}));
}

/** Format grocery item quantity as freeform string for pantry. */
function formatGroceryQty(item: GroceryItem): string {
	if (item.quantity == null && !item.unit) return '1';
	const parts: string[] = [];
	if (item.quantity != null) parts.push(String(item.quantity));
	if (item.unit) parts.push(item.unit);
	return parts.join(' ') || '1';
}

/** Map grocery department to pantry category. */
function mapDepartmentToCategory(department: string): string {
	// Use the department directly as category (they overlap well)
	return department || 'Other';
}

/** Format the pantry for display. */
export function formatPantry(items: PantryItem[]): string {
	if (!items.length) return '📦 Your pantry is empty.';

	const lines: string[] = [`📦 Pantry (${items.length} items)\n`];

	// Group by category
	const groups = new Map<string, PantryItem[]>();
	for (const item of items) {
		const cat = item.category || 'Other';
		const group = groups.get(cat) ?? [];
		group.push(item);
		groups.set(cat, group);
	}

	for (const dept of DEPT_ORDER) {
		const deptItems = groups.get(dept);
		if (!deptItems?.length) continue;

		const emoji = DEPARTMENT_EMOJI[dept] ?? '📦';
		lines.push(`${emoji} *${escapeMarkdown(dept)}*`);
		for (const item of deptItems) {
			lines.push(`• ${escapeMarkdown(item.name)} — ${escapeMarkdown(item.quantity)}`);
		}
		lines.push('');
	}

	// Show any categories not in the standard order
	for (const [cat, catItems] of groups) {
		if (DEPT_ORDER.includes(cat)) continue;
		lines.push(`📦 *${escapeMarkdown(cat)}*`);
		for (const item of catItems) {
			lines.push(`• ${escapeMarkdown(item.name)} — ${escapeMarkdown(item.quantity)}`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

/** Perishable categories that should get LLM-estimated expiry. */
const PERISHABLE_CATEGORIES = new Set(['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery']);

/** Check if a pantry item's category is perishable. */
export function isPerishableCategory(category: string): boolean {
	return PERISHABLE_CATEGORIES.has(category);
}

/**
 * Enrich perishable pantry items with LLM-estimated expiry dates.
 * Only estimates for items that don't already have an expiryEstimate
 * and are in perishable categories.
 */
export async function enrichWithExpiry(
	services: {
		llm: {
			complete: (
				prompt: string,
				opts: { tier: 'fast' | 'standard' | 'reasoning' },
			) => Promise<string>;
		};
		timezone: string;
	},
	items: PantryItem[],
): Promise<PantryItem[]> {
	const result = [...items];
	for (let i = 0; i < result.length; i++) {
		const item = result[i]!;
		if (item.expiryEstimate || !isPerishableCategory(item.category)) continue;

		try {
			const daysStr = await services.llm.complete(
				`How many days does ${sanitizeInput(item.name)} last in the fridge after purchase? Reply with just a number.`,
				{ tier: 'fast' },
			);
			const parsed = parseStrictInt(daysStr.trim());
			if (parsed !== null && parsed > 0) {
				const cappedDays = Math.min(parsed, 365);
				const expiry = new Date(`${item.addedDate}T00:00:00Z`);
				expiry.setUTCDate(expiry.getUTCDate() + cappedDays);
				result[i] = { ...item, expiryEstimate: expiry.toISOString().slice(0, 10) };
			}
		} catch {
			// Skip estimation on failure — item remains without expiryEstimate
		}
	}
	return result;
}

/** Regex to extract quantity+unit prefix from pantry items. */
const PANTRY_QTY_REGEX =
	/^(\d+(?:\.\d+)?)\s*(lbs?|oz|cups?|tbsp|tsp|dozen|cans?|bunch(?:es)?|bags?|boxes?|bottles?|packs?|pieces?|heads?|stalks?|cloves?|sticks?|jars?|containers?)?\s*/i;

/**
 * Parse free-text pantry items (e.g., "2 dozen eggs, milk, 3 lbs chicken").
 * Extracts quantity+unit when present (e.g., "2 dozen eggs" → name "eggs", quantity "2 dozen").
 */
export function parsePantryItems(text: string, timezone: string): PantryItem[] {
	const parts = text
		.split(/,|\band\b|\n/i)
		.map((s) => s.trim())
		.filter(Boolean);

	const date = todayDate(timezone);
	return parts.map((part) => {
		const match = part.match(PANTRY_QTY_REGEX);
		if (match?.[0]?.trim()) {
			const qty = match[1] ?? '';
			const unit = match[2] ?? '';
			const name = part.slice(match[0].length).trim();
			if (name) {
				return {
					name,
					quantity: [qty, unit].filter(Boolean).join(' ') || '1',
					addedDate: date,
					category: assignDepartment(name),
				};
			}
		}
		return {
			name: part,
			quantity: '1',
			addedDate: date,
			category: assignDepartment(part),
		};
	});
}
