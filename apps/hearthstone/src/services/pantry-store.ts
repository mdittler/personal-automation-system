/**
 * Pantry store — CRUD for household pantry inventory.
 *
 * Stored at `pantry.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { GroceryItem, PantryItem } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';
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
		tags: buildAppTags('hearthstone', 'pantry'),
		app: 'hearthstone',
	});
	await store.write(PANTRY_PATH, fm + stringify({ items }));
}

/** Add items to pantry with dedup by name (case-insensitive). */
export function addPantryItems(existing: PantryItem[], newItems: PantryItem[]): PantryItem[] {
	const result = [...existing];
	for (const item of newItems) {
		const idx = result.findIndex((p) => p.name.toLowerCase() === item.name.toLowerCase());
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

/** Remove a pantry item by name (case-insensitive). Returns updated list. */
export function removePantryItem(items: PantryItem[], name: string): PantryItem[] {
	return items.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
}

/**
 * Check if the pantry contains a specific ingredient (case-insensitive).
 * Uses word-boundary-aware matching: the shorter string must be at least
 * 60% the length of the longer one to avoid false positives like
 * "oil" matching "olive oil" or "rice" matching "licorice".
 */
export function pantryContains(items: PantryItem[], ingredientName: string): boolean {
	const lower = ingredientName.toLowerCase();
	return items.some((p) => {
		const pLower = p.name.toLowerCase();
		// Exact match
		if (pLower === lower) return true;
		// Substring match with minimum length ratio to avoid false positives
		const shorter = pLower.length <= lower.length ? pLower : lower;
		const longer = pLower.length > lower.length ? pLower : lower;
		if (!longer.includes(shorter)) return false;
		return shorter.length >= longer.length * 0.6;
	});
}

/** Convert purchased grocery items to pantry items. */
export function groceryToPantryItems(purchased: GroceryItem[], timezone: string): PantryItem[] {
	const date = todayDate(timezone);
	return purchased.map((item) => ({
		name: item.name,
		quantity: formatGroceryQty(item),
		addedDate: date,
		category: mapDepartmentToCategory(item.department),
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
		lines.push(`${emoji} *${dept}*`);
		for (const item of deptItems) {
			lines.push(`• ${item.name} — ${item.quantity}`);
		}
		lines.push('');
	}

	// Show any categories not in the standard order
	for (const [cat, catItems] of groups) {
		if (DEPT_ORDER.includes(cat)) continue;
		lines.push(`📦 *${cat}*`);
		for (const item of catItems) {
			lines.push(`• ${item.name} — ${item.quantity}`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

/** Perishable categories that should get LLM-estimated expiry. */
const PERISHABLE_CATEGORIES = new Set([
	'Produce',
	'Dairy & Eggs',
	'Meat & Seafood',
	'Bakery',
]);

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
	services: { llm: { complete: (prompt: string, opts: { tier: 'fast' | 'standard' | 'reasoning' }) => Promise<string> }; timezone: string },
	items: PantryItem[],
): Promise<PantryItem[]> {
	const result = [...items];
	for (let i = 0; i < result.length; i++) {
		const item = result[i]!;
		if (item.expiryEstimate || !isPerishableCategory(item.category)) continue;

		try {
			const daysStr = await services.llm.complete(
				`How many days does ${item.name} last in the fridge after purchase? Reply with just a number.`,
				{ tier: 'fast' },
			);
			const days = Number.parseInt(daysStr.trim(), 10);
			if (!Number.isNaN(days) && days > 0) {
				const expiry = new Date(`${item.addedDate}T00:00:00Z`);
				expiry.setUTCDate(expiry.getUTCDate() + days);
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
