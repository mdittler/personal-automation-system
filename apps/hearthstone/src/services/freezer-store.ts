/**
 * Freezer store — CRUD for household freezer inventory.
 *
 * Stored at `freezer.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { FreezerItem } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';

const FREEZER_PATH = 'freezer.yaml';

/** Regex to extract quantity+unit prefix from freezer item text. */
const FREEZER_QTY_REGEX =
	/^(\d+(?:\.\d+)?)\s*(lbs?|oz|cups?|servings?|containers?|bags?|pieces?|portions?|slices?|loaves?|loaf)\s+/i;

/** Months threshold for age warning display. */
const AGE_WARNING_MONTHS = 3;

/** Load the freezer inventory, or empty array if none exists. */
export async function loadFreezer(store: ScopedDataStore): Promise<FreezerItem[]> {
	const raw = await store.read(FREEZER_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as FreezerItem[];
		if (data && typeof data === 'object' && Array.isArray(data.items))
			return data.items as FreezerItem[];
		return [];
	} catch {
		return [];
	}
}

/** Save the freezer inventory. */
export async function saveFreezer(store: ScopedDataStore, items: FreezerItem[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Freezer Inventory',
		date: isoNow(),
		tags: buildAppTags('hearthstone', 'freezer'),
		app: 'hearthstone',
	});
	await store.write(FREEZER_PATH, fm + stringify({ items }));
}

/** Add a freezer item, deduplicating by name (case-insensitive). */
export function addFreezerItem(existing: FreezerItem[], item: FreezerItem): FreezerItem[] {
	const result = [...existing];
	const idx = result.findIndex((f) => f.name.toLowerCase() === item.name.toLowerCase());
	if (idx >= 0) {
		const found = result[idx];
		if (found) result[idx] = { ...found, ...item };
	} else {
		result.push(item);
	}
	return result;
}

/** Remove a freezer item by index. Returns updated list. */
export function removeFreezerItem(items: FreezerItem[], index: number): FreezerItem[] {
	if (index < 0 || index >= items.length) return [...items];
	return items.filter((_, i) => i !== index);
}

/**
 * Get freezer items that were frozen more than N months ago.
 * Uses simple calendar-month arithmetic on YYYY-MM-DD date strings.
 */
export function getAgingFreezerItems(
	items: FreezerItem[],
	olderThanMonths: number,
	today: string,
): FreezerItem[] {
	const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
	return items.filter((item) => {
		const [fy, fm, fd] = item.frozenDate.split('-').map(Number) as [number, number, number];
		// Calculate whole months elapsed
		const wholeMonths = (ty - fy) * 12 + (tm - fm);
		if (wholeMonths > olderThanMonths) return true;
		if (wholeMonths < olderThanMonths) return false;
		// wholeMonths === olderThanMonths: include only if the day-of-month has advanced past frozen day
		return td > fd;
	});
}

/** Format the freezer inventory for display. */
export function formatFreezerList(items: FreezerItem[], today?: string): string {
	if (!items.length) return '🧊 Your freezer is empty.';

	const lines: string[] = [`🧊 Freezer (${items.length} items)\n`];

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const ageWarning = today ? isOlderThan(item.frozenDate, AGE_WARNING_MONTHS, today) : false;
		const warning = ageWarning ? ' ⚠️' : '';
		const sourceStr = item.source ? ` — ${item.source}` : '';
		lines.push(`${i + 1}. ${item.name} (${item.quantity})${sourceStr} — frozen ${item.frozenDate}${warning}`);
	}

	return lines.join('\n').trimEnd();
}

/** Check if a frozen date is at least N months old (inclusive of exact boundary). */
function isOlderThan(frozenDate: string, months: number, today: string): boolean {
	const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
	const [fy, fm, fd] = frozenDate.split('-').map(Number) as [number, number, number];
	const wholeMonths = (ty - fy) * 12 + (tm - fm);
	if (wholeMonths > months) return true;
	if (wholeMonths < months) return false;
	// Exactly N whole months: include if today's day >= frozen day (same day or later)
	return td >= fd;
}

/** Build inline keyboard buttons for the freezer list. */
export function buildFreezerButtons(
	items: FreezerItem[],
): Array<Array<{ text: string; callbackData: string }>> {
	const rows: Array<Array<{ text: string; callbackData: string }>> = [];

	// Add button always appears first
	rows.push([{ text: '➕ Add to Freezer', callbackData: 'app:hearthstone:fz:add' }]);

	// Per-item Thaw / Toss buttons
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const enc = encodeURIComponent(item.name);
		rows.push([
			{ text: `🫧 Thaw: ${item.name}`, callbackData: `app:hearthstone:fz:thaw:${i}:${enc}` },
			{ text: `🗑️ Toss: ${item.name}`, callbackData: `app:hearthstone:fz:toss:${i}:${enc}` },
		]);
	}

	return rows;
}

/**
 * Parse free-text freezer item input.
 * Extracts quantity+unit when present (e.g., "2 lbs chicken breasts" → quantity "2 lbs", name "chicken breasts").
 * Defaults to "some" when no quantity prefix is found.
 */
export function parseFreezerInput(
	text: string,
	source: string | undefined,
	timezone: string,
): FreezerItem {
	const frozenDate = todayDate(timezone);
	const match = text.match(FREEZER_QTY_REGEX);

	if (match?.[0]?.trim()) {
		const qty = match[1] ?? '';
		const unit = match[2] ?? '';
		const name = text.slice(match[0].length).trim();
		if (name) {
			return {
				name,
				quantity: [qty, unit].filter(Boolean).join(' '),
				frozenDate,
				source,
			};
		}
	}

	return {
		name: text.trim(),
		quantity: 'some',
		frozenDate,
		source,
	};
}
