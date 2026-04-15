/**
 * Leftover store — CRUD for household leftover tracking.
 *
 * Stored at `leftovers.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { withFileLock } from '@pas/core/utils/file-mutex';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { Leftover } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';

const LEFTOVERS_PATH = 'leftovers.yaml';

/** Acquire the leftovers lock for a read-modify-write sequence. */
export function withLeftoverLock<T>(fn: () => Promise<T>): Promise<T> {
	return withFileLock(LEFTOVERS_PATH, fn);
}

/** Load leftovers, or empty array if none exists. */
export async function loadLeftovers(store: ScopedDataStore): Promise<Leftover[]> {
	const raw = await store.read(LEFTOVERS_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as Leftover[];
		if (data && typeof data === 'object' && Array.isArray(data.items))
			return data.items as Leftover[];
		return [];
	} catch {
		return [];
	}
}

/** Save leftovers. */
export async function saveLeftovers(store: ScopedDataStore, items: Leftover[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Leftovers',
		date: isoNow(),
		tags: buildAppTags('food', 'leftovers'),
		app: 'food',
	});
	await store.write(LEFTOVERS_PATH, fm + stringify({ items }));
}

/** Add a leftover with dedup by name (case-insensitive). Replaces existing if found. */
export function addLeftover(existing: Leftover[], item: Leftover): Leftover[] {
	const result = [...existing];
	const idx = result.findIndex((l) => l.name.toLowerCase() === item.name.toLowerCase());
	if (idx >= 0) {
		result[idx] = item;
	} else {
		result.push(item);
	}
	return result;
}

/** Update the status of a leftover at the given index. Returns updated list. */
export function updateLeftoverStatus(
	items: Leftover[],
	index: number,
	status: Leftover['status'],
): Leftover[] {
	if (index < 0 || index >= items.length) return [...items];
	return items.map((item, i) => (i === index ? { ...item, status } : item));
}

/** Return only active leftovers. */
export function getActiveLeftovers(items: Leftover[]): Leftover[] {
	return items.filter((l) => l.status === 'active');
}

/**
 * Return active leftovers expiring within `withinDays` days of `today`,
 * including items that have already expired.
 */
export function getExpiringLeftovers(
	items: Leftover[],
	withinDays: number,
	today: string,
): Leftover[] {
	const todayMs = new Date(today).getTime();
	const boundaryMs = todayMs + withinDays * 24 * 60 * 60 * 1000;
	return items.filter((l) => {
		if (l.status !== 'active') return false;
		const expiryMs = new Date(l.expiryEstimate).getTime();
		return expiryMs <= boundaryMs;
	});
}

/**
 * Format active leftovers for display.
 * Shows expiry indicators: ⚠️ for tomorrow, ❌ for today/past.
 */
export function formatLeftoverList(items: Leftover[], today?: string): string {
	const active = getActiveLeftovers(items);
	if (!active.length) return '🍱 No active leftovers in the fridge.';

	const todayStr = today ?? new Date().toISOString().slice(0, 10);
	const todayMs = new Date(todayStr).getTime();
	const tomorrowMs = todayMs + 24 * 60 * 60 * 1000;

	const lines: string[] = ['🍱 *Leftovers*\n'];
	for (const item of active) {
		const expiryMs = new Date(item.expiryEstimate).getTime();
		let indicator = '';
		if (expiryMs <= todayMs) {
			indicator = ' ❌';
		} else if (expiryMs <= tomorrowMs) {
			indicator = ' ⚠️';
		}
		const fromPart = item.fromRecipe ? ` _(${item.fromRecipe})_` : '';
		lines.push(`• ${item.name} — ${item.quantity}${fromPart} · exp ${item.expiryEstimate}${indicator}`);
	}
	return lines.join('\n').trimEnd();
}

/**
 * Build inline button rows for leftover management.
 * First row: Add button.
 * Subsequent rows: Use/Freeze/Toss buttons per active item (using original index).
 */
export function buildLeftoverButtons(
	items: Leftover[],
): Array<Array<{ text: string; callbackData: string }>> {
	const rows: Array<Array<{ text: string; callbackData: string }>> = [];

	rows.push([{ text: '➕ Add Leftover', callbackData: 'app:food:lo:add' }]);

	items.forEach((item, idx) => {
		if (item.status !== 'active') return;
		const enc = encodeURIComponent(item.name);
		rows.push([
			{ text: `✅ Use ${item.name}`, callbackData: `app:food:lo:use:${idx}:${enc}` },
			{ text: `🧊 Freeze ${item.name}`, callbackData: `app:food:lo:freeze:${idx}:${enc}` },
			{ text: `🗑️ Toss ${item.name}`, callbackData: `app:food:lo:toss:${idx}:${enc}` },
		]);
	});

	return rows;
}

/**
 * Parse free-text leftover input.
 * Format: "name" or "name, quantity"
 * Defaults quantity to "some".
 */
export function parseLeftoverInput(
	text: string,
	fromRecipe: string | undefined,
	timezone: string,
): Omit<Leftover, 'expiryEstimate'> {
	const commaIdx = text.indexOf(',');
	let name: string;
	let quantity: string;

	if (commaIdx >= 0) {
		name = text.slice(0, commaIdx).trim();
		quantity = text.slice(commaIdx + 1).trim() || 'some';
	} else {
		name = text.trim();
		quantity = 'some';
	}

	return {
		name,
		quantity,
		fromRecipe,
		storedDate: todayDate(timezone),
		status: 'active',
	};
}
