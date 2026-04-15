/**
 * Grocery list store — CRUD, formatting, and inline button generation.
 *
 * Active list stored at `grocery/active.yaml` in shared scope.
 * Purchase history archived to `grocery/history/YYYY-MM-DD.yaml`.
 */

import type { InlineButton, ScopedDataStore } from '@pas/core/types';
import { withFileLock } from '@pas/core/utils/file-mutex';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { GroceryItem, GroceryList } from '../types.js';
import { generateId, isoNow, todayDate } from '../utils/date.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';
import { DEPARTMENT_EMOJI } from './item-parser.js';

const ACTIVE_PATH = 'grocery/active.yaml';
const HISTORY_DIR = 'grocery/history';

/** Acquire the grocery list lock for a read-modify-write sequence. */
export function withGroceryLock<T>(fn: () => Promise<T>): Promise<T> {
	return withFileLock(ACTIVE_PATH, fn);
}

/** Department display order. */
const DEPT_ORDER = [
	'Produce',
	'Dairy & Eggs',
	'Meat & Seafood',
	'Bakery',
	'Frozen',
	'Pantry & Dry Goods',
	'Beverages',
	'Snacks',
	'Household',
	'Other',
];

/** Load the active grocery list, or null if none exists. */
export async function loadGroceryList(store: ScopedDataStore): Promise<GroceryList | null> {
	const raw = await store.read(ACTIVE_PATH);
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as GroceryList;
	} catch {
		return null;
	}
}

/** Save the active grocery list. */
export async function saveGroceryList(store: ScopedDataStore, list: GroceryList): Promise<void> {
	list.updatedAt = isoNow();
	const fm = generateFrontmatter({
		title: 'Grocery List',
		date: list.createdAt,
		tags: buildAppTags('food', 'grocery'),
		type: 'grocery-list',
		app: 'food',
	});
	await store.write(ACTIVE_PATH, fm + stringify(list));
}

/** Create an empty grocery list. */
export function createEmptyList(): GroceryList {
	const now = isoNow();
	return {
		id: generateId(),
		items: [],
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Add items to the list with exact-match dedup.
 * If an item with the same lowercase name exists, merge quantities.
 */
export function addItems(list: GroceryList, items: GroceryItem[]): GroceryList {
	for (const newItem of items) {
		const existing = list.items.find((i) => i.name.toLowerCase() === newItem.name.toLowerCase());
		if (existing) {
			// Merge quantities if same unit
			if (existing.unit === newItem.unit && existing.quantity != null && newItem.quantity != null) {
				existing.quantity += newItem.quantity;
			}
			// Merge recipe IDs
			for (const rid of newItem.recipeIds) {
				if (!existing.recipeIds.includes(rid)) {
					existing.recipeIds.push(rid);
				}
			}
			// Reset purchased if re-added
			existing.purchased = false;
		} else {
			list.items.push({ ...newItem });
		}
	}
	return list;
}

/** Toggle the purchased status of an item by index. */
export function togglePurchased(list: GroceryList, index: number): GroceryList {
	const item = list.items[index];
	if (item) {
		item.purchased = !item.purchased;
	}
	return list;
}

/** Remove all purchased items from the list and return them. */
export function clearPurchased(list: GroceryList): {
	updated: GroceryList;
	purchased: GroceryItem[];
} {
	const purchased = list.items.filter((i) => i.purchased);
	list.items = list.items.filter((i) => !i.purchased);
	return { updated: list, purchased };
}

/** Archive purchased items to history. Merges with existing same-day history. */
export async function archivePurchased(
	store: ScopedDataStore,
	items: GroceryItem[],
	timezone: string,
): Promise<void> {
	// Must be called from within withGroceryLock to prevent concurrent same-day races.
	if (!items.length) return;
	const date = todayDate(timezone);
	const path = `${HISTORY_DIR}/${date}.yaml`;

	// Merge with existing history for the same day (prevents overwrite on second clear)
	let merged = items;
	const existing = await store.read(path);
	if (existing) {
		try {
			const content = stripFrontmatter(existing);
			const data = parse(content) as { items?: GroceryItem[] };
			if (data?.items && Array.isArray(data.items)) {
				merged = [...data.items, ...items];
			}
		} catch {
			// Corrupt history — overwrite with new items only
		}
	}

	const fm = generateFrontmatter({
		title: `Grocery History — ${date}`,
		date: isoNow(),
		tags: buildAppTags('food', 'grocery-history'),
		type: 'grocery-history',
		app: 'food',
	});
	await store.write(path, fm + stringify({ date, items: merged }));
}

/** Format the grocery list as a department-grouped message. */
export function formatGroceryMessage(list: GroceryList): string {
	if (!list.items.length) return '🛒 Your grocery list is empty.';

	const total = list.items.length;
	const purchased = list.items.filter((i) => i.purchased).length;
	const lines: string[] = [
		`🛒 Grocery List (${total} items${purchased > 0 ? `, ${purchased} purchased` : ''})\n`,
	];

	// Group by department
	const groups = new Map<string, GroceryItem[]>();
	for (const item of list.items) {
		const dept = item.department || 'Other';
		const group = groups.get(dept) ?? [];
		group.push(item);
		groups.set(dept, group);
	}

	// Display in department order
	for (const dept of DEPT_ORDER) {
		const items = groups.get(dept);
		if (!items?.length) continue;

		const emoji = DEPARTMENT_EMOJI[dept] ?? '📦';
		lines.push(`${emoji} *${escapeMarkdown(dept)}*`);
		for (const item of items) {
			const check = item.purchased ? '✅' : '☐';
			const qty = formatItemQty(item);
			lines.push(`${check} ${escapeMarkdown(item.name)}${qty}`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

/** Format item quantity for display. */
function formatItemQty(item: GroceryItem): string {
	if (item.quantity == null && !item.unit) return '';
	const parts: string[] = [];
	if (item.quantity != null) parts.push(String(item.quantity));
	if (item.unit) parts.push(escapeMarkdown(item.unit));
	return parts.length ? ` — ${parts.join(' ')}` : '';
}

/**
 * Build inline keyboard buttons for the grocery list.
 * One toggle button per item, plus a control row at the bottom.
 */
export function buildGroceryButtons(list: GroceryList, appId = 'food'): InlineButton[][] {
	const buttons: InlineButton[][] = [];

	for (let i = 0; i < list.items.length; i++) {
		const item = list.items[i];
		if (!item) continue;
		const check = item.purchased ? '✅' : '☐';
		const label = `${check} ${item.name}`;
		buttons.push([
			{
				text: label,
				callbackData: `app:${appId}:toggle:${i}`,
			},
		]);
	}

	// Control row
	const controlRow: InlineButton[] = [
		{ text: '🔄 Refresh', callbackData: `app:${appId}:refresh` },
		{ text: '🗑 Clear ✅', callbackData: `app:${appId}:clear` },
		{ text: '📦 → Pantry', callbackData: `app:${appId}:pantry-prompt` },
	];
	buttons.push(controlRow);

	return buttons;
}
