/**
 * Waste store — append-only log of food waste.
 *
 * Stored at `waste-log.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { withFileLock } from '@pas/core/utils/file-mutex';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { WasteLogEntry } from '../types.js';
import { isoNow } from '../utils/date.js';

const WASTE_LOG_PATH = 'waste-log.yaml';

/** Acquire the waste log lock for a read-modify-write sequence. */
export function withWasteLock<T>(fn: () => Promise<T>): Promise<T> {
	return withFileLock(WASTE_LOG_PATH, fn);
}

const REASON_EMOJI: Record<WasteLogEntry['reason'], string> = {
	expired: '⏰',
	spoiled: '🤢',
	discarded: '🗑',
};

/** Load the waste log, or empty array if none exists. */
export async function loadWasteLog(store: ScopedDataStore): Promise<WasteLogEntry[]> {
	const raw = await store.read(WASTE_LOG_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as WasteLogEntry[];
		if (data && typeof data === 'object' && Array.isArray(data.entries))
			return data.entries as WasteLogEntry[];
		return [];
	} catch {
		return [];
	}
}

/** Save the waste log. */
async function saveWasteLog(store: ScopedDataStore, entries: WasteLogEntry[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Food Waste Log',
		date: isoNow(),
		tags: buildAppTags('food', 'waste'),
		app: 'food',
	});
	await store.write(WASTE_LOG_PATH, fm + stringify({ entries }));
}

/** Append a waste entry to the log. Self-locking — callers need no external lock. */
export async function appendWaste(store: ScopedDataStore, entry: WasteLogEntry): Promise<void> {
	await withWasteLock(async () => {
		const entries = await loadWasteLog(store);
		entries.push(entry);
		await saveWasteLog(store, entries);
	});
}

/** Format a waste summary for the given period. */
export function formatWasteSummary(entries: WasteLogEntry[], _periodDays: number): string {
	if (!entries.length) return 'No food waste logged.';

	const lines: string[] = [];
	for (const entry of entries) {
		const emoji = REASON_EMOJI[entry.reason] ?? '🗑';
		lines.push(`${emoji} ${entry.name} — ${entry.quantity}`);
	}
	return lines.join('\n');
}
